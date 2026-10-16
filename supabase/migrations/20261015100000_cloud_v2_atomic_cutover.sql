-- Add a backend-only, Workspace-wide atomic Snapshot V1 -> V2 cutover.
-- Applying this migration does not convert any existing Workspace. A caller
-- must first obtain complete inspection evidence and construct an explicit
-- versioned plan for one legacy, fully backfilled Workspace.

begin;

-- A BEFORE INSERT trigger runs before the row's Workspace foreign-key check.
-- Take the parent KEY SHARE lock first so an old V1 INSERT cannot observe
-- legacy, wait behind the cutover's parent UPDATE lock, and then commit after
-- the Workspace has become ready. UPDATE keeps its existing row-first order;
-- after waiting on the Event row, PostgreSQL invokes this trigger against the
-- current ready state and rejects V1.
create or replace function public.guard_ready_workspace_from_v1_event_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  master_status text;
begin
  if tg_op = 'INSERT' then
    perform 1
    from public.workspaces
    where workspaces.id = new.workspace_id
    for key share;
  end if;

  if (new.event_snapshot -> 'version') is distinct from '1'::jsonb then
    return new;
  end if;

  select cloud_workspace_master_states.status
    into master_status
    from public.cloud_workspace_master_states
    where cloud_workspace_master_states.workspace_id = new.workspace_id
    for share;

  if master_status is null then
    raise exception 'Workspace master state is unavailable'
      using errcode = '55000';
  elsif master_status is not distinct from 'ready' then
    raise exception 'Snapshot V1 writes are disabled for ready Workspaces'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create function public.cutover_cloud_v2_validated(
  p_workspace_id uuid,
  p_expected_generation text,
  p_expected_backfill_plan_fingerprint text,
  p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  master_status text;
  current_generation bigint;
  result_generation bigint;
  planned_event_count integer;
  current_event_count bigint;
  converted_event_count integer := 0;
  event_entry jsonb;
  source_row public.cloud_events%rowtype;
  completed_backfill public.cloud_workspace_master_backfills%rowtype;
  collection_name text;
  direct_member_ids text[];
  direct_band_ids text[];
  referenced_member_ids text[];
  referenced_band_ids text[];
  required_member_ids text[];
begin
  -- Reject missing, JSON-null, extra, or wrongly typed plan fields before any
  -- lock or table read. bigint values are compared as numeric/text until their
  -- range has been proven, avoiding a cast overflow or JS-number semantics.
  if p_workspace_id is null
    or p_expected_generation is null
    or p_expected_generation !~ '^(0|[1-9][0-9]*)$'
    or p_expected_backfill_plan_fingerprint is null
    or p_expected_backfill_plan_fingerprint !~ '^[0-9a-f]{64}$'
    or p_plan is null
    or jsonb_typeof(p_plan) is distinct from 'object'
    or not (p_plan ?& array[
      'version', 'workspaceId', 'expectedGeneration',
      'expectedBackfillPlanFingerprint', 'events'
    ])
    or p_plan - array[
      'version', 'workspaceId', 'expectedGeneration',
      'expectedBackfillPlanFingerprint', 'events'
    ] <> '{}'::jsonb
    or p_plan -> 'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_plan -> 'workspaceId') is distinct from 'string'
    or p_plan ->> 'workspaceId' is distinct from p_workspace_id::text
    or jsonb_typeof(p_plan -> 'expectedGeneration') is distinct from 'string'
    or p_plan ->> 'expectedGeneration' is distinct from p_expected_generation
    or jsonb_typeof(p_plan -> 'expectedBackfillPlanFingerprint')
      is distinct from 'string'
    or p_plan ->> 'expectedBackfillPlanFingerprint'
      is distinct from p_expected_backfill_plan_fingerprint
    or jsonb_typeof(p_plan -> 'events') is distinct from 'array' then
    raise exception 'Cloud V2 atomic cutover plan is invalid'
      using errcode = '22023';
  end if;

  if length(p_expected_generation) > 19
    or p_expected_generation::numeric > 9223372036854775807 then
    raise exception 'Cloud V2 atomic cutover generation is out of range'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_plan -> 'events') as planned_event(value)
    where jsonb_typeof(planned_event.value) is distinct from 'object'
      or not (planned_event.value ?& array[
        'eventId', 'expectedRevision',
        'expectedSnapshotFingerprint', 'snapshotV2'
      ])
      or planned_event.value - array[
        'eventId', 'expectedRevision',
        'expectedSnapshotFingerprint', 'snapshotV2'
      ] <> '{}'::jsonb
      or jsonb_typeof(planned_event.value -> 'eventId') is distinct from 'string'
      or btrim(planned_event.value ->> 'eventId') = ''
      or jsonb_typeof(planned_event.value -> 'expectedRevision')
        is distinct from 'number'
      or (planned_event.value ->> 'expectedRevision') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(planned_event.value -> 'expectedSnapshotFingerprint')
        is distinct from 'string'
      or (planned_event.value ->> 'expectedSnapshotFingerprint')
        !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(planned_event.value -> 'snapshotV2')
        is distinct from 'object'
      or not public.is_cloud_event_v2_snapshot_shape(
        planned_event.value -> 'snapshotV2',
        planned_event.value ->> 'eventId',
        planned_event.value #>> '{snapshotV2,eventState,events,0,name}'
      )
  ) or (
    select count(*) <> count(distinct planned_event.value ->> 'eventId')
    from jsonb_array_elements(p_plan -> 'events') as planned_event(value)
  ) then
    raise exception 'Cloud V2 atomic cutover Events are invalid'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_plan -> 'events') as planned_event(value)
    where length(planned_event.value ->> 'expectedRevision') > 19
      or (planned_event.value ->> 'expectedRevision')::numeric
        > 9223372036854775807
  ) then
    raise exception 'Cloud V2 atomic cutover Event revision is out of range'
      using errcode = '22023';
  end if;

  planned_event_count := jsonb_array_length(p_plan -> 'events');

  -- Lock order:
  --   Workspace parent -> Master state SHARE -> all Event rows UPDATE
  --   -> generation UPDATE -> backfill/Master/reference rows SHARE.
  -- The parent UPDATE lock prevents new FK child INSERTs (including Events and
  -- memberships) after the complete Event set is frozen. Existing writers may
  -- finish before these locks are acquired, after which all expected values
  -- are rechecked. No table-wide lock or advisory lock is used.
  perform 1
  from public.workspaces
  where workspaces.id = p_workspace_id
  for update;
  if not found then
    raise exception 'Workspace does not exist' using errcode = 'P0002';
  end if;

  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for share;
  if master_status is distinct from 'legacy' then
    raise exception 'Cloud V2 atomic cutover requires legacy status'
      using errcode = '55000';
  end if;

  perform 1
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id
  order by cloud_events.event_id collate "C"
  for update;

  select cloud_event_workspace_generations.generation into current_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id
  for update;
  if current_generation is null then
    raise exception 'Workspace generation is unavailable' using errcode = '55000';
  end if;
  if current_generation::text is distinct from p_expected_generation then
    raise exception 'Workspace changed after Cloud V2 cutover planning'
      using errcode = '40001';
  end if;

  -- Classify an incomplete Plan as stale CAS input before validating the
  -- completed-backfill evidence against the authoritative locked Event set.
  select count(*) into current_event_count
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id;
  if planned_event_count is distinct from current_event_count then
    raise exception 'Cloud Event set changed after Cloud V2 cutover planning'
      using errcode = '40001';
  end if;

  select * into completed_backfill
  from public.cloud_workspace_master_backfills
  where cloud_workspace_master_backfills.workspace_id = p_workspace_id
  for share;
  if completed_backfill.workspace_id is null
    or completed_backfill.plan_fingerprint
      is distinct from p_expected_backfill_plan_fingerprint
    or completed_backfill.result_generation is distinct from current_generation
    or completed_backfill.source_generation > completed_backfill.result_generation
    or completed_backfill.event_count is distinct from current_event_count then
    raise exception 'Completed Workspace Master backfill evidence is inconsistent'
      using errcode = '55000';
  end if;

  -- Full Event-set equality plus revision and PostgreSQL jsonb::text digest CAS.
  if exists (
      select 1
      from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
        and (
          cloud_events.event_snapshot -> 'version' is distinct from '1'::jsonb
          or cloud_events.event_snapshot ->> 'format'
            is distinct from 'acappella-tt-cloud-event'
          or jsonb_typeof(cloud_events.event_snapshot -> 'appState')
            is distinct from 'object'
          or not (cloud_events.event_snapshot -> 'appState' ?& array[
            'version', 'members', 'bands', 'events', 'eventDays', 'stages',
            'sections', 'eventMembers', 'eventMemberDays', 'eventBands',
            'scheduleItems', 'paAssignments', 'dutyTypes', 'dutyAssignments',
            'timetableLocks', 'timetableOrderConstraints'
          ])
          or (cloud_events.event_snapshot -> 'appState') - array[
            'version', 'members', 'bands', 'events', 'eventDays', 'stages',
            'sections', 'eventMembers', 'eventMemberDays', 'eventBands',
            'scheduleItems', 'paAssignments', 'dutyTypes', 'dutyAssignments',
            'timetableLocks', 'timetableOrderConstraints'
          ] <> '{}'::jsonb
          or jsonb_typeof(cloud_events.event_snapshot #> '{appState,members}')
            is distinct from 'array'
          or jsonb_typeof(cloud_events.event_snapshot #> '{appState,bands}')
            is distinct from 'array'
          or exists (
            select 1
            from unnest(array[
              'events', 'eventDays', 'stages', 'sections', 'eventMembers',
              'eventMemberDays', 'eventBands', 'scheduleItems', 'paAssignments',
              'dutyTypes', 'dutyAssignments', 'timetableLocks',
              'timetableOrderConstraints'
            ]) as required_collection(name)
            where jsonb_typeof(
              cloud_events.event_snapshot #>
                array['appState', required_collection.name]
            ) is distinct from 'array'
          )
        )
    ) or exists (
      select 1
      from jsonb_array_elements(p_plan -> 'events') as planned_event(value)
      left join public.cloud_events
        on cloud_events.workspace_id = p_workspace_id
        and cloud_events.event_id = planned_event.value ->> 'eventId'
      where cloud_events.event_id is null
        or cloud_events.revision is distinct from
          (planned_event.value ->> 'expectedRevision')::bigint
        or pg_catalog.encode(
          extensions.digest(cloud_events.event_snapshot::text, 'sha256'), 'hex'
        ) is distinct from planned_event.value ->> 'expectedSnapshotFingerprint'
    ) then
    raise exception 'Cloud Event set changed after Cloud V2 cutover planning'
      using errcode = '40001';
  end if;

  -- Every Event-owned collection must have non-empty, Workspace-unique IDs.
  -- The same string may still be used by different collection kinds.
  foreach collection_name in array array[
    'events', 'eventDays', 'stages', 'sections', 'eventMembers',
    'eventMemberDays', 'eventBands', 'scheduleItems', 'paAssignments',
    'dutyTypes', 'dutyAssignments', 'timetableLocks',
    'timetableOrderConstraints'
  ] loop
    if exists (
      select 1
      from public.cloud_events
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> array['appState', collection_name]
      ) as owned_record(value)
      where cloud_events.workspace_id = p_workspace_id
        and (
          jsonb_typeof(owned_record.value) is distinct from 'object'
          or jsonb_typeof(owned_record.value -> 'id') is distinct from 'string'
          or btrim(owned_record.value ->> 'id') = ''
        )
    ) or exists (
      select 1
      from public.cloud_events
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> array['appState', collection_name]
      ) as owned_record(value)
      where cloud_events.workspace_id = p_workspace_id
      group by owned_record.value ->> 'id'
      having count(*) > 1
    ) then
      raise exception 'Cloud Event-owned IDs are invalid or duplicated'
        using errcode = '55000';
    end if;
  end loop;

  -- Lock normalized data and its relation/index evidence after generation.
  perform 1 from public.workspace_master_members
    where workspace_master_members.workspace_id = p_workspace_id
    order by workspace_master_members.member_id collate "C" for share;
  perform 1 from public.workspace_master_bands
    where workspace_master_bands.workspace_id = p_workspace_id
    order by workspace_master_bands.band_id collate "C" for share;
  perform 1 from public.workspace_master_band_members
    where workspace_master_band_members.workspace_id = p_workspace_id
    order by workspace_master_band_members.band_id collate "C",
      workspace_master_band_members.position for share;
  perform 1 from public.cloud_event_member_references
    where cloud_event_member_references.workspace_id = p_workspace_id
    order by cloud_event_member_references.event_id collate "C",
      cloud_event_member_references.member_id collate "C" for share;
  perform 1 from public.cloud_event_band_references
    where cloud_event_band_references.workspace_id = p_workspace_id
    order by cloud_event_band_references.event_id collate "C",
      cloud_event_band_references.band_id collate "C" for share;

  -- Normalize DB rows to the exact V1 JSON representation. Both directions
  -- are checked, so a conflict, missing row, or unreferenced extra row fails.
  if exists (
      select 1
      from public.cloud_events
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> '{appState,members}'
      ) as source_member(value)
      where cloud_events.workspace_id = p_workspace_id
        and not exists (
          select 1 from public.workspace_master_members
          where workspace_master_members.workspace_id = p_workspace_id
            and workspace_master_members.member_id = source_member.value ->> 'id'
            and jsonb_strip_nulls(jsonb_build_object(
              'id', workspace_master_members.member_id,
              'realName', workspace_master_members.real_name,
              'acaName', workspace_master_members.aca_name,
              'entryAcademicYear', workspace_master_members.entry_academic_year,
              'notes', workspace_master_members.notes,
              'active', workspace_master_members.active
            )) = source_member.value
        )
    ) or exists (
      select 1 from public.workspace_master_members
      where workspace_master_members.workspace_id = p_workspace_id
        and not exists (
          select 1
          from public.cloud_events
          cross join lateral jsonb_array_elements(
            cloud_events.event_snapshot #> '{appState,members}'
          ) as source_member(value)
          where cloud_events.workspace_id = p_workspace_id
            and source_member.value = jsonb_strip_nulls(jsonb_build_object(
              'id', workspace_master_members.member_id,
              'realName', workspace_master_members.real_name,
              'acaName', workspace_master_members.aca_name,
              'entryAcademicYear', workspace_master_members.entry_academic_year,
              'notes', workspace_master_members.notes,
              'active', workspace_master_members.active
            ))
        )
    ) then
    raise exception 'Normalized Workspace Members do not match Snapshot V1'
      using errcode = '55000';
  end if;

  if exists (
      select 1
      from public.cloud_events
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> '{appState,bands}'
      ) as source_band(value)
      where cloud_events.workspace_id = p_workspace_id
        and not exists (
          select 1 from public.workspace_master_bands
          where workspace_master_bands.workspace_id = p_workspace_id
            and workspace_master_bands.band_id = source_band.value ->> 'id'
            and jsonb_strip_nulls(jsonb_build_object(
              'id', workspace_master_bands.band_id,
              'name', workspace_master_bands.name,
              'defaultMemberIds', coalesce((
                select jsonb_agg(workspace_master_band_members.member_id
                  order by workspace_master_band_members.position)
                from public.workspace_master_band_members
                where workspace_master_band_members.workspace_id = p_workspace_id
                  and workspace_master_band_members.band_id =
                    workspace_master_bands.band_id
              ), '[]'::jsonb),
              'notes', workspace_master_bands.notes,
              'active', workspace_master_bands.active
            )) = source_band.value
        )
    ) or exists (
      select 1 from public.workspace_master_bands
      where workspace_master_bands.workspace_id = p_workspace_id
        and not exists (
          select 1
          from public.cloud_events
          cross join lateral jsonb_array_elements(
            cloud_events.event_snapshot #> '{appState,bands}'
          ) as source_band(value)
          where cloud_events.workspace_id = p_workspace_id
            and source_band.value = jsonb_strip_nulls(jsonb_build_object(
              'id', workspace_master_bands.band_id,
              'name', workspace_master_bands.name,
              'defaultMemberIds', coalesce((
                select jsonb_agg(workspace_master_band_members.member_id
                  order by workspace_master_band_members.position)
                from public.workspace_master_band_members
                where workspace_master_band_members.workspace_id = p_workspace_id
                  and workspace_master_band_members.band_id =
                    workspace_master_bands.band_id
              ), '[]'::jsonb),
              'notes', workspace_master_bands.notes,
              'active', workspace_master_bands.active
            ))
        )
    ) then
    raise exception 'Normalized Workspace Bands do not match Snapshot V1'
      using errcode = '55000';
  end if;

  -- Reference rows must be the exact per-Event Master sets from Snapshot V1.
  if exists (
      select 1
      from public.cloud_events
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> '{appState,members}'
      ) as source_member(value)
      where cloud_events.workspace_id = p_workspace_id
        and not exists (
          select 1 from public.cloud_event_member_references
          where cloud_event_member_references.workspace_id = p_workspace_id
            and cloud_event_member_references.event_id = cloud_events.event_id
            and cloud_event_member_references.member_id = source_member.value ->> 'id'
        )
    ) or exists (
      select 1 from public.cloud_event_member_references
      join public.cloud_events
        on cloud_events.workspace_id = cloud_event_member_references.workspace_id
        and cloud_events.event_id = cloud_event_member_references.event_id
      where cloud_event_member_references.workspace_id = p_workspace_id
        and not exists (
          select 1 from jsonb_array_elements(
            cloud_events.event_snapshot #> '{appState,members}'
          ) as source_member(value)
          where source_member.value ->> 'id' =
            cloud_event_member_references.member_id
        )
    ) or exists (
      select 1
      from public.cloud_events
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> '{appState,bands}'
      ) as source_band(value)
      where cloud_events.workspace_id = p_workspace_id
        and not exists (
          select 1 from public.cloud_event_band_references
          where cloud_event_band_references.workspace_id = p_workspace_id
            and cloud_event_band_references.event_id = cloud_events.event_id
            and cloud_event_band_references.band_id = source_band.value ->> 'id'
        )
    ) or exists (
      select 1 from public.cloud_event_band_references
      join public.cloud_events
        on cloud_events.workspace_id = cloud_event_band_references.workspace_id
        and cloud_events.event_id = cloud_event_band_references.event_id
      where cloud_event_band_references.workspace_id = p_workspace_id
        and not exists (
          select 1 from jsonb_array_elements(
            cloud_events.event_snapshot #> '{appState,bands}'
          ) as source_band(value)
          where source_band.value ->> 'id' = cloud_event_band_references.band_id
        )
    ) then
    raise exception 'Cloud Event Master reference index is inconsistent'
      using errcode = '55000';
  end if;

  -- Verify all six historical backfill counts against locked current data.
  if completed_backfill.member_count is distinct from (
      select count(*) from public.workspace_master_members
      where workspace_master_members.workspace_id = p_workspace_id
    ) or completed_backfill.band_count is distinct from (
      select count(*) from public.workspace_master_bands
      where workspace_master_bands.workspace_id = p_workspace_id
    ) or completed_backfill.band_member_relation_count is distinct from (
      select count(*) from public.workspace_master_band_members
      where workspace_master_band_members.workspace_id = p_workspace_id
    ) or completed_backfill.event_member_reference_count is distinct from (
      select count(*) from public.cloud_event_member_references
      where cloud_event_member_references.workspace_id = p_workspace_id
    ) or completed_backfill.event_band_reference_count is distinct from (
      select count(*) from public.cloud_event_band_references
      where cloud_event_band_references.workspace_id = p_workspace_id
    ) then
    raise exception 'Completed Workspace Master backfill counts are inconsistent'
      using errcode = '55000';
  end if;

  -- Compare each candidate independently with its locked source row. The V2
  -- Event-owned state must be byte-for-byte JSONB equal to V1 minus the two
  -- Master collections; reference arrays are compared as exact sets against
  -- the locked reference index (array collation/order is not trusted). Direct
  -- references and the transitive Band-member closure are independently
  -- derived with the same helpers and lock-protected relations as V2 Save.
  for event_entry in
    select planned_event.value
    from jsonb_array_elements(p_plan -> 'events') as planned_event(value)
    order by planned_event.value ->> 'eventId' collate "C"
  loop
    select * into strict source_row
    from public.cloud_events
    where cloud_events.workspace_id = p_workspace_id
      and cloud_events.event_id = event_entry ->> 'eventId';

    direct_member_ids := public.cloud_event_v2_direct_member_ids(
      event_entry -> 'snapshotV2'
    );
    direct_band_ids := public.cloud_event_v2_direct_band_ids(
      event_entry -> 'snapshotV2'
    );

    select coalesce(
      array_agg(reference.value #>> '{}'
        order by (reference.value #>> '{}') collate "C"),
      array[]::text[]
    ) into referenced_member_ids
    from jsonb_array_elements(
      event_entry #> '{snapshotV2,masterReferences,memberIds}'
    ) as reference(value);

    select coalesce(
      array_agg(reference.value #>> '{}'
        order by (reference.value #>> '{}') collate "C"),
      array[]::text[]
    ) into referenced_band_ids
    from jsonb_array_elements(
      event_entry #> '{snapshotV2,masterReferences,bandIds}'
    ) as reference(value);

    select coalesce(
      array_agg(reference_id order by reference_id collate "C"),
      array[]::text[]
    ) into required_member_ids
    from (
      select unnest(direct_member_ids) as reference_id
      union
      select workspace_master_band_members.member_id as reference_id
      from public.workspace_master_band_members
      where workspace_master_band_members.workspace_id = p_workspace_id
        and workspace_master_band_members.band_id = any(referenced_band_ids)
    ) as required_members;

    if event_entry #> '{snapshotV2,eventState}' is distinct from
        (source_row.event_snapshot -> 'appState') - 'members' - 'bands'
      or direct_band_ids is distinct from referenced_band_ids
      or not direct_member_ids <@ referenced_member_ids
      or required_member_ids is distinct from referenced_member_ids
      or exists (
        select 1
        from jsonb_array_elements(
          event_entry #> '{snapshotV2,masterReferences,memberIds}'
        ) as planned_reference(value)
        where not exists (
          select 1 from public.cloud_event_member_references
          where cloud_event_member_references.workspace_id = p_workspace_id
            and cloud_event_member_references.event_id = source_row.event_id
            and cloud_event_member_references.member_id =
              planned_reference.value #>> '{}'
        )
      ) or (
        select count(*)
        from jsonb_array_elements(
          event_entry #> '{snapshotV2,masterReferences,memberIds}'
        )
      ) is distinct from (
        select count(*) from public.cloud_event_member_references
        where cloud_event_member_references.workspace_id = p_workspace_id
          and cloud_event_member_references.event_id = source_row.event_id
      ) or exists (
        select 1
        from jsonb_array_elements(
          event_entry #> '{snapshotV2,masterReferences,bandIds}'
        ) as planned_reference(value)
        where not exists (
          select 1 from public.cloud_event_band_references
          where cloud_event_band_references.workspace_id = p_workspace_id
            and cloud_event_band_references.event_id = source_row.event_id
            and cloud_event_band_references.band_id =
              planned_reference.value #>> '{}'
        )
      ) or (
        select count(*)
        from jsonb_array_elements(
          event_entry #> '{snapshotV2,masterReferences,bandIds}'
        )
      ) is distinct from (
        select count(*) from public.cloud_event_band_references
        where cloud_event_band_references.workspace_id = p_workspace_id
          and cloud_event_band_references.event_id = source_row.event_id
      ) then
      raise exception 'Snapshot V2 candidate does not match locked Snapshot V1'
        using errcode = '55000';
    end if;

    update public.cloud_events
      set event_name = event_entry #>> '{snapshotV2,eventState,events,0,name}',
          event_snapshot = event_entry -> 'snapshotV2'
      where cloud_events.workspace_id = p_workspace_id
        and cloud_events.event_id = source_row.event_id;
    converted_event_count := converted_event_count + 1;
  end loop;

  if converted_event_count is distinct from planned_event_count
    or exists (
      select 1 from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
        and (
          cloud_events.event_snapshot -> 'version' is distinct from '2'::jsonb
          or not public.is_cloud_event_v2_snapshot_shape(
            cloud_events.event_snapshot,
            cloud_events.event_id,
            cloud_events.event_name
          )
        )
    ) then
    raise exception 'Cloud V2 atomic cutover verification failed'
      using errcode = '55000';
  end if;

  -- Upgrade the earlier SHARE lock only after every Event is V2. NOWAIT avoids
  -- a lock-upgrade deadlock with a legacy writer/backfill that already holds a
  -- state SHARE lock while waiting for an Event row. Any conflict aborts the
  -- whole function and rolls every Event/revision/generation change back.
  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for update nowait;
  if master_status is distinct from 'legacy' then
    raise exception 'Workspace Master state changed during Cloud V2 cutover'
      using errcode = '40001';
  end if;

  update public.cloud_workspace_master_states
    set status = 'ready'
    where cloud_workspace_master_states.workspace_id = p_workspace_id;

  select cloud_event_workspace_generations.generation into result_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'sourceGeneration', current_generation::text,
    'resultGeneration', result_generation::text,
    'eventCount', planned_event_count,
    'convertedEventCount', converted_event_count,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventId', cloud_events.event_id,
        'revision', cloud_events.revision
      ) order by cloud_events.event_id collate "C")
      from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
exception
  when lock_not_available then
    raise exception 'Cloud V2 atomic cutover conflicts with another Workspace operation'
      using errcode = '55P03';
end;
$$;

revoke all on function public.cutover_cloud_v2_validated(
  uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.cutover_cloud_v2_validated(
  uuid, text, text, jsonb
) to service_role;

comment on function public.cutover_cloud_v2_validated(
  uuid, text, text, jsonb
) is
  'Backend-only atomic conversion of the complete locked Snapshot V1 Event set to validated Snapshot V2, followed by the final legacy-to-ready transition.';

-- Fail closed on direct, PUBLIC, or inherited EXECUTE grants.
do $cloud_v2_atomic_cutover_privilege_guard$
declare
  function_oid oid := to_regprocedure(
    'public.cutover_cloud_v2_validated(uuid,text,text,jsonb)'
  );
  service_role_oid oid;
  authenticated_role_oid oid;
  anon_role_oid oid;
begin
  select oid into service_role_oid
    from pg_catalog.pg_roles where rolname = 'service_role';
  select oid into authenticated_role_oid
    from pg_catalog.pg_roles where rolname = 'authenticated';
  select oid into anon_role_oid
    from pg_catalog.pg_roles where rolname = 'anon';

  if function_oid is null
    or service_role_oid is null
    or authenticated_role_oid is null
    or anon_role_oid is null
    or not (
      select pg_catalog.pg_proc.prosecdef
      from pg_catalog.pg_proc where pg_catalog.pg_proc.oid = function_oid
    )
    or not has_function_privilege(service_role_oid, function_oid, 'EXECUTE')
    or has_function_privilege(authenticated_role_oid, function_oid, 'EXECUTE')
    or has_function_privilege(anon_role_oid, function_oid, 'EXECUTE')
    or exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_catalog.pg_proc.proacl,
        pg_catalog.acldefault('f', pg_catalog.pg_proc.proowner)
      )) as function_acl
      where pg_catalog.pg_proc.oid = function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Cloud V2 atomic cutover RPC privileges are unsafe'
      using errcode = '42501';
  end if;
end
$cloud_v2_atomic_cutover_privilege_guard$;

commit;
