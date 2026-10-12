\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This test commits remote transactions. Startup/final cleanup touches only
-- the fixed IDs below so an interrupted disposable run is safely repeatable.
create extension if not exists dblink with schema extensions;

delete from public.workspaces
where id = '72000000-0000-0000-0000-000000000001'::uuid;
delete from auth.users where id in (
  '00000000-0000-0000-0000-000000000075'::uuid,
  '00000000-0000-0000-0000-000000000076'::uuid
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000075', 'authenticated', 'authenticated',
   'master-cas-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000076', 'authenticated', 'authenticated',
   'master-cas-editor@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.workspaces (id, name) values
  ('72000000-0000-0000-0000-000000000001', 'Master CAS concurrency');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('72000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000075', 'owner'),
  ('72000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000076', 'editor');
update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '72000000-0000-0000-0000-000000000001';

select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000075',
  '72000000-0000-0000-0000-000000000001',
  'create', 'member',
  '{"id":"member-a","realName":"A","active":true}'::jsonb, null
);
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000075',
  '72000000-0000-0000-0000-000000000001',
  'create', 'member',
  '{"id":"member-b","realName":"B","active":true}'::jsonb, null
);

select extensions.dblink_connect('master_cas_a', :'test_db_url');
select extensions.dblink_connect('master_cas_b', :'test_db_url');
select extensions.dblink_exec('master_cas_a',
  'set application_name = ''workspace-master-cas-a'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms''');
select extensions.dblink_exec('master_cas_b',
  'set application_name = ''workspace-master-cas-b'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms''');

create or replace function pg_temp.assert_master_wait(
  expected_application_name text,
  failure_message text
)
returns void
language plpgsql
as $$
declare
  attempt integer;
  observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1 from pg_catalog.pg_stat_activity
      where application_name = expected_application_name
        and wait_event_type = 'Lock'
    ) into observed;
    exit when observed;
    perform pg_sleep(0.01);
  end loop;
  if not observed then raise exception '%', failure_message; end if;
end;
$$;

-- The first writer owns the row. The second writer uses the same revision,
-- waits, then observes the committed revision and fails with 40001.
select extensions.dblink_exec('master_cas_a', $remote$
  begin;
  do $update$
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000075',
      '72000000-0000-0000-0000-000000000001',
      'update', 'member',
      '{"id":"member-a","realName":"A first","active":true}'::jsonb, 1
    );
  end;
  $update$;
$remote$);
do $send_stale_update$
begin
  if extensions.dblink_send_query('master_cas_b', $remote$
    do $stale$
    begin
      begin
        perform public.mutate_workspace_master_validated(
          '00000000-0000-0000-0000-000000000076',
          '72000000-0000-0000-0000-000000000001',
          'update', 'member',
          '{"id":"member-a","realName":"A stale","active":true}'::jsonb, 1
        );
        raise exception 'stale same-Master update succeeded';
      exception when sqlstate '40001' then null;
      end;
    end;
    $stale$;
  $remote$) <> 1 then
    raise exception 'could not send stale same-Master update';
  end if;
end;
$send_stale_update$;
select pg_temp.assert_master_wait(
  'workspace-master-cas-b',
  'same-Master CAS writer did not wait for the target row'
);
select extensions.dblink_exec('master_cas_a', 'commit');
select * from extensions.dblink_get_result('master_cas_b') as result(status text);
do $drain_stale_update$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('master_cas_b') as result(status text);
  if remaining_results <> 0 then
    raise exception 'same-Master CAS left a trailing async result';
  end if;
end;
$drain_stale_update$;

-- Different Master IDs have independent CAS rows. They may serialize briefly
-- on the shared generation counter, but both valid revisions must commit.
select extensions.dblink_exec('master_cas_a', $remote$
  begin;
  do $update$
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000075',
      '72000000-0000-0000-0000-000000000001',
      'update', 'member',
      '{"id":"member-a","realName":"A second","active":true}'::jsonb, 2
    );
  end;
  $update$;
$remote$);
do $send_independent_update$
begin
  if extensions.dblink_send_query('master_cas_b', $remote$
    do $update$
    begin
      perform public.mutate_workspace_master_validated(
        '00000000-0000-0000-0000-000000000076',
        '72000000-0000-0000-0000-000000000001',
        'update', 'member',
        '{"id":"member-b","realName":"B second","active":true}'::jsonb, 1
      );
    end;
    $update$;
  $remote$) <> 1 then
    raise exception 'could not send different-Master update';
  end if;
end;
$send_independent_update$;
select pg_temp.assert_master_wait(
  'workspace-master-cas-b',
  'different-Master update did not serialize on Workspace generation'
);
select extensions.dblink_exec('master_cas_a', 'commit');
select * from extensions.dblink_get_result('master_cas_b') as result(status text);
do $drain_independent_update$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('master_cas_b') as result(status text);
  if remaining_results <> 0 then
    raise exception 'different-Master update left a trailing async result';
  end if;
end;
$drain_independent_update$;

do $$
begin
  if not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '72000000-0000-0000-0000-000000000001'
      and member_id = 'member-a' and real_name = 'A second' and revision = 3
  ) or not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '72000000-0000-0000-0000-000000000001'
      and member_id = 'member-b' and real_name = 'B second' and revision = 2
  ) then
    raise exception 'CAS concurrency results are invalid';
  end if;
end;
$$;

select extensions.dblink_disconnect('master_cas_a');
select extensions.dblink_disconnect('master_cas_b');

delete from public.workspaces
where id = '72000000-0000-0000-0000-000000000001'::uuid;
delete from auth.users where id in (
  '00000000-0000-0000-0000-000000000075'::uuid,
  '00000000-0000-0000-0000-000000000076'::uuid
);
