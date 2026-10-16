\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This fixture intentionally commits between dblink sessions. Run only on a
-- fresh disposable database. It refuses to overwrite a previous fixture.
create extension if not exists dblink with schema extensions;

do $startup_guard$
begin
  if exists (
    select 1 from public.workspaces where id in (
      '79100000-0000-4000-8000-000000000001'::uuid,
      '79200000-0000-4000-8000-000000000001'::uuid,
      '79300000-0000-4000-8000-000000000001'::uuid
    )
  ) or to_regprocedure('public.cloud_v2_atomic_cutover_test_gate()') is not null then
    raise exception 'Dedicated atomic cutover concurrency fixture already exists';
  end if;
end
$startup_guard$;

create or replace function pg_temp.atomic_race_v1_snapshot(
  event_id text,
  event_name text default 'Atomic race Event'
)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event', 'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'members', jsonb_build_array(jsonb_build_object(
        'id', 'member-race', 'realName', 'Race Member', 'active', true
      )),
      'bands', '[]'::jsonb,
      'events', jsonb_build_array(jsonb_build_object(
        'id', event_id, 'name', event_name, 'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1, 'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5)
      )),
      'eventDays', '[]'::jsonb, 'stages', '[]'::jsonb,
      'sections', '[]'::jsonb,
      'eventMembers', jsonb_build_array(jsonb_build_object(
        'id', 'event-member-race', 'eventId', event_id,
        'memberId', 'member-race',
        'paCapabilities', jsonb_build_object('main', false, 'sub', false)
      )),
      'eventMemberDays', '[]'::jsonb, 'eventBands', '[]'::jsonb,
      'scheduleItems', '[]'::jsonb, 'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb, 'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    )
  )
$$;

create or replace function pg_temp.atomic_race_backfill_plan(
  workspace_id uuid,
  source_generation bigint
)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'version', 1, 'workspaceId', workspace_id,
    'sourceGeneration', source_generation::text,
    'sourceEvents', jsonb_build_array(jsonb_build_object(
      'eventId', 'event-race', 'revision', 1,
      'snapshotFingerprint', pg_catalog.encode(extensions.digest(
        pg_temp.atomic_race_v1_snapshot('event-race')::text, 'sha256'
      ), 'hex')
    )),
    'members', jsonb_build_array(jsonb_build_object(
      'id', 'member-race', 'realName', 'Race Member', 'active', true
    )),
    'bands', '[]'::jsonb,
    'bandMembers', '[]'::jsonb,
    'eventMemberReferences', jsonb_build_array(jsonb_build_object(
      'eventId', 'event-race', 'memberId', 'member-race'
    )),
    'eventBandReferences', '[]'::jsonb
  )
$$;

create or replace function pg_temp.atomic_race_cutover_plan(
  workspace_id uuid,
  expected_generation bigint
)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'version', 1, 'workspaceId', workspace_id,
    'expectedGeneration', expected_generation::text,
    'expectedBackfillPlanFingerprint', repeat('e', 64),
    'events', jsonb_build_array(jsonb_build_object(
      'eventId', 'event-race', 'expectedRevision', 1,
      'expectedSnapshotFingerprint', pg_catalog.encode(extensions.digest(
        pg_temp.atomic_race_v1_snapshot('event-race')::text, 'sha256'
      ), 'hex'),
      'snapshotV2', jsonb_build_object(
        'format', 'acappella-tt-cloud-event', 'version', 2,
        'eventState',
          (pg_temp.atomic_race_v1_snapshot('event-race') -> 'appState')
            - 'members' - 'bands',
        'masterReferences', jsonb_build_object(
          'memberIds', jsonb_build_array('member-race'),
          'bandIds', '[]'::jsonb
        )
      )
    ))
  )
$$;

create temporary table atomic_cutover_race_plans (
  workspace_id uuid primary key,
  expected_generation bigint not null,
  plan jsonb not null
);

