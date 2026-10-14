\set ON_ERROR_STOP on

\if :{?test_db_url}
\else
  \echo 'Pass -v test_db_url=<disposable admin PostgreSQL URL>.'
  \quit 2
\endif

-- This fixture intentionally commits across dblink connections. Run only on
-- a disposable database. Startup/final cleanup target these fixed IDs only.
create extension if not exists dblink with schema extensions;

delete from public.workspaces where id =
  '72000000-0000-0000-0000-000000000004'::uuid;
delete from auth.users where id =
  '00000000-0000-0000-0000-000000000085'::uuid;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000085',
  'authenticated', 'authenticated', 'event-v2-race@example.invalid', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);
insert into public.workspaces (id, name) values (
  '72000000-0000-0000-0000-000000000004', 'Event V2 concurrency'
);
insert into public.workspace_members (workspace_id, user_id, role) values (
  '72000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000085',
  'owner'
);
update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '72000000-0000-0000-0000-000000000004';
insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values (
  '72000000-0000-0000-0000-000000000004', 'member-race', 'Race Member', true
);

create or replace function pg_temp.cloud_event_v2_race_snapshot(
  p_name text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 2,
    'eventState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'event-race', 'name', p_name,
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1, 'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5)
      )),
      'eventDays', '[]'::jsonb,
      'stages', '[]'::jsonb,
      'sections', '[]'::jsonb,
      'eventMembers', jsonb_build_array(jsonb_build_object(
        'id', 'event-member-race', 'eventId', 'event-race',
        'memberId', 'member-race',
        'paCapabilities', jsonb_build_object('main', false, 'sub', false)
      )),
      'eventMemberDays', '[]'::jsonb,
      'eventBands', '[]'::jsonb,
      'scheduleItems', '[]'::jsonb,
      'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb,
      'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    ),
    'masterReferences', jsonb_build_object(
      'memberIds', jsonb_build_array('member-race'),
      'bandIds', '[]'::jsonb
    )
  );
$$;

do $$
declare generation_value bigint;
begin
  select generation into generation_value
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000004';
  perform public.save_cloud_event_v2_validated(
    '00000000-0000-0000-0000-000000000085',
    '72000000-0000-0000-0000-000000000004',
    pg_temp.cloud_event_v2_race_snapshot('Race initial'),
    null,
    generation_value::text
  );
end;
$$;

