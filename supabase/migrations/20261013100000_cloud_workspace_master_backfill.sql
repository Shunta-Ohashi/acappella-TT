-- Add a backend-only, preview-first bridge from validated Snapshot V1 rows to
-- normalized Workspace Masters. The migration never backfills automatically,
-- rewrites a Cloud Event, or changes a Workspace out of legacy status.

begin;

create table public.cloud_workspace_master_backfills (
  workspace_id uuid primary key
    references public.workspaces(id) on delete cascade,
  plan_fingerprint text not null
    check (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  source_generation bigint not null check (source_generation >= 0),
  result_generation bigint not null check (result_generation >= source_generation),
  event_count integer not null check (event_count >= 0),
  member_count integer not null check (member_count >= 0),
  band_count integer not null check (band_count >= 0),
  band_member_relation_count integer not null
    check (band_member_relation_count >= 0),
  event_member_reference_count integer not null
    check (event_member_reference_count >= 0),
  event_band_reference_count integer not null
    check (event_band_reference_count >= 0),
  completed_at timestamptz not null default now()
);

alter table public.cloud_workspace_master_backfills enable row level security;
revoke all on table public.cloud_workspace_master_backfills
  from public, anon, authenticated, service_role;

create function public.inspect_workspace_master_backfill_source(
  p_workspace_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  master_status text;
  workspace_generation bigint;
  source_events jsonb;
begin
  if p_workspace_id is null then
    raise exception 'Workspace ID is required' using errcode = '22023';
  end if;

  -- Status precedes generation throughout the Master subsystem. Holding the
  -- generation lock through the Event SELECT gives the planner one MVCC-safe
  -- source generation without granting the browser a migration endpoint.
  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for share;

  if master_status is null then
    raise exception 'Workspace Master state is unavailable' using errcode = '55000';
  end if;

  select cloud_event_workspace_generations.generation
    into workspace_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id
  for share;

  if workspace_generation is null then
    raise exception 'Workspace generation is unavailable' using errcode = '55000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'workspaceId', cloud_events.workspace_id,
    'eventId', cloud_events.event_id,
    'eventName', cloud_events.event_name,
    'snapshot', cloud_events.event_snapshot,
    'snapshotFingerprint', pg_catalog.encode(
      extensions.digest(cloud_events.event_snapshot::text, 'sha256'), 'hex'
    ),
    'revision', cloud_events.revision
  ) order by cloud_events.event_id collate "C"), '[]'::jsonb)
  into source_events
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'workspaceStatus', master_status,
    'workspaceGeneration', workspace_generation::text,
    'events', source_events,
    'existing', jsonb_build_object(
      'members', (select count(*) from public.workspace_master_members
        where workspace_id = p_workspace_id),
      'bands', (select count(*) from public.workspace_master_bands
        where workspace_id = p_workspace_id),
      'bandMembers', (select count(*) from public.workspace_master_band_members
        where workspace_id = p_workspace_id),
      'eventMemberReferences', (
        select count(*) from public.cloud_event_member_references
        where workspace_id = p_workspace_id
      ),
      'eventBandReferences', (
        select count(*) from public.cloud_event_band_references
        where workspace_id = p_workspace_id
      ),
      'completedBackfills', (
        select count(*) from public.cloud_workspace_master_backfills
        where workspace_id = p_workspace_id
      ),
      'completedBackfill', (
        select jsonb_build_object(
          'planFingerprint', plan_fingerprint,
          'sourceGeneration', source_generation::text,
          'resultGeneration', result_generation::text,
          'eventCount', event_count,
          'memberCount', member_count,
          'bandCount', band_count,
          'bandMemberRelationCount', band_member_relation_count,
          'eventMemberReferenceCount', event_member_reference_count,
          'eventBandReferenceCount', event_band_reference_count
        )
        from public.cloud_workspace_master_backfills
        where workspace_id = p_workspace_id
      )
    )
  );
end;
$$;

