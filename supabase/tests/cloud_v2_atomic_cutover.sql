\set ON_ERROR_STOP on

-- Run only against a fresh disposable database with every repository
-- migration applied. All fixture DDL/data and the successful cutover roll back.
begin;

create or replace function pg_temp.atomic_cutover_v1_snapshot(event_id text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'members', jsonb_build_array(
        jsonb_build_object('id', 'member-a', 'realName', 'Alice', 'active', true),
        jsonb_build_object('id', 'member-b', 'realName', 'Bob', 'active', true)
      ),
      'bands', jsonb_build_array(jsonb_build_object(
        'id', 'band-a', 'name', 'Alpha',
        'defaultMemberIds', jsonb_build_array('member-b', 'member-a'),
        'active', true
      )),
      'events', jsonb_build_array(jsonb_build_object(
        'id', event_id, 'name', 'Atomic ' || event_id,
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1, 'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5, 10)
      )),
      'eventDays', jsonb_build_array(jsonb_build_object(
        'id', 'day-' || event_id, 'eventId', event_id,
        'date', '2026-10-15', 'order', 0
      )),
      'stages', jsonb_build_array(jsonb_build_object(
        'id', 'stage-' || event_id, 'eventDayId', 'day-' || event_id,
        'name', 'Main', 'order', 0, 'plannedStartTime', '10:00'
      )),
      'sections', jsonb_build_array(jsonb_build_object(
        'id', 'section-' || event_id, 'stageId', 'stage-' || event_id,
        'name', 'Part 1', 'order', 0,
        'plannedStartTime', '10:00', 'plannedEndTime', '12:00'
      )),
      'eventMembers', jsonb_build_array(jsonb_build_object(
        'id', 'event-member-' || event_id, 'eventId', event_id,
        'memberId', 'member-a',
        'paCapabilities', jsonb_build_object('main', true, 'sub', false)
      )),
      'eventMemberDays', '[]'::jsonb,
      'eventBands', jsonb_build_array(jsonb_build_object(
        'id', 'event-band-' || event_id, 'eventId', event_id,
        'eventDayId', 'day-' || event_id, 'bandId', 'band-a',
        'name', 'Alpha live', 'memberIds', jsonb_build_array('member-a'),
        'durationMinutes', 5
      )),
      'scheduleItems', jsonb_build_array(jsonb_build_object(
        'id', 'item-' || event_id, 'stageId', 'stage-' || event_id,
        'sectionId', 'section-' || event_id, 'kind', 'performance',
        'eventBandId', 'event-band-' || event_id, 'order', 0
      )),
      'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb,
      'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    )
  )
$$;

create or replace function pg_temp.atomic_cutover_backfill_plan(
  workspace_id uuid,
  source_generation bigint
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'version', 1,
    'workspaceId', workspace_id,
    'sourceGeneration', source_generation::text,
    'sourceEvents', (
      select jsonb_agg(jsonb_build_object(
        'eventId', event_id,
        'revision', 1,
        'snapshotFingerprint', pg_catalog.encode(
          extensions.digest(
            pg_temp.atomic_cutover_v1_snapshot(event_id)::text, 'sha256'
          ), 'hex'
        )
      ) order by event_id collate "C")
      from unnest(array['event-a', 'event-b']) as event_id
    ),
    'members', jsonb_build_array(
      jsonb_build_object('id', 'member-a', 'realName', 'Alice', 'active', true),
      jsonb_build_object('id', 'member-b', 'realName', 'Bob', 'active', true)
    ),
    'bands', jsonb_build_array(jsonb_build_object(
      'id', 'band-a', 'name', 'Alpha',
      'defaultMemberIds', jsonb_build_array('member-b', 'member-a'),
      'active', true
    )),
    'bandMembers', jsonb_build_array(
      jsonb_build_object(
        'bandId', 'band-a', 'memberId', 'member-b', 'position', 0
      ),
      jsonb_build_object(
        'bandId', 'band-a', 'memberId', 'member-a', 'position', 1
      )
    ),
    'eventMemberReferences', (
      select jsonb_agg(jsonb_build_object(
        'eventId', event_id, 'memberId', member_id
      ) order by event_id collate "C", member_id collate "C")
      from unnest(array['event-a', 'event-b']) as event_id
      cross join unnest(array['member-a', 'member-b']) as member_id
    ),
    'eventBandReferences', (
      select jsonb_agg(jsonb_build_object(
        'eventId', event_id, 'bandId', 'band-a'
      ) order by event_id collate "C")
      from unnest(array['event-a', 'event-b']) as event_id
    )
  )
