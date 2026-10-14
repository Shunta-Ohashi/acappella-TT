\set ON_ERROR_STOP on

-- Run only against a disposable database with all repository migrations.
-- Every fixture and mutation is rolled back.
begin;

create or replace function pg_temp.workspace_master_contract_v2_snapshot(
  p_event_id text,
  p_event_name text
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
        'id', 'master-contract-day',
        'eventId', p_event_id,
        'date', '2026-10-14',
        'order', 0
      )),
      'stages', '[]'::jsonb,
      'sections', '[]'::jsonb,
      'eventMembers', jsonb_build_array(
        jsonb_build_object(
          'id', 'master-contract-member-a',
          'eventId', p_event_id,
          'memberId', 'member-a',
          'paCapabilities', jsonb_build_object('main', false, 'sub', false)
        ),
        jsonb_build_object(
          'id', 'master-contract-member-b',
          'eventId', p_event_id,
          'memberId', 'member-b',
          'paCapabilities', jsonb_build_object('main', false, 'sub', false)
        )
      ),
      'eventMemberDays', '[]'::jsonb,
      'eventBands', jsonb_build_array(jsonb_build_object(
        'id', 'master-contract-band',
        'eventId', p_event_id,
        'eventDayId', 'master-contract-day',
        'bandId', 'band-a',
        'name', 'Alpha at Event',
        'memberIds', jsonb_build_array('member-a', 'member-b'),
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
      'memberIds', jsonb_build_array('member-a', 'member-b'),
      'bandIds', jsonb_build_array('band-a')
    )
  );
$$;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000071', 'authenticated', 'authenticated',
   'master-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000072', 'authenticated', 'authenticated',
   'master-editor@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000073', 'authenticated', 'authenticated',
   'master-viewer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000074', 'authenticated', 'authenticated',
   'master-outsider@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.workspaces (id, name) values
  ('71000000-0000-0000-0000-000000000001', 'Master contracts ready'),
  ('71000000-0000-0000-0000-000000000002', 'Master contracts legacy');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('71000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000071', 'owner'),
  ('71000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000072', 'editor'),
  ('71000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000073', 'viewer'),
  ('71000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000071', 'owner');

update public.cloud_workspace_master_states
set status = 'ready'
where workspace_id = '71000000-0000-0000-0000-000000000001';

-- This Member exists only in the other Workspace. It must not satisfy a Band
-- relation in the ready Workspace under test.
insert into public.workspace_master_members (
  workspace_id, member_id, real_name, active
) values (
  '71000000-0000-0000-0000-000000000002',
  'foreign-only-member',
  'Foreign only',
  true
);

do $$
declare
  table_name text;
begin
  if not has_function_privilege(
    'authenticated',
    'public.load_workspace_masters_page_authorized(uuid,text,text,integer,text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.load_workspace_masters_page_authorized(uuid,text,text,integer,text)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'public.load_workspace_masters_page_authorized(uuid,text,text,integer,text)',
    'execute'
  ) then
    raise exception 'Workspace Master read RPC privileges are incorrect';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.mutate_workspace_master_validated(uuid,uuid,text,text,jsonb,bigint)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.mutate_workspace_master_validated(uuid,uuid,text,text,jsonb,bigint)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.mutate_workspace_master_validated(uuid,uuid,text,text,jsonb,bigint)',
    'execute'
  ) then
    raise exception 'Workspace Master mutation RPC privileges are incorrect';
  end if;

  foreach table_name in array array[
    'workspace_master_members',
    'workspace_master_bands',
    'workspace_master_band_members',
    'cloud_event_member_references',
    'cloud_event_band_references'
  ] loop
    if has_table_privilege('authenticated', format('public.%I', table_name), 'insert')
      or has_table_privilege('authenticated', format('public.%I', table_name), 'update')
      or has_table_privilege('authenticated', format('public.%I', table_name), 'delete') then
      raise exception 'authenticated retains a direct Master write on %', table_name;
    end if;
  end loop;
