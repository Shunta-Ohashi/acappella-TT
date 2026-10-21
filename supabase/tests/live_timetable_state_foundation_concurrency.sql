\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This fixture commits rows so separate dblink sessions can contend on them.
-- Run only in a dedicated disposable database. Existing fixed IDs are never
-- deleted at startup: their presence makes the test fail closed.
create extension if not exists dblink with schema extensions;

do $startup_guard$
begin
  if exists (select 1 from public.workspaces
      where id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from auth.users where id in (
      '00000000-0000-4000-8000-000000000091',
      '00000000-0000-4000-8000-000000000092'
    ))
    or to_regprocedure(
      'public.live_concurrency_projection_fixture()'
    ) is not null
    or to_regprocedure(
      'public.live_concurrency_projection_for(text,text)'
    ) is not null then
    raise exception 'Live concurrency fixture already exists; inspect it manually'
      using errcode = '55000';
  end if;
end
$startup_guard$;

create or replace function pg_temp.live_concurrency_snapshot()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event', 'version', 1,
    'appState', jsonb_build_object(
      'version', 5, 'members', '[]'::jsonb, 'bands', '[]'::jsonb,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'live-concurrency-event', 'name', 'Live concurrency fixture',
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1, 'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(10)
      )),
      'eventDays', '[]'::jsonb, 'stages', '[]'::jsonb,
      'sections', '[]'::jsonb, 'eventMembers', '[]'::jsonb,
      'eventMemberDays', '[]'::jsonb, 'eventBands', '[]'::jsonb,
      'scheduleItems', '[]'::jsonb, 'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb, 'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    )
  )
$$;

begin;
create function public.live_concurrency_projection_fixture()
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-live-timetable-projection', 'version', 1,
    'eventId', 'live-concurrency-event',
    'eventName', 'Live concurrency fixture', 'timeZone', 'Asia/Tokyo',
    'eventDays', jsonb_build_array(jsonb_build_object(
      'sourceEventDayId', 'day-a', 'date', '2026-11-01',
      'label', null, 'position', 0
    )),
    'stages', jsonb_build_array(
      jsonb_build_object(
        'sourceEventDayId', 'day-a', 'sourceStageId', 'stage-a',
        'eventDayPosition', 0,
        'name', 'Stage A', 'position', 0,
        'plannedStartTime', '10:00', 'plannedEndTime', null,
        'sections', '[]'::jsonb,
        'entries', jsonb_build_array(jsonb_build_object(
          'sourceScheduleItemId', 'item-a', 'sourceSectionId', null,
          'afterSectionId', null, 'kind', 'performance', 'position', 0,
          'displayName', 'A', 'plannedStartMinute', 600,
          'plannedEndMinute', 610
        ))
      ),
      jsonb_build_object(
        'sourceEventDayId', 'day-a', 'sourceStageId', 'stage-b',
        'eventDayPosition', 0,
        'name', 'Stage B', 'position', 1,
        'plannedStartTime', '11:00', 'plannedEndTime', null,
        'sections', '[]'::jsonb,
        'entries', jsonb_build_array(jsonb_build_object(
          'sourceScheduleItemId', 'item-b', 'sourceSectionId', null,
          'afterSectionId', null, 'kind', 'performance', 'position', 0,
          'displayName', 'B', 'plannedStartMinute', 660,
          'plannedEndMinute', 670
        ))
      )
    )
  )
$$;
revoke all on function public.live_concurrency_projection_fixture()
  from public, anon, authenticated, service_role;
