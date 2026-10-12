\set ON_ERROR_STOP on

-- Run only against a disposable database with every repository migration
-- applied. This focused fixture proves that one parent Workspace DELETE can
-- complete every child cascade without weakening direct Master references.
begin;

create or replace function pg_temp.workspace_master_cascade_snapshot(
  event_id text,
  event_name text
)
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
        'name', event_name,
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1,
          'minimumRestMinutes', 10
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
$$;

create or replace function pg_temp.assert_workspace_cascade_absent(
  target_workspace_id uuid
)
returns void
language plpgsql
as $$
begin
  if exists (select 1 from public.workspaces where id = target_workspace_id)
    or exists (select 1 from public.workspace_master_members where workspace_id = target_workspace_id)
    or exists (select 1 from public.workspace_master_bands where workspace_id = target_workspace_id)
    or exists (select 1 from public.workspace_master_band_members where workspace_id = target_workspace_id)
    or exists (select 1 from public.cloud_event_member_references where workspace_id = target_workspace_id)
    or exists (select 1 from public.cloud_event_band_references where workspace_id = target_workspace_id)
    or exists (select 1 from public.cloud_events where workspace_id = target_workspace_id)
    or exists (select 1 from public.cloud_workspace_master_states where workspace_id = target_workspace_id)
    or exists (select 1 from public.cloud_event_workspace_generations where workspace_id = target_workspace_id)
  then
    raise exception 'Workspace cascade left rows for %', target_workspace_id;
  end if;
end;
$$;

insert into public.workspaces (id, name) values
  ('72000000-0000-0000-0000-000000000001', 'Cascade A member only'),
  ('72000000-0000-0000-0000-000000000002', 'Cascade B member and band'),
  ('72000000-0000-0000-0000-000000000003', 'Cascade C multiple members'),
  ('72000000-0000-0000-0000-000000000004', 'Cascade D shared member'),
  ('72000000-0000-0000-0000-000000000005', 'Cascade E event references'),
  ('72000000-0000-0000-0000-000000000006', 'Cascade F legacy'),
  ('72000000-0000-0000-0000-000000000007', 'Cascade F ready'),
  ('72000000-0000-0000-0000-000000000008', 'Cascade F conflict');

update public.cloud_workspace_master_states
set status = case workspace_id
  when '72000000-0000-0000-0000-000000000002' then 'ready'
  when '72000000-0000-0000-0000-000000000003' then 'conflict'
  when '72000000-0000-0000-0000-000000000005' then 'ready'
  when '72000000-0000-0000-0000-000000000007' then 'ready'
  when '72000000-0000-0000-0000-000000000008' then 'conflict'
  else 'legacy'
end
where workspace_id between
  '72000000-0000-0000-0000-000000000001'::uuid and
  '72000000-0000-0000-0000-000000000008'::uuid;

insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values
  ('72000000-0000-0000-0000-000000000001', 'member-a', 'Member A', true),
  ('72000000-0000-0000-0000-000000000002', 'member-b', 'Member B', true),
  ('72000000-0000-0000-0000-000000000003', 'member-c1', 'Member C1', true),
  ('72000000-0000-0000-0000-000000000003', 'member-c2', 'Member C2', true),
  ('72000000-0000-0000-0000-000000000003', 'member-c3', 'Member C3', true),
  ('72000000-0000-0000-0000-000000000004', 'member-d', 'Member D', true),
  ('72000000-0000-0000-0000-000000000005', 'member-e', 'Member E', true),
  ('72000000-0000-0000-0000-000000000005', 'member-e-event', 'Member E Event', true),
  ('72000000-0000-0000-0000-000000000006', 'member-f', 'Member F Legacy', true),
  ('72000000-0000-0000-0000-000000000007', 'member-f', 'Member F Ready', true),
  ('72000000-0000-0000-0000-000000000008', 'member-f', 'Member F Conflict', true);

