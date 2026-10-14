\set ON_ERROR_STOP on

-- Run only against a disposable PostgreSQL/Supabase database after all
-- repository migrations. Every fixture and mutation is rolled back.
begin;

create or replace function pg_temp.cloud_event_v2_snapshot(
  p_event_id text,
  p_event_name text,
  p_member_ids jsonb default '["member-a","member-b"]'::jsonb,
  p_band_ids jsonb default '["band-a"]'::jsonb
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
        'id', p_event_id,
        'name', p_event_name,
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1,
          'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5)
      )),
      'eventDays', jsonb_build_array(jsonb_build_object(
        'id', 'day-a', 'eventId', p_event_id,
        'date', '2026-10-13', 'order', 0
      )),
      'stages', '[]'::jsonb,
      'sections', '[]'::jsonb,
      'eventMembers', jsonb_build_array(jsonb_build_object(
        'id', 'event-member-a', 'eventId', p_event_id,
        'memberId', 'member-a',
        'paCapabilities', jsonb_build_object('main', true, 'sub', false)
      )),
      'eventMemberDays', '[]'::jsonb,
      'eventBands', jsonb_build_array(jsonb_build_object(
        'id', 'event-band-a', 'eventId', p_event_id,
        'eventDayId', 'day-a', 'bandId', 'band-a',
        'name', 'Alpha at Event',
        'memberIds', jsonb_build_array('member-a'),
        'durationMinutes', 5
      )),
      'scheduleItems', '[]'::jsonb,
      'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb,
      'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    ),
    'masterReferences', jsonb_build_object(
      'memberIds', p_member_ids,
      'bandIds', p_band_ids
    )
  );
$$;

create or replace function pg_temp.cloud_event_v1_snapshot(
  p_event_id text,
  p_event_name text
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
        'id', p_event_id,
        'name', p_event_name,
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
  );
$$;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000081', 'authenticated', 'authenticated',
   'event-v2-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000082', 'authenticated', 'authenticated',
   'event-v2-editor@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000083', 'authenticated', 'authenticated',
   'event-v2-viewer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000084', 'authenticated', 'authenticated',
   'event-v2-outsider@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.workspaces (id, name) values
  ('72000000-0000-0000-0000-000000000001', 'Event V2 ready'),
  ('72000000-0000-0000-0000-000000000002', 'Event V2 legacy'),
  ('72000000-0000-0000-0000-000000000003', 'Event V1 conversion guard');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('72000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000081', 'owner'),
  ('72000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000082', 'editor'),
  ('72000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000083', 'viewer'),
  ('72000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000081', 'owner'),
  ('72000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000081', 'owner');

update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '72000000-0000-0000-0000-000000000001';

insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values
  ('72000000-0000-0000-0000-000000000001', 'member-a', 'Alice', true),
  ('72000000-0000-0000-0000-000000000001', 'member-b', 'Bob', true),
  ('72000000-0000-0000-0000-000000000002', 'member-a', 'Legacy Alice', true);
insert into public.workspace_master_bands (
  workspace_id, band_id, name, active
) values (
  '72000000-0000-0000-0000-000000000001', 'band-a', 'Alpha', true
);
insert into public.workspace_master_band_members (
  workspace_id, band_id, member_id, position
) values (
  '72000000-0000-0000-0000-000000000001', 'band-a', 'member-b', 0
);

do $$
begin
  if not has_function_privilege(
    'service_role',
    'public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text)',
    'execute'
  ) then
    raise exception 'Snapshot V2 save RPC privileges are incorrect';
  end if;
end;
$$;

-- Owner create: exactly one Event row mutation advances generation once and
-- both reference indexes are replaced atomically.
do $$
declare
  generation_before bigint;
  result jsonb;
begin
  select generation into generation_before
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000001';

  result := public.save_cloud_event_v2_validated(
    '00000000-0000-0000-0000-000000000081',
    '72000000-0000-0000-0000-000000000001',
    pg_temp.cloud_event_v2_snapshot('event-v2', 'Event V2'),
    null,
    generation_before::text
  );
  if result ->> 'workspaceGeneration' <> (generation_before + 1)::text
    or result #>> '{record,revision}' <> '1'
    or (select count(*) from public.cloud_event_member_references
        where workspace_id = '72000000-0000-0000-0000-000000000001'
          and event_id = 'event-v2') <> 2
    or (select count(*) from public.cloud_event_band_references
        where workspace_id = '72000000-0000-0000-0000-000000000001'
          and event_id = 'event-v2') <> 1 then
    raise exception 'Snapshot V2 create did not atomically save row and references';
  end if;
end;
$$;

-- Editor update with matching revision/generation succeeds once.
do $$
declare
  generation_before bigint;
  result jsonb;