end;
$$;

-- Owner and editor can create normalized records through the backend-only RPC.
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'create', 'member',
  '{"id":"member-a","realName":"Alice","active":true}'::jsonb,
  null
);
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000072',
  '71000000-0000-0000-0000-000000000001',
  'create', 'member',
  '{"id":"member-b","realName":"Bob","active":true}'::jsonb,
  null
);
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'create', 'band',
  '{"id":"band-a","name":"Alpha","defaultMemberIds":["member-b","member-a"],"active":true}'::jsonb,
  null
);

-- SQL NULL discriminators must not slip through PostgreSQL three-valued
-- boolean expressions. Every invalid call must fail before any Master or
-- Workspace generation state changes.
do $$
declare
  invalid_case record;
  members_before jsonb;
  bands_before jsonb;
  relations_before jsonb;
  generation_before bigint;
begin
  select coalesce(
    jsonb_agg(to_jsonb(member_row) order by member_row.member_id),
    '[]'::jsonb
  )
  into members_before
  from public.workspace_master_members as member_row
  where workspace_id = '71000000-0000-0000-0000-000000000001';

  select coalesce(
    jsonb_agg(to_jsonb(band_row) order by band_row.band_id),
    '[]'::jsonb
  )
  into bands_before
  from public.workspace_master_bands as band_row
  where workspace_id = '71000000-0000-0000-0000-000000000001';

  select coalesce(
    jsonb_agg(
      to_jsonb(relation_row)
      order by relation_row.band_id, relation_row.position
    ),
    '[]'::jsonb
  )
  into relations_before
  from public.workspace_master_band_members as relation_row
  where workspace_id = '71000000-0000-0000-0000-000000000001';

  select generation into generation_before
  from public.cloud_event_workspace_generations
  where workspace_id = '71000000-0000-0000-0000-000000000001';

  for invalid_case in
    select *
    from (values
      ('SQL NULL operation', null::text, 'member'::text,
       '{"id":"invalid-null-operation","realName":"Invalid","active":true}'::jsonb,
       null::bigint),
      ('SQL NULL kind', 'create', null,
       '{"id":"invalid-null-kind","realName":"Invalid","active":true}'::jsonb, null),
      ('SQL NULL payload', 'create', 'member', null::jsonb, null),
      ('JSON null payload', 'create', 'member', 'null'::jsonb, null),
      ('invalid operation', 'rename', 'member',
       '{"id":"member-a","realName":"Invalid","active":true}'::jsonb, 1),
      ('invalid kind', 'create', 'ensemble',
       '{"id":"invalid-kind","name":"Invalid","defaultMemberIds":[],"active":true}'::jsonb,
       null),
      ('create revision', 'create', 'member',
       '{"id":"invalid-create-revision","realName":"Invalid","active":true}'::jsonb, 1),
      ('missing update revision', 'update', 'member',
       '{"id":"member-a","realName":"Invalid","active":true}'::jsonb, null),
      ('missing delete revision', 'delete', 'band', '{"id":"band-a"}'::jsonb, null),
      ('Member create missing id', 'create', 'member',
       '{"realName":"Invalid","active":true}'::jsonb, null),
      ('Member create null id', 'create', 'member',
       '{"id":null,"realName":"Invalid","active":true}'::jsonb, null),
      ('Member create wrong id type', 'create', 'member',
       '{"id":7,"realName":"Invalid","active":true}'::jsonb, null),
      ('Member create missing realName', 'create', 'member',
       '{"id":"invalid-member-create-missing-name","active":true}'::jsonb, null),
      ('Member create missing active', 'create', 'member',
       '{"id":"invalid-member-create-missing-active","realName":"Invalid"}'::jsonb,
       null),
      ('Member create null realName', 'create', 'member',
       '{"id":"invalid-member-create-null-name","realName":null,"active":true}'::jsonb,
       null),
      ('Member create null active', 'create', 'member',
       '{"id":"invalid-member-create-null-active","realName":"Invalid","active":null}'::jsonb,
       null),
      ('Member create wrong realName type', 'create', 'member',
       '{"id":"invalid-member-create-name-type","realName":7,"active":true}'::jsonb,
       null),
      ('Member create wrong active type', 'create', 'member',
       '{"id":"invalid-member-create-active-type","realName":"Invalid","active":"true"}'::jsonb,
       null),
      ('Member create null entryAcademicYear', 'create', 'member',
       '{"id":"invalid-member-create-null-year","realName":"Invalid","entryAcademicYear":null,"active":true}'::jsonb,
       null),
      ('Member create wrong entryAcademicYear type', 'create', 'member',
       '{"id":"invalid-member-create-year-type","realName":"Invalid","entryAcademicYear":"2024","active":true}'::jsonb,
       null),
      ('Member create entryAcademicYear overflow', 'create', 'member',
       '{"id":"invalid-member-create-year-overflow","realName":"Invalid","entryAcademicYear":2147483648,"active":true}'::jsonb,
       null),
      ('Member update missing realName', 'update', 'member',
       '{"id":"member-a","active":true}'::jsonb, 1),
      ('Member update missing active', 'update', 'member',
       '{"id":"member-a","realName":"Invalid"}'::jsonb, 1),
      ('Member update null realName', 'update', 'member',
       '{"id":"member-a","realName":null,"active":true}'::jsonb, 1),
      ('Member update null active', 'update', 'member',
       '{"id":"member-a","realName":"Invalid","active":null}'::jsonb, 1),
      ('Member update wrong realName type', 'update', 'member',
       '{"id":"member-a","realName":7,"active":true}'::jsonb, 1),
      ('Member update wrong active type', 'update', 'member',
       '{"id":"member-a","realName":"Invalid","active":"true"}'::jsonb, 1),
      ('Band create missing id', 'create', 'band',
       '{"name":"Invalid","defaultMemberIds":[],"active":true}'::jsonb, null),
      ('Band create null id', 'create', 'band',
       '{"id":null,"name":"Invalid","defaultMemberIds":[],"active":true}'::jsonb,
       null),
      ('Band create wrong id type', 'create', 'band',
       '{"id":7,"name":"Invalid","defaultMemberIds":[],"active":true}'::jsonb,
       null),
      ('Band create missing name', 'create', 'band',
       '{"id":"invalid-band-create-missing-name","defaultMemberIds":[],"active":true}'::jsonb,
       null),
      ('Band create missing active', 'create', 'band',
       '{"id":"invalid-band-create-missing-active","name":"Invalid","defaultMemberIds":[]}'::jsonb,
       null),
      ('Band create missing defaultMemberIds', 'create', 'band',
       '{"id":"invalid-band-create-missing-members","name":"Invalid","active":true}'::jsonb,
       null),
      ('Band create null name', 'create', 'band',
       '{"id":"invalid-band-create-null-name","name":null,"defaultMemberIds":[],"active":true}'::jsonb,
       null),
      ('Band create null active', 'create', 'band',
       '{"id":"invalid-band-create-null-active","name":"Invalid","defaultMemberIds":[],"active":null}'::jsonb,
       null),
      ('Band create null defaultMemberIds', 'create', 'band',
       '{"id":"invalid-band-create-null-members","name":"Invalid","defaultMemberIds":null,"active":true}'::jsonb,
       null),
      ('Band create object defaultMemberIds', 'create', 'band',
       '{"id":"invalid-band-create-object-members","name":"Invalid","defaultMemberIds":{},"active":true}'::jsonb,
       null),
      ('Band create string defaultMemberIds', 'create', 'band',
       '{"id":"invalid-band-create-string-members","name":"Invalid","defaultMemberIds":"member-a","active":true}'::jsonb,
       null),
      ('Band create wrong name type', 'create', 'band',
       '{"id":"invalid-band-create-name-type","name":7,"defaultMemberIds":[],"active":true}'::jsonb,
       null),
      ('Band create wrong active type', 'create', 'band',
       '{"id":"invalid-band-create-active-type","name":"Invalid","defaultMemberIds":[],"active":"true"}'::jsonb,
       null),
      ('Band update missing name', 'update', 'band',
       '{"id":"band-a","defaultMemberIds":[],"active":true}'::jsonb, 1),
      ('Band update missing active', 'update', 'band',
       '{"id":"band-a","name":"Invalid","defaultMemberIds":[]}'::jsonb, 1),
      ('Band update missing defaultMemberIds', 'update', 'band',
       '{"id":"band-a","name":"Invalid","active":true}'::jsonb, 1),
      ('Band update null name', 'update', 'band',
       '{"id":"band-a","name":null,"defaultMemberIds":[],"active":true}'::jsonb, 1),
      ('Band update null active', 'update', 'band',
       '{"id":"band-a","name":"Invalid","defaultMemberIds":[],"active":null}'::jsonb, 1),
      ('Band update null defaultMemberIds', 'update', 'band',
       '{"id":"band-a","name":"Invalid","defaultMemberIds":null,"active":true}'::jsonb, 1),
      ('Band update object defaultMemberIds', 'update', 'band',
       '{"id":"band-a","name":"Invalid","defaultMemberIds":{},"active":true}'::jsonb, 1),
      ('Band update string defaultMemberIds', 'update', 'band',
       '{"id":"band-a","name":"Invalid","defaultMemberIds":"member-a","active":true}'::jsonb, 1),
      ('Band update wrong name type', 'update', 'band',
       '{"id":"band-a","name":7,"defaultMemberIds":[],"active":true}'::jsonb, 1),
      ('Band update wrong active type', 'update', 'band',
       '{"id":"band-a","name":"Invalid","defaultMemberIds":[],"active":"true"}'::jsonb, 1)
    ) as cases(label, operation, master_kind, payload, expected_revision)
  loop
    begin
      perform public.mutate_workspace_master_validated(
        '00000000-0000-0000-0000-000000000071',
        '71000000-0000-0000-0000-000000000001',
        invalid_case.operation,
        invalid_case.master_kind,
        invalid_case.payload,
        invalid_case.expected_revision
      );
      raise exception 'Invalid mutation was accepted: %', invalid_case.label;
    exception when sqlstate '22023' then null;
    end;
  end loop;

  if members_before is distinct from (
      select coalesce(
        jsonb_agg(to_jsonb(member_row) order by member_row.member_id),
        '[]'::jsonb
      )
      from public.workspace_master_members as member_row
      where workspace_id = '71000000-0000-0000-0000-000000000001'
    ) or bands_before is distinct from (
      select coalesce(
        jsonb_agg(to_jsonb(band_row) order by band_row.band_id),
        '[]'::jsonb
      )
      from public.workspace_master_bands as band_row
      where workspace_id = '71000000-0000-0000-0000-000000000001'
    ) or relations_before is distinct from (
      select coalesce(
        jsonb_agg(
          to_jsonb(relation_row)
          order by relation_row.band_id, relation_row.position
        ),
        '[]'::jsonb
      )
      from public.workspace_master_band_members as relation_row
      where workspace_id = '71000000-0000-0000-0000-000000000001'
    ) or generation_before is distinct from (
      select generation
      from public.cloud_event_workspace_generations
      where workspace_id = '71000000-0000-0000-0000-000000000001'
    ) then
    raise exception 'Rejected invalid mutation changed Master or generation state';
  end if;
