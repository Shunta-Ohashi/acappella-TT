\set ON_ERROR_STOP on

-- Explicit recovery for an interrupted concurrency fixture. Run only after
-- confirming that this is the disposable inspection database. The checks
-- refuse cleanup if the dedicated Workspace contains anything the fixture
-- itself does not create.
begin;

-- Phase 2 must observe rows committed while Phase 1 was acquiring locks.
-- Do not inherit a caller's REPEATABLE READ snapshot for this recovery tool.
set transaction isolation level read committed;

-- Test-only synchronization hook. Normal cleanup leaves this empty. The
-- dedicated process-level concurrency runner passes an advisory-lock key so
-- it can prove that this exact script has acquired every row lock before
-- starting competing writers.
set local acappella_tt.cleanup_test_gate_key = '';
\if :{?cleanup_test_gate_key}
set local acappella_tt.cleanup_test_gate_key = :'cleanup_test_gate_key';
\endif

do $$
declare
  fixture_workspace_id constant uuid :=
    '79500000-0000-4000-8000-000000000001';
  fixture_workspace_name constant text :=
    'Cutover inspection concurrency';
  expected_before_snapshot jsonb;
  expected_after_snapshot jsonb;
  fixture_event_count bigint;
  fixture_event_id text;
  fixture_event_name text;
  fixture_event_snapshot jsonb;
  fixture_event_revision bigint;
  fixture_generation bigint;
  fixture_master_status text;
  fixture_workspace_locked boolean := false;
  cleanup_test_gate_key text := nullif(
    current_setting('acappella_tt.cleanup_test_gate_key', true),
    ''
  );
