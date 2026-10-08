-- Read each Cloud Event page through a transaction-scoped authorization
-- boundary. The membership row lock orders a concurrent role change or
-- revocation against this page only; it does not create a cross-request
-- snapshot for the complete pagination run.
create index cloud_events_workspace_event_id_c_idx
  on public.cloud_events(workspace_id, event_id collate "C");

create function public.load_cloud_events_page_authorized(
  p_workspace_id uuid,
  p_after_event_id text,
  p_page_size integer
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
    or (p_after_event_id is not null and btrim(p_after_event_id) = '') then
    raise exception 'workspace id, cursor, or page size is invalid'
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
    'rows', page_rows,
    'next_cursor', next_cursor
  );
end;
$$;

revoke all on function public.load_cloud_events_page_authorized(uuid, text, integer)
  from public;
revoke all on function public.load_cloud_events_page_authorized(uuid, text, integer)
  from anon;
revoke all on function public.load_cloud_events_page_authorized(uuid, text, integer)
  from authenticated;
revoke all on function public.load_cloud_events_page_authorized(uuid, text, integer)
  from service_role;
grant execute on function public.load_cloud_events_page_authorized(uuid, text, integer)
  to authenticated;

comment on function public.load_cloud_events_page_authorized(uuid, text, integer) is
  'Locks and validates the caller membership, then returns one C-collated Cloud Event page in an authorization envelope.';
