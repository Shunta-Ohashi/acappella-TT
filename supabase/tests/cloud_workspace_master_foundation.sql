\set ON_ERROR_STOP on

-- Run only against a disposable database with every repository migration
-- applied. All fixture rows are rolled back.
begin;

create or replace function pg_temp.workspace_master_test_snapshot(
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

insert into public.workspaces (id, name) values
  ('70000000-0000-0000-0000-000000000001', 'Master foundation A'),
  ('70000000-0000-0000-0000-000000000002', 'Master foundation B'),
  ('70000000-0000-0000-0000-000000000003', 'Master cascade probe');

do $$
begin
  if exists (
    select 1
    from public.workspaces
    left join public.cloud_workspace_master_states
      on cloud_workspace_master_states.workspace_id = workspaces.id
    where cloud_workspace_master_states.workspace_id is null
  ) then
    raise exception 'Every Workspace must have an initialized master state';
  end if;
  if exists (
    select 1 from public.cloud_workspace_master_states
    where workspace_id in (
      '70000000-0000-0000-0000-000000000001'::uuid,
      '70000000-0000-0000-0000-000000000002'::uuid,
      '70000000-0000-0000-0000-000000000003'::uuid
    ) and status <> 'legacy'
  ) then
    raise exception 'New Workspace master state must be legacy';
  end if;
end;
$$;

create temporary table master_generation_probe (
  step text primary key,
  generation bigint not null
);

insert into master_generation_probe
select 'initial', generation
from public.cloud_event_workspace_generations
where workspace_id = '70000000-0000-0000-0000-000000000001';

insert into public.workspace_master_members (
  workspace_id, member_id, real_name, aca_name,
  entry_academic_year, notes, active, revision, created_at, updated_at
) values
  (
    '70000000-0000-0000-0000-000000000001',
    'member-a', 'Alice', 'A', 2024, null, true,
    99, timestamptz '2000-01-01 00:00:00+00',
    timestamptz '2000-01-01 00:00:00+00'
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    'member-b', 'Bob', null, null, null, true,
    99, timestamptz '2000-01-01 00:00:00+00',
    timestamptz '2000-01-01 00:00:00+00'
  );

insert into master_generation_probe
select 'after-member', generation
from public.cloud_event_workspace_generations
where workspace_id = '70000000-0000-0000-0000-000000000001';

insert into public.workspace_master_bands (
  workspace_id, band_id, name, notes, active,
  revision, created_at, updated_at
) values
  (
    '70000000-0000-0000-0000-000000000001',
    'band-a', 'Alpha', null, true,
    99, timestamptz '2000-01-01 00:00:00+00',
    timestamptz '2000-01-01 00:00:00+00'
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    'band-b', 'Beta', null, true,
    99, timestamptz '2000-01-01 00:00:00+00',
    timestamptz '2000-01-01 00:00:00+00'
  );

insert into master_generation_probe
select 'after-band', generation
from public.cloud_event_workspace_generations
where workspace_id = '70000000-0000-0000-0000-000000000001';

insert into public.workspace_master_band_members (
  workspace_id, band_id, member_id, position
) values
  ('70000000-0000-0000-0000-000000000001', 'band-a', 'member-a', 0);

insert into master_generation_probe
select 'after-relation', generation
from public.cloud_event_workspace_generations
where workspace_id = '70000000-0000-0000-0000-000000000001';

do $$
declare
  initial_generation bigint;
  member_generation bigint;
  band_generation bigint;
  relation_generation bigint;
begin
  select generation into initial_generation
    from master_generation_probe where step = 'initial';
  select generation into member_generation
    from master_generation_probe where step = 'after-member';
  select generation into band_generation
    from master_generation_probe where step = 'after-band';
  select generation into relation_generation
    from master_generation_probe where step = 'after-relation';

  if member_generation <> initial_generation + 1
    or band_generation <> member_generation + 1
    or relation_generation <> band_generation + 1 then
    raise exception 'Member, Band, and ordered relation mutations must advance generation';
  end if;
end;
$$;

do $$
declare
  member_created_at timestamptz;
  band_created_at timestamptz;
  invalid_timestamp constant timestamptz := timestamptz '2001-01-01 00:00:00+00';
begin
  select created_at into member_created_at
  from public.workspace_master_members
  where workspace_id = '70000000-0000-0000-0000-000000000001'
    and member_id = 'member-a';
  if not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and member_id = 'member-a'
      and revision = 1
      and created_at = transaction_timestamp()
      and updated_at = transaction_timestamp()
  ) then
    raise exception 'Workspace Member INSERT metadata was not normalized';
  end if;

  select created_at into band_created_at
  from public.workspace_master_bands
  where workspace_id = '70000000-0000-0000-0000-000000000001'
    and band_id = 'band-a';
  if not exists (
    select 1 from public.workspace_master_bands
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and band_id = 'band-a'
      and revision = 1
      and created_at = transaction_timestamp()
      and updated_at = transaction_timestamp()
  ) then
    raise exception 'Workspace Band INSERT metadata was not normalized';
  end if;

  begin
    update public.workspace_master_members
    set member_id = 'member-a-renamed'
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and member_id = 'member-a';
    raise exception 'Workspace Member ID mutation was accepted';
  exception when sqlstate '42501' then
    null;
  end;
  begin
    update public.workspace_master_members
    set workspace_id = '70000000-0000-0000-0000-000000000002'
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and member_id = 'member-a';
    raise exception 'Workspace Member ownership mutation was accepted';
  exception when sqlstate '42501' then
    null;
  end;

  update public.workspace_master_members
  set real_name = 'Alice Updated',
    revision = 999,
    created_at = invalid_timestamp,
    updated_at = invalid_timestamp
  where workspace_id = '70000000-0000-0000-0000-000000000001'
    and member_id = 'member-a';
  if not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and member_id = 'member-a'
      and real_name = 'Alice Updated'
      and revision = 2
      and created_at = member_created_at
      and updated_at = transaction_timestamp()
      and updated_at <> invalid_timestamp
  ) then
    raise exception 'Workspace Member UPDATE metadata contract was not preserved';
  end if;

  begin
    update public.workspace_master_bands
    set band_id = 'band-a-renamed'
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and band_id = 'band-a';
    raise exception 'Workspace Band ID mutation was accepted';
  exception when sqlstate '42501' then
    null;
  end;
  begin
    update public.workspace_master_bands
    set workspace_id = '70000000-0000-0000-0000-000000000002'
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and band_id = 'band-a';
    raise exception 'Workspace Band ownership mutation was accepted';
  exception when sqlstate '42501' then
    null;
  end;

  update public.workspace_master_bands
  set name = 'Alpha Updated',
    revision = 999,
    created_at = invalid_timestamp,
    updated_at = invalid_timestamp
  where workspace_id = '70000000-0000-0000-0000-000000000001'
    and band_id = 'band-a';
  if not exists (
    select 1 from public.workspace_master_bands
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and band_id = 'band-a'
      and name = 'Alpha Updated'
      and revision = 2
      and created_at = band_created_at
      and updated_at = transaction_timestamp()
      and updated_at <> invalid_timestamp
  ) then
    raise exception 'Workspace Band UPDATE metadata contract was not preserved';
  end if;
