\set ON_ERROR_STOP on

-- Run only against a disposable database with all repository migrations.
-- Every fixture and mutation is rolled back.
begin;

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
  exception when foreign_key_violation then null;
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
