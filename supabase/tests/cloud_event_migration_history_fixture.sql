-- Fixture for a disposable database only. Apply after Auth / Workspace and the
-- known final old Cloud Event base schema have been created, but before history repair.

begin;

insert into public.workspaces (id, name)
values ('51000000-0000-0000-0000-000000000001', 'Migration history fixture');

insert into public.cloud_events (
  workspace_id,
  event_id,
  event_name,
  event_snapshot
) values (
  '51000000-0000-0000-0000-000000000001',
  'migration-history-event',
  'Migration history Event',
  jsonb_build_object(
    'format', 'acappella-tt-cloud-event',
    'version', 1,
    'appState', jsonb_build_object(
      'version', 5,
      'members', jsonb_build_array(),
      'bands', jsonb_build_array(),
      'events', jsonb_build_array(jsonb_build_object(
        'id', 'migration-history-event',
        'name', 'Migration history Event',
        'timeZone', 'Asia/Tokyo',
        'validationPolicy', jsonb_build_object(
          'minimumGapBands', 1,
          'minimumRestMinutes', 10
        ),
        'performanceSlotMinutes', jsonb_build_array(5)
      )),
      'eventDays', jsonb_build_array(),
      'stages', jsonb_build_array(),
      'sections', jsonb_build_array(),
      'eventMembers', jsonb_build_array(),
      'eventMemberDays', jsonb_build_array(),
      'eventBands', jsonb_build_array(),
      'scheduleItems', jsonb_build_array(),
      'paAssignments', jsonb_build_array(),
      'dutyTypes', jsonb_build_array(),
      'dutyAssignments', jsonb_build_array(),
      'timetableLocks', jsonb_build_array(),
      'timetableOrderConstraints', jsonb_build_array()
    )
  )
);

commit;
