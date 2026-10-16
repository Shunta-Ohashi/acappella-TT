-- Add one backend-only, read-only evidence boundary for the future Snapshot
-- V2 cutover. This migration registers the function and its ACL only; it does
-- not backfill, rewrite an Event, or change a Workspace status/generation.

begin;

create function public.inspect_cloud_v2_cutover_state(
  p_workspace_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  master_status text;
  workspace_generation bigint;
begin
  if p_workspace_id is null then
    raise exception 'Workspace ID is required' using errcode = '22023';
  end if;

  -- Keep the established status -> generation lock order. Every supported
  -- Event/Master writer must acquire an UPDATE lock on the same generation
  -- row before commit. Once these locks are held, the remaining SELECTs form
  -- complete evidence for the returned generation rather than a mixed read.
  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for share;

  if master_status is null then
    raise exception 'Workspace Master state is unavailable' using errcode = '55000';
  end if;

  select cloud_event_workspace_generations.generation
    into workspace_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id
  for share;

  if workspace_generation is null then
    raise exception 'Workspace generation is unavailable' using errcode = '55000';
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'workspaceStatus', master_status,
    'workspaceGeneration', workspace_generation::text,
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'workspaceId', cloud_events.workspace_id,
        'eventId', cloud_events.event_id,
        'eventName', cloud_events.event_name,
        'snapshotVersion', cloud_events.event_snapshot -> 'version',
        'snapshot', cloud_events.event_snapshot,
        'snapshotFingerprint', pg_catalog.encode(
          extensions.digest(cloud_events.event_snapshot::text, 'sha256'), 'hex'
        ),
        'revision', cloud_events.revision
      ) order by cloud_events.event_id collate "C"), '[]'::jsonb)
      from public.cloud_events
      where cloud_events.workspace_id = p_workspace_id
    ),
    'existing', jsonb_build_object(
      'members', (select count(*) from public.workspace_master_members
        where workspace_id = p_workspace_id),
      'bands', (select count(*) from public.workspace_master_bands
        where workspace_id = p_workspace_id),
      'bandMembers', (select count(*) from public.workspace_master_band_members
        where workspace_id = p_workspace_id),
      'eventMemberReferences', (
        select count(*) from public.cloud_event_member_references
        where workspace_id = p_workspace_id
      ),
      'eventBandReferences', (
        select count(*) from public.cloud_event_band_references
        where workspace_id = p_workspace_id
      ),
      'completedBackfills', (
        select count(*) from public.cloud_workspace_master_backfills
        where workspace_id = p_workspace_id
      ),
      'completedBackfill', (
        select jsonb_build_object(
          'planFingerprint', plan_fingerprint,
          'sourceGeneration', source_generation::text,
          'resultGeneration', result_generation::text,
          'eventCount', event_count,
          'memberCount', member_count,
          'bandCount', band_count,
          'bandMemberRelationCount', band_member_relation_count,
          'eventMemberReferenceCount', event_member_reference_count,
          'eventBandReferenceCount', event_band_reference_count
        )
        from public.cloud_workspace_master_backfills
        where workspace_id = p_workspace_id
      )
    ),
    'masters', jsonb_build_object(
      'members', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'kind', 'member',
          'workspaceId', workspace_master_members.workspace_id,
          'value', jsonb_strip_nulls(jsonb_build_object(
            'id', workspace_master_members.member_id,
            'realName', workspace_master_members.real_name,
            'acaName', workspace_master_members.aca_name,
            'entryAcademicYear', workspace_master_members.entry_academic_year,
            'notes', workspace_master_members.notes,
            'active', workspace_master_members.active
          )),
          'revision', workspace_master_members.revision,
          'createdAt', workspace_master_members.created_at,
          'updatedAt', workspace_master_members.updated_at
        ) order by workspace_master_members.member_id collate "C"), '[]'::jsonb)
        from public.workspace_master_members
        where workspace_master_members.workspace_id = p_workspace_id
      ),
      'bands', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'kind', 'band',
          'workspaceId', workspace_master_bands.workspace_id,
          'value', jsonb_strip_nulls(jsonb_build_object(
            'id', workspace_master_bands.band_id,
            'name', workspace_master_bands.name,
            'defaultMemberIds', coalesce((
              select jsonb_agg(workspace_master_band_members.member_id
                order by workspace_master_band_members.position)
              from public.workspace_master_band_members
              where workspace_master_band_members.workspace_id =
                  workspace_master_bands.workspace_id
                and workspace_master_band_members.band_id =
                  workspace_master_bands.band_id
            ), '[]'::jsonb),
            'notes', workspace_master_bands.notes,
            'active', workspace_master_bands.active
          )),
          'revision', workspace_master_bands.revision,
          'createdAt', workspace_master_bands.created_at,
          'updatedAt', workspace_master_bands.updated_at
        ) order by workspace_master_bands.band_id collate "C"), '[]'::jsonb)
        from public.workspace_master_bands
        where workspace_master_bands.workspace_id = p_workspace_id
      )
    ),
    'relations', jsonb_build_object(
      'bandMembers', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'workspaceId', workspace_master_band_members.workspace_id,
          'bandId', workspace_master_band_members.band_id,
          'memberId', workspace_master_band_members.member_id,
          'position', workspace_master_band_members.position
        ) order by workspace_master_band_members.band_id collate "C",
          workspace_master_band_members.position,
          workspace_master_band_members.member_id collate "C"), '[]'::jsonb)
        from public.workspace_master_band_members
        where workspace_master_band_members.workspace_id = p_workspace_id
      ),
      'eventMemberReferences', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'workspaceId', cloud_event_member_references.workspace_id,
          'eventId', cloud_event_member_references.event_id,
          'memberId', cloud_event_member_references.member_id
        ) order by cloud_event_member_references.event_id collate "C",
          cloud_event_member_references.member_id collate "C"), '[]'::jsonb)
        from public.cloud_event_member_references
        where cloud_event_member_references.workspace_id = p_workspace_id
      ),
      'eventBandReferences', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'workspaceId', cloud_event_band_references.workspace_id,
          'eventId', cloud_event_band_references.event_id,
          'bandId', cloud_event_band_references.band_id
        ) order by cloud_event_band_references.event_id collate "C",
          cloud_event_band_references.band_id collate "C"), '[]'::jsonb)
        from public.cloud_event_band_references
        where cloud_event_band_references.workspace_id = p_workspace_id
      )
    ),
    'counts', jsonb_build_object(
      'events', (select count(*) from public.cloud_events
        where workspace_id = p_workspace_id),
      'members', (select count(*) from public.workspace_master_members
        where workspace_id = p_workspace_id),
      'bands', (select count(*) from public.workspace_master_bands
        where workspace_id = p_workspace_id),
      'bandMembers', (select count(*) from public.workspace_master_band_members
        where workspace_id = p_workspace_id),
      'eventMemberReferences', (select count(*)
        from public.cloud_event_member_references
        where workspace_id = p_workspace_id),
      'eventBandReferences', (select count(*)
        from public.cloud_event_band_references
        where workspace_id = p_workspace_id)
    )
  );
end;
$$;

revoke all on function public.inspect_cloud_v2_cutover_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.inspect_cloud_v2_cutover_state(uuid)
  to service_role;

comment on function public.inspect_cloud_v2_cutover_state(uuid) is
  'Backend-only read of complete Snapshot, normalized Master, relation, generation, and completed-backfill evidence for read-only V2 cutover preflight.';

-- Fail closed if this migration accidentally exposes the evidence surface.
do $$
declare
  function_oid oid := to_regprocedure(
    'public.inspect_cloud_v2_cutover_state(uuid)'
  );
begin
  if function_oid is null
    or not has_function_privilege('service_role', function_oid, 'EXECUTE')
    or has_function_privilege('authenticated', function_oid, 'EXECUTE')
    or has_function_privilege('anon', function_oid, 'EXECUTE')
    or exists (
      select 1
      from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl, pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = function_oid
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Cloud V2 cutover inspection RPC privileges are unsafe'
      using errcode = '42501';
  end if;
end;
$$;

commit;