begin
  select generation into generation_before
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000001';
  result := public.save_cloud_event_v2_validated(
    '00000000-0000-0000-0000-000000000082',
    '72000000-0000-0000-0000-000000000001',
    pg_temp.cloud_event_v2_snapshot('event-v2', 'Event V2 updated'),
    1,
    generation_before::text
  );
  if result #>> '{record,revision}' <> '2'
    or result #>> '{record,event_name}' <> 'Event V2 updated'
    or result ->> 'workspaceGeneration' <> (generation_before + 1)::text then
    raise exception 'Snapshot V2 revision/generation CAS update is incorrect';
  end if;
end;
$$;

-- Every failure below runs in a PL/pgSQL subtransaction. Event, references,
-- revision, generation and Workspace status must remain unchanged.
do $$
declare
  event_before jsonb;
  members_before jsonb;
  bands_before jsonb;
  generation_before bigint;
  status_before text;
begin
  select to_jsonb(cloud_events) into event_before
  from public.cloud_events
  where workspace_id = '72000000-0000-0000-0000-000000000001'
    and event_id = 'event-v2';
  select coalesce(jsonb_agg(to_jsonb(reference_row)
      order by reference_row.member_id), '[]'::jsonb)
    into members_before
  from public.cloud_event_member_references as reference_row
  where workspace_id = '72000000-0000-0000-0000-000000000001'
    and event_id = 'event-v2';
  select coalesce(jsonb_agg(to_jsonb(reference_row)
      order by reference_row.band_id), '[]'::jsonb)
    into bands_before
  from public.cloud_event_band_references as reference_row
  where workspace_id = '72000000-0000-0000-0000-000000000001'
    and event_id = 'event-v2';
  select generation into generation_before
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000001';
  select status into status_before
  from public.cloud_workspace_master_states
  where workspace_id = '72000000-0000-0000-0000-000000000001';

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_v2_snapshot('event-v2', 'Stale revision'),
      1,
      generation_before::text
    );
    raise exception 'stale Event revision was accepted';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_v2_snapshot('event-v2', 'Duplicate create'),
      null,
      generation_before::text
    );
    raise exception 'duplicate Snapshot V2 create was accepted';
  exception when unique_violation then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_v2_snapshot('event-v2', 'Stale generation'),
      2,
      (generation_before - 1)::text
    );
    raise exception 'stale Workspace generation was accepted';
  exception when sqlstate 'PVE04' then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_v2_snapshot(
        'event-v2', 'Missing transitive member', '["member-a"]'::jsonb
      ),
      2,
      generation_before::text
    );
    raise exception 'incomplete transitive Master closure was accepted';
  exception when sqlstate 'PVE02' then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000001',
      jsonb_set(
        jsonb_set(
          pg_temp.cloud_event_v2_snapshot(
            'event-v2', 'Missing Workspace Member',
            '["missing-member","member-b"]'::jsonb
          ),
          '{eventState,eventMembers,0,memberId}',
          '"missing-member"'::jsonb
        ),
        '{eventState,eventBands,0,memberIds}',
        '["missing-member"]'::jsonb
      ),
      2,
      generation_before::text
    );
    raise exception 'missing or cross-Workspace Member was accepted';
  exception when sqlstate 'PVE02' then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000001',
      jsonb_set(
        jsonb_set(
          pg_temp.cloud_event_v2_snapshot(
            'event-v2', 'Missing Workspace Band',
            '["member-a"]'::jsonb,
            '["missing-band"]'::jsonb
          ),
          '{eventState,eventBands,0,bandId}',
          '"missing-band"'::jsonb
        ),
        '{eventState,eventBands,0,memberIds}',
        '["member-a"]'::jsonb
      ),
      2,
      generation_before::text
    );
    raise exception 'missing or cross-Workspace Band was accepted';
  exception when sqlstate 'PVE02' then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000083',
      '72000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_v2_snapshot('viewer-event', 'Viewer Event'),
      null,
      generation_before::text
    );
    raise exception 'viewer V2 save was accepted';
  exception when sqlstate '42501' then null;
  end;

  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000084',
      '72000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_v2_snapshot('outsider-event', 'Outsider Event'),
      null,
      generation_before::text
    );
    raise exception 'outsider V2 save was accepted';
  exception when sqlstate '42501' then null;
  end;

  if event_before is distinct from (
      select to_jsonb(cloud_events) from public.cloud_events
      where workspace_id = '72000000-0000-0000-0000-000000000001'
        and event_id = 'event-v2'
    ) or members_before is distinct from (
      select coalesce(jsonb_agg(to_jsonb(reference_row)
        order by reference_row.member_id), '[]'::jsonb)
      from public.cloud_event_member_references as reference_row
      where workspace_id = '72000000-0000-0000-0000-000000000001'
        and event_id = 'event-v2'
    ) or bands_before is distinct from (
      select coalesce(jsonb_agg(to_jsonb(reference_row)
        order by reference_row.band_id), '[]'::jsonb)
      from public.cloud_event_band_references as reference_row
      where workspace_id = '72000000-0000-0000-0000-000000000001'
        and event_id = 'event-v2'
    ) or generation_before is distinct from (
      select generation from public.cloud_event_workspace_generations
      where workspace_id = '72000000-0000-0000-0000-000000000001'
    ) or status_before is distinct from (
      select status from public.cloud_workspace_master_states
      where workspace_id = '72000000-0000-0000-0000-000000000001'
    ) then
    raise exception 'failed V2 saves changed protected state';
  end if;
