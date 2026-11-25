import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'
import { createSupabaseCloudEventRepository } from '../src/cloud/cloudEventRepository.ts'
import { createSupabaseLiveTimetableRepository } from '../src/live/liveTimetableRepository.ts'
import { isMatchingLiveRealtimePayload, LIVE_TIMETABLE_REALTIME_COLUMNS } from '../src/live/liveTimetableSync.ts'
import { exchangeMagicLink, getAuthenticatedUserId, readHiddenMagicLink } from './cloudV1HostedAuthzSmoke.mjs'
import { assertUnassignedViewerTransitionDenied } from './liveTimetableFoundationSmokeAuthorization.mjs'

const project = 'sqrbioyjhxoehbmacujf'
const origin = `https://${project}.supabase.co`
const workspace = 'e73db27b-f32b-4310-8498-6a21269bd065'
const deployment = 'dpl_8APhCgjsrgn5AAs9fLtS9DRJ5NzN'
const columns = [...LIVE_TIMETABLE_REALTIME_COLUMNS]
const realtimeDeadlineMs = 12000
const httpObservation = new AsyncLocalStorage()
const repositoryErrorCodes = new Set([
  'ACCESS_DENIED', 'AUTHENTICATION_REQUIRED', 'CONFIGURATION_ERROR', 'EVENT_NOT_FOUND',
  'INVALID_ARGUMENT', 'INVALID_RESPONSE', 'INVALID_SOURCE', 'LIVE_ALREADY_EXISTS',
  'LIVE_NOT_FOUND', 'NOT_FOUND', 'REVISION_CONFLICT', 'STATE_CONFLICT', 'SUPABASE_ERROR',
])

function fixture(eventId) {
  const day = `${eventId}-day`, stage = `${eventId}-stage`, band = `${eventId}-band`, entry = `${eventId}-entry`
  const result = createCloudEventSnapshot({
    members: [], bands: [], events: [{ id: eventId, name: '【検証用】Hosted Live evidence', timeZone: 'Asia/Tokyo',
      validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 }, performanceSlotMinutes: [10] }],
    eventDays: [{ id: day, eventId, date: '2026-11-24', order: 0 }],
    stages: [{ id: stage, eventDayId: day, name: 'Evidence stage', order: 0, plannedStartTime: '10:00' }],
    sections: [], eventMembers: [], eventMemberDays: [],
    eventBands: [{ id: band, eventId, eventDayId: day, name: 'Evidence band', memberIds: [], durationMinutes: 10 }],
    scheduleItems: [{ id: entry, stageId: stage, order: 0, kind: 'performance', eventBandId: band }],
    paAssignments: [], dutyTypes: [], dutyAssignments: [], timetableLocks: [], timetableOrderConstraints: [],
  }, eventId)
  assert.equal(result.ok, true)
  return { snapshot: result.snapshot, stage, entry }
}

const checkedFetch = async (url, options = {}, transport = fetch) => {
  assert.equal(new URL(url).origin, origin)
  const deadline = AbortSignal.timeout(15000)
  const observation = httpObservation.getStore()
  if (observation) observation.requested = true
  const response = await transport(url, { ...options, redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline })
  if (observation) observation.status = response.status
  return response
}