insert into public.workspaces (id, name) values
  ('79100000-0000-4000-8000-000000000001', 'Atomic writer-first'),
  ('79200000-0000-4000-8000-000000000001', 'Atomic cutover-first'),
  ('79300000-0000-4000-8000-000000000001', 'Atomic double-cutover');

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
)
select workspace_id, 'event-race', 'Atomic race Event',
  pg_temp.atomic_race_v1_snapshot('event-race')
from unnest(array[
  '79100000-0000-4000-8000-000000000001'::uuid,
  '79200000-0000-4000-8000-000000000001'::uuid,
  '79300000-0000-4000-8000-000000000001'::uuid
]) as workspace_id;

do $backfill_all$
declare
  v_workspace_id uuid;
  v_generation bigint;
begin
  foreach v_workspace_id in array array[
    '79100000-0000-4000-8000-000000000001'::uuid,
    '79200000-0000-4000-8000-000000000001'::uuid,
    '79300000-0000-4000-8000-000000000001'::uuid
  ] loop
    select generation into strict v_generation
    from public.cloud_event_workspace_generations
    where workspace_id = v_workspace_id;
    perform public.backfill_workspace_masters_validated(
      v_workspace_id, v_generation::text, repeat('e', 64),
      pg_temp.atomic_race_backfill_plan(v_workspace_id, v_generation), true
    );
    select generation into strict v_generation
    from public.cloud_event_workspace_generations
    where workspace_id = v_workspace_id;
    insert into atomic_cutover_race_plans values (
      v_workspace_id, v_generation,
      pg_temp.atomic_race_cutover_plan(v_workspace_id, v_generation)
    );
  end loop;
end
$backfill_all$;

-- A test-only synchronization trigger pauses the real RPC after it has taken
-- its production locks. It neither skips nor weakens any RPC validation.
create function public.cloud_v2_atomic_cutover_test_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  gate_key bigint;
begin
  if new.event_snapshot -> 'version' is not distinct from '2'::jsonb
    and old.event_id = 'event-race'
    and old.workspace_id in (
      '79200000-0000-4000-8000-000000000001'::uuid,
      '79300000-0000-4000-8000-000000000001'::uuid
    ) then
    gate_key := case old.workspace_id
      when '79200000-0000-4000-8000-000000000001'::uuid then 792001
      else 793001
    end;
    perform pg_catalog.pg_advisory_xact_lock(gate_key);
  end if;
  return new;
end;
$$;
revoke all on function public.cloud_v2_atomic_cutover_test_gate()
  from public, anon, authenticated, service_role;
create trigger cloud_v2_atomic_cutover_test_gate
  before update on public.cloud_events
  for each row execute function public.cloud_v2_atomic_cutover_test_gate();

commit;

select extensions.dblink_connect('atomic_writer', :'test_db_url');
select extensions.dblink_connect('atomic_inserter', :'test_db_url');
select extensions.dblink_connect('atomic_cutover_a', :'test_db_url');
select extensions.dblink_connect('atomic_cutover_b', :'test_db_url');
select extensions.dblink_exec('atomic_writer',
  'set application_name = ''cloud-v2-atomic-writer'';
   set statement_timeout = ''20s''; set lock_timeout = ''15s''');
select extensions.dblink_exec('atomic_inserter',
  'set application_name = ''cloud-v2-atomic-inserter'';
   set statement_timeout = ''20s''; set lock_timeout = ''15s''');
select extensions.dblink_exec('atomic_cutover_a',
  'set application_name = ''cloud-v2-atomic-cutover-a'';
   set statement_timeout = ''20s''; set lock_timeout = ''15s''');
select extensions.dblink_exec('atomic_cutover_b',
  'set application_name = ''cloud-v2-atomic-cutover-b'';
   set statement_timeout = ''20s''; set lock_timeout = ''15s''');

create or replace function pg_temp.assert_atomic_lock_wait(
  p_application_name text,
  p_failure_message text
)
returns void language plpgsql as $$
declare
  attempt integer;
  observed boolean := false;
