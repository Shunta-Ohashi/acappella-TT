create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (btrim(display_name) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (workspace_id, user_id)
);

create function public.set_current_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_current_updated_at() from public;

create trigger profiles_set_current_updated_at
  before update on public.profiles
  for each row execute function public.set_current_updated_at();

create trigger workspaces_set_current_updated_at
  before update on public.workspaces
  for each row execute function public.set_current_updated_at();

create index workspace_members_user_id_idx
  on public.workspace_members(user_id);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.workspaces from anon, authenticated;
revoke all on table public.workspace_members from anon, authenticated;

grant select, insert, update on table public.profiles to authenticated;
grant select on table public.workspaces to authenticated;
grant select on table public.workspace_members to authenticated;

create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "workspace_members_select_own"
  on public.workspace_members for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "workspaces_select_for_member"
  on public.workspaces for select to authenticated
  using (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id = workspaces.id
        and workspace_members.user_id = (select auth.uid())
    )
  );