function clientFor(createClient, key, token, transport = fetch) {
  return createClient(origin, key, {
    global: { fetch: (url, options) => checkedFetch(url, options, transport) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(token ? { accessToken: async () => token } : {}),
  })
}

function repositoryFailure(result) {
  if (result.ok) return null
  return repositoryErrorCodes.has(result.error?.code) ? result.error.code : 'REPOSITORY_ERROR'
}

async function apiOutcome(call, failure) {
  const observation = {}
  let reason
  try {
    const result = await httpObservation.run(observation, call)
    reason = failure(result, observation.status)
    if (!reason) return { value: result.value }
  } catch {
    reason = 'CHECK_FAILED'
  }
  if (observation.requested && observation.status === undefined) reason = 'HTTP_NO_RESPONSE'
  return { reason, status: observation.status }
}

function stopAt(step, reason, status, report = console.log) {
  report(`DIAGNOSTIC STEP=${step} HTTP=${status ?? 'NONE'} REASON=${reason}`)
  throw new Error('HOSTED_API_CHECK_FAILED')
}

async function checkApi(step, call, failure = repositoryFailure, report = console.log) {
  const result = await apiOutcome(call, failure)
  if (result.reason) stopAt(step, result.reason, result.status, report)
  return result.value
}

function fixtureReadFailure(result, eventId, role) {
  return repositoryFailure(result) ??
    (result.value.workspaceId !== workspace || result.value.eventId !== eventId ? 'FIXTURE_ID_MISMATCH' :
      result.value.role !== role ? 'UNEXPECTED_FIXTURE_ROLE' : null)
}

function checkAnonymousUnavailable(step, anonymous, publicId, report) {
  return checkApi(step, () => anonymous.loadPublic(publicId), (result, status) => {
    if (result.ok) return 'ANONYMOUS_READ_SUCCEEDED'
    // The public RPC returns JSON null when the published projection is unavailable.
    if (result.error?.code === 'NOT_FOUND') return status === 200 ? null : 'EXPECTED_HTTP_200'
    return repositoryFailure(result)
  }, report)
}

async function signIn(createClient, role, key) {
  const target = { origin, publishableKey: key }
  const link = await readHiddenMagicLink(`Paste the ${role} Magic Link (hidden): `)
  const token = await exchangeMagicLink(checkedFetch, target, link)
  const userId = await getAuthenticatedUserId(checkedFetch, target, token)
  const client = clientFor(createClient, key, token)
  const { data, error } = await client.from('workspace_members').select('role')
    .eq('workspace_id', workspace).eq('user_id', userId).single()
  assert.equal(error, null)
  assert.equal(data.role, role)
  await client.realtime.setAuth(token)
  return { userId, client, repo: createSupabaseLiveTimetableRepository(client) }
}

function watchRealtime(owner, liveId, stageId, eventId, deadlineMs = realtimeDeadlineMs) {
  let joined = false, subscribedToPostgres = false, connectionFailure, observation
  let settle, timer
  const ready = new Promise(resolve => { settle = resolve })
  const finishReadiness = reason => {
    clearTimeout(timer)
    settle(reason)
  }
  const failConnection = reason => {
    connectionFailure ||= reason
    finishReadiness(connectionFailure)
  }
  const channel = owner.client.channel(`hosted-live-evidence-${randomUUID()}`)
    .on('system', {}, payload => {
      if (payload?.extension !== 'postgres_changes') return
      if (payload.status === 'error') failConnection('POSTGRES_CHANGES_ERROR')
      if (payload.status === 'ok' && payload.message === 'Subscribed to PostgreSQL') {
        subscribedToPostgres = true
        if (joined) finishReadiness(null)
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_timetable_stages',
      filter: `workspace_id=eq.${workspace}`, select: columns }, async payload => {
      const current = observation
      if (!current || current.received) return
      const row = payload?.new
      if (row?.live_timetable_id !== liveId || row?.id !== stageId || row?.workspace_id !== workspace) {
        current.otherTarget = true
        return
      }
      if (String(row.revision) !== current.revision && Object.hasOwn(row, 'revision')) {
        current.otherRevision = true
        return
      }
      current.received = true
      if (payload.eventType !== 'UPDATE' || payload.schema !== 'public' || payload.table !== 'live_timetable_stages') {
        current.validationFailure = 'UNEXPECTED_NOTICE_ENVELOPE'
        return
      }
      if (!isMatchingLiveRealtimePayload(row, workspace, liveId)) {
        current.validationFailure = 'INVALID_SEVEN_COLUMN_ROW'
        return
      }
      if (String(row.projection_version) !== current.projectionVersion || row.progress_status !== current.progressStatus) {
        current.validationFailure = 'NOTICE_STATE_MISMATCH'
        return
      }
      current.read = await apiOutcome(() => owner.repo.loadAuthorized(liveId), result => {
        const failure = fixtureReadFailure(result, eventId, 'owner')
        if (failure) return failure
        const stage = result.value.stages.find(value => value.stageId === stageId)
        return stage?.revision === current.revision && stage.progressStatus === row.progress_status &&
          result.value.projectionVersion === current.projectionVersion ? null : 'NOTICE_AUTHORIZED_STATE_MISMATCH'
      })
    })
  timer = setTimeout(() => finishReadiness(joined ? 'POSTGRES_CHANGES_NOT_READY' : 'CHANNEL_JOIN_TIMEOUT'), deadlineMs)
  try {
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        joined = true
        if (subscribedToPostgres) finishReadiness(null)
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        failConnection(`CHANNEL_STATUS_${status}`)
      }
    })
  } catch {
    failConnection('CHANNEL_SUBSCRIBE_FAILED')
  }
  return {
    channel, ready,
    connectionFailure: () => connectionFailure,
    observe(revision, projectionVersion, progressStatus) {
      observation = { revision, projectionVersion, progressStatus }
      return observation
    },
    stopObserving() {
      observation = undefined
    },
  }
}

