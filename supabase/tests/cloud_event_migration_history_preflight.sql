-- Read-only preflight for the one-time Cloud Event base-migration rename.
-- Run through scripts/cloudEventMigrationRepair.mjs or psql with ON_ERROR_STOP.
-- This file intentionally contains no DDL, DML, transaction-control, or repair.

\set history_table_exists false
\set applied_versions '[]'
\set cloud_events_exists false
\set cloud_row_count 0
\set cloud_data_digest 'absent'

select (to_regclass('supabase_migrations.schema_migrations') is not null)::text
  as history_table_exists
\gset

\if :history_table_exists
select coalesce(jsonb_agg(version::text order by version::text), '[]'::jsonb)::text
  as applied_versions
from supabase_migrations.schema_migrations
\gset
\endif

select (to_regclass('public.cloud_events') is not null)::text
  as cloud_events_exists
\gset

\if :cloud_events_exists
select
  count(*)::text as cloud_row_count,
  md5(coalesce(
    string_agg(md5(to_jsonb(cloud_events)::text), '' order by workspace_id, event_id),
    ''
  )) as cloud_data_digest
from public.cloud_events
\gset
\endif

with cloud_table as (
  select pg_class.oid, pg_class.relacl, pg_class.relowner, pg_class.relrowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname = 'cloud_events'
    and pg_class.relkind = 'r'
),
authenticated_role as (
  select oid from pg_catalog.pg_roles where rolname = 'authenticated'
),
anon_role as (
  select oid from pg_catalog.pg_roles where rolname = 'anon'
),
constraint_definitions as (
  select
    pg_constraint.contype,
    pg_constraint.conname,
    lower(pg_get_constraintdef(pg_constraint.oid, true)) as definition
  from pg_catalog.pg_constraint
  join cloud_table on cloud_table.oid = pg_constraint.conrelid
),
base_checks as (
  select jsonb_build_object(
    'columns', (
      select count(*) = 7 and bool_and(case columns.column_name
        when 'workspace_id' then columns.udt_name = 'uuid'
          and columns.is_nullable = 'NO' and columns.column_default is null
        when 'event_id' then columns.udt_name = 'text'
          and columns.is_nullable = 'NO' and columns.column_default is null
        when 'event_name' then columns.udt_name = 'text'
          and columns.is_nullable = 'NO' and columns.column_default is null
        when 'event_snapshot' then columns.udt_name = 'jsonb'
          and columns.is_nullable = 'NO' and columns.column_default is null
        when 'revision' then columns.udt_name = 'int8'
          and columns.is_nullable = 'NO' and columns.column_default like '%1%'
        when 'created_at' then columns.udt_name = 'timestamptz'
          and columns.is_nullable = 'NO' and columns.column_default like '%now()%'
        when 'updated_at' then columns.udt_name = 'timestamptz'
          and columns.is_nullable = 'NO' and columns.column_default like '%now()%'
        else false
      end)
      from information_schema.columns
      where columns.table_schema = 'public' and columns.table_name = 'cloud_events'
    ),
    'primaryKey', exists (
      select 1 from constraint_definitions
      where contype = 'p' and replace(definition, ' ', '') =
        'primarykey(workspace_id,event_id)'
    ),
    'workspaceForeignKey', exists (
      select 1 from constraint_definitions
      where contype = 'f'
        and definition like '%foreign key (workspace_id)%'
        and definition like '%references workspaces(id)%'
        and definition like '%on delete cascade%'
    ),
    'eventIdCheck', exists (
      select 1 from constraint_definitions
      where contype = 'c' and replace(definition, ' ', '') like '%btrim(event_id)<>%'
    ),
    'eventNameCheck', exists (
      select 1 from constraint_definitions
      where contype = 'c' and replace(definition, ' ', '') like '%btrim(event_name)<>%'
    ),
    'revisionCheck', exists (
      select 1 from constraint_definitions
      where contype = 'c' and replace(definition, ' ', '') like '%revision>0%'
    ),
    'strictSnapshotCheck', exists (
      select 1 from constraint_definitions
      where conname = 'cloud_events_snapshot_shape_check'
        and definition like '%jsonb_typeof%'
        and definition like '%appstate,events,0%object%'
        and definition like '%appstate,events,0,id%string%'
        and definition like '%appstate,events,0,name%string%'
        and definition like '%case%'
        and definition like '%is true%'
    ),
    'updatedAtIndex', exists (
      select 1 from pg_catalog.pg_indexes
      where schemaname = 'public'
        and indexname = 'cloud_events_workspace_updated_at_idx'
        and lower(indexdef) like '%(workspace_id, updated_at desc, event_id)%'
    ),
    'initializeFunction', exists (
      select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure('public.initialize_cloud_event_metadata()')
        and prosrc like '%new.revision = 1%'
        and prosrc like '%new.created_at = now()%'
        and prosrc like '%new.updated_at = now()%'
    ),
    'protectFunction', exists (
      select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure('public.protect_cloud_event_ownership_and_revision()')
        and prosrc like '%new.workspace_id is distinct from old.workspace_id%'
        and prosrc like '%new.event_id is distinct from old.event_id%'
        and prosrc like '%new.revision = old.revision + 1%'
    ),
    'initializeTrigger', exists (
      select 1 from pg_catalog.pg_trigger
      join cloud_table on cloud_table.oid = pg_trigger.tgrelid
      where not pg_trigger.tgisinternal
        and pg_trigger.tgname = 'cloud_events_initialize_metadata'
        and pg_trigger.tgfoid = to_regprocedure('public.initialize_cloud_event_metadata()')
        and lower(pg_get_triggerdef(pg_trigger.oid, true)) like '%before insert%'
    ),
    'protectTrigger', exists (
      select 1 from pg_catalog.pg_trigger
      join cloud_table on cloud_table.oid = pg_trigger.tgrelid
      where not pg_trigger.tgisinternal
        and pg_trigger.tgname = 'cloud_events_protect_ownership_and_revision'
        and pg_trigger.tgfoid =
          to_regprocedure('public.protect_cloud_event_ownership_and_revision()')
        and lower(pg_get_triggerdef(pg_trigger.oid, true)) like '%before update%'
    ),
    'rowLevelSecurity', coalesce((select relrowsecurity from cloud_table), false),
    'policies', (
      select count(*) = 4
        and count(*) filter (where policyname = 'cloud_events_select_for_member'
          and cmd = 'SELECT'
          and lower(coalesce(qual, '')) like '%workspace_members%'
          and lower(coalesce(qual, '')) like '%auth.uid%') = 1
        and count(*) filter (where policyname = 'cloud_events_insert_for_editor'
          and cmd = 'INSERT'
          and lower(coalesce(with_check, '')) like '%workspace_members%'
          and lower(coalesce(with_check, '')) like '%owner%editor%') = 1
        and count(*) filter (where policyname = 'cloud_events_update_for_editor'
          and cmd = 'UPDATE'
          and lower(coalesce(qual, '')) like '%workspace_members%'
          and lower(coalesce(with_check, '')) like '%owner%editor%') = 1
        and count(*) filter (where policyname = 'cloud_events_delete_for_editor'
          and cmd = 'DELETE'
          and lower(coalesce(qual, '')) like '%workspace_members%'
          and lower(coalesce(qual, '')) like '%owner%editor%') = 1
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'cloud_events'
    )
  ) as value
),
later_schema as (
  select jsonb_build_object(
    'authorizedDeleteFunction', exists (
      select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure('public.delete_cloud_event_authorized(uuid,text)')
        and lower(prosrc) like '%from public.workspace_members%'
        and lower(prosrc) like '%for share%'
        and lower(prosrc) like '%delete from public.cloud_events%'
        and lower(prosrc) like '%already_absent%'
    ),
    'authorizedPageIndex', exists (
      select 1 from pg_catalog.pg_indexes
      where schemaname = 'public'
        and indexname = 'cloud_events_workspace_event_id_c_idx'
        and indexdef like '%event_id COLLATE "C"%'
    ),
    'authorizedPageFunction', exists (
      select 1 from pg_catalog.pg_proc
      where oid =
        to_regprocedure('public.load_cloud_events_page_authorized(uuid,text,integer)')
        and lower(prosrc) like '%from public.workspace_members%'
        and lower(prosrc) like '%for share%'
        and prosrc like '%event_id collate "C"%'
        and lower(prosrc) like '%limit (p_page_size + 1)%'
    ),
    'authorizedSaveFunction', exists (
      select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure('public.save_cloud_event_validated(uuid,uuid,jsonb)')
        and lower(prosrc) like '%from public.workspace_members%'
        and lower(prosrc) like '%for share%'
        and lower(prosrc) like '%insert into public.cloud_events%'
        and lower(prosrc) like '%on conflict (workspace_id, event_id) do update%'
    ),
    'authenticatedSelect', coalesce((select has_table_privilege(
      authenticated_role.oid, cloud_table.oid, 'SELECT'
    ) from authenticated_role cross join cloud_table), false),
    'authenticatedInsert', coalesce((select has_table_privilege(
      authenticated_role.oid, cloud_table.oid, 'INSERT'
    ) from authenticated_role cross join cloud_table), false),
    'authenticatedUpdate', coalesce((select has_table_privilege(
      authenticated_role.oid, cloud_table.oid, 'UPDATE'
    ) from authenticated_role cross join cloud_table), false),
    'authenticatedDelete', coalesce((select has_table_privilege(
      authenticated_role.oid, cloud_table.oid, 'DELETE'
    ) from authenticated_role cross join cloud_table), false),
    'authenticatedColumnInsert', coalesce((select bool_or(has_column_privilege(
      authenticated_role.oid, cloud_table.oid, pg_attribute.attnum, 'INSERT'
    ))
      from authenticated_role cross join cloud_table
      join pg_catalog.pg_attribute on pg_attribute.attrelid = cloud_table.oid
      where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
    ), false),
    'authenticatedColumnUpdate', coalesce((select bool_or(has_column_privilege(
      authenticated_role.oid, cloud_table.oid, pg_attribute.attnum, 'UPDATE'
    ))
      from authenticated_role cross join cloud_table
      join pg_catalog.pg_attribute on pg_attribute.attrelid = cloud_table.oid
      where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
    ), false),
    'anonOrPublicWrite',
      coalesce((select bool_or(
        has_table_privilege(anon_role.oid, cloud_table.oid, privilege_name)
      )
        from anon_role cross join cloud_table
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as privileges(privilege_name)
      ), false)
      or exists (
        select 1
        from cloud_table
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            cloud_table.relacl,
            pg_catalog.acldefault('r', cloud_table.relowner)
          )
        ) as table_acl
        where table_acl.grantee = 0
          and table_acl.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
      )
  ) as value
)
select jsonb_build_object(
  'target', jsonb_build_object(
    'database', current_database(),
    'currentUser', current_user,
    'serverAddress', inet_server_addr()::text,
    'serverPort', inet_server_port()
  ),
  'historyTableExists', :'history_table_exists'::boolean,
  'appliedVersions', :'applied_versions'::jsonb,
  'authWorkspaceReady',
    to_regclass('auth.users') is not null
    and to_regclass('public.workspaces') is not null
    and to_regclass('public.workspace_members') is not null,
  'cloudEventsExists', :'cloud_events_exists'::boolean,
  'baseSchemaChecks', base_checks.value,
  'laterSchema', later_schema.value,
  'cloudData', jsonb_build_object(
    'rowCount', :'cloud_row_count'::bigint,
    'digest', :'cloud_data_digest'
  )
)::text
from base_checks cross join later_schema;