insert into public.workspace_master_bands (
  workspace_id, band_id, name, active
) values
  ('72000000-0000-0000-0000-000000000002', 'band-b', 'Band B', true),
  ('72000000-0000-0000-0000-000000000003', 'band-c', 'Band C', true),
  ('72000000-0000-0000-0000-000000000004', 'band-d1', 'Band D1', true),
  ('72000000-0000-0000-0000-000000000004', 'band-d2', 'Band D2', true),
  ('72000000-0000-0000-0000-000000000005', 'band-e', 'Band E', true),
  ('72000000-0000-0000-0000-000000000006', 'band-f', 'Band F Legacy', true),
  ('72000000-0000-0000-0000-000000000007', 'band-f', 'Band F Ready', true),
  ('72000000-0000-0000-0000-000000000008', 'band-f', 'Band F Conflict', true);

insert into public.workspace_master_band_members (
  workspace_id, band_id, member_id, position
) values
  ('72000000-0000-0000-0000-000000000003', 'band-c', 'member-c1', 0),
  ('72000000-0000-0000-0000-000000000003', 'band-c', 'member-c2', 1),
  ('72000000-0000-0000-0000-000000000003', 'band-c', 'member-c3', 2),
  ('72000000-0000-0000-0000-000000000004', 'band-d1', 'member-d', 0),
  ('72000000-0000-0000-0000-000000000004', 'band-d2', 'member-d', 0),
  ('72000000-0000-0000-0000-000000000005', 'band-e', 'member-e', 0),
  ('72000000-0000-0000-0000-000000000006', 'band-f', 'member-f', 0),
  ('72000000-0000-0000-0000-000000000007', 'band-f', 'member-f', 0),
  ('72000000-0000-0000-0000-000000000008', 'band-f', 'member-f', 0);

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '72000000-0000-0000-0000-000000000005',
  'event-e',
  'Event E',
  pg_temp.workspace_master_cascade_snapshot('event-e', 'Event E')
);
insert into public.cloud_event_member_references values
  ('72000000-0000-0000-0000-000000000005', 'event-e', 'member-e'),
  ('72000000-0000-0000-0000-000000000005', 'event-e', 'member-e-event');
insert into public.cloud_event_band_references values (
  '72000000-0000-0000-0000-000000000005', 'event-e', 'band-e'
);

-- RESTRICT must remain a real reference guard outside the parent cascade.
do $$
begin
  begin
    delete from public.workspace_master_members
    where workspace_id = '72000000-0000-0000-0000-000000000007'
      and member_id = 'member-f';
    raise exception 'Band-referenced Workspace Member deletion was accepted';
  exception when foreign_key_violation then
    null;
  end;
  begin
    delete from public.workspace_master_members
    where workspace_id = '72000000-0000-0000-0000-000000000005'
      and member_id = 'member-e-event';
    raise exception 'Event-referenced Workspace Member deletion was accepted';
  exception when foreign_key_violation then
    null;
  end;
  begin
    delete from public.workspace_master_bands
    where workspace_id = '72000000-0000-0000-0000-000000000005'
      and band_id = 'band-e';
    raise exception 'Referenced Workspace Band deletion was accepted';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

delete from public.workspaces
where id between
  '72000000-0000-0000-0000-000000000001'::uuid and
  '72000000-0000-0000-0000-000000000008'::uuid;

select pg_temp.assert_workspace_cascade_absent(workspace_id)
from unnest(array[
  '72000000-0000-0000-0000-000000000001'::uuid,
  '72000000-0000-0000-0000-000000000002'::uuid,
  '72000000-0000-0000-0000-000000000003'::uuid,
  '72000000-0000-0000-0000-000000000004'::uuid,
  '72000000-0000-0000-0000-000000000005'::uuid,
  '72000000-0000-0000-0000-000000000006'::uuid,
  '72000000-0000-0000-0000-000000000007'::uuid,
  '72000000-0000-0000-0000-000000000008'::uuid
]) as fixture_workspaces(workspace_id);

rollback;
