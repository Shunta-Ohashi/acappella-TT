\set ON_ERROR_STOP on

-- Run only against a fresh disposable PostgreSQL 17 database with all
-- repository migrations applied. Every fixture row is rolled back.
begin;

create or replace function pg_temp.live_v1_snapshot()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'members', '[]'::jsonb,
      'bands', '[]'::jsonb,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'live-foundation-event',
        'name', 'Live Foundation Event',
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1, 'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(10)
      )),
      'eventDays', jsonb_build_array(jsonb_build_object(
        'id', 'live-day', 'eventId', 'live-foundation-event',
        'date', '2026-11-01', 'order', 0
      )),
      'stages', jsonb_build_array(
        jsonb_build_object(
          'id', 'live-stage-a', 'eventDayId', 'live-day',
          'name', 'Main', 'order', 0, 'plannedStartTime', '10:00'
        ),
        jsonb_build_object(
          'id', 'live-stage-b', 'eventDayId', 'live-day',
          'name', 'Sub', 'order', 1, 'plannedStartTime', '11:00'
        )
      ),
      'sections', jsonb_build_array(jsonb_build_object(
        'id', 'live-section', 'stageId', 'live-stage-a',
        'name', 'Part 1', 'order', 0,
        'plannedStartTime', '10:00', 'plannedEndTime', '11:00'
      )),
      'eventMembers', '[]'::jsonb,
      'eventMemberDays', '[]'::jsonb,
      'eventBands', jsonb_build_array(
        jsonb_build_object(
          'id', 'live-band-a', 'eventId', 'live-foundation-event',
          'eventDayId', 'live-day', 'name', 'First Band',
          'memberIds', '[]'::jsonb, 'durationMinutes', 10
        ),
        jsonb_build_object(
          'id', 'live-band-b', 'eventId', 'live-foundation-event',
          'eventDayId', 'live-day', 'name', 'Second Band',
          'memberIds', '[]'::jsonb, 'durationMinutes', 10
        )
      ),
      'scheduleItems', jsonb_build_array(
        jsonb_build_object(
          'id', 'live-item-a', 'stageId', 'live-stage-a',
          'sectionId', 'live-section', 'kind', 'performance',
          'eventBandId', 'live-band-a', 'order', 0
        ),
        jsonb_build_object(
          'id', 'live-break', 'stageId', 'live-stage-a',
          'sectionId', 'live-section', 'kind', 'break',
          'title', 'Private break title', 'durationMinutes', 5, 'order', 1
        ),
        jsonb_build_object(
          'id', 'live-item-b', 'stageId', 'live-stage-a',
          'sectionId', 'live-section', 'kind', 'performance',
          'eventBandId', 'live-band-b', 'order', 2
        )
      ),
      'paAssignments', '[]'::jsonb,
      'dutyTypes', '[]'::jsonb,
      'dutyAssignments', '[]'::jsonb,
      'timetableLocks', '[]'::jsonb,
      'timetableOrderConstraints', '[]'::jsonb
    )
  )
$$;