$$;

create or replace function pg_temp.atomic_cutover_v2_snapshot(event_id text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 2,
    'eventState',
      (pg_temp.atomic_cutover_v1_snapshot(event_id) -> 'appState')
        - 'members' - 'bands',
    'masterReferences', jsonb_build_object(
      'memberIds', jsonb_build_array('member-a', 'member-b'),
      'bandIds', jsonb_build_array('band-a')
    )
  )
$$;

create or replace function pg_temp.atomic_cutover_plan(
  workspace_id uuid,
  expected_generation bigint
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'version', 1,
    'workspaceId', workspace_id,
    'expectedGeneration', expected_generation::text,
    'expectedBackfillPlanFingerprint', repeat('c', 64),
    'events', (
      select jsonb_agg(jsonb_build_object(
        'eventId', event_id,
        'expectedRevision', 1,
        'expectedSnapshotFingerprint', pg_catalog.encode(
          extensions.digest(
            pg_temp.atomic_cutover_v1_snapshot(event_id)::text, 'sha256'
          ), 'hex'
        ),
        'snapshotV2', pg_temp.atomic_cutover_v2_snapshot(event_id)
      ) order by event_id collate "C")
      from unnest(array['event-a', 'event-b']) as event_id
    )
  )
$$;

insert into public.workspaces (id, name) values
  ('79000000-0000-4000-8000-000000000001', 'Atomic cutover fixture'),
  ('79000000-0000-4000-8000-000000000002', 'Atomic cutover isolation'),
  ('79000000-0000-4000-8000-000000000003', 'Atomic empty fixture');

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
)
select '79000000-0000-4000-8000-000000000001', event_id,
  'Atomic ' || event_id, pg_temp.atomic_cutover_v1_snapshot(event_id)
from unnest(array['event-a', 'event-b']) as event_id;

do $apply_backfill$
declare
  v_workspace_id constant uuid := '79000000-0000-4000-8000-000000000001';
  v_generation bigint;
begin
  select generation into strict v_generation
  from public.cloud_event_workspace_generations
  where workspace_id = v_workspace_id;

  perform public.backfill_workspace_masters_validated(
    v_workspace_id,
    v_generation::text,
    repeat('c', 64),
    pg_temp.atomic_cutover_backfill_plan(v_workspace_id, v_generation),
    true
  );
end
$apply_backfill$;

-- Browser roles must fail at the EXECUTE boundary, not inside the function.
do $privilege_contract$
declare
  function_oid oid := to_regprocedure(
    'public.cutover_cloud_v2_validated(uuid,text,text,jsonb)'
  );
begin
  if function_oid is null
    or has_function_privilege('authenticated', function_oid, 'EXECUTE')
    or has_function_privilege('anon', function_oid, 'EXECUTE')
    or not has_function_privilege('service_role', function_oid, 'EXECUTE') then
    raise exception 'Atomic cutover backend-only EXECUTE contract is invalid';
  end if;
end
$privilege_contract$;

set local role authenticated;
do $authenticated_cannot_execute$
begin
  begin
    perform public.cutover_cloud_v2_validated(
      '79000000-0000-4000-8000-000000000001'::uuid,
      '0', repeat('0', 64), '{}'::jsonb
    );
    raise exception 'authenticated executed the backend-only atomic cutover RPC';
  exception when insufficient_privilege then null;
  end;
end
$authenticated_cannot_execute$;
reset role;

-- All CAS and full-set failures must leave every table unchanged.
do $fail_closed_inputs$
declare
  v_workspace_id constant uuid := '79000000-0000-4000-8000-000000000001';
  v_generation bigint;
  v_plan jsonb;
  v_before_events jsonb;
  v_count_field text;