create function public.live_concurrency_projection_for(
  p_event_id text,
  p_event_name text
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_set(
    jsonb_set(
      public.live_concurrency_projection_fixture(),
      '{eventId}', to_jsonb(p_event_id)
    ),
    '{eventName}', to_jsonb(p_event_name)
  )
$$;
revoke all on function public.live_concurrency_projection_for(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.live_concurrency_projection_for(text, text)
  to service_role;
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-4000-8000-000000000091', 'authenticated', 'authenticated',
   'live-concurrency-owner@example.invalid', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-000000000092', 'authenticated', 'authenticated',
   'live-concurrency-editor@example.invalid', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.workspaces (id, name) values
  ('78100000-0000-4000-8000-000000000001', 'Live concurrency fixture');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('78100000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000091', 'owner'),
  ('78100000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000092', 'editor');
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78100000-0000-4000-8000-000000000001',
  'live-concurrency-event', 'Live concurrency fixture',
  pg_temp.live_concurrency_snapshot()
);
insert into public.live_timetables (
  id, public_id, workspace_id, event_id, event_name, time_zone,
  event_days, source_event_revision, source_snapshot_fingerprint,
  projection_version, management_revision, is_published
) values (
  '78100000-0000-4000-8000-000000000010',
  '78100000-0000-4000-8000-000000000011',
  '78100000-0000-4000-8000-000000000001',
  'live-concurrency-event', 'Live concurrency fixture', 'Asia/Tokyo',
  '[]'::jsonb, 1,
  encode(extensions.digest(pg_temp.live_concurrency_snapshot()::text, 'sha256'), 'hex'),
  1, 1, true
);
insert into public.live_timetable_stages (
  id, workspace_id, live_timetable_id, source_event_day_id,
  event_day_position, source_stage_id, name, position, planned_start_time, sections,
  projection_version, revision, progress_status,
  next_entry_position, next_performance_position
) values
  ('78100000-0000-4000-8000-000000000020',
   '78100000-0000-4000-8000-000000000001',
   '78100000-0000-4000-8000-000000000010',
   'day-a', 0, 'stage-a', 'Stage A', 0, '10:00', '[]'::jsonb,
   1, 1, 'not_started', 0, 0),
  ('78100000-0000-4000-8000-000000000021',
   '78100000-0000-4000-8000-000000000001',
   '78100000-0000-4000-8000-000000000010',
   'day-a', 0, 'stage-b', 'Stage B', 1, '11:00', '[]'::jsonb,
   1, 1, 'not_started', 0, 0);
insert into public.live_timetable_entries (
  id, workspace_id, live_timetable_id, stage_id,
  source_schedule_item_id, kind, position, display_name,
  planned_start_minute, planned_end_minute
) values
  ('78100000-0000-4000-8000-000000000030',
   '78100000-0000-4000-8000-000000000001',
   '78100000-0000-4000-8000-000000000010',
   '78100000-0000-4000-8000-000000000020',
   'item-a', 'performance', 0, 'A', 600, 610),
  ('78100000-0000-4000-8000-000000000031',
   '78100000-0000-4000-8000-000000000001',
   '78100000-0000-4000-8000-000000000010',
   '78100000-0000-4000-8000-000000000021',
   'item-b', 'performance', 0, 'B', 660, 670);
insert into public.live_timetable_stage_operators (
  workspace_id, live_timetable_id, stage_id, user_id
) values
  ('78100000-0000-4000-8000-000000000001',
   '78100000-0000-4000-8000-000000000010',
   '78100000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000092'),
  ('78100000-0000-4000-8000-000000000001',
   '78100000-0000-4000-8000-000000000010',
   '78100000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000092');
commit;

select extensions.dblink_connect('live_writer_a', :'test_db_url');
select extensions.dblink_connect('live_writer_b', :'test_db_url');
select extensions.dblink_exec('live_writer_a',
  'set application_name = ''live-foundation-writer-a'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s''');
select extensions.dblink_exec('live_writer_b',
  'set application_name = ''live-foundation-writer-b'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s''');

create or replace function pg_temp.assert_live_lock_wait(
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
end
$$;

create or replace function pg_temp.assert_live_async_finishes(
  connection_name text,
  failure_message text
)
returns void
language plpgsql
as $$
declare
  attempt integer;
begin
  for attempt in 1..200 loop
    if extensions.dblink_is_busy(connection_name) = 0 then return; end if;
    perform pg_sleep(0.01);
  end loop;
  raise exception '%', failure_message;
end
$$;

-- Same-Stage stale CAS: exactly one start commits; the waiter must recheck
-- revision after obtaining the Stage lock and reject with 40001.
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000092', true
    );
    perform public.start_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '1', '1'
    );
  end
  $operation$;
$remote$);
do $send_stale$
begin
  if extensions.dblink_send_query('live_writer_b', $remote$
    do $stale$
    begin
      perform set_config(
        'request.jwt.claim.sub',
        '00000000-0000-4000-8000-000000000092', true
      );
      begin
        perform public.start_live_timetable_entry(
          '78100000-0000-4000-8000-000000000010',
          'stage-a', 'item-a', '1', '1'
        );
        raise exception 'same-Stage stale start succeeded' using errcode = 'P0004';
      exception when sqlstate '40001' then null;
      end;
    end
    $stale$;
  $remote$) <> 1 then
    raise exception 'could not send stale same-Stage start';
  end if;
end
$send_stale$;
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'same-Stage start did not wait'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);
do $$
begin
  if (select count(*) from public.live_timetable_entries
      where stage_id = '78100000-0000-4000-8000-000000000020'
        and status = 'in_progress') <> 1
    or (select revision from public.live_timetable_stages
      where id = '78100000-0000-4000-8000-000000000020') <> 2 then
    raise exception 'same-Stage race did not produce exactly one winner';
  end if;
end
$$;

-- The same CAS rule applies to end. One end commits; a waiter using the
-- previously current Stage revision must recheck after the Stage lock.
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000092', true
    );
    perform public.end_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '2', '1'
    );
  end
  $operation$;
