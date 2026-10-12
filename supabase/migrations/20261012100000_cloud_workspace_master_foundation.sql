-- Add the inert, normalized foundation for Workspace-wide Member and Band
-- persistence. Existing Cloud Event Snapshot V1 rows remain authoritative;
-- this migration neither seeds master rows nor exposes read/write endpoints.

begin;

create table public.cloud_workspace_master_states (
  workspace_id uuid primary key
    references public.workspaces(id) on delete cascade,
  status text not null default 'legacy'
    check (status in ('legacy', 'conflict', 'ready')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_master_members (
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  member_id text not null check (btrim(member_id) <> ''),
  real_name text not null check (btrim(real_name) <> ''),
  aca_name text,
  entry_academic_year integer check (entry_academic_year > 0),
  notes text,
  active boolean not null,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, member_id)
);

create table public.workspace_master_bands (
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  band_id text not null check (btrim(band_id) <> ''),
  name text not null check (btrim(name) <> ''),
  notes text,
  active boolean not null,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, band_id)
);

create table public.workspace_master_band_members (
  workspace_id uuid not null,
  band_id text not null,
  member_id text not null,
  position integer not null check (position >= 0),
  primary key (workspace_id, band_id, member_id),
  unique (workspace_id, band_id, position),
  foreign key (workspace_id, band_id)
    references public.workspace_master_bands(workspace_id, band_id)
    on delete cascade,
  foreign key (workspace_id, member_id)
    references public.workspace_master_members(workspace_id, member_id)
    on delete restrict
);

create table public.cloud_event_member_references (
  workspace_id uuid not null,
  event_id text not null,
  member_id text not null,
  primary key (workspace_id, event_id, member_id),
  foreign key (workspace_id, event_id)
    references public.cloud_events(workspace_id, event_id)
    on delete cascade,
  foreign key (workspace_id, member_id)
    references public.workspace_master_members(workspace_id, member_id)
    on delete restrict
);

create table public.cloud_event_band_references (
  workspace_id uuid not null,
  event_id text not null,
  band_id text not null,
  primary key (workspace_id, event_id, band_id),
  foreign key (workspace_id, event_id)
    references public.cloud_events(workspace_id, event_id)
    on delete cascade,
  foreign key (workspace_id, band_id)
    references public.workspace_master_bands(workspace_id, band_id)
    on delete restrict
);

create index workspace_master_band_members_member_idx
  on public.workspace_master_band_members(workspace_id, member_id);
create index cloud_event_member_references_master_idx
  on public.cloud_event_member_references(workspace_id, member_id);
create index cloud_event_band_references_master_idx
  on public.cloud_event_band_references(workspace_id, band_id);

-- Prevent a Workspace created concurrently with the state backfill from
-- missing its legacy state row.
lock table public.workspaces in share row exclusive mode;

insert into public.cloud_workspace_master_states (workspace_id)
select workspaces.id from public.workspaces;

create function public.initialize_cloud_workspace_master_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cloud_workspace_master_states (workspace_id, status)
  values (new.id, 'legacy');
  return new;
end;
$$;

revoke all on function public.initialize_cloud_workspace_master_state()
  from public, anon, authenticated, service_role;

create trigger workspaces_initialize_cloud_workspace_master_state
  after insert on public.workspaces
  for each row execute function public.initialize_cloud_workspace_master_state();

create trigger cloud_workspace_master_states_set_current_updated_at
  before update on public.cloud_workspace_master_states
  for each row execute function public.set_current_updated_at();

create function public.initialize_workspace_master_record_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision = 1;
  new.created_at = now();
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.initialize_workspace_master_record_metadata()
  from public, anon, authenticated, service_role;

create function public.protect_workspace_master_member_identity_and_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
    or new.member_id is distinct from old.member_id then
    raise exception 'Workspace Member identity cannot be changed'
      using errcode = '42501';
  end if;
  new.created_at = old.created_at;
  new.revision = old.revision + 1;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.protect_workspace_master_member_identity_and_revision()
  from public, anon, authenticated, service_role;

