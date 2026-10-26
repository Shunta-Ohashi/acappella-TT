import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'
import {
  createSupabaseLiveTimetableRepository,
} from '../src/live/liveTimetableRepository.ts'
import { deleteLiveSmokeAuthUsers } from './liveTimetableFoundationSmokeCleanup.mjs'

const execFileAsync = promisify(execFile)
const API_PORT = '56121'
const DATABASE_PORT = '56122'
const EXPECTED_REALTIME_COLUMNS = [
  'id', 'workspace_id', 'live_timetable_id', 'projection_version',
  'revision', 'progress_status', 'updated_at',
]
const setupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/live_timetable_state_foundation_http_setup.sql',
  import.meta.url,
))
const cleanupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/live_timetable_state_foundation_http_cleanup.sql',
  import.meta.url,
))

const requiredEnvironment = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const parseLoopbackUrl = (value, label, protocols, allowCredentials = false) => {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is invalid.`)
  }
  if (!protocols.has(parsed.protocol) ||
    !new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
      .has(parsed.hostname.toLowerCase())) {
    throw new Error(`${label} must use the dedicated loopback environment.`)
  }
  if ((!allowCredentials && (parsed.username || parsed.password)) || parsed.hash) {
    throw new Error(`${label} contains unsupported URL components.`)
  }
  return parsed
}

const parseArguments = args => {
  if (args.length !== 1 || args[0] !== '--confirm-disposable') {
    throw new Error('Exactly one --confirm-disposable argument is required.')
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const waitFor = async (predicate, message, timeoutMilliseconds = 12_000) => {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(message)
}

const createDomainState = eventId => ({
  members: [],
  bands: [],
  events: [{
    id: eventId,
    name: 'Live HTTP Realtime fixture',
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [10],
  }],
  eventDays: [{
    id: `${eventId}-day`, eventId, date: '2026-11-01', label: '   ', order: 0,
  }],
  stages: [
    {
      id: `${eventId}-stage-a`, eventDayId: `${eventId}-day`,
      name: 'Main', order: 0, plannedStartTime: '10:00',
    },
    {
      id: `${eventId}-stage-b`, eventDayId: `${eventId}-day`,
      name: 'Sub', order: 1, plannedStartTime: '11:00',
    },
  ],
  sections: [],
  eventMembers: [],
  eventMemberDays: [],
  eventBands: [
    {
      id: `${eventId}-band-a`, eventId, eventDayId: `${eventId}-day`,
      name: 'First Band', memberIds: [], durationMinutes: 10,
    },
    {
      id: `${eventId}-band-b`, eventId, eventDayId: `${eventId}-day`,
      name: 'Second Band', memberIds: [], durationMinutes: 10,
    },
  ],
  scheduleItems: [
    {
      id: `${eventId}-item-a`, stageId: `${eventId}-stage-a`, order: 0,
      kind: 'performance', eventBandId: `${eventId}-band-a`,
    },
    {
      id: `${eventId}-break`, stageId: `${eventId}-stage-a`, order: 1,
      kind: 'break', title: 'Private break title', durationMinutes: 5,
    },
    {
      id: `${eventId}-item-b`, stageId: `${eventId}-stage-b`, order: 0,
      kind: 'performance', eventBandId: `${eventId}-band-b`,
    },
  ],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
  timetableLocks: [],
  timetableOrderConstraints: [],
})

const createRealtimeProbe = (client, label, workspaceId) => {
  const events = []
  const statuses = []
  const channel = client
    .channel(`live-foundation-${label}-${randomUUID()}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'live_timetable_stages',
      filter: `workspace_id=eq.${workspaceId}`,
      select: EXPECTED_REALTIME_COLUMNS,
    }, payload => events.push(payload))
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `${label} Realtime subscription did not settle.`,
    )), 10_000)
    channel.subscribe(status => {
      statuses.push(status)
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT') {
        clearTimeout(timeout)
        resolve(status)
      }
    })
  })
  return { label, client, channel, events, statuses, ready }
}