$remote$);
do $send_stale_end$
begin
  if extensions.dblink_send_query('live_writer_b', $remote$
    do $stale_end$
    begin
      perform set_config(
        'request.jwt.claim.sub',
        '00000000-0000-4000-8000-000000000092', true
      );
      begin
        perform public.end_live_timetable_entry(
          '78100000-0000-4000-8000-000000000010',
          'stage-a', 'item-a', '2', '1'
        );
        raise exception 'same-Stage stale end succeeded' using errcode = 'P0004';
      exception when sqlstate '40001' then null;
      end;
    end
    $stale_end$;
  $remote$) <> 1 then
    raise exception 'could not send stale same-Stage end';
  end if;
end
$send_stale_end$;
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'same-Stage end did not wait'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);
do $$
begin
  if (select status from public.live_timetable_entries
      where id = '78100000-0000-4000-8000-000000000030') <> 'completed'
    or (select revision from public.live_timetable_stages
      where id = '78100000-0000-4000-8000-000000000020') <> 3 then
    raise exception 'same-Stage end race did not produce exactly one winner';
  end if;
end
$$;

-- Restore the exact baseline between scenarios.
update public.live_timetable_entries
set status = 'pending', actual_started_at = null, actual_ended_at = null,
    started_by = null, ended_by = null
where live_timetable_id = '78100000-0000-4000-8000-000000000010';
update public.live_timetable_stages
set revision = 1, progress_status = 'not_started',
    current_entry_position = null, next_entry_position = 0,
    next_performance_position = 0
where live_timetable_id = '78100000-0000-4000-8000-000000000010';

-- Different Stages do not share an exclusive Stage lock. B must finish while
-- A's transaction still holds the Stage A row.
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000092', true
    );
    perform public.start_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '1', '1'
    );
  end
  $operation$;
$remote$);
select extensions.dblink_send_query('live_writer_b', $remote$
  select set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000000092', true
  );
  select public.start_live_timetable_entry(
    '78100000-0000-4000-8000-000000000010',
    'stage-b', 'item-b', '1', '1'
  );
$remote$);
select pg_temp.assert_live_async_finishes(
  'live_writer_b', 'different-Stage start was unnecessarily blocked'
);
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select * from extensions.dblink_get_result('live_writer_b') as result(value jsonb);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);
select extensions.dblink_exec('live_writer_a', 'rollback');

update public.live_timetable_entries
set status = 'pending', actual_started_at = null, actual_ended_at = null,
    started_by = null, ended_by = null
where live_timetable_id = '78100000-0000-4000-8000-000000000010';
update public.live_timetable_stages
set revision = 1, progress_status = 'not_started',
    current_entry_position = null, next_entry_position = 0,
    next_performance_position = 0
where live_timetable_id = '78100000-0000-4000-8000-000000000010';

-- Publication mutation takes the Live UPDATE lock. A blocked start must
-- observe the newly unpublished state and reject with 55000.
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000091', true
    );
    perform public.set_live_timetable_publication(
      '78100000-0000-4000-8000-000000000010', '1', false
    );
  end
  $operation$;
$remote$);
do $send_unpublished_start$
begin
  if extensions.dblink_send_query('live_writer_b', $remote$
    do $blocked$
    begin
      perform set_config(
        'request.jwt.claim.sub',
        '00000000-0000-4000-8000-000000000092', true
      );
      begin
        perform public.start_live_timetable_entry(
          '78100000-0000-4000-8000-000000000010',
          'stage-a', 'item-a', '1', '1'
        );
        raise exception 'start succeeded after unpublish' using errcode = 'P0004';
      exception when sqlstate '55000' then null;
      end;
    end
    $blocked$;
  $remote$) <> 1 then raise exception 'could not send blocked start'; end if;
end
$send_unpublished_start$;
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'start did not wait for publication lock'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);

-- Restore and verify assignment mutation serializes with an in-flight editor
-- operation. The assignment cannot disappear before the operation commits.
update public.live_timetables
set is_published = true, management_revision = 1
where id = '78100000-0000-4000-8000-000000000010';

-- A progress transaction and projection replacement must not interleave.
-- Starting requires published=true while replacement requires false, so the
-- waiter must re-read the locked Live row and reject rather than replacing a
-- projection that has just started.
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000092', true
    );
    perform public.start_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '1', '1'
    );
  end
  $operation$;
$remote$);
do $send_replacement$
begin
  if extensions.dblink_send_query('live_writer_b', $remote$
    do $replacement$
    declare
      snapshot_fingerprint text;
    begin
      select encode(
        extensions.digest(event_snapshot::text, 'sha256'), 'hex'
      ) into snapshot_fingerprint
      from public.cloud_events
      where workspace_id = '78100000-0000-4000-8000-000000000001'
        and event_id = 'live-concurrency-event';
      begin
        perform public.create_or_replace_live_timetable_projection(
          '00000000-0000-4000-8000-000000000091',
          '78100000-0000-4000-8000-000000000001',
          'live-concurrency-event', 1, snapshot_fingerprint,
          public.live_concurrency_projection_fixture(), 'replace', '1'
        );
        raise exception 'replacement raced past progress' using errcode = 'P0004';
      exception when sqlstate '55000' then null;
      end;
    end
    $replacement$;
  $remote$) <> 1 then raise exception 'could not send replacement'; end if;
