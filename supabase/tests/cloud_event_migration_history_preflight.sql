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

with auth_users_table as (
  select pg_class.oid
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'auth'
    and pg_class.relname = 'users'
    and pg_class.relkind = 'r'
),
profiles_table as (
  select pg_class.oid, pg_class.relacl, pg_class.relowner,
    pg_class.relrowsecurity, pg_class.relforcerowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname = 'profiles'
    and pg_class.relkind = 'r'
),
workspaces_table as (
  select pg_class.oid, pg_class.relacl, pg_class.relowner,
    pg_class.relrowsecurity, pg_class.relforcerowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname = 'workspaces'
    and pg_class.relkind = 'r'
),
workspace_members_table as (
  select pg_class.oid, pg_class.relacl, pg_class.relowner,
    pg_class.relrowsecurity, pg_class.relforcerowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname = 'workspace_members'
    and pg_class.relkind = 'r'
),
auth_workspace_tables as (
  select 'profiles'::text as table_name, * from profiles_table
  union all
  select 'workspaces'::text, * from workspaces_table
  union all
  select 'workspace_members'::text, * from workspace_members_table
),
auth_workspace_constraints as (
  select
    pg_class.relname as table_name,
    pg_constraint.contype,
    regexp_replace(
      lower(pg_get_constraintdef(pg_constraint.oid, true)),
      '\s+', '', 'g'
    ) as definition
  from pg_catalog.pg_constraint
  join pg_catalog.pg_class on pg_class.oid = pg_constraint.conrelid
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname in ('profiles', 'workspaces', 'workspace_members')
),
auth_workspace_policies as (
  select
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    regexp_replace(
      regexp_replace(lower(coalesce(qual, '')), '\s+', '', 'g'),
      '[()]', '', 'g'
    ) as normalized_qual,
    regexp_replace(
      regexp_replace(lower(coalesce(with_check, '')), '\s+', '', 'g'),
      '[()]', '', 'g'
    ) as normalized_with_check,
    qual is null as qual_is_null,
    with_check is null as with_check_is_null
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename in ('profiles', 'workspaces', 'workspace_members')
),
cloud_table as (
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
service_role as (
  select oid from pg_catalog.pg_roles where rolname = 'service_role'
),
authorized_save_function as (
  select
    pg_proc.oid,
    pg_proc.proacl,
    pg_proc.proowner,
    pg_proc.prosecdef,
    pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid =
    to_regprocedure('public.save_cloud_event_validated(uuid,uuid,jsonb)')
),
constraint_definitions as (
  select
    pg_constraint.contype,
    pg_constraint.conname,
    lower(pg_get_constraintdef(pg_constraint.oid, true)) as definition
  from pg_catalog.pg_constraint
  join cloud_table on cloud_table.oid = pg_constraint.conrelid
),
auth_workspace_checks as (
  select jsonb_build_object(
    'authUsersReference',
      (select count(*) = 1 from auth_users_table)
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'auth' and table_name = 'users'
          and column_name = 'id' and udt_name = 'uuid'
          and is_nullable = 'NO'
      ),
    'profilesColumns', (
      select count(*) = 4 and bool_and(case column_name
        when 'user_id' then udt_name = 'uuid' and is_nullable = 'NO'
          and column_default is null
        when 'display_name' then udt_name = 'text' and is_nullable = 'NO'
          and column_default is null
        when 'created_at' then udt_name = 'timestamptz' and is_nullable = 'NO'
          and column_default = 'now()'
        when 'updated_at' then udt_name = 'timestamptz' and is_nullable = 'NO'
          and column_default = 'now()'
        else false end)
      from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
    ),
    'workspacesColumns', (
      select count(*) = 4 and bool_and(case column_name
        when 'id' then udt_name = 'uuid' and is_nullable = 'NO'
          and column_default = 'gen_random_uuid()'
        when 'name' then udt_name = 'text' and is_nullable = 'NO'
          and column_default is null
        when 'created_at' then udt_name = 'timestamptz' and is_nullable = 'NO'
          and column_default = 'now()'
        when 'updated_at' then udt_name = 'timestamptz' and is_nullable = 'NO'
          and column_default = 'now()'
        else false end)
      from information_schema.columns
      where table_schema = 'public' and table_name = 'workspaces'
    ),
    'workspaceMembersColumns', (
      select count(*) = 3 and bool_and(case column_name
        when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          and column_default is null
        when 'user_id' then udt_name = 'uuid' and is_nullable = 'NO'
          and column_default is null
        when 'role' then udt_name = 'text' and is_nullable = 'NO'
          and column_default is null
        else false end)
      from information_schema.columns
      where table_schema = 'public' and table_name = 'workspace_members'
    ),
    'profilesPrimaryKey', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'profiles' and contype = 'p'
        and definition = 'primarykey(user_id)'
    ),
    'workspacesPrimaryKey', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspaces' and contype = 'p'
        and definition = 'primarykey(id)'
    ),
    'workspaceMembersPrimaryKey', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspace_members' and contype = 'p'
        and definition = 'primarykey(workspace_id,user_id)'
    ),
    'profilesUserForeignKey', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'profiles' and contype = 'f'
        and definition = 'foreignkey(user_id)referencesauth.users(id)ondeletecascade'
    ),
    'workspaceMemberUserForeignKey', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspace_members' and contype = 'f'
        and definition = 'foreignkey(user_id)referencesauth.users(id)ondeletecascade'
    ),
    'workspaceMemberWorkspaceForeignKey', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspace_members' and contype = 'f'
        and definition = 'foreignkey(workspace_id)referencesworkspaces(id)ondeletecascade'
    ),
    'profileNameCheck', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'profiles' and contype = 'c'
        and definition = 'check((btrim(display_name)<>''''::text))'
    ),
    'workspaceNameCheck', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspaces' and contype = 'c'
        and definition = 'check((btrim(name)<>''''::text))'
    ),
    'workspaceMemberRoleCheck', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspace_members' and contype = 'c'
        and definition in (
          'check((role=any(array[''owner''::text,''editor''::text,''viewer''::text])))',
          'check((role=any((array[''owner''::text,''editor''::text,''viewer''::text]))))'
        )
    ),
    'updatedAtFunction', exists (
      select 1
      from pg_catalog.pg_proc
      join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
      where pg_proc.oid = to_regprocedure('public.set_current_updated_at()')
        and pg_proc.prorettype = 'trigger'::regtype
        and pg_proc.pronargs = 0
        and pg_language.lanname = 'plpgsql'
        and not pg_proc.prosecdef
        and pg_proc.provolatile = 'v'
        and array_to_string(pg_proc.proconfig, ',') in (
          'search_path=""',
          'search_path='
        )
        and regexp_replace(lower(pg_proc.prosrc), '\s+', '', 'g') =
          'beginnew.updated_at=now();returnnew;end;'
        and not exists (
          select 1
          from pg_catalog.aclexplode(coalesce(
            pg_proc.proacl,
            pg_catalog.acldefault('f', pg_proc.proowner)
          )) as function_acl
          where function_acl.grantee = 0
            and function_acl.privilege_type = 'EXECUTE'
        )
    ),
    'updatedAtTriggers', (
      select count(*) = 2
        and count(*) filter (
          where pg_class.relname = 'profiles'
            and pg_trigger.tgname = 'profiles_set_current_updated_at'
        ) = 1
        and count(*) filter (
          where pg_class.relname = 'workspaces'
            and pg_trigger.tgname = 'workspaces_set_current_updated_at'
        ) = 1
        and bool_and(
          pg_trigger.tgfoid = to_regprocedure('public.set_current_updated_at()')
          and lower(pg_get_triggerdef(pg_trigger.oid, true)) like '%before update%'
          and lower(pg_get_triggerdef(pg_trigger.oid, true)) like '%for each row%'
        )
      from pg_catalog.pg_trigger
      join pg_catalog.pg_class on pg_class.oid = pg_trigger.tgrelid
      join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where not pg_trigger.tgisinternal
        and pg_namespace.nspname = 'public'
        and pg_class.relname in ('profiles', 'workspaces')
        and pg_trigger.tgname in (
          'profiles_set_current_updated_at',
          'workspaces_set_current_updated_at'
        )
    ),
    'workspaceMemberUserIndex', exists (
      select 1 from pg_catalog.pg_indexes
      where schemaname = 'public'
        and indexname = 'workspace_members_user_id_idx'
        and regexp_replace(lower(indexdef), '\s+', '', 'g') like
          '%onpublic.workspace_membersusingbtree(user_id)'
    ),
    'rowLevelSecurity', (
      select count(*) = 3
        and bool_and(relrowsecurity and not relforcerowsecurity)
      from auth_workspace_tables
    ),
    'policies', (
      select count(*) = 5
        and bool_and(permissive = 'PERMISSIVE' and roles = '{authenticated}'::name[])
        and count(*) filter (where tablename = 'profiles'
          and policyname = 'profiles_select_own' and cmd = 'SELECT'
          and normalized_qual in (
            'selectauth.uidasuid=user_id',
            'auth.uid=user_id'
          )
          and with_check_is_null) = 1
        and count(*) filter (where tablename = 'profiles'
          and policyname = 'profiles_insert_own' and cmd = 'INSERT'
          and qual_is_null
          and normalized_with_check in (
            'selectauth.uidasuid=user_id',
            'auth.uid=user_id'
          )) = 1
        and count(*) filter (where tablename = 'profiles'
          and policyname = 'profiles_update_own' and cmd = 'UPDATE'
          and normalized_qual in (
            'selectauth.uidasuid=user_id',
            'auth.uid=user_id'
          )
          and normalized_with_check in (
            'selectauth.uidasuid=user_id',
            'auth.uid=user_id'
          )) = 1
        and count(*) filter (where tablename = 'workspace_members'
          and policyname = 'workspace_members_select_own' and cmd = 'SELECT'
          and normalized_qual in (
            'selectauth.uidasuid=user_id',
            'auth.uid=user_id'
          )
          and with_check_is_null) = 1
        and count(*) filter (where tablename = 'workspaces'
          and policyname = 'workspaces_select_for_member' and cmd = 'SELECT'
          and normalized_qual in (
            'existsselect1fromworkspace_memberswhereworkspace_members.workspace_id=workspaces.idandworkspace_members.user_id=selectauth.uidasuid',
            'existsselect1fromworkspace_memberswhereworkspace_members.workspace_id=workspaces.idandworkspace_members.user_id=auth.uid'
          )
          and with_check_is_null) = 1
      from auth_workspace_policies
    ),
    'tablePrivileges',
      (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and coalesce((select
        has_table_privilege(authenticated_role.oid, profiles_table.oid, 'SELECT')
        and has_table_privilege(authenticated_role.oid, profiles_table.oid, 'INSERT')
        and has_table_privilege(authenticated_role.oid, profiles_table.oid, 'UPDATE')
        and not has_table_privilege(authenticated_role.oid, profiles_table.oid, 'DELETE')
        and has_table_privilege(authenticated_role.oid, workspaces_table.oid, 'SELECT')
        and not has_table_privilege(authenticated_role.oid, workspaces_table.oid, 'INSERT, UPDATE, DELETE')
        and has_table_privilege(authenticated_role.oid, workspace_members_table.oid, 'SELECT')
        and not has_table_privilege(authenticated_role.oid, workspace_members_table.oid, 'INSERT, UPDATE, DELETE')
        and not has_table_privilege(anon_role.oid, profiles_table.oid, 'SELECT, INSERT, UPDATE, DELETE')
        and not has_table_privilege(anon_role.oid, workspaces_table.oid, 'SELECT, INSERT, UPDATE, DELETE')
        and not has_table_privilege(anon_role.oid, workspace_members_table.oid, 'SELECT, INSERT, UPDATE, DELETE')
        and not has_table_privilege(authenticated_role.oid, profiles_table.oid, 'SELECT WITH GRANT OPTION')
        and not has_table_privilege(authenticated_role.oid, profiles_table.oid, 'INSERT WITH GRANT OPTION')
        and not has_table_privilege(authenticated_role.oid, profiles_table.oid, 'UPDATE WITH GRANT OPTION')
        and not has_table_privilege(authenticated_role.oid, workspaces_table.oid, 'SELECT WITH GRANT OPTION')
        and not has_table_privilege(authenticated_role.oid, workspace_members_table.oid, 'SELECT WITH GRANT OPTION')
        from authenticated_role cross join anon_role cross join profiles_table
        cross join workspaces_table cross join workspace_members_table
      ), false),
    'columnPrivileges',
      (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 3 from auth_workspace_tables)
      and not exists (
        select 1
        from auth_workspace_tables
        join pg_catalog.pg_attribute on pg_attribute.attrelid = auth_workspace_tables.oid
        cross join authenticated_role
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and not (
            has_column_privilege(
              authenticated_role.oid,
              auth_workspace_tables.oid,
              pg_attribute.attnum,
              'SELECT'
            )
            and (
              auth_workspace_tables.table_name <> 'profiles'
              or (
                has_column_privilege(
                  authenticated_role.oid,
                  auth_workspace_tables.oid,
                  pg_attribute.attnum,
                  'INSERT'
                )
                and has_column_privilege(
                  authenticated_role.oid,
                  auth_workspace_tables.oid,
                  pg_attribute.attnum,
                  'UPDATE'
                )
              )
            )
            and (
              auth_workspace_tables.table_name = 'profiles'
              or (
                not has_column_privilege(
                  authenticated_role.oid,
                  auth_workspace_tables.oid,
                  pg_attribute.attnum,
                  'INSERT'
                )
                and not has_column_privilege(
                  authenticated_role.oid,
                  auth_workspace_tables.oid,
                  pg_attribute.attnum,
                  'UPDATE'
                )
              )
            )
            and not has_column_privilege(
              authenticated_role.oid,
              auth_workspace_tables.oid,
              pg_attribute.attnum,
              'REFERENCES'
            )
            and not has_column_privilege(
              authenticated_role.oid,
              auth_workspace_tables.oid,
              pg_attribute.attnum,
              'SELECT WITH GRANT OPTION'
            )
            and not has_column_privilege(
              authenticated_role.oid,
              auth_workspace_tables.oid,
              pg_attribute.attnum,
              'INSERT WITH GRANT OPTION'
            )
            and not has_column_privilege(
              authenticated_role.oid,
              auth_workspace_tables.oid,
              pg_attribute.attnum,
              'UPDATE WITH GRANT OPTION'
            )
          )
      )
      and not exists (
        select 1
        from auth_workspace_tables
        join pg_catalog.pg_attribute on pg_attribute.attrelid = auth_workspace_tables.oid
        cross join anon_role
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and has_column_privilege(
            anon_role.oid,
            auth_workspace_tables.oid,
            pg_attribute.attnum,
            'SELECT, INSERT, UPDATE, REFERENCES'
          )
      )
      and not exists (
        select 1
        from auth_workspace_tables
        join pg_catalog.pg_attribute on pg_attribute.attrelid = auth_workspace_tables.oid
        cross join lateral pg_catalog.aclexplode(
          coalesce(pg_attribute.attacl, '{}'::aclitem[])
        ) as column_acl
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and column_acl.grantee = 0
      )
  ) as value
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
      select 1 from authorized_save_function
      where lower(prosrc) like '%from public.workspace_members%'
        and lower(prosrc) like '%for share%'
        and lower(prosrc) like '%insert into public.cloud_events%'
        and lower(prosrc) like '%on conflict (workspace_id, event_id) do update%'
    ),
    'authorizedSaveSecurityDefiner', coalesce((
      select authorized_save_function.prosecdef from authorized_save_function
    ), false),
    'saveFunctionPermissionCatalogReady',
      (select count(*) = 1 from authorized_save_function)
      and (select count(*) = 1 from service_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from authenticated_role),
    'serviceRoleSaveExecute', coalesce((select has_function_privilege(
      service_role.oid,
      authorized_save_function.oid,
      'EXECUTE'
    ) from service_role cross join authorized_save_function), false),
    -- PUBLIC has no pg_roles OID. Its effective function privilege is the
    -- grantee=0 entry in the resolved ACL, including PostgreSQL's default ACL.
    'publicSaveExecute', exists (
      select 1
      from authorized_save_function
      cross join lateral pg_catalog.aclexplode(coalesce(
        authorized_save_function.proacl,
        pg_catalog.acldefault('f', authorized_save_function.proowner)
      )) as function_acl
      where function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ),
    'anonSaveExecute', coalesce((select has_function_privilege(
      anon_role.oid,
      authorized_save_function.oid,
      'EXECUTE'
    ) from anon_role cross join authorized_save_function), false),
    'authenticatedSaveExecute', coalesce((select has_function_privilege(
      authenticated_role.oid,
      authorized_save_function.oid,
      'EXECUTE'
    ) from authenticated_role cross join authorized_save_function), false),
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
    'permissionCatalogReady',
      (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from cloud_table)
      and (select count(*) = 7
        from cloud_table
        join pg_catalog.pg_attribute on pg_attribute.attrelid = cloud_table.oid
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped),
    'anonTableWrite', coalesce((select bool_or(
        has_table_privilege(anon_role.oid, cloud_table.oid, privilege_name)
      )
        from anon_role cross join cloud_table
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as privileges(privilege_name)
      ), false),
    'anonColumnWrite', coalesce((select bool_or(
        has_column_privilege(
          anon_role.oid,
          cloud_table.oid,
          pg_attribute.attnum,
          privilege_name
        )
      )
        from anon_role cross join cloud_table
        join pg_catalog.pg_attribute on pg_attribute.attrelid = cloud_table.oid
        cross join (values ('INSERT'), ('UPDATE')) as privileges(privilege_name)
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
      ), false),
    'publicTableWrite', exists (
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
      ),
    'publicColumnWrite', exists (
        select 1
        from cloud_table
        join pg_catalog.pg_attribute on pg_attribute.attrelid = cloud_table.oid
        cross join lateral pg_catalog.aclexplode(
          coalesce(pg_attribute.attacl, '{}'::aclitem[])
        ) as column_acl
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and column_acl.grantee = 0
          and column_acl.privilege_type in ('INSERT', 'UPDATE')
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
  'authWorkspaceReady', (
    select bool_and(value::boolean)
    from jsonb_each_text(auth_workspace_checks.value)
  ),
  'authWorkspaceChecks', auth_workspace_checks.value,
  'cloudEventsExists', :'cloud_events_exists'::boolean,
  'baseSchemaChecks', base_checks.value,
  'laterSchema', later_schema.value,
  'cloudData', jsonb_build_object(
    'rowCount', :'cloud_row_count'::bigint,
    'digest', :'cloud_data_digest'
  )
)::text
from auth_workspace_checks cross join base_checks cross join later_schema;