begin
  select generation into strict v_generation
  from public.cloud_event_workspace_generations
  where workspace_id = v_workspace_id;
  select jsonb_agg(to_jsonb(e) order by e.event_id collate "C") into v_before_events
  from public.cloud_events as e where e.workspace_id = v_workspace_id;
  v_plan := pg_temp.atomic_cutover_plan(v_workspace_id, v_generation);

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, (v_generation - 1)::text, repeat('c', 64),
      jsonb_set(v_plan, '{expectedGeneration}',
        to_jsonb((v_generation - 1)::text))
    );
    raise exception 'stale generation was accepted';
  exception when SQLSTATE '40001' then null;
  end;

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      jsonb_set(v_plan, '{events,0,expectedRevision}', '99'::jsonb)
    );
    raise exception 'stale Event revision was accepted';
  exception when SQLSTATE '40001' then null;
  end;

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      jsonb_set(v_plan, '{events,0,expectedSnapshotFingerprint}',
        to_jsonb(repeat('e', 64)))
    );
    raise exception 'stale Event Snapshot fingerprint was accepted';
  exception when SQLSTATE '40001' then null;
  end;

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      jsonb_set(v_plan, '{events}',
        (v_plan -> 'events') || jsonb_build_array(v_plan #> '{events,0}'))
    );
    raise exception 'duplicate Event ID was accepted';
  exception when SQLSTATE '22023' then null;
  end;

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      jsonb_set(v_plan, '{events}', (v_plan -> 'events') - 1)
    );
    raise exception 'partial Event set was accepted';
  exception when SQLSTATE '40001' then null;
  end;

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('d', 64),
      jsonb_set(v_plan, '{expectedBackfillPlanFingerprint}',
        to_jsonb(repeat('d', 64)))
    );
    raise exception 'wrong backfill fingerprint was accepted';
  exception when SQLSTATE '55000' then null;
  end;

  foreach v_count_field in array array[
    'event_count', 'member_count', 'band_count',
    'band_member_relation_count', 'event_member_reference_count',
    'event_band_reference_count'
  ] loop
    begin
      execute format(
        'update public.cloud_workspace_master_backfills '
        'set %1$I = %1$I + 1 where workspace_id = $1',
        v_count_field
      ) using v_workspace_id;
      perform public.cutover_cloud_v2_validated(
        v_workspace_id, v_generation::text, repeat('c', 64), v_plan
      );
      raise exception 'incorrect completed-backfill % was accepted',
        v_count_field;
    exception when SQLSTATE '55000' then null;
    end;
  end loop;

  if (select status from public.cloud_workspace_master_states
        where workspace_id = v_workspace_id) is distinct from 'legacy'
    or (select generation from public.cloud_event_workspace_generations
        where workspace_id = v_workspace_id) is distinct from v_generation
    or (select jsonb_agg(to_jsonb(e) order by e.event_id collate "C")
        from public.cloud_events as e where e.workspace_id = v_workspace_id)
      is distinct from v_before_events then
    raise exception 'Rejected atomic cutover changed persistent state';
  end if;
end
$fail_closed_inputs$;

-- Evidence is re-derived from locked database rows. Each nested block rolls its
-- deliberate corruption back when the real RPC rejects it.
do $fail_closed_evidence$
declare
  v_workspace_id constant uuid := '79000000-0000-4000-8000-000000000001';
  v_generation bigint;
  v_revision bigint;
  v_fingerprint text;
  v_plan jsonb;
