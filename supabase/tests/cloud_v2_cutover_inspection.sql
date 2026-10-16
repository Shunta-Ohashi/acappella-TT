\set ON_ERROR_STOP on

-- Run only against a disposable database with every repository migration.
-- All fixture changes are rolled back.
begin;

do $$
declare
  target_workspace_id constant uuid :=
    '79000000-0000-4000-8000-000000000001';
  other_workspace_id constant uuid :=
    '79000000-0000-4000-8000-000000000002';
  result jsonb;
  generation_before bigint;
  generation_after bigint;
  function_oid oid := to_regprocedure(
    'public.inspect_cloud_v2_cutover_state(uuid)'
  );
begin
  if function_oid is null then
    raise exception 'Cutover inspection RPC is missing';
  end if;
  if not has_function_privilege('service_role', function_oid, 'EXECUTE')
    or has_function_privilege('authenticated', function_oid, 'EXECUTE')
    or has_function_privilege('anon', function_oid, 'EXECUTE')
    or exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl, pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Cutover inspection RPC ACL is unsafe';
  end if;

  if exists (
    select 1 from public.workspaces
    where id in (target_workspace_id, other_workspace_id)
  ) then
    raise exception 'Dedicated cutover inspection fixture IDs already exist';
  end if;

  insert into public.workspaces (id, name) values
    (target_workspace_id, 'Cutover inspection target'),
    (other_workspace_id, 'Cutover inspection isolation control');
  insert into public.workspace_master_members (
    workspace_id, member_id, real_name, active
  ) values (
    other_workspace_id, 'other-member', 'Isolation control', true
  );

  select generation into generation_before
  from public.cloud_event_workspace_generations
  where workspace_id = target_workspace_id;

  result := public.inspect_cloud_v2_cutover_state(target_workspace_id);
  if result ->> 'status' is distinct from 'ok'
    or result ->> 'workspaceId' is distinct from target_workspace_id::text
    or result ->> 'workspaceStatus' is distinct from 'legacy'
    or (result ->> 'workspaceGeneration')::bigint is distinct from generation_before
    or jsonb_typeof(result -> 'events') is distinct from 'array'
    or jsonb_array_length(result -> 'events') is distinct from 0
    or jsonb_typeof(result -> 'masters' -> 'members') is distinct from 'array'
    or jsonb_array_length(result -> 'masters' -> 'members') is distinct from 0
    or jsonb_typeof(result -> 'masters' -> 'bands') is distinct from 'array'
    or jsonb_array_length(result -> 'masters' -> 'bands') is distinct from 0
    or jsonb_typeof(result -> 'relations' -> 'bandMembers') is distinct from 'array'
    or jsonb_array_length(result -> 'relations' -> 'bandMembers') is distinct from 0
    or jsonb_typeof(result -> 'relations' -> 'eventMemberReferences')
      is distinct from 'array'
    or jsonb_array_length(result -> 'relations' -> 'eventMemberReferences')
      is distinct from 0
    or jsonb_typeof(result -> 'relations' -> 'eventBandReferences')
      is distinct from 'array'
    or jsonb_array_length(result -> 'relations' -> 'eventBandReferences')
      is distinct from 0
    or jsonb_typeof(result -> 'counts' -> 'events') is distinct from 'number'
    or result -> 'counts' ->> 'events' is distinct from '0'
    or jsonb_typeof(result -> 'counts' -> 'members') is distinct from 'number'
    or result -> 'counts' ->> 'members' is distinct from '0'
    or jsonb_typeof(result -> 'counts' -> 'bands') is distinct from 'number'
    or result -> 'counts' ->> 'bands' is distinct from '0'
    or jsonb_typeof(result -> 'counts' -> 'bandMembers') is distinct from 'number'
    or result -> 'counts' ->> 'bandMembers' is distinct from '0'
    or jsonb_typeof(result -> 'counts' -> 'eventMemberReferences')
      is distinct from 'number'
    or result -> 'counts' ->> 'eventMemberReferences' is distinct from '0'
    or jsonb_typeof(result -> 'counts' -> 'eventBandReferences')
      is distinct from 'number'
    or result -> 'counts' ->> 'eventBandReferences' is distinct from '0' then
    raise exception 'Empty/isolation inspection response is invalid';
  end if;

  select generation into generation_after
  from public.cloud_event_workspace_generations
  where workspace_id = target_workspace_id;
  if generation_after is distinct from generation_before then
    raise exception 'Read-only inspection changed Workspace generation';
  end if;

  update public.cloud_workspace_master_states set status = 'conflict'
  where workspace_id = target_workspace_id;
  result := public.inspect_cloud_v2_cutover_state(target_workspace_id);
  if result ->> 'workspaceStatus' is distinct from 'conflict' then
    raise exception 'Conflict Workspace status was not inspected';
  end if;

  update public.cloud_workspace_master_states set status = 'ready'
  where workspace_id = target_workspace_id;
  result := public.inspect_cloud_v2_cutover_state(target_workspace_id);
  if result ->> 'workspaceStatus' is distinct from 'ready' then
    raise exception 'Ready Workspace status was not inspected';
  end if;
end;
$$;

rollback;
