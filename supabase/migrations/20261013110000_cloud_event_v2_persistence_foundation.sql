-- Add the backend-only Snapshot V2 persistence contract without switching the
-- existing application from Snapshot V1. V2 stores Event-owned collections
-- plus exact Workspace Master IDs; normalized Master bodies remain in the
-- Workspace Master tables.

begin;

create function public.is_cloud_event_v2_snapshot_shape(
  p_snapshot jsonb,
  p_event_id text,
  p_event_name text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  event_state jsonb;
  master_references jsonb;
  collection_name text;
  reference_array jsonb;
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object'
    or (p_snapshot -> 'format') is distinct from
      to_jsonb('acappella-tt-cloud-event'::text)
    or (p_snapshot -> 'version') is distinct from '2'::jsonb
    or not (p_snapshot ?& array[
      'format', 'version', 'eventState', 'masterReferences'
    ])
    or p_snapshot - array[
      'format', 'version', 'eventState', 'masterReferences'
    ] <> '{}'::jsonb then
    return false;
  end if;

  event_state := p_snapshot -> 'eventState';
  master_references := p_snapshot -> 'masterReferences';
  if jsonb_typeof(event_state) is distinct from 'object'
    or jsonb_typeof(master_references) is distinct from 'object'
    or not (event_state ?& array[
      'version',
      'events',
      'eventDays',
      'stages',
      'sections',
      'eventMembers',
      'eventMemberDays',
      'eventBands',
      'scheduleItems',
      'paAssignments',
      'dutyTypes',
      'dutyAssignments',
      'timetableLocks',
      'timetableOrderConstraints'
    ])
    or event_state - array[
      'version',
      'events',
      'eventDays',
      'stages',
      'sections',
      'eventMembers',
      'eventMemberDays',
      'eventBands',
      'scheduleItems',
      'paAssignments',
      'dutyTypes',
      'dutyAssignments',
      'timetableLocks',
      'timetableOrderConstraints'
    ] <> '{}'::jsonb
    or event_state ? 'members'
    or event_state ? 'bands'
    or (event_state -> 'version') is distinct from '5'::jsonb
    or not (master_references ?& array['memberIds', 'bandIds'])
    or master_references - array['memberIds', 'bandIds'] <> '{}'::jsonb then
    return false;
  end if;

  foreach collection_name in array array[
    'events',
    'eventDays',
    'stages',
    'sections',
    'eventMembers',
    'eventMemberDays',
    'eventBands',
    'scheduleItems',
    'paAssignments',
    'dutyTypes',
    'dutyAssignments',
    'timetableLocks',
    'timetableOrderConstraints'
  ] loop
    if jsonb_typeof(event_state -> collection_name) is distinct from 'array'
      or exists (
        select 1
        from jsonb_array_elements(event_state -> collection_name) as item(value)
        where jsonb_typeof(item.value) is distinct from 'object'
      ) then
      return false;
    end if;
  end loop;

  if jsonb_array_length(event_state -> 'events') <> 1
    or jsonb_typeof(event_state #> '{events,0,id}') is distinct from 'string'
    or jsonb_typeof(event_state #> '{events,0,name}') is distinct from 'string'
    or (event_state #> '{events,0,id}') is distinct from to_jsonb(p_event_id)
    or (event_state #> '{events,0,name}') is distinct from to_jsonb(p_event_name)
    or btrim(event_state #>> '{events,0,id}') = ''
    or btrim(event_state #>> '{events,0,name}') = '' then
    return false;
  end if;

  foreach reference_array in array array[
    master_references -> 'memberIds',
    master_references -> 'bandIds'
  ] loop
    if jsonb_typeof(reference_array) is distinct from 'array'
      or exists (
        select 1
        from jsonb_array_elements(reference_array) as reference(value)
        where jsonb_typeof(reference.value) is distinct from 'string'
          or btrim(reference.value #>> '{}') = ''
      )
      or jsonb_array_length(reference_array) <> (
        select count(distinct reference.value #>> '{}')
        from jsonb_array_elements(reference_array) as reference(value)
      ) then
      return false;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(event_state -> 'eventMembers') as record(value)
    where jsonb_typeof(record.value -> 'memberId') is distinct from 'string'
      or btrim(record.value ->> 'memberId') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(event_state -> 'eventBands') as record(value)
    where jsonb_typeof(record.value -> 'memberIds') is distinct from 'array'
      or exists (
        select 1
        from jsonb_array_elements(record.value -> 'memberIds') as member(value)
        where jsonb_typeof(member.value) is distinct from 'string'
          or btrim(member.value #>> '{}') = ''
      )
      or (
        record.value ? 'bandId'
        and (
          jsonb_typeof(record.value -> 'bandId') is distinct from 'string'
          or btrim(record.value ->> 'bandId') = ''
        )
      )
  ) or exists (
    select 1
    from jsonb_array_elements(event_state -> 'paAssignments') as record(value)
    where jsonb_typeof(record.value -> 'memberId') is distinct from 'string'
      or btrim(record.value ->> 'memberId') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(event_state -> 'dutyAssignments') as record(value)
    where jsonb_typeof(record.value -> 'memberId') is distinct from 'string'
      or btrim(record.value ->> 'memberId') = ''
  ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

revoke all on function public.is_cloud_event_v2_snapshot_shape(jsonb, text, text)
  from public, anon, authenticated, service_role;

create function public.cloud_event_v2_direct_member_ids(p_snapshot jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    array_agg(reference_id order by reference_id collate "C"),
    array[]::text[]
  )
  from (
    select distinct event_member.value ->> 'memberId' as reference_id
    from jsonb_array_elements(
      p_snapshot #> '{eventState,eventMembers}'
    ) as event_member(value)
    union
    select distinct event_band_member.value #>> '{}' as reference_id
    from jsonb_array_elements(
      p_snapshot #> '{eventState,eventBands}'
    ) as event_band(value)
    cross join lateral jsonb_array_elements(
      event_band.value -> 'memberIds'
    ) as event_band_member(value)
    union
    select distinct assignment.value ->> 'memberId' as reference_id
    from jsonb_array_elements(
      p_snapshot #> '{eventState,paAssignments}'
    ) as assignment(value)
    union
    select distinct assignment.value ->> 'memberId' as reference_id
    from jsonb_array_elements(
      p_snapshot #> '{eventState,dutyAssignments}'
    ) as assignment(value)
  ) as direct_member_ids
  where reference_id is not null;
$$;

create function public.cloud_event_v2_direct_band_ids(p_snapshot jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    array_agg(reference_id order by reference_id collate "C"),
    array[]::text[]
  )
  from (
    select distinct event_band.value ->> 'bandId' as reference_id
    from jsonb_array_elements(
      p_snapshot #> '{eventState,eventBands}'
    ) as event_band(value)
    where event_band.value ? 'bandId'
  ) as direct_band_ids
  where reference_id is not null;
$$;

revoke all on function public.cloud_event_v2_direct_member_ids(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.cloud_event_v2_direct_band_ids(jsonb)
  from public, anon, authenticated, service_role;

alter table public.cloud_events
  drop constraint cloud_events_snapshot_shape_check;

alter table public.cloud_events
  add constraint cloud_events_snapshot_shape_check check (
    (
      (
        jsonb_typeof(event_snapshot) = 'object'
        and (event_snapshot -> 'format') is not distinct from
          to_jsonb('acappella-tt-cloud-event'::text)
        and (event_snapshot -> 'version') is not distinct from '1'::jsonb
        and jsonb_typeof(event_snapshot -> 'appState') = 'object'
        and (event_snapshot #> '{appState,version}') is not distinct from '5'::jsonb
        and case
          when jsonb_typeof(event_snapshot #> '{appState,events}') = 'array'
            then jsonb_array_length(event_snapshot #> '{appState,events}') = 1
              and jsonb_typeof(event_snapshot #> '{appState,events,0}') = 'object'
              and jsonb_typeof(event_snapshot #> '{appState,events,0,id}') = 'string'
              and (event_snapshot #> '{appState,events,0,id}') is not distinct from
                to_jsonb(event_id)
              and jsonb_typeof(event_snapshot #> '{appState,events,0,name}') = 'string'
              and (event_snapshot #> '{appState,events,0,name}') is not distinct from
                to_jsonb(event_name)
          else false
        end
      )
      or public.is_cloud_event_v2_snapshot_shape(
        event_snapshot,
        event_id,
        event_name
      )
    ) is true
  );

-- A legacy V1 writer remains available for legacy/conflict Workspaces. Once a
-- Workspace is explicitly ready, reject every V1 insert/update at the table
-- boundary so an old client cannot reintroduce duplicated Master bodies.
create function public.guard_ready_workspace_from_v1_event_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  master_status text;
begin
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

revoke all on function public.guard_ready_workspace_from_v1_event_write()
  from public, anon, authenticated, service_role;

create trigger cloud_events_guard_ready_workspace_from_v1_write
  before insert or update on public.cloud_events
  for each row execute function public.guard_ready_workspace_from_v1_event_write();

create function public.save_cloud_event_v2_validated(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_event_snapshot jsonb,
  p_expected_revision bigint,
  p_expected_generation text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  membership_role text;
  master_status text;
  snapshot_event_id text;
  snapshot_event_name text;
  current_generation bigint;
  existing_row public.cloud_events%rowtype;
  saved_row public.cloud_events%rowtype;
  event_exists boolean;
  direct_member_ids text[];
  direct_band_ids text[];
  referenced_member_ids text[];
  referenced_band_ids text[];
  required_member_ids text[];
  locked_count bigint;
begin
  if p_actor_id is null or p_workspace_id is null then
    raise exception 'authenticated actor and workspace are required'
      using errcode = '42501';
  end if;
  if p_expected_generation is null
    or p_expected_generation !~ '^(0|[1-9][0-9]*)$'
    or (p_expected_revision is not null and p_expected_revision <= 0) then
    raise exception 'expected revision or Workspace generation is invalid'
      using errcode = '22023';
  end if;

  snapshot_event_id := p_event_snapshot #>> '{eventState,events,0,id}';
  snapshot_event_name := p_event_snapshot #>> '{eventState,events,0,name}';
  if snapshot_event_id is null or btrim(snapshot_event_id) = ''
    or snapshot_event_name is null or btrim(snapshot_event_name) = ''
    or not public.is_cloud_event_v2_snapshot_shape(
      p_event_snapshot,
      snapshot_event_id,
      snapshot_event_name
    ) then
    raise exception 'validated Snapshot V2 is required'
      using errcode = '22023';
  end if;

  select workspace_members.role
    into membership_role
    from public.workspace_members
    where workspace_members.workspace_id = p_workspace_id
      and workspace_members.user_id = p_actor_id
    for share;

  if membership_role is null or membership_role not in ('owner', 'editor') then
    raise exception 'Cloud Event V2 write access denied'
      using errcode = '42501';
  end if;

  select cloud_workspace_master_states.status
    into master_status
    from public.cloud_workspace_master_states
    where cloud_workspace_master_states.workspace_id = p_workspace_id
    for share;

  if master_status is distinct from 'ready' then
    raise exception 'Snapshot V2 writes require a ready Workspace'
      using errcode = '55000';
  end if;

  select * into existing_row
    from public.cloud_events
    where cloud_events.workspace_id = p_workspace_id
      and cloud_events.event_id = snapshot_event_id
    for update;
  event_exists := found;

  if event_exists then
    if (existing_row.event_snapshot -> 'version') is distinct from '2'::jsonb then
      raise exception 'Snapshot V1 rows cannot be overwritten by the V2 writer'
        using errcode = 'PVE01';
    end if;
    if p_expected_revision is null then
      raise exception 'Cloud Event already exists'
        using errcode = '23505';
    end if;
    if existing_row.revision <> p_expected_revision then
      raise exception 'Cloud Event revision changed'
        using errcode = '40001';
    end if;
  elsif p_expected_revision is not null then
    raise exception 'Cloud Event does not exist for revision update'
      using errcode = 'P0002';
  end if;

  direct_member_ids := public.cloud_event_v2_direct_member_ids(p_event_snapshot);
  direct_band_ids := public.cloud_event_v2_direct_band_ids(p_event_snapshot);

  select coalesce(
    array_agg(reference.value #>> '{}' order by (reference.value #>> '{}') collate "C"),
    array[]::text[]
  ) into referenced_member_ids
  from jsonb_array_elements(
    p_event_snapshot #> '{masterReferences,memberIds}'
  ) as reference(value);

  select coalesce(
    array_agg(reference.value #>> '{}' order by (reference.value #>> '{}') collate "C"),
    array[]::text[]
  ) into referenced_band_ids
  from jsonb_array_elements(
    p_event_snapshot #> '{masterReferences,bandIds}'
  ) as reference(value);

  if direct_band_ids is distinct from referenced_band_ids
    or not direct_member_ids <@ referenced_member_ids then
    raise exception 'Snapshot V2 direct Master references are incomplete'
      using errcode = 'PVE02';
  end if;

  -- Lock order shared with Master mutations: membership, master state,
  -- referenced Members in C order, referenced Bands in C order, generation.
  -- Locking Band rows freezes their ordered defaultMember relation while the
  -- exact transitive closure is calculated below.
  select count(*) into locked_count
  from (
    select workspace_master_members.member_id
    from public.workspace_master_members
    where workspace_master_members.workspace_id = p_workspace_id
      and workspace_master_members.member_id = any(referenced_member_ids)
    order by workspace_master_members.member_id collate "C"
    for share
  ) as locked_members;
  if locked_count <> cardinality(referenced_member_ids) then
    raise exception 'Snapshot V2 references a missing Workspace Member'
      using errcode = 'PVE02';
  end if;

  select count(*) into locked_count
  from (
    select workspace_master_bands.band_id
    from public.workspace_master_bands
    where workspace_master_bands.workspace_id = p_workspace_id
      and workspace_master_bands.band_id = any(referenced_band_ids)
    order by workspace_master_bands.band_id collate "C"
    for share
  ) as locked_bands;
  if locked_count <> cardinality(referenced_band_ids) then
    raise exception 'Snapshot V2 references a missing Workspace Band'
      using errcode = 'PVE02';
  end if;

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

  if required_member_ids is distinct from referenced_member_ids then
    raise exception 'Snapshot V2 Master reference closure does not match'
      using errcode = 'PVE02';
  end if;

  select cloud_event_workspace_generations.generation
    into current_generation
    from public.cloud_event_workspace_generations
    where cloud_event_workspace_generations.workspace_id = p_workspace_id
    for update;

  if current_generation is null then
    raise exception 'Cloud Event Workspace generation is unavailable'
      using errcode = '55000';
  end if;
  if p_expected_generation::bigint <> current_generation then
    raise exception 'Workspace changed before Snapshot V2 save'
      using errcode = 'PVE04';
  end if;

  if event_exists then
    update public.cloud_events
      set event_name = snapshot_event_name,
          event_snapshot = p_event_snapshot
      where cloud_events.workspace_id = p_workspace_id
        and cloud_events.event_id = snapshot_event_id
      returning * into saved_row;
  else
    insert into public.cloud_events (
      workspace_id,
      event_id,
      event_name,
      event_snapshot
    ) values (
      p_workspace_id,
      snapshot_event_id,
      snapshot_event_name,
      p_event_snapshot
    ) returning * into saved_row;
  end if;

  delete from public.cloud_event_member_references
    where cloud_event_member_references.workspace_id = p_workspace_id
      and cloud_event_member_references.event_id = snapshot_event_id;
  delete from public.cloud_event_band_references
    where cloud_event_band_references.workspace_id = p_workspace_id
      and cloud_event_band_references.event_id = snapshot_event_id;

  insert into public.cloud_event_member_references (
    workspace_id,
    event_id,
    member_id
  )
  select p_workspace_id, snapshot_event_id, reference_id
  from unnest(referenced_member_ids) as reference_id;

  insert into public.cloud_event_band_references (
    workspace_id,
    event_id,
    band_id
  )
  select p_workspace_id, snapshot_event_id, reference_id
  from unnest(referenced_band_ids) as reference_id;

  select cloud_event_workspace_generations.generation
    into current_generation
    from public.cloud_event_workspace_generations
    where cloud_event_workspace_generations.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'workspaceGeneration', current_generation::text,
    'record', to_jsonb(saved_row)
  );
end;
$$;

revoke all on function public.save_cloud_event_v2_validated(
  uuid, uuid, jsonb, bigint, text
) from public, anon, authenticated;
grant execute on function public.save_cloud_event_v2_validated(
  uuid, uuid, jsonb, bigint, text
) to service_role;

do $cloud_event_v2_execute_privilege_guard$
declare
  save_function_oid oid := to_regprocedure(
    'public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text)'
  );
  authenticated_role_oid oid;
  anon_role_oid oid;
  service_role_oid oid;
begin
  select oid into authenticated_role_oid
    from pg_catalog.pg_roles where rolname = 'authenticated';
  select oid into anon_role_oid
    from pg_catalog.pg_roles where rolname = 'anon';
  select oid into service_role_oid
    from pg_catalog.pg_roles where rolname = 'service_role';

  if save_function_oid is null
    or authenticated_role_oid is null
    or anon_role_oid is null
    or service_role_oid is null
    or not (
      select pg_proc.prosecdef
      from pg_catalog.pg_proc
      where pg_proc.oid = save_function_oid
    )
    or has_function_privilege(authenticated_role_oid, save_function_oid, 'EXECUTE')
    or has_function_privilege(anon_role_oid, save_function_oid, 'EXECUTE')
    or not has_function_privilege(service_role_oid, save_function_oid, 'EXECUTE')
    or exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl,
        pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = save_function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Snapshot V2 save RPC backend-only contract is unsafe'
      using errcode = '42501';
  end if;
end
$cloud_event_v2_execute_privilege_guard$;

comment on function public.save_cloud_event_v2_validated(
  uuid, uuid, jsonb, bigint, text
) is
  'Backend-only Snapshot V2 create/update with ready-state, Event revision CAS, Workspace generation CAS, exact Master closure, and atomic reference-index replacement.';
comment on function public.guard_ready_workspace_from_v1_event_write() is
  'Rejects legacy Snapshot V1 writes only after a Workspace has explicitly reached normalized-master ready state.';

commit;