begin
  begin
    update public.workspace_master_members
      set real_name = 'Unexpected member body'
      where workspace_id = v_workspace_id and member_id = 'member-a';
    select generation into strict v_generation
      from public.cloud_event_workspace_generations
      where workspace_id = v_workspace_id;
    update public.cloud_workspace_master_backfills
      set result_generation = v_generation where workspace_id = v_workspace_id;
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      pg_temp.atomic_cutover_plan(v_workspace_id, v_generation)
    );
    raise exception 'mismatched normalized Member was accepted';
  exception when SQLSTATE '55000' then null;
  end;

  begin
    update public.workspace_master_band_members set position = 2
      where workspace_id = v_workspace_id and band_id = 'band-a'
        and member_id = 'member-b';
    update public.workspace_master_band_members set position = 0
      where workspace_id = v_workspace_id and band_id = 'band-a'
        and member_id = 'member-a';
    update public.workspace_master_band_members set position = 1
      where workspace_id = v_workspace_id and band_id = 'band-a'
        and member_id = 'member-b';
    select generation into strict v_generation
      from public.cloud_event_workspace_generations
      where workspace_id = v_workspace_id;
    update public.cloud_workspace_master_backfills
      set result_generation = v_generation where workspace_id = v_workspace_id;
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      pg_temp.atomic_cutover_plan(v_workspace_id, v_generation)
    );
    raise exception 'mismatched ordered Band members were accepted';
  exception when SQLSTATE '55000' then null;
  end;

  begin
    delete from public.cloud_event_member_references
      where workspace_id = v_workspace_id and event_id = 'event-a'
        and member_id = 'member-b';
    update public.cloud_workspace_master_backfills
      set event_member_reference_count = event_member_reference_count - 1
      where workspace_id = v_workspace_id;
    select generation into strict v_generation
      from public.cloud_event_workspace_generations
      where workspace_id = v_workspace_id;
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      pg_temp.atomic_cutover_plan(v_workspace_id, v_generation)
    );
    raise exception 'mismatched Event-Member reference combination was accepted';
  exception when SQLSTATE '55000' then null;
  end;

  begin
    update public.cloud_events
      set event_snapshot = jsonb_set(
        event_snapshot, '{appState,eventDays,0,id}',
        to_jsonb('day-event-a'::text)
      )
      where workspace_id = v_workspace_id and event_id = 'event-b';
    select generation into strict v_generation
      from public.cloud_event_workspace_generations
      where workspace_id = v_workspace_id;
    select revision,
      encode(extensions.digest(event_snapshot::text, 'sha256'), 'hex')
      into strict v_revision, v_fingerprint
      from public.cloud_events
      where workspace_id = v_workspace_id and event_id = 'event-b';
    update public.cloud_workspace_master_backfills
      set result_generation = v_generation where workspace_id = v_workspace_id;
    v_plan := pg_temp.atomic_cutover_plan(v_workspace_id, v_generation);
    v_plan := jsonb_set(v_plan, '{events,1,expectedRevision}',
      to_jsonb(v_revision));
    v_plan := jsonb_set(v_plan, '{events,1,expectedSnapshotFingerprint}',
      to_jsonb(v_fingerprint));
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64), v_plan
    );
    raise exception 'cross-Event duplicate Event-owned ID was accepted';
  exception when SQLSTATE '55000' then null;
  end;

  begin
    update public.cloud_workspace_master_states set status = 'conflict'
      where workspace_id = v_workspace_id;
    select generation into strict v_generation
      from public.cloud_event_workspace_generations
      where workspace_id = v_workspace_id;
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      pg_temp.atomic_cutover_plan(v_workspace_id, v_generation)
    );
    raise exception 'conflict Workspace was accepted';
  exception when SQLSTATE '55000' then null;
  end;
end
$fail_closed_evidence$;

-- Test-only failure injection proves that an error after event-a is updated
-- rolls back event-a's Snapshot/revision and its generation advance as well.
create function public.cloud_v2_atomic_cutover_test_failure()
returns trigger
language plpgsql
as $$
begin
  if current_setting('acappella_tt.fail_atomic_cutover', true) = 'on'
    and old.workspace_id = '79000000-0000-4000-8000-000000000001'::uuid
    and old.event_id = 'event-b'
    and new.event_snapshot -> 'version' = '2'::jsonb then
    raise exception 'test-only second Event failure' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function public.cloud_v2_atomic_cutover_test_failure()
  from public, anon, authenticated, service_role;

create trigger cloud_v2_atomic_cutover_test_failure
  before update on public.cloud_events
  for each row execute function public.cloud_v2_atomic_cutover_test_failure();

do $atomic_rollback$
declare
  v_workspace_id constant uuid := '79000000-0000-4000-8000-000000000001';
  v_generation bigint;
  v_before_events jsonb;