end;
$$;

-- Valid create/update payloads may omit optional fields, and an empty ordered
-- Band membership is a valid relation set. CAS still advances each revision.
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'update', 'member',
  '{"id":"member-b","realName":"Bob updated","active":true}'::jsonb,
  1
);
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'create', 'band',
  '{"id":"empty-band","name":"Empty","defaultMemberIds":[],"active":true}'::jsonb,
  null
);
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'update', 'band',
  '{"id":"empty-band","name":"Empty updated","defaultMemberIds":[],"active":true}'::jsonb,
  1
);

do $$
begin
  if not exists (
    select 1 from public.workspace_master_members
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and member_id = 'member-b'
      and real_name = 'Bob updated'
      and revision = 2
  ) or not exists (
    select 1 from public.workspace_master_bands
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and band_id = 'empty-band'
      and name = 'Empty updated'
      and revision = 2
  ) or exists (
    select 1 from public.workspace_master_band_members
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and band_id = 'empty-band'
  ) then
    raise exception 'Valid optional/empty-relation mutation contract failed';
  end if;
end;
$$;

select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'delete', 'band', '{"id":"empty-band"}'::jsonb, 2
);

do $$
begin
  if (select array_agg(member_id order by position)
      from public.workspace_master_band_members
      where workspace_id = '71000000-0000-0000-0000-000000000001'
        and band_id = 'band-a') <> array['member-b', 'member-a'] then
    raise exception 'Band.defaultMemberIds order was not preserved';
  end if;
