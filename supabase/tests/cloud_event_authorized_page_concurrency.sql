\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This test commits transactions so a second connection can observe the
-- transaction-scoped membership lock. Run only against a disposable database.
-- ON_ERROR_STOP can leave the committed fixed-ID fixture behind. The startup
-- cleanup below intentionally targets only those test IDs, making a rerun safe
-- without resetting or deleting unrelated database data.
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
  'set application_name = ''cloud-event-page-generation-change'''
);

create temporary table page_generation_probe (
  generation text not null
) on commit preserve rows;
-- The admin session owns this temporary table, while the page RPC probes run
-- under SET LOCAL ROLE authenticated. Grant only the INSERT/SELECT operations
-- those blocks use; TRUNCATE and lifecycle control remain with the owner.
grant select, insert on table page_generation_probe to authenticated;

-- The page transaction holds a shared generation-row lock after it has read
-- both the generation and page rows. A concurrent Cloud Event mutation cannot
-- commit until that page transaction ends, so there is no version/read gap.
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
    '30000000-0000-0000-0000-000000000001', null, 1, null
  );
  insert into page_generation_probe (generation)
  values (result ->> 'workspace_generation');
end
$$;
reset role;

do $send_generation_update$
begin
  if extensions.dblink_send_query(
    'page_membership_change',
    $remote$
      update public.cloud_events
        set event_name = 'Page Race Event Updated',
            event_snapshot = jsonb_set(
              event_snapshot,
              '{appState,events,0,name}',
              to_jsonb('Page Race Event Updated'::text)
            )
        where workspace_id = '30000000-0000-0000-0000-000000000001'
          and event_id = 'page-race-event'
    $remote$
  ) <> 1 then
    raise exception 'could not send asynchronous Cloud Event UPDATE';
  end if;
end
$send_generation_update$;
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1
      from pg_stat_activity
      where application_name = 'cloud-event-page-generation-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'Cloud Event UPDATE did not wait for page generation lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('page_membership_change') as result(status text);
do $drain_generation_update$
declare
  remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('page_membership_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'Cloud Event UPDATE returned an unexpected trailing result';
  end if;
end
$drain_generation_update$;

begin;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
do $$
declare
  stale_generation text := (select generation from page_generation_probe limit 1);
begin
  begin
    perform public.load_cloud_events_page_authorized(
      '30000000-0000-0000-0000-000000000001',
      null,
      1,
      stale_generation
    );
    raise exception 'stale Workspace generation unexpectedly succeeded';
  exception when sqlstate '40001' then
    null;
  end;
end
$$;
rollback;

truncate page_generation_probe;
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
    '30000000-0000-0000-0000-000000000001', null, 1, null
  );
  insert into page_generation_probe (generation)
  values (result ->> 'workspace_generation');
end
$$;
reset role;
do $send_generation_insert$
begin
  if extensions.dblink_send_query(
    'page_membership_change',
    $remote$
      insert into public.cloud_events (
        workspace_id, event_id, event_name, event_snapshot
      )
      select
        workspace_id,
        'page-race-insert',
        'Page Race Insert',
        jsonb_set(
          jsonb_set(
            event_snapshot,
            '{appState,events,0,id}',
            to_jsonb('page-race-insert'::text)
          ),
          '{appState,events,0,name}',
          to_jsonb('Page Race Insert'::text)
        )
      from public.cloud_events
      where workspace_id = '30000000-0000-0000-0000-000000000001'
        and event_id = 'page-race-event'
    $remote$
  ) <> 1 then
    raise exception 'could not send asynchronous Cloud Event INSERT';
  end if;
end
$send_generation_insert$;
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1 from pg_stat_activity
      where application_name = 'cloud-event-page-generation-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'Cloud Event INSERT did not wait for page generation lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('page_membership_change') as result(status text);
do $drain_generation_insert$
declare
  remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('page_membership_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'Cloud Event INSERT returned an unexpected trailing result';
  end if;
end
$drain_generation_insert$;
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
      '30000000-0000-0000-0000-000000000001', null, 1,
      (select generation from page_generation_probe limit 1)
    );
    raise exception 'stale generation after INSERT unexpectedly succeeded';
  exception when sqlstate '40001' then
    null;
  end;
end
$$;
rollback;

truncate page_generation_probe;
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
    '30000000-0000-0000-0000-000000000001', null, 1, null
  );
  insert into page_generation_probe (generation)
  values (result ->> 'workspace_generation');
end
$$;
reset role;
do $send_generation_delete$
begin
  if extensions.dblink_send_query(
    'page_membership_change',
    $remote$
      delete from public.cloud_events
      where workspace_id = '30000000-0000-0000-0000-000000000001'
        and event_id = 'page-race-insert'
    $remote$
  ) <> 1 then
    raise exception 'could not send asynchronous Cloud Event DELETE';
  end if;
end
$send_generation_delete$;
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1 from pg_stat_activity
      where application_name = 'cloud-event-page-generation-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'Cloud Event DELETE did not wait for page generation lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('page_membership_change') as result(status text);
do $drain_generation_delete$
declare
  remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('page_membership_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'Cloud Event DELETE returned an unexpected trailing result';
  end if;
end
$drain_generation_delete$;
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
      '30000000-0000-0000-0000-000000000001', null, 1,
      (select generation from page_generation_probe limit 1)
    );
    raise exception 'stale generation after DELETE unexpectedly succeeded';
  exception when sqlstate '40001' then
    null;
  end;
end
$$;
rollback;

truncate page_generation_probe;
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
    '30000000-0000-0000-0000-000000000001', null, 1, null
  );
  insert into page_generation_probe (generation)
  values (result ->> 'workspace_generation');
end
$$;
reset role;
do $send_master_generation_insert$
begin
  if extensions.dblink_send_query(
    'page_membership_change',
    $remote$
      insert into public.workspace_master_members (
        workspace_id, member_id, real_name, active
      ) values (
        '30000000-0000-0000-0000-000000000001',
        'page-race-master-member',
        'Page Race Master Member',
        true
      )
    $remote$
  ) <> 1 then
    raise exception 'could not send asynchronous Workspace master INSERT';
  end if;
end
$send_master_generation_insert$;
do $$
declare
  attempt integer;
  lock_wait_observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1 from pg_stat_activity
      where application_name = 'cloud-event-page-generation-change'
        and wait_event_type = 'Lock'
    ) into lock_wait_observed;
    exit when lock_wait_observed;
    perform pg_sleep(0.01);
  end loop;
  if not lock_wait_observed then
    raise exception 'Workspace master INSERT did not wait for page generation lock';
  end if;
end
$$;
commit;
select * from extensions.dblink_get_result('page_membership_change') as result(status text);
do $drain_master_generation_insert$
declare
  remaining_result_count bigint;
begin
  select count(*) into remaining_result_count
  from extensions.dblink_get_result('page_membership_change') as result(status text);
  if remaining_result_count <> 0 then
    raise exception 'Workspace master INSERT returned an unexpected trailing result';
  end if;
end
$drain_master_generation_insert$;
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
      '30000000-0000-0000-0000-000000000001', null, 1,
      (select generation from page_generation_probe limit 1)
    );
    raise exception 'stale generation after Workspace master INSERT unexpectedly succeeded';
  exception when sqlstate '40001' then
    null;
  end;
end
$$;
rollback;

truncate page_generation_probe;
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
    '30000000-0000-0000-0000-000000000001', null, 100, null
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
      '30000000-0000-0000-0000-000000000001', null, 100, null
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