async function waitForNotice(watcher, observation, step, deadlineMs = realtimeDeadlineMs, report = console.log) {
  // The only read counted here is initiated by the matching notification.
  const end = Date.now() + deadlineMs
  while (!observation.validationFailure && !observation.read && !watcher.connectionFailure() && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, end - Date.now()))))
  }
  if (observation.validationFailure) stopAt(`${step}.NOTICE_PAYLOAD`, observation.validationFailure, undefined, report)
  if (observation.read?.reason) {
    stopAt(`${step}.NOTICE_AUTHORIZED_READ`, observation.read.reason, observation.read.status, report)
  }
  if (observation.read) return
  const disconnected = watcher.connectionFailure()
  if (disconnected) stopAt(`${step}.NOTICE_WAIT`, disconnected, undefined, report)
  if (observation.received) stopAt(`${step}.NOTICE_AUTHORIZED_READ`, 'NOTICE_READ_TIMEOUT', undefined, report)
  const reason = observation.otherRevision ? 'NO_MATCHING_NOTICE_REVISION' :
    observation.otherTarget ? 'NO_MATCHING_NOTICE_TARGET' : 'NO_NOTICE'
  stopAt(`${step}.NOTICE_WAIT`, reason, undefined, report)
}

function hasTestAssignment(value, target) {
  return value.operators.some(operator => operator.stageId === target.stageId && operator.userId === target.userId)
}

function matchesAssignmentTarget(value, sourceStageId, target) {
  return value.projectionVersion === target.projectionVersion &&
    value.stages.some(stage => stage.stageId === target.stageId && stage.sourceStageId === sourceStageId)
}

async function finalizeFixture({ owner, anonymous, eventId, liveId, publicId, sourceStageId, target, report = console.log }) {
  // Each failed operation reports its own reason. Continue the independent cleanup checks.
  async function attempt(action) {
    try {
      return await action()
    } catch {
      return undefined
    }
  }
  if (!liveId) {
    report('FINAL LIVE_ID_UNCONFIRMED')
    report('FINAL TEST_ASSIGNMENT_UNCONFIRMED')
    return false
  }
  const read = step => checkApi(step, () => owner.repo.loadAuthorized(liveId),
    result => fixtureReadFailure(result, eventId, 'owner'), report)
  const before = await attempt(() => read('FINAL.LIVE_OFF_READ'))
  if (before?.isPublished) {
    await attempt(() => checkApi('FINAL.SET_OFF',
      () => owner.repo.setPublication(liveId, before.managementRevision, false), repositoryFailure, report))
  }

  if (target) {
    const current = await attempt(() => read('FINAL.ASSIGNMENT_READ'))
    if (current && hasTestAssignment(current, target)) {
      await attempt(() => {
        if (!matchesAssignmentTarget(current, sourceStageId, target)) {
          stopAt('FINAL.REMOVE_TEST_ASSIGNMENT', 'ASSIGNMENT_TARGET_CHANGED', undefined, report)
        }
        return checkApi('FINAL.REMOVE_TEST_ASSIGNMENT', () => owner.repo.setStageOperator(liveId, sourceStageId,
          target.stageId, target.userId, false, current.managementRevision, current.projectionVersion),
        repositoryFailure, report)
      })
    }
  }

  const after = await attempt(() => read('FINAL.VERIFY_OWNER_STATE'))
  const confirmedPublicId = after?.publicId ?? before?.publicId ?? publicId
  const anonymousDenied = confirmedPublicId && await attempt(async () => {
    await checkAnonymousUnavailable('FINAL.ANONYMOUS_READ', anonymous, confirmedPublicId, report)
    return true
  })
  const off = after?.isPublished === false
  const assignmentStatus = !after || (target && !matchesAssignmentTarget(after, sourceStageId, target)) ? 'UNCONFIRMED' :
    !target ? 'NOT_ATTEMPTED' : hasTestAssignment(after, target) ? 'REMAINS' : 'ABSENT'
  report(`FINAL ${off ? 'LIVE_OFF' : after ? 'LIVE_ON' : 'OFF_UNCONFIRMED'} ` +
    `${anonymousDenied ? 'ANONYMOUS_READ_DENIED' : 'ANONYMOUS_READ_UNCONFIRMED'} ` +
    `OPERATORS=${after?.operators.length ?? 'UNCONFIRMED'}`)
  report(`FINAL TEST_ASSIGNMENT_${assignmentStatus}`)
  return off && anonymousDenied === true && after.operators.length === 0 &&
    (assignmentStatus === 'ABSENT' || assignmentStatus === 'NOT_ATTEMPTED')
}

