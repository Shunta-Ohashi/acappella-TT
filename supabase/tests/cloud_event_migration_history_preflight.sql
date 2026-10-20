-- Read-only preflight for the one-time Cloud Event base-migration rename.
-- Run through scripts/cloudEventMigrationRepair.mjs or psql with ON_ERROR_STOP.
-- This file intentionally contains no DDL, DML, transaction-control, or repair.

\set history_table_exists false
\set applied_versions '[]'
\set cloud_events_exists false
\set cloud_row_count 0
\set cloud_data_digest 'absent'
\set workspace_master_tables_exist false
\set workspace_master_foundation_state_safe false
\set workspace_master_row_count 0
\set workspace_master_data_digest 'absent'
\set live_timetable_tables_exist false
\set live_timetable_row_count 0
\set live_timetable_data_digest 'absent'

select (to_regclass('supabase_migrations.schema_migrations') is not null)::text
  as history_table_exists
\gset

\if :history_table_exists
select coalesce(jsonb_agg(version::text order by version::text), '[]'::jsonb)::text
  as applied_versions
from supabase_migrations.schema_migrations
\gset
\endif

select (
  to_regclass('public.live_timetables') is not null
  and to_regclass('public.live_timetable_stages') is not null
  and to_regclass('public.live_timetable_entries') is not null
  and to_regclass('public.live_timetable_stage_operators') is not null
)::text as live_timetable_tables_exist
\gset

\if :live_timetable_tables_exist
with live_rows as (
  select 'live'::text as kind, array[id::text] as row_key,
    to_jsonb(live_timetables)::text as payload
  from public.live_timetables
  union all
  select 'stage', array[live_timetable_id::text, id::text],
    to_jsonb(live_timetable_stages)::text
  from public.live_timetable_stages
  union all
  select 'entry', array[live_timetable_id::text, stage_id::text, id::text],
    to_jsonb(live_timetable_entries)::text
  from public.live_timetable_entries
  union all
  select 'operator', array[live_timetable_id::text, stage_id::text, user_id::text],
    to_jsonb(live_timetable_stage_operators)::text
  from public.live_timetable_stage_operators
)
select
  count(*)::text as live_timetable_row_count,
  md5(coalesce(
    string_agg(md5(kind || ':' || to_jsonb(row_key)::text || ':' || payload), ''
      order by kind, row_key),
    ''
  )) as live_timetable_data_digest
from live_rows
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

select (
  to_regclass('public.cloud_workspace_master_states') is not null
  and to_regclass('public.workspace_master_members') is not null
  and to_regclass('public.workspace_master_bands') is not null
  and to_regclass('public.workspace_master_band_members') is not null
  and to_regclass('public.cloud_event_member_references') is not null
  and to_regclass('public.cloud_event_band_references') is not null
)::text as workspace_master_tables_exist
\gset

\if :workspace_master_tables_exist
select (
  not exists (
    select 1
    from public.workspaces
    left join public.cloud_workspace_master_states
      on cloud_workspace_master_states.workspace_id = workspaces.id
    where cloud_workspace_master_states.workspace_id is null
  )
  and not exists (
    select 1 from public.cloud_workspace_master_states
    where status <> 'legacy'
  )
)::text as workspace_master_foundation_state_safe
\gset

with master_rows as (
  select 'state'::text as kind, array[workspace_id::text] as row_key,
    to_jsonb(cloud_workspace_master_states)::text as payload
  from public.cloud_workspace_master_states
  union all
  select 'member', array[workspace_id::text, member_id],
    to_jsonb(workspace_master_members)::text
  from public.workspace_master_members
  union all
  select 'band', array[workspace_id::text, band_id],
    to_jsonb(workspace_master_bands)::text
  from public.workspace_master_bands
  union all
  select 'band-member', array[workspace_id::text, band_id, member_id],
    to_jsonb(workspace_master_band_members)::text
  from public.workspace_master_band_members
  union all
  select 'event-member-reference', array[workspace_id::text, event_id, member_id],
    to_jsonb(cloud_event_member_references)::text
  from public.cloud_event_member_references
  union all
  select 'event-band-reference', array[workspace_id::text, event_id, band_id],
    to_jsonb(cloud_event_band_references)::text
  from public.cloud_event_band_references
)
select
  count(*)::text as workspace_master_row_count,
  md5(coalesce(
    string_agg(md5(kind || ':' || to_jsonb(row_key)::text || ':' || payload), ''
      order by kind, row_key),
    ''
  )) as workspace_master_data_digest
