import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'
import {
  handleLiveTimetableProjectionRequest,
} from '../src/live/liveTimetableProjectionEndpoint.ts'
import {
  createLiveTimetableProjection,
} from '../src/live/liveTimetableProjection.ts'
import {
  createLiveTimetableRepository,
  createSupabaseLiveTimetableGateway,
  parsePublicLiveTimetable,
} from '../src/live/liveTimetableRepository.ts'
import {
  deleteLiveSmokeAuthUsers,
} from '../scripts/liveTimetableFoundationSmokeCleanup.mjs'

const workspaceId = '78000000-0000-4000-8000-000000000001'
const liveId = '78000000-0000-4000-8000-000000000002'
const publicId = '78000000-0000-4000-8000-000000000003'
const actorId = '00000000-0000-4000-8000-000000000078'
const now = '2026-10-20T00:00:00.000Z'

const createDomainState = () => ({
  members: [],
  bands: [],
  events: [{
    id: 'event-live',
    name: 'Live Event',
    description: 'public projection must not copy this',
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [10, 15],
    notes: 'private event notes',
  }],
  eventDays: [
    { id: 'day-b', eventId: 'event-live', date: '2026-11-02', order: 1 },
    { id: 'day-a', eventId: 'event-live', date: '2026-11-01', label: 'Day 1', order: 0 },
  ],
  stages: [
    {
      id: 'stage-empty', eventDayId: 'day-a', name: 'Empty Stage', order: 1,
      plannedStartTime: '09:00', plannedEndTime: '10:00',
    },
    {
      id: 'stage-main', eventDayId: 'day-a', name: 'Main Stage', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '12:00',
    },
    {
      id: 'stage-day-two', eventDayId: 'day-b', name: 'Day Two Stage', order: 0,
      plannedStartTime: '13:00',
    },
  ],
  sections: [
    {
      id: 'section-b', stageId: 'stage-main', name: 'Part 2', order: 1,
      plannedStartTime: '11:00', plannedEndTime: '12:00',
    },
    {
      id: 'section-a', stageId: 'stage-main', name: 'Part 1', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '10:30',
    },
    {
      id: 'section-empty', stageId: 'stage-empty', name: 'Empty Section', order: 0,
    },
  ],
  eventMembers: [],
  eventMemberDays: [],
  eventBands: [
    {
      id: 'event-band-a', eventId: 'event-live', eventDayId: 'day-a',
      name: 'Event Band A', memberIds: [], durationMinutes: 10,
      notes: 'private band notes',
    },
    {
      id: 'event-band-b', eventId: 'event-live', eventDayId: 'day-a',
      name: 'Event Band B', memberIds: [], durationMinutes: 15,
    },
    {
      id: 'event-band-c', eventId: 'event-live', eventDayId: 'day-b',
      name: 'Event Band C', memberIds: [], durationMinutes: 20,
    },
  ],
  scheduleItems: [
    {
      id: 'item-b', stageId: 'stage-main', sectionId: 'section-b', order: 0,
      kind: 'performance', eventBandId: 'event-band-b',
    },
    {
      id: 'item-a', stageId: 'stage-main', sectionId: 'section-a', order: 0,
      kind: 'performance', eventBandId: 'event-band-a',
    },
    {
      id: 'break-a', stageId: 'stage-main', afterSectionId: 'section-a', order: 0,
      kind: 'break', title: 'Do not publish this title', durationMinutes: 5,
    },
    {
      id: 'item-c', stageId: 'stage-day-two', order: 0,
      kind: 'performance', eventBandId: 'event-band-c',
    },
  ],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
  timetableLocks: [],
  timetableOrderConstraints: [],
})

const createSnapshot = () => {
  const result = createCloudEventSnapshot(createDomainState(), 'event-live')
  assert.equal(result.ok, true)
  return result.snapshot
}

const createProjection = () => {
  const result = createLiveTimetableProjection(createSnapshot())
  assert.equal(result.ok, true)
  return result.projection
}