const assertRealtimePayload = payload => {
  assert.equal(payload.eventType, 'UPDATE')
  assert.deepEqual(Object.keys(payload.new).sort(), [...EXPECTED_REALTIME_COLUMNS].sort())
  assert.equal(Object.hasOwn(payload.new, 'name'), false)
  assert.equal(Object.hasOwn(payload.new, 'current_entry_position'), false)
}

const run = async () => {
  parseArguments(process.argv.slice(2))
  const supabaseUrl = requiredEnvironment('LIVE_TT_SMOKE_SUPABASE_URL')
  const anonKey = requiredEnvironment('LIVE_TT_SMOKE_ANON_KEY')
  const serviceRoleKey = requiredEnvironment('LIVE_TT_SMOKE_SERVICE_ROLE_KEY')
  const databaseUrl = requiredEnvironment('LIVE_TT_SMOKE_DATABASE_URL')

  const apiUrl = parseLoopbackUrl(
    supabaseUrl, 'Supabase URL', new Set(['http:', 'https:']),
  )
  const dbUrl = parseLoopbackUrl(
    databaseUrl, 'Database URL', new Set(['postgres:', 'postgresql:']), true,
  )
  if (apiUrl.port !== API_PORT || apiUrl.pathname !== '/' ||
    apiUrl.search || dbUrl.port !== DATABASE_PORT ||
    dbUrl.pathname !== '/postgres' || dbUrl.search) {
    throw new Error(`Only disposable API ${API_PORT} / DB ${DATABASE_PORT} is allowed.`)
  }

  const functionUrl = `${apiUrl.origin}/functions/v1/create-live-timetable`
  const suffix = randomUUID()
  const workspaceId = randomUUID()
  const workspaceName = `Live HTTP Realtime fixture ${suffix}`
  const eventId = `live-http-${suffix}`
  const password = `${randomUUID()}Aa1!`
  const emails = Object.fromEntries(['owner', 'editor', 'viewer', 'outsider']
    .map(role => [role, `live-tt-${role}-${suffix}@example.invalid`]))
  const createdUserIds = []
  const probes = []
  let fixtureCreated = false
  let successReport

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const runPsqlFile = async (path, variables) => {
    const args = [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1']
    for (const [key, value] of Object.entries(variables)) {
      args.push('-v', `${key}=${value}`)
    }
    args.push('-f', path)
    try {
      await execFileAsync('psql', args, {
        windowsHide: true,
        env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
      })
    } catch {
      throw new Error(`Dedicated psql fixture failed: ${path.split(/[\\/]/u).at(-1)}`)
    }
  }

  const runPsqlCommand = async (sql, variables = {}, operation = 'fixture command') => {
    const args = [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At']
    const settingOptions = []
    for (const [key, value] of Object.entries(variables)) {
      if (!/^[a-z_]+$/u.test(key) || !/^[a-z0-9-]+$/iu.test(value)) {
        throw new Error('Dedicated psql setting is invalid.')
      }
      settingOptions.push(`-c live_smoke.${key}=${value}`)
    }
    args.push('-c', sql)
    try {
      return (await execFileAsync('psql', args, {
        windowsHide: true,
        env: {
          ...process.env,
          PGCLIENTENCODING: 'UTF8',
          PGOPTIONS: settingOptions.join(' '),
        },
      })).stdout.trim()
    } catch {
      throw new Error(`Dedicated psql command failed (${operation}).`)
    }
  }

  const signIn = async email => {
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error || !data.session?.access_token) {
      throw new Error('Dedicated Auth user sign-in failed.')
    }
    await client.realtime.setAuth(data.session.access_token)
    return { client, token: data.session.access_token }
  }

  const rawInvoke = async (token, body) => {
    const headers = { apikey: anonKey, 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(functionUrl, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let value
    try { value = JSON.parse(text) } catch { value = undefined }
    return { status: response.status, value }
  }

  try {
    const migrationCheck = await runPsqlCommand(
      "select count(*) || '|' || max(version) from supabase_migrations.schema_migrations",
    )
    assert.equal(migrationCheck, '16|20261021050414')
    const publicationColumns = (await runPsqlCommand(
      "select array_to_string(attnames, ',') from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='live_timetable_stages'",
    )).split(',').sort()
    assert.deepEqual(publicationColumns, [...EXPECTED_REALTIME_COLUMNS].sort())

    const users = {}
    for (const [role, email] of Object.entries(emails)) {
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      })
      if (error || !data.user) throw new Error(`Dedicated ${role} Auth user creation failed.`)
      createdUserIds.push(data.user.id)
      users[role] = data.user
    }

    const sqlVariables = {
      workspace_id: workspaceId,
      workspace_name: workspaceName,
      event_id: eventId,
      owner_id: users.owner.id,
      editor_id: users.editor.id,
      viewer_id: users.viewer.id,
      outsider_id: users.outsider.id,
    }
    await runPsqlFile(setupSqlPath, sqlVariables)
    fixtureCreated = true

    const snapshotResult = createCloudEventSnapshot(createDomainState(eventId), eventId)
    assert.equal(snapshotResult.ok, true)
    const { data: saved, error: saveError } = await admin.rpc(
      'save_cloud_event_validated',
      {
        p_actor_id: users.owner.id,
        p_workspace_id: workspaceId,
        p_event_snapshot: snapshotResult.snapshot,
      },
    )
    assert.equal(saveError, null)
    assert.equal(saved.revision, 1)

    const sessions = {}
    for (const role of Object.keys(emails)) sessions[role] = await signIn(emails[role])
    const repositories = Object.fromEntries(Object.entries(sessions).map(
      ([role, session]) => [role, createSupabaseLiveTimetableRepository(session.client)],
    ))

    const pageBefore = await sessions.owner.client.rpc(
      'load_cloud_events_page_authorized',
      {
        p_workspace_id: workspaceId,
        p_after_event_id: null,
        p_page_size: 100,
        p_expected_generation: null,
      },
    )
    assert.equal(pageBefore.error, null)
    assert.equal(pageBefore.data.rows.length, 1)
    const cloudBefore = {
      generation: pageBefore.data.workspace_generation,
      revision: pageBefore.data.rows[0].revision,
      snapshot: pageBefore.data.rows[0].event_snapshot,
    }

    assert.equal((await rawInvoke(null, {})).status, 401)
    assert.equal((await rawInvoke('invalid.jwt.value', {})).status, 401)
    for (const badBody of [
      {},
      {
        workspaceId, eventId, expectedSourceRevision: '1',
        mode: 'create', expectedManagementRevision: null, unknown: true,
      },
      {
        workspaceId, eventId, expectedSourceRevision: '1',
        mode: 'create', expectedManagementRevision: null,
        actorId: users.owner.id,
      },
      {
        workspaceId, eventId, expectedSourceRevision: '1',
        mode: 'create', expectedManagementRevision: null,
        snapshot: snapshotResult.snapshot,
      },
    ]) {
      const rejected = await rawInvoke(sessions.owner.token, badBody)
      assert.equal(rejected.status, 400)
      assert.equal(rejected.value?.error?.code, 'INVALID_REQUEST')
    }

    const staleSource = await rawInvoke(sessions.owner.token, {
      workspaceId, eventId, expectedSourceRevision: '2',
      mode: 'create', expectedManagementRevision: null,
    })
    assert.equal(staleSource.status, 409)
    assert.equal(staleSource.value?.error?.code, 'REVISION_CONFLICT')

    const missingEvent = await rawInvoke(sessions.owner.token, {
      workspaceId, eventId: `missing-${suffix}`, expectedSourceRevision: '1',
      mode: 'create', expectedManagementRevision: null,
    })
    assert.equal(missingEvent.status, 409)
    assert.equal(missingEvent.value?.error?.code, 'EVENT_NOT_FOUND')

    const missingDiscovery = await repositories.owner.findForEvent(
      workspaceId,
      `missing-${suffix}`,
    )
    assert.equal(missingDiscovery.ok, false)
    assert.equal(missingDiscovery.error.code, 'EVENT_NOT_FOUND')
    const missingAuthorizedLive = await repositories.owner.loadAuthorized(randomUUID())
    assert.equal(missingAuthorizedLive.ok, false)
    assert.equal(missingAuthorizedLive.error.code, 'LIVE_NOT_FOUND')

    const missingLive = await rawInvoke(sessions.owner.token, {
      workspaceId, eventId, expectedSourceRevision: '1',
      mode: 'replace', expectedManagementRevision: '1',
    })
    assert.equal(missingLive.status, 409)
    assert.equal(missingLive.value?.error?.code, 'LIVE_NOT_FOUND')

    for (const role of ['editor', 'viewer', 'outsider']) {
      const denied = await repositories[role].createProjection({
        workspaceId, eventId, expectedSourceRevision: '1',
        mode: 'create', expectedManagementRevision: null,
      })
      assert.equal(denied.ok, false)
      assert.equal(denied.error.code, 'ACCESS_DENIED')
    }

    const backendDirect = await sessions.owner.client.rpc(
      'load_live_timetable_projection_source_serialized',
      {
        p_actor_id: users.owner.id,
        p_workspace_id: workspaceId,
        p_event_id: eventId,
        p_expected_source_revision: '1',
      },
    )
    assert.notEqual(backendDirect.error, null)

    const created = await repositories.owner.createProjection({
      workspaceId, eventId, expectedSourceRevision: '1',
      mode: 'create', expectedManagementRevision: null,
    })
    assert.equal(created.ok, true)
    const createdValue = created.value
    const liveId = createdValue.liveId
    const publicId = createdValue.publicId
    assert.equal(createdValue.sourceRevision, '1')
    assert.match(createdValue.sourceSnapshotFingerprint, /^[0-9a-f]{64}$/u)

    const discovery = await repositories.viewer.findForEvent(workspaceId, eventId)
    assert.equal(discovery.ok, true)
    assert.equal(discovery.value.liveId, liveId)
    assert.equal(discovery.value.eventName, 'Live HTTP Realtime fixture')
    assert.equal(discovery.value.sourceRevision, '1')
    const candidates = await repositories.owner.listOperatorCandidates(liveId)
    assert.equal(candidates.ok, true)
    assert.deepEqual(
      new Set(candidates.value.map(candidate => candidate.userId)),
      new Set([users.editor.id, users.viewer.id]),
    )
    assert.equal(
      JSON.stringify(candidates.value).includes('@'),
      false,
    )
    const deniedCandidates = await repositories.viewer.listOperatorCandidates(liveId)
    assert.equal(deniedCandidates.ok, false)
    assert.equal(deniedCandidates.error.code, 'ACCESS_DENIED')

    const duplicate = await repositories.owner.createProjection({
      workspaceId, eventId, expectedSourceRevision: '1',
      mode: 'create', expectedManagementRevision: null,
    })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error.code, 'LIVE_ALREADY_EXISTS')

    const outsiderRead = await repositories.outsider.loadAuthorized(liveId)
    assert.equal(outsiderRead.ok, false)
    assert.equal(outsiderRead.error.code, 'ACCESS_DENIED')
    for (const role of ['owner', 'editor', 'viewer']) {
      const read = await repositories[role].loadAuthorized(liveId)
      assert.equal(read.ok, true)
      assert.equal(read.value.role, role)
    }
    assert.equal((await repositories.owner.loadPublic(publicId)).ok, false)

    const directWrite = await sessions.owner.client
      .from('live_timetable_stages')
      .update({ progress_status: 'completed' })
      .eq('workspace_id', workspaceId)
    assert.notEqual(directWrite.error, null)

    await runPsqlCommand(
      "update public.live_timetables set management_revision=9007199254740993 where id=current_setting('live_smoke.live_id')::uuid and workspace_id=current_setting('live_smoke.workspace_id')::uuid",
      { live_id: liveId, workspace_id: workspaceId },
    )
    const bigintRead = await repositories.owner.loadAuthorized(liveId)
    assert.equal(bigintRead.ok, true)
    assert.equal(bigintRead.value.managementRevision, '9007199254740993')
    assert.equal(bigintRead.value.eventDays[0].label, null)

    for (const [label, client] of [
      ['owner', sessions.owner.client],
      ['editor', sessions.editor.client],
      ['viewer', sessions.viewer.client],
      ['outsider', sessions.outsider.client],
      ['anon', createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })],
    ]) probes.push(createRealtimeProbe(client, label, workspaceId))
    const settled = await Promise.all(probes.map(probe => probe.ready))
    assert.deepEqual(settled, Array(probes.length).fill('SUBSCRIBED'))
    // SUBSCRIBED only acknowledges the WebSocket channel. A fresh local
    // Realtime tenant can report it before postgres_changes is ready, while
    // replication slots already appear active. Prove end-to-end delivery with
    // bounded no-op UPDATEs against this disposable fixture before testing the
    // first semantic mutation. No published value or revision is changed.
    let controlDelivered = false
    for (let attempt = 0; attempt < 4 && !controlDelivered; attempt += 1) {
      await runPsqlCommand(
        "update public.live_timetable_stages set updated_at=updated_at where live_timetable_id=current_setting('live_smoke.live_id')::uuid and workspace_id=current_setting('live_smoke.workspace_id')::uuid",
        { live_id: liveId, workspace_id: workspaceId },
      )
      try {
        await waitFor(
          () => probes.slice(0, 3).every(probe => probe.events.length >= 1),
          'Realtime control update was not delivered.',
          3_000,
        )
        controlDelivered = true
      } catch {
        // Retry only this idempotent disposable-fixture control update.
      }
    }
    assert.equal(controlDelivered, true, 'Realtime control updates were not delivered.')
    await sleep(500)
    assert.equal(probes[3].events.length, 0)
    assert.equal(probes[4].events.length, 0)
    probes.slice(0, 3).forEach(probe => probe.events.forEach(assertRealtimePayload))
    probes.forEach(probe => { probe.events.length = 0 })

    // Postgres Changes must re-evaluate the current RLS policy after a
    // membership is revoked. Keep the already-SUBSCRIBED channel connected,
    // prove the distinct UPDATE reached the owner, and only then accept zero
    // delivery to the revoked viewer as evidence. Restore this dedicated
    // fixture membership even when an assertion fails so strict cleanup can
    // still validate and remove the complete fixture.
    let viewerMembershipRestoreRequired = false
    try {
      viewerMembershipRestoreRequired = true
      const removedRole = await runPsqlCommand(
        "with removed as (delete from public.workspace_members where workspace_id=current_setting('live_smoke.workspace_id')::uuid and user_id=current_setting('live_smoke.viewer_id')::uuid and role='viewer' returning role) select role from removed",
        { workspace_id: workspaceId, viewer_id: users.viewer.id },
        'revoke viewer membership',
      )
      assert.equal(removedRole, 'viewer')
      probes.forEach(probe => { probe.events.length = 0 })

      const revocationUpdate = await runPsqlCommand(
        "with changed as (update public.live_timetable_stages set revision=revision+1,updated_at=clock_timestamp() where id=(select id from public.live_timetable_stages where live_timetable_id=current_setting('live_smoke.live_id')::uuid and workspace_id=current_setting('live_smoke.workspace_id')::uuid order by id limit 1) returning id,revision) select id::text || '|' || revision::text from changed",
        { live_id: liveId, workspace_id: workspaceId },
        'emit post-revocation update',
      )
      const [revocationStageId, revocationRevision] = revocationUpdate.split('|')
      assert.match(revocationStageId, /^[0-9a-f-]{36}$/u)
      assert.match(revocationRevision, /^[1-9][0-9]*$/u)
      const isRevocationUpdate = event =>
        event.eventType === 'UPDATE' &&
        event.new.id === revocationStageId &&
        String(event.new.revision) === revocationRevision
      await waitFor(
        () => probes[0].events.some(isRevocationUpdate),
        'Owner did not receive the post-revocation Realtime update.',
      )
      await sleep(750)
      probes[0].events.forEach(assertRealtimePayload)
      assert.equal(
        probes[2].events.filter(isRevocationUpdate).length,
        0,
        'Revoked viewer received a post-revocation Realtime update.',
      )
      const revokedViewerRead = await repositories.viewer.loadAuthorized(liveId)
      assert.equal(revokedViewerRead.ok, false)
      assert.equal(revokedViewerRead.error.code, 'ACCESS_DENIED')
    } finally {
      if (viewerMembershipRestoreRequired) {
        await runPsqlCommand(
          "insert into public.workspace_members (workspace_id,user_id,role) values (current_setting('live_smoke.workspace_id')::uuid,current_setting('live_smoke.viewer_id')::uuid,'viewer') on conflict (workspace_id,user_id) do nothing",
          { workspace_id: workspaceId, viewer_id: users.viewer.id },
          'restore viewer membership',
        )
        const restoredRole = await runPsqlCommand(
          "select role from public.workspace_members where workspace_id=current_setting('live_smoke.workspace_id')::uuid and user_id=current_setting('live_smoke.viewer_id')::uuid",
          { workspace_id: workspaceId, viewer_id: users.viewer.id },
          'verify viewer membership restoration',
        )
        assert.equal(restoredRole, 'viewer')
      }
    }
    const restoredViewerRead = await repositories.viewer.loadAuthorized(liveId)
    assert.equal(restoredViewerRead.ok, true)
    assert.equal(restoredViewerRead.value.role, 'viewer')
    probes.forEach(probe => { probe.events.length = 0 })

    const published = await repositories.owner.setPublication(
      liveId, '9007199254740993', true,
    )
    assert.equal(published.ok, true)
    assert.equal(published.value.managementRevision, '9007199254740994')
    await waitFor(
      () => probes.slice(0, 3).every(probe => probe.events.length >= 2),
      'Workspace members did not receive publication Realtime updates.',
    )
    await sleep(500)
    assert.equal(probes[3].events.length, 0)
    assert.equal(probes[4].events.length, 0)
    probes.slice(0, 3).forEach(probe => probe.events.forEach(assertRealtimePayload))
    probes.forEach(probe => { probe.events.length = 0 })

    const unassignedStage = bigintRead.value.stages.find(
      stage => stage.sourceStageId === `${eventId}-stage-a`,
    )
    const deniedStart = await repositories.editor.startEntry(
      liveId,
      `${eventId}-stage-a`,
      unassignedStage.stageId,
      `${eventId}-item-a`,
      unassignedStage.entries.find(entry =>
        entry.sourceScheduleItemId === `${eventId}-item-a`).position,
      unassignedStage.revision,
      bigintRead.value.projectionVersion,
    )
    assert.equal(deniedStart.ok, false)
    assert.equal(deniedStart.error.code, 'ACCESS_DENIED')

    const assigned = await repositories.owner.setStageOperator(
      liveId,
      `${eventId}-stage-a`,
      unassignedStage.stageId,
      users.viewer.id,
      true,
      '9007199254740994',
      bigintRead.value.projectionVersion,
    )
    assert.equal(assigned.ok, true)
    await waitFor(
      () => probes.slice(0, 3).every(probe => probe.events.length >= 1),
      'Workspace members did not receive operator Realtime update.',
    )
    await sleep(500)
    assert.equal(probes[3].events.length, 0)
    assert.equal(probes[4].events.length, 0)
    probes.forEach(probe => { probe.events.length = 0 })

    const repeatedAssignment = await repositories.owner.setStageOperator(
      liveId,
      `${eventId}-stage-a`,
      unassignedStage.stageId,
      users.viewer.id,
      true,
      assigned.value.managementRevision,
      bigintRead.value.projectionVersion,
    )
    assert.equal(repeatedAssignment.ok, true)
    assert.equal(
      repeatedAssignment.value.managementRevision,
      (BigInt(assigned.value.managementRevision) + 1n).toString(),
    )
    await waitFor(
      () => probes.slice(0, 3).every(probe => probe.events.length >= 1),
      'Workspace members did not receive repeated operator receipt update.',
    )
    probes.forEach(probe => { probe.events.length = 0 })

    const absentRemoval = await repositories.owner.setStageOperator(
      liveId,
      `${eventId}-stage-a`,
      unassignedStage.stageId,
      users.editor.id,
      false,
      repeatedAssignment.value.managementRevision,
      bigintRead.value.projectionVersion,
    )
    assert.equal(absentRemoval.ok, true)
    assert.equal(
      absentRemoval.value.managementRevision,
      (BigInt(repeatedAssignment.value.managementRevision) + 1n).toString(),
    )
    await waitFor(
      () => probes.slice(0, 3).every(probe => probe.events.length >= 1),
      'Workspace members did not receive absent operator removal receipt update.',
    )
    probes.forEach(probe => { probe.events.length = 0 })
    const staleOperatorCas = await repositories.owner.setStageOperator(
      liveId,
      `${eventId}-stage-a`,
      unassignedStage.stageId,
      users.viewer.id,
      true,
      repeatedAssignment.value.managementRevision,
      bigintRead.value.projectionVersion,
    )
    assert.equal(staleOperatorCas.ok, false)
    assert.equal(staleOperatorCas.error.code, 'REVISION_CONFLICT')
    const afterOperatorReceipts = await repositories.owner.loadAuthorized(liveId)
    assert.equal(afterOperatorReceipts.ok, true)
    assert.equal(
      afterOperatorReceipts.value.managementRevision,
      absentRemoval.value.managementRevision,
    )
    assert.equal(afterOperatorReceipts.value.operators.some(operator =>
      operator.stageId === assigned.value.stageId &&
      operator.userId === users.viewer.id), true)

    const beforeStart = await repositories.owner.loadAuthorized(liveId)
    assert.equal(beforeStart.ok, true)
    const stageBeforeStart = beforeStart.value.stages.find(
      stage => stage.sourceStageId === `${eventId}-stage-a`,
    )
    const started = await repositories.viewer.startEntry(
      liveId,
      `${eventId}-stage-a`,
      stageBeforeStart.stageId,
      `${eventId}-item-a`,
      stageBeforeStart.entries.find(entry =>
        entry.sourceScheduleItemId === `${eventId}-item-a`).position,
      stageBeforeStart.revision,
      beforeStart.value.projectionVersion,
    )
    assert.equal(started.ok, true)
    await waitFor(
      () => probes.slice(0, 3).every(probe => probe.events.length >= 1),
      'Workspace members did not receive start Realtime update.',
    )
    await sleep(500)
    assert.equal(probes[3].events.length, 0)
    assert.equal(probes[4].events.length, 0)
    probes.slice(0, 3).forEach(probe => probe.events.forEach(assertRealtimePayload))
    probes.forEach(probe => { probe.events.length = 0 })

    const afterStart = await repositories.owner.loadAuthorized(liveId)
    assert.equal(afterStart.ok, true)
    const stageAfterStart = afterStart.value.stages.find(
      stage => stage.sourceStageId === `${eventId}-stage-a`,
    )
    assert.equal(stageAfterStart.progressStatus, 'in_progress')
    const ended = await repositories.viewer.endEntry(
      liveId,
      `${eventId}-stage-a`,
      stageAfterStart.stageId,
      `${eventId}-item-a`,
      stageAfterStart.entries.find(entry =>
        entry.sourceScheduleItemId === `${eventId}-item-a`).position,
      stageAfterStart.revision,
      afterStart.value.projectionVersion,
    )
    assert.equal(ended.ok, true)
    await waitFor(
      () => probes.slice(0, 3).every(probe => probe.events.length >= 1),
      'Workspace members did not receive end Realtime update.',
    )
    await sleep(500)
    assert.equal(probes[3].events.length, 0)
    assert.equal(probes[4].events.length, 0)

    assert.equal((await repositories.owner.loadPublic(publicId)).ok, false)
    await runPsqlCommand(
      "update public.live_timetables set public_view_enabled=true where id=current_setting('live_smoke.live_id')::uuid and workspace_id=current_setting('live_smoke.workspace_id')::uuid",
      { live_id: liveId, workspace_id: workspaceId },
      'enable disposable public-view fixture',
    )
    const publicAnon = await createSupabaseLiveTimetableRepository(
      createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ).loadPublic(publicId)
    const publicViewer = await repositories.viewer.loadPublic(publicId)
    assert.equal(publicAnon.ok, true)
    assert.equal(publicViewer.ok, true)
    assert.deepEqual(publicAnon.value, publicViewer.value)
    const publicJson = JSON.stringify(publicAnon.value)
    for (const forbidden of [
      workspaceId, liveId, eventId, users.owner.id, users.editor.id,
      users.viewer.id,
      createdValue.sourceSnapshotFingerprint, 'Private break title',
      'sourceStageId', 'sourceScheduleItemId', 'startedBy', 'endedBy',
    ]) assert.equal(publicJson.includes(forbidden), false)

    const pageAfter = await sessions.owner.client.rpc(
      'load_cloud_events_page_authorized',
      {
        p_workspace_id: workspaceId,
        p_after_event_id: null,
        p_page_size: 100,
        p_expected_generation: cloudBefore.generation,
      },
    )
    assert.equal(pageAfter.error, null)
    assert.equal(pageAfter.data.workspace_generation, cloudBefore.generation)
    assert.equal(pageAfter.data.rows[0].revision, cloudBefore.revision)
    assert.deepEqual(pageAfter.data.rows[0].event_snapshot, cloudBefore.snapshot)

    const unpublished = await repositories.owner.setPublication(
      liveId, absentRemoval.value.managementRevision, false,
    )
    assert.equal(unpublished.ok, true)
    assert.equal((await repositories.owner.loadPublic(publicId)).ok, false)
    const republished = await repositories.owner.setPublication(
      liveId, unpublished.value.managementRevision, true,
    )
    assert.equal(republished.ok, true)

    probes.forEach(probe => { probe.events.length = 0 })
    await runPsqlCommand(
      "delete from public.live_timetables where id=current_setting('live_smoke.live_id')::uuid and workspace_id=current_setting('live_smoke.workspace_id')::uuid and event_id=current_setting('live_smoke.event_id')",
      { live_id: liveId, workspace_id: workspaceId, event_id: eventId },
    )
    await sleep(1_000)
    assert.equal(probes[3].events.length, 0)
    assert.equal(probes[4].events.length, 0)
    const memberDeleteEvents = probes.slice(0, 3)
      .flatMap(probe => probe.events)
      .filter(event => event.eventType === 'DELETE').length

    successReport = {
      ok: true,
      authHttp: 'passed',
      repositoryParser: 'passed',
      realtimeUpdateAuthorization: 'passed',
      realtimeRevokedViewerAuthorization: 'passed',
      realtimeDeleteMemberEventsObserved: memberDeleteEvents,
      realtimeNegativeStatuses: {
        outsider: settled[3],
        anon: settled[4],
      },
    }
  } finally {
    await Promise.allSettled(probes.map(async (probe) => {
      await probe.channel.unsubscribe()
      await probe.client.removeAllChannels()
      probe.client.realtime.disconnect()
    }))
    let databaseCleaned = !fixtureCreated
    if (fixtureCreated) {
      try {
        const users = createdUserIds
        await runPsqlFile(cleanupSqlPath, {
          workspace_id: workspaceId,
          workspace_name: workspaceName,
          event_id: eventId,
          owner_id: users[0],
          editor_id: users[1],
          viewer_id: users[2],
        })
        databaseCleaned = true
      } catch {
        databaseCleaned = false
      }
    }
    if (databaseCleaned) {
      await deleteLiveSmokeAuthUsers(admin, createdUserIds)
    } else {
      throw new Error('Dedicated fixture cleanup failed; Auth users were preserved for inspection.')
    }
  }

  console.log(JSON.stringify(successReport))
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : 'Live smoke failed.')
  process.exitCode = 1
})

