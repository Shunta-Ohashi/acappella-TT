-- Cloud Event snapshots are fully validated by the save Edge Function before
-- this backend-only function receives them. Browser roles cannot call this
-- function. In existing environments, legacy browser clients temporarily keep
-- direct INSERT/UPDATE access after this migration; deploy the Edge Function
-- and compatible frontend, drain those clients, then apply
-- 20261008160000_cloud_event_rpc_only_save.sql to revoke direct writes. Fresh
-- environments reach the final state with no browser direct-write access.

create function public.save_cloud_event_validated(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_event_snapshot jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  membership_role text;
  snapshot_event_id text;
  snapshot_event_name text;
  saved_row public.cloud_events%rowtype;
begin
  if p_actor_id is null or p_workspace_id is null then
    raise exception 'authenticated actor and workspace are required'
      using errcode = '42501';
  end if;

  snapshot_event_id := p_event_snapshot #>> '{appState,events,0,id}';
  snapshot_event_name := p_event_snapshot #>> '{appState,events,0,name}';
  if snapshot_event_id is null or btrim(snapshot_event_id) = ''
    or snapshot_event_name is null or btrim(snapshot_event_name) = '' then
    raise exception 'validated Cloud Event identity is required'
      using errcode = '22023';
  end if;

  select workspace_members.role
    into membership_role
    from public.workspace_members
    where workspace_members.workspace_id = p_workspace_id
      and workspace_members.user_id = p_actor_id
    for share;

  if membership_role is null or membership_role not in ('owner', 'editor') then
    raise exception 'Cloud Event write access denied'
      using errcode = '42501';
  end if;

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
  )
  on conflict (workspace_id, event_id) do update
    set event_name = excluded.event_name,
        event_snapshot = excluded.event_snapshot
  returning * into saved_row;

  return to_jsonb(saved_row);
end;
$$;

revoke all on function public.save_cloud_event_validated(uuid, uuid, jsonb)
  from public;
revoke all on function public.save_cloud_event_validated(uuid, uuid, jsonb)
  from anon;
revoke all on function public.save_cloud_event_validated(uuid, uuid, jsonb)
  from authenticated;
grant execute on function public.save_cloud_event_validated(uuid, uuid, jsonb)
  to service_role;

-- Direct REVOKE does not remove privileges inherited through custom roles, and
-- function default ACLs can grant EXECUTE when the function is created. Verify
-- the complete backend-only contract without mutating shared role memberships.
do $cloud_event_save_execute_privilege_guard$
declare
  save_function_oid oid := to_regprocedure(
    'public.save_cloud_event_validated(uuid,uuid,jsonb)'
  );
  authenticated_role_oid oid;
  anon_role_oid oid;
  service_role_oid oid;
  save_security_definer boolean;
  public_execute boolean;
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
    or service_role_oid is null then
    raise exception
      'Cloud Event backend-only save RPC contract cannot be verified'
      using errcode = '42501',
        hint = 'Restore the save RPC and required roles, inspect inherited EXECUTE grants, custom-role memberships, and default ACLs, then rerun this migration.';
  end if;

  select pg_proc.prosecdef
    into save_security_definer
    from pg_catalog.pg_proc
    where pg_proc.oid = save_function_oid;

  if save_security_definer is distinct from true then
    raise exception
      'Cloud Event backend-only save RPC must be SECURITY DEFINER'
      using errcode = '42501',
        hint = 'Restore the SECURITY DEFINER function contract, then rerun this migration.';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_proc
    cross join lateral pg_catalog.aclexplode(coalesce(
      pg_proc.proacl,
      pg_catalog.acldefault('f', pg_proc.proowner)
    )) as function_acl
    where pg_proc.oid = save_function_oid
      and function_acl.grantee = 0
      and function_acl.privilege_type = 'EXECUTE'
  ) into public_execute;

  if public_execute then
    raise exception
      'Cloud Event backend-only save RPC must not be executable by PUBLIC'
      using errcode = '42501',
        hint = 'Remove PUBLIC EXECUTE, including unsafe function default ACLs, then rerun this migration.';
  end if;

  if has_function_privilege(
    authenticated_role_oid,
    save_function_oid,
    'EXECUTE'
  ) or has_function_privilege(
    anon_role_oid,
    save_function_oid,
    'EXECUTE'
  ) then
    raise exception
      'Cloud Event backend-only save RPC must not be executable by browser roles'
      using errcode = '42501',
        hint = 'Remove inherited EXECUTE grants or custom-role memberships for authenticated/anon, inspect default ACLs, then rerun this migration.';
  end if;

  if not has_function_privilege(
    service_role_oid,
    save_function_oid,
    'EXECUTE'
  ) then
    raise exception
      'Cloud Event backend-only save RPC requires effective service_role EXECUTE'
      using errcode = '42501',
        hint = 'Restore service_role EXECUTE after checking role membership and function ACLs, then rerun this migration.';
  end if;
end
$cloud_event_save_execute_privilege_guard$;

comment on function public.save_cloud_event_validated(uuid, uuid, jsonb) is
  'Backend-only upsert for a snapshot already validated by save-cloud-event. Rechecks and locks actor Workspace membership in the save transaction.';