end;
$$;

-- A legacy Workspace remains available to the V1 writer but rejects V2.
select public.save_cloud_event_validated(
  '00000000-0000-0000-0000-000000000081',
  '72000000-0000-0000-0000-000000000002',
  pg_temp.cloud_event_v1_snapshot('legacy-v1', 'Legacy V1')
);
do $$
declare generation_value bigint;
begin
  select generation into generation_value
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000002';
  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000002',
      pg_temp.cloud_event_v2_snapshot(
        'legacy-v2', 'Legacy V2', '["member-a"]'::jsonb, '[]'::jsonb
      ),
      null,
      generation_value::text
    );
    raise exception 'legacy Workspace accepted V2';
  exception when sqlstate '55000' then null;
  end;

  update public.cloud_workspace_master_states set status = 'conflict'
  where workspace_id = '72000000-0000-0000-0000-000000000002';
  select generation into generation_value
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000002';
  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000002',
      pg_temp.cloud_event_v2_snapshot(
        'conflict-v2', 'Conflict V2', '[]'::jsonb, '[]'::jsonb
      ),
      null,
      generation_value::text
    );
    raise exception 'conflict Workspace accepted V2';
  exception when sqlstate '55000' then null;
  end;
end;
$$;

-- Existing V1 rows cannot be overwritten by V2 and old V1 writers cannot
-- write once a Workspace is explicitly ready.
select public.save_cloud_event_validated(
  '00000000-0000-0000-0000-000000000081',
  '72000000-0000-0000-0000-000000000003',
  pg_temp.cloud_event_v1_snapshot('conversion-v1', 'Conversion V1')
);
update public.cloud_workspace_master_states set status = 'ready'
where workspace_id = '72000000-0000-0000-0000-000000000003';
do $$
declare generation_value bigint;
begin
  begin
    perform public.save_cloud_event_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000003',
      pg_temp.cloud_event_v1_snapshot('new-v1', 'Blocked V1')
    );
    raise exception 'ready Workspace accepted a V1 write';
  exception when sqlstate '55000' then null;
  end;

  select generation into generation_value
  from public.cloud_event_workspace_generations
  where workspace_id = '72000000-0000-0000-0000-000000000003';
  begin
    perform public.save_cloud_event_v2_validated(
      '00000000-0000-0000-0000-000000000081',
      '72000000-0000-0000-0000-000000000003',
      pg_temp.cloud_event_v2_snapshot(
        'conversion-v1', 'Conversion V2', '[]'::jsonb, '[]'::jsonb
      ),
      1,
      generation_value::text
    );
    raise exception 'V2 writer overwrote an existing V1 row';
  exception when sqlstate 'PVE01' then null;
  end;
end;
$$;

-- Unknown versions and V2 Master bodies fail at the table CHECK boundary.
do $$
begin
  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '72000000-0000-0000-0000-000000000002',
      'unknown-version', 'Unknown',
      jsonb_build_object('format', 'acappella-tt-cloud-event', 'version', 99)
    );
    raise exception 'unknown Snapshot version was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '72000000-0000-0000-0000-000000000002',
      'master-body', 'Master body',
      jsonb_set(
        pg_temp.cloud_event_v2_snapshot(
          'master-body', 'Master body', '[]'::jsonb, '[]'::jsonb
        ),
        '{eventState,members}',
        '[]'::jsonb
      )
    );
    raise exception 'V2 Master bodies were accepted';
  exception when check_violation then null;
  end;
end;
$$;

-- Event deletion retains the existing cascade contract for both reference
-- indexes. The outer transaction still rolls every fixture back.
delete from public.cloud_events
where workspace_id = '72000000-0000-0000-0000-000000000001'
  and event_id = 'event-v2';
do $$
begin
  if exists (
    select 1 from public.cloud_event_member_references
    where workspace_id = '72000000-0000-0000-0000-000000000001'
      and event_id = 'event-v2'
  ) or exists (
    select 1 from public.cloud_event_band_references
    where workspace_id = '72000000-0000-0000-0000-000000000001'
      and event_id = 'event-v2'
  ) then
    raise exception 'Event deletion did not cascade V2 reference indexes';
  end if;
end;
$$;

rollback;
