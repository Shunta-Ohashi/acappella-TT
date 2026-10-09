-- Cloud Event deletion must pass through delete_cloud_event_authorized(),
-- which locks and re-checks the caller's Workspace membership. This migration
-- is intentionally additive so databases that already applied the original
-- table grant are corrected during upgrade as well as on a fresh install.
revoke delete on table public.cloud_events from public;
revoke delete on table public.cloud_events from anon;
revoke delete on table public.cloud_events from authenticated;

-- REVOKE removes direct grants only. Fail closed if a browser role can still
-- DELETE through an inherited role; operators must remove that membership or
-- inherited grant explicitly rather than having this migration alter a shared
-- role as a side effect.
do $cloud_event_delete_privilege_guard$
begin
  if has_table_privilege('anon', 'public.cloud_events', 'DELETE') then
    raise exception
      'Cloud Event RPC-only delete requires anon to have no effective DELETE privilege'
      using errcode = '42501',
        hint = 'Remove inherited DELETE grants or role memberships for anon, then rerun this migration.';
  end if;

  if has_table_privilege('authenticated', 'public.cloud_events', 'DELETE') then
    raise exception
      'Cloud Event RPC-only delete requires authenticated to have no effective DELETE privilege'
      using errcode = '42501',
        hint = 'Remove inherited DELETE grants or role memberships for authenticated, then rerun this migration.';
  end if;
end
$cloud_event_delete_privilege_guard$;

