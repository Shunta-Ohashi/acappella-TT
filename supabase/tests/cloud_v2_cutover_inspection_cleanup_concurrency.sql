\set ON_ERROR_STOP on

\if :{?confirm_cleanup_concurrency_fixture}
\else
  \echo 'Run this fixture only through cloudV2CutoverInspectionCleanupConcurrency.mjs.'
  \quit 2
\endif

-- Setup only. The process-level runner executes the real cleanup SQL in three
-- concurrent scenarios, then removes this exact fixture. Existing fixed IDs
-- are never recovered or deleted automatically at startup.
begin;

do $$
begin
  if exists (
    select 1 from public.workspaces
    where id = '79500000-0000-4000-8000-000000000001'
  ) or exists (
    select 1 from auth.users
    where id = '00000000-0000-4000-8000-000000000075'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Dedicated cleanup concurrency fixture already exists; inspect it and run explicit cleanup';
  end if;
end;
$$;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-000000000075',
  'authenticated',
  'authenticated',
  'cloud-v2-cleanup-race@example.invalid',
  '',
  now(),
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.workspaces (id, name) values (
  '79500000-0000-4000-8000-000000000001',
  'Cutover inspection concurrency'
);

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

do $$
declare
  fixture_generation bigint;
  fixture_revision bigint;
begin
  select generation into fixture_generation
  from public.cloud_event_workspace_generations
  where workspace_id = '79500000-0000-4000-8000-000000000001';

  select revision into fixture_revision
  from public.cloud_events
  where workspace_id = '79500000-0000-4000-8000-000000000001'
    and event_id = 'event-a';

  if fixture_generation is distinct from 1
    or fixture_revision is distinct from 1
    or (select status from public.cloud_workspace_master_states
      where workspace_id = '79500000-0000-4000-8000-000000000001')
      is distinct from 'legacy'
    or exists (
      select 1 from public.workspace_members
      where workspace_id = '79500000-0000-4000-8000-000000000001'
    ) then
    raise exception 'cleanup concurrency fixture setup is invalid';
  end if;
end;
$$;

commit;