select extensions.dblink_connect('event_v2_writer_a', :'test_db_url');
select extensions.dblink_connect('event_v2_writer_b', :'test_db_url');
select extensions.dblink_connect('event_v2_master_writer', :'test_db_url');
select extensions.dblink_exec(
  'event_v2_writer_a',
  'set application_name = ''event-v2-writer-a'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms'''
);
select extensions.dblink_exec(
  'event_v2_writer_b',
  'set application_name = ''event-v2-writer-b'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms'''
);
select extensions.dblink_exec(
  'event_v2_master_writer',
  'set application_name = ''event-v2-master-writer'';
   set statement_timeout = ''10s'';
   set lock_timeout = ''10s'';
   set deadlock_timeout = ''100ms'''
);

create or replace function pg_temp.assert_event_v2_lock_wait(
  p_application_name text,
  p_failure_message text
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
      where application_name = p_application_name
        and wait_event_type = 'Lock'
    ) into observed;
    exit when observed;
    perform pg_sleep(0.01);
  end loop;
  if not observed then
    raise exception '%', p_failure_message;
  end if;
end;
$$;

-- Two updates begin with the same Event revision and Workspace generation.
-- Writer B must wait for writer A and then fail its stale revision CAS.
select extensions.dblink_exec('event_v2_writer_a', 'begin');
select extensions.dblink_exec('event_v2_writer_a', $remote$
  do $save$
  declare
    source_snapshot jsonb;
    source_revision bigint;
    source_generation text;
  begin
    select event_snapshot, revision
      into source_snapshot, source_revision
    from public.cloud_events
    where workspace_id = '72000000-0000-0000-0000-000000000004'
      and event_id = 'event-race';
    select generation::text into source_generation
    from public.cloud_event_workspace_generations
    where workspace_id = '72000000-0000-0000-0000-000000000004';
    source_snapshot := jsonb_set(
      source_snapshot,
      '{eventState,events,0,name}',
      to_jsonb('Writer A'::text)
    );
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000085',
      '72000000-0000-0000-0000-000000000004',
      source_snapshot,
      source_revision,
      source_generation
    );
  end;
  $save$;
$remote$);

do $send_stale_writer$
begin
  if extensions.dblink_send_query('event_v2_writer_b', $remote$
    do $save$
    declare
      source_snapshot jsonb;
      source_revision bigint;
      source_generation text;
    begin
      select event_snapshot, revision
        into source_snapshot, source_revision
      from public.cloud_events
      where workspace_id = '72000000-0000-0000-0000-000000000004'
        and event_id = 'event-race';
      select generation::text into source_generation
      from public.cloud_event_workspace_generations
      where workspace_id = '72000000-0000-0000-0000-000000000004';
      source_snapshot := jsonb_set(
        source_snapshot,
        '{eventState,events,0,name}',
        to_jsonb('Writer B stale'::text)
      );
      begin
        perform public.save_cloud_event_v2_validated(
          '00000000-0000-0000-0000-000000000085',
          '72000000-0000-0000-0000-000000000004',
          source_snapshot,
          source_revision,
          source_generation
        );
        raise exception 'stale concurrent Event save succeeded';
      exception when sqlstate '40001' then
        null;
      end;
    end;
    $save$;
  $remote$) <> 1 then
    raise exception 'could not send concurrent stale Event save';
  end if;
end
$send_stale_writer$;
select pg_temp.assert_event_v2_lock_wait(
  'event-v2-writer-b',
  'second Event V2 writer did not wait for the Event CAS lock'
);
select extensions.dblink_exec('event_v2_writer_a', 'commit');
select * from extensions.dblink_get_result('event_v2_writer_b') as result(status text);
do $drain_stale_writer$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('event_v2_writer_b') as result(status text);
  if remaining_results <> 0 then
    raise exception 'stale Event writer left a trailing async result';
  end if;
end
$drain_stale_writer$;

do $$
begin
  if (select revision from public.cloud_events
      where workspace_id = '72000000-0000-0000-0000-000000000004'
        and event_id = 'event-race') <> 2
    or (select event_name from public.cloud_events
      where workspace_id = '72000000-0000-0000-0000-000000000004'
        and event_id = 'event-race') <> 'Writer A' then
    raise exception 'Event revision CAS did not preserve the winning update';
  end if;
end;
$$;

-- V2 save locks referenced Member rows before generation. A concurrent Master
-- update must wait, then commit afterward without deadlock or mixed closure.
select extensions.dblink_exec('event_v2_writer_a', 'begin');
select extensions.dblink_exec('event_v2_writer_a', $remote$
  do $save$
  declare
    source_snapshot jsonb;
    source_revision bigint;
    source_generation text;
  begin
    select event_snapshot, revision
      into source_snapshot, source_revision
    from public.cloud_events
    where workspace_id = '72000000-0000-0000-0000-000000000004'
      and event_id = 'event-race';
    select generation::text into source_generation
    from public.cloud_event_workspace_generations
    where workspace_id = '72000000-0000-0000-0000-000000000004';
    source_snapshot := jsonb_set(
      source_snapshot,
      '{eventState,events,0,name}',
      to_jsonb('Event before Master'::text)
    );
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000085',
      '72000000-0000-0000-0000-000000000004',
      source_snapshot,
      source_revision,
      source_generation
    );
  end;
  $save$;
$remote$);

do $send_master_update$
begin
  if extensions.dblink_send_query('event_v2_master_writer', $remote$
    select public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000085',
      '72000000-0000-0000-0000-000000000004',
      'update',
      'member',
      '{"id":"member-race","realName":"Race Member Updated","active":true}'::jsonb,
      1
    );
  $remote$) <> 1 then
    raise exception 'could not send concurrent Master update';
  end if;
end
$send_master_update$;
select pg_temp.assert_event_v2_lock_wait(
  'event-v2-master-writer',
  'Master update did not wait for Snapshot V2 referenced-Member lock'
);
select extensions.dblink_exec('event_v2_writer_a', 'commit');
select * from extensions.dblink_get_result('event_v2_master_writer')
  as result(value jsonb);
do $drain_master_update$
declare remaining_results bigint;
begin
  select count(*) into remaining_results
  from extensions.dblink_get_result('event_v2_master_writer') as result(value jsonb);
  if remaining_results <> 0 then
    raise exception 'Master update left a trailing async result';
  end if;
end
$drain_master_update$;

do $$
begin
  if (select revision from public.cloud_events
      where workspace_id = '72000000-0000-0000-0000-000000000004'
        and event_id = 'event-race') <> 3
    or (select revision from public.workspace_master_members
      where workspace_id = '72000000-0000-0000-0000-000000000004'
        and member_id = 'member-race') <> 2
    or (select real_name from public.workspace_master_members
      where workspace_id = '72000000-0000-0000-0000-000000000004'
        and member_id = 'member-race') <> 'Race Member Updated' then
    raise exception 'Event/Master serialization did not preserve both commits';
  end if;
end;
$$;

select extensions.dblink_disconnect('event_v2_writer_a');
select extensions.dblink_disconnect('event_v2_writer_b');
select extensions.dblink_disconnect('event_v2_master_writer');

delete from public.workspaces where id =
  '72000000-0000-0000-0000-000000000004'::uuid;
delete from auth.users where id =
  '00000000-0000-0000-0000-000000000085'::uuid;