begin
  for attempt in 1..250 loop
    perform pg_catalog.pg_stat_clear_snapshot();
    select exists (
      select 1 from pg_catalog.pg_stat_activity
      where application_name = p_application_name
        and wait_event_type = 'Lock'
    ) into observed;
    exit when observed;
    perform pg_sleep(0.01);
  end loop;
  if not observed then raise exception '%', p_failure_message; end if;
end;
$$;

-- writer-first: a valid V1 UPDATE holds Event/status/generation locks. The real
-- cutover waits, then revalidates and rejects the stale generation/revision.
select extensions.dblink_exec('atomic_writer', 'begin');
select extensions.dblink_exec('atomic_writer', $writer_first$
  update public.cloud_events
  set event_name = 'Writer first won',
      event_snapshot = jsonb_set(
        event_snapshot, '{appState,events,0,name}',
        to_jsonb('Writer first won'::text)
      )
  where workspace_id = '79100000-0000-4000-8000-000000000001'
    and event_id = 'event-race';
$writer_first$);

do $send_writer_first_cutover$
declare p record;
begin
  select * into strict p from atomic_cutover_race_plans
  where workspace_id = '79100000-0000-4000-8000-000000000001';
  if extensions.dblink_send_query('atomic_cutover_a', format($remote$
    do $cutover$
    begin
      perform public.cutover_cloud_v2_validated(%L::uuid, %L, %L, %L::jsonb);
      raise exception 'writer-first cutover unexpectedly succeeded';
    exception when SQLSTATE '40001' then null;
    end
    $cutover$;
  $remote$, p.workspace_id, p.expected_generation::text, repeat('e', 64), p.plan::text)) <> 1 then
    raise exception 'writer-first: could not send real atomic cutover';
  end if;
end
$send_writer_first_cutover$;
select pg_temp.assert_atomic_lock_wait(
  'cloud-v2-atomic-cutover-a',
  'writer-first: real cutover did not wait for the V1 writer'
);
select extensions.dblink_exec('atomic_writer', 'commit');
select * from extensions.dblink_get_result('atomic_cutover_a') as result(status text);
do $drain_writer_first$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('atomic_cutover_a') as result(status text);
  if remaining_results <> 0 then
    raise exception 'writer-first cutover left a trailing async result';
  end if;
end
$drain_writer_first$;

do $assert_writer_first$
begin
  if (select status from public.cloud_workspace_master_states
      where workspace_id = '79100000-0000-4000-8000-000000000001')
        is distinct from 'legacy'
    or (select event_snapshot -> 'version' from public.cloud_events
      where workspace_id = '79100000-0000-4000-8000-000000000001'
        and event_id = 'event-race') is distinct from '1'::jsonb
    or (select event_name from public.cloud_events
      where workspace_id = '79100000-0000-4000-8000-000000000001'
        and event_id = 'event-race') is distinct from 'Writer first won' then
    raise exception 'writer-first rejection changed or deleted the fixture';
  end if;
end
$assert_writer_first$;

-- cutover-first: pause the real RPC inside its first Event UPDATE. A V1 UPDATE
-- waits on that row, while a V1 INSERT waits on the parent-row lock before its
-- status check. Both must reject after ready commits.
select pg_catalog.pg_advisory_lock(792001);
do $send_cutover_first$
declare p record;
begin
  select * into strict p from atomic_cutover_race_plans
  where workspace_id = '79200000-0000-4000-8000-000000000001';
  if extensions.dblink_send_query('atomic_cutover_a', format(
    'select public.cutover_cloud_v2_validated(%L::uuid,%L,%L,%L::jsonb)',
    p.workspace_id, p.expected_generation::text, repeat('e', 64), p.plan::text
  )) <> 1 then
    raise exception 'cutover-first: could not send real atomic cutover';
  end if;
