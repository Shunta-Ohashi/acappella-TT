\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This fixture commits remote transactions. It refuses to overwrite a prior
-- interrupted run: inspect and explicitly clean the dedicated fixture before
-- retrying instead of silently deleting evidence from the failed run.
create extension if not exists dblink with schema extensions;

do $$
begin
  if exists (
    select 1 from public.workspaces
    where id = '79500000-0000-4000-8000-000000000001'::uuid
  ) then
    raise exception using
      errcode = '55000',
      message = 'Dedicated cutover inspection concurrency fixture already exists',
      hint = 'Inspect the dedicated Workspace and run the documented explicit cleanup before retrying.';
  end if;
end;
$$;

insert into public.workspaces (id, name) values
  ('79500000-0000-4000-8000-000000000001', 'Cutover inspection concurrency');

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '79500000-0000-4000-8000-000000000001',
  'event-a',
  'Before inspection race',
  jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'event-a',
        'name', 'Before inspection race',
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1, 'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5)
      )),
      'members', '[]'::jsonb,
      'bands', '[]'::jsonb,
      'eventDays', '[]'::jsonb,
      'stages', '[]'::jsonb,
      'sections', '[]'::jsonb,
      'eventMembers', '[]'::jsonb,
      'eventMemberDays', '[]'::jsonb,
      'eventBands', '[]'::jsonb,
      'scheduleItems', '[]'::jsonb,
      'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb,
      'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    )
  )
);

create temporary table cutover_inspection_probe (value jsonb not null);

select extensions.dblink_connect('cutover_inspection_reader', :'test_db_url');
select extensions.dblink_connect('cutover_inspection_writer', :'test_db_url');
select extensions.dblink_exec('cutover_inspection_reader',
  'set application_name = ''cloud-v2-cutover-inspection-reader'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s''');
select extensions.dblink_exec('cutover_inspection_writer',
  'set application_name = ''cloud-v2-cutover-inspection-writer'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s''');

create or replace function pg_temp.assert_cutover_inspection_lock_wait(
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
    perform pg_catalog.pg_stat_clear_snapshot();
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

-- Block the inspection late in its response assembly. It has already taken
-- status then generation FOR SHARE before this table is read.
begin;
lock table public.cloud_workspace_master_backfills in access exclusive mode;

do $$
begin
  if extensions.dblink_send_query(
    'cutover_inspection_reader',
    $remote$
      select public.inspect_cloud_v2_cutover_state(
        '79500000-0000-4000-8000-000000000001'
      )::text
    $remote$
  ) <> 1 then
    raise exception 'could not send cutover inspection query';
  end if;
end;
$$;

select pg_temp.assert_cutover_inspection_lock_wait(
  'cloud-v2-cutover-inspection-reader',
  'inspection did not reach its bounded evidence read'
);

do $$
begin
  if extensions.dblink_send_query(
    'cutover_inspection_writer',
    $remote$
      update public.cloud_events
      set event_name = 'After inspection race',
          event_snapshot = jsonb_set(
            event_snapshot,
            '{appState,events,0,name}',
            '"After inspection race"'::jsonb
          )
      where workspace_id = '79500000-0000-4000-8000-000000000001'
        and event_id = 'event-a'
    $remote$
  ) <> 1 then
    raise exception 'could not send concurrent Event update';
  end if;
end;
$$;

select pg_temp.assert_cutover_inspection_lock_wait(
  'cloud-v2-cutover-inspection-writer',
  'Event writer did not wait for inspection generation FOR SHARE'
);

commit;

insert into cutover_inspection_probe (value)
select status::jsonb
from extensions.dblink_get_result('cutover_inspection_reader') as result(status text);
do $$
declare
  remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('cutover_inspection_reader') as result(status text);
  if remaining_results <> 0 then
    raise exception 'inspection connection retained an async result';
  end if;
end;
$$;

select *
from extensions.dblink_get_result('cutover_inspection_writer') as result(status text);
do $$
declare
  remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('cutover_inspection_writer') as result(status text);
  if remaining_results <> 0 then
    raise exception 'writer connection retained an async result';
  end if;
end;
$$;

do $$
declare
  inspected jsonb;
  current_generation bigint;
begin
  select value into inspected from cutover_inspection_probe;
  select generation into current_generation
  from public.cloud_event_workspace_generations
  where workspace_id = '79500000-0000-4000-8000-000000000001';

  if inspected -> 'events' -> 0 ->> 'eventName'
      is distinct from 'Before inspection race'
    or inspected -> 'events' -> 0 -> 'snapshot' -> 'appState' -> 'events' -> 0 ->> 'name'
      is distinct from 'Before inspection race'
    or (inspected ->> 'workspaceGeneration')::bigint >= current_generation
    or (select event_name from public.cloud_events
      where workspace_id = '79500000-0000-4000-8000-000000000001'
        and event_id = 'event-a') is distinct from 'After inspection race' then
    raise exception 'inspection mixed the pre-write generation with post-write data';
  end if;
end;
$$;

select extensions.dblink_disconnect('cutover_inspection_reader');
select extensions.dblink_disconnect('cutover_inspection_writer');

delete from public.workspaces
where id = '79500000-0000-4000-8000-000000000001'::uuid;

do $$
begin
  if exists (
      select 1 from public.workspaces
      where id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.workspace_members
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.cloud_events
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.workspace_master_members
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.workspace_master_bands
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.workspace_master_band_members
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.cloud_event_member_references
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.cloud_event_band_references
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.cloud_workspace_master_backfills
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.cloud_workspace_master_states
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) or exists (
      select 1 from public.cloud_event_workspace_generations
      where workspace_id = '79500000-0000-4000-8000-000000000001'::uuid
    ) then
    raise exception 'Dedicated cutover inspection concurrency fixture cleanup was incomplete';
  end if;
end;
$$;