test('Snapshot V1から日・Stage・Section・正式Timeline順のLive投影を作る', () => {
  const snapshot = createSnapshot()
  const before = structuredClone(snapshot)
  const result = createLiveTimetableProjection(snapshot)
  assert.equal(result.ok, true)
  assert.deepEqual(snapshot, before)

  const projection = result.projection
  assert.equal(projection.eventId, 'event-live')
  assert.equal(projection.eventName, 'Live Event')
  assert.equal(projection.timeZone, 'Asia/Tokyo')
  assert.deepEqual(projection.eventDays.map(day => [day.sourceEventDayId, day.position]), [
    ['day-a', 0], ['day-b', 1],
  ])
  assert.deepEqual(projection.stages.map(stage => [stage.sourceStageId, stage.position]), [
    ['stage-main', 0], ['stage-empty', 1], ['stage-day-two', 2],
  ])
  assert.deepEqual(projection.stages.map(stage => stage.eventDayPosition), [0, 0, 1])

  const main = projection.stages[0]
  assert.deepEqual(main.sections.map(section => section.sourceSectionId), [
    'section-a', 'section-b',
  ])
  assert.deepEqual(main.entries.map(entry => ({
    id: entry.sourceScheduleItemId,
    name: entry.displayName,
    start: entry.plannedStartMinute,
    end: entry.plannedEndMinute,
    section: entry.sourceSectionId,
    after: entry.afterSectionId,
  })), [
    { id: 'item-a', name: 'Event Band A', start: 600, end: 610,
      section: 'section-a', after: null },
    { id: 'break-a', name: '休憩', start: 610, end: 615,
      section: null, after: 'section-a' },
    { id: 'item-b', name: 'Event Band B', start: 660, end: 675,
      section: 'section-b', after: null },
  ])
  assert.equal(projection.stages[1].sections.length, 1)
  assert.equal(projection.stages[1].entries.length, 0)
  assert.equal(JSON.stringify(projection).includes('private event notes'), false)
  assert.equal(JSON.stringify(projection).includes('private band notes'), false)
  assert.equal(JSON.stringify(projection).includes('Do not publish this title'), false)
})

test('EventDayの空ラベルだけをnullへ正規化し有効な表示を保持する', () => {
  for (const { label, expected } of [
    { label: undefined, expected: null },
    { label: '', expected: null },
    { label: '   ', expected: null },
    { label: '学祭初日', expected: '学祭初日' },
    { label: '  学祭初日  ', expected: '  学祭初日  ' },
  ]) {
    const state = createDomainState()
    const target = state.eventDays.find(day => day.id === 'day-b')
    if (label === undefined) delete target.label
    else target.label = label
    const snapshotResult = createCloudEventSnapshot(state, 'event-live')
    assert.equal(snapshotResult.ok, true)
    const before = structuredClone(snapshotResult.snapshot)
    const result = createLiveTimetableProjection(snapshotResult.snapshot)
    assert.equal(result.ok, true)
    assert.equal(
      result.projection.eventDays.find(day => day.sourceEventDayId === 'day-b').label,
      expected,
    )
    assert.deepEqual(snapshotResult.snapshot, before)
  }
})

test('malformed V1と不正Timelineをfail closedにする', () => {
  assert.deepEqual(createLiveTimetableProjection({ version: 1 }), {
    ok: false,
    reason: 'INVALID_SNAPSHOT',
  })
  const malformed = structuredClone(createSnapshot())
  malformed.appState.scheduleItems[0].stageId = 'missing-stage'
  assert.equal(createLiveTimetableProjection(malformed).ok, false)
})

const jsonRequest = body => new Request('https://example.invalid/live', {
  method: 'POST',
  headers: {
    authorization: 'Bearer valid-token',
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
})

const projectionRequest = (overrides = {}) => ({
  workspaceId,
  eventId: 'event-live',
  expectedSourceRevision: 3,
  mode: 'create',
  expectedManagementRevision: null,
  ...overrides,
})

const sourceValue = (snapshot = createSnapshot()) => ({
  status: 'ok',
  workspace_id: workspaceId,
  event_id: 'event-live',
  event_name: 'Live Event',
  event_snapshot: snapshot,
  revision: 3,
  snapshot_fingerprint: 'a'.repeat(64),
})

const mutationValue = (overrides = {}) => ({
  status: 'created',
  workspaceId,
  eventId: 'event-live',
  liveId,
  publicId,
  sourceRevision: 3,
  sourceSnapshotFingerprint: 'a'.repeat(64),
  projectionVersion: '1',
  managementRevision: '1',
  isPublished: false,
  ...overrides,
})

test('投影Endpointは認証済みDB sourceだけから投影しTOCTOUをRPCへ引き継ぐ', async () => {
  let loaded
  let persisted
  const response = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      async authenticate(token) {
        assert.equal(token, 'valid-token')
        return { id: actorId }
      },
      async loadProjectionSource(input) {
        loaded = input
        return { data: sourceValue(), error: null }
      },
      async persistProjection(input) {
        persisted = input
        return { data: mutationValue(), error: null }
      },
    },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(loaded, {
    actorId,
    workspaceId,
    eventId: 'event-live',
    expectedSourceRevision: 3,
  })
  assert.equal(persisted.actorId, actorId)
  assert.equal(persisted.sourceSnapshotFingerprint, 'a'.repeat(64))
  assert.deepEqual(persisted.projection, createProjection())
  assert.equal(Object.hasOwn(projectionRequest(), 'snapshot'), false)
})