end
$send_cutover_first$;
select pg_temp.assert_atomic_lock_wait(
  'cloud-v2-atomic-cutover-a',
  'cutover-first: real cutover did not reach the synchronization gate'
);
do $send_cutover_first_writer$
begin
  if extensions.dblink_send_query('atomic_writer', $remote$
    do $writer$
    begin
      begin
        update public.cloud_events
        set event_name = 'Late V1 writer',
            event_snapshot = jsonb_set(
              event_snapshot, '{appState,events,0,name}',
              to_jsonb('Late V1 writer'::text)
            )
        where workspace_id = '79200000-0000-4000-8000-000000000001'
          and event_id = 'event-race';
        raise exception 'cutover-first V1 writer unexpectedly succeeded';
      exception when SQLSTATE '55000' then null;
      end;
    end
    $writer$;
  $remote$) <> 1 then
    raise exception 'cutover-first: could not send V1 writer';
  end if;
end
$send_cutover_first_writer$;
do $send_cutover_first_inserter$
begin
  if extensions.dblink_send_query('atomic_inserter', $remote$
    do $inserter$
    begin
      begin
        insert into public.cloud_events (
          workspace_id, event_id, event_name, event_snapshot
        )
        select workspace_id, 'late-event', 'Late V1 insert',
          jsonb_set(
            jsonb_set(
              event_snapshot, '{appState,events,0,id}',
              to_jsonb('late-event'::text)
            ),
            '{appState,events,0,name}', to_jsonb('Late V1 insert'::text)
          )
        from public.cloud_events
        where workspace_id = '79200000-0000-4000-8000-000000000001'
          and event_id = 'event-race';
        raise exception 'cutover-first V1 INSERT unexpectedly succeeded';
      exception when SQLSTATE '55000' then null;
      end;
    end
    $inserter$;
  $remote$) <> 1 then
    raise exception 'cutover-first: could not send V1 INSERT';
  end if;
end
$send_cutover_first_inserter$;
select pg_temp.assert_atomic_lock_wait(
  'cloud-v2-atomic-writer',
  'cutover-first: V1 writer did not wait for real cutover locks'
);
select pg_temp.assert_atomic_lock_wait(
  'cloud-v2-atomic-inserter',
  'cutover-first: V1 INSERT did not wait for the Workspace parent lock'
);
select pg_catalog.pg_advisory_unlock(792001);
select * from extensions.dblink_get_result('atomic_cutover_a') as result(value jsonb);
do $drain_cutover_first$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('atomic_cutover_a') as result(value jsonb);
  if remaining_results <> 0 then raise exception 'cutover-first left a trailing result'; end if;
end
$drain_cutover_first$;
select * from extensions.dblink_get_result('atomic_writer') as result(status text);
do $drain_cutover_first_writer$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('atomic_writer') as result(status text);
  if remaining_results <> 0 then raise exception 'late V1 writer left a trailing result'; end if;
end
$drain_cutover_first_writer$;
select * from extensions.dblink_get_result('atomic_inserter') as result(status text);
do $drain_cutover_first_inserter$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('atomic_inserter') as result(status text);
  if remaining_results <> 0 then
    raise exception 'late V1 INSERT left a trailing result';
  end if;
end
$drain_cutover_first_inserter$;

do $assert_cutover_first$
begin
  if (select status from public.cloud_workspace_master_states
      where workspace_id = '79200000-0000-4000-8000-000000000001')
        is distinct from 'ready'
    or (select event_snapshot -> 'version' from public.cloud_events
      where workspace_id = '79200000-0000-4000-8000-000000000001'
        and event_id = 'event-race') is distinct from '2'::jsonb
    or exists (select 1 from public.cloud_events
      where workspace_id = '79200000-0000-4000-8000-000000000001'
        and event_id = 'late-event') then
    raise exception 'cutover-first did not preserve the committed V2 result';
  end if;
end
$assert_cutover_first$;

-- double-cutover: the first real RPC holds the parent Workspace row while the
-- second waits. Once ready commits, the second must reject rather than report
-- idempotent success or rewrite the Event again.
select pg_catalog.pg_advisory_lock(793001);
do $send_double_cutover_a$
declare p record;
begin
  select * into strict p from atomic_cutover_race_plans
  where workspace_id = '79300000-0000-4000-8000-000000000001';
  if extensions.dblink_send_query('atomic_cutover_a', format(
    'select public.cutover_cloud_v2_validated(%L::uuid,%L,%L,%L::jsonb)',
    p.workspace_id, p.expected_generation::text, repeat('e', 64), p.plan::text
  )) <> 1 then raise exception 'double-cutover: first send failed'; end if;
