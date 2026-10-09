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
begin
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
    when 'cloud_anon_inherited_column_write' then
      if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'cloud_event_catalog_regression_inherited'
      ) then
        raise exception 'Disposable regression role already exists';
      end if;
      create role cloud_event_catalog_regression_inherited nologin;
      grant update (event_name) on table public.cloud_events
        to cloud_event_catalog_regression_inherited;
      grant cloud_event_catalog_regression_inherited to anon;
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
      alter function public.load_cloud_events_page_authorized(uuid, text, integer)
        security invoker;
    when 'page_authenticated_execute_missing' then
      revoke execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer)
        from authenticated;
    when 'page_public_execute' then
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer) to public;
    when 'page_anon_execute' then
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer) to anon;
    when 'page_service_role_execute' then
      grant execute on function
        public.load_cloud_events_page_authorized(uuid, text, integer)
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
        public.load_cloud_events_page_authorized(uuid, text, integer)
        to cloud_event_page_regression_inherited;
      grant cloud_event_page_regression_inherited to anon;
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
    when 'save_anon_inherited_execute' then
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
      grant cloud_event_save_regression_inherited to anon;
    when 'save_service_role_execute_missing' then
      revoke execute on function
        public.save_cloud_event_validated(uuid, uuid, jsonb) from service_role;
    when 'save_service_role_missing' then
      if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'cloud_event_catalog_regression_service_role'
      ) then
        raise exception 'Disposable service role replacement already exists';
      end if;
      alter role service_role rename to cloud_event_catalog_regression_service_role;
    when 'required_role_missing' then
      if exists (
        select 1 from pg_catalog.pg_roles
        where rolname = 'cloud_event_catalog_regression_anon'
      ) then
        raise exception 'Disposable replacement role already exists';
      end if;
      alter role anon rename to cloud_event_catalog_regression_anon;
    when 'profiles_missing' then
      alter table public.profiles rename to catalog_regression_profiles;
    when 'profiles_column_missing' then
      alter table public.profiles rename column display_name
        to catalog_regression_display_name;
    when 'profiles_column_type' then
      alter table public.profiles alter column display_name type varchar(80);
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
end;
$catalog_regression$;

\ir cloud_event_migration_history_preflight.sql

rollback;