test('投影Endpointは認証・source・revision/response不整合をfail closedにする', async () => {
  let persistCalls = 0
  const baseDependencies = {
    async authenticate() { return { id: actorId } },
    async loadProjectionSource() { return { data: sourceValue(), error: null } },
    async persistProjection() {
      persistCalls += 1
      return { data: mutationValue(), error: null }
    },
  }

  const unauthenticated = await handleLiveTimetableProjectionRequest(
    new Request('https://example.invalid/live', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(projectionRequest()),
    }),
    baseDependencies,
  )
  assert.equal(unauthenticated.status, 401)

  const stale = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      ...baseDependencies,
      async loadProjectionSource() {
        return { data: null, error: { code: '40001' } }
      },
    },
  )
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT')

  const missingEvent = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      ...baseDependencies,
      async loadProjectionSource() {
        return { data: null, error: { code: 'P0002' } }
      },
    },
  )
  assert.equal(missingEvent.status, 409)
  assert.equal((await missingEvent.json()).error.code, 'EVENT_NOT_FOUND')

  for (const requestBody of [
    projectionRequest(),
    projectionRequest({ mode: 'replace', expectedManagementRevision: '1' }),
  ]) {
    const snapshotV2Source = await handleLiveTimetableProjectionRequest(
      jsonRequest(requestBody),
      {
        ...baseDependencies,
        async loadProjectionSource() {
          return { data: null, error: { code: '55000' } }
        },
      },
    )
    assert.equal(snapshotV2Source.status, 400)
    assert.equal((await snapshotV2Source.json()).error.code, 'INVALID_SOURCE')
  }

  for (const requestBody of [
    projectionRequest(),
    projectionRequest({ mode: 'replace', expectedManagementRevision: '1' }),
  ]) {
    const forbiddenPersistence = await handleLiveTimetableProjectionRequest(
      jsonRequest(requestBody),
      {
        ...baseDependencies,
        async persistProjection() {
          return { data: null, error: { code: '55000' } }
        },
      },
    )
    assert.equal(forbiddenPersistence.status, 409)
    assert.equal(
      (await forbiddenPersistence.json()).error.code,
      'PROJECTION_REPLACEMENT_FORBIDDEN',
    )
  }

  const missingLive = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest({
      mode: 'replace', expectedManagementRevision: '1',
    })),
    {
      ...baseDependencies,
      async persistProjection() {
        return { data: null, error: { code: 'P0003' } }
      },
    },
  )
  assert.equal(missingLive.status, 409)
  assert.equal((await missingLive.json()).error.code, 'LIVE_NOT_FOUND')

  const malformed = structuredClone(sourceValue())
  malformed.event_snapshot.appState.eventDays = null
  const invalidSource = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      ...baseDependencies,
      async loadProjectionSource() { return { data: malformed, error: null } },
    },
  )
  assert.equal(invalidSource.status, 502)
  assert.equal((await invalidSource.json()).error.code, 'INVALID_RESPONSE')

  const wrongIdentity = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      ...baseDependencies,
      async persistProjection() {
        return { data: mutationValue({ eventId: 'other' }), error: null }
      },
    },
  )
  assert.equal(wrongIdentity.status, 502)
  assert.equal(persistCalls, 0)

  const extraSourceField = sourceValue()
  extraSourceField.unexpected = 'must fail closed'
  assert.equal((await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      ...baseDependencies,
      async loadProjectionSource() {
        return { data: extraSourceField, error: null }
      },
    },
  )).status, 502)

  const extraMutationField = mutationValue({ unexpected: 'must not leak' })
  assert.equal((await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest()),
    {
      ...baseDependencies,
      async persistProjection() {
        return { data: extraMutationField, error: null }
      },
    },
  )).status, 502)

  const zeroRevision = await handleLiveTimetableProjectionRequest(
    jsonRequest(projectionRequest({
      mode: 'replace', expectedManagementRevision: '0',
    })),
    baseDependencies,
  )
  assert.equal(zeroRevision.status, 400)
})