from master_rows
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
workspace_generation_table as (
  select pg_class.oid, pg_class.relacl, pg_class.relowner,
    pg_class.relrowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname = 'cloud_event_workspace_generations'
    and pg_class.relkind = 'r'
),
workspace_master_tables as (
  select pg_class.relname, pg_class.oid, pg_class.relacl,
    pg_class.relowner, pg_class.relrowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname in (
      'cloud_workspace_master_states',
      'workspace_master_members',
      'workspace_master_bands',
      'workspace_master_band_members',
      'cloud_event_member_references',
      'cloud_event_band_references'
    )
    and pg_class.relkind = 'r'
),
initialize_master_state_function as (
  select pg_proc.oid, pg_proc.prosecdef, pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.initialize_cloud_workspace_master_state()'
  )
),
guard_master_delete_function as (
  select pg_proc.oid, pg_proc.prosecdef, pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.guard_workspace_master_delete_until_ready()'
  )
),
prepare_master_cascade_function as (
  select pg_proc.oid, pg_proc.prosecdef, pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.prepare_workspace_master_cascade()'
  )
),
workspace_master_internal_functions as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner
  from pg_catalog.pg_proc
  where pg_proc.oid in (
    to_regprocedure('public.initialize_cloud_workspace_master_state()'),
    to_regprocedure('public.initialize_workspace_master_record_metadata()'),
    to_regprocedure(
      'public.protect_workspace_master_member_identity_and_revision()'
    ),
    to_regprocedure(
      'public.protect_workspace_master_band_identity_and_revision()'
    ),
    to_regprocedure(
      'public.protect_workspace_master_band_member_identity()'
    ),
    to_regprocedure('public.prepare_workspace_master_cascade()'),
    to_regprocedure('public.guard_workspace_master_delete_until_ready()')
  )
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
authorized_delete_function as (
  select
    pg_proc.oid,
    pg_proc.proacl,
    pg_proc.proowner,
    pg_proc.prosecdef,
    pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid =
    to_regprocedure('public.delete_cloud_event_authorized(uuid,text)')
),
authorized_page_function as (
  select
    pg_proc.oid,
    pg_proc.proacl,
    pg_proc.proowner,
    pg_proc.prosecdef,
    pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid in (
    to_regprocedure('public.load_cloud_events_page_authorized(uuid,text,integer)'),
    to_regprocedure('public.load_cloud_events_page_authorized(uuid,text,integer,text)')
  )
),
generation_page_function as (
  select * from authorized_page_function
  where oid = to_regprocedure(
    'public.load_cloud_events_page_authorized(uuid,text,integer,text)'
  )
),
initialize_generation_function as (
  select pg_proc.oid, pg_proc.prosecdef, pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.initialize_cloud_event_workspace_generation()'
  )
),
advance_generation_function as (
  select pg_proc.oid, pg_proc.prosecdef, pg_proc.prosrc
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.advance_cloud_event_workspace_generation()'
  )
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
cloud_event_v2_save_function as (
  select
    pg_proc.oid,
    pg_proc.proacl,
    pg_proc.proowner,
    pg_proc.prosecdef,
    pg_proc.prosrc,
    pg_proc.proconfig,
    pg_proc.provolatile,
    pg_proc.prorettype,
    pg_proc.pronargs,
    pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text)'
  )
),
cloud_event_v2_shape_function as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner, pg_proc.provolatile,
    pg_proc.prosrc, pg_proc.proconfig, pg_proc.prorettype, pg_proc.pronargs
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.is_cloud_event_v2_snapshot_shape(jsonb,text,text)'
  )
),
cloud_event_v1_ready_guard_function as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner, pg_proc.prosecdef,
    pg_proc.prosrc, pg_proc.proconfig
  from pg_catalog.pg_proc
  where pg_proc.oid = to_regprocedure(
    'public.guard_ready_workspace_from_v1_event_write()'
  )
),
workspace_master_read_function as (
  select
    pg_proc.oid,
    pg_proc.proacl,
    pg_proc.proowner,
    pg_proc.prosecdef,
    pg_proc.prosrc,
    pg_proc.proconfig,
    pg_proc.provolatile,
    pg_proc.prorettype,
    pg_proc.pronargs,
    pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.load_workspace_masters_page_authorized(uuid,text,text,integer,text)'
  )
),
workspace_master_mutation_function as (
  select
    pg_proc.oid,
    pg_proc.proacl,
    pg_proc.proowner,
    pg_proc.prosecdef,
    pg_proc.prosrc,
    pg_proc.proconfig,
    pg_proc.provolatile,
    pg_proc.prorettype,
    pg_proc.pronargs,
    pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.mutate_workspace_master_validated(uuid,uuid,text,text,jsonb,bigint)'
  )
),
workspace_master_backfill_table as (
  select pg_class.oid, pg_class.relacl, pg_class.relowner,
    pg_class.relrowsecurity
  from pg_catalog.pg_class
  join pg_catalog.pg_namespace on pg_namespace.oid = pg_class.relnamespace
  where pg_namespace.nspname = 'public'
    and pg_class.relname = 'cloud_workspace_master_backfills'
    and pg_class.relkind = 'r'
),
workspace_master_backfill_inspect_function as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner, pg_proc.prosecdef,
    pg_proc.prosrc, pg_proc.proconfig, pg_proc.provolatile,
    pg_proc.prorettype, pg_proc.pronargs, pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.inspect_workspace_master_backfill_source(uuid)'
  )
),
workspace_master_backfill_apply_function as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner, pg_proc.prosecdef,
    pg_proc.prosrc, pg_proc.proconfig, pg_proc.provolatile,
    pg_proc.prorettype, pg_proc.pronargs, pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.backfill_workspace_masters_validated(uuid,text,text,jsonb,boolean)'
  )
),
cloud_v2_cutover_inspection_function as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner, pg_proc.prosecdef,
    pg_proc.prosrc, pg_proc.proconfig, pg_proc.provolatile,
    pg_proc.prorettype, pg_proc.pronargs, pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.inspect_cloud_v2_cutover_state(uuid)'
  )
),
cloud_v2_atomic_cutover_function as (
  select pg_proc.oid, pg_proc.proacl, pg_proc.proowner, pg_proc.prosecdef,
    pg_proc.prosrc, pg_proc.proconfig, pg_proc.provolatile,
    pg_proc.prorettype, pg_proc.pronargs, pg_language.lanname
  from pg_catalog.pg_proc
  join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
  where pg_proc.oid = to_regprocedure(
    'public.cutover_cloud_v2_validated(uuid,text,text,jsonb)'
  )
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
        and definition in (
          'check((btrim(display_name)<>''''::text))',
          'check(btrim(display_name)<>''''::text)'
        )
    ),
    'workspaceNameCheck', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspaces' and contype = 'c'
        and definition in (
          'check((btrim(name)<>''''::text))',
          'check(btrim(name)<>''''::text)'
        )
    ),
    'workspaceMemberRoleCheck', exists (
      select 1 from auth_workspace_constraints
      where table_name = 'workspace_members' and contype = 'c'
        and definition in (
          'check((role=any(array[''owner''::text,''editor''::text,''viewer''::text])))',
          'check((role=any((array[''owner''::text,''editor''::text,''viewer''::text]))))',
          'check(role=any(array[''owner''::text,''editor''::text,''viewer''::text]))'
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
        cross join lateral pg_catalog.aclexplode(pg_attribute.attacl) as column_acl
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and pg_attribute.attacl is not null
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
      select 1 from authorized_delete_function
      where lower(prosrc) like '%from public.workspace_members%'
        and lower(prosrc) like '%for share%'
        and lower(prosrc) like '%delete from public.cloud_events%'
        and lower(prosrc) like '%already_absent%'
    ),
    'authorizedDeleteSecurityDefiner', coalesce((
      select authorized_delete_function.prosecdef from authorized_delete_function
    ), false),
    'deleteFunctionPermissionCatalogReady',
      (select count(*) = 1 from authorized_delete_function)
      and (select count(*) = 1 from service_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from authenticated_role),
    'authenticatedDeleteExecute', coalesce((select has_function_privilege(
      authenticated_role.oid,
      authorized_delete_function.oid,
      'EXECUTE'
    ) from authenticated_role cross join authorized_delete_function), false),
    'publicDeleteExecute', exists (
      select 1
      from authorized_delete_function
      cross join lateral pg_catalog.aclexplode(coalesce(
        authorized_delete_function.proacl,
        pg_catalog.acldefault('f', authorized_delete_function.proowner)
      )) as function_acl
      where function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ),
    'anonDeleteExecute', coalesce((select has_function_privilege(
      anon_role.oid,
      authorized_delete_function.oid,
      'EXECUTE'
    ) from anon_role cross join authorized_delete_function), false),
    'serviceRoleDeleteExecute', coalesce((select has_function_privilege(
      service_role.oid,
      authorized_delete_function.oid,
      'EXECUTE'
    ) from service_role cross join authorized_delete_function), false),
    'authorizedPageIndex', exists (
      select 1 from pg_catalog.pg_indexes
      where schemaname = 'public'
        and indexname = 'cloud_events_workspace_event_id_c_idx'
        and indexdef like '%event_id COLLATE "C"%'
    ),
    'authorizedPageFunction', exists (
      select 1 from authorized_page_function
      where lower(prosrc) like '%from public.workspace_members%'
        and lower(prosrc) like '%for share%'
        and prosrc like '%event_id collate "C"%'
        and lower(prosrc) like '%limit (p_page_size + 1)%'
    ),
    'authorizedPageSecurityDefiner', coalesce((
      select authorized_page_function.prosecdef from authorized_page_function
    ), false),
    'pageFunctionPermissionCatalogReady',
      (select count(*) = 1 from authorized_page_function)
      and (select count(*) = 1 from service_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from authenticated_role),
    'authenticatedPageExecute', coalesce((select has_function_privilege(
      authenticated_role.oid,
      authorized_page_function.oid,
      'EXECUTE'
    ) from authenticated_role cross join authorized_page_function), false),
    'publicPageExecute', exists (
      select 1
      from authorized_page_function
      cross join lateral pg_catalog.aclexplode(coalesce(
        authorized_page_function.proacl,
        pg_catalog.acldefault('f', authorized_page_function.proowner)
      )) as function_acl
      where function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ),
    'anonPageExecute', coalesce((select has_function_privilege(
      anon_role.oid,
      authorized_page_function.oid,
      'EXECUTE'
    ) from anon_role cross join authorized_page_function), false),
    'serviceRolePageExecute', coalesce((select has_function_privilege(
      service_role.oid,
      authorized_page_function.oid,
      'EXECUTE'
    ) from service_role cross join authorized_page_function), false),
    'workspaceGenerationTable',
      (select count(*) = 1 from workspace_generation_table)
      and (select count(*) = 2
        from workspace_generation_table
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_generation_table.oid
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped)
      and exists (
        select 1
        from workspace_generation_table
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_generation_table.oid
        where pg_attribute.attname = 'workspace_id'
          and pg_attribute.atttypid = 'uuid'::regtype
          and pg_attribute.attnotnull
      )
      and exists (
        select 1
        from workspace_generation_table
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_generation_table.oid
        join pg_catalog.pg_attrdef
          on pg_attrdef.adrelid = workspace_generation_table.oid
          and pg_attrdef.adnum = pg_attribute.attnum
        where pg_attribute.attname = 'generation'
          and pg_attribute.atttypid = 'bigint'::regtype
          and pg_attribute.attnotnull
          and regexp_replace(
            lower(pg_get_expr(pg_attrdef.adbin, pg_attrdef.adrelid)),
            '\s+', '', 'g'
          ) in ('0', '0::bigint')
      )
      and exists (
        select 1
        from workspace_generation_table
        join pg_catalog.pg_constraint
          on pg_constraint.conrelid = workspace_generation_table.oid
        where pg_constraint.contype = 'p'
          and pg_constraint.conkey = array[
            (select pg_attribute.attnum
              from pg_catalog.pg_attribute
              where pg_attribute.attrelid = workspace_generation_table.oid
                and pg_attribute.attname = 'workspace_id')
          ]::smallint[]
      )
      and exists (
        select 1
        from workspace_generation_table
        join pg_catalog.pg_constraint
          on pg_constraint.conrelid = workspace_generation_table.oid
        where pg_constraint.contype = 'f'
          and pg_constraint.confrelid = to_regclass('public.workspaces')
          and pg_constraint.confdeltype = 'c'
          and pg_constraint.conkey = array[
            (select pg_attribute.attnum
              from pg_catalog.pg_attribute
              where pg_attribute.attrelid = workspace_generation_table.oid
                and pg_attribute.attname = 'workspace_id')
          ]::smallint[]
      )
      and exists (
        select 1
        from workspace_generation_table
        join pg_catalog.pg_constraint
          on pg_constraint.conrelid = workspace_generation_table.oid
        where pg_constraint.contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(pg_constraint.oid, true)),
            '\s+', '', 'g'
          ) in (
            'check(generation>=0)',
            'check((generation>=0))'
          )
      )
      and (select workspace_generation_table.relrowsecurity
        from workspace_generation_table)
      and not exists (
        select 1
        from workspace_generation_table
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as browser_or_backend_role
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'))
          as privileges(privilege_name)
        where has_table_privilege(
          browser_or_backend_role.oid,
          workspace_generation_table.oid,
          privileges.privilege_name
        )
      )
      and not exists (
        select 1
        from workspace_generation_table
        cross join lateral pg_catalog.aclexplode(coalesce(
          workspace_generation_table.relacl,
          pg_catalog.acldefault('r', workspace_generation_table.relowner)
        )) as table_acl
        where table_acl.grantee = 0
          and table_acl.privilege_type in (
            'SELECT', 'INSERT', 'UPDATE', 'DELETE'
          )
      )
      and not exists (
        select 1 from pg_catalog.pg_policy
        join workspace_generation_table
          on workspace_generation_table.oid = pg_policy.polrelid
      ),
    'workspaceGenerationFunctions',
      exists (
        select 1 from initialize_generation_function
        where initialize_generation_function.prosecdef
          and lower(initialize_generation_function.prosrc)
            like '%insert into public.cloud_event_workspace_generations%'
      )
      and exists (
        select 1 from advance_generation_function
        where advance_generation_function.prosecdef
          and lower(advance_generation_function.prosrc)
            like '%update public.cloud_event_workspace_generations%'
          and lower(advance_generation_function.prosrc)
            like '%set generation = generation + 1%'
      ),
    'workspaceGenerationTriggers',
      exists (
        select 1
        from workspace_generation_table
        join pg_catalog.pg_trigger
          on pg_trigger.tgrelid = to_regclass('public.workspaces')
        join initialize_generation_function
          on initialize_generation_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgname = 'workspaces_initialize_cloud_event_generation'
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
      )
      and exists (
        select 1
        from cloud_table
        join pg_catalog.pg_trigger on pg_trigger.tgrelid = cloud_table.oid
        join advance_generation_function
          on advance_generation_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgname = 'cloud_events_advance_workspace_generation'
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
      ),
    'authorizedPageGenerationGuard', exists (
      select 1 from generation_page_function
      where lower(generation_page_function.prosrc)
          like '%from public.cloud_event_workspace_generations%'
        and lower(generation_page_function.prosrc) like '%for share%'
        and lower(generation_page_function.prosrc)
          like '%p_expected_generation::bigint <> workspace_generation%'
        and lower(generation_page_function.prosrc) like '%errcode = ''40001''%'
        and lower(generation_page_function.prosrc)
          like '%''workspace_generation'', workspace_generation::text%'
    ),
    'workspaceMasterTables',
      (select count(*) = 6 from workspace_master_tables)
      and (
        select count(*) = 4 and bool_and(case column_name
          when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          when 'status' then udt_name = 'text' and is_nullable = 'NO'
            and column_default like '%legacy%'
          when 'created_at' then udt_name = 'timestamptz'
            and is_nullable = 'NO' and column_default = 'now()'
          when 'updated_at' then udt_name = 'timestamptz'
            and is_nullable = 'NO' and column_default = 'now()'
          else false end)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'cloud_workspace_master_states'
      )
      and (
        select count(*) = 10 and bool_and(case column_name
          when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          when 'member_id' then udt_name = 'text' and is_nullable = 'NO'
          when 'real_name' then udt_name = 'text' and is_nullable = 'NO'
          when 'aca_name' then udt_name = 'text' and is_nullable = 'YES'
          when 'entry_academic_year' then udt_name = 'int4'
            and is_nullable = 'YES'
          when 'notes' then udt_name = 'text' and is_nullable = 'YES'
          when 'active' then udt_name = 'bool' and is_nullable = 'NO'
          when 'revision' then udt_name = 'int8' and is_nullable = 'NO'
            and column_default like '%1%'
          when 'created_at' then udt_name = 'timestamptz'
            and is_nullable = 'NO' and column_default = 'now()'
          when 'updated_at' then udt_name = 'timestamptz'
            and is_nullable = 'NO' and column_default = 'now()'
          else false end)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'workspace_master_members'
      )
      and (
        select count(*) = 8 and bool_and(case column_name
          when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          when 'band_id' then udt_name = 'text' and is_nullable = 'NO'
          when 'name' then udt_name = 'text' and is_nullable = 'NO'
          when 'notes' then udt_name = 'text' and is_nullable = 'YES'
          when 'active' then udt_name = 'bool' and is_nullable = 'NO'
          when 'revision' then udt_name = 'int8' and is_nullable = 'NO'
            and column_default like '%1%'
          when 'created_at' then udt_name = 'timestamptz'
            and is_nullable = 'NO' and column_default = 'now()'
          when 'updated_at' then udt_name = 'timestamptz'
            and is_nullable = 'NO' and column_default = 'now()'
          else false end)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'workspace_master_bands'
      )
      and (
        select count(*) = 4 and bool_and(case column_name
          when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          when 'band_id' then udt_name = 'text' and is_nullable = 'NO'
          when 'member_id' then udt_name = 'text' and is_nullable = 'NO'
          when 'position' then udt_name = 'int4' and is_nullable = 'NO'
          else false end)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'workspace_master_band_members'
      )
      and (
        select count(*) = 3 and bool_and(case column_name
          when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          when 'event_id' then udt_name = 'text' and is_nullable = 'NO'
          when 'member_id' then udt_name = 'text' and is_nullable = 'NO'
          else false end)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'cloud_event_member_references'
      )
      and (
        select count(*) = 3 and bool_and(case column_name
          when 'workspace_id' then udt_name = 'uuid' and is_nullable = 'NO'
          when 'event_id' then udt_name = 'text' and is_nullable = 'NO'
          when 'band_id' then udt_name = 'text' and is_nullable = 'NO'
          else false end)
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'cloud_event_band_references'
      ),
    'workspaceMasterConstraints',
      (select count(*) = 6
        from pg_catalog.pg_constraint
        where conrelid in (
            to_regclass('public.cloud_workspace_master_states'),
            to_regclass('public.workspace_master_members'),
            to_regclass('public.workspace_master_bands'),
            to_regclass('public.workspace_master_band_members'),
            to_regclass('public.cloud_event_member_references'),
            to_regclass('public.cloud_event_band_references')
          )
          and contype = 'p')
      and not exists (
        select 1
        from pg_catalog.pg_constraint
        where conrelid in (
            to_regclass('public.cloud_workspace_master_states'),
            to_regclass('public.workspace_master_members'),
            to_regclass('public.workspace_master_bands'),
            to_regclass('public.workspace_master_band_members'),
            to_regclass('public.cloud_event_member_references'),
            to_regclass('public.cloud_event_band_references')
          )
          and contype in ('p', 'u', 'f', 'c')
          and (not convalidated or condeferrable or condeferred)
      )
      and not exists (
        select 1
        from (values
          ('cloud_workspace_master_states', 'primarykey(workspace_id)'),
          ('workspace_master_members', 'primarykey(workspace_id,member_id)'),
          ('workspace_master_bands', 'primarykey(workspace_id,band_id)'),
          ('workspace_master_band_members',
            'primarykey(workspace_id,band_id,member_id)'),
          ('cloud_event_member_references',
            'primarykey(workspace_id,event_id,member_id)'),
          ('cloud_event_band_references',
            'primarykey(workspace_id,event_id,band_id)')
        ) as expected_primary_key(table_name, definition)
        where not exists (
          select 1 from pg_catalog.pg_constraint
          where conrelid = to_regclass(format(
              'public.%I', expected_primary_key.table_name
            ))
            and contype = 'p'
            and regexp_replace(
              lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
            ) = expected_primary_key.definition
        )
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_workspace_master_states')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) in (
            'check(status=any(array[''legacy''::text,''conflict''::text,''ready''::text]))',
            'check((status=any(array[''legacy''::text,''conflict''::text,''ready''::text])))'
          )
      )
      and (
        select count(*) = 3
        from pg_catalog.pg_constraint
        where conrelid in (
            to_regclass('public.cloud_workspace_master_states'),
            to_regclass('public.workspace_master_members'),
            to_regclass('public.workspace_master_bands')
          )
          and contype = 'f'
          and confrelid = to_regclass('public.workspaces')
          and confdeltype = 'c'
      )
      and not exists (
        select 1
        from (values
          ('cloud_workspace_master_states'),
          ('workspace_master_members'),
          ('workspace_master_bands')
        ) as expected_workspace_foreign_key(table_name)
        where not exists (
          select 1 from pg_catalog.pg_constraint
          where conrelid = to_regclass(format(
              'public.%I', expected_workspace_foreign_key.table_name
            ))
            and contype = 'f'
            and confrelid = to_regclass('public.workspaces')
            and confdeltype = 'c'
            and regexp_replace(
              lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
            ) like 'foreignkey(workspace_id)references%workspaces(id)%'
        )
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_members')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%btrim(member_id)<>%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_members')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%btrim(real_name)<>%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_members')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%entry_academic_year>0%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_members')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%revision>0%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_bands')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%btrim(band_id)<>%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_bands')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%btrim(name)<>%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_bands')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like '%revision>0%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_band_members')
          and contype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) in (
            'check(position>=0)',
            'check((position>=0))',
            'check("position">=0)',
            'check(("position">=0))'
          )
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_band_members')
          and contype = 'u'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) in (
            'unique(workspace_id,band_id,position)',
            'unique(workspace_id,band_id,"position")'
          )
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_band_members')
          and contype = 'f'
          and confrelid = to_regclass('public.workspace_master_bands')
          and confdeltype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like 'foreignkey(workspace_id,band_id)references%workspace_master_bands(workspace_id,band_id)%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.workspace_master_band_members')
          and contype = 'f'
          and confrelid = to_regclass('public.workspace_master_members')
          and confdeltype = 'r'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like 'foreignkey(workspace_id,member_id)references%workspace_master_members(workspace_id,member_id)%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_event_member_references')
          and contype = 'f'
          and confrelid = to_regclass('public.cloud_events')
          and confdeltype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like 'foreignkey(workspace_id,event_id)references%cloud_events(workspace_id,event_id)%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_event_member_references')
          and contype = 'f'
          and confrelid = to_regclass('public.workspace_master_members')
          and confdeltype = 'r'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like 'foreignkey(workspace_id,member_id)references%workspace_master_members(workspace_id,member_id)%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_event_band_references')
          and contype = 'f'
          and confrelid = to_regclass('public.cloud_events')
          and confdeltype = 'c'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like 'foreignkey(workspace_id,event_id)references%cloud_events(workspace_id,event_id)%'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_event_band_references')
          and contype = 'f'
          and confrelid = to_regclass('public.workspace_master_bands')
          and confdeltype = 'r'
          and regexp_replace(
            lower(pg_get_constraintdef(oid, true)), '\s+', '', 'g'
          ) like 'foreignkey(workspace_id,band_id)references%workspace_master_bands(workspace_id,band_id)%'
      ),
    'workspaceMasterStateInitializer',
      :'workspace_master_foundation_state_safe'::boolean
      and exists (
        select 1 from initialize_master_state_function
        where initialize_master_state_function.prosecdef
          and lower(initialize_master_state_function.prosrc)
            like '%insert into public.cloud_workspace_master_states%'
          and lower(initialize_master_state_function.prosrc)
            like '%values (new.id, ''legacy'')%'
      )
      -- pg_trigger.tgtype is a bit mask: ROW=1, BEFORE=2, INSERT=4,
      -- DELETE=8, UPDATE=16. AFTER INSERT FOR EACH ROW is therefore 5.
      and (
        select count(*) = 1 from pg_catalog.pg_trigger
        join initialize_master_state_function
          on initialize_master_state_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgrelid = to_regclass('public.workspaces')
          and pg_trigger.tgname =
            'workspaces_initialize_cloud_workspace_master_state'
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
          and pg_trigger.tgtype = 5
      )
      and exists (
        select 1 from prepare_master_cascade_function
        where prepare_master_cascade_function.prosecdef
          and lower(prepare_master_cascade_function.prosrc)
            like '%cloud_workspace_master_states%for share%'
          and lower(prepare_master_cascade_function.prosrc)
            like '%delete from public.cloud_event_member_references%'
          and lower(prepare_master_cascade_function.prosrc)
            like '%delete from public.cloud_event_band_references%'
          and lower(prepare_master_cascade_function.prosrc)
            like '%delete from public.workspace_master_band_members%'
      )
      and (
        select count(*) = 1 from pg_catalog.pg_trigger
        join prepare_master_cascade_function
          on prepare_master_cascade_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgrelid = to_regclass('public.workspaces')
          and pg_trigger.tgname = 'workspaces_prepare_workspace_master_cascade'
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
          and pg_trigger.tgtype = 11
      )
      and exists (
        select 1 from guard_master_delete_function
        where guard_master_delete_function.prosecdef
          and lower(guard_master_delete_function.prosrc)
            like '%for share%'
          and lower(guard_master_delete_function.prosrc)
            like '%master_status is distinct from ''ready''%'
          and lower(guard_master_delete_function.prosrc)
            like '%errcode = ''55000''%'
      )
      and (
        select count(*) = 2
        from pg_catalog.pg_trigger
        join guard_master_delete_function
          on guard_master_delete_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgrelid in (
            to_regclass('public.workspace_master_members'),
            to_regclass('public.workspace_master_bands')
          )
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
      )
      -- BEFORE DELETE FOR EACH ROW is ROW + BEFORE + DELETE = 11. Check
      -- each table independently so a duplicate on one cannot hide a missing
      -- guard on the other.
      and (
        select count(*) = 1 from pg_catalog.pg_trigger
        join guard_master_delete_function
          on guard_master_delete_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgrelid =
            to_regclass('public.workspace_master_members')
          and pg_trigger.tgname =
            'workspace_master_members_guard_delete_until_ready'
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
          and pg_trigger.tgtype = 11
      )
      and (
        select count(*) = 1 from pg_catalog.pg_trigger
        join guard_master_delete_function
          on guard_master_delete_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgrelid =
            to_regclass('public.workspace_master_bands')
          and pg_trigger.tgname =
            'workspace_master_bands_guard_delete_until_ready'
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
          and pg_trigger.tgtype = 11
      ),
    'workspaceMasterMetadataTriggers',
      -- Every metadata/identity function is a non-SECURITY-DEFINER trigger
      -- function with an empty search_path. Body checks below retain the
      -- fail-closed metadata and identity contracts.
      (
        select count(*) = 5 and bool_and(
          pg_proc.prorettype = 'trigger'::regtype
          and pg_proc.pronargs = 0
          and pg_language.lanname = 'plpgsql'
          and not pg_proc.prosecdef
          and pg_proc.provolatile = 'v'
          and array_to_string(pg_proc.proconfig, ',') in (
            'search_path=""',
            'search_path='
          )
        )
        from pg_catalog.pg_proc
        join pg_catalog.pg_language on pg_language.oid = pg_proc.prolang
        where pg_proc.oid in (
          to_regprocedure(
            'public.initialize_workspace_master_record_metadata()'
          ),
          to_regprocedure(
            'public.protect_workspace_master_member_identity_and_revision()'
          ),
          to_regprocedure(
            'public.protect_workspace_master_band_identity_and_revision()'
          ),
          to_regprocedure(
            'public.protect_workspace_master_band_member_identity()'
          ),
          to_regprocedure('public.set_current_updated_at()')
        )
      )
      and exists (
        select 1 from pg_catalog.pg_proc
        where pg_proc.oid = to_regprocedure(
            'public.initialize_workspace_master_record_metadata()'
          )
          and lower(pg_proc.prosrc) like '%new.revision = 1%'
          and lower(pg_proc.prosrc) like '%new.created_at = now()%'
          and lower(pg_proc.prosrc) like '%new.updated_at = now()%'
      )
      and exists (
        select 1 from pg_catalog.pg_proc
        where pg_proc.oid = to_regprocedure(
            'public.protect_workspace_master_member_identity_and_revision()'
          )
          and lower(pg_proc.prosrc)
            like '%new.workspace_id is distinct from old.workspace_id%'
          and lower(pg_proc.prosrc)
            like '%new.member_id is distinct from old.member_id%'
          and lower(pg_proc.prosrc) like '%new.created_at = old.created_at%'
          and lower(pg_proc.prosrc) like '%new.revision = old.revision + 1%'
          and lower(pg_proc.prosrc) like '%new.updated_at = now()%'
          and lower(pg_proc.prosrc) like '%errcode = ''42501''%'
      )
      and exists (
        select 1 from pg_catalog.pg_proc
        where pg_proc.oid = to_regprocedure(
            'public.protect_workspace_master_band_identity_and_revision()'
          )
          and lower(pg_proc.prosrc)
            like '%new.workspace_id is distinct from old.workspace_id%'
          and lower(pg_proc.prosrc)
            like '%new.band_id is distinct from old.band_id%'
          and lower(pg_proc.prosrc) like '%new.created_at = old.created_at%'
          and lower(pg_proc.prosrc) like '%new.revision = old.revision + 1%'
          and lower(pg_proc.prosrc) like '%new.updated_at = now()%'
          and lower(pg_proc.prosrc) like '%errcode = ''42501''%'
      )
      and exists (
        select 1 from pg_catalog.pg_proc
        where pg_proc.oid = to_regprocedure(
            'public.protect_workspace_master_band_member_identity()'
          )
          and lower(pg_proc.prosrc)
            like '%new.workspace_id is distinct from old.workspace_id%'
          and lower(pg_proc.prosrc)
            like '%new.band_id is distinct from old.band_id%'
          and lower(pg_proc.prosrc)
            like '%new.member_id is distinct from old.member_id%'
          and lower(pg_proc.prosrc) like '%errcode = ''42501''%'
      )
      and exists (
        select 1 from pg_catalog.pg_proc
        where pg_proc.oid = to_regprocedure('public.set_current_updated_at()')
          and regexp_replace(lower(pg_proc.prosrc), '\s+', '', 'g') =
            'beginnew.updated_at=now();returnnew;end;'
      )
      -- ROW=1, BEFORE=2, INSERT=4, UPDATE=16. Validate every required
      -- table/name/function/type tuple independently; aggregate counts cannot
      -- hide a missing or misplaced trigger.
      and not exists (
        select 1
        from (values
          (
            'workspace_master_members',
            'workspace_master_members_initialize_metadata',
            'public.initialize_workspace_master_record_metadata()',
            7
          ),
          (
            'workspace_master_members',
            'workspace_master_members_protect_identity_and_revision',
            'public.protect_workspace_master_member_identity_and_revision()',
            19
          ),
          (
            'workspace_master_bands',
            'workspace_master_bands_initialize_metadata',
            'public.initialize_workspace_master_record_metadata()',
            7
          ),
          (
            'workspace_master_bands',
            'workspace_master_bands_protect_identity_and_revision',
            'public.protect_workspace_master_band_identity_and_revision()',
            19
          ),
          (
            'cloud_workspace_master_states',
            'cloud_workspace_master_states_set_current_updated_at',
            'public.set_current_updated_at()',
            19
          ),
          (
            'workspace_master_band_members',
            'workspace_master_band_members_protect_identity',
            'public.protect_workspace_master_band_member_identity()',
            19
          )
        ) as expected_metadata_trigger(
          table_name, trigger_name, function_signature, trigger_type
        )
        where (
          select count(*)
          from pg_catalog.pg_trigger
          where pg_trigger.tgrelid = to_regclass(format(
              'public.%I', expected_metadata_trigger.table_name
            ))
            and pg_trigger.tgname = expected_metadata_trigger.trigger_name
            and pg_trigger.tgfoid = to_regprocedure(
              expected_metadata_trigger.function_signature
            )
            and not pg_trigger.tgisinternal
            and pg_trigger.tgenabled = 'O'
            and pg_trigger.tgtype = expected_metadata_trigger.trigger_type
        ) <> 1
      ),
    'workspaceMasterGenerationTriggers',
      -- AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW is 29; AFTER UPDATE
      -- FOR EACH ROW is 17. Validate each table/name pair independently.
      (select count(*) = 4
        from pg_catalog.pg_trigger
        join advance_generation_function
          on advance_generation_function.oid = pg_trigger.tgfoid
        where pg_trigger.tgrelid in (
            to_regclass('public.workspace_master_members'),
            to_regclass('public.workspace_master_bands'),
            to_regclass('public.workspace_master_band_members'),
            to_regclass('public.cloud_workspace_master_states')
          )
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O')
      and not exists (
        select 1
        from (values
          (
            'workspace_master_members',
            'workspace_master_members_advance_workspace_generation',
            29
          ),
          (
            'workspace_master_bands',
            'workspace_master_bands_advance_workspace_generation',
            29
          ),
          (
            'workspace_master_band_members',
            'workspace_master_band_members_advance_workspace_generation',
            29
          ),
          (
            'cloud_workspace_master_states',
            'cloud_workspace_master_states_advance_workspace_generation',
            17
          )
        ) as expected_generation_trigger(table_name, trigger_name, trigger_type)
        where (
          select count(*)
          from pg_catalog.pg_trigger
          join advance_generation_function
            on advance_generation_function.oid = pg_trigger.tgfoid
          where pg_trigger.tgrelid = to_regclass(format(
              'public.%I', expected_generation_trigger.table_name
            ))
            and pg_trigger.tgname = expected_generation_trigger.trigger_name
            and not pg_trigger.tgisinternal
            and pg_trigger.tgenabled = 'O'
            and pg_trigger.tgtype = expected_generation_trigger.trigger_type
        ) <> 1
      ),
    'workspaceMasterRowLevelSecurity',
      (select count(*) = 6 and bool_and(relrowsecurity)
        from workspace_master_tables)
      and not exists (
        select 1 from pg_catalog.pg_policy
        join workspace_master_tables
          on workspace_master_tables.oid = pg_policy.polrelid
      ),
    'workspaceMasterPrivileges',
      (select count(*) = 6 from workspace_master_tables)
      and (select count(*) = 7 from workspace_master_internal_functions)
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and not exists (
        select 1
        from workspace_master_tables
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        cross join (values
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
          ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
        ) as privileges(privilege_name)
        where has_table_privilege(
          direct_role.oid,
          workspace_master_tables.oid,
          privileges.privilege_name
        )
      )
      and not exists (
        select 1
        from workspace_master_tables
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_master_tables.oid
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        cross join (values
          ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
        ) as privileges(privilege_name)
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and has_column_privilege(
            direct_role.oid,
            workspace_master_tables.oid,
            pg_attribute.attnum,
            privileges.privilege_name
          )
      )
      and not exists (
        select 1
        from workspace_master_tables
        cross join lateral pg_catalog.aclexplode(coalesce(
          workspace_master_tables.relacl,
          pg_catalog.acldefault('r', workspace_master_tables.relowner)
        )) as table_acl
        where table_acl.grantee = 0
      )
      and not exists (
        select 1
        from workspace_master_tables
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_master_tables.oid
        cross join lateral pg_catalog.aclexplode(pg_attribute.attacl)
          as column_acl
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and pg_attribute.attacl is not null
          and column_acl.grantee = 0
      )
      and not exists (
        select 1
        from workspace_master_internal_functions
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        where has_function_privilege(
          direct_role.oid,
          workspace_master_internal_functions.oid,
          'EXECUTE'
        )
      )
      and not exists (
        select 1
        from workspace_master_internal_functions
        cross join lateral pg_catalog.aclexplode(coalesce(
          workspace_master_internal_functions.proacl,
          pg_catalog.acldefault(
            'f', workspace_master_internal_functions.proowner
          )
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      ),
    'workspaceMasterContractFunctions',
      (select count(*) = 1
        and bool_and(
          workspace_master_read_function.prosecdef
          and workspace_master_read_function.provolatile = 'v'
          and workspace_master_read_function.prorettype = 'jsonb'::regtype
          and workspace_master_read_function.pronargs = 5
          and workspace_master_read_function.lanname = 'plpgsql'
          and array_to_string(workspace_master_read_function.proconfig, ',')
            in ('search_path=""', 'search_path=')
          and lower(workspace_master_read_function.prosrc)
            like '%from public.workspace_members%'
          and lower(workspace_master_read_function.prosrc) like '%for share%'
          and lower(workspace_master_read_function.prosrc)
            like '%cloud_workspace_master_states%'
          and lower(workspace_master_read_function.prosrc)
            like '%cloud_event_workspace_generations%'
          and lower(workspace_master_read_function.prosrc)
            like '%p_expected_generation%'
          and lower(workspace_master_read_function.prosrc)
            like '%workspace_master_members%'
          and lower(workspace_master_read_function.prosrc)
            like '%workspace_master_bands%'
          and lower(workspace_master_read_function.prosrc)
            like '%workspace_master_band_members%'
        )
        from workspace_master_read_function)
      and (select count(*) = 1
        and bool_and(
          workspace_master_mutation_function.prosecdef
          and workspace_master_mutation_function.provolatile = 'v'
          and workspace_master_mutation_function.prorettype = 'jsonb'::regtype
          and workspace_master_mutation_function.pronargs = 6
          and workspace_master_mutation_function.lanname = 'plpgsql'
          and array_to_string(workspace_master_mutation_function.proconfig, ',')
            in ('search_path=""', 'search_path=')
          and lower(workspace_master_mutation_function.prosrc)
            like '%from public.workspace_members%'
          and lower(workspace_master_mutation_function.prosrc) like '%for share%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%master_status is distinct from ''ready''%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%p_expected_revision%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%for update%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%insert into public.workspace_master_members%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%update public.workspace_master_members%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%delete from public.workspace_master_members%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%insert into public.workspace_master_band_members%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%errcode = ''pma01''%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%p_operation is null%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%p_master_kind is null%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%p_payload is null%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%jsonb_typeof(p_payload -> ''realname'') is distinct from ''string''%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%jsonb_typeof(p_payload -> ''active'') is distinct from ''boolean''%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%jsonb_typeof(p_payload -> ''name'') is distinct from ''string''%'
          and lower(workspace_master_mutation_function.prosrc)
            like '%jsonb_typeof(p_payload -> ''defaultmemberids'') is distinct from ''array''%'
          and lower(workspace_master_mutation_function.prosrc) like
            '%jsonb_typeof(p_payload -> ''realname'') is distinct from ''string''%jsonb_typeof(p_payload -> ''active'') is distinct from ''boolean''%jsonb_typeof(p_payload -> ''name'') is distinct from ''string''%jsonb_typeof(p_payload -> ''active'') is distinct from ''boolean''%jsonb_typeof(p_payload -> ''defaultmemberids'') is distinct from ''array''%'
        )
        from workspace_master_mutation_function),
    'workspaceMasterContractPrivileges',
      (select count(*) = 1 from workspace_master_read_function)
      and (select count(*) = 1 from workspace_master_mutation_function)
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        workspace_master_read_function.oid,
        'EXECUTE'
      ) from authenticated_role cross join workspace_master_read_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        workspace_master_read_function.oid,
        'EXECUTE'
      ) from anon_role cross join workspace_master_read_function), false)
      and not coalesce((select has_function_privilege(
        service_role.oid,
        workspace_master_read_function.oid,
        'EXECUTE'
      ) from service_role cross join workspace_master_read_function), false)
      and coalesce((select has_function_privilege(
        service_role.oid,
        workspace_master_mutation_function.oid,
        'EXECUTE'
      ) from service_role cross join workspace_master_mutation_function), false)
      and not coalesce((select has_function_privilege(
        authenticated_role.oid,
        workspace_master_mutation_function.oid,
        'EXECUTE'
      ) from authenticated_role cross join workspace_master_mutation_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        workspace_master_mutation_function.oid,
        'EXECUTE'
      ) from anon_role cross join workspace_master_mutation_function), false)
      and not exists (
        select 1 from (
          select oid, proacl, proowner from workspace_master_read_function
          union all
          select oid, proacl, proowner from workspace_master_mutation_function
        ) as contract_function
        cross join lateral pg_catalog.aclexplode(coalesce(
          contract_function.proacl,
          pg_catalog.acldefault('f', contract_function.proowner)
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      ),
    'workspaceMasterBackfillContract',
      (select count(*) = 1 and bool_and(relrowsecurity)
        from workspace_master_backfill_table)
      and not exists (
        select 1 from pg_catalog.pg_policy
        join workspace_master_backfill_table
          on workspace_master_backfill_table.oid = pg_policy.polrelid
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_workspace_master_backfills')
          and contype = 'p'
      )
      and exists (
        select 1 from pg_catalog.pg_constraint
        where conrelid = to_regclass('public.cloud_workspace_master_backfills')
          and contype = 'f'
          and confrelid = to_regclass('public.workspaces')
          and confdeltype = 'c'
      )
      and (select count(*) = 1 and bool_and(
          prosecdef
          and provolatile = 'v'
          and prorettype = 'jsonb'::regtype
          and pronargs = 1
          and lanname = 'plpgsql'
          and array_to_string(proconfig, ',') in ('search_path=""', 'search_path=')
          and lower(prosrc) like '%cloud_workspace_master_states%for share%'
          and lower(prosrc) like '%cloud_event_workspace_generations%for share%'
          and lower(prosrc) like '%from public.cloud_events%'
          and lower(prosrc) like '%extensions.digest%event_snapshot%'
        ) from workspace_master_backfill_inspect_function)
      and (select count(*) = 1 and bool_and(
          prosecdef
          and provolatile = 'v'
          and prorettype = 'jsonb'::regtype
          and pronargs = 5
          and lanname = 'plpgsql'
          and array_to_string(proconfig, ',') in ('search_path=""', 'search_path=')
          and lower(prosrc) like '%master_status is distinct from ''legacy''%'
          and lower(prosrc) like '%order by cloud_events.event_id collate "c"%for share%'
          and lower(prosrc) like '%cloud_event_workspace_generations%for update%'
          and lower(prosrc) like '%cloud_events.event_snapshot%'
          and lower(prosrc) like '%insert into public.workspace_master_members%'
          and lower(prosrc) like '%insert into public.workspace_master_bands%'
          and lower(prosrc) like '%insert into public.cloud_event_member_references%'
          and lower(prosrc) like '%insert into public.cloud_event_band_references%'
          and lower(prosrc) like '%insert into public.cloud_workspace_master_backfills%'
          and lower(prosrc) like '%snapshotfingerprint%'
          and lower(prosrc) like '%if not p_apply%'
          and lower(prosrc) not like '%update public.cloud_events%'
          and lower(prosrc) not like '%update public.cloud_workspace_master_states%'
        ) from workspace_master_backfill_apply_function)
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and not exists (
        select 1
        from workspace_master_backfill_table
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        cross join (values
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
          ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
        ) as privileges(privilege_name)
        where has_table_privilege(
          direct_role.oid,
          workspace_master_backfill_table.oid,
          privileges.privilege_name
        )
      )
      and not exists (
        select 1
        from workspace_master_backfill_table
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_master_backfill_table.oid
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        cross join (values
          ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
        ) as privileges(privilege_name)
        where pg_attribute.attnum > 0
          and not pg_attribute.attisdropped
          and has_column_privilege(
            direct_role.oid,
            workspace_master_backfill_table.oid,
            pg_attribute.attnum,
            privileges.privilege_name
          )
      )
      and not exists (
        select 1
        from workspace_master_backfill_table
        cross join lateral pg_catalog.aclexplode(coalesce(
          workspace_master_backfill_table.relacl,
          pg_catalog.acldefault(
            'r', workspace_master_backfill_table.relowner
          )
        )) as table_acl
        where table_acl.grantee = 0
      )
      and not exists (
        select 1
        from workspace_master_backfill_table
        join pg_catalog.pg_attribute
          on pg_attribute.attrelid = workspace_master_backfill_table.oid
        cross join lateral pg_catalog.aclexplode(pg_attribute.attacl)
          as column_acl
        where pg_attribute.attnum > 0
          and not pg_attribute.attisdropped
          and pg_attribute.attacl is not null
          and column_acl.grantee = 0
      )
      and not exists (
        select 1
        from (
          select * from workspace_master_backfill_inspect_function
          union all
          select * from workspace_master_backfill_apply_function
        ) as backfill_function
        cross join lateral pg_catalog.aclexplode(coalesce(
          backfill_function.proacl,
          pg_catalog.acldefault('f', backfill_function.proowner)
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      )
      and not coalesce((select has_function_privilege(
        authenticated_role.oid,
        workspace_master_backfill_inspect_function.oid,
        'EXECUTE'
      ) from authenticated_role
        cross join workspace_master_backfill_inspect_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        workspace_master_backfill_inspect_function.oid,
        'EXECUTE'
      ) from anon_role
        cross join workspace_master_backfill_inspect_function), false)
      and coalesce((select has_function_privilege(
        service_role.oid,
        workspace_master_backfill_inspect_function.oid,
        'EXECUTE'
      ) from service_role
        cross join workspace_master_backfill_inspect_function), false)
      and not coalesce((select has_function_privilege(
        authenticated_role.oid,
        workspace_master_backfill_apply_function.oid,
        'EXECUTE'
      ) from authenticated_role
        cross join workspace_master_backfill_apply_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        workspace_master_backfill_apply_function.oid,
        'EXECUTE'
      ) from anon_role
        cross join workspace_master_backfill_apply_function), false)
      and coalesce((select has_function_privilege(
        service_role.oid,
        workspace_master_backfill_apply_function.oid,
        'EXECUTE'
      ) from service_role
        cross join workspace_master_backfill_apply_function), false),
    'cloudV2CutoverInspectionContract',
      (select count(*) = 1 and bool_and(
          prosecdef
          and provolatile = 'v'
          and prorettype = 'jsonb'::regtype
          and pronargs = 1
          and lanname = 'plpgsql'
          and array_to_string(proconfig, ',') in ('search_path=""', 'search_path=')
          and lower(prosrc) like '%cloud_workspace_master_states%for share%'
          and lower(prosrc) like '%cloud_event_workspace_generations%for share%'
          and lower(prosrc) like '%from public.cloud_events%'
          and lower(prosrc) like '%from public.workspace_master_members%'
          and lower(prosrc) like '%from public.workspace_master_bands%'
          and lower(prosrc) like '%from public.workspace_master_band_members%'
          and lower(prosrc) like '%from public.cloud_event_member_references%'
          and lower(prosrc) like '%from public.cloud_event_band_references%'
          and lower(prosrc) like '%from public.cloud_workspace_master_backfills%'
          and lower(prosrc) not like '%insert into%'
          and lower(prosrc) not like '%update public.%'
          and lower(prosrc) not like '%delete from%'
          and lower(prosrc) not like '%truncate%'
        ) from cloud_v2_cutover_inspection_function)
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and coalesce((select has_function_privilege(
        service_role.oid,
        cloud_v2_cutover_inspection_function.oid,
        'EXECUTE'
      ) from service_role cross join cloud_v2_cutover_inspection_function), false)
      and not coalesce((select has_function_privilege(
        authenticated_role.oid,
        cloud_v2_cutover_inspection_function.oid,
        'EXECUTE'
      ) from authenticated_role cross join cloud_v2_cutover_inspection_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        cloud_v2_cutover_inspection_function.oid,
        'EXECUTE'
      ) from anon_role cross join cloud_v2_cutover_inspection_function), false)
      and not exists (
        select 1
        from cloud_v2_cutover_inspection_function
        cross join lateral pg_catalog.aclexplode(coalesce(
          cloud_v2_cutover_inspection_function.proacl,
          pg_catalog.acldefault(
            'f', cloud_v2_cutover_inspection_function.proowner
          )
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      ),
    'cloudV2AtomicCutoverContract',
      (select count(*) = 1 and bool_and(
          prosecdef
          and provolatile = 'v'
          and prorettype = 'jsonb'::regtype
          and pronargs = 4
          and lanname = 'plpgsql'
          and array_to_string(proconfig, ',') in ('search_path=""', 'search_path=')
          and lower(prosrc) like '%from public.workspaces%for update%'
          and lower(prosrc) like '%cloud_workspace_master_states%for share%'
          and lower(prosrc) like '%from public.cloud_events%for update%'
          and lower(prosrc) like '%cloud_event_workspace_generations%for update%'
          and lower(prosrc) like '%from public.cloud_workspace_master_backfills%'
          and lower(prosrc) like '%from public.workspace_master_members%'
          and lower(prosrc) like '%from public.workspace_master_bands%'
          and lower(prosrc) like '%from public.workspace_master_band_members%'
          and lower(prosrc) like '%from public.cloud_event_member_references%'
          and lower(prosrc) like '%from public.cloud_event_band_references%'
          and lower(prosrc) like '%update public.cloud_events%'
          and lower(prosrc) like '%set status = ''ready''%'
          and lower(prosrc) like '%for update nowait%'
        ) from cloud_v2_atomic_cutover_function)
      and (select count(*) = 1 and bool_and(
          lower(cloud_event_v1_ready_guard_function.prosrc)
            like '%tg_op = ''insert''%from public.workspaces%for key share%'
        ) from cloud_event_v1_ready_guard_function)
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and coalesce((select has_function_privilege(
        service_role.oid,
        cloud_v2_atomic_cutover_function.oid,
        'EXECUTE'
      ) from service_role cross join cloud_v2_atomic_cutover_function), false)
      and not coalesce((select has_function_privilege(
        authenticated_role.oid,
        cloud_v2_atomic_cutover_function.oid,
        'EXECUTE'
      ) from authenticated_role cross join cloud_v2_atomic_cutover_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        cloud_v2_atomic_cutover_function.oid,
        'EXECUTE'
      ) from anon_role cross join cloud_v2_atomic_cutover_function), false)
      and not exists (
        select 1
        from cloud_v2_atomic_cutover_function
        cross join lateral pg_catalog.aclexplode(coalesce(
          cloud_v2_atomic_cutover_function.proacl,
          pg_catalog.acldefault(
            'f', cloud_v2_atomic_cutover_function.proowner
          )
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      )
    -- Keep each jsonb_build_object call within PostgreSQL's 100-argument
    -- function limit. The Live foundation pushed this catalog object past
    -- 50 key/value pairs, so compose the unchanged checks as two objects.
  ) || jsonb_build_object(
    'liveTimetableFoundationContract',
      (select count(*) = 4 and bool_and(pg_class.relrowsecurity)
        from pg_catalog.pg_class
        where pg_class.oid = any(array[
          to_regclass('public.live_timetables'),
          to_regclass('public.live_timetable_stages'),
          to_regclass('public.live_timetable_entries'),
          to_regclass('public.live_timetable_stage_operators')
        ]))
      and exists (
        select 1
        from pg_catalog.pg_constraint
        where pg_constraint.conrelid = to_regclass('public.live_timetables')
          and pg_constraint.confrelid = to_regclass('public.cloud_events')
          and pg_constraint.contype = 'f'
          and pg_constraint.confdeltype = 'r'
      )
      and (select count(*) = 1
        from pg_catalog.pg_constraint
        where pg_constraint.conrelid =
            to_regclass('public.live_timetable_stages')
          and pg_constraint.confrelid =
            to_regclass('public.live_timetables')
          and pg_constraint.contype = 'f'
          and pg_constraint.confdeltype = 'c')
      and (select count(*) = 1
        from pg_catalog.pg_constraint
        where pg_constraint.conrelid =
            to_regclass('public.live_timetable_entries')
          and pg_constraint.confrelid =
            to_regclass('public.live_timetable_stages')
          and pg_constraint.contype = 'f'
          and pg_constraint.confdeltype = 'c')
      and (select count(*) = 2
        from pg_catalog.pg_constraint
        where pg_constraint.conrelid =
            to_regclass('public.live_timetable_stage_operators')
          and pg_constraint.contype = 'f'
          and pg_constraint.confrelid in (
            to_regclass('public.live_timetable_stages'),
            to_regclass('public.workspace_members')
          )
          and pg_constraint.confdeltype = 'c')
      and exists (
        select 1
        from pg_catalog.pg_attribute
        where pg_attribute.attrelid =
            to_regclass('public.live_timetable_stages')
          and pg_attribute.attname = 'event_day_position'
          and pg_attribute.atttypid = 'integer'::regtype
          and pg_attribute.attnotnull
          and not pg_attribute.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_indexes
        where pg_indexes.schemaname = 'public'
          and pg_indexes.indexname =
            'live_timetable_entries_one_in_progress_idx'
          and lower(pg_indexes.indexdef) like
            '%unique%where (status = ''in_progress''%'
      )
      and (select count(*) = 1
        from pg_catalog.pg_policies
        where pg_policies.schemaname = 'public'
          and pg_policies.tablename = 'live_timetable_stages'
          and pg_policies.policyname =
            'live_timetable_stages_select_for_workspace_member'
          and pg_policies.cmd = 'SELECT'
          and lower(coalesce(pg_policies.qual, '')) like '%workspace_members%'
          and lower(coalesce(pg_policies.qual, '')) like '%auth.uid%')
      and exists (
        select 1
        from pg_catalog.pg_publication_tables
        where pg_publication_tables.pubname = 'supabase_realtime'
          and pg_publication_tables.schemaname = 'public'
          and pg_publication_tables.tablename = 'live_timetable_stages'
      )
      and (select count(*) = 1 and bool_and(
          cardinality(pg_publication_tables.attnames) = 7
          and pg_publication_tables.attnames::text[] <@ array[
            'id', 'workspace_id', 'live_timetable_id',
            'projection_version', 'revision', 'progress_status', 'updated_at'
          ]::text[])
        from pg_catalog.pg_publication_tables
        where pg_publication_tables.pubname = 'supabase_realtime'
          and pg_publication_tables.schemaname = 'public'
          and pg_publication_tables.tablename = 'live_timetable_stages')
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and coalesce((select has_table_privilege(
        authenticated_role.oid,
        to_regclass('public.live_timetable_stages'),
        'SELECT'
      ) from authenticated_role), false)
      and not coalesce((select has_table_privilege(
        anon_role.oid,
        to_regclass('public.live_timetable_stages'),
        'SELECT'
      ) from anon_role), false)
      and not coalesce((select has_table_privilege(
        service_role.oid,
        to_regclass('public.live_timetable_stages'),
        'SELECT'
      ) from service_role), false)
      and not exists (
        select 1
        from (values
          (to_regclass('public.live_timetables')),
          (to_regclass('public.live_timetable_stages')),
          (to_regclass('public.live_timetable_entries')),
          (to_regclass('public.live_timetable_stage_operators'))
        ) as live_table(oid)
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        cross join (values
          ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
          ('REFERENCES'), ('TRIGGER')
        ) as privilege(privilege_name)
        where live_table.oid is null
          or has_table_privilege(
            direct_role.oid, live_table.oid, privilege.privilege_name
          )
      )
      and (select count(*) = 8 and bool_and(
          pg_proc.prosecdef
          and pg_proc.provolatile = 'v'
          and pg_proc.prorettype = 'jsonb'::regtype
          and array_to_string(pg_proc.proconfig, ',') in (
            'search_path=""', 'search_path='
          )
        )
        from pg_catalog.pg_proc
        where pg_proc.oid = any(array[
          to_regprocedure('public.load_live_timetable_projection_source(uuid,uuid,text,bigint)'),
          to_regprocedure('public.create_or_replace_live_timetable_projection(uuid,uuid,text,bigint,text,jsonb,text,text)'),
          to_regprocedure('public.load_live_timetable_authorized(uuid)'),
          to_regprocedure('public.load_live_timetable_public(uuid)'),
          to_regprocedure('public.set_live_timetable_publication(uuid,text,boolean)'),
          to_regprocedure('public.set_live_timetable_stage_operator(uuid,text,uuid,boolean,text,text)'),
          to_regprocedure('public.start_live_timetable_entry(uuid,text,text,text,text)'),
          to_regprocedure('public.end_live_timetable_entry(uuid,text,text,text,text)')
        ]))
      and coalesce((select has_function_privilege(
        service_role.oid,
        to_regprocedure('public.load_live_timetable_projection_source(uuid,uuid,text,bigint)'),
        'EXECUTE'
      ) from service_role), false)
      and coalesce((select has_function_privilege(
        service_role.oid,
        to_regprocedure('public.create_or_replace_live_timetable_projection(uuid,uuid,text,bigint,text,jsonb,text,text)'),
        'EXECUTE'
      ) from service_role), false)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        to_regprocedure('public.load_live_timetable_authorized(uuid)'),
        'EXECUTE'
      ) from authenticated_role), false)
      and coalesce((select has_function_privilege(
        anon_role.oid,
        to_regprocedure('public.load_live_timetable_public(uuid)'),
        'EXECUTE'
      ) from anon_role), false)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        to_regprocedure('public.load_live_timetable_public(uuid)'),
        'EXECUTE'
      ) from authenticated_role), false)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        to_regprocedure('public.set_live_timetable_publication(uuid,text,boolean)'),
        'EXECUTE'
      ) from authenticated_role), false)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        to_regprocedure('public.set_live_timetable_stage_operator(uuid,text,uuid,boolean,text,text)'),
        'EXECUTE'
      ) from authenticated_role), false)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        to_regprocedure('public.start_live_timetable_entry(uuid,text,text,text,text)'),
        'EXECUTE'
      ) from authenticated_role), false)
      and coalesce((select has_function_privilege(
        authenticated_role.oid,
        to_regprocedure('public.end_live_timetable_entry(uuid,text,text,text,text)'),
        'EXECUTE'
      ) from authenticated_role), false)
      and not coalesce((select has_function_privilege(
        service_role.oid,
        to_regprocedure('public.load_live_timetable_public(uuid)'),
        'EXECUTE'
      ) from service_role), false)
      and not exists (
        select 1
        from (values
          (to_regprocedure('public.load_live_timetable_projection_source(uuid,uuid,text,bigint)')),
          (to_regprocedure('public.create_or_replace_live_timetable_projection(uuid,uuid,text,bigint,text,jsonb,text,text)'))
        ) as backend_function(oid)
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
        ) as browser_role
        where backend_function.oid is null
          or has_function_privilege(
            browser_role.oid, backend_function.oid, 'EXECUTE'
          )
      )
      and not exists (
        select 1
        from (values
          (to_regprocedure('public.load_live_timetable_projection_source(uuid,uuid,text,bigint)')),
          (to_regprocedure('public.create_or_replace_live_timetable_projection(uuid,uuid,text,bigint,text,jsonb,text,text)')),
          (to_regprocedure('public.load_live_timetable_authorized(uuid)')),
          (to_regprocedure('public.load_live_timetable_public(uuid)')),
          (to_regprocedure('public.set_live_timetable_publication(uuid,text,boolean)')),
          (to_regprocedure('public.set_live_timetable_stage_operator(uuid,text,uuid,boolean,text,text)')),
          (to_regprocedure('public.start_live_timetable_entry(uuid,text,text,text,text)')),
          (to_regprocedure('public.end_live_timetable_entry(uuid,text,text,text,text)'))
        ) as exposed_function(oid)
        cross join lateral pg_catalog.aclexplode(coalesce(
          (select pg_proc.proacl from pg_catalog.pg_proc
            where pg_proc.oid = exposed_function.oid),
          pg_catalog.acldefault(
            'f',
            (select pg_proc.proowner from pg_catalog.pg_proc
              where pg_proc.oid = exposed_function.oid)
          )
        )) as function_acl
        where exposed_function.oid is null
          or (
            function_acl.grantee = 0
            and function_acl.privilege_type = 'EXECUTE'
          )
      )
      and not exists (
        select 1
        from (values
          (to_regprocedure('public.is_live_timetable_event_days_shape(jsonb)')),
          (to_regprocedure('public.is_live_timetable_sections_shape(jsonb)')),
          (to_regprocedure('public.is_live_timetable_projection_shape(jsonb,text,text)')),
          (to_regprocedure('public.populate_live_timetable_projection(uuid,uuid,jsonb,bigint)')),
          (to_regprocedure('public.build_live_timetable_stages_json(uuid,uuid,text,boolean)')),
          (to_regprocedure('public.is_live_timetable_revision_text(text)')),
          (to_regprocedure('public.transition_live_timetable_entry(text,uuid,text,text,text,text)'))
        ) as internal_function(oid)
        cross join (
          select authenticated_role.oid from authenticated_role
          union all select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as direct_role
        where internal_function.oid is null
          or has_function_privilege(
            direct_role.oid, internal_function.oid, 'EXECUTE'
          )
      )
      and not exists (
        select 1
        from (values
          (to_regprocedure('public.load_live_timetable_authorized(uuid)')),
          (to_regprocedure('public.set_live_timetable_publication(uuid,text,boolean)')),
          (to_regprocedure('public.set_live_timetable_stage_operator(uuid,text,uuid,boolean,text,text)')),
          (to_regprocedure('public.start_live_timetable_entry(uuid,text,text,text,text)')),
          (to_regprocedure('public.end_live_timetable_entry(uuid,text,text,text,text)'))
        ) as authenticated_function(oid)
        cross join (
          select anon_role.oid from anon_role
          union all select service_role.oid from service_role
        ) as denied_role
        where authenticated_function.oid is null
          or has_function_privilege(
            denied_role.oid, authenticated_function.oid, 'EXECUTE'
          )
      ),
    'cloudEventV2PersistenceContract',
      (select count(*) = 1 and bool_and(
          cloud_event_v2_save_function.prosecdef
          and cloud_event_v2_save_function.provolatile = 'v'
          and cloud_event_v2_save_function.prorettype = 'jsonb'::regtype
          and cloud_event_v2_save_function.pronargs = 5
          and cloud_event_v2_save_function.lanname = 'plpgsql'
          and array_to_string(cloud_event_v2_save_function.proconfig, ',')
            in ('search_path=""', 'search_path=')
          and lower(cloud_event_v2_save_function.prosrc)
            like '%from public.workspace_members%for share%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%master_status is distinct from ''ready''%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%p_expected_revision%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%p_expected_generation%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%from public.workspace_master_members%for share%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%from public.workspace_master_bands%for share%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%cloud_event_member_references%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%cloud_event_band_references%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%errcode = ''pve01''%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%errcode = ''pve02''%'
          and lower(cloud_event_v2_save_function.prosrc)
            like '%errcode = ''pve04''%'
        ) from cloud_event_v2_save_function)
      and (select count(*) = 1 and bool_and(
          cloud_event_v2_shape_function.provolatile = 'i'
          and cloud_event_v2_shape_function.prorettype = 'boolean'::regtype
          and cloud_event_v2_shape_function.pronargs = 3
          and array_to_string(cloud_event_v2_shape_function.proconfig, ',')
            in ('search_path=""', 'search_path=')
          and lower(cloud_event_v2_shape_function.prosrc)
            like '%eventstate%masterreferences%'
          and lower(cloud_event_v2_shape_function.prosrc)
            like '%event_state ? ''members''%'
          and lower(cloud_event_v2_shape_function.prosrc)
            like '%event_state ? ''bands''%'
        ) from cloud_event_v2_shape_function)
      and exists (
        select 1 from constraint_definitions
        where conname = 'cloud_events_snapshot_shape_check'
          and definition like '%appstate,events,0%'
          and definition like '%is_cloud_event_v2_snapshot_shape%'
      )
      and (select count(*) = 1 and bool_and(
          cloud_event_v1_ready_guard_function.prosecdef
          and array_to_string(cloud_event_v1_ready_guard_function.proconfig, ',')
            in ('search_path=""', 'search_path=')
          and lower(cloud_event_v1_ready_guard_function.prosrc)
            like '%master_status is not distinct from ''ready''%'
          and lower(cloud_event_v1_ready_guard_function.prosrc)
            like '%errcode = ''55000''%'
        ) from cloud_event_v1_ready_guard_function)
      and exists (
        select 1 from pg_catalog.pg_trigger
        join cloud_table on cloud_table.oid = pg_trigger.tgrelid
        where pg_trigger.tgname =
            'cloud_events_guard_ready_workspace_from_v1_write'
          and pg_trigger.tgfoid = to_regprocedure(
            'public.guard_ready_workspace_from_v1_event_write()'
          )
          and not pg_trigger.tgisinternal
          and pg_trigger.tgenabled = 'O'
          and pg_trigger.tgtype = 23
      )
      and (select count(*) = 1 from authenticated_role)
      and (select count(*) = 1 from anon_role)
      and (select count(*) = 1 from service_role)
      and coalesce((select has_function_privilege(
        service_role.oid,
        cloud_event_v2_save_function.oid,
        'EXECUTE'
      ) from service_role cross join cloud_event_v2_save_function), false)
      and not coalesce((select has_function_privilege(
        authenticated_role.oid,
        cloud_event_v2_save_function.oid,
        'EXECUTE'
      ) from authenticated_role cross join cloud_event_v2_save_function), false)
      and not coalesce((select has_function_privilege(
        anon_role.oid,
        cloud_event_v2_save_function.oid,
        'EXECUTE'
      ) from anon_role cross join cloud_event_v2_save_function), false)
      and not exists (
        select 1
        from cloud_event_v2_save_function
        cross join lateral pg_catalog.aclexplode(coalesce(
          cloud_event_v2_save_function.proacl,
          pg_catalog.acldefault('f', cloud_event_v2_save_function.proowner)
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
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
        cross join lateral pg_catalog.aclexplode(pg_attribute.attacl) as column_acl
        where pg_attribute.attnum > 0 and not pg_attribute.attisdropped
          and pg_attribute.attacl is not null
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
  ),
  'workspaceMasterData', jsonb_build_object(
    'rowCount', :'workspace_master_row_count'::bigint,
    'digest', :'workspace_master_data_digest'
  ),
  'liveTimetableData', jsonb_build_object(
    'rowCount', :'live_timetable_row_count'::bigint,
    'digest', :'live_timetable_data_digest'
  )
)::text
from auth_workspace_checks cross join base_checks cross join later_schema;
