\set ON_ERROR_STOP on

-- Dedicated local HTTP/Realtime smoke fixture. The runner supplies fresh UUIDs
-- and refuses every target except its isolated loopback Supabase environment.
begin;

select set_config('test.live_http_workspace_id', :'workspace_id', false);
select set_config('test.live_http_owner_id', :'owner_id', false);
select set_config('test.live_http_editor_id', :'editor_id', false);
select set_config('test.live_http_viewer_id', :'viewer_id', false);
select set_config('test.live_http_outsider_id', :'outsider_id', false);

do $fixture_guard$
declare
  fixture_workspace_id uuid := current_setting(
    'test.live_http_workspace_id'
  )::uuid;
begin
  if exists (
    select 1 from public.workspaces where id = fixture_workspace_id
  ) or exists (
    select 1 from public.workspace_members
    where workspace_id = fixture_workspace_id
  ) or (
    select count(*) from auth.users
    where id in (
      current_setting('test.live_http_owner_id')::uuid,
      current_setting('test.live_http_editor_id')::uuid,
      current_setting('test.live_http_viewer_id')::uuid,
      current_setting('test.live_http_outsider_id')::uuid
    )
  ) <> 4 then
    raise exception 'Live HTTP fixture precondition failed'
      using errcode = '55000';
  end if;
end
$fixture_guard$;

insert into public.workspaces (id, name)
values (:'workspace_id'::uuid, :'workspace_name');

insert into public.workspace_members (workspace_id, user_id, role) values
  (:'workspace_id'::uuid, :'owner_id'::uuid, 'owner'),
  (:'workspace_id'::uuid, :'editor_id'::uuid, 'editor'),
  (:'workspace_id'::uuid, :'viewer_id'::uuid, 'viewer');

commit;