revoke all on function public.inspect_workspace_master_backfill_source(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.inspect_workspace_master_backfill_source(uuid)
  to service_role;

create function public.backfill_workspace_masters_validated(
  p_workspace_id uuid,
  p_expected_generation text,
  p_plan_fingerprint text,
  p_plan jsonb,
  p_apply boolean
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
  completed_backfill public.cloud_workspace_master_backfills%rowtype;
  result_generation bigint;
  planned_event_count integer;
  planned_member_count integer;
  planned_band_count integer;
begin
  if p_workspace_id is null
    or p_expected_generation is null
    or p_expected_generation !~ '^(0|[1-9][0-9]*)$'
    or p_plan_fingerprint is null
    or p_plan_fingerprint !~ '^[0-9a-f]{64}$'
    or p_plan is null
    or p_apply is null
    or jsonb_typeof(p_plan) is distinct from 'object'
    or not (p_plan ?& array[
      'version', 'workspaceId', 'sourceGeneration', 'sourceEvents',
      'members', 'bands', 'bandMembers', 'eventMemberReferences',
      'eventBandReferences'
    ])
    or p_plan - array[
      'version', 'workspaceId', 'sourceGeneration', 'sourceEvents',
      'members', 'bands', 'bandMembers', 'eventMemberReferences',
      'eventBandReferences'
    ] <> '{}'::jsonb
    or p_plan -> 'version' is distinct from '1'::jsonb
    or p_plan ->> 'workspaceId' is distinct from p_workspace_id::text
    or p_plan ->> 'sourceGeneration' is distinct from p_expected_generation
    or jsonb_typeof(p_plan -> 'sourceEvents') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'members') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'bands') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'bandMembers') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'eventMemberReferences') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'eventBandReferences') is distinct from 'array' then
    raise exception 'Workspace Master backfill plan is invalid'
      using errcode = '22023';
  end if;

  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for share;

  if master_status is distinct from 'legacy' then
    raise exception 'Workspace Master backfill requires legacy status'
      using errcode = '55000';
  end if;

  -- Cloud Event writers lock their Event row before advancing generation. Do
  -- the same here: freeze every current Event row in C order, then lock and
  -- compare generation. Concurrent INSERT has no old row to lock, but it must
  -- advance the generation and therefore either wins first (mismatch) or waits.
  perform 1
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id
  order by cloud_events.event_id collate "C"
  for share;

  select cloud_event_workspace_generations.generation
    into current_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id
  for update;

  if current_generation is null then
    raise exception 'Workspace generation is unavailable' using errcode = '55000';
  end if;

  select * into completed_backfill
  from public.cloud_workspace_master_backfills
  where cloud_workspace_master_backfills.workspace_id = p_workspace_id;

  if completed_backfill.workspace_id is not null then
    if completed_backfill.plan_fingerprint = p_plan_fingerprint
      and completed_backfill.result_generation = current_generation then
      return jsonb_build_object(
        'status', 'already_applied',
        'workspaceId', p_workspace_id,
        'workspaceStatus', master_status,
        'sourceGeneration', completed_backfill.source_generation::text,
        'resultGeneration', completed_backfill.result_generation::text,
        'planFingerprint', completed_backfill.plan_fingerprint,
        'eventCount', completed_backfill.event_count,
        'memberCount', completed_backfill.member_count,
        'bandCount', completed_backfill.band_count,
        'bandMemberRelationCount', completed_backfill.band_member_relation_count,
        'eventMemberReferenceCount', completed_backfill.event_member_reference_count,
        'eventBandReferenceCount', completed_backfill.event_band_reference_count
      );
    end if;
    raise exception 'A different or stale Workspace Master backfill already exists'
      using errcode = '55000';
  end if;

  if current_generation::text is distinct from p_expected_generation then
    raise exception 'Workspace changed after backfill planning'
      using errcode = '40001';
  end if;

  -- Validate source Event tuple shape before any JSON array traversal.
  if exists (
    select 1
    from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
    where jsonb_typeof(source_event.value) is distinct from 'object'
      or not (source_event.value ?& array[
        'eventId', 'revision', 'snapshotFingerprint'
      ])
      or source_event.value - array[
        'eventId', 'revision', 'snapshotFingerprint'
      ] <> '{}'::jsonb
      or jsonb_typeof(source_event.value -> 'eventId') is distinct from 'string'
      or btrim(source_event.value ->> 'eventId') = ''
      or jsonb_typeof(source_event.value -> 'revision') is distinct from 'number'
      or (source_event.value ->> 'revision') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(source_event.value -> 'snapshotFingerprint')
        is distinct from 'string'
      or (source_event.value ->> 'snapshotFingerprint') !~ '^[0-9a-f]{64}$'
  ) or (
    select count(*) <> count(distinct source_event.value ->> 'eventId')
    from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
  ) then
    raise exception 'Workspace Master backfill source Events are invalid'
      using errcode = '22023';
  end if;

  planned_event_count := jsonb_array_length(p_plan -> 'sourceEvents');
  if planned_event_count <> (
      select count(*) from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
    ) or exists (
      select 1 from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
        and (
          cloud_events.event_snapshot #>> '{format}' is distinct from
            'acappella-tt-cloud-event'
          or cloud_events.event_snapshot #> '{version}' is distinct from '1'::jsonb
          or jsonb_typeof(cloud_events.event_snapshot #> '{appState}')
            is distinct from 'object'
          or jsonb_typeof(cloud_events.event_snapshot #> '{appState,members}')
            is distinct from 'array'
          or jsonb_typeof(cloud_events.event_snapshot #> '{appState,bands}')
            is distinct from 'array'
        )
    ) or exists (
      select 1
      from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
      left join public.cloud_events
        on cloud_events.workspace_id = p_workspace_id
        and cloud_events.event_id = source_event.value ->> 'eventId'
      where cloud_events.event_id is null
        or to_jsonb(cloud_events.revision)
          is distinct from source_event.value -> 'revision'
        or pg_catalog.encode(
          extensions.digest(cloud_events.event_snapshot::text, 'sha256'), 'hex'
        ) is distinct from source_event.value ->> 'snapshotFingerprint'
    ) then
    raise exception 'Cloud Event source changed after backfill planning'
      using errcode = '40001';
  end if;

  -- Required/optional Master fields match the shared Cloud validator. Missing,
  -- JSON null, wrong types, duplicate IDs, and out-of-range integer values all
  -- fail before relation or table writes.
  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'members') as member(value)
    where jsonb_typeof(member.value) is distinct from 'object'
      or not (member.value ?& array['id', 'realName', 'active'])
      or member.value - array[
        'id', 'realName', 'acaName', 'entryAcademicYear', 'notes', 'active'
      ] <> '{}'::jsonb
      or jsonb_typeof(member.value -> 'id') is distinct from 'string'
      or btrim(member.value ->> 'id') = ''
      or jsonb_typeof(member.value -> 'realName') is distinct from 'string'
      or btrim(member.value ->> 'realName') = ''
      or jsonb_typeof(member.value -> 'active') is distinct from 'boolean'
      or (member.value ? 'acaName'
        and jsonb_typeof(member.value -> 'acaName') is distinct from 'string')
      or (member.value ? 'notes'
        and jsonb_typeof(member.value -> 'notes') is distinct from 'string')
      or (member.value ? 'entryAcademicYear' and (
        jsonb_typeof(member.value -> 'entryAcademicYear') is distinct from 'number'
        or (member.value ->> 'entryAcademicYear') !~ '^[1-9][0-9]*$'
      ))
  ) or (
    select count(*) <> count(distinct member.value ->> 'id')
    from jsonb_array_elements(p_plan -> 'members') as member(value)
  ) then
    raise exception 'Workspace Master backfill Members are invalid'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'members') as member(value)
    where member.value ? 'entryAcademicYear'
      and (member.value ->> 'entryAcademicYear')::numeric > 2147483647
  ) then
    raise exception 'Workspace Master backfill Member academic year is out of range'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'bands') as band(value)
    where jsonb_typeof(band.value) is distinct from 'object'
      or not (band.value ?& array['id', 'name', 'active', 'defaultMemberIds'])
      or band.value - array['id', 'name', 'notes', 'active', 'defaultMemberIds']
        <> '{}'::jsonb
      or jsonb_typeof(band.value -> 'id') is distinct from 'string'
      or btrim(band.value ->> 'id') = ''
      or jsonb_typeof(band.value -> 'name') is distinct from 'string'
      or btrim(band.value ->> 'name') = ''
      or jsonb_typeof(band.value -> 'active') is distinct from 'boolean'
      or jsonb_typeof(band.value -> 'defaultMemberIds') is distinct from 'array'
      or (band.value ? 'notes'
        and jsonb_typeof(band.value -> 'notes') is distinct from 'string')
  ) or (
    select count(*) <> count(distinct band.value ->> 'id')
    from jsonb_array_elements(p_plan -> 'bands') as band(value)
  ) then
    raise exception 'Workspace Master backfill Bands are invalid'
      using errcode = '22023';
  end if;

  -- Array shape has been established above; only now expand ordered Band IDs.
  if exists (
    select 1
    from jsonb_array_elements(p_plan -> 'bands') as band(value)
    cross join lateral jsonb_array_elements(band.value -> 'defaultMemberIds')
      as default_member(value)
    where jsonb_typeof(default_member.value) is distinct from 'string'
      or btrim(default_member.value #>> '{}') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(p_plan -> 'bands') as band(value)
    where (
      select count(*) <> count(distinct default_member.value #>> '{}')
      from jsonb_array_elements(band.value -> 'defaultMemberIds')
        as default_member(value)
    )
  ) then
    raise exception 'Workspace Master backfill Band members are invalid'
      using errcode = '22023';
  end if;

  -- Every source copy must equal the one deterministic merged record. This is
  -- the DB-side fail-closed guard against same-ID Snapshot V1 conflicts.
  if exists (
      select 1
      from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
      join public.cloud_events
        on cloud_events.workspace_id = p_workspace_id
        and cloud_events.event_id = source_event.value ->> 'eventId'
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> '{appState,members}'
      ) as source_member(value)
      where not exists (
        select 1 from jsonb_array_elements(p_plan -> 'members') as member(value)
        where member.value ->> 'id' = source_member.value ->> 'id'
          and member.value = source_member.value
      )
    ) or exists (
      select 1 from jsonb_array_elements(p_plan -> 'members') as member(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
        join public.cloud_events
          on cloud_events.workspace_id = p_workspace_id
          and cloud_events.event_id = source_event.value ->> 'eventId'
        cross join lateral jsonb_array_elements(
          cloud_events.event_snapshot #> '{appState,members}'
        ) as source_member(value)
        where source_member.value = member.value
      )
    ) or exists (
      select 1
      from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
      join public.cloud_events
        on cloud_events.workspace_id = p_workspace_id
        and cloud_events.event_id = source_event.value ->> 'eventId'
      cross join lateral jsonb_array_elements(
        cloud_events.event_snapshot #> '{appState,bands}'
      ) as source_band(value)
      where not exists (
        select 1 from jsonb_array_elements(p_plan -> 'bands') as band(value)
        where band.value ->> 'id' = source_band.value ->> 'id'
          and band.value = source_band.value
      )
    ) or exists (
      select 1 from jsonb_array_elements(p_plan -> 'bands') as band(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
        join public.cloud_events
          on cloud_events.workspace_id = p_workspace_id
          and cloud_events.event_id = source_event.value ->> 'eventId'
        cross join lateral jsonb_array_elements(
          cloud_events.event_snapshot #> '{appState,bands}'
        ) as source_band(value)
        where source_band.value = band.value
      )
    ) then
    raise exception 'Snapshot V1 shared Master conflict detected'
      using errcode = '22023';
  end if;

  -- Plan relation rows must be the exact ordered expansion of Band bodies.
  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
    where jsonb_typeof(relation.value) is distinct from 'object'
      or not (relation.value ?& array['bandId', 'memberId', 'position'])
      or relation.value - array['bandId', 'memberId', 'position'] <> '{}'::jsonb
      or jsonb_typeof(relation.value -> 'bandId') is distinct from 'string'
      or jsonb_typeof(relation.value -> 'memberId') is distinct from 'string'
      or btrim(relation.value ->> 'bandId') = ''
      or btrim(relation.value ->> 'memberId') = ''
      or jsonb_typeof(relation.value -> 'position') is distinct from 'number'
      or (relation.value ->> 'position') !~ '^(0|[1-9][0-9]*)$'
  ) then
    raise exception 'Workspace Master backfill relations are invalid'
      using errcode = '22023';
  end if;

  if (
    select coalesce(bool_or(
      (relation.value ->> 'position')::numeric > 2147483647
    ), false)
    from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
  ) or (
    select count(*) <> count(distinct (
      relation.value ->> 'bandId', relation.value ->> 'memberId'
    ))
    from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
  ) or (
    select count(*) <> count(distinct (
      relation.value ->> 'bandId', relation.value ->> 'position'
    ))
    from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
  ) or exists (
    (
      select band.value ->> 'id' as band_id,
        default_member.value #>> '{}' as member_id,
        default_member.ordinality - 1 as position
      from jsonb_array_elements(p_plan -> 'bands') as band(value)
      cross join lateral jsonb_array_elements(band.value -> 'defaultMemberIds')
        with ordinality as default_member(value, ordinality)
      except
      select relation.value ->> 'bandId', relation.value ->> 'memberId',
        (relation.value ->> 'position')::numeric
      from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
    ) union all (
      select relation.value ->> 'bandId', relation.value ->> 'memberId',
        (relation.value ->> 'position')::numeric
      from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
      except
      select band.value ->> 'id', default_member.value #>> '{}',
        default_member.ordinality - 1
      from jsonb_array_elements(p_plan -> 'bands') as band(value)
      cross join lateral jsonb_array_elements(band.value -> 'defaultMemberIds')
        with ordinality as default_member(value, ordinality)
    )
  ) then
    raise exception 'Workspace Master backfill relations are incomplete'
      using errcode = '22023';
  end if;

  -- Snapshot V1 contains the exact reference closure, including Member IDs
  -- reached transitively through each referenced Band's defaultMemberIds.
  if exists (
      select 1
      from jsonb_array_elements(p_plan -> 'eventMemberReferences')
        as reference(value)
      where jsonb_typeof(reference.value) is distinct from 'object'
        or not (reference.value ?& array['eventId', 'memberId'])
        or reference.value - array['eventId', 'memberId'] <> '{}'::jsonb
        or jsonb_typeof(reference.value -> 'eventId') is distinct from 'string'
        or jsonb_typeof(reference.value -> 'memberId') is distinct from 'string'
        or btrim(reference.value ->> 'eventId') = ''
        or btrim(reference.value ->> 'memberId') = ''
    ) or (
      select count(*) <> count(distinct (
        reference.value ->> 'eventId', reference.value ->> 'memberId'
      ))
      from jsonb_array_elements(p_plan -> 'eventMemberReferences')
        as reference(value)
    ) or exists (
      select 1
      from jsonb_array_elements(p_plan -> 'eventBandReferences')
        as reference(value)
      where jsonb_typeof(reference.value) is distinct from 'object'
        or not (reference.value ?& array['eventId', 'bandId'])
        or reference.value - array['eventId', 'bandId'] <> '{}'::jsonb
        or jsonb_typeof(reference.value -> 'eventId') is distinct from 'string'
        or jsonb_typeof(reference.value -> 'bandId') is distinct from 'string'
        or btrim(reference.value ->> 'eventId') = ''
        or btrim(reference.value ->> 'bandId') = ''
    ) or (
      select count(*) <> count(distinct (
        reference.value ->> 'eventId', reference.value ->> 'bandId'
      ))
      from jsonb_array_elements(p_plan -> 'eventBandReferences')
        as reference(value)
    ) or exists (
      (
        select source_event.value ->> 'eventId', source_member.value ->> 'id'
        from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
        join public.cloud_events
          on cloud_events.workspace_id = p_workspace_id
          and cloud_events.event_id = source_event.value ->> 'eventId'
        cross join lateral jsonb_array_elements(
          cloud_events.event_snapshot #> '{appState,members}'
        ) as source_member(value)
        except
        select reference.value ->> 'eventId', reference.value ->> 'memberId'
        from jsonb_array_elements(p_plan -> 'eventMemberReferences')
          as reference(value)
      ) union all (
        select reference.value ->> 'eventId', reference.value ->> 'memberId'
        from jsonb_array_elements(p_plan -> 'eventMemberReferences')
          as reference(value)
        except
        select source_event.value ->> 'eventId', source_member.value ->> 'id'
        from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
        join public.cloud_events
          on cloud_events.workspace_id = p_workspace_id
          and cloud_events.event_id = source_event.value ->> 'eventId'
        cross join lateral jsonb_array_elements(
          cloud_events.event_snapshot #> '{appState,members}'
        ) as source_member(value)
      )
    ) or exists (
      (
        select source_event.value ->> 'eventId', source_band.value ->> 'id'
        from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
        join public.cloud_events
          on cloud_events.workspace_id = p_workspace_id
          and cloud_events.event_id = source_event.value ->> 'eventId'
        cross join lateral jsonb_array_elements(
          cloud_events.event_snapshot #> '{appState,bands}'
        ) as source_band(value)
        except
        select reference.value ->> 'eventId', reference.value ->> 'bandId'
        from jsonb_array_elements(p_plan -> 'eventBandReferences')
          as reference(value)
      ) union all (
        select reference.value ->> 'eventId', reference.value ->> 'bandId'
        from jsonb_array_elements(p_plan -> 'eventBandReferences')
          as reference(value)
        except
        select source_event.value ->> 'eventId', source_band.value ->> 'id'
        from jsonb_array_elements(p_plan -> 'sourceEvents') as source_event(value)
        join public.cloud_events
          on cloud_events.workspace_id = p_workspace_id
          and cloud_events.event_id = source_event.value ->> 'eventId'
        cross join lateral jsonb_array_elements(
          cloud_events.event_snapshot #> '{appState,bands}'
        ) as source_band(value)
      )
    ) then
    raise exception 'Workspace Master backfill Event references are incomplete'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.workspace_master_members
      where workspace_id = p_workspace_id)
    or exists (select 1 from public.workspace_master_bands
      where workspace_id = p_workspace_id)
    or exists (select 1 from public.workspace_master_band_members
      where workspace_id = p_workspace_id)
    or exists (select 1 from public.cloud_event_member_references
      where workspace_id = p_workspace_id)
    or exists (select 1 from public.cloud_event_band_references
      where workspace_id = p_workspace_id) then
    raise exception 'Workspace contains partial normalized Master data'
      using errcode = '55000';
  end if;

  planned_member_count := jsonb_array_length(p_plan -> 'members');
  planned_band_count := jsonb_array_length(p_plan -> 'bands');
  if not p_apply then
    return jsonb_build_object(
      'status', 'preview',
      'workspaceId', p_workspace_id,
      'workspaceStatus', master_status,
      'sourceGeneration', current_generation::text,
      'planFingerprint', p_plan_fingerprint,
      'eventCount', planned_event_count,
      'memberCount', planned_member_count,
      'bandCount', planned_band_count,
      'bandMemberRelationCount', jsonb_array_length(p_plan -> 'bandMembers'),
      'eventMemberReferenceCount',
        jsonb_array_length(p_plan -> 'eventMemberReferences'),
      'eventBandReferenceCount',
        jsonb_array_length(p_plan -> 'eventBandReferences')
    );
  end if;

  insert into public.workspace_master_members (
    workspace_id, member_id, real_name, aca_name,
    entry_academic_year, notes, active
  )
  select p_workspace_id, member.value ->> 'id', member.value ->> 'realName',
    member.value ->> 'acaName',
    (member.value ->> 'entryAcademicYear')::integer,
    member.value ->> 'notes', (member.value ->> 'active')::boolean
  from jsonb_array_elements(p_plan -> 'members') as member(value)
  order by member.value ->> 'id' collate "C";

  insert into public.workspace_master_bands (
    workspace_id, band_id, name, notes, active
  )
  select p_workspace_id, band.value ->> 'id', band.value ->> 'name',
    band.value ->> 'notes', (band.value ->> 'active')::boolean
  from jsonb_array_elements(p_plan -> 'bands') as band(value)
  order by band.value ->> 'id' collate "C";

  insert into public.workspace_master_band_members (
    workspace_id, band_id, member_id, position
  )
  select p_workspace_id, relation.value ->> 'bandId',
    relation.value ->> 'memberId', (relation.value ->> 'position')::integer
  from jsonb_array_elements(p_plan -> 'bandMembers') as relation(value)
  order by relation.value ->> 'bandId' collate "C",
    (relation.value ->> 'position')::integer;

  insert into public.cloud_event_member_references (
    workspace_id, event_id, member_id
  )
  select p_workspace_id, reference.value ->> 'eventId',
    reference.value ->> 'memberId'
  from jsonb_array_elements(p_plan -> 'eventMemberReferences') as reference(value)
  order by reference.value ->> 'eventId' collate "C",
    reference.value ->> 'memberId' collate "C";

  insert into public.cloud_event_band_references (
    workspace_id, event_id, band_id
  )
  select p_workspace_id, reference.value ->> 'eventId',
    reference.value ->> 'bandId'
  from jsonb_array_elements(p_plan -> 'eventBandReferences') as reference(value)
  order by reference.value ->> 'eventId' collate "C",
    reference.value ->> 'bandId' collate "C";

  select generation into result_generation
  from public.cloud_event_workspace_generations
  where workspace_id = p_workspace_id;

  insert into public.cloud_workspace_master_backfills (
    workspace_id, plan_fingerprint, source_generation, result_generation,
    event_count, member_count, band_count,
    band_member_relation_count, event_member_reference_count,
    event_band_reference_count
  ) values (
    p_workspace_id, p_plan_fingerprint, current_generation, result_generation,
    planned_event_count, planned_member_count, planned_band_count,
    jsonb_array_length(p_plan -> 'bandMembers'),
    jsonb_array_length(p_plan -> 'eventMemberReferences'),
    jsonb_array_length(p_plan -> 'eventBandReferences')
  );

  return jsonb_build_object(
    'status', 'applied',
    'workspaceId', p_workspace_id,
    'workspaceStatus', master_status,
    'sourceGeneration', current_generation::text,
    'resultGeneration', result_generation::text,
    'planFingerprint', p_plan_fingerprint,
    'eventCount', planned_event_count,
    'memberCount', planned_member_count,
    'bandCount', planned_band_count,
    'bandMemberRelationCount', jsonb_array_length(p_plan -> 'bandMembers'),
    'eventMemberReferenceCount',
      jsonb_array_length(p_plan -> 'eventMemberReferences'),
    'eventBandReferenceCount',
      jsonb_array_length(p_plan -> 'eventBandReferences')
  );
