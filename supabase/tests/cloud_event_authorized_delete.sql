\set ON_ERROR_STOP on

-- Run only against a disposable Supabase/PostgreSQL database after applying all
-- repository migrations. This transaction rolls back every fixture. The
-- helper below is a complete, app-loadable empty Event snapshot rather than
-- the older database-shape-only fixture.
begin;

create or replace function pg_temp.cloud_event_test_snapshot(
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

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
   'cloud-delete-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
   'cloud-delete-editor@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated',
   'cloud-delete-viewer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated',
   'cloud-delete-outsider@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.workspaces (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Cloud delete workspace A'),
  ('10000000-0000-0000-0000-000000000002', 'Cloud delete workspace B'),
  ('10000000-0000-0000-0000-000000000003', 'Cloud page order workspace');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'editor'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'viewer'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'owner');

do $$
begin
  if not has_function_privilege(
    'authenticated',
    'public.delete_cloud_event_authorized(uuid,text)',
    'execute'
  ) then
    raise exception 'authenticated must be able to execute delete RPC';
  end if;
  if has_function_privilege(
    'anon',
    'public.delete_cloud_event_authorized(uuid,text)',
    'execute'
  ) then
    raise exception 'anon must not be able to execute delete RPC';
  end if;
  if has_function_privilege(
    'service_role',
    'public.delete_cloud_event_authorized(uuid,text)',
    'execute'
  ) then
    raise exception 'service_role must not be able to execute delete RPC';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.load_cloud_events_page_authorized(uuid,text,integer)',
    'execute'
  ) then
    raise exception 'authenticated must be able to execute page RPC';
  end if;
  if has_function_privilege(
    'anon',
    'public.load_cloud_events_page_authorized(uuid,text,integer)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'public.load_cloud_events_page_authorized(uuid,text,integer)',
    'execute'
  ) then
    raise exception 'anon and service_role must not be able to execute page RPC';
  end if;
  if has_table_privilege('authenticated', 'public.cloud_events', 'delete') then
    raise exception 'authenticated must not have direct cloud_events DELETE';
  end if;
  if not has_table_privilege('authenticated', 'public.cloud_events', 'select')
    or has_table_privilege('authenticated', 'public.cloud_events', 'insert')
    or has_table_privilege('authenticated', 'public.cloud_events', 'update') then
    raise exception 'authenticated must retain SELECT but not direct writes';
  end if;
  if has_any_column_privilege(
    'authenticated', 'public.cloud_events', 'insert,update'
  ) then
    raise exception 'authenticated must not retain column-level write privileges';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.save_cloud_event_validated(uuid,uuid,jsonb)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.save_cloud_event_validated(uuid,uuid,jsonb)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.save_cloud_event_validated(uuid,uuid,jsonb)',
    'execute'
  ) then
    raise exception 'internal save RPC privileges are incorrect';
  end if;
end
$$;

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values
  ('10000000-0000-0000-0000-000000000001', 'owner-event', 'Owner Event',
   pg_temp.cloud_event_test_snapshot('owner-event', 'Owner Event')),
  ('10000000-0000-0000-0000-000000000001', 'editor-event', 'Editor Event',
   pg_temp.cloud_event_test_snapshot('editor-event', 'Editor Event')),
  ('10000000-0000-0000-0000-000000000001', 'viewer-rls-event', 'Viewer RLS Event',
   pg_temp.cloud_event_test_snapshot('viewer-rls-event', 'Viewer RLS Event')),
  ('10000000-0000-0000-0000-000000000001', 'owner-direct-event', 'Owner Direct Event',
   pg_temp.cloud_event_test_snapshot('owner-direct-event', 'Owner Direct Event')),
  ('10000000-0000-0000-0000-000000000001', 'editor-direct-event', 'Editor Direct Event',
   pg_temp.cloud_event_test_snapshot('editor-direct-event', 'Editor Direct Event'));

insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values
  ('10000000-0000-0000-0000-000000000003', '!mark', '!mark',
   pg_temp.cloud_event_test_snapshot('!mark', '!mark')),
  ('10000000-0000-0000-0000-000000000003', 'A', 'A',
   pg_temp.cloud_event_test_snapshot('A', 'A')),
  ('10000000-0000-0000-0000-000000000003', 'a', 'a',
   pg_temp.cloud_event_test_snapshot('a', 'a')),
  ('10000000-0000-0000-0000-000000000003', 'あ', 'あ',
   pg_temp.cloud_event_test_snapshot('あ', 'あ')),
  ('10000000-0000-0000-0000-000000000003', '😀', '😀',
   pg_temp.cloud_event_test_snapshot('😀', '😀')),
  ('10000000-0000-0000-0000-000000000003', '𠮷', '𠮷',
   pg_temp.cloud_event_test_snapshot('𠮷', '𠮷'));