create function public.protect_workspace_master_band_identity_and_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
    or new.band_id is distinct from old.band_id then
    raise exception 'Workspace Band identity cannot be changed'
      using errcode = '42501';
  end if;
  new.created_at = old.created_at;
  new.revision = old.revision + 1;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.protect_workspace_master_band_identity_and_revision()
  from public, anon, authenticated, service_role;

create trigger workspace_master_members_initialize_metadata
  before insert on public.workspace_master_members
  for each row execute function public.initialize_workspace_master_record_metadata();

create trigger workspace_master_members_protect_identity_and_revision
  before update on public.workspace_master_members
  for each row execute function public.protect_workspace_master_member_identity_and_revision();

create trigger workspace_master_bands_initialize_metadata
  before insert on public.workspace_master_bands
  for each row execute function public.initialize_workspace_master_record_metadata();

create trigger workspace_master_bands_protect_identity_and_revision
  before update on public.workspace_master_bands
  for each row execute function public.protect_workspace_master_band_identity_and_revision();

-- Existing Workspace snapshots have not been backfilled into the reference
-- tables. Deleting normalized masters is therefore fail-closed until a later
-- migration has made the Workspace ready. Parent Workspace cascades remain
-- possible because the parent row is no longer visible during FK cascading.
create function public.guard_workspace_master_delete_until_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.guard_workspace_master_delete_until_ready()
  from public, anon, authenticated, service_role;

create trigger workspace_master_members_guard_delete_until_ready
  before delete on public.workspace_master_members
  for each row execute function public.guard_workspace_master_delete_until_ready();

create trigger workspace_master_bands_guard_delete_until_ready
  before delete on public.workspace_master_bands
  for each row execute function public.guard_workspace_master_delete_until_ready();

-- Future internal master mutations participate in the same generation lock
-- used by Cloud Event page reads. A later owner/editor mutation RPC must keep
-- the existing lock order: Workspace membership FOR SHARE first, then master
-- DML; the row trigger takes the generation UPDATE lock transactionally. No
-- mutation endpoint is exposed here.
create trigger workspace_master_members_advance_workspace_generation
  after insert or update or delete on public.workspace_master_members
  for each row execute function public.advance_cloud_event_workspace_generation();

create trigger workspace_master_bands_advance_workspace_generation
  after insert or update or delete on public.workspace_master_bands
  for each row execute function public.advance_cloud_event_workspace_generation();

create trigger workspace_master_band_members_advance_workspace_generation
  after insert or update or delete on public.workspace_master_band_members
  for each row execute function public.advance_cloud_event_workspace_generation();

create trigger cloud_workspace_master_states_advance_workspace_generation
  after update on public.cloud_workspace_master_states
  for each row execute function public.advance_cloud_event_workspace_generation();

alter table public.cloud_workspace_master_states enable row level security;
alter table public.workspace_master_members enable row level security;
alter table public.workspace_master_bands enable row level security;
alter table public.workspace_master_band_members enable row level security;
alter table public.cloud_event_member_references enable row level security;
alter table public.cloud_event_band_references enable row level security;

revoke all on table public.cloud_workspace_master_states
  from public, anon, authenticated, service_role;
revoke all on table public.workspace_master_members
  from public, anon, authenticated, service_role;
revoke all on table public.workspace_master_bands
  from public, anon, authenticated, service_role;
revoke all on table public.workspace_master_band_members
  from public, anon, authenticated, service_role;
revoke all on table public.cloud_event_member_references
  from public, anon, authenticated, service_role;
revoke all on table public.cloud_event_band_references
  from public, anon, authenticated, service_role;

comment on table public.cloud_workspace_master_states is
  'Migration state for normalized Workspace masters. Existing Workspaces remain legacy until an explicit later migration.';
