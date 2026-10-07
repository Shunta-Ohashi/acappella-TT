\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This test deliberately commits transactions so a second connection can
-- observe lock ordering. Run only against a disposable database.
create extension if not exists dblink with schema extensions;

delete from public.workspaces
  where id = '20000000-0000-0000-0000-000000000001';
delete from auth.users
  where id = '00000000-0000-0000-0000-000000000011';

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000011',
  'authenticated',
  'authenticated',
  'cloud-delete-race@example.invalid',
  '',
  now(),
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);
insert into public.workspaces (id, name) values
  ('20000000-0000-0000-0000-000000000001', 'Cloud delete concurrency');
insert into public.workspace_members (workspace_id, user_id, role) values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000011',
  'editor'
);
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '20000000-0000-0000-0000-000000000001',
  'race-event',
  'Race Event',
  jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'race-event',
        'name', 'Race Event'
      ))
    )
  )
);

select extensions.dblink_connect('membership_change', :'test_db_url');
select extensions.dblink_exec(
  'membership_change',
  'set application_name = ''cloud-event-membership-change'''
);

-- RPC first: FOR SHARE remains held through the RPC transaction. A concurrent
-- role UPDATE must wait until COMMIT, then it may complete.
begin;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000011',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.delete_cloud_event_authorized(
    '20000000-0000-0000-0000-000000000001',
    'race-event'
  );
  if result ->> 'status' <> 'deleted' then
    raise exception 'RPC-first delete failed: %', result;
  end if;
end
$$;
reset role;

select extensions.dblink_send_query(
  'membership_change',
  $remote$
    update public.workspace_members
      set role = 'viewer'
      where workspace_id = '20000000-0000-0000-0000-000000000001'
        and user_id = '00000000-0000-0000-0000-000000000011'
  $remote$
);
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1
      from pg_stat_activity
      where application_name = 'cloud-event-membership-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'membership role UPDATE did not wait for RPC FOR SHARE lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('membership_change') as result(status text);

do $$
begin
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = '20000000-0000-0000-0000-000000000001'
      and user_id = '00000000-0000-0000-0000-000000000011'
      and role = 'viewer'
  ) then
    raise exception 'waiting membership downgrade did not complete after RPC commit';
  end if;
end
$$;

-- RPC first also blocks Membership DELETE until the RPC transaction ends.
update public.workspace_members
  set role = 'editor'
  where workspace_id = '20000000-0000-0000-0000-000000000001'
    and user_id = '00000000-0000-0000-0000-000000000011';
begin;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000011',
  true
);
select public.delete_cloud_event_authorized(
  '20000000-0000-0000-0000-000000000001',
  'already-absent-race-event'
);
reset role;
select extensions.dblink_send_query(
  'membership_change',
  $remote$
    delete from public.workspace_members
      where workspace_id = '20000000-0000-0000-0000-000000000001'
        and user_id = '00000000-0000-0000-0000-000000000011'
  $remote$
);
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1
      from pg_stat_activity
      where application_name = 'cloud-event-membership-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'membership DELETE did not wait for RPC FOR SHARE lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('membership_change') as result(status text);

-- Revocation first: once the downgrade commits, the subsequent RPC must deny.
insert into public.workspace_members (workspace_id, user_id, role) values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000011',
  'editor'
);
select extensions.dblink_exec(
  'membership_change',
  $remote$
    update public.workspace_members
      set role = 'viewer'
      where workspace_id = '20000000-0000-0000-0000-000000000001'
        and user_id = '00000000-0000-0000-0000-000000000011'
  $remote$
);
begin;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000011',
  true
);
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '20000000-0000-0000-0000-000000000001',
      'already-absent-after-downgrade'
    );
    raise exception 'RPC succeeded after committed downgrade';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
rollback;

select extensions.dblink_disconnect('membership_change');
delete from public.workspaces
  where id = '20000000-0000-0000-0000-000000000001';
delete from auth.users
  where id = '00000000-0000-0000-0000-000000000011';