end
$send_replacement$;
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'replacement did not wait for progress lock'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);

update public.live_timetable_entries
set status = 'pending', actual_started_at = null, actual_ended_at = null,
    started_by = null, ended_by = null
where live_timetable_id = '78100000-0000-4000-8000-000000000010';
update public.live_timetable_stages
set revision = 1, progress_status = 'not_started',
    current_entry_position = null, next_entry_position = 0,
    next_performance_position = 0
where live_timetable_id = '78100000-0000-4000-8000-000000000010';

-- Operator removal uses the Live UPDATE lock and cannot invalidate the
-- authorization of an already running editor operation.
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000092', true
    );
    perform public.start_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '1', '1'
    );
  end
  $operation$;
$remote$);
select extensions.dblink_send_query('live_writer_b', $remote$
  select set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000000091', true
  );
  select public.set_live_timetable_stage_operator(
    '78100000-0000-4000-8000-000000000010',
    'stage-a', '00000000-0000-4000-8000-000000000092',
    false, '1', '1'
  );
$remote$);
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'operator removal did not wait for Live operation'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select * from extensions.dblink_get_result('live_writer_b') as result(value jsonb);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);
do $$
begin
  if exists (select 1 from public.live_timetable_stage_operators
      where stage_id = '78100000-0000-4000-8000-000000000020'
        and user_id = '00000000-0000-4000-8000-000000000092') then
    raise exception 'operator removal did not commit after progress';
  end if;
  if (select revision from public.cloud_events
      where workspace_id = '78100000-0000-4000-8000-000000000001'
        and event_id = 'live-concurrency-event') <> 1
    or (select generation from public.cloud_event_workspace_generations
      where workspace_id = '78100000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'Live concurrency changed Cloud Event revision/generation';
  end if;
end
$$;

-- A membership role change must wait for the membership SHARE lock held by
-- an in-flight operation. Once the downgrade commits, a stale operator row
-- must not authorize another mutation.
update public.live_timetable_entries
set status = 'pending', actual_started_at = null, actual_ended_at = null,
    started_by = null, ended_by = null
where live_timetable_id = '78100000-0000-4000-8000-000000000010';
update public.live_timetable_stages
set revision = 1, progress_status = 'not_started',
    current_entry_position = null, next_entry_position = 0,
    next_performance_position = 0
where live_timetable_id = '78100000-0000-4000-8000-000000000010';
update public.live_timetables
set management_revision = 1
where id = '78100000-0000-4000-8000-000000000010';
insert into public.live_timetable_stage_operators (
  workspace_id, live_timetable_id, stage_id, user_id
) values (
  '78100000-0000-4000-8000-000000000001',
  '78100000-0000-4000-8000-000000000010',
  '78100000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000092'
) on conflict do nothing;

select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role authenticated;
  do $operation$
  begin
    perform set_config(
      'request.jwt.claim.sub',
      '00000000-0000-4000-8000-000000000092', true
    );
    perform public.start_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '1', '1'
    );
  end
  $operation$;
$remote$);
select extensions.dblink_send_query('live_writer_b', $remote$
  update public.workspace_members
  set role = 'viewer'
  where workspace_id = '78100000-0000-4000-8000-000000000001'
    and user_id = '00000000-0000-4000-8000-000000000092';
$remote$);
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'membership downgrade did not wait for progress'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);

update public.live_timetable_entries
set status = 'pending', actual_started_at = null, actual_ended_at = null,
    started_by = null, ended_by = null
where live_timetable_id = '78100000-0000-4000-8000-000000000010';
update public.live_timetable_stages
set revision = 1, progress_status = 'not_started',
    current_entry_position = null, next_entry_position = 0,
    next_performance_position = 0
where live_timetable_id = '78100000-0000-4000-8000-000000000010';

set role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000092', false
);
do $stale_assignment_after_downgrade$
begin
  begin
    perform public.start_live_timetable_entry(
      '78100000-0000-4000-8000-000000000010',
      'stage-a', 'item-a', '1', '1'
    );
    raise exception 'viewer with stale assignment started Live entry'
      using errcode = 'P0004';
  exception when insufficient_privilege then null;
  end;
end
$stale_assignment_after_downgrade$;
reset role;
update public.workspace_members
set role = 'editor'
where workspace_id = '78100000-0000-4000-8000-000000000001'
  and user_id = '00000000-0000-4000-8000-000000000092';

-- A source read is only evidence for its observed revision/fingerprint. If the
-- Event is updated before commit, the backend CAS must reject without leaving
-- a partial Live projection.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78100000-0000-4000-8000-000000000001',
  'live-source-update-race', 'Live source update race',
  jsonb_set(
    jsonb_set(
      pg_temp.live_concurrency_snapshot(),
      '{appState,events,0,id}', to_jsonb('live-source-update-race'::text)
    ),
    '{appState,events,0,name}', to_jsonb('Live source update race'::text)
  )
);
select set_config(
  'test.live_source_update_fingerprint',
  encode(extensions.digest(event_snapshot::text, 'sha256'), 'hex'),
  false
)
from public.cloud_events
where workspace_id = '78100000-0000-4000-8000-000000000001'
  and event_id = 'live-source-update-race';
