create table public.cloud_events (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_id text not null check (btrim(event_id) <> ''),
  event_name text not null check (btrim(event_name) <> ''),
  event_snapshot jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, event_id),
  constraint cloud_events_snapshot_shape_check check (
    jsonb_typeof(event_snapshot) = 'object'
    and event_snapshot ->> 'format' is not distinct from 'acappella-tt-cloud-event'
    and event_snapshot ->> 'version' is not distinct from '1'
    and event_snapshot #>> '{appState,version}' is not distinct from '5'
    and jsonb_typeof(event_snapshot #> '{appState,events}') is not distinct from 'array'
    and jsonb_array_length(event_snapshot #> '{appState,events}') = 1
    and event_snapshot #>> '{appState,events,0,id}' is not distinct from event_id
    and event_snapshot #>> '{appState,events,0,name}' is not distinct from event_name
  )
);

create index cloud_events_workspace_updated_at_idx
  on public.cloud_events(workspace_id, updated_at desc, event_id);

create function public.initialize_cloud_event_metadata()
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

revoke all on function public.initialize_cloud_event_metadata() from public;

create trigger cloud_events_initialize_metadata
  before insert on public.cloud_events
  for each row execute function public.initialize_cloud_event_metadata();

create function public.protect_cloud_event_ownership_and_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'cloud event workspace cannot be changed'
      using errcode = '42501';
  end if;
  if new.event_id is distinct from old.event_id then
    raise exception 'cloud event id cannot be changed'
      using errcode = '42501';
  end if;
  new.created_at = old.created_at;
  new.revision = old.revision + 1;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.protect_cloud_event_ownership_and_revision() from public;

create trigger cloud_events_protect_ownership_and_revision
  before update on public.cloud_events
  for each row execute function public.protect_cloud_event_ownership_and_revision();

alter table public.cloud_events enable row level security;

revoke all on table public.cloud_events from anon, authenticated;
grant select, insert, update, delete on table public.cloud_events to authenticated;

create policy "cloud_events_select_for_member"
  on public.cloud_events for select to authenticated
  using (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id = cloud_events.workspace_id
        and workspace_members.user_id = (select auth.uid())
    )
  );

create policy "cloud_events_insert_for_editor"
  on public.cloud_events for insert to authenticated
  with check (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id = cloud_events.workspace_id
        and workspace_members.user_id = (select auth.uid())
        and workspace_members.role in ('owner', 'editor')
    )
  );

create policy "cloud_events_update_for_editor"
  on public.cloud_events for update to authenticated
  using (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id = cloud_events.workspace_id
        and workspace_members.user_id = (select auth.uid())
        and workspace_members.role in ('owner', 'editor')
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id = cloud_events.workspace_id
        and workspace_members.user_id = (select auth.uid())
        and workspace_members.role in ('owner', 'editor')
    )
  );

create policy "cloud_events_delete_for_editor"
  on public.cloud_events for delete to authenticated
  using (
    exists (
      select 1
      from public.workspace_members
      where workspace_members.workspace_id = cloud_events.workspace_id
        and workspace_members.user_id = (select auth.uid())
        and workspace_members.role in ('owner', 'editor')
    )
  );