begin
  expected_before_snapshot := jsonb_build_object(
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
  );
  expected_after_snapshot := jsonb_set(
    expected_before_snapshot,
    '{appState,events,0,name}',
    '"After inspection race"'::jsonb
  );

  -- Freeze every writable edge of this one fixture before inspecting it.
  -- NOWAIT is deliberate: if a supported writer already owns an earlier lock,
  -- cleanup fails closed instead of waiting while holding a different lock and
  -- risking a deadlock. If cleanup wins, these row locks remain held through
  -- the parent DELETE and COMMIT, so an existing row cannot change after it is
  -- validated.
  --
  -- Phase 1 takes membership, state, Event, and Master locks in the same
  -- leading order used by the mutation/backfill RPCs. Lock the parent
  -- Workspace only after those existing child rows: its FOR UPDATE lock
  -- conflicts with the KEY SHARE lock required by a new FK child (Event,
  -- membership, Master, state, generation, or backfill).
  --
  -- A child INSERT may commit between the Phase 1 scan and acquisition of the
  -- parent lock. Phase 2 therefore repeats every child scan after the parent is
  -- frozen. That second pass locks such a phantom before validation; without
  -- it, a newly committed Event could still be updated after it was observed.
  -- New relation/reference rows are also frozen explicitly, in addition to
  -- being blocked by the locked Event/Master rows that their composite FKs
  -- reference. Generation is last, matching writers after their data rows.
  begin
    perform 1
    from public.workspace_members
    where workspace_members.workspace_id = fixture_workspace_id
    order by workspace_members.user_id
    for update nowait;

    perform 1
    from public.cloud_workspace_master_states
    where cloud_workspace_master_states.workspace_id = fixture_workspace_id
    for update nowait;

    perform 1
    from public.cloud_events
    where cloud_events.workspace_id = fixture_workspace_id
    order by cloud_events.event_id collate "C"
    for update nowait;

    perform 1
    from public.workspace_master_members
    where workspace_master_members.workspace_id = fixture_workspace_id
    order by workspace_master_members.member_id collate "C"
    for update nowait;

    perform 1
    from public.workspace_master_bands
    where workspace_master_bands.workspace_id = fixture_workspace_id
    order by workspace_master_bands.band_id collate "C"
    for update nowait;

    perform 1
    from public.workspace_master_band_members
    where workspace_master_band_members.workspace_id = fixture_workspace_id
    order by workspace_master_band_members.band_id collate "C",
      workspace_master_band_members.position,
      workspace_master_band_members.member_id collate "C"
    for update nowait;

    perform 1
    from public.cloud_event_member_references
    where cloud_event_member_references.workspace_id = fixture_workspace_id
    order by cloud_event_member_references.event_id collate "C",
      cloud_event_member_references.member_id collate "C"
    for update nowait;

    perform 1
    from public.cloud_event_band_references
    where cloud_event_band_references.workspace_id = fixture_workspace_id
    order by cloud_event_band_references.event_id collate "C",
      cloud_event_band_references.band_id collate "C"
    for update nowait;

    perform 1
    from public.cloud_workspace_master_backfills
    where cloud_workspace_master_backfills.workspace_id = fixture_workspace_id
    for update nowait;

    perform 1
    from public.workspaces
    where workspaces.id = fixture_workspace_id
    for update nowait;
    fixture_workspace_locked := found;

    -- Phase 2: close the Phase 1-to-parent-lock insertion window. Keep the
    -- ordering identical to Phase 1 so multiple cleanup attempts cannot invert
    -- their row-lock order.
    perform 1
    from public.workspace_members
    where workspace_members.workspace_id = fixture_workspace_id
    order by workspace_members.user_id
    for update nowait;

    perform 1
    from public.cloud_workspace_master_states
    where cloud_workspace_master_states.workspace_id = fixture_workspace_id
    for update nowait;

    perform 1
    from public.cloud_events
    where cloud_events.workspace_id = fixture_workspace_id
    order by cloud_events.event_id collate "C"
    for update nowait;

    perform 1
    from public.workspace_master_members
    where workspace_master_members.workspace_id = fixture_workspace_id
    order by workspace_master_members.member_id collate "C"
    for update nowait;

    perform 1
    from public.workspace_master_bands
    where workspace_master_bands.workspace_id = fixture_workspace_id
    order by workspace_master_bands.band_id collate "C"
    for update nowait;

    perform 1
    from public.workspace_master_band_members
    where workspace_master_band_members.workspace_id = fixture_workspace_id
    order by workspace_master_band_members.band_id collate "C",
      workspace_master_band_members.position,
      workspace_master_band_members.member_id collate "C"
    for update nowait;

    perform 1
    from public.cloud_event_member_references
    where cloud_event_member_references.workspace_id = fixture_workspace_id
    order by cloud_event_member_references.event_id collate "C",
      cloud_event_member_references.member_id collate "C"
    for update nowait;

    perform 1
    from public.cloud_event_band_references
    where cloud_event_band_references.workspace_id = fixture_workspace_id
    order by cloud_event_band_references.event_id collate "C",
      cloud_event_band_references.band_id collate "C"
    for update nowait;

    perform 1
    from public.cloud_workspace_master_backfills
    where cloud_workspace_master_backfills.workspace_id = fixture_workspace_id
    for update nowait;

    perform 1
    from public.cloud_event_workspace_generations
    where cloud_event_workspace_generations.workspace_id = fixture_workspace_id
    for update nowait;

    if cleanup_test_gate_key is not null then
      perform pg_catalog.pg_advisory_xact_lock(cleanup_test_gate_key::bigint);
    end if;
  exception
    when lock_not_available then
      raise exception using
        errcode = '55000',
        message = 'Dedicated Workspace is being modified; refusing automatic cleanup';
  end;

  if not fixture_workspace_locked then
    raise exception using
      errcode = '55000',
      message = 'Dedicated cutover inspection concurrency fixture does not exist';
  end if;

  select count(*)
  into fixture_event_count
  from public.cloud_events
  where workspace_id = fixture_workspace_id;

  select status
  into fixture_master_status
  from public.cloud_workspace_master_states
  where workspace_id = fixture_workspace_id;

  select generation
  into fixture_generation
  from public.cloud_event_workspace_generations
  where workspace_id = fixture_workspace_id;

  if exists (
    select 1 from public.workspaces
    where id = fixture_workspace_id
      and name is distinct from fixture_workspace_name
  ) or exists (
    select 1 from public.workspace_members
    where workspace_id = fixture_workspace_id
  ) or exists (
    select 1 from public.workspace_master_members
    where workspace_id = fixture_workspace_id
  ) or exists (
    select 1 from public.workspace_master_bands
    where workspace_id = fixture_workspace_id
  ) or exists (
    select 1 from public.workspace_master_band_members
    where workspace_id = fixture_workspace_id
  ) or exists (
    select 1 from public.cloud_event_member_references
    where workspace_id = fixture_workspace_id
  ) or exists (
    select 1 from public.cloud_event_band_references
    where workspace_id = fixture_workspace_id
  ) or exists (
    select 1 from public.cloud_workspace_master_backfills
    where workspace_id = fixture_workspace_id
  ) or fixture_master_status is distinct from 'legacy'
    or fixture_event_count not in (0, 1)
    or fixture_generation is null
  then
    raise exception using
      errcode = '55000',
      message = 'Dedicated Workspace contains unexpected data; refusing automatic cleanup';
  end if;

  -- Only the exact states committed by this fixture are safe to remove:
  -- before Event creation, after the insert, or after the concurrent update.
  if fixture_event_count = 0 then
    if fixture_generation is distinct from 0 then
      raise exception using
        errcode = '55000',
        message = 'Dedicated Workspace state is not a recognized concurrency fixture; refusing automatic cleanup';
    end if;
  else
    select event_id, event_name, event_snapshot, revision
    into fixture_event_id, fixture_event_name, fixture_event_snapshot,
      fixture_event_revision
    from public.cloud_events
    where workspace_id = fixture_workspace_id;

    if fixture_event_id is distinct from 'event-a'
      or not (
        (
          fixture_event_name is not distinct from 'Before inspection race'
          and fixture_event_snapshot is not distinct from expected_before_snapshot
          and fixture_event_revision is not distinct from 1
          and fixture_generation is not distinct from 1
        ) or (
          fixture_event_name is not distinct from 'After inspection race'
          and fixture_event_snapshot is not distinct from expected_after_snapshot
          and fixture_event_revision is not distinct from 2
          and fixture_generation is not distinct from 2
        )
      ) then
      raise exception using
        errcode = '55000',
        message = 'Dedicated Workspace state is not a recognized concurrency fixture; refusing automatic cleanup';
    end if;
  end if;

  delete from public.workspaces
  where id = fixture_workspace_id;

  if not found
    or exists (
      select 1 from public.workspaces
      where id = fixture_workspace_id
    ) or exists (
      select 1 from public.workspace_members
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.cloud_events
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.workspace_master_members
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.workspace_master_bands
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.workspace_master_band_members
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.cloud_event_member_references
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.cloud_event_band_references
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.cloud_workspace_master_backfills
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.cloud_workspace_master_states
      where workspace_id = fixture_workspace_id
    ) or exists (
      select 1 from public.cloud_event_workspace_generations
      where workspace_id = fixture_workspace_id
    ) then
    raise exception using
      errcode = '55000',
      message = 'Dedicated cutover inspection concurrency fixture cleanup failed';
  end if;
end;
$$;

commit;