async function smoke() {
  const { createClient } = await import('@supabase/supabase-js')
  let stage = 'AUTH', owner, watcher, liveId, publicId, operatorTarget
  let verifiedCleanup = false, passed = false
  const eventId = `hosted-live-evidence-${randomUUID()}`
  const newEvent = fixture(eventId)
  const key = await readHiddenMagicLink('Paste the dedicated Project publishable key (hidden): ')
  assert.match(key, /^sb_publishable_[A-Za-z0-9_-]+$/)
  const anonymous = createSupabaseLiveTimetableRepository(clientFor(createClient, key))
  try {
    owner = await signIn(createClient, 'owner', key)
    const viewer = await signIn(createClient, 'viewer', key)
    assert.notEqual(owner.userId, viewer.userId)
    const read = step => checkApi(`${stage}.${step}`, () => owner.repo.loadAuthorized(liveId),
      result => fixtureReadFailure(result, eventId, 'owner'))
    const findStage = value => value.stages.find(s => s.sourceStageId === newEvent.stage)
    const setOperator = async assign => {
      const step = `${stage}.${assign ? 'ASSIGN_VIEWER' : 'REMOVE_VIEWER'}`
      const value = await read('OWNER_READ_FOR_ASSIGNMENT')
      const selected = findStage(value)
      if (selected?.stageId !== stageId || (operatorTarget && value.projectionVersion !== operatorTarget.projectionVersion)) {
        stopAt(step, 'ASSIGNMENT_TARGET_CHANGED')
      }
      if (assign) {
        const target = { stageId, userId: viewer.userId, projectionVersion: value.projectionVersion }
        if (hasTestAssignment(value, target)) stopAt(step, 'ASSIGNMENT_ALREADY_PRESENT')
        // A failed or lost RPC response can still leave the requested assignment in the database.
        operatorTarget = target
      }
      await checkApi(step, () => owner.repo.setStageOperator(liveId, newEvent.stage, stageId,
        viewer.userId, assign, value.managementRevision, value.projectionVersion))
    }

    stage = 'SAVE_NEW_FIXTURE'
    console.log(`FIXTURE_EVENT_ID: ${eventId}`)
    const saved = await createSupabaseCloudEventRepository(owner.client).saveEvent(workspace, newEvent.snapshot)
    assert.equal(saved.ok, true)
    assert.equal(String(saved.value.revision), '1')

    stage = 'CREATE_OWNER_PROJECTION'
    const created = await checkApi('CREATE_OWNER_PROJECTION.RESPONSE', () => owner.repo.createProjection({
      workspaceId: workspace, eventId, expectedSourceRevision: '1', mode: 'create', expectedManagementRevision: null,
    }))
    liveId = created.liveId
    publicId = created.publicId
    // createProjection validates isPublished=false before returning the DTO.
    await checkAnonymousUnavailable('CREATE_OWNER_PROJECTION.ANONYMOUS_READ', anonymous, publicId)
    console.log('PASS OWNER_SAVED_EVENT_PROJECTION')

    stage = 'UNASSIGNED_START'
    const start = await read('OWNER_READ')
    assert.equal((await owner.repo.setPublication(liveId, start.managementRevision, true)).ok, true)
    await checkAnonymousUnavailable('UNASSIGNED_START.ANONYMOUS_READ', anonymous, publicId)
    const denial = { ownerRepository: owner.repo, viewerRepository: viewer.repo, viewerId: viewer.userId,
      liveId, sourceStageId: newEvent.stage, sourceScheduleItemId: newEvent.entry }
    await assertUnassignedViewerTransitionDenied({ ...denial, operation: 'start' })
    console.log('PASS UNASSIGNED_START_ACCESS_DENIED_UNCHANGED')

    stage = 'REALTIME_AND_ASSIGNED_VIEWER_START'
    const stageId = findStage(await read('OWNER_READ_TARGET'))?.stageId
    if (!stageId) stopAt(`${stage}.OWNER_READ_TARGET`, 'FIXTURE_STAGE_NOT_FOUND')
    try {
      watcher = watchRealtime(owner, liveId, stageId, eventId)
    } catch {
      stopAt(`${stage}.SUBSCRIBE`, 'CHANNEL_SETUP_FAILED')
    }
    const subscriptionFailure = await watcher.ready
    if (subscriptionFailure) stopAt(`${stage}.SUBSCRIBE`, subscriptionFailure)
    await setOperator(true)
    async function transition(operation) {
      const current = await checkApi(`${stage}.VIEWER_READ`, () => viewer.repo.loadAuthorized(liveId), result => {
        const failure = fixtureReadFailure(result, eventId, 'viewer')
        if (failure) return failure
        const selected = findStage(result.value)
        if (selected?.stageId !== stageId || result.value.projectionVersion !== operatorTarget.projectionVersion) {
          return 'ASSIGNMENT_TARGET_CHANGED'
        }
        if (!selected.canOperate) return 'VIEWER_CANNOT_OPERATE'
        return selected.entries.some(entry => entry.sourceScheduleItemId === newEvent.entry) ? null : 'FIXTURE_ENTRY_NOT_FOUND'
      })
      const selected = findStage(current)
      const entry = selected.entries.find(e => e.sourceScheduleItemId === newEvent.entry)
      const disconnected = watcher.connectionFailure()
      if (disconnected) stopAt(`${stage}.SUBSCRIBE`, disconnected)
      const starting = operation === 'startEntry'
      const expected = starting ? 'in_progress' : 'completed'
      const nextRevision = (BigInt(selected.revision) + 1n).toString()
      // Arm before the RPC: an UPDATE can arrive before its HTTP response.
      const notice = watcher.observe(nextRevision, current.projectionVersion, expected)
      try {
        const mutation = await checkApi(`${stage}.VIEWER_${starting ? 'START' : 'END'}_RPC`,
          () => viewer.repo[operation](liveId, newEvent.stage, stageId, newEvent.entry,
            entry.position, selected.revision, current.projectionVersion))
        await checkApi(`${stage}.OWNER_READ_AFTER_TRANSITION`, () => owner.repo.loadAuthorized(liveId), result => {
          const failure = fixtureReadFailure(result, eventId, 'owner')
          if (failure) return failure
          const after = findStage(result.value)
          const updatedEntry = after?.entries.find(value => value.sourceScheduleItemId === newEvent.entry)
          return after?.stageId === stageId && after.revision === mutation.stageRevision &&
            result.value.projectionVersion === current.projectionVersion && updatedEntry?.status === expected &&
            (starting ? updatedEntry.startedBy : updatedEntry.endedBy) === viewer.userId ? null : 'TRANSITION_STATE_MISMATCH'
        })
        await waitForNotice(watcher, notice, stage)
      } finally {
        watcher.stopObserving()
      }
    }
    await transition('startEntry')
    console.log('PASS ASSIGNED_VIEWER_START_REALTIME_7_COLUMNS_AUTHORIZED_READ')

    stage = 'UNASSIGNED_END'
    await setOperator(false)
    await assertUnassignedViewerTransitionDenied({ ...denial, operation: 'end' })
    console.log('PASS UNASSIGNED_END_ACCESS_DENIED_UNCHANGED')

    stage = 'REALTIME_AND_ASSIGNED_VIEWER_END'
    await setOperator(true)
    await transition('endEntry')
    console.log('PASS ASSIGNED_VIEWER_END_REALTIME_7_COLUMNS_AUTHORIZED_READ')
    passed = true
  } catch {
    console.log(`INCOMPLETE AT ${stage}`)
  } finally {
    if (!liveId && owner && stage === 'CREATE_OWNER_PROJECTION') {
      try {
        const discovered = await checkApi('FINAL.DISCOVER', () => owner.repo.findForEvent(workspace, eventId),
          result => repositoryFailure(result) ?? (result.value.liveId ? null : 'PROJECTION_ID_NOT_FOUND'))
        liveId = discovered.liveId
      } catch {
        // The discovery check already reported the reason.
      }
    }
    verifiedCleanup = await finalizeFixture({ owner, anonymous, eventId, liveId, publicId,
      sourceStageId: newEvent.stage, target: operatorTarget })
    if (watcher) {
      try {
        if (await owner.client.removeChannel(watcher.channel) !== 'ok') throw new Error('REMOVE_CHANNEL_FAILED')
      } catch {
        console.log('DIAGNOSTIC STEP=FINAL.REMOVE_CHANNEL HTTP=NONE REASON=CHANNEL_REMOVAL_UNCONFIRMED')
        verifiedCleanup = false
      }
    }
  }
  if (passed && verifiedCleanup) console.log('COMPLETED HOSTED LIVE EVIDENCE')
  else process.exitCode = 2
}

