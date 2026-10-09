\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This test commits transactions so a second connection can observe the
-- transaction-scoped membership lock. Run only against a disposable database.
create extension if not exists dblink with schema extensions;

delete from public.workspaces
  where id = '30000000-0000-0000-0000-000000000001';
delete from auth.users
  where id = '00000000-0000-0000-0000-000000000021';

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000021',
  'authenticated',
  'authenticated',
  'cloud-page-race@example.invalid',
  '',
  now(),
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);
insert into public.workspaces (id, name) values
  ('30000000-0000-0000-0000-000000000001', 'Cloud page concurrency');
insert into public.workspace_members (workspace_id, user_id, role) values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000021',
  'viewer'
);
-- Database-only lock fixture: this exercises page authorization/locking, not
-- the application snapshot parser. See the core SQL script for the complete
-- app-loadable snapshot fixture.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '30000000-0000-0000-0000-000000000001',
  'page-race-event',
  'Page Race Event',
  jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'page-race-event',
        'name', 'Page Race Event'
      ))
    )
  )
);

select extensions.dblink_connect('page_membership_change', :'test_db_url');
select extensions.dblink_exec(
  'page_membership_change',
  'set application_name = ''cloud-event-page-membership-change'''
);

-- Page read first: FOR SHARE is held until this transaction commits, so a
-- concurrent membership revocation must wait.
begin;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.load_cloud_events_page_authorized(
    '30000000-0000-0000-0000-000000000001', null, 100
  );
  if result ->> 'status' <> 'ok'
    or jsonb_array_length(result -> 'rows') <> 1 then
    raise exception 'page-first read failed: %', result;
  end if;
end
$$;
reset role;

do $send$
begin
  if extensions.dblink_send_query(
    'page_membership_change',
    $remote$
      delete from public.workspace_members
        where workspace_id = '30000000-0000-0000-0000-000000000001'
          and user_id = '00000000-0000-0000-0000-000000000021'
    $remote$
  ) <> 1 then
    raise exception 'could not send asynchronous page membership DELETE';
  end if;
end
$send$;
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1
      from pg_stat_activity
      where application_name = 'cloud-event-page-membership-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'membership revocation did not wait for page RPC FOR SHARE lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('page_membership_change') as result(status text);
do $drain$
declare
  remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('page_membership_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'page membership DELETE returned an unexpected trailing result';
  end if;
end
$drain$;

do $$
begin
  if exists (
    select 1 from public.workspace_members
    where workspace_id = '30000000-0000-0000-0000-000000000001'
      and user_id = '00000000-0000-0000-0000-000000000021'
  ) then
    raise exception 'waiting membership revocation did not finish after page commit';
  end if;
end
$$;

-- Revocation first: a later page request must fail instead of returning an
-- apparently valid empty envelope.
begin;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
do $$
begin
  begin
    perform public.load_cloud_events_page_authorized(
      '30000000-0000-0000-0000-000000000001', null, 100
    );
    raise exception 'page RPC succeeded after committed membership revocation';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
rollback;

select extensions.dblink_disconnect('page_membership_change');
delete from public.workspaces
  where id = '30000000-0000-0000-0000-000000000001';
delete from auth.users
  where id = '00000000-0000-0000-0000-000000000021';
