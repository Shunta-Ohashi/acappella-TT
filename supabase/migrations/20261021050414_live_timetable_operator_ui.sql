begin;

-- A role label alone cannot distinguish an old editor grant from a later
-- editor membership reached through editor -> viewer -> editor. Keep a
-- per-membership authorization epoch and rotate it only when the role really
-- changes. Direct attempts to rewrite the epoch without changing role are
-- normalized back to the previous value by the trigger.
alter table public.workspace_members
  add column authorization_epoch uuid not null default gen_random_uuid();

create function public.rotate_workspace_member_authorization_epoch()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    new.authorization_epoch := gen_random_uuid();
  else
    new.authorization_epoch := old.authorization_epoch;
  end if;
  return new;
end;
$$;

revoke all on function public.rotate_workspace_member_authorization_epoch()
  from public, anon, authenticated, service_role;

create trigger workspace_members_rotate_authorization_epoch
  before update on public.workspace_members
  for each row
  execute function public.rotate_workspace_member_authorization_epoch();

-- PR #79 keeps the immutable Snapshot V1 projection and Live progress data
-- separate. Existing assignments were necessarily granted to editors under
-- migration #15, so backfill the grant-time role as editor rather than using
-- the assignee's current (possibly downgraded) membership role.
alter table public.live_timetable_stage_operators
  add column granted_role text,
  add column granted_authorization_epoch uuid;

update public.live_timetable_stage_operators as assignment
set granted_role = 'editor',
    granted_authorization_epoch = membership.authorization_epoch
from public.workspace_members as membership
where membership.workspace_id = assignment.workspace_id
  and membership.user_id = assignment.user_id;

alter table public.live_timetable_stage_operators
  alter column granted_role set not null,
  alter column granted_authorization_epoch set not null,
  add constraint live_timetable_stage_operators_granted_role_check
    check (granted_role in ('editor', 'viewer'));

-- Live progress enablement and anonymous publication are different decisions.
-- No browser RPC for enabling public_view_enabled is exposed in this PR.
alter table public.live_timetables
  add column public_view_enabled boolean not null default false;

-- Preserve the #15 implementation as an internal helper, then replace the
-- canonical helper with exact grant-role matching for editor/viewer operators.
alter function public.build_live_timetable_stages_json(
  uuid, uuid, text, boolean
) rename to build_live_timetable_stages_json_v15;

