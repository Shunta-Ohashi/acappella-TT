-- Cloud Event deletion must pass through delete_cloud_event_authorized(),
-- which locks and re-checks the caller's Workspace membership. This migration
-- is intentionally additive so databases that already applied the original
-- table grant are corrected during upgrade as well as on a fresh install.
revoke delete on table public.cloud_events from public;
revoke delete on table public.cloud_events from anon;
revoke delete on table public.cloud_events from authenticated;

