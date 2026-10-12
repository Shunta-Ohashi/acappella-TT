\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This fixture commits transactions across multiple connections. Run it only
-- against a disposable database with all repository migrations freshly
-- applied. Startup and final cleanup target only these fixed test Workspaces.
create extension if not exists dblink with schema extensions;

delete from public.workspaces where id in (
  '71000000-0000-0000-0000-000000000001'::uuid,
  '71000000-0000-0000-0000-000000000002'::uuid
);

insert into public.workspaces (id, name) values
  ('71000000-0000-0000-0000-000000000001', 'Master lock concurrency'),
  ('71000000-0000-0000-0000-000000000002', 'Master cascade concurrency');

update public.cloud_workspace_master_states
set status = 'ready'
where workspace_id = '71000000-0000-0000-0000-000000000001';

insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values
  ('71000000-0000-0000-0000-000000000001', 'status-first-conflict', 'Status First Conflict', true),
  ('71000000-0000-0000-0000-000000000001', 'status-first-legacy', 'Status First Legacy', true),
  ('71000000-0000-0000-0000-000000000001', 'delete-first-conflict', 'Delete First Conflict', true),
  ('71000000-0000-0000-0000-000000000001', 'delete-first-legacy', 'Delete First Legacy', true);

select extensions.dblink_connect('master_state_change', :'test_db_url');
select extensions.dblink_connect('master_delete', :'test_db_url');
select extensions.dblink_exec(
  'master_state_change',
  'set application_name = ''workspace-master-state-change'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms'''
);
select extensions.dblink_exec(
  'master_delete',
  'set application_name = ''workspace-master-delete-change'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms'''
);

create or replace function pg_temp.assert_workspace_master_lock_wait(
  expected_application_name text,
  failure_message text
)
returns void
language plpgsql
as $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1 from pg_catalog.pg_stat_activity
      where application_name = expected_application_name
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception '%', failure_message;
  end if;
end;
$$;

-- When the status transition owns the row lock first, DELETE must wait, read
-- the committed non-ready status under READ COMMITTED, and fail closed.
select extensions.dblink_exec('master_state_change', $remote$
  begin;
  update public.cloud_workspace_master_states
  set status = 'conflict'
  where workspace_id = '71000000-0000-0000-0000-000000000001';
$remote$);
do $send_status_first_conflict_delete$
begin
  if extensions.dblink_send_query('master_delete', $remote$
    do $delete$
    begin
      begin
        delete from public.workspace_master_members
        where workspace_id = '71000000-0000-0000-0000-000000000001'
          and member_id = 'status-first-conflict';
        raise exception 'DELETE succeeded after conflict transition';
      exception when sqlstate '55000' then
        null;
      end;
    end;
    $delete$;
  $remote$) <> 1 then
    raise exception 'could not send conflict-first asynchronous DELETE';
  end if;
end
$send_status_first_conflict_delete$;
select pg_temp.assert_workspace_master_lock_wait(
  'workspace-master-delete-change',
  'Master DELETE did not wait for conflict status row lock'
);
select extensions.dblink_exec('master_state_change', 'commit');
select * from extensions.dblink_get_result('master_delete') as result(status text);
do $drain_status_first_conflict_delete$
declare remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('master_delete') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'conflict-first DELETE returned a trailing async result';
  end if;
end
$drain_status_first_conflict_delete$;

do $$
begin
  if not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and member_id = 'status-first-conflict'
  ) or not exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and status = 'conflict'
  ) then
    raise exception 'conflict-first DELETE did not fail closed';
  end if;
end;
$$;

update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '71000000-0000-0000-0000-000000000001';

select extensions.dblink_exec('master_state_change', $remote$
  begin;
  update public.cloud_workspace_master_states
  set status = 'legacy'
  where workspace_id = '71000000-0000-0000-0000-000000000001';
$remote$);
do $send_status_first_legacy_delete$
begin
  if extensions.dblink_send_query('master_delete', $remote$
    do $delete$
    begin
      begin
        delete from public.workspace_master_members
        where workspace_id = '71000000-0000-0000-0000-000000000001'
          and member_id = 'status-first-legacy';
        raise exception 'DELETE succeeded after legacy transition';
      exception when sqlstate '55000' then
        null;
      end;
    end;
    $delete$;
  $remote$) <> 1 then
    raise exception 'could not send legacy-first asynchronous DELETE';
  end if;
end
$send_status_first_legacy_delete$;
select pg_temp.assert_workspace_master_lock_wait(
  'workspace-master-delete-change',
  'Master DELETE did not wait for legacy status row lock'
);
select extensions.dblink_exec('master_state_change', 'commit');
select * from extensions.dblink_get_result('master_delete') as result(status text);
do $drain_status_first_legacy_delete$
declare remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('master_delete') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'legacy-first DELETE returned a trailing async result';
  end if;