begin
  select generation into strict v_generation
  from public.cloud_event_workspace_generations
  where workspace_id = v_workspace_id;
  select jsonb_agg(to_jsonb(e) order by e.event_id collate "C") into v_before_events
  from public.cloud_events as e where e.workspace_id = v_workspace_id;
  perform set_config('acappella_tt.fail_atomic_cutover', 'on', true);

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id, v_generation::text, repeat('c', 64),
      pg_temp.atomic_cutover_plan(v_workspace_id, v_generation)
    );
    raise exception 'test-only mid-cutover failure was not raised';
  exception when SQLSTATE 'P0001' then null;
  end;

  if (select status from public.cloud_workspace_master_states
        where workspace_id = v_workspace_id) is distinct from 'legacy'
    or (select generation from public.cloud_event_workspace_generations
        where workspace_id = v_workspace_id) is distinct from v_generation
    or (select jsonb_agg(to_jsonb(e) order by e.event_id collate "C")
        from public.cloud_events as e where e.workspace_id = v_workspace_id)
      is distinct from v_before_events then
    raise exception 'Mid-cutover error did not roll back the complete transaction';
  end if;
  perform set_config('acappella_tt.fail_atomic_cutover', 'off', true);
end
$atomic_rollback$;

drop trigger cloud_v2_atomic_cutover_test_failure on public.cloud_events;
drop function public.cloud_v2_atomic_cutover_test_failure();

do $successful_cutover$
declare
  v_workspace_id constant uuid := '79000000-0000-4000-8000-000000000001';
  v_generation bigint;
  v_result jsonb;
  v_backfill_before jsonb;
  v_master_evidence_before jsonb;
begin
  select generation into strict v_generation
  from public.cloud_event_workspace_generations
  where workspace_id = v_workspace_id;
  select to_jsonb(bf) into strict v_backfill_before
  from public.cloud_workspace_master_backfills as bf
  where bf.workspace_id = v_workspace_id;
  select jsonb_build_object(
    'members', (select jsonb_agg(to_jsonb(m) order by m.member_id collate "C")
      from public.workspace_master_members as m
      where m.workspace_id = v_workspace_id),
    'bands', (select jsonb_agg(to_jsonb(b) order by b.band_id collate "C")
      from public.workspace_master_bands as b
      where b.workspace_id = v_workspace_id),
    'bandMembers', (select jsonb_agg(to_jsonb(bm)
        order by bm.band_id collate "C", bm.position)
      from public.workspace_master_band_members as bm
      where bm.workspace_id = v_workspace_id),
    'memberReferences', (select jsonb_agg(to_jsonb(mr)
        order by mr.event_id collate "C", mr.member_id collate "C")
      from public.cloud_event_member_references as mr
      where mr.workspace_id = v_workspace_id),
    'bandReferences', (select jsonb_agg(to_jsonb(br)
        order by br.event_id collate "C", br.band_id collate "C")
      from public.cloud_event_band_references as br
      where br.workspace_id = v_workspace_id)
  ) into v_master_evidence_before;

  v_result := public.cutover_cloud_v2_validated(
    v_workspace_id, v_generation::text, repeat('c', 64),
    pg_temp.atomic_cutover_plan(v_workspace_id, v_generation)
  );

  if v_result ->> 'status' is distinct from 'ok'
    or (v_result ->> 'sourceGeneration')::bigint is distinct from v_generation
    or v_result ->> 'resultGeneration' is distinct from (
      select generation::text from public.cloud_event_workspace_generations
      where workspace_id = v_workspace_id
    )
    or (v_result ->> 'eventCount')::integer is distinct from 2
    or (v_result ->> 'convertedEventCount')::integer is distinct from 2
    or (select status from public.cloud_workspace_master_states
        where workspace_id = v_workspace_id) is distinct from 'ready'
    or exists (select 1 from public.cloud_events
        where workspace_id = v_workspace_id
          and (event_snapshot -> 'version' is distinct from '2'::jsonb
            or event_snapshot is distinct from
              pg_temp.atomic_cutover_snapshot_v2(event_id)
            or revision is distinct from 2))
    or (select to_jsonb(bf) from public.cloud_workspace_master_backfills as bf
        where bf.workspace_id = v_workspace_id) is distinct from v_backfill_before
    or (select jsonb_build_object(
        'members', (select jsonb_agg(to_jsonb(m) order by m.member_id collate "C")
          from public.workspace_master_members as m
          where m.workspace_id = v_workspace_id),
        'bands', (select jsonb_agg(to_jsonb(b) order by b.band_id collate "C")
          from public.workspace_master_bands as b
          where b.workspace_id = v_workspace_id),
        'bandMembers', (select jsonb_agg(to_jsonb(bm)
            order by bm.band_id collate "C", bm.position)
          from public.workspace_master_band_members as bm
          where bm.workspace_id = v_workspace_id),
        'memberReferences', (select jsonb_agg(to_jsonb(mr)
            order by mr.event_id collate "C", mr.member_id collate "C")
          from public.cloud_event_member_references as mr
          where mr.workspace_id = v_workspace_id),
        'bandReferences', (select jsonb_agg(to_jsonb(br)
            order by br.event_id collate "C", br.band_id collate "C")
          from public.cloud_event_band_references as br
          where br.workspace_id = v_workspace_id)
      )) is distinct from v_master_evidence_before then
    raise exception 'Successful atomic cutover violates its result contract';
  end if;

  begin
    update public.cloud_events
      set event_snapshot = pg_temp.atomic_cutover_v1_snapshot('event-a')
      where workspace_id = v_workspace_id and event_id = 'event-a';
    raise exception 'ready Workspace accepted a resumed Snapshot V1 writer';
  exception when SQLSTATE '55000' then null;
  end;

  begin
    perform public.cutover_cloud_v2_validated(
      v_workspace_id,
      (select generation::text from public.cloud_event_workspace_generations
        where workspace_id = v_workspace_id),
      repeat('c', 64),
      pg_temp.atomic_cutover_plan(
        v_workspace_id,
        (select generation from public.cloud_event_workspace_generations
          where workspace_id = v_workspace_id)
      )
    );
    raise exception 'ready Workspace accepted a repeated cutover';
  exception when SQLSTATE '55000' then null;
  end;

  if exists (select 1 from public.cloud_events
      where workspace_id = '79000000-0000-4000-8000-000000000002')
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '79000000-0000-4000-8000-000000000002')
      is distinct from 'legacy' then
    raise exception 'Atomic cutover changed another Workspace';
  end if;
