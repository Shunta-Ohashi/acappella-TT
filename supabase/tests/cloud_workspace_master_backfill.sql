\set ON_ERROR_STOP on

-- Run only against a disposable database with all repository migrations.
-- Every fixture and successful backfill is rolled back at the end.
begin;

create or replace function pg_temp.backfill_snapshot(event_id text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', event_id,
        'name', 'Backfill Event',
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1,
          'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5)
      )),
      'members', jsonb_build_array(
        jsonb_build_object('id', 'member-a', 'realName', 'Alice', 'active', true),
        jsonb_build_object('id', 'member-b', 'realName', 'Bob', 'active', true)
      ),
      'bands', jsonb_build_array(jsonb_build_object(
        'id', 'band-a',
        'name', 'Alpha',
        'defaultMemberIds', jsonb_build_array('member-b', 'member-a'),
        'active', true
      )),
      'eventDays', jsonb_build_array(jsonb_build_object(
        'id', 'day-a', 'eventId', event_id, 'date', '2026-10-13', 'order', 0
      )),
      'stages', '[]'::jsonb,
      'sections', '[]'::jsonb,
      'eventMembers', jsonb_build_array(jsonb_build_object(
        'id', 'event-member-a',
        'eventId', event_id,
        'memberId', 'member-a',
        'paCapabilities', jsonb_build_object('main', true, 'sub', false)
      )),
      'eventMemberDays', '[]'::jsonb,
      'eventBands', jsonb_build_array(jsonb_build_object(
        'id', 'event-band-a',
        'eventId', event_id,
        'eventDayId', 'day-a',
        'bandId', 'band-a',
        'name', 'Alpha live',
        'memberIds', jsonb_build_array('member-a'),
        'durationMinutes', 5
      )),
      'scheduleItems', '[]'::jsonb,
      'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb,
      'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    )
  )
$$;

create or replace function pg_temp.backfill_plan(
  workspace_id uuid,
  event_id text,
  source_generation bigint,
  event_revision bigint default 1
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'version', 1,
    'workspaceId', workspace_id,
    'sourceGeneration', source_generation::text,
    'sourceEvents', jsonb_build_array(jsonb_build_object(
      'eventId', event_id,
      'revision', event_revision,
      'snapshotFingerprint', pg_catalog.encode(
        extensions.digest(pg_temp.backfill_snapshot(event_id)::text, 'sha256'),
        'hex'
      )
    )),
    'members', jsonb_build_array(
      jsonb_build_object('id', 'member-a', 'realName', 'Alice', 'active', true),
      jsonb_build_object('id', 'member-b', 'realName', 'Bob', 'active', true)
    ),
    'bands', jsonb_build_array(jsonb_build_object(
      'id', 'band-a',
      'name', 'Alpha',
      'defaultMemberIds', jsonb_build_array('member-b', 'member-a'),
      'active', true
    )),
    'bandMembers', jsonb_build_array(
      jsonb_build_object('bandId', 'band-a', 'memberId', 'member-b', 'position', 0),
      jsonb_build_object('bandId', 'band-a', 'memberId', 'member-a', 'position', 1)
    ),
    'eventMemberReferences', jsonb_build_array(
      jsonb_build_object('eventId', event_id, 'memberId', 'member-a'),
      jsonb_build_object('eventId', event_id, 'memberId', 'member-b')
    ),
    'eventBandReferences', jsonb_build_array(
      jsonb_build_object('eventId', event_id, 'bandId', 'band-a')
    )
  )
$$;

insert into public.workspaces (id, name) values
  ('71000000-0000-0000-0000-000000000001', 'Master backfill success'),
  ('71000000-0000-0000-0000-000000000002', 'Master backfill stale');

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values
  (
    '71000000-0000-0000-0000-000000000001',
    'event-a', 'Backfill Event', pg_temp.backfill_snapshot('event-a')
  ),
  (
    '71000000-0000-0000-0000-000000000002',
    'event-b', 'Backfill Event', pg_temp.backfill_snapshot('event-b')
  );

do $$
declare
  v_workspace_id constant uuid := '71000000-0000-0000-0000-000000000001';
  v_source_generation bigint;
  v_preview jsonb;
  v_applied jsonb;
  v_repeated jsonb;
  v_source_snapshot jsonb;
  v_invalid_plan jsonb;
