\set ON_ERROR_STOP on

-- Delete only the fixed Workspace IDs reserved by the HTTP smoke fixture.
begin;

delete from public.workspaces
where id in (
  '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000002',
  '68000000-0000-0000-0000-000000000003'
);

commit;