-- The service role is only a transport to the backend-only RPC. The actor ID
-- is still authorized and locked inside the same transaction as the upsert.
set local role service_role;
do $$
declare
  saved jsonb;
begin
  saved := public.save_cloud_event_validated(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    pg_temp.cloud_event_test_snapshot('backend-save-event', 'Backend Save Event')
  );
  if saved ->> 'event_id' <> 'backend-save-event'
    or (saved ->> 'revision')::bigint <> 1 then
    raise exception 'backend INSERT response is invalid: %', saved;
  end if;

  saved := public.save_cloud_event_validated(
    '00000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    pg_temp.cloud_event_test_snapshot('backend-save-event', 'Backend Save Updated')
  );
  if saved ->> 'event_name' <> 'Backend Save Updated'
    or (saved ->> 'revision')::bigint <> 2 then
    raise exception 'backend UPDATE/revision response is invalid: %', saved;
  end if;

  begin
    perform public.save_cloud_event_validated(
      '00000000-0000-0000-0000-000000000003',
      '10000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_test_snapshot('viewer-backend-save', 'Viewer Save')
    );
    raise exception 'viewer backend save unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    perform public.save_cloud_event_validated(
      '00000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_test_snapshot('outsider-backend-save', 'Outsider Save')
    );
    raise exception 'non-member backend save unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    perform public.save_cloud_event_validated(
      '00000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      pg_temp.cloud_event_test_snapshot('cross-workspace-save', 'Cross Workspace')
    );
    raise exception 'cross-workspace backend save unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

-- The read RPC authorizes every page and owns the keyset ordering. It returns
-- an envelope even when the authorized page is empty.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);
do $$
declare
  first_page jsonb;
  final_page jsonb;
  ordered_ids jsonb;
begin
  first_page := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000001', null, 2
  );
  if first_page ->> 'status' <> 'ok'
    or first_page ->> 'workspace_id' <>
      '10000000-0000-0000-0000-000000000001'
    or jsonb_array_length(first_page -> 'rows') <> 2
    or first_page ->> 'next_cursor' is null
    or first_page ->> 'next_cursor' <>
      first_page #>> '{rows,1,event_id}' then
    raise exception 'unexpected authorized first page: %', first_page;
  end if;

  final_page := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000001',
    first_page ->> 'next_cursor',
    100
  );
  if final_page ->> 'status' <> 'ok'
    or final_page ->> 'next_cursor' is not null
    or jsonb_array_length(final_page -> 'rows') = 0 then
    raise exception 'unexpected authorized final page: %', final_page;
  end if;

  final_page := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000001', 'zzzz', 100
  );
  if final_page ->> 'status' <> 'ok'
    or jsonb_array_length(final_page -> 'rows') <> 0
    or final_page ->> 'next_cursor' is not null then
    raise exception 'authorized empty page did not return an envelope: %', final_page;
  end if;

  final_page := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000003', null, 100
  );
  select jsonb_agg(page_entry.value ->> 'event_id' order by page_entry.ordinality)
    into ordered_ids
    from jsonb_array_elements(final_page -> 'rows') with ordinality
      as page_entry(value, ordinality);
  if ordered_ids is distinct from '["!mark", "A", "a", "あ", "😀", "𠮷"]'::jsonb then
    raise exception 'C-collated page order is unexpected: %', ordered_ids;
  end if;

  begin
    perform public.load_cloud_events_page_authorized(
      '10000000-0000-0000-0000-000000000001', '   ', 100
    );
    raise exception 'blank page cursor unexpectedly succeeded';
  exception when sqlstate '22023' then
    null;
  end;
  begin
    perform public.load_cloud_events_page_authorized(
      '10000000-0000-0000-0000-000000000001', null, 101
    );
    raise exception 'oversized page unexpectedly succeeded';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000001', null, 1
  );
  if result ->> 'status' <> 'ok' or jsonb_array_length(result -> 'rows') <> 1 then
    raise exception 'editor could not read an authorized page: %', result;
  end if;
end
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000003',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000001', null, 1
  );
  if result ->> 'status' <> 'ok' or jsonb_array_length(result -> 'rows') <> 1 then
    raise exception 'viewer could not read an authorized page: %', result;
  end if;
end
$$;
reset role;

-- editor -> viewer remains readable because viewer is a read role.
update public.workspace_members
  set role = 'viewer'
  where workspace_id = '10000000-0000-0000-0000-000000000001'
    and user_id = '00000000-0000-0000-0000-000000000002';
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.load_cloud_events_page_authorized(
    '10000000-0000-0000-0000-000000000001', 'zzzz', 100
  );
  if result ->> 'status' <> 'ok' or jsonb_array_length(result -> 'rows') <> 0 then
    raise exception 'downgraded viewer could not read an authorized empty page: %', result;
  end if;