create or replace function pg_temp.live_empty_v1_snapshot()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-cloud-event', 'version', 1,
    'appState', jsonb_build_object(
      'version', 5, 'members', '[]'::jsonb, 'bands', '[]'::jsonb,
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'live-without-state', 'name', 'No Live State',
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

create or replace function pg_temp.live_projection()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format', 'acappella-tt-live-timetable-projection',
    'version', 1,
    'eventId', 'live-foundation-event',
    'eventName', 'Live Foundation Event',
    'timeZone', 'Asia/Tokyo',
    'eventDays', jsonb_build_array(jsonb_build_object(
      'sourceEventDayId', 'live-day', 'date', '2026-11-01',
      'label', null, 'position', 0
    )),
    'stages', jsonb_build_array(
      jsonb_build_object(
        'sourceEventDayId', 'live-day',
        'eventDayPosition', 0,
        'sourceStageId', 'live-stage-a',
        'name', 'Main', 'position', 0,
        'plannedStartTime', '10:00', 'plannedEndTime', null,
        'sections', jsonb_build_array(jsonb_build_object(
          'sourceSectionId', 'live-section', 'name', 'Part 1',
          'position', 0, 'plannedStartTime', '10:00',
          'plannedEndTime', '11:00'
        )),
        'entries', jsonb_build_array(
          jsonb_build_object(
            'sourceScheduleItemId', 'live-item-a',
            'sourceSectionId', 'live-section', 'afterSectionId', null,
            'kind', 'performance', 'position', 0,
            'displayName', 'First Band',
            'plannedStartMinute', 600, 'plannedEndMinute', 610
          ),
          jsonb_build_object(
            'sourceScheduleItemId', 'live-break',
            'sourceSectionId', 'live-section', 'afterSectionId', null,
            'kind', 'break', 'position', 1, 'displayName', '休憩',
            'plannedStartMinute', 610, 'plannedEndMinute', 615
          ),
          jsonb_build_object(
            'sourceScheduleItemId', 'live-item-b',
            'sourceSectionId', 'live-section', 'afterSectionId', null,
            'kind', 'performance', 'position', 2,
            'displayName', 'Second Band',
            'plannedStartMinute', 615, 'plannedEndMinute', 625
          )
        )
      ),
      jsonb_build_object(
        'sourceEventDayId', 'live-day',
        'eventDayPosition', 0,
        'sourceStageId', 'live-stage-b',
        'name', 'Sub', 'position', 1,
        'plannedStartTime', '11:00', 'plannedEndTime', null,
        'sections', '[]'::jsonb, 'entries', '[]'::jsonb
      )
    )
  )
$$;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-4000-8000-000000000081', 'authenticated', 'authenticated',
   'live-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-000000000082', 'authenticated', 'authenticated',
   'live-editor@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-000000000083', 'authenticated', 'authenticated',
   'live-viewer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-000000000084', 'authenticated', 'authenticated',
   'live-outsider@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.workspaces (id, name) values
  ('78000000-0000-4000-8000-000000000001', 'Live foundation fixture');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('78000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000081', 'owner'),
  ('78000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000082', 'editor'),
  ('78000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000083', 'viewer');
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78000000-0000-4000-8000-000000000001',
  'live-foundation-event', 'Live Foundation Event',
  pg_temp.live_v1_snapshot()
);

do $catalog_contract$
declare
  table_name text;
begin
  foreach table_name in array array[
    'live_timetables', 'live_timetable_stages',
    'live_timetable_entries', 'live_timetable_stage_operators'
  ] loop
    if not (select relrowsecurity from pg_catalog.pg_class
      where oid = to_regclass('public.' || table_name)) then
      raise exception 'RLS is disabled on %', table_name;
    end if;
    if has_table_privilege('authenticated', 'public.' || table_name,
      'INSERT,UPDATE,DELETE')
      or has_table_privilege('anon', 'public.' || table_name,
      'INSERT,UPDATE,DELETE') then
      raise exception 'Browser write privilege exists on %', table_name;
    end if;
  end loop;
  if not has_table_privilege(
    'authenticated', 'public.live_timetable_stages', 'SELECT'
  ) or has_table_privilege(
    'anon', 'public.live_timetable_stages', 'SELECT'
  ) then
    raise exception 'Realtime Stage SELECT privilege is incorrect';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'live_timetable_stages'
  ) then
    raise exception 'Live Stage is absent from realtime publication';
  end if;
  if not (
    select count(*) = 1 and bool_and(
      cardinality(pg_publication_tables.attnames) = 7
      and pg_publication_tables.attnames::text[] <@ array[
        'id', 'workspace_id', 'live_timetable_id',
        'projection_version', 'revision', 'progress_status', 'updated_at'
      ]::text[]
    )
    from pg_catalog.pg_publication_tables
    where pg_publication_tables.pubname = 'supabase_realtime'
      and pg_publication_tables.schemaname = 'public'
      and pg_publication_tables.tablename = 'live_timetable_stages'
  ) then
    raise exception 'Realtime Stage publication columns are not minimal';
  end if;
end
$catalog_contract$;

do $create_and_replace$
declare
  source_value jsonb;
  mutation jsonb;
  replacement jsonb;
  target_live_id uuid;