end
$drain_status_first_legacy_delete$;

do $$
begin
  if not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and member_id = 'status-first-legacy'
  ) or not exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and status = 'legacy'
  ) then
    raise exception 'legacy-first DELETE did not fail closed';
  end if;
end;
$$;

-- When DELETE owns FOR SHARE first, the status UPDATE waits. The deletion is
-- valid at its serialization point; after its COMMIT the later status change
-- completes. Both mutations advance the same Workspace generation.
update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '71000000-0000-0000-0000-000000000001';
create temporary table master_concurrency_generation_probe (
  scenario text primary key,
  generation bigint not null
);
insert into master_concurrency_generation_probe
select 'delete-first-conflict', generation
from public.cloud_event_workspace_generations
where workspace_id = '71000000-0000-0000-0000-000000000001';

begin;
set local statement_timeout = '10s';
set local deadlock_timeout = '100ms';
delete from public.workspace_master_members
where workspace_id = '71000000-0000-0000-0000-000000000001'
  and member_id = 'delete-first-conflict';
do $send_delete_first_conflict$
begin
  if extensions.dblink_send_query('master_state_change', $remote$
    update public.cloud_workspace_master_states
    set status = 'conflict'
    where workspace_id = '71000000-0000-0000-0000-000000000001'
  $remote$) <> 1 then
    raise exception 'could not send delete-first conflict transition';
  end if;
end
$send_delete_first_conflict$;
select pg_temp.assert_workspace_master_lock_wait(
  'workspace-master-state-change',
  'Conflict transition did not wait for Master DELETE FOR SHARE lock'
);
commit;
select * from extensions.dblink_get_result('master_state_change') as result(status text);
do $drain_delete_first_conflict$
declare remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('master_state_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'delete-first conflict returned a trailing async result';
  end if;
end
$drain_delete_first_conflict$;

do $$
begin
  if exists (
    select 1 from public.workspace_master_members
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and member_id = 'delete-first-conflict'
  ) or not exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and status = 'conflict'
  ) or (select generation from public.cloud_event_workspace_generations
        where workspace_id = '71000000-0000-0000-0000-000000000001') <>
       (select generation + 2 from master_concurrency_generation_probe
        where scenario = 'delete-first-conflict') then
    raise exception 'delete-first conflict serialization is invalid';
  end if;
end;
$$;

update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '71000000-0000-0000-0000-000000000001';
insert into master_concurrency_generation_probe
select 'delete-first-legacy', generation
from public.cloud_event_workspace_generations
where workspace_id = '71000000-0000-0000-0000-000000000001';

begin;
set local statement_timeout = '10s';
set local deadlock_timeout = '100ms';
delete from public.workspace_master_members
where workspace_id = '71000000-0000-0000-0000-000000000001'
  and member_id = 'delete-first-legacy';
do $send_delete_first_legacy$
begin
  if extensions.dblink_send_query('master_state_change', $remote$
    update public.cloud_workspace_master_states
    set status = 'legacy'
    where workspace_id = '71000000-0000-0000-0000-000000000001'
  $remote$) <> 1 then
    raise exception 'could not send delete-first legacy transition';
  end if;
end
$send_delete_first_legacy$;
select pg_temp.assert_workspace_master_lock_wait(
  'workspace-master-state-change',
  'Legacy transition did not wait for Master DELETE FOR SHARE lock'
);
commit;
select * from extensions.dblink_get_result('master_state_change') as result(status text);
do $drain_delete_first_legacy$
declare remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('master_state_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'delete-first legacy returned a trailing async result';
  end if;
end
$drain_delete_first_legacy$;

do $$
begin
  if exists (
    select 1 from public.workspace_master_members
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and member_id = 'delete-first-legacy'
  ) or not exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and status = 'legacy'
  ) or (select generation from public.cloud_event_workspace_generations
        where workspace_id = '71000000-0000-0000-0000-000000000001') <>
       (select generation + 2 from master_concurrency_generation_probe
        where scenario = 'delete-first-legacy') then
    raise exception 'delete-first legacy serialization is invalid';
  end if;
end;
$$;

-- Parent Workspace cascading remains legal even while its state is legacy.
insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values (
  '71000000-0000-0000-0000-000000000002',
  'cascade-member',
  'Cascade Member',
  true
);
delete from public.workspaces
where id = '71000000-0000-0000-0000-000000000002';
do $$
begin
  if exists (
    select 1 from public.workspace_master_members
    where workspace_id = '71000000-0000-0000-0000-000000000002'
  ) then
    raise exception 'Parent Workspace cascade did not remove Master rows';
  end if;
end;
$$;

select extensions.dblink_disconnect('master_state_change');
select extensions.dblink_disconnect('master_delete');

delete from public.workspaces where id in (
  '71000000-0000-0000-0000-000000000001'::uuid,
  '71000000-0000-0000-0000-000000000002'::uuid
);