select extensions.dblink_exec('live_writer_a', $remote$
  update public.cloud_events
  set event_name = 'Live source update race changed',
      event_snapshot = jsonb_set(
        event_snapshot,
        '{appState,events,0,name}',
        to_jsonb('Live source update race changed'::text)
      )
  where workspace_id = '78100000-0000-4000-8000-000000000001'
    and event_id = 'live-source-update-race';
$remote$);
set role service_role;
do $updated_source_cas$
begin
  begin
    perform public.create_or_replace_live_timetable_projection(
      '00000000-0000-4000-8000-000000000091',
      '78100000-0000-4000-8000-000000000001',
      'live-source-update-race', 1,
      current_setting('test.live_source_update_fingerprint'),
      public.live_concurrency_projection_for(
        'live-source-update-race', 'Live source update race'
      ),
      'create', null
    );
    raise exception 'updated source was committed as Live projection'
      using errcode = 'P0004';
  exception when sqlstate '40001' then null;
  end;
end
$updated_source_cas$;
reset role;
do $updated_source_no_partial$
begin
  if exists (select 1 from public.live_timetables
      where workspace_id = '78100000-0000-4000-8000-000000000001'
        and event_id = 'live-source-update-race') then
    raise exception 'updated source left a partial Live projection';
  end if;
end
$updated_source_no_partial$;

-- Deletion after source inspection must likewise fail closed and leave no
-- projection. The deleted source is recreated nowhere by the mutation.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78100000-0000-4000-8000-000000000001',
  'live-source-delete-race', 'Live source delete race',
  jsonb_set(
    jsonb_set(
      pg_temp.live_concurrency_snapshot(),
      '{appState,events,0,id}', to_jsonb('live-source-delete-race'::text)
    ),
    '{appState,events,0,name}', to_jsonb('Live source delete race'::text)
  )
);
select set_config(
  'test.live_source_delete_fingerprint',
  encode(extensions.digest(event_snapshot::text, 'sha256'), 'hex'),
  false
)
from public.cloud_events
where workspace_id = '78100000-0000-4000-8000-000000000001'
  and event_id = 'live-source-delete-race';
select extensions.dblink_exec('live_writer_a', $remote$
  delete from public.cloud_events
  where workspace_id = '78100000-0000-4000-8000-000000000001'
    and event_id = 'live-source-delete-race';
$remote$);
set role service_role;
do $deleted_source_cas$
begin
  begin
    perform public.create_or_replace_live_timetable_projection(
      '00000000-0000-4000-8000-000000000091',
      '78100000-0000-4000-8000-000000000001',
      'live-source-delete-race', 1,
      current_setting('test.live_source_delete_fingerprint'),
      public.live_concurrency_projection_for(
        'live-source-delete-race', 'Live source delete race'
      ),
      'create', null
    );
    raise exception 'deleted source was committed as Live projection'
      using errcode = 'P0004';
  exception when sqlstate 'P0002' then null;
  end;
end
$deleted_source_cas$;
reset role;

-- Concurrent create calls for one Event serialize on the unique identity.
-- Exactly one commits; the waiter must report the existing Live projection.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78100000-0000-4000-8000-000000000001',
  'live-create-race', 'Live create race',
  jsonb_set(
    jsonb_set(
      pg_temp.live_concurrency_snapshot(),
      '{appState,events,0,id}', to_jsonb('live-create-race'::text)
    ),
    '{appState,events,0,name}', to_jsonb('Live create race'::text)
  )
);
select extensions.dblink_exec('live_writer_a', $remote$
  begin;
  set local role service_role;
  do $create_a$
  declare
    source_fingerprint text;
  begin
    select encode(extensions.digest(event_snapshot::text, 'sha256'), 'hex')
      into source_fingerprint
    from public.cloud_events
    where workspace_id = '78100000-0000-4000-8000-000000000001'
      and event_id = 'live-create-race';
    perform public.create_or_replace_live_timetable_projection(
      '00000000-0000-4000-8000-000000000091',
      '78100000-0000-4000-8000-000000000001',
      'live-create-race', 1, source_fingerprint,
      public.live_concurrency_projection_for(
        'live-create-race', 'Live create race'
      ),
      'create', null
    );
  end
  $create_a$;
$remote$);
do $send_duplicate_create$
begin
  if extensions.dblink_send_query('live_writer_b', $remote$
    do $create_b$
    declare
      source_fingerprint text;
    begin
      select encode(extensions.digest(event_snapshot::text, 'sha256'), 'hex')
        into source_fingerprint
      from public.cloud_events
      where workspace_id = '78100000-0000-4000-8000-000000000001'
        and event_id = 'live-create-race';
      begin
        perform public.create_or_replace_live_timetable_projection(
          '00000000-0000-4000-8000-000000000091',
          '78100000-0000-4000-8000-000000000001',
          'live-create-race', 1, source_fingerprint,
          public.live_concurrency_projection_for(
            'live-create-race', 'Live create race'
          ),
          'create', null
        );
        raise exception 'duplicate Live create succeeded' using errcode = 'P0004';
      exception when unique_violation then null;
      end;
    end
    $create_b$;
  $remote$) <> 1 then
    raise exception 'could not send duplicate Live create';
  end if;
