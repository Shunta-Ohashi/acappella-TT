-- Make a paginated Workspace load an optimistic, transactionally versioned
-- snapshot. Every committed Cloud Event mutation advances one Workspace
-- generation. A page reader locks that generation row while it reads rows, so
-- no mutation can commit between the generation check and the page snapshot.

begin;

create table public.cloud_event_workspace_generations (
  workspace_id uuid primary key
    references public.workspaces(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0)
);

-- Hold off concurrent Workspace creation until both the backfill and the
-- initializer trigger exist, so an empty/new Workspace can never lack its
-- lockable generation row.
lock table public.workspaces in share row exclusive mode;

insert into public.cloud_event_workspace_generations (workspace_id)
select workspaces.id from public.workspaces;

alter table public.cloud_event_workspace_generations enable row level security;
revoke all on table public.cloud_event_workspace_generations
  from public, anon, authenticated, service_role;

create function public.initialize_cloud_event_workspace_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cloud_event_workspace_generations (workspace_id)
  values (new.id);
  return new;
end;
$$;

revoke all on function public.initialize_cloud_event_workspace_generation()
  from public, anon, authenticated, service_role;

create trigger workspaces_initialize_cloud_event_generation
  after insert on public.workspaces
  for each row execute function public.initialize_cloud_event_workspace_generation();

create function public.advance_cloud_event_workspace_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace_id uuid;
begin
  target_workspace_id := case
    when tg_op = 'DELETE' then old.workspace_id
    else new.workspace_id
  end;

  update public.cloud_event_workspace_generations
    set generation = generation + 1
    where workspace_id = target_workspace_id;

  if not found and exists (
    select 1 from public.workspaces where id = target_workspace_id
  ) then
    raise exception 'Cloud Event Workspace generation row is missing'
      using errcode = '23503';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.advance_cloud_event_workspace_generation()
  from public, anon, authenticated, service_role;

create trigger cloud_events_advance_workspace_generation
  after insert or update or delete on public.cloud_events
  for each row execute function public.advance_cloud_event_workspace_generation();

revoke all on function public.load_cloud_events_page_authorized(uuid, text, integer)
  from public, anon, authenticated, service_role;
drop function public.load_cloud_events_page_authorized(uuid, text, integer);

create function public.load_cloud_events_page_authorized(
  p_workspace_id uuid,
  p_after_event_id text,
  p_page_size integer,
  p_expected_generation text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  membership_role text;
  workspace_generation bigint;
  fetched_rows jsonb;
  page_rows jsonb;
  has_more boolean;
  next_cursor text;
begin
  if caller_id is null then
    raise exception 'cloud event page read requires authentication'
      using errcode = '42501';
  end if;

  if p_workspace_id is null
    or p_page_size is null
    or p_page_size < 1
    or p_page_size > 100
    or (p_after_event_id is not null and btrim(p_after_event_id) = '')
    or (p_expected_generation is not null
      and p_expected_generation !~ '^(0|[1-9][0-9]*)$') then
    raise exception 'workspace id, cursor, page size, or generation is invalid'
      using errcode = '22023';
  end if;

  select workspace_members.role
    into membership_role
    from public.workspace_members
    where workspace_members.workspace_id = p_workspace_id
      and workspace_members.user_id = caller_id
    for share;

  if membership_role is null
    or membership_role not in ('owner', 'editor', 'viewer') then
    raise exception 'cloud event page read is not permitted'
      using errcode = '42501';
  end if;

  -- The shared row lock is held through the rows SELECT and function return.
  -- The mutation trigger needs an UPDATE lock on the same row before its
  -- transaction can commit, closing the generation/read MVCC gap.
  select cloud_event_workspace_generations.generation
    into workspace_generation
    from public.cloud_event_workspace_generations
    where cloud_event_workspace_generations.workspace_id = p_workspace_id
    for share;

  if workspace_generation is null then
    raise exception 'Cloud Event Workspace generation is unavailable'
      using errcode = '55000';
  end if;

  if p_expected_generation is not null
    and p_expected_generation::bigint <> workspace_generation then
    raise exception 'Cloud Event Workspace changed during pagination'
      using errcode = '40001';
  end if;

  select coalesce(
    jsonb_agg(
      to_jsonb(page_candidate)
      order by page_candidate.event_id collate "C"
    ),
    '[]'::jsonb
  )
    into fetched_rows
    from (
      select
        cloud_events.workspace_id,
        cloud_events.event_id,
        cloud_events.event_name,
        cloud_events.event_snapshot,
        cloud_events.revision,
        cloud_events.created_at,
        cloud_events.updated_at
      from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
        and (
          p_after_event_id is null
          or (cloud_events.event_id collate "C") >
            (p_after_event_id collate "C")
        )
      order by cloud_events.event_id collate "C"
      limit (p_page_size + 1)
    ) as page_candidate;

  has_more := jsonb_array_length(fetched_rows) > p_page_size;
  select coalesce(jsonb_agg(page_entry.value order by page_entry.ordinality), '[]'::jsonb)
    into page_rows
    from jsonb_array_elements(fetched_rows) with ordinality as page_entry(value, ordinality)
    where page_entry.ordinality <= p_page_size;

  next_cursor := case
    when has_more then page_rows -> (jsonb_array_length(page_rows) - 1) ->> 'event_id'
    else null
  end;

  return jsonb_build_object(
    'status', 'ok',
    'workspace_id', p_workspace_id,
    'workspace_generation', workspace_generation::text,
    'rows', page_rows,
    'next_cursor', next_cursor
  );
end;
$$;

revoke all on function public.load_cloud_events_page_authorized(uuid, text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.load_cloud_events_page_authorized(uuid, text, integer, text)
  to authenticated;

comment on table public.cloud_event_workspace_generations is
  'Internal monotonic generation used to reject mixed-version paginated Workspace loads.';
comment on function public.load_cloud_events_page_authorized(uuid, text, integer, text) is
  'Locks membership and the Workspace generation, verifies the expected generation, then returns one C-collated Cloud Event page.';

commit;