begin
  source_value := public.load_live_timetable_projection_source(
    '00000000-0000-4000-8000-000000000081',
    '78000000-0000-4000-8000-000000000001',
    'live-foundation-event', 1
  );
  mutation := public.create_or_replace_live_timetable_projection(
    '00000000-0000-4000-8000-000000000081',
    '78000000-0000-4000-8000-000000000001',
    'live-foundation-event', 1,
    source_value ->> 'snapshot_fingerprint',
    pg_temp.live_projection(), 'create', null
  );
  target_live_id := (mutation ->> 'liveId')::uuid;
  if mutation ->> 'projectionVersion' <> '1'
    or mutation ->> 'managementRevision' <> '1'
    or (mutation ->> 'isPublished')::boolean then
    raise exception 'Initial Live projection metadata is invalid';
  end if;
  perform set_config(
    'test.live_id', target_live_id::text, true
  );
  perform set_config(
    'test.live_public_id',
    (select public_id::text from public.live_timetables where id = target_live_id),
    true
  );
  perform set_config(
    'test.source_revision',
    (select revision::text from public.cloud_events
      where workspace_id = '78000000-0000-4000-8000-000000000001'
        and event_id = 'live-foundation-event'),
    true
  );
  perform set_config(
    'test.source_generation',
    (select generation::text from public.cloud_event_workspace_generations
      where workspace_id = '78000000-0000-4000-8000-000000000001'),
    true
  );

  insert into public.live_timetable_stage_operators (
    workspace_id, live_timetable_id, stage_id, user_id
  ) select workspace_id, live_timetable_id, id,
      '00000000-0000-4000-8000-000000000082'
    from public.live_timetable_stages
    where live_timetable_id = target_live_id
      and source_stage_id = 'live-stage-a';

  replacement := public.create_or_replace_live_timetable_projection(
    '00000000-0000-4000-8000-000000000081',
    '78000000-0000-4000-8000-000000000001',
    'live-foundation-event', 1,
    source_value ->> 'snapshot_fingerprint',
    pg_temp.live_projection(), 'replace', '1'
  );
  if replacement ->> 'projectionVersion' <> '2'
    or replacement ->> 'managementRevision' <> '2'
    or exists (select 1 from public.live_timetable_stage_operators
      where live_timetable_id = target_live_id) then
    raise exception 'Projection replacement contract is invalid';
  end if;

  begin
    perform public.create_or_replace_live_timetable_projection(
      '00000000-0000-4000-8000-000000000081',
      '78000000-0000-4000-8000-000000000001',
      'live-foundation-event', 1,
      source_value ->> 'snapshot_fingerprint',
      pg_temp.live_projection(), 'replace', '1'
    );
    raise exception 'Stale management CAS was accepted' using errcode = 'P0004';
  exception when sqlstate '40001' then null;
  end;
end
$create_and_replace$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000083', true
);
do $viewer_contract$
declare
  target_live_id uuid;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  perform public.load_live_timetable_authorized(target_live_id);
  begin
    perform public.set_live_timetable_publication(target_live_id, '2', true);
    raise exception 'Viewer publication mutation was accepted' using errcode = 'P0004';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.start_live_timetable_entry(
      target_live_id, 'live-stage-a', 'live-item-a', '1', '2'
    );
    raise exception 'Viewer progress mutation was accepted' using errcode = 'P0004';
  exception when insufficient_privilege then null;
  end;
end
$viewer_contract$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000084', true
);
do $outsider_contract$
declare
  target_live_id uuid;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  begin
    perform public.load_live_timetable_authorized(target_live_id);
    raise exception 'Workspace outsider read was accepted' using errcode = 'P0004';
  exception when insufficient_privilege then null;
  end;
end
$outsider_contract$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000081', true
);
do $owner_publishes$
declare
  target_live_id uuid;
  publication_result jsonb;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  publication_result := public.set_live_timetable_publication(
    target_live_id, '2', true
  );
  if publication_result ->> 'managementRevision' <> '3' then
    raise exception 'Publication did not advance management revision';
  end if;
end
$owner_publishes$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000082', true
);
do $unassigned_editor_contract$
declare
  target_live_id uuid;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  begin
    perform public.start_live_timetable_entry(
      target_live_id, 'live-stage-a', 'live-item-a', '1', '2'
    );
    raise exception 'Unassigned editor progress was accepted' using errcode = 'P0004';
  exception when insufficient_privilege then null;
  end;
