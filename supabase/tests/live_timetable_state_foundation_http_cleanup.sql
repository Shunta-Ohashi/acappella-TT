\set ON_ERROR_STOP on

-- Refuse broad cleanup. Only the runner's fresh Workspace, one source Event,
-- one Live projection, and the three expected memberships are permitted.
begin;

select set_config('test.live_http_workspace_id', :'workspace_id', false);
select set_config('test.live_http_workspace_name', :'workspace_name', false);
select set_config('test.live_http_event_id', :'event_id', false);
select set_config('test.live_http_owner_id', :'owner_id', false);
select set_config('test.live_http_editor_id', :'editor_id', false);
select set_config('test.live_http_viewer_id', :'viewer_id', false);

-- Lock the parent first so no new FK child can be inserted, then lock every
-- existing row that the guard inspects or the Workspace delete can cascade.
-- The Event-before-Live order matches the projection writer's lock order.
select id from public.workspaces
where id = :'workspace_id'::uuid
for update;
select user_id from public.workspace_members
where workspace_id = :'workspace_id'::uuid
order by user_id
for update;
select event_id from public.cloud_events
where workspace_id = :'workspace_id'::uuid
order by event_id
for update;
select workspace_id from public.cloud_event_workspace_generations
where workspace_id = :'workspace_id'::uuid
for update;
select workspace_id from public.cloud_workspace_master_states
where workspace_id = :'workspace_id'::uuid
for update;
select member_id from public.workspace_master_members
where workspace_id = :'workspace_id'::uuid
order by member_id
for update;
select band_id from public.workspace_master_bands
where workspace_id = :'workspace_id'::uuid
order by band_id
for update;
select band_id, member_id from public.workspace_master_band_members
where workspace_id = :'workspace_id'::uuid
order by band_id, member_id
for update;
select event_id, member_id from public.cloud_event_member_references
where workspace_id = :'workspace_id'::uuid
order by event_id, member_id
for update;
select event_id, band_id from public.cloud_event_band_references
where workspace_id = :'workspace_id'::uuid
order by event_id, band_id
for update;
select workspace_id from public.cloud_workspace_master_backfills
where workspace_id = :'workspace_id'::uuid
for update;
select id from public.live_timetables
where workspace_id = :'workspace_id'::uuid
order by id
for update;
select id from public.live_timetable_stages
where workspace_id = :'workspace_id'::uuid
order by id
for update;
select id from public.live_timetable_entries
where workspace_id = :'workspace_id'::uuid
order by id
for update;
select stage_id, user_id from public.live_timetable_stage_operators
where workspace_id = :'workspace_id'::uuid
order by stage_id, user_id
for update;

do $cleanup_guard$
declare
  fixture_workspace_id uuid := current_setting(
    'test.live_http_workspace_id'
  )::uuid;
  fixture_workspace_name text := current_setting(
    'test.live_http_workspace_name'
  );
  fixture_event_id text := current_setting('test.live_http_event_id');
begin
  if (select count(*) from public.workspaces
      where id = fixture_workspace_id
        and name = fixture_workspace_name) <> 1
    or (select count(*) from public.workspaces
      where id = fixture_workspace_id) <> 1
    or (select count(*) from public.workspace_members
      where workspace_id = fixture_workspace_id
        and (
          (user_id = current_setting('test.live_http_owner_id')::uuid
            and role = 'owner')
          or (user_id = current_setting('test.live_http_editor_id')::uuid
            and role = 'editor')
          or (user_id = current_setting('test.live_http_viewer_id')::uuid
            and role = 'viewer')
        )) <> 3
    or (select count(*) from public.workspace_members
      where workspace_id = fixture_workspace_id) <> 3
    or (select count(*) from public.cloud_events
      where workspace_id = fixture_workspace_id
        and event_id = fixture_event_id) > 1
    or (select count(*) from public.cloud_events
      where workspace_id = fixture_workspace_id) > 1
    or exists (select 1 from public.cloud_events
      where workspace_id = fixture_workspace_id
        and event_id is distinct from fixture_event_id)
    or (select count(*) from public.live_timetables
      where workspace_id = fixture_workspace_id
        and event_id = fixture_event_id) > 1
    or (select count(*) from public.live_timetables
      where workspace_id = fixture_workspace_id) > 1
    or exists (select 1 from public.live_timetables
      where workspace_id = fixture_workspace_id
        and event_id is distinct from fixture_event_id)
    or exists (select 1 from public.workspace_master_members
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.workspace_master_bands
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.workspace_master_band_members
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_event_member_references
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_event_band_references
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_workspace_master_backfills
      where workspace_id = fixture_workspace_id) then
    raise exception 'Live HTTP cleanup target differs from its dedicated fixture'
      using errcode = '55000';
  end if;
end
$cleanup_guard$;

delete from public.live_timetables
where workspace_id = :'workspace_id'::uuid
  and event_id = :'event_id';

delete from public.cloud_events
where workspace_id = :'workspace_id'::uuid
  and event_id = :'event_id';

delete from public.workspaces
where id = :'workspace_id'::uuid
  and name = :'workspace_name';

commit;

do $final_guard$
declare
  fixture_workspace_id uuid := current_setting(
    'test.live_http_workspace_id'
  )::uuid;
begin
  if exists (select 1 from public.workspaces
      where id = fixture_workspace_id)
    or exists (select 1 from public.workspace_members
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_events
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_event_workspace_generations
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_workspace_master_states
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.workspace_master_members
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.workspace_master_bands
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.workspace_master_band_members
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_event_member_references
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_event_band_references
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.cloud_workspace_master_backfills
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.live_timetables
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.live_timetable_stages
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.live_timetable_entries
      where workspace_id = fixture_workspace_id)
    or exists (select 1 from public.live_timetable_stage_operators
      where workspace_id = fixture_workspace_id) then
    raise exception 'Live HTTP fixture cleanup is incomplete'
      using errcode = '55000';
  end if;
end
$final_guard$;

