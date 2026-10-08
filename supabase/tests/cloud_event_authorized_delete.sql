\set ON_ERROR_STOP on

-- Run only against a disposable Supabase/PostgreSQL database after applying all
-- repository migrations. This transaction rolls back every fixture.
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
        'name', event_name
      ))
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
  ('10000000-0000-0000-0000-000000000002', 'Cloud delete workspace B');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'editor'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'viewer');

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
  if has_table_privilege('authenticated', 'public.cloud_events', 'delete') then
    raise exception 'authenticated must not have direct cloud_events DELETE';
  end if;
  if not has_table_privilege('authenticated', 'public.cloud_events', 'select')
    or not has_table_privilege('authenticated', 'public.cloud_events', 'insert')
    or not has_table_privilege('authenticated', 'public.cloud_events', 'update') then
    raise exception 'authenticated must retain cloud_events SELECT/INSERT/UPDATE';
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

-- Owner keeps SELECT/INSERT/UPDATE through the table API, but direct DELETE is
-- denied even though the row is visible and owned by an editable Workspace.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);
do $$
declare
  affected integer;
begin
  if not exists (
    select 1 from public.cloud_events
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'owner-direct-event'
  ) then
    raise exception 'owner could not SELECT cloud event';
  end if;

  insert into public.cloud_events (
    workspace_id, event_id, event_name, event_snapshot
  ) values (
    '10000000-0000-0000-0000-000000000001',
    'owner-write-event',
    'Owner Write Event',
    pg_temp.cloud_event_test_snapshot('owner-write-event', 'Owner Write Event')
  );
  update public.cloud_events
    set event_name = 'Owner Updated Event',
        event_snapshot = pg_temp.cloud_event_test_snapshot(
          'owner-write-event', 'Owner Updated Event'
        )
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'owner-write-event';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'owner UPDATE did not affect exactly one row';
  end if;

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

-- Editor has the same direct write capabilities except DELETE, which remains
-- available only through the authorized RPC below.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000002',
  true
);
do $$
declare
  affected integer;
begin
  insert into public.cloud_events (
    workspace_id, event_id, event_name, event_snapshot
  ) values (
    '10000000-0000-0000-0000-000000000001',
    'editor-write-event',
    'Editor Write Event',
    pg_temp.cloud_event_test_snapshot('editor-write-event', 'Editor Write Event')
  );
  update public.cloud_events
    set event_name = 'Editor Updated Event',
        event_snapshot = pg_temp.cloud_event_test_snapshot(
          'editor-write-event', 'Editor Updated Event'
        )
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'editor-write-event';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'editor UPDATE did not affect exactly one row';
  end if;

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
declare
  affected integer;
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

  update public.cloud_events
    set event_name = 'Viewer Updated Event'
    where workspace_id = '10000000-0000-0000-0000-000000000001'
      and event_id = 'viewer-rls-event';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'viewer UPDATE unexpectedly changed a row';
  end if;

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