end
$unassigned_editor_contract$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000081', true
);
do $owner_assigns$
declare
  target_live_id uuid;
  assignment_result jsonb;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  assignment_result := public.set_live_timetable_stage_operator(
    target_live_id, 'live-stage-a',
    '00000000-0000-4000-8000-000000000082', true,
    '3', '2'
  );
  if assignment_result ->> 'managementRevision' <> '4' then
    raise exception 'Operator assignment did not advance management revision';
  end if;
end
$owner_assigns$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000082', true
);
do $editor_progress$
declare
  target_live_id uuid;
  start_result jsonb;
  end_result jsonb;
  break_start_result jsonb;
  break_end_result jsonb;
begin
  target_live_id := current_setting('test.live_id')::uuid;

  begin
    perform public.start_live_timetable_entry(
      target_live_id, 'live-stage-a', 'live-item-b', '1', '2'
    );
    raise exception 'Non-first pending entry was accepted' using errcode = 'P0004';
  exception when sqlstate '55000' then null;
  end;

  start_result := public.start_live_timetable_entry(
    target_live_id, 'live-stage-a', 'live-item-a', '1', '2'
  );
  if start_result ->> 'progressStatus' <> 'in_progress'
    or start_result ->> 'stageRevision' <> '2'
    or start_result ->> 'nextEntryPosition' <> '1'
    or start_result ->> 'nextPerformancePosition' <> '2' then
    raise exception 'Start result is inconsistent';
  end if;
  begin
    perform public.end_live_timetable_entry(
      target_live_id, 'live-stage-a', 'live-item-a', '1', '2'
    );
    raise exception 'Stale Stage CAS was accepted' using errcode = 'P0004';
  exception when sqlstate '40001' then null;
  end;
  end_result := public.end_live_timetable_entry(
    target_live_id, 'live-stage-a', 'live-item-a', '2', '2'
  );
  if end_result ->> 'progressStatus' <> 'waiting'
    or end_result ->> 'stageRevision' <> '3'
    or end_result ->> 'nextEntryPosition' <> '1'
    or end_result ->> 'nextPerformancePosition' <> '2' then
    raise exception 'End result is inconsistent';
  end if;

  break_start_result := public.start_live_timetable_entry(
    target_live_id, 'live-stage-a', 'live-break', '3', '2'
  );
  if break_start_result ->> 'progressStatus' <> 'in_progress'
    or break_start_result ->> 'stageRevision' <> '4'
    or break_start_result ->> 'currentEntryPosition' <> '1'
    or break_start_result ->> 'nextEntryPosition' <> '2'
    or break_start_result ->> 'nextPerformancePosition' <> '2' then
    raise exception 'Break start result is inconsistent';
  end if;
  break_end_result := public.end_live_timetable_entry(
    target_live_id, 'live-stage-a', 'live-break', '4', '2'
  );
  if break_end_result ->> 'progressStatus' <> 'waiting'
    or break_end_result ->> 'stageRevision' <> '5'
    or break_end_result ->> 'nextEntryPosition' <> '2'
    or break_end_result ->> 'nextPerformancePosition' <> '2' then
    raise exception 'Break end result is inconsistent';
  end if;
  begin
    perform public.end_live_timetable_entry(
      target_live_id, 'live-stage-a', 'live-break', '5', '2'
    );
    raise exception 'Repeated Break end was accepted' using errcode = 'P0004';
  exception when sqlstate '55000' then null;
  end;
end
$editor_progress$;

reset role;
do $cloud_persistence_non_regression$
begin
  if (select revision from public.cloud_events
      where workspace_id = '78000000-0000-4000-8000-000000000001'
        and event_id = 'live-foundation-event')::text <>
      current_setting('test.source_revision')
    or (select generation from public.cloud_event_workspace_generations
      where workspace_id = '78000000-0000-4000-8000-000000000001')::text <>
      current_setting('test.source_generation') then
    raise exception 'Live progress changed Cloud Event persistence state';
  end if;
end
$cloud_persistence_non_regression$;

update public.workspace_members
set role = 'viewer'
where workspace_id = '78000000-0000-4000-8000-000000000001'
  and user_id = '00000000-0000-4000-8000-000000000082';
