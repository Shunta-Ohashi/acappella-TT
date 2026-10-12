-- Add generation-consistent Workspace Master reads and a backend-only CAS
-- mutation contract. Existing Workspaces stay legacy and Snapshot V1 remains
-- the active Cloud Event format; this migration performs no seed/backfill.

begin;

create function public.load_workspace_masters_page_authorized(
  p_workspace_id uuid,
  p_after_kind text,
  p_after_master_id text,
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
  master_status text;
  workspace_generation bigint;
  fetched_rows jsonb;
  page_rows jsonb;
  has_more boolean;
  next_cursor jsonb;
begin
  if caller_id is null then
    raise exception 'Workspace Master read requires authentication'
      using errcode = '42501';
  end if;
  if p_workspace_id is null
    or p_page_size is null
    or p_page_size < 1
    or p_page_size > 100
    or ((p_after_kind is null) <> (p_after_master_id is null))
    or (p_after_kind is not null and p_after_kind not in ('member', 'band'))
    or (p_after_master_id is not null and btrim(p_after_master_id) = '')
    or (p_expected_generation is not null
      and p_expected_generation !~ '^(0|[1-9][0-9]*)$') then
    raise exception 'Workspace Master page arguments are invalid'
      using errcode = '22023';
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = p_workspace_id
    and workspace_members.user_id = caller_id
  for share;

  if membership_role is null
    or membership_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Workspace Master read is not permitted'
      using errcode = '42501';
  end if;

  -- State precedes generation in every Master operation. Holding both shared
  -- locks closes the status/read and generation/read MVCC gaps for this page.
  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for share;

  if master_status is distinct from 'ready' then
    raise exception 'Workspace Master state is not ready'
      using errcode = '55000';
  end if;

  select cloud_event_workspace_generations.generation
    into workspace_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id
  for share;

  if workspace_generation is null then
    raise exception 'Workspace generation is unavailable'
      using errcode = '55000';
  end if;
  if p_expected_generation is not null
    and p_expected_generation::bigint <> workspace_generation then
    raise exception 'Workspace changed during Master pagination'
      using errcode = '40001';
  end if;

  with master_candidates as (
    select
      0 as sort_rank,
      'member'::text as master_kind,
      workspace_master_members.member_id as master_id,
      jsonb_build_object(
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
      ) as row_value
    from public.workspace_master_members
    where workspace_master_members.workspace_id = p_workspace_id
    union all
    select
      1,
      'band'::text,
      workspace_master_bands.band_id,
      jsonb_build_object(
        'kind', 'band',
        'workspaceId', workspace_master_bands.workspace_id,
        'value', jsonb_strip_nulls(jsonb_build_object(
          'id', workspace_master_bands.band_id,
          'name', workspace_master_bands.name,
          'defaultMemberIds', coalesce((
            select jsonb_agg(
              workspace_master_band_members.member_id
              order by workspace_master_band_members.position
            )
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
      )
    from public.workspace_master_bands
    where workspace_master_bands.workspace_id = p_workspace_id
  ), filtered_candidates as (
    select * from master_candidates
    where p_after_kind is null
      or sort_rank > case p_after_kind when 'member' then 0 else 1 end
      or (
        sort_rank = case p_after_kind when 'member' then 0 else 1 end
        and (master_id collate "C") > (p_after_master_id collate "C")
      )
    order by sort_rank, master_id collate "C"
    limit (p_page_size + 1)
  )
  select coalesce(
    jsonb_agg(row_value order by sort_rank, master_id collate "C"),
    '[]'::jsonb
  ) into fetched_rows
  from filtered_candidates;

  has_more := jsonb_array_length(fetched_rows) > p_page_size;
  select coalesce(
    jsonb_agg(page_entry.value order by page_entry.ordinality),
    '[]'::jsonb
  ) into page_rows
  from jsonb_array_elements(fetched_rows) with ordinality
    as page_entry(value, ordinality)
  where page_entry.ordinality <= p_page_size;

  next_cursor := case when has_more then jsonb_build_object(
    'kind', page_rows -> (jsonb_array_length(page_rows) - 1) ->> 'kind',
    'id', page_rows -> (jsonb_array_length(page_rows) - 1) -> 'value' ->> 'id'
  ) else null end;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'workspaceGeneration', workspace_generation::text,
    'rows', page_rows,
    'nextCursor', next_cursor
  );
end;
$$;

revoke all on function public.load_workspace_masters_page_authorized(
  uuid, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.load_workspace_masters_page_authorized(
  uuid, text, text, integer, text
) to authenticated;

create function public.mutate_workspace_master_validated(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_operation text,
  p_master_kind text,
  p_payload jsonb,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  membership_role text;
  master_status text;
  target_id text;
  current_revision bigint;
  workspace_generation bigint;
  saved_member public.workspace_master_members%rowtype;
  saved_band public.workspace_master_bands%rowtype;
  default_member_ids jsonb;
begin
  if p_actor_id is null or p_workspace_id is null
    or p_operation is null
    or p_master_kind is null
    or p_payload is null
    or p_operation not in ('create', 'update', 'delete')
    or p_master_kind not in ('member', 'band')
    or jsonb_typeof(p_payload) <> 'object'
    or (p_operation = 'create' and p_expected_revision is not null)
    or (p_operation in ('update', 'delete') and (
      p_expected_revision is null or p_expected_revision < 1
    )) then
    raise exception 'Workspace Master mutation arguments are invalid'
      using errcode = '22023';
  end if;

  target_id := p_payload ->> 'id';
  if jsonb_typeof(p_payload -> 'id') <> 'string'
    or target_id is null or btrim(target_id) = '' then
    raise exception 'Workspace Master ID is invalid' using errcode = '22023';
  end if;

  if p_operation = 'delete' then
    if p_payload - 'id' <> '{}'::jsonb then
      raise exception 'Workspace Master delete payload is invalid'
        using errcode = '22023';
    end if;
  elsif p_master_kind = 'member' then
    if p_payload - array[
        'id', 'realName', 'acaName', 'entryAcademicYear', 'notes', 'active'
      ] <> '{}'::jsonb
      or jsonb_typeof(p_payload -> 'id') <> 'string'
      or jsonb_typeof(p_payload -> 'realName') <> 'string'
      or btrim(p_payload ->> 'realName') = ''
      or jsonb_typeof(p_payload -> 'active') <> 'boolean'
      or (p_payload ? 'acaName' and jsonb_typeof(p_payload -> 'acaName') <> 'string')
      or (p_payload ? 'notes' and jsonb_typeof(p_payload -> 'notes') <> 'string')
      or (p_payload ? 'entryAcademicYear' and (
        jsonb_typeof(p_payload -> 'entryAcademicYear') <> 'number'
        or (p_payload ->> 'entryAcademicYear') !~ '^[1-9][0-9]*$'
        or (p_payload ->> 'entryAcademicYear')::numeric > 2147483647
      )) then
      raise exception 'Workspace Member payload is invalid'
        using errcode = '22023';
    end if;
  else
    if p_payload - array[
        'id', 'name', 'defaultMemberIds', 'notes', 'active'
      ] <> '{}'::jsonb
      or jsonb_typeof(p_payload -> 'id') <> 'string'
      or jsonb_typeof(p_payload -> 'name') <> 'string'
      or btrim(p_payload ->> 'name') = ''
      or jsonb_typeof(p_payload -> 'active') <> 'boolean'
      or jsonb_typeof(p_payload -> 'defaultMemberIds') <> 'array'
      or (p_payload ? 'notes' and jsonb_typeof(p_payload -> 'notes') <> 'string')
      or exists (
        select 1
        from jsonb_array_elements(p_payload -> 'defaultMemberIds') as item(value)
        where jsonb_typeof(item.value) <> 'string'
          or btrim(item.value #>> '{}') = ''
      )
      or (
        select count(*) <> count(distinct item.value #>> '{}')
        from jsonb_array_elements(p_payload -> 'defaultMemberIds') as item(value)
      ) then
      raise exception 'Workspace Band payload is invalid'
        using errcode = '22023';
    end if;
  end if;

  select workspace_members.role into membership_role
  from public.workspace_members
  where workspace_members.workspace_id = p_workspace_id
    and workspace_members.user_id = p_actor_id
  for share;

  if membership_role is null or membership_role not in ('owner', 'editor') then
    raise exception 'Workspace Master mutation is not permitted'
      using errcode = '42501';
  end if;

  -- Membership -> state -> target Master -> generation (via AFTER trigger) is
  -- the common lock order. A status transition cannot race a normal mutation.
  select cloud_workspace_master_states.status into master_status
  from public.cloud_workspace_master_states
  where cloud_workspace_master_states.workspace_id = p_workspace_id
  for share;

  if master_status is distinct from 'ready' then
    raise exception 'Workspace Master state is not ready'
      using errcode = '55000';
  end if;

  if p_master_kind = 'member' then
    if p_operation = 'create' then
      insert into public.workspace_master_members (
        workspace_id, member_id, real_name, aca_name,
        entry_academic_year, notes, active
      ) values (
        p_workspace_id,
        target_id,
        p_payload ->> 'realName',
        p_payload ->> 'acaName',
        (p_payload ->> 'entryAcademicYear')::integer,
        p_payload ->> 'notes',
        (p_payload ->> 'active')::boolean
      ) returning * into saved_member;
    else
      select workspace_master_members.revision into current_revision
      from public.workspace_master_members
      where workspace_master_members.workspace_id = p_workspace_id
        and workspace_master_members.member_id = target_id
      for update;
      if current_revision is null then
        raise exception 'Workspace Member not found' using errcode = 'P0002';
      end if;
      if current_revision <> p_expected_revision then
        raise exception 'Workspace Member revision conflict' using errcode = '40001';
      end if;

      if p_operation = 'delete' then
        delete from public.workspace_master_members
        where workspace_id = p_workspace_id and member_id = target_id;
      else
        update public.workspace_master_members set
          real_name = p_payload ->> 'realName',
          aca_name = p_payload ->> 'acaName',
          entry_academic_year = (p_payload ->> 'entryAcademicYear')::integer,
          notes = p_payload ->> 'notes',
          active = (p_payload ->> 'active')::boolean
        where workspace_id = p_workspace_id and member_id = target_id
        returning * into saved_member;
      end if;
    end if;
  else
    if p_operation <> 'delete' then
      -- Lock referenced Member rows in stable C order before writing relation
      -- rows. Missing or cross-Workspace IDs fail before partial Band changes.
      perform 1
      from public.workspace_master_members
      where workspace_master_members.workspace_id = p_workspace_id
        and workspace_master_members.member_id in (
          select item.value #>> '{}'
          from jsonb_array_elements(p_payload -> 'defaultMemberIds') as item(value)
        )
      order by workspace_master_members.member_id collate "C"
      for share;

      if (
        select count(*)
        from public.workspace_master_members
        where workspace_master_members.workspace_id = p_workspace_id
          and workspace_master_members.member_id in (
            select item.value #>> '{}'
            from jsonb_array_elements(p_payload -> 'defaultMemberIds') as item(value)
          )
      ) <> jsonb_array_length(p_payload -> 'defaultMemberIds') then
        raise exception 'Workspace Band references an unknown Member'
          using errcode = 'PMA01';
      end if;
    end if;

    if p_operation = 'create' then
      insert into public.workspace_master_bands (
        workspace_id, band_id, name, notes, active
      ) values (
        p_workspace_id,
        target_id,
        p_payload ->> 'name',
        p_payload ->> 'notes',
        (p_payload ->> 'active')::boolean
      ) returning * into saved_band;
    else
      select workspace_master_bands.revision into current_revision
      from public.workspace_master_bands
      where workspace_master_bands.workspace_id = p_workspace_id
        and workspace_master_bands.band_id = target_id
      for update;
      if current_revision is null then
        raise exception 'Workspace Band not found' using errcode = 'P0002';
      end if;
      if current_revision <> p_expected_revision then
        raise exception 'Workspace Band revision conflict' using errcode = '40001';
      end if;

      if p_operation = 'delete' then
        delete from public.workspace_master_bands
        where workspace_id = p_workspace_id and band_id = target_id;
      else
        -- The UPDATE always runs, including an order-only mutation, so the
        -- Band revision advances exactly once for every successful CAS call.
        update public.workspace_master_bands set
          name = p_payload ->> 'name',
          notes = p_payload ->> 'notes',
          active = (p_payload ->> 'active')::boolean
        where workspace_id = p_workspace_id and band_id = target_id
        returning * into saved_band;
      end if;
    end if;

    if p_operation <> 'delete' then
      delete from public.workspace_master_band_members
      where workspace_id = p_workspace_id and band_id = target_id;
      insert into public.workspace_master_band_members (
        workspace_id, band_id, member_id, position
      )
      select p_workspace_id, target_id, item.value #>> '{}', item.ordinality - 1
      from jsonb_array_elements(p_payload -> 'defaultMemberIds')
        with ordinality as item(value, ordinality)
      order by item.ordinality;
    end if;
  end if;

  select cloud_event_workspace_generations.generation
    into workspace_generation
  from public.cloud_event_workspace_generations
  where cloud_event_workspace_generations.workspace_id = p_workspace_id;

  if workspace_generation is null then
    raise exception 'Workspace generation is unavailable'
      using errcode = '55000';
  end if;

  if p_operation = 'delete' then
    return jsonb_build_object(
      'status', 'ok',
      'workspaceId', p_workspace_id,
      'workspaceGeneration', workspace_generation::text,
      'deletion', jsonb_build_object(
        'kind', p_master_kind,
        'workspaceId', p_workspace_id,
        'id', target_id,
        'revision', current_revision
      )
    );
  end if;

  if p_master_kind = 'member' then
    return jsonb_build_object(
      'status', 'ok',
      'workspaceId', p_workspace_id,
      'workspaceGeneration', workspace_generation::text,
      'record', jsonb_build_object(
        'kind', 'member',
        'workspaceId', p_workspace_id,
        'value', jsonb_strip_nulls(jsonb_build_object(
          'id', saved_member.member_id,
          'realName', saved_member.real_name,
          'acaName', saved_member.aca_name,
          'entryAcademicYear', saved_member.entry_academic_year,
          'notes', saved_member.notes,
          'active', saved_member.active
        )),
        'revision', saved_member.revision,
        'createdAt', saved_member.created_at,
        'updatedAt', saved_member.updated_at
      )
    );
  end if;

  select coalesce(
    jsonb_agg(member_id order by position),
    '[]'::jsonb
  ) into default_member_ids
  from public.workspace_master_band_members
  where workspace_id = p_workspace_id and band_id = target_id;

  return jsonb_build_object(
    'status', 'ok',
    'workspaceId', p_workspace_id,
    'workspaceGeneration', workspace_generation::text,
    'record', jsonb_build_object(
      'kind', 'band',
      'workspaceId', p_workspace_id,
      'value', jsonb_strip_nulls(jsonb_build_object(
        'id', saved_band.band_id,
        'name', saved_band.name,
        'defaultMemberIds', default_member_ids,
        'notes', saved_band.notes,
        'active', saved_band.active
      )),
      'revision', saved_band.revision,
      'createdAt', saved_band.created_at,
      'updatedAt', saved_band.updated_at
    )
  );
end;
$$;

revoke all on function public.mutate_workspace_master_validated(
  uuid, uuid, text, text, jsonb, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.mutate_workspace_master_validated(
  uuid, uuid, text, text, jsonb, bigint
) to service_role;

comment on function public.load_workspace_masters_page_authorized(
  uuid, text, text, integer, text
) is
  'Reads one C-collated normalized Workspace Master page at an expected shared generation; only ready Workspaces are exposed.';
comment on function public.mutate_workspace_master_validated(
  uuid, uuid, text, text, jsonb, bigint
) is
  'Backend-only owner/editor Workspace Master create/update/delete with ready-state gating, revision CAS, and atomic ordered Band membership.';

-- Fail closed if inherited/default grants undermine either endpoint or restore
-- browser writes to the normalized Master tables.
do $$
declare
  table_name text;
  role_name text;
  privilege_name text;
  read_function oid := to_regprocedure(
    'public.load_workspace_masters_page_authorized(uuid,text,text,integer,text)'
  );
  mutation_function oid := to_regprocedure(
    'public.mutate_workspace_master_validated(uuid,uuid,text,text,jsonb,bigint)'
  );
begin
  if read_function is null or mutation_function is null then
    raise exception 'Workspace Master contract function is missing'
      using errcode = '55000';
  end if;

  if not has_function_privilege('authenticated', read_function, 'EXECUTE')
    or has_function_privilege('anon', read_function, 'EXECUTE')
    or has_function_privilege('service_role', read_function, 'EXECUTE')
    or exists (
      select 1 from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl,
        pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = read_function
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Workspace Master read RPC privileges are unsafe'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', mutation_function, 'EXECUTE')
    or has_function_privilege('anon', mutation_function, 'EXECUTE')
    or has_function_privilege('authenticated', mutation_function, 'EXECUTE')
    or exists (
      select 1 from pg_catalog.pg_proc
      cross join lateral pg_catalog.aclexplode(coalesce(
        pg_proc.proacl,
        pg_catalog.acldefault('f', pg_proc.proowner)
      )) as function_acl
      where pg_proc.oid = mutation_function
        and function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Workspace Master mutation RPC privileges are unsafe'
      using errcode = '42501';
  end if;

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
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
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
        'INSERT,UPDATE,REFERENCES'
      ) then
        raise exception '% retains column writes on public.%', role_name, table_name
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
        and table_acl.privilege_type in (
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        )
    ) then
      raise exception 'PUBLIC retains writes on public.%', table_name
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
        and column_acl.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
    ) then
      raise exception 'PUBLIC retains column writes on public.%', table_name
        using errcode = '42501';
    end if;
  end loop;
end;
$$;

commit;