end
$successful_cutover$;

-- Empty Workspaces are supported only with an explicit completed-backfill
-- record; absence of Events does not waive the same evidence contract.
do $empty_workspace_cutover$
declare
  v_workspace_id constant uuid := '79000000-0000-4000-8000-000000000003';
  v_generation bigint;
  v_backfill_plan jsonb;
  v_cutover_plan jsonb;
  v_result jsonb;
begin
  select generation into strict v_generation
  from public.cloud_event_workspace_generations
  where workspace_id = v_workspace_id;
  v_backfill_plan := jsonb_build_object(
    'version', 1, 'workspaceId', v_workspace_id,
    'sourceGeneration', v_generation::text,
    'sourceEvents', '[]'::jsonb, 'members', '[]'::jsonb,
    'bands', '[]'::jsonb, 'bandMembers', '[]'::jsonb,
    'eventMemberReferences', '[]'::jsonb,
    'eventBandReferences', '[]'::jsonb
  );
  perform public.backfill_workspace_masters_validated(
    v_workspace_id, v_generation::text, repeat('f', 64),
    v_backfill_plan, true
  );
  select generation into strict v_generation
  from public.cloud_event_workspace_generations
  where workspace_id = v_workspace_id;
  v_cutover_plan := jsonb_build_object(
    'version', 1, 'workspaceId', v_workspace_id,
    'expectedGeneration', v_generation::text,
    'expectedBackfillPlanFingerprint', repeat('f', 64),
    'events', '[]'::jsonb
  );
  v_result := public.cutover_cloud_v2_validated(
    v_workspace_id, v_generation::text, repeat('f', 64), v_cutover_plan
  );
  if v_result ->> 'status' is distinct from 'ok'
    or (v_result ->> 'eventCount')::integer is distinct from 0
    or (select status from public.cloud_workspace_master_states
        where workspace_id = v_workspace_id) is distinct from 'ready'
    or exists (select 1 from public.cloud_events
        where workspace_id = v_workspace_id) then
    raise exception 'Empty Workspace atomic cutover violated its evidence contract';
  end if;
end
$empty_workspace_cutover$;

rollback;