end
$$;
reset role;
update public.workspace_members
  set role = 'editor'
  where workspace_id = '10000000-0000-0000-0000-000000000001'
    and user_id = '00000000-0000-0000-0000-000000000002';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000004',
  true
);
do $$
begin
  begin
    perform public.load_cloud_events_page_authorized(
      '10000000-0000-0000-0000-000000000001', null, 100
    );
    raise exception 'non-member page read unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
begin
  begin
    perform public.load_cloud_events_page_authorized(
      '10000000-0000-0000-0000-000000000002', null, 100
    );
    raise exception 'cross-workspace page read unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform public.load_cloud_events_page_authorized(
      '10000000-0000-0000-0000-000000000001', null, 100
    );
    raise exception 'anonymous page read unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

-- Owners retain SELECT, but every direct write path is denied. Saving goes
-- through the backend-only validator/RPC path tested below.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);
do $$
begin
  if not exists (
    select 1 from public.cloud_events
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'owner-direct-event'
  ) then
    raise exception 'owner could not SELECT cloud event';
  end if;

  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'owner-write-event',
      'Owner Write Event',
      pg_temp.cloud_event_test_snapshot('owner-write-event', 'Owner Write Event')
    );
    raise exception 'owner direct INSERT unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'owner-incomplete-event',
      'Owner Incomplete Event',
      jsonb_build_object(
        'format', 'acappella-tt-cloud-event',
        'version', 1,
        'appState', jsonb_build_object(
          'version', 5,
          'events', jsonb_build_array(jsonb_build_object(
            'id', 'owner-incomplete-event',
            'name', 'Owner Incomplete Event'
          ))
        )
      )
    );
    raise exception 'owner incomplete direct INSERT unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.cloud_events
      set event_name = 'Owner Updated Event'
      where workspace_id = '10000000-0000-0000-0000-000000000001'
        and event_id = 'owner-direct-event';
    raise exception 'owner direct UPDATE unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'owner-direct-event',
      'Owner Upsert Event',
      pg_temp.cloud_event_test_snapshot('owner-direct-event', 'Owner Upsert Event')
    ) on conflict (workspace_id, event_id) do update
      set event_name = excluded.event_name,
          event_snapshot = excluded.event_snapshot;
    raise exception 'owner direct UPSERT unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    perform public.save_cloud_event_validated(
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      pg_temp.cloud_event_test_snapshot('forged-rpc-event', 'Forged RPC Event')
    );
    raise exception 'authenticated direct internal save RPC unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    delete from public.cloud_events
      where workspace_id = '10000000-0000-0000-0000-000000000001'
        and event_id = 'owner-direct-event';
    raise exception 'owner direct DELETE unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

-- Editors have the same direct-write denial as owners.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
begin
  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'editor-write-event',
      'Editor Write Event',
      pg_temp.cloud_event_test_snapshot('editor-write-event', 'Editor Write Event')
    );
    raise exception 'editor direct INSERT unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.cloud_events
      set event_name = 'Editor Updated Event'
      where workspace_id = '10000000-0000-0000-0000-000000000001'
        and event_id = 'editor-direct-event';
    raise exception 'editor direct UPDATE unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    delete from public.cloud_events
      where workspace_id = '10000000-0000-0000-0000-000000000001'
        and event_id = 'editor-direct-event';
    raise exception 'editor direct DELETE unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

do $$
begin
  if not exists (
    select 1 from public.cloud_events
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'owner-direct-event'
  ) or not exists (
    select 1 from public.cloud_events
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'editor-direct-event'
  ) then
    raise exception 'direct DELETE test unexpectedly removed a row';
  end if;
end
$$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.delete_cloud_event_authorized(
    '10000000-0000-0000-0000-000000000001',
    'owner-event'
  );
  if result is distinct from jsonb_build_object(
    'status', 'deleted',
    'workspace_id', '10000000-0000-0000-0000-000000000001'::uuid,
    'event_id', 'owner-event'
  ) then
    raise exception 'unexpected owner delete result: %', result;
  end if;

  result := public.delete_cloud_event_authorized(
    '10000000-0000-0000-0000-000000000001',
    'owner-event'
  );
  if result ->> 'status' <> 'already_absent' then
    raise exception 'authorized missing owner event was not idempotent: %', result;
  end if;
end
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
declare
  result jsonb;
begin
  result := public.delete_cloud_event_authorized(
    '10000000-0000-0000-0000-000000000001',
    'editor-event'
  );
  if result ->> 'status' <> 'deleted' then
    raise exception 'editor did not delete existing event: %', result;
  end if;
  result := public.delete_cloud_event_authorized(
    '10000000-0000-0000-0000-000000000001',
    'missing-editor-event'
  );
  if result ->> 'status' <> 'already_absent' then
    raise exception 'authorized missing editor event was not idempotent: %', result;
  end if;