end
$send_duplicate_create$;
select pg_temp.assert_live_lock_wait(
  'live-foundation-writer-b', 'duplicate Live create did not wait'
);
select extensions.dblink_exec('live_writer_a', 'commit');
select * from extensions.dblink_get_result('live_writer_b') as result(status text);
select count(*) from extensions.dblink_get_result('live_writer_b') as result(status text);
do $single_live_create_winner$
begin
  if (select count(*) from public.live_timetables
      where workspace_id = '78100000-0000-4000-8000-000000000001'
        and event_id = 'live-create-race') <> 1 then
    raise exception 'concurrent Live create did not produce one winner';
  end if;
end
$single_live_create_winner$;

select extensions.dblink_disconnect('live_writer_a');
select extensions.dblink_disconnect('live_writer_b');

-- Cleanup uses one exact, reusable path. It locks the parent before any child
-- so concurrent FK inserts wait, locks existing children in a stable order,
-- validates the complete fixture allowlist, and only then deletes.
create or replace function pg_temp.live_concurrency_fixture_digest()
returns text
language sql
stable
as $$
  with fixture_rows as (
    select 'workspace'::text as kind, id::text as row_key,
      to_jsonb(workspaces)::text as payload
    from public.workspaces
    where id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'membership', user_id::text, to_jsonb(workspace_members)::text
    from public.workspace_members
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'event', event_id, to_jsonb(cloud_events)::text
    from public.cloud_events
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'master-state', workspace_id::text,
      to_jsonb(cloud_workspace_master_states)::text
    from public.cloud_workspace_master_states
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'generation', workspace_id::text,
      to_jsonb(cloud_event_workspace_generations)::text
    from public.cloud_event_workspace_generations
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'live', id::text, to_jsonb(live_timetables)::text
    from public.live_timetables
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'stage', id::text, to_jsonb(live_timetable_stages)::text
    from public.live_timetable_stages
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'entry', id::text, to_jsonb(live_timetable_entries)::text
    from public.live_timetable_entries
    where workspace_id = '78100000-0000-4000-8000-000000000001'
    union all
    select 'operator', stage_id::text || ':' || user_id::text,
      to_jsonb(live_timetable_stage_operators)::text
    from public.live_timetable_stage_operators
    where workspace_id = '78100000-0000-4000-8000-000000000001'
  )
  select md5(coalesce(string_agg(
    md5(kind || ':' || row_key || ':' || payload), '' order by kind, row_key
  ), ''))
  from fixture_rows
$$;

create or replace function pg_temp.assert_live_concurrency_cleanup_target()
returns void
language plpgsql
as $$
declare
  fixture_workspace_id constant uuid :=
    '78100000-0000-4000-8000-000000000001';
  locked_workspace_name text;
