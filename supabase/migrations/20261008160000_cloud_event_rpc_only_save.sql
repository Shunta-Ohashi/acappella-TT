-- Apply only after save-cloud-event is deployed and the frontend is ready to
-- use it. Existing browser clients lose direct INSERT/UPDATE after this step.

revoke insert, update on table public.cloud_events from public;
revoke insert, update on table public.cloud_events from anon;
revoke insert, update on table public.cloud_events from authenticated;

-- Also remove any independently granted column privileges in upgraded
-- environments; table-level REVOKE alone does not clear column grants.
revoke insert (
  workspace_id, event_id, event_name, event_snapshot,
  revision, created_at, updated_at
) on public.cloud_events from public;
revoke insert (
  workspace_id, event_id, event_name, event_snapshot,
  revision, created_at, updated_at
) on public.cloud_events from anon;
revoke insert (
  workspace_id, event_id, event_name, event_snapshot,
  revision, created_at, updated_at
) on public.cloud_events from authenticated;
revoke update (
  workspace_id, event_id, event_name, event_snapshot,
  revision, created_at, updated_at
) on public.cloud_events from public;
revoke update (
  workspace_id, event_id, event_name, event_snapshot,
  revision, created_at, updated_at
) on public.cloud_events from anon;
revoke update (
  workspace_id, event_id, event_name, event_snapshot,
  revision, created_at, updated_at
) on public.cloud_events from authenticated;

-- REVOKE removes direct grants only. Fail closed if browser roles retain
-- effective table- or column-level writes through inherited roles. Operators
-- must repair those memberships or grants explicitly; this migration does not
-- mutate potentially shared custom roles.
do $cloud_event_write_privilege_guard$
begin
  if has_table_privilege('anon', 'public.cloud_events', 'INSERT')
    or has_table_privilege('anon', 'public.cloud_events', 'UPDATE') then
    raise exception
      'Cloud Event RPC-only save requires anon to have no effective table write privilege'
      using errcode = '42501',
        hint = 'Remove inherited INSERT/UPDATE grants or role memberships for anon, then rerun this migration.';
  end if;

  if has_any_column_privilege(
    'anon',
    'public.cloud_events',
    'INSERT,UPDATE'
  ) then
    raise exception
      'Cloud Event RPC-only save requires anon to have no effective column write privilege'
      using errcode = '42501',
        hint = 'Remove inherited column INSERT/UPDATE grants or role memberships for anon, then rerun this migration.';
  end if;

  if has_table_privilege('authenticated', 'public.cloud_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.cloud_events', 'UPDATE') then
    raise exception
      'Cloud Event RPC-only save requires authenticated to have no effective table write privilege'
      using errcode = '42501',
        hint = 'Remove inherited INSERT/UPDATE grants or role memberships for authenticated, then rerun this migration.';
  end if;

  if has_any_column_privilege(
    'authenticated',
    'public.cloud_events',
    'INSERT,UPDATE'
  ) then
    raise exception
      'Cloud Event RPC-only save requires authenticated to have no effective column write privilege'
      using errcode = '42501',
        hint = 'Remove inherited column INSERT/UPDATE grants or role memberships for authenticated, then rerun this migration.';
  end if;
end
$cloud_event_write_privilege_guard$;

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