async function testAnonymousRead() {
  const publicId = '10000000-0000-0000-0000-000000000098'
  const createTestClient = (_origin, _key, { global }) => ({
    async rpc(name, args) {
      assert.equal(name, 'load_live_timetable_public')
      assert.deepEqual(args, { p_public_id: publicId })
      const response = await global.fetch(`${origin}/rest/v1/rpc/${name}`)
      const body = response.status === 204 ? null : await response.json()
      return response.ok ? { data: body, error: null } : { data: null, error: body }
    },
  })
  const anonymousFor = transport => createSupabaseLiveTimetableRepository(
    clientFor(createTestClient, 'offline-key', undefined, transport),
  )
  const unavailable = anonymousFor(async () => Response.json(null))
  const oldResult = await unavailable.loadPublic(publicId)
  assert.equal(oldResult.error.code, 'NOT_FOUND')
  assert.throws(() => assert.equal(oldResult.error.code, 'LIVE_NOT_FOUND'), { code: 'ERR_ASSERTION' })
  const steps = ['CREATE_OWNER_PROJECTION.ANONYMOUS_READ', 'UNASSIGNED_START.ANONYMOUS_READ', 'FINAL.ANONYMOUS_READ']
  const diagnostics = []
  const report = line => diagnostics.push(line)
  for (const step of steps) await checkAnonymousUnavailable(step, unavailable, publicId, report)
  assert.deepEqual(diagnostics, [])

  const step = 'FINAL.ANONYMOUS_READ'
  const failures = [
    [async () => Response.json({ code: 'P0002', message: 'offline private body' }, { status: 404 }), '404', 'LIVE_NOT_FOUND'],
    [async () => Response.json({ code: '42501' }, { status: 403 }), '403', 'ACCESS_DENIED'],
    [async () => new Response(null, { status: 204 }), '204', 'EXPECTED_HTTP_200'],
    [async () => Response.json({ malformed: true }), '200', 'INVALID_RESPONSE'],
    [async () => { throw new Error('offline private exception') }, 'NONE', 'HTTP_NO_RESPONSE'],
  ]
  for (const [transport, status, reason] of failures) {
    await assert.rejects(checkAnonymousUnavailable(step, anonymousFor(transport), publicId, report),
      { message: 'HOSTED_API_CHECK_FAILED' })
    assert.equal(diagnostics.pop(), `DIAGNOSTIC STEP=${step} HTTP=${status} REASON=${reason}`)
  }
  await assert.rejects(checkAnonymousUnavailable(step, { loadPublic: async () => ({ ok: true }) }, publicId, report),
    { message: 'HOSTED_API_CHECK_FAILED' })
  assert.equal(diagnostics.pop(), `DIAGNOSTIC STEP=${step} HTTP=NONE REASON=ANONYMOUS_READ_SUCCEEDED`)
  assert.deepEqual(diagnostics, [])
  console.log('PASS HOSTED LIVE ANONYMOUS READ CONTRACT AND DIAGNOSTICS (offline)')
}