end;
$$;

insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values
  ('70000000-0000-0000-0000-000000000001', 'member-a2', 'Alice 2', true),
  ('70000000-0000-0000-0000-000000000001', 'member-a3', 'Alice 3', true),
  ('70000000-0000-0000-0000-000000000001', 'member-a4', 'Alice 4', true);

insert into public.workspace_master_band_members (
  workspace_id, band_id, member_id, position
) values
  ('70000000-0000-0000-0000-000000000001', 'band-a', 'member-a2', 2),
  ('70000000-0000-0000-0000-000000000001', 'band-a', 'member-a3', 1);

do $$
declare
  ordered_member_ids text[];
begin
  select array_agg(member_id order by position)
    into ordered_member_ids
    from public.workspace_master_band_members
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and band_id = 'band-a';

  if ordered_member_ids <> array['member-a', 'member-a3', 'member-a2'] then
    raise exception 'Band Member order was not preserved';
  end if;

  begin
    insert into public.workspace_master_band_members (
      workspace_id, band_id, member_id, position
    ) values (
      '70000000-0000-0000-0000-000000000001',
      'band-a',
      'member-a4',
      1
    );
    raise exception 'Duplicate Band Member position was accepted';
  exception when unique_violation then
    null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.workspace_master_band_members (
      workspace_id, band_id, member_id, position
    ) values (
      '70000000-0000-0000-0000-000000000001',
      'band-a',
      'member-b',
      3
    );
    raise exception 'Cross-Workspace Band-to-Member reference was accepted';
  exception when foreign_key_violation then
    null;
  end;

  begin
    insert into public.workspace_master_band_members (
      workspace_id, band_id, member_id, position
    ) values (
      '70000000-0000-0000-0000-000000000002',
      'band-a',
      'member-b',
      0
    );
    raise exception 'Cross-Workspace relation ownership was accepted';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '70000000-0000-0000-0000-000000000001',
  'master-event-a',
  'Master Event A',
  pg_temp.workspace_master_test_snapshot('master-event-a', 'Master Event A')
);