end;
$$;

revoke all on function public.backfill_workspace_masters_validated(
  uuid, text, text, jsonb, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.backfill_workspace_masters_validated(
  uuid, text, text, jsonb, boolean
) to service_role;

comment on table public.cloud_workspace_master_backfills is
  'One successful Snapshot V1-to-normalized-Master plan per Workspace; status remains legacy until a later cutover.';
comment on function public.inspect_workspace_master_backfill_source(uuid) is
  'Backend-only, generation-consistent Snapshot V1 source for Workspace Master backfill planning.';
comment on function public.backfill_workspace_masters_validated(
  uuid, text, text, jsonb, boolean
) is
  'Backend-only preview/apply RPC that revalidates the complete source set, generation, revisions, exact Master merge, and reference closure atomically.';

-- Direct and inherited ACLs must preserve a backend-only migration surface.
do $$
declare
  table_oid oid := to_regclass('public.cloud_workspace_master_backfills');
  inspect_oid oid := to_regprocedure(
    'public.inspect_workspace_master_backfill_source(uuid)'
  );
  apply_oid oid := to_regprocedure(
    'public.backfill_workspace_masters_validated(uuid,text,text,jsonb,boolean)'
  );
  function_oid oid;
begin
  if table_oid is null or inspect_oid is null or apply_oid is null then
    raise exception 'Workspace Master backfill contract is incomplete'
      using errcode = '55000';
  end if;

  foreach function_oid in array array[inspect_oid, apply_oid] loop
    if not has_function_privilege('service_role', function_oid, 'EXECUTE')
      or has_function_privilege('authenticated', function_oid, 'EXECUTE')
      or has_function_privilege('anon', function_oid, 'EXECUTE')
      or exists (
        select 1 from pg_catalog.pg_proc
        cross join lateral pg_catalog.aclexplode(coalesce(
          pg_proc.proacl, pg_catalog.acldefault('f', pg_proc.proowner)
        )) as function_acl
        where pg_proc.oid = function_oid
          and function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      ) then
      raise exception 'Workspace Master backfill RPC privileges are unsafe'
        using errcode = '42501';
    end if;
  end loop;

  if exists (
      select 1
      from (values ('service_role'), ('authenticated'), ('anon'))
        as inspected_role(role_name)
      cross join (values
        ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
        ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
      ) as inspected_privilege(privilege_name)
      where has_table_privilege(
        inspected_role.role_name,
        table_oid,
        inspected_privilege.privilege_name
      )
    ) or has_any_column_privilege(
      'service_role', table_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    )
    or has_any_column_privilege(
      'authenticated', table_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    )
    or has_any_column_privilege(
      'anon', table_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    )
    or exists (
      select 1 from pg_catalog.pg_class
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_class.relacl, pg_catalog.acldefault('r', pg_class.relowner)
      )) as table_acl
      where pg_class.oid = table_oid and table_acl.grantee = 0
    ) or exists (
      select 1
      from pg_catalog.pg_attribute
      cross join lateral pg_catalog.aclexplode(pg_attribute.attacl)
        as column_acl
      where pg_attribute.attrelid = table_oid
        and pg_attribute.attnum > 0
        and not pg_attribute.attisdropped
        and pg_attribute.attacl is not null
        and column_acl.grantee = 0
    ) then
    raise exception 'Workspace Master backfill table privileges are unsafe'
      using errcode = '42501';
  end if;
end;
$$;

commit;