begin
  select name into locked_workspace_name
  from public.workspaces
  where id = fixture_workspace_id
  for update;
  if not found
    or locked_workspace_name is distinct from 'Live concurrency fixture' then
    raise exception 'Live concurrency cleanup target is not the fixture Workspace'
      using errcode = '55000';
  end if;

  perform 1 from public.workspace_members
    where workspace_id = fixture_workspace_id order by user_id for update;
  perform 1 from public.cloud_events
    where workspace_id = fixture_workspace_id order by event_id for update;
  perform 1 from public.cloud_event_workspace_generations
    where workspace_id = fixture_workspace_id for update;
  perform 1 from public.cloud_workspace_master_states
    where workspace_id = fixture_workspace_id for update;
  perform 1 from public.workspace_master_members
    where workspace_id = fixture_workspace_id order by member_id for update;
  perform 1 from public.workspace_master_bands
    where workspace_id = fixture_workspace_id order by band_id for update;
  perform 1 from public.workspace_master_band_members
    where workspace_id = fixture_workspace_id
    order by band_id, member_id for update;
  perform 1 from public.cloud_event_member_references
    where workspace_id = fixture_workspace_id
    order by event_id, member_id for update;
  perform 1 from public.cloud_event_band_references
    where workspace_id = fixture_workspace_id
    order by event_id, band_id for update;
  perform 1 from public.cloud_workspace_master_backfills
    where workspace_id = fixture_workspace_id for update;
  perform 1 from public.live_timetables
    where workspace_id = fixture_workspace_id order by id for update;
  perform 1 from public.live_timetable_stages
    where workspace_id = fixture_workspace_id order by id for update;
  perform 1 from public.live_timetable_entries
    where workspace_id = fixture_workspace_id order by id for update;
  perform 1 from public.live_timetable_stage_operators
    where workspace_id = fixture_workspace_id
    order by stage_id, user_id for update;
  perform 1 from auth.users
    where id in (
      '00000000-0000-4000-8000-000000000091',
      '00000000-0000-4000-8000-000000000092'
    ) order by id for update;

  if (select count(*) from public.workspace_members
      where workspace_id = fixture_workspace_id
        and (
          (user_id = '00000000-0000-4000-8000-000000000091'
            and role = 'owner')
          or (user_id = '00000000-0000-4000-8000-000000000092'
            and role = 'editor')
        )) is distinct from 2
    or (select count(*) from public.workspace_members
      where workspace_id = fixture_workspace_id) is distinct from 2
    or (select count(*) from auth.users
      where (id = '00000000-0000-4000-8000-000000000091'
          and email = 'live-concurrency-owner@example.invalid')
        or (id = '00000000-0000-4000-8000-000000000092'
          and email = 'live-concurrency-editor@example.invalid'))
      is distinct from 2
    or (select count(*) from public.cloud_events
      where workspace_id = fixture_workspace_id) is distinct from 3
    or (select count(*) from public.cloud_events
      where workspace_id = fixture_workspace_id
        and event_id = 'live-concurrency-event'
        and event_name = 'Live concurrency fixture'
        and revision = 1) is distinct from 1
    or (select count(*) from public.cloud_events
      where workspace_id = fixture_workspace_id
        and event_id = 'live-source-update-race'
        and event_name = 'Live source update race changed'
        and revision = 2) is distinct from 1
    or (select count(*) from public.cloud_events
      where workspace_id = fixture_workspace_id
        and event_id = 'live-create-race'
        and event_name = 'Live create race'
        and revision = 1) is distinct from 1
    or exists (
      select 1 from public.cloud_events
      where workspace_id = fixture_workspace_id
        and (
          event_id not in (
            'live-concurrency-event',
            'live-source-update-race',
            'live-create-race'
          )
          or jsonb_typeof(event_snapshot -> 'appState' -> 'events')
            is distinct from 'array'
          or jsonb_array_length(event_snapshot -> 'appState' -> 'events')
            is distinct from 1
          or event_snapshot -> 'version' is distinct from '1'::jsonb
          or event_snapshot #>> '{appState,events,0,id}'
            is distinct from event_id
          or event_snapshot #>> '{appState,events,0,name}'
            is distinct from event_name
        )
    )
    or (select count(*) from public.cloud_workspace_master_states
      where workspace_id = fixture_workspace_id and status = 'legacy')
      is distinct from 1
    or (select count(*) from public.cloud_event_workspace_generations
      where workspace_id = fixture_workspace_id and generation = 6)
      is distinct from 1
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
    or (select count(*) from public.live_timetables
      where workspace_id = fixture_workspace_id) is distinct from 2
    or (select count(*) from public.live_timetables
      where workspace_id = fixture_workspace_id
        and id = '78100000-0000-4000-8000-000000000010'
        and event_id = 'live-concurrency-event'
        and event_name = 'Live concurrency fixture'
        and projection_version = 1
        and management_revision = 1
        and is_published) is distinct from 1
    or (select count(*) from public.live_timetables
      where workspace_id = fixture_workspace_id
        and event_id = 'live-create-race'
        and event_name = 'Live create race'
        and projection_version = 1
        and management_revision = 1
        and not is_published) is distinct from 1
    or exists (
      select 1
      from public.live_timetables as live
      join public.cloud_events as event
        on event.workspace_id = live.workspace_id
       and event.event_id = live.event_id
      where live.workspace_id = fixture_workspace_id
        and live.source_snapshot_fingerprint is distinct from encode(
          extensions.digest(event.event_snapshot::text, 'sha256'), 'hex'
        )
    )
    or (select count(*) from public.live_timetable_stages
      where workspace_id = fixture_workspace_id) is distinct from 4
    or (select count(*) from public.live_timetable_stages
      where live_timetable_id = '78100000-0000-4000-8000-000000000010'
        and id in (
          '78100000-0000-4000-8000-000000000020',
          '78100000-0000-4000-8000-000000000021'
        ) and revision = 1 and progress_status = 'not_started')
      is distinct from 2
    or (select count(*) from public.live_timetable_stages as stage
      join public.live_timetables as live on live.id = stage.live_timetable_id
      where live.workspace_id = fixture_workspace_id
        and live.event_id = 'live-create-race'
        and stage.source_stage_id in ('stage-a', 'stage-b')
        and stage.revision = 1 and stage.progress_status = 'not_started')
      is distinct from 2
    or (select count(*) from public.live_timetable_entries
      where workspace_id = fixture_workspace_id) is distinct from 4
    or (select count(*) from public.live_timetable_entries
      where live_timetable_id = '78100000-0000-4000-8000-000000000010'
        and id in (
          '78100000-0000-4000-8000-000000000030',
          '78100000-0000-4000-8000-000000000031'
        ) and status = 'pending') is distinct from 2
    or (select count(*) from public.live_timetable_entries as entry
      join public.live_timetables as live on live.id = entry.live_timetable_id
      where live.workspace_id = fixture_workspace_id
        and live.event_id = 'live-create-race'
        and entry.source_schedule_item_id in ('item-a', 'item-b')
        and entry.status = 'pending') is distinct from 2
    or (select count(*) from public.live_timetable_stage_operators
      where workspace_id = fixture_workspace_id
        and live_timetable_id = '78100000-0000-4000-8000-000000000010'
        and stage_id in (
          '78100000-0000-4000-8000-000000000020',
          '78100000-0000-4000-8000-000000000021'
        )
        and user_id = '00000000-0000-4000-8000-000000000092')
      is distinct from 2
    or (select count(*) from public.live_timetable_stage_operators
      where workspace_id = fixture_workspace_id) is distinct from 2 then
    raise exception 'Live concurrency cleanup target differs from its fixture'
      using errcode = '55000';
  end if;
