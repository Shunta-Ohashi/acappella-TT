\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This fixture commits remote transactions. Startup/final cleanup is limited
-- to this fixed Workspace ID so an interrupted disposable run is repeatable.
create extension if not exists dblink with schema extensions;

delete from public.workspaces
where id = '73000000-0000-0000-0000-000000000001'::uuid;

insert into public.workspaces (id, name) values
  ('73000000-0000-0000-0000-000000000001', 'Master backfill concurrency');

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '73000000-0000-0000-0000-000000000001',
  'event-a',
  'Before race',
  jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'event-a',
        'name', 'Before race',
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

create temporary table backfill_race_plan (
  source_generation bigint not null,
  plan jsonb not null
);

insert into backfill_race_plan (source_generation, plan)
select generation, jsonb_build_object(
  'version', 1,
  'workspaceId', '73000000-0000-0000-0000-000000000001',
  'sourceGeneration', generation::text,
  'sourceEvents', jsonb_build_array(jsonb_build_object(
    'eventId', cloud_events.event_id,
    'revision', cloud_events.revision,
    'snapshotFingerprint', pg_catalog.encode(
      extensions.digest(cloud_events.event_snapshot::text, 'sha256'), 'hex'
    )
  )),
  'members', '[]'::jsonb,
  'bands', '[]'::jsonb,
  'bandMembers', '[]'::jsonb,
  'eventMemberReferences', '[]'::jsonb,
  'eventBandReferences', '[]'::jsonb
)
from public.cloud_event_workspace_generations
join public.cloud_events using (workspace_id)
where workspace_id = '73000000-0000-0000-0000-000000000001';

select extensions.dblink_connect('backfill_event_writer', :'test_db_url');
select extensions.dblink_connect('backfill_apply', :'test_db_url');
select extensions.dblink_exec('backfill_event_writer',
  'set application_name = ''workspace-master-backfill-event-writer'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms''');
select extensions.dblink_exec('backfill_apply',
  'set application_name = ''workspace-master-backfill-apply'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms''');

create or replace function pg_temp.assert_backfill_lock_wait(
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

-- A V1 writer owns Event then generation. The stale backfill takes the same
-- order, waits on Event FOR SHARE, and rejects after the writer commits.
select extensions.dblink_exec('backfill_event_writer', $remote$
  begin;
  update public.cloud_events
  set event_name = 'After race',
      event_snapshot = jsonb_set(
        event_snapshot,
        '{appState,events,0,name}',
        '"After race"'::jsonb
      )
  where workspace_id = '73000000-0000-0000-0000-000000000001'
    and event_id = 'event-a';
$remote$);

do $send_backfill$
declare
  source_generation bigint;
  plan jsonb;
  remote_query text;
begin
  select backfill_race_plan.source_generation, backfill_race_plan.plan
    into source_generation, plan
  from backfill_race_plan;
  remote_query := format($remote$
    do $apply$
    begin
      begin
        perform public.backfill_workspace_masters_validated(
          '73000000-0000-0000-0000-000000000001',
          %L,
          %L,
          %L::jsonb,
          true
        );
        raise exception 'stale backfill unexpectedly succeeded';
      exception when sqlstate '40001' then
        null;
      end;
    end;
    $apply$;
  $remote$, source_generation::text, repeat('c', 64), plan::text);
  if extensions.dblink_send_query('backfill_apply', remote_query) <> 1 then
    raise exception 'could not send stale backfill query';
  end if;
end;
$send_backfill$;

select pg_temp.assert_backfill_lock_wait(
  'workspace-master-backfill-apply',
  'backfill did not wait for the concurrent Event writer'
);
select extensions.dblink_exec('backfill_event_writer', 'commit');
select * from extensions.dblink_get_result('backfill_apply') as result(status text);
do $drain_backfill$
declare
  remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('backfill_apply') as result(status text);
  if remaining_results <> 0 then
    raise exception 'backfill connection retained an async result';
  end if;
end;
$drain_backfill$;

do $$
begin
  if exists (
      select 1 from public.cloud_workspace_master_backfills
      where workspace_id = '73000000-0000-0000-0000-000000000001'
    ) or exists (
      select 1 from public.workspace_master_members
      where workspace_id = '73000000-0000-0000-0000-000000000001'
    ) or (select status from public.cloud_workspace_master_states
      where workspace_id = '73000000-0000-0000-0000-000000000001') <> 'legacy'
    or (select revision from public.cloud_events
      where workspace_id = '73000000-0000-0000-0000-000000000001'
        and event_id = 'event-a') <> 2 then
    raise exception 'concurrent Event update/backfill outcome is invalid';
  end if;
end;
$$;

select extensions.dblink_disconnect('backfill_event_writer');
select extensions.dblink_disconnect('backfill_apply');

delete from public.workspaces
where id = '73000000-0000-0000-0000-000000000001'::uuid;
