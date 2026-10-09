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
