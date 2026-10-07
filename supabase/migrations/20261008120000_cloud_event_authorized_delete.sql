create function public.delete_cloud_event_authorized(
  p_workspace_id uuid,
  p_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  membership_role text;
  deleted_count integer;
begin
  if caller_id is null then
    raise exception 'cloud event deletion requires authentication'
      using errcode = '42501';
  end if;

  if p_workspace_id is null or p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'workspace id and event id are required'
      using errcode = '22023';
  end if;

  select workspace_members.role
    into membership_role
    from public.workspace_members
    where workspace_members.workspace_id = p_workspace_id
      and workspace_members.user_id = caller_id
    for share;

  if membership_role is null or membership_role not in ('owner', 'editor') then
    raise exception 'cloud event deletion is not permitted'
      using errcode = '42501';
  end if;

  delete from public.cloud_events
    where cloud_events.workspace_id = p_workspace_id
      and cloud_events.event_id = p_event_id;

  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'status', case when deleted_count = 1 then 'deleted' else 'already_absent' end,
    'workspace_id', p_workspace_id,
    'event_id', p_event_id
  );
end;
$$;

revoke all on function public.delete_cloud_event_authorized(uuid, text) from public;
revoke all on function public.delete_cloud_event_authorized(uuid, text) from anon;
revoke all on function public.delete_cloud_event_authorized(uuid, text) from authenticated;
revoke all on function public.delete_cloud_event_authorized(uuid, text) from service_role;
grant execute on function public.delete_cloud_event_authorized(uuid, text) to authenticated;

comment on function public.delete_cloud_event_authorized(uuid, text) is
  'Deletes one Cloud Event after locking and validating the caller membership; an authorized missing row is an idempotent success.';
