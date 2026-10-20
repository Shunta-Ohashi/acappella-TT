-- Add the independent Live TT state foundation. Cloud Event Snapshot V1 stays
-- authoritative for editing; Live mutations never update cloud_events or the
-- Workspace generation.

begin;

create function public.is_live_timetable_event_days_shape(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array'
    or exists (
      select 1
      from jsonb_array_elements(p_value) as day(value)
      where jsonb_typeof(day.value) is distinct from 'object'
        or not (day.value ?& array[
          'sourceEventDayId', 'date', 'label', 'position'
        ])
        or day.value - array[
          'sourceEventDayId', 'date', 'label', 'position'
        ] <> '{}'::jsonb
        or jsonb_typeof(day.value -> 'sourceEventDayId') is distinct from 'string'
        or btrim(day.value ->> 'sourceEventDayId') = ''
        or jsonb_typeof(day.value -> 'date') is distinct from 'string'
        or (day.value ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$'
        or (
          jsonb_typeof(day.value -> 'label') is distinct from 'null'
          and (
            jsonb_typeof(day.value -> 'label') is distinct from 'string'
            or btrim(day.value ->> 'label') = ''
          )
        )
        or jsonb_typeof(day.value -> 'position') is distinct from 'number'
        or (day.value ->> 'position') !~ '^(0|[1-9][0-9]*)$'
    )
    or jsonb_array_length(p_value) <> (
      select count(distinct day.value ->> 'sourceEventDayId')
      from jsonb_array_elements(p_value) as day(value)
    )
    or jsonb_array_length(p_value) <> (
      select count(distinct (day.value ->> 'position')::integer)
      from jsonb_array_elements(p_value) as day(value)
    )
    or exists (
      select 1
      from jsonb_array_elements(p_value) as day(value)
      where (day.value ->> 'position')::integer >= jsonb_array_length(p_value)
    ) then
    return false;
  end if;
  return true;
exception
  when others then
    return false;
end;
$$;

revoke all on function public.is_live_timetable_event_days_shape(jsonb)
  from public, anon, authenticated, service_role;

create function public.is_live_timetable_sections_shape(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array'
    or exists (
      select 1
      from jsonb_array_elements(p_value) as section(value)
      where jsonb_typeof(section.value) is distinct from 'object'
        or not (section.value ?& array[
          'sourceSectionId', 'name', 'position',
          'plannedStartTime', 'plannedEndTime'
        ])
        or section.value - array[
          'sourceSectionId', 'name', 'position',
          'plannedStartTime', 'plannedEndTime'
        ] <> '{}'::jsonb
        or jsonb_typeof(section.value -> 'sourceSectionId') is distinct from 'string'
        or btrim(section.value ->> 'sourceSectionId') = ''
        or jsonb_typeof(section.value -> 'name') is distinct from 'string'
        or btrim(section.value ->> 'name') = ''
        or jsonb_typeof(section.value -> 'position') is distinct from 'number'
        or (section.value ->> 'position') !~ '^(0|[1-9][0-9]*)$'
        or (
          jsonb_typeof(section.value -> 'plannedStartTime') is distinct from 'null'
          and (
            jsonb_typeof(section.value -> 'plannedStartTime') is distinct from 'string'
            or (section.value ->> 'plannedStartTime') !~
              '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
          )
        )
        or (
          jsonb_typeof(section.value -> 'plannedEndTime') is distinct from 'null'
          and (
            jsonb_typeof(section.value -> 'plannedEndTime') is distinct from 'string'
            or (section.value ->> 'plannedEndTime') !~
              '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
          )
        )
    )
    or jsonb_array_length(p_value) <> (
      select count(distinct section.value ->> 'sourceSectionId')
      from jsonb_array_elements(p_value) as section(value)
    )
    or jsonb_array_length(p_value) <> (
      select count(distinct (section.value ->> 'position')::integer)
      from jsonb_array_elements(p_value) as section(value)
    )
    or exists (
      select 1
      from jsonb_array_elements(p_value) as section(value)
      where (section.value ->> 'position')::integer >= jsonb_array_length(p_value)
    ) then
    return false;
  end if;
  return true;
exception
  when others then
    return false;
end;
$$;

revoke all on function public.is_live_timetable_sections_shape(jsonb)
  from public, anon, authenticated, service_role;

create function public.is_live_timetable_projection_shape(
  p_projection jsonb,
  p_event_id text,
  p_event_name text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  stage_value jsonb;
  entry_value jsonb;
begin
  if jsonb_typeof(p_projection) is distinct from 'object'
    or not (p_projection ?& array[
      'format', 'version', 'eventId', 'eventName', 'timeZone',
      'eventDays', 'stages'
    ])
    or p_projection - array[
      'format', 'version', 'eventId', 'eventName', 'timeZone',
      'eventDays', 'stages'
    ] <> '{}'::jsonb
    or (p_projection -> 'format') is distinct from
      to_jsonb('acappella-tt-live-timetable-projection'::text)
    or (p_projection -> 'version') is distinct from '1'::jsonb
    or (p_projection -> 'eventId') is distinct from to_jsonb(p_event_id)
    or (p_projection -> 'eventName') is distinct from to_jsonb(p_event_name)
    or jsonb_typeof(p_projection -> 'timeZone') is distinct from 'string'
    or btrim(p_projection ->> 'timeZone') = ''
    or not public.is_live_timetable_event_days_shape(
      p_projection -> 'eventDays'
    )
    or jsonb_typeof(p_projection -> 'stages') is distinct from 'array' then
    return false;
  end if;

  for stage_value in
    select stage.value
    from jsonb_array_elements(p_projection -> 'stages') as stage(value)
  loop
    if jsonb_typeof(stage_value) is distinct from 'object'
      or not (stage_value ?& array[
        'sourceEventDayId', 'eventDayPosition', 'sourceStageId', 'name', 'position',
        'plannedStartTime', 'plannedEndTime', 'sections', 'entries'
      ])
      or stage_value - array[
        'sourceEventDayId', 'eventDayPosition', 'sourceStageId', 'name', 'position',
        'plannedStartTime', 'plannedEndTime', 'sections', 'entries'
      ] <> '{}'::jsonb
      or jsonb_typeof(stage_value -> 'sourceEventDayId') is distinct from 'string'
      or btrim(stage_value ->> 'sourceEventDayId') = ''
      or not exists (
        select 1
        from jsonb_array_elements(p_projection -> 'eventDays') as day(value)
        where day.value ->> 'sourceEventDayId' =
          stage_value ->> 'sourceEventDayId'
      )
      or jsonb_typeof(stage_value -> 'eventDayPosition') is distinct from 'number'
      or (stage_value ->> 'eventDayPosition') !~ '^(0|[1-9][0-9]*)$'
      or (stage_value ->> 'eventDayPosition')::integer >=
        jsonb_array_length(p_projection -> 'eventDays')
      or not exists (
        select 1
        from jsonb_array_elements(p_projection -> 'eventDays') as day(value)
        where (day.value ->> 'position')::integer =
          (stage_value ->> 'eventDayPosition')::integer
          and day.value ->> 'sourceEventDayId' =
            stage_value ->> 'sourceEventDayId'
      )
      or jsonb_typeof(stage_value -> 'sourceStageId') is distinct from 'string'
      or btrim(stage_value ->> 'sourceStageId') = ''
      or jsonb_typeof(stage_value -> 'name') is distinct from 'string'
      or btrim(stage_value ->> 'name') = ''
      or jsonb_typeof(stage_value -> 'position') is distinct from 'number'
      or (stage_value ->> 'position') !~ '^(0|[1-9][0-9]*)$'
      or jsonb_typeof(stage_value -> 'plannedStartTime') is distinct from 'string'
      or (stage_value ->> 'plannedStartTime') !~
        '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
      or (
        jsonb_typeof(stage_value -> 'plannedEndTime') is distinct from 'null'
        and (
          jsonb_typeof(stage_value -> 'plannedEndTime') is distinct from 'string'
          or (stage_value ->> 'plannedEndTime') !~
            '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
        )
      )
      or not public.is_live_timetable_sections_shape(stage_value -> 'sections')
      or jsonb_typeof(stage_value -> 'entries') is distinct from 'array'
      or jsonb_array_length(stage_value -> 'entries') <> (
        select count(distinct entry.value ->> 'sourceScheduleItemId')
        from jsonb_array_elements(stage_value -> 'entries') as entry(value)
      )
      or jsonb_array_length(stage_value -> 'entries') <> (
        select count(distinct (entry.value ->> 'position')::integer)
        from jsonb_array_elements(stage_value -> 'entries') as entry(value)
      ) then
      return false;
    end if;

    for entry_value in
      select entry.value
      from jsonb_array_elements(stage_value -> 'entries') as entry(value)
    loop
      if jsonb_typeof(entry_value) is distinct from 'object'
        or not (entry_value ?& array[
          'sourceScheduleItemId', 'sourceSectionId', 'afterSectionId',
          'kind', 'position', 'displayName',
          'plannedStartMinute', 'plannedEndMinute'
        ])
        or entry_value - array[
          'sourceScheduleItemId', 'sourceSectionId', 'afterSectionId',
          'kind', 'position', 'displayName',
          'plannedStartMinute', 'plannedEndMinute'
        ] <> '{}'::jsonb
        or jsonb_typeof(entry_value -> 'sourceScheduleItemId') is distinct from 'string'
        or btrim(entry_value ->> 'sourceScheduleItemId') = ''
        or jsonb_typeof(entry_value -> 'kind') is distinct from 'string'
        or entry_value ->> 'kind' not in ('performance', 'break')
        or jsonb_typeof(entry_value -> 'position') is distinct from 'number'
        or (entry_value ->> 'position') !~ '^(0|[1-9][0-9]*)$'
        or (entry_value ->> 'position')::integer >=
          jsonb_array_length(stage_value -> 'entries')
        or jsonb_typeof(entry_value -> 'displayName') is distinct from 'string'
        or btrim(entry_value ->> 'displayName') = ''
        or jsonb_typeof(entry_value -> 'plannedStartMinute') is distinct from 'number'
        or (entry_value ->> 'plannedStartMinute') !~ '^(0|[1-9][0-9]*)$'
        or jsonb_typeof(entry_value -> 'plannedEndMinute') is distinct from 'number'
        or (entry_value ->> 'plannedEndMinute') !~ '^(0|[1-9][0-9]*)$'
        or (entry_value ->> 'plannedEndMinute')::integer <
          (entry_value ->> 'plannedStartMinute')::integer
        or (
          jsonb_typeof(entry_value -> 'sourceSectionId') is distinct from 'null'
          and (
            jsonb_typeof(entry_value -> 'sourceSectionId') is distinct from 'string'
            or not exists (
              select 1
              from jsonb_array_elements(stage_value -> 'sections') as section(value)
              where section.value ->> 'sourceSectionId' =
                entry_value ->> 'sourceSectionId'
            )
          )
        )
        or (
          jsonb_typeof(entry_value -> 'afterSectionId') is distinct from 'null'
          and (
            entry_value ->> 'kind' <> 'break'
            or jsonb_typeof(entry_value -> 'afterSectionId') is distinct from 'string'
            or not exists (
              select 1
              from jsonb_array_elements(stage_value -> 'sections') as section(value)
              where section.value ->> 'sourceSectionId' =
                entry_value ->> 'afterSectionId'
            )
          )
        )
        or (
          jsonb_typeof(entry_value -> 'sourceSectionId') = 'string'
          and jsonb_typeof(entry_value -> 'afterSectionId') = 'string'
        )
        or (
          entry_value ->> 'kind' = 'break'
          and entry_value ->> 'displayName' <> '休憩'
        ) then
        return false;
      end if;
    end loop;
  end loop;

  if jsonb_array_length(p_projection -> 'stages') <> (
      select count(distinct stage.value ->> 'sourceStageId')
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
    )
    or jsonb_array_length(p_projection -> 'stages') <> (
      select count(distinct (stage.value ->> 'position')::integer)
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
    )
    or exists (
      select 1
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
      where (stage.value ->> 'position')::integer >=
        jsonb_array_length(p_projection -> 'stages')
    )
    or (
      select count(*)
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
      cross join lateral jsonb_array_elements(stage.value -> 'sections')
        as section(value)
    ) <> (
      select count(distinct section.value ->> 'sourceSectionId')
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
      cross join lateral jsonb_array_elements(stage.value -> 'sections')
        as section(value)
    )
    or (
      select count(*)
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
      cross join lateral jsonb_array_elements(stage.value -> 'entries')
        as entry(value)
    ) <> (
      select count(distinct entry.value ->> 'sourceScheduleItemId')
      from jsonb_array_elements(p_projection -> 'stages') as stage(value)
      cross join lateral jsonb_array_elements(stage.value -> 'entries')
        as entry(value)
    ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

revoke all on function public.is_live_timetable_projection_shape(jsonb, text, text)
  from public, anon, authenticated, service_role;

create table public.live_timetables (
  id uuid primary key default extensions.gen_random_uuid(),
  public_id uuid not null unique default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  event_id text not null check (btrim(event_id) <> ''),
  event_name text not null check (btrim(event_name) <> ''),
  time_zone text not null check (btrim(time_zone) <> ''),
  event_days jsonb not null
    check (public.is_live_timetable_event_days_shape(event_days)),
  source_event_revision bigint not null check (source_event_revision > 0),
  source_snapshot_fingerprint text not null
    check (source_snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  projection_version bigint not null default 1 check (projection_version > 0),
  management_revision bigint not null default 1 check (management_revision > 0),
  is_published boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, event_id),
  unique (workspace_id, id),
  foreign key (workspace_id, event_id)
    references public.cloud_events(workspace_id, event_id)
    on delete restrict
);

create table public.live_timetable_stages (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  live_timetable_id uuid not null,
  source_event_day_id text not null check (btrim(source_event_day_id) <> ''),
  event_day_position integer not null check (event_day_position >= 0),
  source_stage_id text not null check (btrim(source_stage_id) <> ''),
  name text not null check (btrim(name) <> ''),
  position integer not null check (position >= 0),
  planned_start_time text not null
    check (planned_start_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  planned_end_time text
    check (planned_end_time is null or
      planned_end_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  sections jsonb not null
    check (public.is_live_timetable_sections_shape(sections)),
  projection_version bigint not null check (projection_version > 0),
  revision bigint not null default 1 check (revision > 0),
  progress_status text not null
    check (progress_status in (
      'empty', 'not_started', 'waiting', 'in_progress', 'completed'
    )),
  current_entry_position integer check (current_entry_position >= 0),
  next_entry_position integer check (next_entry_position >= 0),
  next_performance_position integer check (next_performance_position >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  unique (live_timetable_id, source_stage_id),
  unique (live_timetable_id, position),
  unique (workspace_id, live_timetable_id, id),
  foreign key (workspace_id, live_timetable_id)
    references public.live_timetables(workspace_id, id)
    on delete cascade,
  check (
    (progress_status = 'in_progress' and current_entry_position is not null)
    or (progress_status <> 'in_progress' and current_entry_position is null)
  ),
  check (
    (progress_status = 'empty'
      and next_entry_position is null
      and next_performance_position is null)
    or progress_status <> 'empty'
  )
);

create table public.live_timetable_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  live_timetable_id uuid not null,
  stage_id uuid not null,
  source_schedule_item_id text not null
    check (btrim(source_schedule_item_id) <> ''),
  source_section_id text,
  after_section_id text,
  kind text not null check (kind in ('performance', 'break')),
  position integer not null check (position >= 0),
  display_name text not null check (btrim(display_name) <> ''),
  planned_start_minute integer not null check (planned_start_minute >= 0),
  planned_end_minute integer not null
    check (planned_end_minute >= planned_start_minute),
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed')),
  actual_started_at timestamptz,
  actual_ended_at timestamptz,
  started_by uuid,
  ended_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (stage_id, source_schedule_item_id),
  unique (stage_id, position),
  foreign key (workspace_id, live_timetable_id, stage_id)
    references public.live_timetable_stages(
      workspace_id, live_timetable_id, id
    )
    on delete cascade,
  check (source_section_id is null or btrim(source_section_id) <> ''),
  check (after_section_id is null or btrim(after_section_id) <> ''),
  check (source_section_id is null or after_section_id is null),
  check (kind = 'break' or after_section_id is null),
  check (kind <> 'break' or display_name = '休憩'),
  check (
    (status = 'pending'
      and actual_started_at is null
      and actual_ended_at is null
      and started_by is null
      and ended_by is null)
    or (status = 'in_progress'
      and actual_started_at is not null
      and actual_ended_at is null
      and started_by is not null
      and ended_by is null)
    or (status = 'completed'
      and actual_started_at is not null
      and actual_ended_at is not null
      and started_by is not null
      and ended_by is not null
      and actual_ended_at >= actual_started_at)
  )
);

create unique index live_timetable_entries_one_in_progress_idx
  on public.live_timetable_entries(stage_id)
  where status = 'in_progress';

create index live_timetable_entries_order_idx
  on public.live_timetable_entries(stage_id, position);

create table public.live_timetable_stage_operators (
  workspace_id uuid not null,
  live_timetable_id uuid not null,
  stage_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (stage_id, user_id),
  foreign key (workspace_id, live_timetable_id, stage_id)
    references public.live_timetable_stages(
      workspace_id, live_timetable_id, id
    )
    on delete cascade,
  foreign key (workspace_id, user_id)
    references public.workspace_members(workspace_id, user_id)
    on delete cascade
);

create index live_timetable_stage_operators_user_idx
  on public.live_timetable_stage_operators(workspace_id, user_id);

create function public.populate_live_timetable_projection(
  p_workspace_id uuid,
  p_live_id uuid,
  p_projection jsonb,
  p_projection_version bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  stage_value jsonb;
  entry_value jsonb;
  inserted_stage_id uuid;
  stage_entry_count integer;
  first_performance_position integer;
begin
  for stage_value in
    select stage.value
    from jsonb_array_elements(p_projection -> 'stages') as stage(value)
    order by (stage.value ->> 'position')::integer
  loop
    stage_entry_count := jsonb_array_length(stage_value -> 'entries');
    select min((entry.value ->> 'position')::integer)
      into first_performance_position
      from jsonb_array_elements(stage_value -> 'entries') as entry(value)
      where entry.value ->> 'kind' = 'performance';

    insert into public.live_timetable_stages (
      workspace_id,
      live_timetable_id,
      source_event_day_id,
      event_day_position,
      source_stage_id,
      name,
      position,
      planned_start_time,
      planned_end_time,
      sections,
      projection_version,
      revision,
      progress_status,
      current_entry_position,
      next_entry_position,
      next_performance_position
    ) values (
      p_workspace_id,
      p_live_id,
      stage_value ->> 'sourceEventDayId',
      (stage_value ->> 'eventDayPosition')::integer,
      stage_value ->> 'sourceStageId',
      stage_value ->> 'name',
      (stage_value ->> 'position')::integer,
      stage_value ->> 'plannedStartTime',
      stage_value ->> 'plannedEndTime',
      stage_value -> 'sections',
      p_projection_version,
      1,
      case when stage_entry_count = 0 then 'empty' else 'not_started' end,
      null,
      case when stage_entry_count = 0 then null else 0 end,
      first_performance_position
    )
    returning id into inserted_stage_id;

    for entry_value in
      select entry.value
      from jsonb_array_elements(stage_value -> 'entries') as entry(value)
      order by (entry.value ->> 'position')::integer
    loop
      insert into public.live_timetable_entries (
        workspace_id,
        live_timetable_id,
        stage_id,
        source_schedule_item_id,
        source_section_id,
        after_section_id,
        kind,
        position,
        display_name,
        planned_start_minute,
        planned_end_minute
      ) values (
        p_workspace_id,
        p_live_id,
        inserted_stage_id,
        entry_value ->> 'sourceScheduleItemId',
        entry_value ->> 'sourceSectionId',
        entry_value ->> 'afterSectionId',
        entry_value ->> 'kind',
        (entry_value ->> 'position')::integer,
        entry_value ->> 'displayName',
        (entry_value ->> 'plannedStartMinute')::integer,
        (entry_value ->> 'plannedEndMinute')::integer
      );
    end loop;
  end loop;
end;
$$;

revoke all on function public.populate_live_timetable_projection(
  uuid, uuid, jsonb, bigint
) from public, anon, authenticated, service_role;

create function public.load_live_timetable_projection_source(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_event_id text,
  p_expected_source_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  membership_role text;
  source_row record;
begin
  if p_actor_id is null
    or p_workspace_id is null
    or p_event_id is null
    or btrim(p_event_id) = ''
    or p_expected_source_revision is null
    or p_expected_source_revision <= 0 then
    raise exception 'Live projection source arguments are invalid'
      using errcode = '22023';
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = p_workspace_id
    and workspace_members.user_id = p_actor_id
  for share;

  if membership_role is distinct from 'owner' then
    raise exception 'Live projection creation requires Workspace owner access'
      using errcode = '42501';
  end if;

  select
    cloud_events.workspace_id,
    cloud_events.event_id,
    cloud_events.event_name,
    cloud_events.event_snapshot,
    cloud_events.revision
  into source_row
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id
    and cloud_events.event_id = p_event_id
  for share;

  if not found then
    raise exception 'Cloud Event for Live projection was not found'
      using errcode = 'P0002';
  end if;
  if source_row.revision <> p_expected_source_revision then
    raise exception 'Cloud Event revision changed before Live projection'
      using errcode = '40001';
  end if;
  if (source_row.event_snapshot -> 'version') is distinct from '1'::jsonb then
    raise exception 'Live projection currently requires Snapshot V1'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'workspace_id', source_row.workspace_id,
    'event_id', source_row.event_id,
    'event_name', source_row.event_name,
    'event_snapshot', source_row.event_snapshot,
    'revision', source_row.revision,
    'snapshot_fingerprint', encode(
      extensions.digest(source_row.event_snapshot::text, 'sha256'),
      'hex'
    )
  );
end;
$$;

revoke all on function public.load_live_timetable_projection_source(
  uuid, uuid, text, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.load_live_timetable_projection_source(
  uuid, uuid, text, bigint
) to service_role;

create function public.create_or_replace_live_timetable_projection(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_event_id text,
  p_expected_source_revision bigint,
  p_source_snapshot_fingerprint text,
  p_projection jsonb,
  p_mode text,
  p_expected_management_revision text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  membership_role text;
  source_row record;
  live_row record;
  actual_fingerprint text;
  target_live_id uuid;
  target_public_id uuid;
  next_projection_version bigint;
  next_management_revision bigint;
begin
  if p_actor_id is null
    or p_workspace_id is null
    or p_event_id is null
    or btrim(p_event_id) = ''
    or p_expected_source_revision is null
    or p_expected_source_revision <= 0
    or p_source_snapshot_fingerprint is null
    or p_source_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
    or p_mode is null
    or p_mode not in ('create', 'replace')
    or (p_mode = 'create' and p_expected_management_revision is not null)
    or (p_mode = 'replace' and not (
      p_expected_management_revision is not null
      and p_expected_management_revision ~ '^[1-9][0-9]*$'
      and (
        length(p_expected_management_revision) < 19
        or (
          length(p_expected_management_revision) = 19
          and p_expected_management_revision <= '9223372036854775807'
        )
      )
    )) then
    raise exception 'Live projection mutation arguments are invalid'
      using errcode = '22023';
  end if;

  -- Mutation lock order: caller membership -> source Event -> Live -> Stages.
  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = p_workspace_id
    and workspace_members.user_id = p_actor_id
  for share;

  if membership_role is distinct from 'owner' then
    raise exception 'Live projection mutation requires Workspace owner access'
      using errcode = '42501';
  end if;

  select
    cloud_events.event_name,
    cloud_events.event_snapshot,
    cloud_events.revision
  into source_row
  from public.cloud_events
  where cloud_events.workspace_id = p_workspace_id
    and cloud_events.event_id = p_event_id
  for share;

  if not found then
    raise exception 'Cloud Event for Live projection was not found'
      using errcode = 'P0002';
  end if;

  actual_fingerprint := encode(
    extensions.digest(source_row.event_snapshot::text, 'sha256'),
    'hex'
  );
  if source_row.revision <> p_expected_source_revision
    or actual_fingerprint <> p_source_snapshot_fingerprint then
    raise exception 'Cloud Event changed before Live projection commit'
      using errcode = '40001';
  end if;
  if (source_row.event_snapshot -> 'version') is distinct from '1'::jsonb
    or not public.is_live_timetable_projection_shape(
      p_projection,
      p_event_id,
      source_row.event_name
    ) then
    raise exception 'Live projection is invalid'
      using errcode = '22023';
  end if;

  select
    live_timetables.id,
    live_timetables.public_id,
    live_timetables.management_revision,
    live_timetables.projection_version,
    live_timetables.is_published
  into live_row
  from public.live_timetables
  where live_timetables.workspace_id = p_workspace_id
    and live_timetables.event_id = p_event_id
  for update;

  if p_mode = 'create' then
    if found then
      raise exception 'Live Timetable already exists'
        using errcode = '23505';
    end if;
    target_live_id := extensions.gen_random_uuid();
    target_public_id := extensions.gen_random_uuid();
    next_projection_version := 1;
    next_management_revision := 1;

    insert into public.live_timetables (
      id,
      public_id,
      workspace_id,
      event_id,
      event_name,
      time_zone,
      event_days,
      source_event_revision,
      source_snapshot_fingerprint,
      projection_version,
      management_revision,
      is_published
    ) values (
      target_live_id,
      target_public_id,
      p_workspace_id,
      p_event_id,
      source_row.event_name,
      p_projection ->> 'timeZone',
      p_projection -> 'eventDays',
      source_row.revision,
      actual_fingerprint,
      next_projection_version,
      next_management_revision,
      false
    );
  else
    if not found then
      raise exception 'Live Timetable does not exist'
        using errcode = 'P0002';
    end if;
    if live_row.management_revision < 1
      or p_expected_management_revision::bigint < 1
      or live_row.management_revision <>
        p_expected_management_revision::bigint then
      raise exception 'Live Timetable management revision changed'
        using errcode = '40001';
    end if;
    if live_row.is_published then
      raise exception 'Published Live projection cannot be replaced'
        using errcode = '55000';
    end if;

    perform 1
    from public.live_timetable_stages
    where live_timetable_stages.live_timetable_id = live_row.id
    order by live_timetable_stages.id
    for update;

    if exists (
      select 1
      from public.live_timetable_entries
      where live_timetable_entries.live_timetable_id = live_row.id
        and (
          live_timetable_entries.status <> 'pending'
          or live_timetable_entries.actual_started_at is not null
          or live_timetable_entries.started_by is not null
        )
    ) then
      raise exception 'Started Live projection cannot be replaced'
        using errcode = '55000';
    end if;

    target_live_id := live_row.id;
    target_public_id := live_row.public_id;
    next_projection_version := live_row.projection_version + 1;
    next_management_revision := live_row.management_revision + 1;

    -- Assignment IDs are tied to the old Stage projection and never inherit
    -- across replacement. Entry rows cascade when Stage rows are removed.
    delete from public.live_timetable_stage_operators
    where live_timetable_stage_operators.live_timetable_id = target_live_id;
    delete from public.live_timetable_stages
    where live_timetable_stages.live_timetable_id = target_live_id;

    update public.live_timetables
    set event_name = source_row.event_name,
        time_zone = p_projection ->> 'timeZone',
        event_days = p_projection -> 'eventDays',
        source_event_revision = source_row.revision,
        source_snapshot_fingerprint = actual_fingerprint,
        projection_version = next_projection_version,
        management_revision = next_management_revision,
        updated_at = clock_timestamp()
    where id = target_live_id;
  end if;

  perform public.populate_live_timetable_projection(
    p_workspace_id,
    target_live_id,
    p_projection,
    next_projection_version
  );

  return jsonb_build_object(
    'status', case when p_mode = 'create' then 'created' else 'replaced' end,
    'workspaceId', p_workspace_id,
    'eventId', p_event_id,
    'liveId', target_live_id,
    'publicId', target_public_id,
    'sourceRevision', source_row.revision,
    'sourceSnapshotFingerprint', actual_fingerprint,
    'projectionVersion', next_projection_version::text,
    'managementRevision', next_management_revision::text,
    'isPublished', false
  );
end;
$$;

revoke all on function public.create_or_replace_live_timetable_projection(
  uuid, uuid, text, bigint, text, jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_replace_live_timetable_projection(
  uuid, uuid, text, bigint, text, jsonb, text, text
) to service_role;

create function public.build_live_timetable_stages_json(
  p_live_id uuid,
  p_actor_id uuid,
  p_membership_role text,
  p_public boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      case when p_public then
        jsonb_build_object(
          'name', stage.name,
          'eventDayPosition', stage.event_day_position,
          'position', stage.position,
          'plannedStartTime', stage.planned_start_time,
          'plannedEndTime', stage.planned_end_time,
          'sections', (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'name', section.value ->> 'name',
                'position', (section.value ->> 'position')::integer,
                'plannedStartTime', section.value -> 'plannedStartTime',
                'plannedEndTime', section.value -> 'plannedEndTime'
              ) order by (section.value ->> 'position')::integer
            ), '[]'::jsonb)
            from jsonb_array_elements(stage.sections) as section(value)
          ),
          'revision', stage.revision::text,
          'projectionVersion', stage.projection_version::text,
          'progressStatus', stage.progress_status,
          'currentEntryPosition', stage.current_entry_position,
          'nextEntryPosition', stage.next_entry_position,
          'nextPerformancePosition', stage.next_performance_position,
          'updatedAt', stage.updated_at,
          'entries', (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'position', entry.position,
                'kind', entry.kind,
                'displayName', entry.display_name,
                'plannedStartMinute', entry.planned_start_minute,
                'plannedEndMinute', entry.planned_end_minute,
                'status', entry.status,
                'actualStartedAt', entry.actual_started_at,
                'actualEndedAt', entry.actual_ended_at
              ) order by entry.position
            ), '[]'::jsonb)
            from public.live_timetable_entries as entry
            where entry.stage_id = stage.id
          )
        )
      else
        jsonb_build_object(
          'stageId', stage.id,
          'sourceEventDayId', stage.source_event_day_id,
          'sourceStageId', stage.source_stage_id,
          'name', stage.name,
          'eventDayPosition', stage.event_day_position,
          'position', stage.position,
          'plannedStartTime', stage.planned_start_time,
          'plannedEndTime', stage.planned_end_time,
          'sections', stage.sections,
          'revision', stage.revision::text,
          'projectionVersion', stage.projection_version::text,
          'progressStatus', stage.progress_status,
          'currentEntryPosition', stage.current_entry_position,
          'nextEntryPosition', stage.next_entry_position,
          'nextPerformancePosition', stage.next_performance_position,
          'updatedAt', stage.updated_at,
          'canOperate', (
            p_membership_role = 'owner'
            or (
              p_membership_role = 'editor'
              and exists (
                select 1
                from public.live_timetable_stage_operators as assignment
                where assignment.stage_id = stage.id
                  and assignment.user_id = p_actor_id
              )
            )
          ),
          'entries', (
            select coalesce(jsonb_agg(
              jsonb_build_object(
                'sourceScheduleItemId', entry.source_schedule_item_id,
                'sourceSectionId', entry.source_section_id,
                'afterSectionId', entry.after_section_id,
                'position', entry.position,
                'kind', entry.kind,
                'displayName', entry.display_name,
                'plannedStartMinute', entry.planned_start_minute,
                'plannedEndMinute', entry.planned_end_minute,
                'status', entry.status,
                'actualStartedAt', entry.actual_started_at,
                'actualEndedAt', entry.actual_ended_at,
                'startedBy', entry.started_by,
                'endedBy', entry.ended_by
              ) order by entry.position
            ), '[]'::jsonb)
            from public.live_timetable_entries as entry
            where entry.stage_id = stage.id
          )
        )
      end
      order by stage.position
    ),
    '[]'::jsonb
  )
  from public.live_timetable_stages as stage
  where stage.live_timetable_id = p_live_id;
$$;

revoke all on function public.build_live_timetable_stages_json(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;

create function public.load_live_timetable_authorized(p_live_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  membership_role text;
  live_row record;
  operators_json jsonb;
  stages_json jsonb;
begin
  if caller_id is null then
    raise exception 'Live Timetable read requires authentication'
      using errcode = '42501';
  end if;
  if p_live_id is null then
    raise exception 'Live Timetable ID is required'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id
  for share;
  if membership_role is null
    or membership_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Live Timetable read is not permitted'
      using errcode = '42501';
  end if;

  select * into live_row
  from public.live_timetables
  where live_timetables.id = p_live_id
    and live_timetables.workspace_id = target_workspace_id
  for share;
  if not found then
    raise exception 'Live Timetable changed during read'
      using errcode = '40001';
  end if;

  perform 1
  from public.live_timetable_stages
  where live_timetable_stages.live_timetable_id = p_live_id
  order by live_timetable_stages.id
  for share;

  stages_json := public.build_live_timetable_stages_json(
    p_live_id,
    caller_id,
    membership_role,
    false
  );

  if membership_role = 'owner' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'stageId', assignment.stage_id,
      'userId', assignment.user_id
    ) order by assignment.stage_id, assignment.user_id), '[]'::jsonb)
    into operators_json
    from public.live_timetable_stage_operators as assignment
    where assignment.live_timetable_id = p_live_id;
  else
    operators_json := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'live', jsonb_build_object(
      'liveId', live_row.id,
      'publicId', live_row.public_id,
      'workspaceId', live_row.workspace_id,
      'eventId', live_row.event_id,
      'eventName', live_row.event_name,
      'timeZone', live_row.time_zone,
      'eventDays', live_row.event_days,
      'sourceRevision', live_row.source_event_revision,
      'sourceSnapshotFingerprint', live_row.source_snapshot_fingerprint,
      'projectionVersion', live_row.projection_version::text,
      'managementRevision', live_row.management_revision::text,
      'isPublished', live_row.is_published,
      'createdAt', live_row.created_at,
      'updatedAt', live_row.updated_at
    ),
    'permissions', jsonb_build_object(
      'role', membership_role,
      'canManage', membership_role = 'owner'
    ),
    'operators', operators_json,
    'stages', stages_json
  );
end;
$$;

revoke all on function public.load_live_timetable_authorized(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_live_timetable_authorized(uuid)
  to authenticated;

create function public.load_live_timetable_public(p_public_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  live_row record;
  public_days jsonb;
  stages_json jsonb;
begin
  if p_public_id is null then
    return null;
  end if;

  select * into live_row
  from public.live_timetables
  where live_timetables.public_id = p_public_id
    and live_timetables.is_published
  for share;
  if not found then
    return null;
  end if;

  perform 1
  from public.live_timetable_stages
  where live_timetable_stages.live_timetable_id = live_row.id
  order by live_timetable_stages.id
  for share;

  select coalesce(jsonb_agg(jsonb_build_object(
    'date', day.value ->> 'date',
    'position', (day.value ->> 'position')::integer
  ) order by (day.value ->> 'position')::integer), '[]'::jsonb)
  into public_days
  from jsonb_array_elements(live_row.event_days) as day(value);

  stages_json := public.build_live_timetable_stages_json(
    live_row.id,
    null,
    null,
    true
  );

  return jsonb_build_object(
    'status', 'ok',
    'live', jsonb_build_object(
      'publicId', live_row.public_id,
      'eventName', live_row.event_name,
      'timeZone', live_row.time_zone,
      'projectionVersion', live_row.projection_version::text,
      'managementRevision', live_row.management_revision::text,
      'eventDays', public_days
    ),
    'stages', stages_json
  );
end;
$$;

revoke all on function public.load_live_timetable_public(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_live_timetable_public(uuid)
  to anon, authenticated;

create function public.is_live_timetable_revision_text(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
    and p_value ~ '^[1-9][0-9]*$'
    and (
      length(p_value) < 19
      or (
        length(p_value) = 19
        and p_value <= '9223372036854775807'
      )
    );
$$;

revoke all on function public.is_live_timetable_revision_text(text)
  from public, anon, authenticated, service_role;

create function public.set_live_timetable_publication(
  p_live_id uuid,
  p_expected_management_revision text,
  p_published boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  membership_role text;
  live_row record;
  changed_at timestamptz;
begin
  if caller_id is null then
    raise exception 'Live publication mutation requires authentication'
      using errcode = '42501';
  end if;
  if p_live_id is null
    or not public.is_live_timetable_revision_text(
      p_expected_management_revision
    )
    or p_published is null then
    raise exception 'Live publication mutation arguments are invalid'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id
  for share;
  if membership_role is distinct from 'owner' then
    raise exception 'Only a Workspace owner can change Live publication'
      using errcode = '42501';
  end if;

  select * into live_row
  from public.live_timetables
  where live_timetables.id = p_live_id
    and live_timetables.workspace_id = target_workspace_id
  for update;
  if not found then
    raise exception 'Live Timetable changed during publication mutation'
      using errcode = '40001';
  end if;
  if live_row.management_revision <>
    p_expected_management_revision::bigint then
    raise exception 'Live management revision changed'
      using errcode = '40001';
  end if;

  if live_row.is_published is distinct from p_published then
    changed_at := clock_timestamp();
    update public.live_timetables
    set is_published = p_published,
        management_revision = management_revision + 1,
        updated_at = changed_at
    where id = p_live_id
    returning * into live_row;

    -- Publication changes are signalled by harmless Stage metadata updates.
    -- Stage CAS revisions remain unchanged.
    update public.live_timetable_stages
    set updated_at = changed_at
    where live_timetable_id = p_live_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'liveId', live_row.id,
    'projectionVersion', live_row.projection_version::text,
    'managementRevision', live_row.management_revision::text,
    'isPublished', live_row.is_published
  );
end;
$$;

revoke all on function public.set_live_timetable_publication(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_live_timetable_publication(uuid, text, boolean)
  to authenticated;

create function public.set_live_timetable_stage_operator(
  p_live_id uuid,
  p_source_stage_id text,
  p_operator_user_id uuid,
  p_assign boolean,
  p_expected_management_revision text,
  p_expected_projection_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  caller_role text;
  operator_role text;
  live_row record;
  target_stage_id uuid;
  changed_count integer;
  changed_at timestamptz;
begin
  if caller_id is null then
    raise exception 'Live operator mutation requires authentication'
      using errcode = '42501';
  end if;
  if p_live_id is null
    or p_source_stage_id is null
    or btrim(p_source_stage_id) = ''
    or p_operator_user_id is null
    or p_assign is null
    or not public.is_live_timetable_revision_text(
      p_expected_management_revision
    )
    or not public.is_live_timetable_revision_text(
      p_expected_projection_version
    ) then
    raise exception 'Live operator mutation arguments are invalid'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  -- Lock every involved membership in stable user-ID order before Live rows.
  perform 1
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id in (caller_id, p_operator_user_id)
  order by workspace_members.user_id
  for share;

  select workspace_members.role into caller_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id;
  select workspace_members.role into operator_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = p_operator_user_id;

  if caller_role is distinct from 'owner' then
    raise exception 'Only a Workspace owner can manage Live operators'
      using errcode = '42501';
  end if;
  if p_assign and operator_role is distinct from 'editor' then
    raise exception 'Live Stage operator must be a current editor'
      using errcode = 'LTT01';
  end if;

  select * into live_row
  from public.live_timetables
  where live_timetables.id = p_live_id
    and live_timetables.workspace_id = target_workspace_id
  for update;
  if not found then
    raise exception 'Live Timetable changed during operator mutation'
      using errcode = '40001';
  end if;
  if live_row.management_revision <>
      p_expected_management_revision::bigint
    or live_row.projection_version <>
      p_expected_projection_version::bigint then
    raise exception 'Live operator mutation is stale'
      using errcode = '40001';
  end if;

  select live_timetable_stages.id into target_stage_id
  from public.live_timetable_stages
  where live_timetable_stages.live_timetable_id = p_live_id
    and live_timetable_stages.source_stage_id = p_source_stage_id
    and live_timetable_stages.projection_version = live_row.projection_version
  for share;
  if target_stage_id is null then
    raise exception 'Live Stage was not found'
      using errcode = 'P0002';
  end if;

  if p_assign then
    insert into public.live_timetable_stage_operators (
      workspace_id, live_timetable_id, stage_id, user_id
    ) values (
      target_workspace_id, p_live_id, target_stage_id, p_operator_user_id
    ) on conflict do nothing;
  else
    delete from public.live_timetable_stage_operators
    where live_timetable_stage_operators.stage_id = target_stage_id
      and live_timetable_stage_operators.user_id = p_operator_user_id;
  end if;
  get diagnostics changed_count = row_count;

  if changed_count > 0 then
    changed_at := clock_timestamp();
    update public.live_timetables
    set management_revision = management_revision + 1,
        updated_at = changed_at
    where id = p_live_id
    returning * into live_row;
    update public.live_timetable_stages
    set updated_at = changed_at
    where id = target_stage_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'liveId', live_row.id,
    'stageId', target_stage_id,
    'operatorUserId', p_operator_user_id,
    'assigned', p_assign,
    'projectionVersion', live_row.projection_version::text,
    'managementRevision', live_row.management_revision::text
  );
end;
$$;

revoke all on function public.set_live_timetable_stage_operator(
  uuid, text, uuid, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_live_timetable_stage_operator(
  uuid, text, uuid, boolean, text, text
) to authenticated;

create function public.transition_live_timetable_entry(
  p_operation text,
  p_live_id uuid,
  p_source_stage_id text,
  p_source_schedule_item_id text,
  p_expected_stage_revision text,
  p_expected_projection_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_workspace_id uuid;
  membership_role text;
  live_row record;
  stage_row record;
  entry_row record;
  first_pending_position integer;
  v_next_entry_position integer;
  v_next_performance_position integer;
  pending_count integer;
  operation_time timestamptz;
  next_progress_status text;
begin
  if caller_id is null then
    raise exception 'Live progress mutation requires authentication'
      using errcode = '42501';
  end if;
  if p_operation is null
    or p_operation not in ('start', 'end')
    or p_live_id is null
    or p_source_stage_id is null
    or btrim(p_source_stage_id) = ''
    or p_source_schedule_item_id is null
    or btrim(p_source_schedule_item_id) = ''
    or not public.is_live_timetable_revision_text(p_expected_stage_revision)
    or not public.is_live_timetable_revision_text(
      p_expected_projection_version
    ) then
    raise exception 'Live progress mutation arguments are invalid'
      using errcode = '22023';
  end if;

  select live_timetables.workspace_id into target_workspace_id
  from public.live_timetables
  where live_timetables.id = p_live_id;
  if target_workspace_id is null then
    raise exception 'Live Timetable was not found'
      using errcode = 'P0002';
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = target_workspace_id
    and workspace_members.user_id = caller_id
  for share;
  if membership_role is null
    or membership_role not in ('owner', 'editor') then
    raise exception 'Live progress mutation is not permitted'
      using errcode = '42501';
  end if;

  -- A shared Live lock serializes with publication/replacement but remains
  -- compatible with operations on other Stages.
  select * into live_row
  from public.live_timetables
  where live_timetables.id = p_live_id
    and live_timetables.workspace_id = target_workspace_id
  for share;
  if not found then
    raise exception 'Live Timetable changed during progress mutation'
      using errcode = '40001';
  end if;
  if not live_row.is_published then
    raise exception 'Live progress mutation requires publication'
      using errcode = '55000';
  end if;
  if live_row.projection_version <>
    p_expected_projection_version::bigint then
    raise exception 'Live projection version changed'
      using errcode = '40001';
  end if;

  if membership_role = 'editor' then
    perform 1
    from public.live_timetable_stage_operators as assignment
    join public.live_timetable_stages as assigned_stage
      on assigned_stage.id = assignment.stage_id
    where assignment.live_timetable_id = p_live_id
      and assignment.user_id = caller_id
      and assigned_stage.source_stage_id = p_source_stage_id
      and assigned_stage.projection_version = live_row.projection_version
    for share of assignment;
    if not found then
      raise exception 'Editor is not assigned to this Live Stage'
        using errcode = '42501';
    end if;
  end if;

  -- Final CAS and state validation happens only after this Stage lock.
  select * into stage_row
  from public.live_timetable_stages
  where live_timetable_stages.live_timetable_id = p_live_id
    and live_timetable_stages.source_stage_id = p_source_stage_id
  for update;
  if not found then
    raise exception 'Live Stage was not found'
      using errcode = 'P0002';
  end if;
  if stage_row.projection_version <> live_row.projection_version
    or stage_row.revision <> p_expected_stage_revision::bigint then
    raise exception 'Live Stage revision changed'
      using errcode = '40001';
  end if;

  select * into entry_row
  from public.live_timetable_entries
  where live_timetable_entries.stage_id = stage_row.id
    and live_timetable_entries.source_schedule_item_id =
      p_source_schedule_item_id
  for update;
  if not found then
    raise exception 'Live entry was not found'
      using errcode = 'P0002';
  end if;

  if p_operation = 'start' then
    select min(live_timetable_entries.position)
      into first_pending_position
    from public.live_timetable_entries
    where live_timetable_entries.stage_id = stage_row.id
      and live_timetable_entries.status = 'pending';

    if entry_row.status <> 'pending'
      or first_pending_position is distinct from entry_row.position
      or exists (
        select 1
        from public.live_timetable_entries
        where live_timetable_entries.stage_id = stage_row.id
          and live_timetable_entries.status = 'in_progress'
      ) then
      raise exception 'Only the first pending Live entry can start'
        using errcode = '55000';
    end if;

    operation_time := clock_timestamp();
    update public.live_timetable_entries
    set status = 'in_progress',
        actual_started_at = operation_time,
        started_by = caller_id,
        updated_at = operation_time
    where id = entry_row.id
    returning * into entry_row;

    select min(position) filter (where status = 'pending'),
           min(position) filter (
             where status = 'pending' and kind = 'performance'
           )
      into v_next_entry_position, v_next_performance_position
    from public.live_timetable_entries
    where stage_id = stage_row.id;
    next_progress_status := 'in_progress';
  else
    if entry_row.status <> 'in_progress'
      or stage_row.current_entry_position is distinct from entry_row.position then
      raise exception 'Only the current Live entry can end'
        using errcode = '55000';
    end if;

    operation_time := clock_timestamp();
    if operation_time < entry_row.actual_started_at then
      raise exception 'Live entry end time cannot precede start time'
        using errcode = '22023';
    end if;
    update public.live_timetable_entries
    set status = 'completed',
        actual_ended_at = operation_time,
        ended_by = caller_id,
        updated_at = operation_time
    where id = entry_row.id
    returning * into entry_row;

    select count(*) filter (where status = 'pending'),
           min(position) filter (where status = 'pending'),
           min(position) filter (
             where status = 'pending' and kind = 'performance'
           )
      into pending_count, v_next_entry_position, v_next_performance_position
    from public.live_timetable_entries
    where stage_id = stage_row.id;
    next_progress_status := case
      when pending_count = 0 then 'completed'
      else 'waiting'
    end;
  end if;

  update public.live_timetable_stages
  set revision = revision + 1,
      progress_status = next_progress_status,
      current_entry_position = case
        when p_operation = 'start' then entry_row.position
        else null
      end,
      next_entry_position = v_next_entry_position,
      next_performance_position = v_next_performance_position,
      updated_at = operation_time
  where id = stage_row.id
  returning * into stage_row;

  return jsonb_build_object(
    'status', 'ok',
    'operation', p_operation,
    'liveId', live_row.id,
    'stageId', stage_row.id,
    'projectionVersion', live_row.projection_version::text,
    'stageRevision', stage_row.revision::text,
    'progressStatus', stage_row.progress_status,
    'currentEntryPosition', stage_row.current_entry_position,
    'nextEntryPosition', stage_row.next_entry_position,
    'nextPerformancePosition', stage_row.next_performance_position,
    'entry', jsonb_build_object(
      'position', entry_row.position,
      'status', entry_row.status,
      'actualStartedAt', entry_row.actual_started_at,
      'actualEndedAt', entry_row.actual_ended_at
    )
  );
end;
$$;

revoke all on function public.transition_live_timetable_entry(
  text, uuid, text, text, text, text
) from public, anon, authenticated, service_role;

create function public.start_live_timetable_entry(
  p_live_id uuid,
  p_source_stage_id text,
  p_source_schedule_item_id text,
  p_expected_stage_revision text,
  p_expected_projection_version text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.transition_live_timetable_entry(
    'start',
    p_live_id,
    p_source_stage_id,
    p_source_schedule_item_id,
    p_expected_stage_revision,
    p_expected_projection_version
  );
$$;

create function public.end_live_timetable_entry(
  p_live_id uuid,
  p_source_stage_id text,
  p_source_schedule_item_id text,
  p_expected_stage_revision text,
  p_expected_projection_version text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.transition_live_timetable_entry(
    'end',
    p_live_id,
    p_source_stage_id,
    p_source_schedule_item_id,
    p_expected_stage_revision,
    p_expected_projection_version
  );
$$;

revoke all on function public.start_live_timetable_entry(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.end_live_timetable_entry(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.start_live_timetable_entry(
  uuid, text, text, text, text
) to authenticated;
grant execute on function public.end_live_timetable_entry(
  uuid, text, text, text, text
) to authenticated;

alter table public.live_timetables enable row level security;
alter table public.live_timetable_stages enable row level security;
alter table public.live_timetable_entries enable row level security;
alter table public.live_timetable_stage_operators enable row level security;

revoke all on table public.live_timetables
  from public, anon, authenticated, service_role;
revoke all on table public.live_timetable_stages
  from public, anon, authenticated, service_role;
revoke all on table public.live_timetable_entries
  from public, anon, authenticated, service_role;
revoke all on table public.live_timetable_stage_operators
  from public, anon, authenticated, service_role;

-- Direct browser writes stay forbidden. Authenticated SELECT on the Stage
-- notification row is the only table privilege required by Postgres Changes.
grant select on table public.live_timetable_stages to authenticated;

create policy "live_timetable_stages_select_for_workspace_member"
  on public.live_timetable_stages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id =
          live_timetable_stages.workspace_id
        and workspace_members.user_id = (select auth.uid())
        and workspace_members.role in ('owner', 'editor', 'viewer')
    )
  );

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication
    where pg_publication.pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication is unavailable'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pg_publication_tables.pubname = 'supabase_realtime'
      and pg_publication_tables.schemaname = 'public'
      and pg_publication_tables.tablename = 'live_timetable_stages'
  ) then
    alter publication supabase_realtime
      add table public.live_timetable_stages (
        id,
        workspace_id,
        live_timetable_id,
        projection_version,
        revision,
        progress_status,
        updated_at
      );
  end if;

  if not (
    select count(*) = 1 and bool_and(
      cardinality(pg_publication_tables.attnames) = 7
      and pg_publication_tables.attnames::text[] <@ array[
        'id',
        'workspace_id',
        'live_timetable_id',
        'projection_version',
        'revision',
        'progress_status',
        'updated_at'
      ]::text[]
    )
    from pg_catalog.pg_publication_tables
    where pg_publication_tables.pubname = 'supabase_realtime'
      and pg_publication_tables.schemaname = 'public'
      and pg_publication_tables.tablename = 'live_timetable_stages'
  ) then
    raise exception 'Live Stage realtime publication columns are invalid'
      using errcode = '55000';
  end if;
end;
$$;

comment on table public.live_timetables is
  'Independent immutable-source Live TT projection metadata. It never replaces Cloud Event Snapshot V1.';
comment on table public.live_timetable_stages is
  'Minimal per-Stage Live progress and revision metadata exposed to authenticated Workspace members for Postgres Changes.';
comment on table public.live_timetable_entries is
  'Ordered Performance/Break progress entries with database-owned actual timestamps and actor IDs.';
comment on table public.live_timetable_stage_operators is
  'Explicit Stage operator assignments; mutation RPCs revalidate that each assigned user remains a current editor.';
comment on function public.load_live_timetable_projection_source(
  uuid, uuid, text, bigint
) is
  'Service-role-only Snapshot V1 source read. Locks and verifies owner membership and source revision before returning the saved snapshot and PostgreSQL jsonb digest.';
comment on function public.create_or_replace_live_timetable_projection(
  uuid, uuid, text, bigint, text, jsonb, text, text
) is
  'Service-role-only atomic Live projection create/replace. Rechecks actor ownership plus locked Cloud Event revision/fingerprint; replacement requires unpublished and never-started state and clears operators.';
comment on function public.load_live_timetable_authorized(uuid) is
  'Returns one internally authorized, lock-consistent Live TT read model to a current Workspace member.';
comment on function public.load_live_timetable_public(uuid) is
  'Returns only the explicit public allowlist for one unguessable published Live ID; missing and unpublished both return null.';
comment on function public.set_live_timetable_publication(uuid, text, boolean) is
  'Owner-only publication CAS. Unpublishing preserves entries, timestamps, and actor records.';
comment on function public.set_live_timetable_stage_operator(
  uuid, text, uuid, boolean, text, text
) is
  'Owner-only Stage operator assignment CAS. New assignments require a current editor and replacement clears every assignment.';
comment on function public.start_live_timetable_entry(
  uuid, text, text, text, text
) is
  'Starts exactly the first pending entry after membership, publication, projection-version, assignment, and post-lock Stage revision checks.';
comment on function public.end_live_timetable_entry(
  uuid, text, text, text, text
) is
  'Ends exactly the current in-progress entry after membership, publication, projection-version, assignment, and post-lock Stage revision checks.';

-- Fail closed if default, PUBLIC, inherited, table, column, or function
-- privileges accidentally expose a write path or broaden an RPC.
do $$
declare
  table_name text;
  role_name text;
  privilege_name text;
  function_contract record;
  function_oid oid;
  expected_execute boolean;
begin
  foreach table_name in array array[
    'live_timetables',
    'live_timetable_stages',
    'live_timetable_entries',
    'live_timetable_stage_operators'
  ] loop
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach privilege_name in array array[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(
          role_name,
          format('public.%I', table_name),
          privilege_name
        ) then
          raise exception '% retains % on public.%',
            role_name, privilege_name, table_name
            using errcode = '42501';
        end if;
      end loop;

      if has_any_column_privilege(
        role_name,
        format('public.%I', table_name),
        'INSERT,UPDATE,REFERENCES'
      ) then
        raise exception '% retains column write privileges on public.%',
          role_name, table_name using errcode = '42501';
      end if;

      if has_table_privilege(
        role_name,
        format('public.%I', table_name),
        'SELECT'
      ) is distinct from (
        table_name = 'live_timetable_stages'
        and role_name = 'authenticated'
      ) then
        raise exception '% has unexpected SELECT contract on public.%',
          role_name, table_name using errcode = '42501';
      end if;
    end loop;

    if exists (
      select 1
      from pg_catalog.pg_class
      join pg_catalog.pg_namespace
        on pg_namespace.oid = pg_class.relnamespace
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_class.relacl,
        pg_catalog.acldefault('r', pg_class.relowner)
      )) as table_acl
      where pg_namespace.nspname = 'public'
        and pg_class.relname = table_name
        and table_acl.grantee = 0
    ) then
      raise exception 'PUBLIC retains privileges on public.%', table_name
        using errcode = '42501';
    end if;

    if exists (
      select 1
      from pg_catalog.pg_class
      join pg_catalog.pg_namespace
        on pg_namespace.oid = pg_class.relnamespace
      join pg_catalog.pg_attribute
        on pg_attribute.attrelid = pg_class.oid
      cross join lateral pg_catalog.aclexplode(pg_attribute.attacl)
        as column_acl
      where pg_namespace.nspname = 'public'
        and pg_class.relname = table_name
        and pg_attribute.attnum > 0
        and not pg_attribute.attisdropped
        and pg_attribute.attacl is not null
        and column_acl.grantee = 0
    ) then
      raise exception 'PUBLIC retains column privileges on public.%', table_name
        using errcode = '42501';
    end if;
  end loop;

  for function_contract in
    select * from (values
      ('public.is_live_timetable_event_days_shape(jsonb)', false, false, false),
      ('public.is_live_timetable_sections_shape(jsonb)', false, false, false),
      ('public.is_live_timetable_projection_shape(jsonb,text,text)', false, false, false),
      ('public.populate_live_timetable_projection(uuid,uuid,jsonb,bigint)', false, false, false),
      ('public.build_live_timetable_stages_json(uuid,uuid,text,boolean)', false, false, false),
      ('public.is_live_timetable_revision_text(text)', false, false, false),
      ('public.transition_live_timetable_entry(text,uuid,text,text,text,text)', false, false, false),
      ('public.load_live_timetable_projection_source(uuid,uuid,text,bigint)', false, false, true),
      ('public.create_or_replace_live_timetable_projection(uuid,uuid,text,bigint,text,jsonb,text,text)', false, false, true),
      ('public.load_live_timetable_authorized(uuid)', false, true, false),
      ('public.load_live_timetable_public(uuid)', true, true, false),
      ('public.set_live_timetable_publication(uuid,text,boolean)', false, true, false),
      ('public.set_live_timetable_stage_operator(uuid,text,uuid,boolean,text,text)', false, true, false),
      ('public.start_live_timetable_entry(uuid,text,text,text,text)', false, true, false),
      ('public.end_live_timetable_entry(uuid,text,text,text,text)', false, true, false)
    ) as contract(
      signature,
      anon_execute,
      authenticated_execute,
      service_role_execute
    )
  loop
    function_oid := to_regprocedure(function_contract.signature);
    if function_oid is null then
      raise exception 'Live Timetable function is missing: %',
        function_contract.signature using errcode = '55000';
    end if;

    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      expected_execute := case role_name
        when 'anon' then function_contract.anon_execute
        when 'authenticated' then function_contract.authenticated_execute
        else function_contract.service_role_execute
      end;
      if has_function_privilege(role_name, function_oid, 'EXECUTE')
        is distinct from expected_execute then
        raise exception '% has unexpected EXECUTE contract on %',
          role_name, function_contract.signature using errcode = '42501';
      end if;
    end loop;

    if exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl,
        pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
      raise exception 'PUBLIC retains EXECUTE on %',
        function_contract.signature using errcode = '42501';
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pg_publication_tables.pubname = 'supabase_realtime'
      and pg_publication_tables.schemaname = 'public'
      and pg_publication_tables.tablename = 'live_timetable_stages'
  ) then
    raise exception 'Live Stage is absent from supabase_realtime publication'
      using errcode = '55000';
  end if;

  if not (
    select count(*) = 1 and bool_and(
      cardinality(pg_publication_tables.attnames) = 7
      and pg_publication_tables.attnames::text[] <@ array[
        'id',
        'workspace_id',
        'live_timetable_id',
        'projection_version',
        'revision',
        'progress_status',
        'updated_at'
      ]::text[]
    )
    from pg_catalog.pg_publication_tables
    where pg_publication_tables.pubname = 'supabase_realtime'
      and pg_publication_tables.schemaname = 'public'
      and pg_publication_tables.tablename = 'live_timetable_stages'
  ) then
    raise exception 'Live Stage realtime publication columns are invalid'
      using errcode = '55000';
  end if;
end;
$$;

commit;