test('投影Endpointはstream上限とmalformed JSONをDB呼出し前に拒否する', async () => {
  let sourceCalls = 0
  let persistCalls = 0
  const dependencies = {
    async authenticate() { return { id: actorId } },
    async loadProjectionSource() {
      sourceCalls += 1
      return { data: sourceValue(), error: null }
    },
    async persistProjection() {
      persistCalls += 1
      return { data: mutationValue(), error: null }
    },
  }
  const oversized = new Request('https://example.invalid/live', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024))
        controller.enqueue(new Uint8Array(32 * 1024 + 1))
        controller.close()
      },
    }),
    duplex: 'half',
  })
  assert.equal((await handleLiveTimetableProjectionRequest(
    oversized, dependencies,
  )).status, 413)

  const malformed = new Request('https://example.invalid/live', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
    },
    body: '{"workspaceId":',
  })
  assert.equal((await handleLiveTimetableProjectionRequest(
    malformed, dependencies,
  )).status, 400)
  assert.equal(sourceCalls, 0)
  assert.equal(persistCalls, 0)
})

const publicValue = () => ({
  status: 'ok',
  live: {
    publicId,
    eventName: 'Live Event',
    timeZone: 'Asia/Tokyo',
    projectionVersion: '1',
    managementRevision: '2',
    eventDays: [{ date: '2026-11-01', position: 0 }],
  },
  stages: [{
    name: 'Main Stage',
    eventDayPosition: 0,
    position: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '12:00',
    sections: [{
      name: 'Part 1', position: 0,
      plannedStartTime: '10:00', plannedEndTime: '10:30',
    }],
    revision: '1',
    projectionVersion: '1',
    progressStatus: 'not_started',
    currentEntryPosition: null,
    nextEntryPosition: 0,
    nextPerformancePosition: 0,
    updatedAt: now,
    entries: [{
      position: 0,
      kind: 'performance',
      displayName: 'Event Band A',
      plannedStartMinute: 600,
      plannedEndMinute: 610,
      status: 'pending',
      actualStartedAt: null,
      actualEndedAt: null,
    }],
  }],
})

test('公開read parserは厳密なrevisionと進行状態を検証する', () => {
  const parsed = parsePublicLiveTimetable(publicValue())
  assert.equal(parsed?.publicId, publicId)
  assert.equal(parsed?.stages[0].nextPerformancePosition, 0)

  const invalid = publicValue()
  invalid.stages[0].revision = '01'
  assert.equal(parsePublicLiveTimetable(invalid), undefined)

  const leaked = publicValue()
  leaked.live.workspaceId = workspaceId
  assert.equal(parsePublicLiveTimetable(leaked), undefined)

  const impossibleWaiting = publicValue()
  impossibleWaiting.stages[0].progressStatus = 'waiting'
  assert.equal(parsePublicLiveTimetable(impossibleWaiting), undefined)
})

test('Repositoryはmutation identityと状態を厳密に照合する', async () => {
  const baseGateway = {
    async createProjection() {
      return { data: {
        status: 'created', workspaceId, eventId: 'event-live', liveId, publicId,
        sourceRevision: 3, sourceSnapshotFingerprint: 'a'.repeat(64),
        projectionVersion: '1', managementRevision: '1', isPublished: false,
      }, error: null }
    },
    async loadAuthorized() { return { data: null, error: null } },
    async loadPublic() { return { data: null, error: null } },
    async setPublication(input) {
      return { data: {
        status: 'ok', liveId: input.liveId, projectionVersion: '1',
        managementRevision: '2', isPublished: input.published,
      }, error: null }
    },
    async setStageOperator(input) {
      return { data: {
        status: 'ok', liveId: input.liveId, stageId: publicId,
        operatorUserId: input.operatorUserId, assigned: input.assign,
        projectionVersion: '1', managementRevision: '2',
      }, error: null }
    },
    async transitionEntry(input) {
      return { data: {
        status: 'ok', operation: input.operation, liveId: input.liveId,
        stageId: publicId, projectionVersion: '1', stageRevision: '2',
        progressStatus: input.operation === 'start' ? 'in_progress' : 'waiting',
        currentEntryPosition: input.operation === 'start' ? 0 : null,
        nextEntryPosition: input.operation === 'start' ? 1 : 1,
        nextPerformancePosition: 1,
        entry: {
          position: 0,
          status: input.operation === 'start' ? 'in_progress' : 'completed',
          actualStartedAt: now,
          actualEndedAt: input.operation === 'end' ? now : null,
        },
      }, error: null }
    },
  }
  const repository = createLiveTimetableRepository(baseGateway)
  assert.equal((await repository.createProjection({
    workspaceId, eventId: 'event-live', expectedSourceRevision: 3,
    mode: 'create', expectedManagementRevision: null,
  })).ok, true)
  assert.equal((await repository.setPublication(liveId, '1', true)).ok, true)
  assert.equal((await repository.setStageOperator(
    liveId, 'stage-main', actorId, true, '1', '1',
  )).ok, true)
  assert.equal((await repository.startEntry(
    liveId, 'stage-main', 'item-a', '1', '1',
  )).ok, true)

  const wrongIdentity = createLiveTimetableRepository({
    ...baseGateway,
    async createProjection() {
      const value = await baseGateway.createProjection()
      value.data.workspaceId = '78000000-0000-4000-8000-000000000099'
      return value
    },
    async setPublication(input) {
      const value = await baseGateway.setPublication(input)
      value.data.liveId = '78000000-0000-4000-8000-000000000099'
      return value
    },
  })
  assert.equal((await wrongIdentity.createProjection({
    workspaceId, eventId: 'event-live', expectedSourceRevision: 3,
    mode: 'create', expectedManagementRevision: null,
  })).error.code, 'INVALID_RESPONSE')
  assert.equal((await wrongIdentity.setPublication(
    liveId, '1', true,
  )).error.code, 'INVALID_RESPONSE')

  const staleMutationResponse = createLiveTimetableRepository({
    ...baseGateway,
    async setStageOperator(input) {
      const value = await baseGateway.setStageOperator(input)
      value.data.projectionVersion = '2'
      return value
    },
    async transitionEntry(input) {
      const value = await baseGateway.transitionEntry(input)
      value.data.stageRevision = '3'
      return value
    },
  })
  assert.equal((await staleMutationResponse.setStageOperator(
    liveId, 'stage-main', actorId, true, '1', '1',
  )).error.code, 'INVALID_RESPONSE')
  assert.equal((await staleMutationResponse.startEntry(
    liveId, 'stage-main', 'item-a', '1', '1',
  )).error.code, 'INVALID_RESPONSE')
})