async function testRealtime() {
  const eventId = 'fixture-event', stageId = 'fixture-stage', liveId = 'fixture-live'
  const handlers = new Map()
  let onStatus, reads = 0, readFailure, readRevision = '5'
  const owner = {
    client: { channel: () => ({
      on(event, options, handle) {
        if (event === 'postgres_changes') assert.deepEqual(options.select, columns)
        handlers.set(event, handle)
        return this
      },
      subscribe(handle) { onStatus = handle; return this },
    }) },
    repo: {
      async loadAuthorized() {
        reads += 1
        if (readFailure) {
          await checkedFetch(`${origin}/rest/v1/rpc/load_live_timetable_authorized`, {},
            async () => new Response(null, { status: 403 }))
          return { ok: false, error: { code: 'ACCESS_DENIED', message: 'offline private reason' } }
        }
        return { ok: true, value: { role: 'owner', workspaceId: workspace, eventId, projectionVersion: '3',
          stages: [{ stageId, revision: readRevision, progressStatus: 'in_progress' }] } }
      },
    },
  }
  const earlyJoin = watchRealtime(owner, liveId, stageId, eventId, 5)
  onStatus('SUBSCRIBED')
  handlers.get('system')({ extension: 'system', status: 'ok' })
  assert.equal(await earlyJoin.ready, 'POSTGRES_CHANGES_NOT_READY')

  const badSubscription = watchRealtime(owner, liveId, stageId, eventId)
  onStatus('SUBSCRIBED')
  handlers.get('system')({ extension: 'postgres_changes', status: 'error', message: 'offline private reason' })
  assert.equal(await badSubscription.ready, 'POSTGRES_CHANGES_ERROR')

  const watcher = watchRealtime(owner, liveId, stageId, eventId)
  onStatus('SUBSCRIBED')
  handlers.get('system')({ extension: 'postgres_changes', status: 'ok', message: 'Subscribed to PostgreSQL' })
  assert.equal(await watcher.ready, null)
  assert.equal(reads, 0)
  const row = { id: stageId, workspace_id: workspace, live_timetable_id: liveId,
    projection_version: 3, revision: 5, progress_status: 'in_progress', updated_at: '2026-11-24T00:00:00Z' }
  const notify = newRow => handlers.get('postgres_changes')({
    eventType: 'UPDATE', schema: 'public', table: 'live_timetable_stages', new: newRow,
  })
  const arm = () => watcher.observe('5', '3', 'in_progress')
  const step = 'REALTIME_AND_ASSIGNED_VIEWER_START'
  const matching = arm()
  await notify({ ...row, revision: 4 })
  await notify({ ...row, id: 'other-stage' })
  await notify(row)
  await waitForNotice(watcher, matching, step, 0)
  watcher.stopObserving()
  assert.equal(reads, 1)
  await notify(row)
  const cases = [
    [null, 'NOTICE_WAIT', 'NONE', 'NO_NOTICE'],
    [{ ...row, id: 'other-stage' }, 'NOTICE_WAIT', 'NONE', 'NO_MATCHING_NOTICE_TARGET'],
    [{ ...row, revision: 4 }, 'NOTICE_WAIT', 'NONE', 'NO_MATCHING_NOTICE_REVISION'],
    [{ ...row, extraColumn: true }, 'NOTICE_PAYLOAD', 'NONE', 'INVALID_SEVEN_COLUMN_ROW'],
    [{ ...row, progress_status: 'completed' }, 'NOTICE_PAYLOAD', 'NONE', 'NOTICE_STATE_MISMATCH'],
    [row, 'NOTICE_AUTHORIZED_READ', '403', 'ACCESS_DENIED'],
    [row, 'NOTICE_AUTHORIZED_READ', 'NONE', 'NOTICE_AUTHORIZED_STATE_MISMATCH'],
  ]
  for (const [newRow, substep, status, reason] of cases) {
    const pending = arm()
    readFailure = reason === 'ACCESS_DENIED'
    readRevision = reason === 'NOTICE_AUTHORIZED_STATE_MISMATCH' ? '4' : '5'
    if (newRow) await notify(newRow)
    const lines = []
    await assert.rejects(waitForNotice(watcher, pending, step, 0, line => lines.push(line)),
      { message: 'HOSTED_API_CHECK_FAILED' })
    assert.deepEqual(lines, [`DIAGNOSTIC STEP=${step}.${substep} HTTP=${status} REASON=${reason}`])
    watcher.stopObserving()
  }
  assert.equal(reads, 3)
  console.log('PASS HOSTED LIVE FIXTURE AND REALTIME CALLBACK (offline)')
}

