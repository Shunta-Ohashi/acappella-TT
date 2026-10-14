\set ON_ERROR_STOP on

-- Read-only invariant check used after every HTTP failure scenario.
begin;

create temporary table cloud_event_v2_http_expected (
  generation bigint not null,
  legacy_generation bigint not null,
  v1_generation bigint not null,
  revision bigint not null,
  event_name text not null
) on commit drop;

insert into cloud_event_v2_http_expected values (
  :'expected_generation'::bigint,
  :'expected_legacy_generation'::bigint,
  :'expected_v1_generation'::bigint,
  :'expected_revision'::bigint,
  :'expected_event_name'::text
);

do $$
declare
  expected cloud_event_v2_http_expected%rowtype;
begin
  select * into strict expected from cloud_event_v2_http_expected;

  if (select count(*) from public.cloud_events
      where workspace_id in (
        '76000000-0000-0000-0000-000000000001',
        '76000000-0000-0000-0000-000000000002',
        '76000000-0000-0000-0000-000000000003'
      )) <> 2
    or (select event_name from public.cloud_events
        where workspace_id = '76000000-0000-0000-0000-000000000001'
          and event_id = 'v2-http-event') is distinct from expected.event_name
    or (select revision from public.cloud_events
        where workspace_id = '76000000-0000-0000-0000-000000000001'
          and event_id = 'v2-http-event') is distinct from expected.revision
    or (select event_snapshot ->> 'version' from public.cloud_events
        where workspace_id = '76000000-0000-0000-0000-000000000001'
          and event_id = 'v2-http-event') is distinct from '2'
    or (select generation from public.cloud_event_workspace_generations
        where workspace_id = '76000000-0000-0000-0000-000000000001')
        is distinct from expected.generation
    or (select generation from public.cloud_event_workspace_generations
        where workspace_id = '76000000-0000-0000-0000-000000000002')
        is distinct from expected.legacy_generation
    or (select generation from public.cloud_event_workspace_generations
        where workspace_id = '76000000-0000-0000-0000-000000000003')
        is distinct from expected.v1_generation
    or (select array_agg(member_id order by member_id collate "C")
        from public.cloud_event_member_references
        where workspace_id = '76000000-0000-0000-0000-000000000001'
          and event_id = 'v2-http-event')
        is distinct from array['v2-http-member-a', 'v2-http-member-b']::text[]
    or (select array_agg(band_id order by band_id collate "C")
        from public.cloud_event_band_references
        where workspace_id = '76000000-0000-0000-0000-000000000001'
          and event_id = 'v2-http-event')
        is distinct from array['v2-http-band-a']::text[]
    or exists (
      select 1 from public.cloud_events
      where workspace_id = '76000000-0000-0000-0000-000000000002'
    )
    or (select event_snapshot ->> 'version' from public.cloud_events
        where workspace_id = '76000000-0000-0000-0000-000000000003'
          and event_id = 'v1-http-event') is distinct from '1'
    or (select revision from public.cloud_events
        where workspace_id = '76000000-0000-0000-0000-000000000003'
          and event_id = 'v1-http-event') is distinct from 1
    or (select count(*) from public.workspace_master_members
        where workspace_id = '76000000-0000-0000-0000-000000000001') <> 2
    or (select count(*) from public.workspace_master_bands
        where workspace_id = '76000000-0000-0000-0000-000000000001') <> 1
    or (select count(*) from public.workspace_master_band_members
        where workspace_id = '76000000-0000-0000-0000-000000000001') <> 2
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '76000000-0000-0000-0000-000000000001')
        is distinct from 'ready'
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '76000000-0000-0000-0000-000000000002')
        is distinct from 'legacy'
    or (select status from public.cloud_workspace_master_states
        where workspace_id = '76000000-0000-0000-0000-000000000003')
        is distinct from 'ready' then
    raise exception 'Cloud Event V2 HTTP smoke invariant changed';
  end if;
end;
$$;

rollback;
