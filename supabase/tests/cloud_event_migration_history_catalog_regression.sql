-- Parameterized destructive catalog fixture for the Cloud Event migration
-- preflight. Run only through cloudEventMigrationCatalogRegression.mjs against
-- a disposable database with every repository migration already applied.
-- Every scenario is wrapped in a transaction and rolled back after the real
-- read-only preflight has inspected the deliberately damaged catalog.

\if :{?catalog_scenario}
\else
  \echo 'catalog_scenario is required'
  \quit 2
\endif

begin;

select set_config('acappella_tt.catalog_scenario', :'catalog_scenario', true);

do $catalog_regression$
declare
  scenario text := current_setting('acappella_tt.catalog_scenario');
  inherited_role_name name := 'cloud_event_catalog_regression_inherited';
  inherited_member_name name;
  fixture_workspace_id uuid := extensions.gen_random_uuid();
begin
  if scenario in (
    'cloud_anon_inherited_delete',
    'cloud_authenticated_inherited_delete',
    'cloud_anon_inherited_table_insert',
    'cloud_anon_inherited_table_update',
    'cloud_authenticated_inherited_table_insert',
    'cloud_authenticated_inherited_table_update',
    'cloud_anon_inherited_column_write',
    'cloud_authenticated_inherited_column_write',
    'workspace_master_authenticated_inherited_write',
    'workspace_master_authenticated_inherited_mutation_execute',
    'workspace_master_backfill_authenticated_inherited_execute',
    'workspace_master_backfill_authenticated_inherited_table_read',
    'cloud_event_v2_save_authenticated_inherited_execute',
    'cloud_v2_cutover_inspection_authenticated_inherited_execute'
  ) then
    if exists (
      select 1 from pg_catalog.pg_roles
      where rolname = inherited_role_name
    ) then
      raise exception 'Disposable regression role already exists';
    end if;

    inherited_member_name := case
      when scenario like 'cloud_anon_%' then 'anon'
      else 'authenticated'
    end;
    execute format('create role %I nologin', inherited_role_name);

    case
      when scenario like '%_inherited_delete' then
        execute format(
          'grant delete on table public.cloud_events to %I',
          inherited_role_name
        );
      when scenario like '%_inherited_table_insert' then
        execute format(
          'grant insert on table public.cloud_events to %I',
          inherited_role_name
        );
      when scenario like '%_inherited_table_update' then
        execute format(
          'grant update on table public.cloud_events to %I',
          inherited_role_name
        );
      when scenario like '%_inherited_column_write' then
        execute format(
          'grant update (event_name) on table public.cloud_events to %I',
          inherited_role_name
        );
      when scenario = 'workspace_master_authenticated_inherited_write' then
        execute format(
          'grant update on table public.workspace_master_members to %I',
          inherited_role_name
        );
      when scenario = 'workspace_master_authenticated_inherited_mutation_execute' then
        execute format(
          'grant execute on function public.mutate_workspace_master_validated(uuid,uuid,text,text,jsonb,bigint) to %I',
          inherited_role_name
        );
      when scenario = 'workspace_master_backfill_authenticated_inherited_execute' then
        execute format(
          'grant execute on function public.backfill_workspace_masters_validated(uuid,text,text,jsonb,boolean) to %I',
          inherited_role_name
        );
      when scenario = 'workspace_master_backfill_authenticated_inherited_table_read' then
        execute format(
          'grant select on table public.cloud_workspace_master_backfills to %I',
          inherited_role_name
        );
      when scenario = 'cloud_event_v2_save_authenticated_inherited_execute' then
        execute format(
          'grant execute on function public.save_cloud_event_v2_validated(uuid,uuid,jsonb,bigint,text) to %I',
          inherited_role_name
        );
      when scenario = 'cloud_v2_cutover_inspection_authenticated_inherited_execute' then
        execute format(
          'grant execute on function public.inspect_cloud_v2_cutover_state(uuid) to %I',
          inherited_role_name
        );
    end case;

    execute format(
      'grant %I to %I',
      inherited_role_name,
      inherited_member_name
    );
  else
    case scenario
    when 'baseline' then
      null;
    when 'cloud_anon_table_insert' then
      grant insert on table public.cloud_events to anon;
    when 'cloud_anon_column_insert' then
      grant insert (event_name) on table public.cloud_events to anon;
    when 'cloud_anon_column_update' then
      grant update (event_name) on table public.cloud_events to anon;
    when 'cloud_public_table_update' then
      grant update on table public.cloud_events to public;
    when 'cloud_public_column_insert' then
      grant insert (event_name) on table public.cloud_events to public;
    when 'cloud_public_column_update' then
      grant update (event_name) on table public.cloud_events to public;
    when 'cloud_anon_column_grant_option' then
      grant update (event_name) on table public.cloud_events to anon
        with grant option;
    when 'delete_function_security_invoker' then
      alter function public.delete_cloud_event_authorized(uuid, text)
        security invoker;
    when 'delete_authenticated_execute_missing' then
      revoke execute on function
        public.delete_cloud_event_authorized(uuid, text) from authenticated;
    when 'delete_public_execute' then
      grant execute on function
        public.delete_cloud_event_authorized(uuid, text) to public;
    when 'delete_anon_execute' then
      grant execute on function
        public.delete_cloud_event_authorized(uuid, text) to anon;
    when 'delete_service_role_execute' then
      grant execute on function
        public.delete_cloud_event_authorized(uuid, text) to service_role;
    when 'delete_anon_inherited_execute' then
      if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'cloud_event_delete_regression_inherited'
      ) then
        raise exception 'Disposable delete regression role already exists';
      end if;
      create role cloud_event_delete_regression_inherited nologin;
      grant execute on function
        public.delete_cloud_event_authorized(uuid, text)
        to cloud_event_delete_regression_inherited;
      grant cloud_event_delete_regression_inherited to anon;
    when 'page_function_security_invoker' then
      alter function public.load_cloud_events_page_authorized(uuid, text, integer, text)
        security invoker;
    when 'page_authenticated_execute_missing' then
      revoke execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer, text)
        from authenticated;
    when 'page_public_execute' then
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer, text) to public;
    when 'page_anon_execute' then
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer, text) to anon;
    when 'page_service_role_execute' then
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer, text)
        to service_role;
    when 'page_anon_inherited_execute' then
      if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'cloud_event_page_regression_inherited'
      ) then
        raise exception 'Disposable page regression role already exists';
      end if;
      create role cloud_event_page_regression_inherited nologin;
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer, text)
        to cloud_event_page_regression_inherited;
      grant cloud_event_page_regression_inherited to anon;
    when 'workspace_generation_trigger_missing' then
      drop trigger cloud_events_advance_workspace_generation
        on public.cloud_events;
    when 'workspace_generation_table_missing' then
      alter table public.cloud_event_workspace_generations
        rename to catalog_regression_cloud_event_workspace_generations;
    when 'workspace_generation_function_security_invoker' then
      alter function public.advance_cloud_event_workspace_generation()
        security invoker;
    when 'page_generation_guard_missing' then
      alter function public.load_cloud_events_page_authorized(
        uuid, text, integer, text
      ) rename to catalog_regression_load_cloud_events_page_authorized;
    when 'save_function_security_invoker' then
      alter function public.save_cloud_event_validated(uuid, uuid, jsonb)
        security invoker;
    when 'save_public_execute' then
      grant execute on function
        public.save_cloud_event_validated(uuid, uuid, jsonb) to public;
    when 'save_anon_execute' then
      grant execute on function
        public.save_cloud_event_validated(uuid, uuid, jsonb) to anon;
    when 'save_authenticated_execute' then
      grant execute on function
        public.save_cloud_event_validated(uuid, uuid, jsonb) to authenticated;
    when 'save_anon_inherited_execute',
      'save_authenticated_inherited_execute' then
      if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'cloud_event_save_regression_inherited'
      ) then
        raise exception 'Disposable save regression role already exists';
      end if;
      create role cloud_event_save_regression_inherited nologin;
      grant execute on function
        public.save_cloud_event_validated(uuid, uuid, jsonb)
        to cloud_event_save_regression_inherited;
      if scenario = 'save_anon_inherited_execute' then
        grant cloud_event_save_regression_inherited to anon;
      else
        grant cloud_event_save_regression_inherited to authenticated;
      end if;
    when 'save_service_role_execute_missing' then
      revoke execute on function
        public.save_cloud_event_validated(uuid, uuid, jsonb) from service_role;
    when 'workspace_master_table_missing' then
      alter table public.workspace_master_members
        rename to catalog_regression_workspace_master_members;
    when 'workspace_master_constraint_missing' then
      alter table public.workspace_master_band_members
        drop constraint workspace_master_band_members_workspace_id_band_id_position_key;
    when 'workspace_master_state_initializer_missing' then
      drop trigger workspaces_initialize_cloud_workspace_master_state
        on public.workspaces;
    when 'workspace_master_cascade_trigger_missing' then
      drop trigger workspaces_prepare_workspace_master_cascade
        on public.workspaces;
    when 'workspace_master_cascade_trigger_after' then
      drop trigger workspaces_prepare_workspace_master_cascade
        on public.workspaces;
      create trigger workspaces_prepare_workspace_master_cascade
        after delete on public.workspaces
        for each row execute function public.prepare_workspace_master_cascade();
    when 'workspace_master_cascade_cleanup_incomplete' then
      create or replace function public.prepare_workspace_master_cascade()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $function$
      begin
        perform 1
        from public.cloud_workspace_master_states
        where cloud_workspace_master_states.workspace_id = old.id
        for share;
        delete from public.cloud_event_member_references
        where cloud_event_member_references.workspace_id = old.id;
        delete from public.cloud_event_band_references
        where cloud_event_band_references.workspace_id = old.id;
        return old;
      end;
      $function$;
    when 'workspace_master_initializer_after_update' then
      drop trigger workspaces_initialize_cloud_workspace_master_state
        on public.workspaces;
      create trigger workspaces_initialize_cloud_workspace_master_state
        after update on public.workspaces
        for each row execute function
          public.initialize_cloud_workspace_master_state();
    when 'workspace_master_initializer_statement_level' then
      drop trigger workspaces_initialize_cloud_workspace_master_state
        on public.workspaces;
      create trigger workspaces_initialize_cloud_workspace_master_state
        after insert on public.workspaces
        for each statement execute function
          public.initialize_cloud_workspace_master_state();
    when 'workspace_master_member_delete_guard_missing' then
      drop trigger workspace_master_members_guard_delete_until_ready
        on public.workspace_master_members;
    when 'workspace_master_band_delete_guard_missing' then
      drop trigger workspace_master_bands_guard_delete_until_ready
        on public.workspace_master_bands;
    when 'workspace_master_member_delete_guard_after' then
      drop trigger workspace_master_members_guard_delete_until_ready
        on public.workspace_master_members;
      create trigger workspace_master_members_guard_delete_until_ready
        after delete on public.workspace_master_members
        for each row execute function
          public.guard_workspace_master_delete_until_ready();
    when 'workspace_master_delete_guard_misplaced' then
      drop trigger workspace_master_members_guard_delete_until_ready
        on public.workspace_master_members;
      -- Preserve the old aggregate count of two guard triggers while placing
      -- both on Bands. A per-table preflight must still reject this catalog.
      create trigger catalog_regression_workspace_master_bands_guard_duplicate
        before delete on public.workspace_master_bands
        for each row execute function
          public.guard_workspace_master_delete_until_ready();
    when 'workspace_master_delete_guard_unlocked' then
      create or replace function public.guard_workspace_master_delete_until_ready()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $function$
      begin
        if exists (
          select 1 from public.workspaces
          where workspaces.id = old.workspace_id
        ) and not exists (
          select 1 from public.cloud_workspace_master_states
          where cloud_workspace_master_states.workspace_id = old.workspace_id
            and cloud_workspace_master_states.status = 'ready'
        ) then
          raise exception 'Workspace master deletion requires ready migration state'
            using errcode = '55000';
        end if;
        return old;
      end;
      $function$;
    when 'workspace_master_metadata_initialize_missing' then
      drop trigger workspace_master_members_initialize_metadata
        on public.workspace_master_members;
    when 'workspace_master_member_metadata_protect_missing' then
      drop trigger workspace_master_members_protect_identity_and_revision
        on public.workspace_master_members;
    when 'workspace_master_band_metadata_protect_missing' then
      drop trigger workspace_master_bands_protect_identity_and_revision
        on public.workspace_master_bands;
    when 'workspace_master_metadata_trigger_disabled' then
      alter table public.workspace_master_bands
        disable trigger workspace_master_bands_initialize_metadata;
    when 'workspace_master_metadata_trigger_after_insert' then
      drop trigger workspace_master_bands_initialize_metadata
        on public.workspace_master_bands;
      create trigger workspace_master_bands_initialize_metadata
        after insert on public.workspace_master_bands
        for each row execute function
          public.initialize_workspace_master_record_metadata();
    when 'workspace_master_state_updated_at_missing' then
      drop trigger cloud_workspace_master_states_set_current_updated_at
        on public.cloud_workspace_master_states;
    when 'workspace_master_relation_identity_trigger_missing' then
      drop trigger workspace_master_band_members_protect_identity
        on public.workspace_master_band_members;
    when 'workspace_master_metadata_trigger_wrong_table' then
      drop trigger workspace_master_members_initialize_metadata
        on public.workspace_master_members;
      create trigger workspace_master_members_initialize_metadata
        before insert on public.workspace_master_bands
        for each row execute function
          public.initialize_workspace_master_record_metadata();
    when 'workspace_master_metadata_trigger_wrong_function' then
      drop trigger workspace_master_members_protect_identity_and_revision
        on public.workspace_master_members;
      create trigger workspace_master_members_protect_identity_and_revision
        before update on public.workspace_master_members
        for each row execute function
          public.protect_workspace_master_band_identity_and_revision();
    when 'workspace_master_nonlegacy_state' then
      insert into public.workspaces (id, name)
      values (fixture_workspace_id, 'Catalog regression master state');
      update public.cloud_workspace_master_states
      set status = 'ready'
      where workspace_id = fixture_workspace_id;
    when 'workspace_master_generation_trigger_missing' then
      drop trigger workspace_master_band_members_advance_workspace_generation
        on public.workspace_master_band_members;
    when 'workspace_master_rls_disabled' then
      alter table public.workspace_master_bands disable row level security;
    when 'workspace_master_authenticated_table_write' then
      grant update on table public.workspace_master_members to authenticated;
    when 'workspace_master_read_function_missing' then
      drop function public.load_workspace_masters_page_authorized(
        uuid, text, text, integer, text
      );
    when 'workspace_master_mutation_function_missing' then
      drop function public.mutate_workspace_master_validated(
        uuid, uuid, text, text, jsonb, bigint
      );
    when 'workspace_master_authenticated_mutation_execute' then
      grant execute on function public.mutate_workspace_master_validated(
        uuid, uuid, text, text, jsonb, bigint
      ) to authenticated;
    when 'workspace_master_anon_read_execute' then
      grant execute on function public.load_workspace_masters_page_authorized(
        uuid, text, text, integer, text
      ) to anon;
    when 'workspace_master_public_read_execute' then
      grant execute on function public.load_workspace_masters_page_authorized(
        uuid, text, text, integer, text
      ) to public;
    when 'workspace_master_backfill_table_missing' then
      alter table public.cloud_workspace_master_backfills
        rename to catalog_regression_workspace_master_backfills;
    when 'workspace_master_backfill_authenticated_execute' then
      grant execute on function public.backfill_workspace_masters_validated(
        uuid, text, text, jsonb, boolean
      ) to authenticated;
    when 'cloud_event_v2_save_security_invoker' then
      alter function public.save_cloud_event_v2_validated(
        uuid, uuid, jsonb, bigint, text
      ) security invoker;
    when 'cloud_event_v2_ready_guard_missing' then
      drop trigger cloud_events_guard_ready_workspace_from_v1_write
        on public.cloud_events;
    when 'cloud_event_v2_save_authenticated_execute' then
      grant execute on function public.save_cloud_event_v2_validated(
        uuid, uuid, jsonb, bigint, text
      ) to authenticated;
    when 'cloud_v2_cutover_inspection_missing' then
      drop function public.inspect_cloud_v2_cutover_state(uuid);
    when 'cloud_v2_cutover_inspection_authenticated_execute' then
      grant execute on function public.inspect_cloud_v2_cutover_state(uuid)
        to authenticated;
    when 'profiles_missing' then
      alter table public.profiles rename to catalog_regression_profiles;
    when 'profiles_column_missing' then
      alter table public.profiles rename column display_name
        to catalog_regression_display_name;
    when 'profiles_column_type' then
      -- Unbounded varchar remains intentionally different from text without
      -- rejecting any pre-existing display_name value during fixture setup.
      alter table public.profiles alter column display_name type varchar;
    when 'membership_primary_key_missing' then
      alter table public.workspace_members
        drop constraint workspace_members_pkey;
    when 'membership_role_check_missing' then
      alter table public.workspace_members
        drop constraint workspace_members_role_check;
    when 'membership_role_check_broad' then
      alter table public.workspace_members
        drop constraint workspace_members_role_check;
      alter table public.workspace_members
        add constraint workspace_members_role_check
        check (role in ('owner', 'editor', 'viewer', 'guest'));
    when 'membership_foreign_key_missing' then
      alter table public.workspace_members
        drop constraint workspace_members_workspace_id_fkey;
    when 'membership_foreign_key_wrong_target' then
      alter table public.workspace_members
        drop constraint workspace_members_workspace_id_fkey;
      create table public.catalog_regression_workspaces (
        id uuid primary key
      );
      -- Preserve referential validity for every existing membership so the
      -- scenario reaches the preflight with a valid-but-wrong FK target.
      -- DISTINCT makes both an empty database and multiple members of one
      -- Workspace safe without changing production Workspace rows.
      insert into public.catalog_regression_workspaces (id)
      select distinct workspace_id
      from public.workspace_members;
      alter table public.workspace_members
        add constraint workspace_members_workspace_id_fkey
        foreign key (workspace_id)
        references public.catalog_regression_workspaces(id)
        on delete cascade;
    when 'workspace_rls_disabled' then
      alter table public.workspaces disable row level security;
    when 'workspace_policy_missing' then
      drop policy workspaces_select_for_member on public.workspaces;
    when 'workspace_policy_broad' then
      drop policy workspaces_select_for_member on public.workspaces;
      create policy workspaces_select_for_member
        on public.workspaces for select to authenticated
        using (true);
    when 'workspace_policy_extra' then
      create policy catalog_regression_workspace_read_all
        on public.workspaces for select to authenticated
        using (true);
    when 'updated_at_function_invalid' then
      create or replace function public.set_current_updated_at()
      returns trigger
      language plpgsql
      set search_path = ''
      as $function$
      begin
        return null;
      end;
      $function$;
    when 'updated_at_trigger_missing' then
      drop trigger profiles_set_current_updated_at on public.profiles;
    when 'auth_workspace_anon_column_write' then
      grant update (display_name) on table public.profiles to anon;
    else
      raise exception 'Unknown catalog regression scenario: %', scenario;
    end case;
  end if;
end;
$catalog_regression$;

\ir cloud_event_migration_history_preflight.sql

rollback;