end
$send_double_cutover_a$;
select pg_temp.assert_atomic_lock_wait(
  'cloud-v2-atomic-cutover-a',
  'double-cutover: first RPC did not reach its synchronization gate'
);
do $send_double_cutover_b$
declare p record;
begin
  select * into strict p from atomic_cutover_race_plans
  where workspace_id = '79300000-0000-4000-8000-000000000001';
  if extensions.dblink_send_query('atomic_cutover_b', format($remote$
    do $cutover$
    begin
      begin
        perform public.cutover_cloud_v2_validated(%L::uuid, %L, %L, %L::jsonb);
        raise exception 'second atomic cutover unexpectedly succeeded';
      exception when SQLSTATE '55000' then null;
      end;
    end
    $cutover$;
  $remote$, p.workspace_id, p.expected_generation::text, repeat('e', 64), p.plan::text)) <> 1 then
    raise exception 'double-cutover: second send failed';
  end if;
end
$send_double_cutover_b$;
select pg_temp.assert_atomic_lock_wait(
  'cloud-v2-atomic-cutover-b',
  'double-cutover: second RPC did not wait for the Workspace parent lock'
);
select pg_catalog.pg_advisory_unlock(793001);
select * from extensions.dblink_get_result('atomic_cutover_a') as result(value jsonb);
do $drain_double_a$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('atomic_cutover_a') as result(value jsonb);
  if remaining_results <> 0 then raise exception 'first double-cutover result was not drained'; end if;
end
$drain_double_a$;
select * from extensions.dblink_get_result('atomic_cutover_b') as result(status text);
do $drain_double_b$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('atomic_cutover_b') as result(status text);
  if remaining_results <> 0 then raise exception 'second double-cutover result was not drained'; end if;
end
$drain_double_b$;

do $assert_double_cutover$
begin
  if (select status from public.cloud_workspace_master_states
      where workspace_id = '79300000-0000-4000-8000-000000000001')
        is distinct from 'ready'
    or (select revision from public.cloud_events
      where workspace_id = '79300000-0000-4000-8000-000000000001'
        and event_id = 'event-race') is distinct from 2 then
    raise exception 'double-cutover did not leave exactly one committed conversion';
  end if;
end
$assert_double_cutover$;

select extensions.dblink_disconnect('atomic_writer');
select extensions.dblink_disconnect('atomic_inserter');
select extensions.dblink_disconnect('atomic_cutover_a');
select extensions.dblink_disconnect('atomic_cutover_b');

drop trigger cloud_v2_atomic_cutover_test_gate on public.cloud_events;
drop function public.cloud_v2_atomic_cutover_test_gate();

delete from public.workspaces where id in (
  '79100000-0000-4000-8000-000000000001'::uuid,
  '79200000-0000-4000-8000-000000000001'::uuid,
  '79300000-0000-4000-8000-000000000001'::uuid
);

do $final_zero$
declare
  fixture_ids uuid[] := array[
    '79100000-0000-4000-8000-000000000001'::uuid,
    '79200000-0000-4000-8000-000000000001'::uuid,
    '79300000-0000-4000-8000-000000000001'::uuid
  ];
begin
  if exists (select 1 from public.workspaces where id = any(fixture_ids))
    or exists (select 1 from public.workspace_members where workspace_id = any(fixture_ids))
    or exists (select 1 from public.cloud_events where workspace_id = any(fixture_ids))
    or exists (select 1 from public.cloud_event_workspace_generations
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.cloud_workspace_master_states
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.workspace_master_members
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.workspace_master_bands
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.workspace_master_band_members
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.cloud_event_member_references
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.cloud_event_band_references
      where workspace_id = any(fixture_ids))
    or exists (select 1 from public.cloud_workspace_master_backfills
      where workspace_id = any(fixture_ids)) then
    raise exception 'Atomic cutover concurrency fixture cleanup is incomplete';
  end if;
end
$final_zero$;