begin
  select g.generation into v_source_generation
  from public.cloud_event_workspace_generations as g
  where g.workspace_id = v_workspace_id;
  select e.event_snapshot into v_source_snapshot
  from public.cloud_events as e
  where e.workspace_id = v_workspace_id and e.event_id = 'event-a';

  v_invalid_plan := jsonb_set(
    pg_temp.backfill_plan(v_workspace_id, 'event-a', v_source_generation),
    '{eventMemberReferences}',
    '[{"eventId":"event-a","memberId":"member-a"}]'::jsonb
  );
  begin
    perform public.backfill_workspace_masters_validated(
      v_workspace_id,
      v_source_generation::text,
      repeat('a', 64),
      v_invalid_plan,
      true
    );
    raise exception 'incomplete transitive Member references were accepted';
  exception when SQLSTATE '22023' then
    null;
  end;
  if exists (select 1 from public.workspace_master_members as m
      where m.workspace_id = v_workspace_id)
    or (select g.generation from public.cloud_event_workspace_generations as g
        where g.workspace_id = v_workspace_id)
        <> v_source_generation then
    raise exception 'invalid reference plan changed DB state or generation';
  end if;

  v_preview := public.backfill_workspace_masters_validated(
    v_workspace_id,
    v_source_generation::text,
    repeat('a', 64),
    pg_temp.backfill_plan(v_workspace_id, 'event-a', v_source_generation),
    false
  );
  if v_preview ->> 'status' <> 'preview'
    or exists (select 1 from public.workspace_master_members as m
      where m.workspace_id = v_workspace_id) then
    raise exception 'dry-run changed normalized data';
  end if;

  v_applied := public.backfill_workspace_masters_validated(
    v_workspace_id,
    v_source_generation::text,
    repeat('a', 64),
    pg_temp.backfill_plan(v_workspace_id, 'event-a', v_source_generation),
    true
  );
  if v_applied ->> 'status' <> 'applied'
    or (select s.status from public.cloud_workspace_master_states as s
        where s.workspace_id = v_workspace_id) <> 'legacy'
    or (select count(*) from public.workspace_master_members as m
        where m.workspace_id = v_workspace_id) <> 2
    or (select count(*) from public.workspace_master_bands as b
        where b.workspace_id = v_workspace_id) <> 1
    or (select jsonb_agg(bm.member_id order by bm.position)
        from public.workspace_master_band_members as bm
        where bm.workspace_id = v_workspace_id
          and bm.band_id = 'band-a') <> '["member-b", "member-a"]'::jsonb
    or (select count(*) from public.cloud_event_member_references as mr
        where mr.workspace_id = v_workspace_id) <> 2
    or (select count(*) from public.cloud_event_band_references as br
        where br.workspace_id = v_workspace_id) <> 1
    or (select e.revision from public.cloud_events as e
        where e.workspace_id = v_workspace_id and e.event_id = 'event-a') <> 1
    or (select e.event_snapshot from public.cloud_events as e
        where e.workspace_id = v_workspace_id and e.event_id = 'event-a')
        is distinct from v_source_snapshot then
    raise exception 'backfill result violates the migration contract';
  end if;

  v_repeated := public.backfill_workspace_masters_validated(
    v_workspace_id,
    v_source_generation::text,
    repeat('a', 64),
    pg_temp.backfill_plan(v_workspace_id, 'event-a', v_source_generation),
    true
  );
  if v_repeated ->> 'status' <> 'already_applied' then
    raise exception 'identical completed plan was not idempotent';
  end if;
end;
$$;

do $$
declare
  v_workspace_id constant uuid := '71000000-0000-0000-0000-000000000002';
  v_source_generation bigint;
  v_before_generation bigint;
begin
  select g.generation into v_source_generation
  from public.cloud_event_workspace_generations as g
  where g.workspace_id = v_workspace_id;
  v_before_generation := v_source_generation;

  begin
    perform public.backfill_workspace_masters_validated(
      v_workspace_id,
      v_source_generation::text,
      repeat('b', 64),
      pg_temp.backfill_plan(v_workspace_id, 'event-b', v_source_generation, 99),
      true
    );
    raise exception 'stale Event revision was accepted';
  exception when SQLSTATE '40001' then
    null;
  end;

  if exists (select 1 from public.workspace_master_members as m
      where m.workspace_id = v_workspace_id)
    or exists (select 1 from public.cloud_workspace_master_backfills as bf
      where bf.workspace_id = v_workspace_id)
    or (select g.generation from public.cloud_event_workspace_generations as g
        where g.workspace_id = v_workspace_id)
        <> v_before_generation
    or (select s.status from public.cloud_workspace_master_states as s
        where s.workspace_id = v_workspace_id) <> 'legacy' then
    raise exception 'SQLSTATE 40001 failure changed DB state or Workspace Master status changed';
  end if;

  begin
    perform public.backfill_workspace_masters_validated(
      v_workspace_id, v_source_generation::text, repeat('b', 64), null, true
    );
    raise exception 'SQL NULL plan was accepted';
  exception when SQLSTATE '22023' then
    null;
  end;
end;
$$;

rollback;