comment on table public.workspace_master_members is
  'Inert normalized Workspace Member foundation; no browser or backend mutation endpoint is exposed by this migration.';
comment on table public.workspace_master_bands is
  'Inert normalized Workspace Band foundation; ordered members are stored in workspace_master_band_members.';
comment on table public.workspace_master_band_members is
  'Ordered Band.defaultMemberIds relation constrained to Members in the same Workspace.';
comment on table public.cloud_event_member_references is
  'Future complete Event-to-Workspace-Member reference index; intentionally empty for legacy Snapshot V1 rows.';
comment on table public.cloud_event_band_references is
  'Future complete Event-to-Workspace-Band reference index; intentionally empty for legacy Snapshot V1 rows.';

-- Guard against inherited/default privileges. These tables are intentionally
-- unreachable until later, complete read/mutation endpoints are introduced.
do $$
declare
  table_name text;
  function_signature text;
  function_oid oid;
  role_name text;
  privilege_name text;
begin
  foreach table_name in array array[
    'cloud_workspace_master_states',
    'workspace_master_members',
    'workspace_master_bands',
    'workspace_master_band_members',
    'cloud_event_member_references',
    'cloud_event_band_references'
  ] loop
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach privilege_name in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(
          role_name,
          format('public.%I', table_name),
          privilege_name
        ) then
          raise exception '% retains % on public.%',
            role_name, privilege_name, table_name
            using errcode = '42501';
        end if;
      end loop;

      if has_any_column_privilege(
        role_name,
        format('public.%I', table_name),
        'SELECT,INSERT,UPDATE,REFERENCES'
      ) then
        raise exception '% retains column privileges on public.%',
          role_name, table_name
          using errcode = '42501';
      end if;
    end loop;

    if exists (
      select 1
      from pg_catalog.pg_class
      join pg_catalog.pg_namespace
        on pg_namespace.oid = pg_class.relnamespace
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_class.relacl,
        pg_catalog.acldefault('r', pg_class.relowner)
      )) as table_acl
      where pg_namespace.nspname = 'public'
        and pg_class.relname = table_name
        and table_acl.grantee = 0
    ) then
      raise exception 'PUBLIC retains privileges on public.%', table_name
        using errcode = '42501';
    end if;

    if exists (
      select 1
      from pg_catalog.pg_class
      join pg_catalog.pg_namespace
        on pg_namespace.oid = pg_class.relnamespace
      join pg_catalog.pg_attribute
        on pg_attribute.attrelid = pg_class.oid
      cross join lateral pg_catalog.aclexplode(pg_attribute.attacl)
        as column_acl
      where pg_namespace.nspname = 'public'
        and pg_class.relname = table_name
        and pg_attribute.attnum > 0
        and not pg_attribute.attisdropped
        and pg_attribute.attacl is not null
        and column_acl.grantee = 0
    ) then
      raise exception 'PUBLIC retains column privileges on public.%', table_name
        using errcode = '42501';
    end if;
  end loop;

  foreach function_signature in array array[
    'public.initialize_cloud_workspace_master_state()',
    'public.initialize_workspace_master_record_metadata()',
    'public.protect_workspace_master_member_identity_and_revision()',
    'public.protect_workspace_master_band_identity_and_revision()',
    'public.guard_workspace_master_delete_until_ready()'
  ] loop
    function_oid := to_regprocedure(function_signature);
    if function_oid is null then
      raise exception 'Internal Workspace master function is missing: %',
        function_signature using errcode = '55000';
    end if;

    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(role_name, function_oid, 'EXECUTE') then
        raise exception '% retains EXECUTE on %', role_name, function_signature
          using errcode = '42501';
      end if;
    end loop;

    if exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl,
        pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
      raise exception 'PUBLIC retains EXECUTE on %', function_signature
        using errcode = '42501';
    end if;
  end loop;
end;
$$;

commit;