async function testFinalization() {
  const eventId = 'fixture-event', liveId = 'fixture-live', sourceStageId = 'source-stage', publicId = 'fixture-public'
  const target = { stageId: 'stage-id', userId: 'fixture-user', projectionVersion: '3' }
  const unrelated = { stageId: target.stageId, userId: 'unrelated-user' }
  for (const mode of ['normal', 'already-clear', 'off-error', 'removal-error', 'unrelated', 'wrong-event', 'wrong-projection']) {
    const calls = [], lines = []
    const state = {
      eventId: mode === 'wrong-event' ? 'other-event' : eventId, role: 'owner', workspaceId: workspace, publicId,
      managementRevision: '10', projectionVersion: mode === 'wrong-projection' ? '4' : '3', isPublished: true,
      stages: [{ stageId: target.stageId, sourceStageId }],
      operators: mode === 'already-clear' ? [] : mode === 'unrelated' ? [target, unrelated] : [target],
    }
    const owner = { repo: {
      async loadAuthorized() { return { ok: true, value: structuredClone(state) } },
      async setPublication(...args) {
        calls.push(args)
        if (mode === 'off-error') return { ok: false, error: { code: 'REVISION_CONFLICT' } }
        state.isPublished = false
        state.managementRevision = '11'
        return { ok: true }
      },
      async setStageOperator(...args) {
        calls.push(args)
        if (mode === 'removal-error') return { ok: false, error: { code: 'REVISION_CONFLICT' } }
        state.operators = state.operators.filter(operator => operator !== target)
        state.managementRevision = '12'
        return { ok: true }
      },
    } }
    const anonymous = { async loadPublic() {
      await checkedFetch(`${origin}/rest/v1/rpc/load_live_timetable_public`, {}, async () => Response.json(null))
      return { ok: false, error: { code: 'NOT_FOUND' } }
    } }
    const verified = await finalizeFixture({ owner, anonymous, eventId, liveId, publicId, sourceStageId,
      target, report: line => lines.push(line) })
    assert.equal(verified, ['normal', 'already-clear'].includes(mode))
    if (mode === 'wrong-event') {
      assert.deepEqual(calls, [])
      assert.ok(lines.includes('FINAL TEST_ASSIGNMENT_UNCONFIRMED'))
      continue
    }
    assert.deepEqual(calls[0], [liveId, '10', false])
    if (['wrong-projection', 'already-clear'].includes(mode)) assert.equal(calls.length, 1)
    else assert.deepEqual(calls[1], [liveId, sourceStageId, target.stageId, target.userId, false,
      mode === 'off-error' ? '10' : '11', '3'])
    const summary = `FINAL ${mode === 'off-error' ? 'LIVE_ON' : 'LIVE_OFF'} ANONYMOUS_READ_DENIED OPERATORS=`
    assert.ok(lines.includes(summary + (['removal-error', 'unrelated', 'wrong-projection'].includes(mode) ? 1 : 0)))
    const expected = mode === 'removal-error' ? 'REMAINS' : mode === 'wrong-projection' ? 'UNCONFIRMED' : 'ABSENT'
    assert.ok(lines.includes(`FINAL TEST_ASSIGNMENT_${expected}`))
  }
  console.log('PASS HOSTED LIVE FIXTURE FINALIZATION AND REVISION CONTROL (offline)')
}

async function selfTest() {
  assert.equal(fixture('hosted-live-evidence-self-test').snapshot.appState.events.length, 1)
  await testAnonymousRead()
  await testRealtime()
  await testFinalization()
}

const args = process.argv.slice(2)
try {
  if (args.length === 1 && args[0] === '--self-test') {
    await selfTest()
  } else if (args.length === 1 && args[0] === '--plan') {
    console.log(`PLAN ONLY deployment=${deployment} project=${project} workspace=${workspace}`)
  } else if (JSON.stringify(args) === JSON.stringify(['--run', '--confirm-deployment', deployment, '--confirm-preview-project', project])) {
    await smoke()
  } else {
    console.error('Use --plan, --self-test, or the exact confirmed deployment and Preview Project arguments.')
    process.exitCode = 2
  }
} catch {
  console.error('INCOMPLETE: Hosted Live evidence could not finish safely.')
  process.exitCode = 2
}
