\set ON_ERROR_STOP on

-- Delete only the fixed Workspace IDs reserved by the V2 HTTP smoke fixture.
begin;

delete from public.workspaces
where id in (
  '76000000-0000-0000-0000-000000000001',
  '76000000-0000-0000-0000-000000000002',
  '76000000-0000-0000-0000-000000000003'
);

do $$
declare
  fixture_workspace_ids uuid[] := array[
    '76000000-0000-0000-0000-000000000001'::uuid,
    '76000000-0000-0000-0000-000000000002'::uuid,
    '76000000-0000-0000-0000-000000000003'::uuid
  ];
begin
  if exists (
    select 1 from public.workspaces
    where id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.workspace_members
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.cloud_events
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.workspace_master_members
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.workspace_master_bands
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.workspace_master_band_members
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.cloud_event_member_references
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.cloud_event_band_references
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id = any(fixture_workspace_ids)
  ) or exists (
    select 1 from public.cloud_event_workspace_generations
    where workspace_id = any(fixture_workspace_ids)
  ) then
    raise exception 'Cloud Event V2 HTTP smoke cleanup left fixture rows';
  end if;
end;
$$;

commit;