end;
$$;

-- An order-only update is one Band CAS and advances its revision.
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'update', 'band',
  '{"id":"band-a","name":"Alpha","defaultMemberIds":["member-a","member-b"],"active":true}'::jsonb,
  1
);

do $$
begin
  if (select revision from public.workspace_master_bands
      where workspace_id = '71000000-0000-0000-0000-000000000001'
        and band_id = 'band-a') <> 2 then
    raise exception 'Order-only Band update did not advance revision exactly once';
  end if;
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'create', 'member',
      '{"id":"member-a","realName":"Duplicate","active":true}'::jsonb,
      null
    );
    raise exception 'Duplicate Member ID was accepted';
  exception when unique_violation then null;
  end;
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'create', 'band',
      '{"id":"missing-member-band","name":"Missing","defaultMemberIds":["unknown"],"active":true}'::jsonb,
      null
    );
    raise exception 'Band with an unknown Member was accepted';
  exception when sqlstate 'PMA01' then null;
  end;
  if exists (
    select 1 from public.workspace_master_bands
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and band_id = 'missing-member-band'
  ) then
    raise exception 'Rejected Band relation left a partial Band row';
  end if;
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'create', 'band',
      '{"id":"foreign-member-band","name":"Foreign","defaultMemberIds":["foreign-only-member"],"active":true}'::jsonb,
      null
    );
    raise exception 'Cross-Workspace Band Member reference was accepted';
  exception when sqlstate 'PMA01' then null;
  end;
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'update', 'band',
      '{"id":"band-a","name":"Should Roll Back","defaultMemberIds":["unknown"],"active":true}'::jsonb,
      2
    );
    raise exception 'Band update with an unknown Member was accepted';
  exception when sqlstate 'PMA01' then null;
  end;
  if not exists (
    select 1 from public.workspace_master_bands
    where workspace_id = '71000000-0000-0000-0000-000000000001'
      and band_id = 'band-a' and name = 'Alpha' and revision = 2
  ) or (select array_agg(member_id order by position)
        from public.workspace_master_band_members
        where workspace_id = '71000000-0000-0000-0000-000000000001'
          and band_id = 'band-a') <> array['member-a', 'member-b'] then
    raise exception 'Rejected Band update left partial body or relation changes';
  end if;
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'update', 'band',
      '{"id":"band-a","name":"stale","defaultMemberIds":[],"active":true}'::jsonb,
      1
    );
    raise exception 'Stale Band revision was accepted';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'delete', 'band', '{"id":"band-a"}'::jsonb, 1
    );
    raise exception 'Stale Band delete revision was accepted';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000073',
      '71000000-0000-0000-0000-000000000001',
      'create', 'member',
      '{"id":"viewer-member","realName":"Viewer","active":true}'::jsonb,
      null
    );
    raise exception 'Viewer mutation was accepted';
  exception when sqlstate '42501' then null;
  end;

  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000074',
      '71000000-0000-0000-0000-000000000001',
      'create', 'member',
      '{"id":"outsider-member","realName":"Outsider","active":true}'::jsonb,
      null
    );
    raise exception 'Cross-Workspace/outsider mutation was accepted';
  exception when sqlstate '42501' then null;
  end;

  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000002',
      'create', 'member',
      '{"id":"legacy-member","realName":"Legacy","active":true}'::jsonb,
      null
    );
    raise exception 'Legacy Workspace mutation was accepted';
  exception when sqlstate '55000' then null;
  end;

  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'delete', 'member', '{"id":"member-a"}'::jsonb, 1
    );
    raise exception 'Referenced Member deletion was accepted';
  exception when foreign_key_violation then null;
  end;