insert into public.cloud_event_member_references (
  workspace_id, event_id, member_id
) values (
  '70000000-0000-0000-0000-000000000001',
  'master-event-a',
  'member-a'
);

insert into public.cloud_event_band_references (
  workspace_id, event_id, band_id
) values (
  '70000000-0000-0000-0000-000000000001',
  'master-event-a',
  'band-a'
);

do $$
begin
  begin
    insert into public.cloud_event_member_references (
      workspace_id, event_id, member_id
    ) values (
      '70000000-0000-0000-0000-000000000002',
      'master-event-a',
      'member-b'
    );
    raise exception 'Cross-Workspace Event-to-Member reference was accepted';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

do $$
begin
  begin
    delete from public.workspace_master_members
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and member_id = 'member-a';
    raise exception 'Legacy Workspace Member deletion was accepted';
  exception when sqlstate '55000' then
    null;
  end;

  update public.cloud_workspace_master_states
  set status = 'ready'
  where workspace_id = '70000000-0000-0000-0000-000000000001';

  begin
    delete from public.workspace_master_members
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and member_id = 'member-a';
    raise exception 'Referenced Workspace Member deletion was accepted';
  exception when foreign_key_violation then
    null;
  end;

  begin
    delete from public.workspace_master_bands
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and band_id = 'band-a';
    raise exception 'Referenced Workspace Band deletion was accepted';
  exception when foreign_key_violation then
    null;
  end;
end;
$$;

delete from public.cloud_events
where workspace_id = '70000000-0000-0000-0000-000000000001'
  and event_id = 'master-event-a';

do $$
begin
  if exists (
    select 1 from public.cloud_event_member_references
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and event_id = 'master-event-a'
  ) or exists (
    select 1 from public.cloud_event_band_references
    where workspace_id = '70000000-0000-0000-0000-000000000001'
      and event_id = 'master-event-a'
  ) then
    raise exception 'Event reference rows must cascade on Event deletion';
  end if;
end;
$$;

-- A parent Workspace cascade must not be mistaken for a user-initiated master
-- deletion while the Workspace is still legacy.
insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values (
  '70000000-0000-0000-0000-000000000003',
  'cascade-member',
  'Cascade Member',
  true
);
delete from public.workspaces
where id = '70000000-0000-0000-0000-000000000003';

do $$
declare
  table_name text;
  role_name text;
  privilege_name text;
begin
  foreach table_name in array array[
    'cloud_workspace_master_states',
    'workspace_master_members',
    'workspace_master_bands',
    'workspace_master_band_members',
    'cloud_event_member_references',
    'cloud_event_band_references'
  ] loop
    if not (
      select relrowsecurity
      from pg_catalog.pg_class
      join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where pg_namespace.nspname = 'public'
        and pg_class.relname = table_name
    ) then
      raise exception 'RLS is disabled on public.%', table_name;
    end if;

    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach privilege_name in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(
          role_name,
          format('public.%I', table_name),
          privilege_name
        ) then
          raise exception '% unexpectedly has % on public.%',
            role_name, privilege_name, table_name;
        end if;
      end loop;
    end loop;
  end loop;
end;
$$;

rollback;