revoke all on function public.build_live_timetable_stages_json_v15(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;

create function public.build_live_timetable_stages_json(
  p_live_id uuid,
  p_actor_id uuid,
  p_membership_role text,
  p_public boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  stages_json jsonb;
begin
  stages_json := public.build_live_timetable_stages_json_v15(
    p_live_id,
    p_actor_id,
    p_membership_role,
    p_public
  );

  if p_public then
    return stages_json;
  end if;

  return coalesce((
    select jsonb_agg(
      stage.value || jsonb_build_object(
        'canOperate',
        p_membership_role = 'owner'
        or (
          p_membership_role in ('editor', 'viewer')
          and exists (
            select 1
            from public.live_timetable_stage_operators as assignment
            join public.workspace_members as membership
              on membership.workspace_id = assignment.workspace_id
              and membership.user_id = assignment.user_id
            where assignment.stage_id =
                (stage.value ->> 'stageId')::uuid
              and assignment.live_timetable_id = p_live_id
              and assignment.user_id = p_actor_id
              and assignment.granted_role = p_membership_role
              and membership.role = p_membership_role
              and assignment.granted_authorization_epoch =
                membership.authorization_epoch
          )
        )
      )
      order by stage.ordinality
    )
    from jsonb_array_elements(stages_json)
      with ordinality as stage(value, ordinality)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.build_live_timetable_stages_json(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;

-- Preserve the original public DTO builder but put an additional, locked,
-- opt-in gate in front of it. The renamed helper is never browser executable.
alter function public.load_live_timetable_public(uuid)
  rename to load_live_timetable_public_v15;

revoke all on function public.load_live_timetable_public_v15(uuid)
  from public, anon, authenticated, service_role;

create function public.load_live_timetable_public(p_public_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_public_id is null then
    return null;
  end if;

  perform 1
  from public.live_timetables
  where live_timetables.public_id = p_public_id
    and live_timetables.is_published
    and live_timetables.public_view_enabled
  for share;
  if not found then
    return null;
  end if;

  return public.load_live_timetable_public_v15(p_public_id);
end;
$$;

revoke all on function public.load_live_timetable_public(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_live_timetable_public(uuid)
  to anon, authenticated;

-- Owner-only assignment now records the assignee's exact role. Reassigning an
-- existing stale row is an explicit role grant and therefore increments the
-- management CAS revision; an identical assignment remains a no-op.
create or replace function public.set_live_timetable_stage_operator(
  p_live_id uuid,
  p_source_stage_id text,
  p_operator_user_id uuid,
  p_assign boolean,
  p_expected_management_revision text,
  p_expected_projection_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  caller_role text;
  operator_role text;
  operator_authorization_epoch uuid;
  live_row record;
  target_stage_id uuid;
  changed_count integer;
  changed_at timestamptz;
begin
  if caller_id is null then
    raise exception 'Live operator mutation requires authentication'
      using errcode = '42501';
  end if;
  if p_live_id is null
    or p_source_stage_id is null
    or btrim(p_source_stage_id) = ''
    or p_operator_user_id is null
    or p_assign is null
    or not public.is_live_timetable_revision_text(
      p_expected_management_revision
    )
    or not public.is_live_timetable_revision_text(
      p_expected_projection_version
    ) then
    raise exception 'Live operator mutation arguments are invalid'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  perform 1
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id in (caller_id, p_operator_user_id)
  order by workspace_members.user_id
  for share;

  select workspace_members.role into caller_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id;
  select workspace_members.role, workspace_members.authorization_epoch
    into operator_role, operator_authorization_epoch
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = p_operator_user_id;

  if caller_role is distinct from 'owner' then
    raise exception 'Only a Workspace owner can manage Live operators'
      using errcode = '42501';
  end if;
  if p_assign and (
    operator_role is null
    or operator_role not in ('editor', 'viewer')
  ) then
    raise exception 'Live Stage operator must be a current editor or viewer'
      using errcode = 'LTT01';
  end if;

  select * into live_row
  from public.live_timetables
  where live_timetables.id = p_live_id
    and live_timetables.workspace_id = target_workspace_id
  for update;
  if not found then
    raise exception 'Live Timetable changed during operator mutation'
      using errcode = '40001';
  end if;
  if live_row.management_revision <>
      p_expected_management_revision::bigint
    or live_row.projection_version <>
      p_expected_projection_version::bigint then
    raise exception 'Live operator mutation is stale'
      using errcode = '40001';
  end if;

  select live_timetable_stages.id into target_stage_id
  from public.live_timetable_stages
  where live_timetable_stages.live_timetable_id = p_live_id
    and live_timetable_stages.source_stage_id = p_source_stage_id
    and live_timetable_stages.projection_version = live_row.projection_version
  for share;
  if target_stage_id is null then
    raise exception 'Live Stage was not found'
      using errcode = 'P0002';
  end if;

  if p_assign then
    insert into public.live_timetable_stage_operators (
      workspace_id,
      live_timetable_id,
      stage_id,
      user_id,
      granted_role,
      granted_authorization_epoch
    ) values (
      target_workspace_id,
      p_live_id,
      target_stage_id,
      p_operator_user_id,
      operator_role,
      operator_authorization_epoch
    )
    on conflict (stage_id, user_id) do update
      set granted_role = excluded.granted_role,
          granted_authorization_epoch =
            excluded.granted_authorization_epoch,
          created_at = clock_timestamp()
      where live_timetable_stage_operators.granted_role
          is distinct from excluded.granted_role
        or live_timetable_stage_operators.granted_authorization_epoch
          is distinct from excluded.granted_authorization_epoch;
  else
    delete from public.live_timetable_stage_operators
    where live_timetable_stage_operators.stage_id = target_stage_id
      and live_timetable_stage_operators.user_id = p_operator_user_id;
  end if;
  get diagnostics changed_count = row_count;

  if changed_count > 0 then
    changed_at := clock_timestamp();
    update public.live_timetables
    set management_revision = management_revision + 1,
        updated_at = changed_at
    where id = p_live_id
    returning * into live_row;
    update public.live_timetable_stages
    set updated_at = changed_at
    where id = target_stage_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'liveId', live_row.id,
    'stageId', target_stage_id,
    'operatorUserId', p_operator_user_id,
    'assigned', p_assign,
    'projectionVersion', live_row.projection_version::text,
    'managementRevision', live_row.management_revision::text
  );
end;
$$;

revoke all on function public.set_live_timetable_stage_operator(
  uuid, text, uuid, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_live_timetable_stage_operator(
  uuid, text, uuid, boolean, text, text
) to authenticated;

-- Progress mutations admit owner unconditionally and exact-role assignments
-- for editor/viewer. Membership and assignment rows are held through commit,
-- so concurrent downgrade/removal cannot pass the authorization check.
create or replace function public.transition_live_timetable_entry(
  p_operation text,
  p_live_id uuid,
  p_source_stage_id text,
  p_source_schedule_item_id text,
  p_expected_stage_revision text,
  p_expected_projection_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  membership_role text;
  membership_authorization_epoch uuid;
  live_row record;
  stage_row record;
  entry_row record;
  first_pending_position integer;
  v_next_entry_position integer;
  v_next_performance_position integer;
  pending_count integer;
  operation_time timestamptz;
  next_progress_status text;
begin
  if caller_id is null then
    raise exception 'Live progress mutation requires authentication'
      using errcode = '42501';
  end if;
  if p_operation is null
    or p_operation not in ('start', 'end')
    or p_live_id is null
    or p_source_stage_id is null
    or btrim(p_source_stage_id) = ''
    or p_source_schedule_item_id is null
    or btrim(p_source_schedule_item_id) = ''
    or not public.is_live_timetable_revision_text(p_expected_stage_revision)
    or not public.is_live_timetable_revision_text(
      p_expected_projection_version
    ) then
    raise exception 'Live progress mutation arguments are invalid'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  select workspace_members.role, workspace_members.authorization_epoch
    into membership_role, membership_authorization_epoch
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id
  for share;
  if membership_role is null
    or membership_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Live progress mutation is not permitted'
      using errcode = '42501';
  end if;

  select * into live_row
  from public.live_timetables
  where live_timetables.id = p_live_id
    and live_timetables.workspace_id = target_workspace_id
  for share;
  if not found then
    raise exception 'Live Timetable changed during progress mutation'
      using errcode = '40001';
  end if;
  if live_row.projection_version <>
    p_expected_projection_version::bigint then
    raise exception 'Live projection version changed'
      using errcode = '40001';
  end if;

  if membership_role in ('editor', 'viewer') then
    perform 1
    from public.live_timetable_stage_operators as assignment
    join public.live_timetable_stages as assigned_stage
      on assigned_stage.id = assignment.stage_id
    where assignment.live_timetable_id = p_live_id
      and assignment.user_id = caller_id
      and assignment.granted_role = membership_role
      and assignment.granted_authorization_epoch =
        membership_authorization_epoch
      and assigned_stage.source_stage_id = p_source_stage_id
      and assigned_stage.projection_version = live_row.projection_version
    for share of assignment;
    if not found then
      raise exception 'Actor is not assigned to this Live Stage for the current role'
        using errcode = '42501';
    end if;
  end if;

  -- Establish the Stage authorization boundary before reporting whether
  -- progress is enabled. An unassigned editor/viewer must not learn or act on
  -- Live management state through this mutation endpoint.
  if not live_row.is_published then
    raise exception 'Live progress mutation requires publication'
      using errcode = '55000';
  end if;

  select * into stage_row
  from public.live_timetable_stages
  where live_timetable_stages.live_timetable_id = p_live_id
    and live_timetable_stages.source_stage_id = p_source_stage_id
  for update;
  if not found then
    raise exception 'Live Stage was not found'
      using errcode = 'P0002';
  end if;
  if stage_row.projection_version <> live_row.projection_version
    or stage_row.revision <> p_expected_stage_revision::bigint then
    raise exception 'Live Stage revision changed'
      using errcode = '40001';
  end if;

  select * into entry_row
  from public.live_timetable_entries
  where live_timetable_entries.stage_id = stage_row.id
    and live_timetable_entries.source_schedule_item_id =
      p_source_schedule_item_id
  for update;
  if not found then
    raise exception 'Live entry was not found'
      using errcode = 'P0002';
  end if;

  if p_operation = 'start' then
    select min(live_timetable_entries.position)
      into first_pending_position
    from public.live_timetable_entries
    where live_timetable_entries.stage_id = stage_row.id
      and live_timetable_entries.status = 'pending';

    if entry_row.status <> 'pending'
      or first_pending_position is distinct from entry_row.position
      or exists (
        select 1
        from public.live_timetable_entries
        where live_timetable_entries.stage_id = stage_row.id
          and live_timetable_entries.status = 'in_progress'
      ) then
      raise exception 'Only the first pending Live entry can start'
        using errcode = '55000';
    end if;

    operation_time := clock_timestamp();
    update public.live_timetable_entries
    set status = 'in_progress',
        actual_started_at = operation_time,
        started_by = caller_id,
        updated_at = operation_time
    where id = entry_row.id
    returning * into entry_row;

    select min(position) filter (where status = 'pending'),
           min(position) filter (
             where status = 'pending' and kind = 'performance'
           )
      into v_next_entry_position, v_next_performance_position
    from public.live_timetable_entries
    where stage_id = stage_row.id;
    next_progress_status := 'in_progress';
  else
    if entry_row.status <> 'in_progress'
      or stage_row.current_entry_position is distinct from entry_row.position then
      raise exception 'Only the current Live entry can end'
        using errcode = '55000';
    end if;

    operation_time := clock_timestamp();
    if operation_time < entry_row.actual_started_at then
      raise exception 'Live entry end time cannot precede start time'
        using errcode = '22023';
    end if;
    update public.live_timetable_entries
    set status = 'completed',
        actual_ended_at = operation_time,
        ended_by = caller_id,
        updated_at = operation_time
    where id = entry_row.id
    returning * into entry_row;

    select count(*) filter (where status = 'pending'),
           min(position) filter (where status = 'pending'),
           min(position) filter (
             where status = 'pending' and kind = 'performance'
           )
      into pending_count, v_next_entry_position, v_next_performance_position
    from public.live_timetable_entries
    where stage_id = stage_row.id;
    next_progress_status := case
      when pending_count = 0 then 'completed'
      else 'waiting'
    end;
  end if;

  update public.live_timetable_stages
  set revision = revision + 1,
      progress_status = next_progress_status,
      current_entry_position = case
        when p_operation = 'start' then entry_row.position
        else null
      end,
      next_entry_position = v_next_entry_position,
      next_performance_position = v_next_performance_position,
      updated_at = operation_time
  where id = stage_row.id
  returning * into stage_row;

  return jsonb_build_object(
    'status', 'ok',
    'operation', p_operation,
    'liveId', live_row.id,
    'stageId', stage_row.id,
    'projectionVersion', live_row.projection_version::text,
    'stageRevision', stage_row.revision::text,
    'progressStatus', stage_row.progress_status,
    'currentEntryPosition', stage_row.current_entry_position,
    'nextEntryPosition', stage_row.next_entry_position,
    'nextPerformancePosition', stage_row.next_performance_position,
    'entry', jsonb_build_object(
      'position', entry_row.position,
      'status', entry_row.status,
      'actualStartedAt', entry_row.actual_started_at,
      'actualEndedAt', entry_row.actual_ended_at
    )
  );
end;
$$;

revoke all on function public.transition_live_timetable_entry(
  text, uuid, text, text, text, text
) from public, anon, authenticated, service_role;

-- Member-only discovery avoids exposing either table to direct browser
-- SELECT. It returns only the saved Event metadata needed to offer creation;
-- the Snapshot body is never hydrated by the operator route.
create function public.find_live_timetable_for_event_authorized(
  p_workspace_id uuid,
  p_event_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  membership_role text;
  target_live_id uuid;
  target_event_name text;
  target_source_revision integer;
begin
  if caller_id is null then
    raise exception 'Live discovery requires authentication'
      using errcode = '42501';
  end if;
  if p_workspace_id is null
    or p_event_id is null
    or btrim(p_event_id) = '' then
    raise exception 'Live discovery arguments are invalid'
      using errcode = '22023';
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = p_workspace_id
    and workspace_members.user_id = caller_id
  for share;
  if membership_role is null
    or membership_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Live discovery is not permitted'
      using errcode = '42501';
  end if;

  select cloud_events.event_name, cloud_events.revision
    into target_event_name, target_source_revision
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id
    and cloud_events.event_id = p_event_id
  for share;
  if not found then
    raise exception 'Cloud Event was not found'
      using errcode = 'P0002';
  end if;

  select live_timetables.id into target_live_id
  from public.live_timetables
  where live_timetables.workspace_id = p_workspace_id
    and live_timetables.event_id = p_event_id
  for share;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'eventId', p_event_id,
    'eventName', target_event_name,
    'sourceRevision', target_source_revision,
    'liveId', target_live_id
  );
end;
$$;

revoke all on function public.find_live_timetable_for_event_authorized(
  uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.find_live_timetable_for_event_authorized(
  uuid, text
) to authenticated;

-- Candidate discovery is owner-only and deliberately excludes email/auth
-- metadata. Final assignment still re-locks and revalidates membership.
create function public.list_live_timetable_operator_candidates(
  p_live_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  caller_role text;
  candidates_json jsonb;
begin
  if caller_id is null then
    raise exception 'Live operator candidate read requires authentication'
      using errcode = '42501';
  end if;
  if p_live_id is null then
    raise exception 'Live Timetable ID is required'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id
  for share;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  select workspace_members.role into caller_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id
  for share;
  if caller_role is distinct from 'owner' then
    raise exception 'Only a Workspace owner can list Live operators'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', workspace_members.user_id,
    'displayName', profiles.display_name
  ) order by lower(profiles.display_name), workspace_members.user_id), '[]'::jsonb)
  into candidates_json
  from public.workspace_members
  join public.profiles
    on profiles.user_id = workspace_members.user_id
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.role in ('editor', 'viewer');

  return jsonb_build_object(
    'status', 'ok',
    'liveId', p_live_id,
    'candidates', candidates_json
  );
end;
$$;

revoke all on function public.list_live_timetable_operator_candidates(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_live_timetable_operator_candidates(uuid)
  to authenticated;

comment on column public.live_timetables.public_view_enabled is
  'Independent anonymous-publication opt-in. Live progress enablement remains is_published.';
comment on column public.live_timetable_stage_operators.granted_role is
  'Exact Workspace role recorded by the owner at assignment time; current role must still match.';
comment on column public.workspace_members.authorization_epoch is
  'Rotates only when the Workspace role changes so stale Live grants cannot revive after a role round trip.';
comment on column public.live_timetable_stage_operators.granted_authorization_epoch is
  'Workspace membership authorization epoch captured by an explicit owner assignment.';
comment on function public.find_live_timetable_for_event_authorized(uuid, text) is
  'Member-only Event-to-Live discovery without granting direct live_timetables SELECT.';
comment on function public.list_live_timetable_operator_candidates(uuid) is
  'Owner-only current editor/viewer candidate list containing UUID and display name only.';

-- Migration-local fail-closed privilege and contract guard.
do $$
declare
  role_name text;
  function_oid oid;
  signature text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute
    where pg_attribute.attrelid = to_regclass('public.live_timetables')
      and pg_attribute.attname = 'public_view_enabled'
      and pg_attribute.atttypid = 'boolean'::regtype
      and pg_attribute.attnotnull
      and not pg_attribute.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute
    where pg_attribute.attrelid =
        to_regclass('public.live_timetable_stage_operators')
      and pg_attribute.attname = 'granted_role'
      and pg_attribute.atttypid = 'text'::regtype
      and pg_attribute.attnotnull
      and not pg_attribute.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute
    where pg_attribute.attrelid = to_regclass('public.workspace_members')
      and pg_attribute.attname = 'authorization_epoch'
      and pg_attribute.atttypid = 'uuid'::regtype
      and pg_attribute.attnotnull
      and not pg_attribute.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute
    where pg_attribute.attrelid =
        to_regclass('public.live_timetable_stage_operators')
      and pg_attribute.attname = 'granted_authorization_epoch'
      and pg_attribute.atttypid = 'uuid'::regtype
      and pg_attribute.attnotnull
      and not pg_attribute.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_trigger
    where pg_trigger.tgrelid = to_regclass('public.workspace_members')
      and pg_trigger.tgname = 'workspace_members_rotate_authorization_epoch'
      and pg_trigger.tgfoid = to_regprocedure(
        'public.rotate_workspace_member_authorization_epoch()'
      )
      and pg_trigger.tgtype = 19
      and pg_trigger.tgenabled = 'O'
      and not pg_trigger.tgisinternal
  ) then
    raise exception 'Live operator UI columns are incomplete'
      using errcode = '55000';
  end if;

  foreach signature in array array[
    'public.find_live_timetable_for_event_authorized(uuid,text)',
    'public.list_live_timetable_operator_candidates(uuid)'
  ] loop
    function_oid := to_regprocedure(signature);
    if function_oid is null then
      raise exception 'Live operator UI function is missing: %', signature
        using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(role_name, function_oid, 'EXECUTE')
        is distinct from (role_name = 'authenticated') then
        raise exception '% has unexpected EXECUTE on %', role_name, signature
          using errcode = '42501';
      end if;
    end loop;
    if exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl,
        pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
      raise exception 'PUBLIC retains EXECUTE on %', signature
        using errcode = '42501';
    end if;
  end loop;

  foreach signature in array array[
    'public.build_live_timetable_stages_json_v15(uuid,uuid,text,boolean)',
    'public.load_live_timetable_public_v15(uuid)'
  ] loop
    function_oid := to_regprocedure(signature);
    if function_oid is null then
      raise exception 'Live v15 helper is missing: %', signature
        using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(role_name, function_oid, 'EXECUTE') then
        raise exception '% can execute internal helper %', role_name, signature
          using errcode = '42501';
      end if;
    end loop;
  end loop;

  if has_table_privilege(
    'authenticated',
    'public.live_timetables',
    'SELECT'
  ) or has_any_column_privilege(
    'authenticated',
    'public.live_timetables',
    'SELECT'
  ) then
    raise exception 'Browser gained direct Live discovery access'
      using errcode = '42501';
  end if;
end;
$$;

commit;