end;
$$;

-- A real FK reference remains a 23503 deletion conflict; it is intentionally
-- distinct from the PMA01 input-reference error above.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '71000000-0000-0000-0000-000000000001',
  'master-contract-event',
  'Master Contract Event',
  pg_temp.workspace_master_contract_v2_snapshot(
    'master-contract-event', 'Master Contract Event'
  )
);
insert into public.cloud_event_member_references (
  workspace_id, event_id, member_id
) values
  ('71000000-0000-0000-0000-000000000001',
   'master-contract-event', 'member-a'),
  ('71000000-0000-0000-0000-000000000001',
   'master-contract-event', 'member-b');
insert into public.cloud_event_band_references (
  workspace_id, event_id, band_id
) values (
  '71000000-0000-0000-0000-000000000001',
  'master-contract-event',
  'band-a'
);
do $$
begin
  begin
    perform public.mutate_workspace_master_validated(
      '00000000-0000-0000-0000-000000000071',
      '71000000-0000-0000-0000-000000000001',
      'delete', 'band', '{"id":"band-a"}'::jsonb, 2
    );
    raise exception 'Referenced Band deletion was accepted';
  exception when foreign_key_violation then null;
  end;
end;
$$;
delete from public.cloud_events
where workspace_id = '71000000-0000-0000-0000-000000000001'
  and event_id = 'master-contract-event';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000073',
  true
);

