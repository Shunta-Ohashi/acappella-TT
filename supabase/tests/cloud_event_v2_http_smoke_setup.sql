\set ON_ERROR_STOP on

-- Dedicated HTTP smoke fixture. Run only through cloudEventV2HttpSmoke.mjs
-- against the disposable local Supabase instance on API 55721 / DB 55722.
begin;

do $$
begin
  if to_regprocedure(
    'public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text)'
  ) is null then
    raise exception 'Snapshot V2 save RPC is unavailable';
  end if;

  if exists (
    select 1 from public.workspaces
    where id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.workspace_members
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.cloud_events
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.workspace_master_members
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.workspace_master_bands
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.workspace_master_band_members
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.cloud_event_member_references
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.cloud_event_band_references
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) or exists (
    select 1 from public.cloud_event_workspace_generations
    where workspace_id in (
      '76000000-0000-0000-0000-000000000001',
      '76000000-0000-0000-0000-000000000002',
      '76000000-0000-0000-0000-000000000003'
    )
  ) then
    raise exception 'Cloud Event V2 HTTP smoke fixture IDs are already in use';
  end if;
end;
$$;

insert into public.workspaces (id, name) values
  ('76000000-0000-0000-0000-000000000001', 'Event V2 HTTP smoke ready'),
  ('76000000-0000-0000-0000-000000000002', 'Event V2 HTTP smoke legacy'),
  ('76000000-0000-0000-0000-000000000003', 'Event V2 HTTP smoke V1 guard');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('76000000-0000-0000-0000-000000000001', :'owner_user_id'::uuid, 'owner'),
  ('76000000-0000-0000-0000-000000000001', :'editor_user_id'::uuid, 'editor'),
  ('76000000-0000-0000-0000-000000000001', :'viewer_user_id'::uuid, 'viewer'),
  ('76000000-0000-0000-0000-000000000002', :'owner_user_id'::uuid, 'owner'),
  ('76000000-0000-0000-0000-000000000003', :'owner_user_id'::uuid, 'owner');

insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values
  ('76000000-0000-0000-0000-000000000001',
   'v2-http-member-a', 'HTTP Member A', true),
  ('76000000-0000-0000-0000-000000000001',
   'v2-http-member-b', 'HTTP Member B', true);

insert into public.workspace_master_bands (
  workspace_id, band_id, name, active
) values (
  '76000000-0000-0000-0000-000000000001',
  'v2-http-band-a', 'HTTP Band A', true
);

insert into public.workspace_master_band_members (
  workspace_id, band_id, member_id, position
) values
  ('76000000-0000-0000-0000-000000000001',
   'v2-http-band-a', 'v2-http-member-a', 0),
  ('76000000-0000-0000-0000-000000000001',
   'v2-http-band-a', 'v2-http-member-b', 1);

-- Create the legacy row before making this Workspace ready. The smoke runner
-- proves that the V2 writer refuses to overwrite it afterwards.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '76000000-0000-0000-0000-000000000003',
  'v1-http-event',
  'V1 HTTP Event',
  jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'v1-http-event',
        'name', 'V1 HTTP Event',
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
);

update public.cloud_workspace_master_states
set status = 'ready'
where workspace_id in (
  '76000000-0000-0000-0000-000000000001',
  '76000000-0000-0000-0000-000000000003'
);

do $$
begin
  if (select count(*) from public.workspaces
      where id in (
        '76000000-0000-0000-0000-000000000001',
        '76000000-0000-0000-0000-000000000002',
        '76000000-0000-0000-0000-000000000003'
      )) <> 3
    or (select count(*) from public.workspace_members
        where workspace_id in (
          '76000000-0000-0000-0000-000000000001',
          '76000000-0000-0000-0000-000000000002',
          '76000000-0000-0000-0000-000000000003'
        )) <> 5
    or (select count(*) from public.workspace_master_members
        where workspace_id = '76000000-0000-0000-0000-000000000001') <> 2
    or (select count(*) from public.workspace_master_bands
        where workspace_id = '76000000-0000-0000-0000-000000000001') <> 1
    or (select count(*) from public.workspace_master_band_members
        where workspace_id = '76000000-0000-0000-0000-000000000001') <> 2
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '76000000-0000-0000-0000-000000000001')
        is distinct from 'ready'
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '76000000-0000-0000-0000-000000000002')
        is distinct from 'legacy'
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '76000000-0000-0000-0000-000000000003')
        is distinct from 'ready'
    or (select event_snapshot ->> 'version' from public.cloud_events
        where workspace_id = '76000000-0000-0000-0000-000000000003'
          and event_id = 'v1-http-event') is distinct from '1' then
    raise exception 'Cloud Event V2 HTTP smoke fixture setup failed';
  end if;
end;
$$;

commit;