end
$$;
reset role;

-- Viewer can SELECT, but INSERT/UPDATE/DELETE all remain unavailable. DELETE is
-- rejected by the table privilege boundary before RLS can silently affect zero
-- rows.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000003',
  true
);
do $$
begin
  if not exists (
    select 1 from public.cloud_events
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'viewer-rls-event'
  ) then
    raise exception 'viewer could not SELECT visible cloud event';
  end if;

  begin
    insert into public.cloud_events (
      workspace_id, event_id, event_name, event_snapshot
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'viewer-write-event',
      'Viewer Write Event',
      pg_temp.cloud_event_test_snapshot('viewer-write-event', 'Viewer Write Event')
    );
    raise exception 'viewer INSERT unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.cloud_events
      set event_name = 'Viewer Updated Event'
      where workspace_id = '10000000-0000-0000-0000-000000000001'
        and event_id = 'viewer-rls-event';
    raise exception 'viewer UPDATE unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    delete from public.cloud_events
      where workspace_id = '10000000-0000-0000-0000-000000000001'
        and event_id = 'viewer-rls-event';
    raise exception 'viewer direct DELETE unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

do $$
begin
  if not exists (
    select 1 from public.cloud_events
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'viewer-rls-event'
  ) then
    raise exception 'viewer RLS test event was unexpectedly deleted';
  end if;
end
$$;

-- Viewer, non-member, cross-workspace and unauthenticated callers must not
-- learn whether a Cloud Event exists.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000003',
  true
);
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '10000000-0000-0000-0000-000000000001',
      'viewer-rls-event'
    );
    raise exception 'viewer delete unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000004',
  true
);
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '10000000-0000-0000-0000-000000000001',
      'viewer-rls-event'
    );
    raise exception 'non-member delete unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '10000000-0000-0000-0000-000000000002',
      'unknown-in-other-workspace'
    );
    raise exception 'cross-workspace delete unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '10000000-0000-0000-0000-000000000001',
      'viewer-rls-event'
    );
    raise exception 'anonymous delete unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

-- Simulate a successful client-side precheck followed by membership deletion.
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 'editor');
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000004',
  true
);
do $$
begin
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and user_id = auth.uid()
      and role = 'editor'
  ) then
    raise exception 'membership precheck fixture is invalid';
  end if;
end
$$;
reset role;
delete from public.workspace_members
  where workspace_id = '10000000-0000-0000-0000-000000000001'
    and user_id = '00000000-0000-0000-0000-000000000004';
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000004',
  true
);
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '10000000-0000-0000-0000-000000000001',
      'viewer-rls-event'
    );
    raise exception 'revoked membership delete unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

-- Simulate a successful client-side precheck followed by editor -> viewer.
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 'editor');
update public.workspace_members
  set role = 'viewer'
  where workspace_id = '10000000-0000-0000-0000-000000000001'
    and user_id = '00000000-0000-0000-0000-000000000004';
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000004',
  true
);
do $$
begin
  begin
    perform public.delete_cloud_event_authorized(
      '10000000-0000-0000-0000-000000000001',
      'viewer-rls-event'
    );
    raise exception 'downgraded membership delete unexpectedly succeeded';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
reset role;

-- The existing JSON CHECK accepts numeric versions and rejects numeric strings,
-- missing keys and JSON null before any malformed row can persist.
insert into public.cloud_events (
  workspace_id, event_id, event_name, event_snapshot
) values (
  '10000000-0000-0000-0000-000000000001',
  'valid-json-event',
  'Valid JSON Event',
  pg_temp.cloud_event_test_snapshot('valid-json-event', 'Valid JSON Event')
);

do $$
declare
  malformed jsonb;
begin
  foreach malformed in array array[
    jsonb_set(
      pg_temp.cloud_event_test_snapshot('invalid-version-string', 'Invalid Version String'),
      '{version}',
      '"1"'::jsonb
    ),
    jsonb_set(
      pg_temp.cloud_event_test_snapshot('invalid-app-version-string', 'Invalid App Version String'),
      '{appState,version}',
      '"5"'::jsonb
    ),
    pg_temp.cloud_event_test_snapshot('missing-version', 'Missing Version') - 'version',
    jsonb_set(
      pg_temp.cloud_event_test_snapshot('null-version', 'Null Version'),
      '{version}',
      'null'::jsonb
    )
  ] loop
    begin
      insert into public.cloud_events (
        workspace_id,
        event_id,
        event_name,
        event_snapshot
      ) values (
        '10000000-0000-0000-0000-000000000001',
        malformed #>> '{appState,events,0,id}',
        malformed #>> '{appState,events,0,name}',
        malformed
      );
      raise exception 'malformed JSON snapshot unexpectedly passed CHECK: %', malformed;
    exception when check_violation then
      null;
    end;
  end loop;
end
$$;

rollback;