do $stale_assignment_fixture$
begin
  if not exists (
    select 1 from public.live_timetable_stage_operators
    where live_timetable_id = current_setting('test.live_id')::uuid
      and user_id = '00000000-0000-4000-8000-000000000082'
  ) then
    raise exception 'Stale operator fixture is missing';
  end if;
end
$stale_assignment_fixture$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000082', true
);
do $stale_operator_assignment_contract$
declare
  target_live_id uuid;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  begin
    perform public.start_live_timetable_entry(
      target_live_id, 'live-stage-a', 'live-item-b', '5', '2'
    );
    raise exception 'Viewer with stale operator assignment was accepted'
      using errcode = 'P0004';
  exception when insufficient_privilege then null;
  end;
end
$stale_operator_assignment_contract$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000081', true
);
do $owner_progress_without_assignment$
declare
  target_live_id uuid;
  start_result jsonb;
  end_result jsonb;
begin
  target_live_id := current_setting('test.live_id')::uuid;
  start_result := public.start_live_timetable_entry(
    target_live_id, 'live-stage-a', 'live-item-b', '5', '2'
  );
  end_result := public.end_live_timetable_entry(
    target_live_id, 'live-stage-a', 'live-item-b', '6', '2'
  );
  if start_result ->> 'stageRevision' <> '6'
    or end_result ->> 'stageRevision' <> '7'
    or end_result ->> 'progressStatus' <> 'completed'
    or end_result -> 'entry' ->> 'actualStartedAt' is null
    or end_result -> 'entry' ->> 'actualEndedAt' is null then
    raise exception 'Owner progress contract is inconsistent';
  end if;
end
$owner_progress_without_assignment$;

reset role;
set local role anon;
do $anonymous_public_read_contract$
declare
  public_value jsonb;
begin
  public_value := public.load_live_timetable_public(
    current_setting('test.live_public_id')::uuid
  );
  if public_value ->> 'status' <> 'ok'
    or public_value::text like '%workspaceId%'
    or public_value::text like '%sourceStageId%'
    or public_value::text like '%operatorUserId%'
    or public_value::text like '%Private break title%'
    or public_value::text not like '%Second Band%' then
    raise exception 'Anonymous public DTO allowlist is invalid';
  end if;
end
$anonymous_public_read_contract$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000081', true
);
select public.set_live_timetable_publication(
  current_setting('test.live_id')::uuid,
  '4', false
);

reset role;
set local role anon;
do $unpublished_public_read_contract$
begin
  if public.load_live_timetable_public(
      current_setting('test.live_public_id')::uuid
    ) is not null then
    raise exception 'Unpublished Live remained publicly readable';
  end if;
end
$unpublished_public_read_contract$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000081', true
);
select public.set_live_timetable_publication(
  current_setting('test.live_id')::uuid,
  '5', true
);

reset role;
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '78000000-0000-4000-8000-000000000001',
  'live-without-state', 'No Live State', pg_temp.live_empty_v1_snapshot()
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000081', true
);
do $authorized_delete_contract$
declare
  delete_result jsonb;
begin
  begin
    perform public.delete_cloud_event_authorized(
      '78000000-0000-4000-8000-000000000001',
      'live-foundation-event'
    );
    raise exception 'Referenced Event deletion was accepted' using errcode = 'P0004';
  exception when foreign_key_violation then null;
  end;
  delete_result := public.delete_cloud_event_authorized(
    '78000000-0000-4000-8000-000000000001',
    'live-without-state'
  );
  if delete_result ->> 'status' <> 'deleted' then
    raise exception 'Event without Live state was not deleted';
  end if;
end
$authorized_delete_contract$;

reset role;
do $delete_non_mutation_contract$
begin
  if not exists (
      select 1 from public.cloud_events
      where workspace_id = '78000000-0000-4000-8000-000000000001'
        and event_id = 'live-foundation-event'
    ) or not exists (
      select 1 from public.live_timetables
      where id = current_setting('test.live_id')::uuid
    ) or exists (
      select 1 from public.cloud_events
      where workspace_id = '78000000-0000-4000-8000-000000000001'
        and event_id = 'live-without-state'
    ) then
    raise exception 'Authorized delete Live restriction is not atomic';
  end if;
end
$delete_non_mutation_contract$;

rollback;