test('Repositoryは不正CAS引数をRPC前に拒否し公開nullを未検証成功にしない', async () => {
  let calls = 0
  const gateway = {
    async createProjection() { calls += 1; return { data: null, error: null } },
    async loadAuthorized() { calls += 1; return { data: null, error: null } },
    async loadPublic() { calls += 1; return { data: null, error: null } },
    async setPublication() { calls += 1; return { data: null, error: null } },
    async setStageOperator() { calls += 1; return { data: null, error: null } },
    async transitionEntry() { calls += 1; return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  assert.equal((await repository.startEntry(
    liveId, 'stage-main', 'item-a', '01', '1',
  )).error.code, 'INVALID_ARGUMENT')
  assert.equal((await repository.setPublication(
    liveId, '9223372036854775808', true,
  )).error.code, 'INVALID_ARGUMENT')
  assert.equal(calls, 0)

  const missing = await repository.loadPublic(publicId)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'NOT_FOUND')
  assert.equal(calls, 1)
})

test('Repositoryは既知のEdge error codeだけを保持し未知・壊れた応答を潰す', async () => {
  const createRepository = functionError => createLiveTimetableRepository(
    createSupabaseLiveTimetableGateway({
      functions: {
        async invoke() { return { data: null, error: functionError } },
      },
    }),
  )
  const create = repository => repository.createProjection({
    workspaceId,
    eventId: 'event-live',
    expectedSourceRevision: 3,
    mode: 'create',
    expectedManagementRevision: null,
  })

  for (const code of [
    'EVENT_NOT_FOUND',
    'LIVE_NOT_FOUND',
    'INVALID_SOURCE',
    'PROJECTION_REPLACEMENT_FORBIDDEN',
    'AUTHENTICATION_REQUIRED',
    'CONFIGURATION_ERROR',
    'INVALID_RESPONSE',
  ]) {
    const result = await create(createRepository({
      context: {
        async json() {
          return { status: 'error', error: { code, message: 'untrusted' } }
        },
      },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.equal(result.error.message.includes('untrusted'), false)
  }

  for (const functionError of [
    { context: { async json() {
      return { status: 'error', error: { code: 'UNKNOWN_EDGE_CODE' } }
    } } },
    { context: { async json() {
      return { status: 'error', error: { code: 123 } }
    } } },
    { context: { async json() { throw new Error('secret transport body') } } },
    { code: 'EVENT_NOT_FOUND', message: 'spoofed structured response' },
    { code: 'FunctionsFetchError', message: 'secret transport message' },
  ]) {
    const result = await create(createRepository(functionError))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'SUPABASE_ERROR')
    assert.equal(result.error.message.includes('secret'), false)
  }
})

test('Live smoke Auth cleanupは全対象を試行しerror・例外・部分失敗を成功扱いしない', async () => {
  const userIds = ['user-a', 'user-b', 'user-c']
  const successfulCalls = []
  await deleteLiveSmokeAuthUsers({
    auth: { admin: { async deleteUser(userId) {
      successfulCalls.push(userId)
      return { data: {}, error: null }
    } } },
  }, userIds)
  assert.deepEqual(successfulCalls, userIds)

  for (const failureMode of ['error', 'throw']) {
    const calls = []
    await assert.rejects(
      deleteLiveSmokeAuthUsers({
        auth: { admin: { async deleteUser(userId) {
          calls.push(userId)
          if (userId === 'user-b') {
            if (failureMode === 'throw') throw new Error('private user detail')
            return { data: null, error: { message: 'private user detail' } }
          }
          return { data: {}, error: null }
        } } },
      }, userIds),
      error => error.message === 'Dedicated Auth fixture cleanup failed.' &&
        !error.message.includes('private user detail'),
    )
    assert.deepEqual(calls, userIds)
  }
})

test('Live foundation migrationは原子的・分離・fail-closed契約を保持する', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261019154519_live_timetable_state_foundation.sql',
    import.meta.url,
  ), 'utf8')
  assert.equal((sql.match(/^begin;$/gmi) ?? []).length, 1)
  assert.equal((sql.match(/^commit;$/gmi) ?? []).length, 1)
  assert.match(sql, /\bbegin;[\s\S]*commit;\s*$/i)

  for (const table of [
    'live_timetables',
    'live_timetable_stages',
    'live_timetable_entries',
    'live_timetable_stage_operators',
  ]) {
    assert.match(sql, new RegExp(`create table public\\.${table}\\b`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  }
  assert.match(sql,
    /references public\.cloud_events\(workspace_id, event_id\)[\s\S]*on delete restrict/i)
  assert.match(sql,
    /create unique index live_timetable_entries_one_in_progress_idx[\s\S]*where status = 'in_progress'/i)
  assert.match(sql,
    /alter publication supabase_realtime[\s\S]*live_timetable_stages\s*\([\s\S]*projection_version[\s\S]*progress_status[\s\S]*updated_at[\s\S]*\)/i)
  assert.match(sql, /pg_catalog\.pg_publication_tables[\s\S]*attnames/i)
  assert.match(sql, /grant select on table public\.live_timetable_stages to authenticated/i)
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]*live_timetable/i)
  assert.match(sql,
    /grant execute on function public\.create_or_replace_live_timetable_projection\([^;]*\) to service_role/i)
  assert.doesNotMatch(sql,
    /grant execute on function public\.create_or_replace_live_timetable_projection\([^;]*\) to authenticated/i)
  assert.match(sql, /caller_id uuid := auth\.uid\(\)/i)
  assert.match(sql, /for update;[\s\S]*stage_row\.revision <> p_expected_stage_revision::bigint/i)
  assert.match(sql, /operation_time := clock_timestamp\(\)/i)
  assert.match(sql, /source_snapshot_fingerprint[\s\S]*extensions\.digest\([^)]*event_snapshot::text/i)
  assert.match(sql, /jsonb_build_object\([\s\S]*'publicId'[\s\S]*'eventName'[\s\S]*'timeZone'/i)
  assert.doesNotMatch(sql, /row_to_json\s*\(/i)
  assert.doesNotMatch(sql, /update public\.cloud_events/i)
  assert.doesNotMatch(sql, /update public\.cloud_event_workspace_generations/i)
  assert.match(sql, /display_name = '休憩'/i)
  assert.match(sql,
    /raise exception 'Live Timetable does not exist'[\s\S]*using errcode = 'P0003'/i)
  assert.match(sql, /delete from public\.live_timetable_stage_operators[\s\S]*delete from public\.live_timetable_stages/i)
})

test('Live Edge FunctionとCIは固定Deno設定を使用する', async () => {
  const [config, workflow, packageJson] = await Promise.all([
    readFile(new URL('../supabase/functions/create-live-timetable/deno.json', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  assert.deepEqual(JSON.parse(config), {
    nodeModulesDir: 'auto',
    imports: { '@supabase/supabase-js': 'npm:@supabase/supabase-js@2.117.2' },
  })
  assert.match(workflow,
    /deno check[\s\S]*--frozen[\s\S]*create-live-timetable\/deno\.json[\s\S]*create-live-timetable\/index\.ts/i)
  assert.match(JSON.parse(packageJson).scripts.test, /liveTimetableFoundation\.test\.mjs/)
  assert.equal(
    JSON.parse(packageJson).scripts['test:live-timetable-http-realtime-smoke'],
    'node scripts/liveTimetableFoundationHttpRealtimeSmoke.mjs --confirm-disposable',
  )
})

test('実DB fixtureはrollback境界とStage単位の並行契約を検証する', async () => {
  const [foundation, concurrency, readme] = await Promise.all([
    readFile(new URL(
      '../supabase/tests/live_timetable_state_foundation.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/live_timetable_state_foundation_concurrency.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../supabase/tests/README.md', import.meta.url), 'utf8'),
  ])

  assert.match(foundation, /^\\set ON_ERROR_STOP on/m)
  assert.match(foundation, /begin;[\s\S]*rollback;\s*$/i)
  assert.match(foundation, /same|first pending|Non-first pending entry/i)
  assert.match(foundation, /Viewer progress mutation was accepted/i)
  assert.match(foundation, /Unassigned editor progress was accepted/i)
  assert.match(foundation, /Viewer with stale operator assignment was accepted/i)
  assert.match(foundation, /Workspace outsider read was accepted/i)
  assert.match(foundation, /Anonymous public DTO allowlist is invalid/i)
  assert.match(foundation, /Referenced Event deletion was accepted/i)
  assert.match(foundation, /Event without Live state was not deleted/i)
  assert.match(foundation, /Live progress changed Cloud Event persistence state/i)
  assert.match(foundation, /Private break title/i)

  assert.match(concurrency, /fixture already exists; inspect it manually/i)
  assert.doesNotMatch(
    concurrency.slice(0, concurrency.indexOf('insert into auth.users')),
    /delete from (?:public\.|auth\.)/i,
  )
  assert.match(concurrency, /same-Stage start did not wait/i)
  assert.match(concurrency, /same-Stage end did not wait/i)
  assert.match(concurrency, /different-Stage start was unnecessarily blocked/i)
  assert.match(concurrency, /start did not wait for publication lock/i)
  assert.match(concurrency, /replacement did not wait for progress lock/i)
  assert.match(concurrency, /operator removal did not wait for Live operation/i)
  assert.match(concurrency, /membership downgrade did not wait for progress/i)
  assert.match(concurrency, /viewer with stale assignment started Live entry/i)
  assert.match(concurrency, /updated source was committed as Live projection/i)
  assert.match(concurrency, /deleted source was committed as Live projection/i)
  assert.match(concurrency, /duplicate Live create did not wait/i)
  assert.match(concurrency, /concurrent Live create did not produce one winner/i)
  assert.match(
    concurrency,
    /assert_live_concurrency_cleanup_target[\s\S]*from public\.workspaces[\s\S]*for update[\s\S]*from public\.workspace_members[\s\S]*order by user_id for update[\s\S]*from public\.cloud_events[\s\S]*order by event_id for update/i,
  )
  assert.match(
    concurrency,
    /workspace_master_members[\s\S]*workspace_master_bands[\s\S]*workspace_master_band_members[\s\S]*cloud_event_member_references[\s\S]*cloud_event_band_references[\s\S]*cloud_workspace_master_backfills/i,
  )
  assert.match(
    concurrency,
    /live-unexpected-cleanup-event[\s\S]*cleanup_live_concurrency_fixture\(\)[\s\S]*exception when sqlstate '55000'[\s\S]*before_digest is distinct from after_digest[\s\S]*rollback;/i,
  )
  assert.match(
    concurrency,
    /begin;\s*select pg_temp\.cleanup_live_concurrency_fixture\(\);[\s\S]*drop function public\.live_concurrency_projection_for[\s\S]*commit;/i,
  )
  assert.match(
    concurrency,
    /create function public\.live_concurrency_projection_for\([\s\S]*security definer[\s\S]*grant execute on function public\.live_concurrency_projection_for\(text, text\)[\s\S]*to service_role/i,
  )
  assert.match(concurrency, /pg_stat_clear_snapshot\(\)/i)
  assert.match(concurrency, /for attempt in 1\.\.200/i)
  assert.match(concurrency, /Live concurrency fixture cleanup is incomplete/i)
  assert.equal((concurrency.match(/do \$operation\$/g) ?? []).length, 7)
  assert.match(readme, /live_timetable_state_foundation\.sql/i)
  assert.match(readme, /live_timetable_state_foundation_concurrency\.sql/i)
})

test('Live実HTTP・Realtime runnerは専用loopbackと厳密cleanupを要求する', async () => {
  const [runner, setup, cleanup, preflight, catalogRegression] = await Promise.all([
    readFile(new URL(
      '../scripts/liveTimetableFoundationHttpRealtimeSmoke.mjs',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/live_timetable_state_foundation_http_setup.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/live_timetable_state_foundation_http_cleanup.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_event_migration_history_preflight.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_event_migration_history_catalog_regression.sql',
      import.meta.url,
    ), 'utf8'),
  ])

  assert.match(runner, /Exactly one --confirm-disposable argument is required/i)
  assert.match(runner, /const API_PORT = '56121'/)
  assert.match(runner, /const DATABASE_PORT = '56122'/)
  assert.match(runner, /createSupabaseLiveTimetableRepository/)
  assert.match(runner, /postgres_changes/)
  assert.match(runner, /await client\.realtime\.setAuth\(data\.session\.access_token\)/)
  assert.match(runner, /select: EXPECTED_REALTIME_COLUMNS/)
  assert.match(runner, /assert\.deepEqual\(settled, Array\(probes\.length\)\.fill\('SUBSCRIBED'\)\)/)
  assert.match(runner,
    /with removed as \(delete from public\.workspace_members[\s\S]*role='viewer' returning role\) select role from removed/i)
  assert.match(runner,
    /Owner did not receive the post-revocation Realtime update[\s\S]*Revoked viewer received a post-revocation Realtime update/i)
  assert.match(runner,
    /revokedViewerRead[\s\S]*ACCESS_DENIED[\s\S]*insert into public\.workspace_members/i)
  assert.match(runner, /realtimeRevokedViewerAuthorization: 'passed'/)
  assert.match(runner, /realtimeUpdateAuthorization: 'passed'/)
  assert.match(runner, /set updated_at=updated_at/)
  assert.match(runner, /attempt < 4 && !controlDelivered/)
  assert.match(runner, /assert\.equal\(controlDelivered, true/)
  assert.doesNotMatch(runner, /pg_catalog\.pg_replication_slots/)
  assert.ok(runner.indexOf('console.log(JSON.stringify(successReport))') >
    runner.indexOf('await deleteLiveSmokeAuthUsers(admin, createdUserIds)'))
  assert.doesNotMatch(runner, /console\.log\([^)]*(?:anonKey|serviceRoleKey|token)/)
  assert.match(setup, /Live HTTP fixture precondition failed/)
  assert.match(cleanup, /cleanup target differs from its dedicated fixture/)
  assert.match(cleanup, /workspace_master_band_members/)
  assert.match(cleanup, /cloud_workspace_master_backfills/)
  assert.match(cleanup, /select id from public\.workspaces[\s\S]*for update/i)
  assert.match(cleanup, /event_id is distinct from fixture_event_id/i)
  assert.match(cleanup, /Live HTTP fixture cleanup is incomplete/)

  assert.match(
    preflight,
    /cloudV2AtomicCutoverContract[\s\S]*\) \|\| jsonb_build_object\([\s\S]*liveTimetableFoundationContract/,
  )
  assert.match(
    preflight,
    /liveTimetableFoundationContract[\s\S]*has_any_column_privilege\([\s\S]*'INSERT,UPDATE,REFERENCES'/i,
  )
  assert.match(
    preflight,
    /live_timetable_stages_select_for_workspace_member[\s\S]*regexp_replace\([\s\S]*workspace_members\.workspace_id = live_timetable_stages\.workspace_id[\s\S]*workspace_members\.user_id = \( SELECT auth\.uid\(\) AS uid\)/i,
  )
  assert.doesNotMatch(
    preflight,
    /live_timetable_stages_select_for_workspace_member[\s\S]{0,1000}qual[^\n]*like/i,
  )
  assert.match(
    preflight,
    /live_timetables'\), false\)[\s\S]*live_timetable_stages'\), true\)[\s\S]*live_timetable_entries'\), false\)[\s\S]*live_timetable_stage_operators'\), false\)[\s\S]*has_table_privilege\([\s\S]*'SELECT'[\s\S]*has_any_column_privilege\([\s\S]*'SELECT'/i,
  )
  for (const selectScenario of [
    'live_timetable_stage_select_policy_uncorrelated',
    'live_timetable_anon_live_select',
    'live_timetable_authenticated_entry_select',
    'live_timetable_authenticated_operator_select',
    'live_timetable_public_select',
    'live_timetable_authenticated_inherited_select',
    'live_timetable_authenticated_column_select',
  ]) {
    assert.match(catalogRegression, new RegExp(`'${selectScenario}'`))
  }
  assert.match(
    catalogRegression,
    /membership_primary_key_missing[\s\S]*drop constraint live_timetable_stage_operators_workspace_id_user_id_fkey[\s\S]*drop constraint workspace_members_pkey/,
  )
})
