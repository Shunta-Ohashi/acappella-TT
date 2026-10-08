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