end
$$;

create or replace function pg_temp.cleanup_live_concurrency_fixture()
returns void
language plpgsql
as $$
begin
  perform pg_temp.assert_live_concurrency_cleanup_target();
  delete from public.live_timetables
  where workspace_id = '78100000-0000-4000-8000-000000000001';
  delete from public.cloud_events
  where workspace_id = '78100000-0000-4000-8000-000000000001';
  delete from public.workspaces
  where id = '78100000-0000-4000-8000-000000000001'
    and name = 'Live concurrency fixture';
  delete from auth.users
  where (id = '00000000-0000-4000-8000-000000000091'
      and email = 'live-concurrency-owner@example.invalid')
    or (id = '00000000-0000-4000-8000-000000000092'
      and email = 'live-concurrency-editor@example.invalid');
end
$$;

-- The actual cleanup path must fail before deleting anything if an unexpected
-- Event is mixed into the dedicated Workspace.
begin;
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78100000-0000-4000-8000-000000000001',
  'live-unexpected-cleanup-event', 'Unexpected cleanup Event',
  jsonb_set(
    jsonb_set(
      pg_temp.live_concurrency_snapshot(),
      '{appState,events,0,id}',
      to_jsonb('live-unexpected-cleanup-event'::text)
    ),
    '{appState,events,0,name}',
    to_jsonb('Unexpected cleanup Event'::text)
  )
);
do $cleanup_negative_regression$
declare
  before_digest text := pg_temp.live_concurrency_fixture_digest();
  after_digest text;
begin
  begin
    perform pg_temp.cleanup_live_concurrency_fixture();
    raise exception 'cleanup accepted an unexpected Cloud Event'
      using errcode = 'P0004';
  exception when sqlstate '55000' then
    null;
  end;
  after_digest := pg_temp.live_concurrency_fixture_digest();
  if before_digest is distinct from after_digest
    or not exists (select 1 from public.workspaces
      where id = '78100000-0000-4000-8000-000000000001'
        and name = 'Live concurrency fixture')
    or not exists (select 1 from public.cloud_events
      where workspace_id = '78100000-0000-4000-8000-000000000001'
        and event_id = 'live-unexpected-cleanup-event') then
    raise exception 'failed cleanup changed the protected fixture';
  end if;
end
$cleanup_negative_regression$;
rollback;

-- Exact cleanup only after every assertion succeeds. Guard, deletes, helper
-- removal, and commit share one transaction.
begin;
select pg_temp.cleanup_live_concurrency_fixture();
drop function public.live_concurrency_projection_for(text, text);
drop function public.live_concurrency_projection_fixture();
commit;

do $final_cleanup_guard$
begin
  if exists (select 1 from public.live_timetables
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.live_timetable_stages
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.live_timetable_entries
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.live_timetable_stage_operators
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.cloud_events
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.cloud_workspace_master_states
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.cloud_event_workspace_generations
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.workspace_master_members
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.workspace_master_bands
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.workspace_master_band_members
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.cloud_event_member_references
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.cloud_event_band_references
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.cloud_workspace_master_backfills
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.workspace_members
      where workspace_id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from public.workspaces
      where id = '78100000-0000-4000-8000-000000000001')
    or exists (select 1 from auth.users where id in (
      '00000000-0000-4000-8000-000000000091',
      '00000000-0000-4000-8000-000000000092'
    ))
    or to_regprocedure(
      'public.live_concurrency_projection_fixture()'
    ) is not null
    or to_regprocedure(
      'public.live_concurrency_projection_for(text,text)'
    ) is not null then
    raise exception 'Live concurrency fixture cleanup is incomplete';
  end if;
end
$final_cleanup_guard$;