do $$
declare
  page jsonb;
  current_generation text;
begin
  page := public.load_workspace_masters_page_authorized(
    '71000000-0000-0000-0000-000000000001', null, null, 100, null
  );
  if page ->> 'status' <> 'ok'
    or jsonb_array_length(page -> 'rows') <> 3 then
    raise exception 'Viewer could not read the complete Master page';
  end if;
  current_generation := page ->> 'workspaceGeneration';
  begin
    perform public.load_workspace_masters_page_authorized(
      '71000000-0000-0000-0000-000000000001', null, null, 100,
      (current_generation::bigint - 1)::text
    );
    raise exception 'Stale Workspace generation was accepted';
  exception when sqlstate '40001' then null;
  end;

  perform set_config(
    'request.jwt.claim.sub',
    '00000000-0000-0000-0000-000000000074',
    true
  );
  begin
    perform public.load_workspace_masters_page_authorized(
      '71000000-0000-0000-0000-000000000001', null, null, 100, null
    );
    raise exception 'Outsider Master read was accepted';
  exception when sqlstate '42501' then null;
  end;
  perform set_config(
    'request.jwt.claim.sub',
    '00000000-0000-0000-0000-000000000071',
    true
  );
  begin
    perform public.load_workspace_masters_page_authorized(
      '71000000-0000-0000-0000-000000000002', null, null, 100, null
    );
    raise exception 'Legacy Workspace Master read was accepted';
  exception when sqlstate '55000' then null;
  end;
end;
$$;

reset role;

-- Remove the Band atomically, then the previously referenced Member.
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'delete', 'band', '{"id":"band-a"}'::jsonb, 2
);
select public.mutate_workspace_master_validated(
  '00000000-0000-0000-0000-000000000071',
  '71000000-0000-0000-0000-000000000001',
  'delete', 'member', '{"id":"member-a"}'::jsonb, 1
);

rollback;
