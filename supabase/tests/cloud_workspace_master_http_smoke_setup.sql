\set ON_ERROR_STOP on

-- HTTP smoke fixture. Run only through cloudWorkspaceMasterHttpSmoke.mjs
-- against a new disposable local Supabase database.
begin;

delete from public.workspaces
where id in (
  '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000002',
  '68000000-0000-0000-0000-000000000003'
);

insert into public.workspaces (id, name) values
  ('68000000-0000-0000-0000-000000000001', 'Master HTTP smoke ready'),
  ('68000000-0000-0000-0000-000000000002', 'Master HTTP smoke other'),
  ('68000000-0000-0000-0000-000000000003', 'Master HTTP smoke legacy');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('68000000-0000-0000-0000-000000000001', :'owner_user_id'::uuid, 'owner'),
  ('68000000-0000-0000-0000-000000000001', :'editor_user_id'::uuid, 'editor'),
  ('68000000-0000-0000-0000-000000000001', :'viewer_user_id'::uuid, 'viewer'),
  ('68000000-0000-0000-0000-000000000002', :'outsider_user_id'::uuid, 'owner'),
  ('68000000-0000-0000-0000-000000000003', :'owner_user_id'::uuid, 'owner');

update public.cloud_workspace_master_states
set status = 'ready'
where workspace_id in (
  '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000002'
);

do $$
begin
  if (select count(*) from public.workspaces where id in (
        '68000000-0000-0000-0000-000000000001',
        '68000000-0000-0000-0000-000000000002',
        '68000000-0000-0000-0000-000000000003'
      )) <> 3
    or (select count(*) from public.workspace_members
        where workspace_id in (
          '68000000-0000-0000-0000-000000000001',
          '68000000-0000-0000-0000-000000000002',
          '68000000-0000-0000-0000-000000000003'
        )) <> 5
    or (select count(*) from public.cloud_workspace_master_states
        where workspace_id in (
          '68000000-0000-0000-0000-000000000001',
          '68000000-0000-0000-0000-000000000002'
        ) and status = 'ready') <> 2
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '68000000-0000-0000-0000-000000000003')
        is distinct from 'legacy' then
    raise exception 'Workspace Master HTTP smoke fixture setup failed';
  end if;
end;
$$;

commit;
