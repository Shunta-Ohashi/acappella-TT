import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createLiveTimetableRepository,
  createSupabaseLiveTimetableGateway,
  parseLiveTimetableDiscovery,
  parseLiveTimetableOperatorCandidates,
} from '../src/live/liveTimetableRepository.ts'
import {
  createRetainedEditorAccountGuardRegistry,
  createLiveTimetableHash,
  createLocalAppReturnUrl,
  resolveLiveTimetableHash,
  shouldKeepCloudEditorMounted,
} from '../src/live/liveTimetableRouting.ts'
import { formatLiveTimetableTimestamp } from '../src/live/liveTimetablePresentation.ts'
import {
  LIVE_TIMETABLE_REALTIME_COLUMNS,
  LIVE_AUTHORIZED_READ_TIMEOUT_MS,
  LIVE_HEALTHY_POLLING_INTERVAL_MS,
  LIVE_STATE_MAX_AGE_MS,
  canApplyLiveOperatorCandidateRead,
  canApplyLiveRead,
  canDispatchConfirmedLiveMutation,
  canRunLiveMutation,
  createInvalidatedLiveOperatorCandidateRead,
  createLivePollingTimerController,
  createPostMutationReadBarrier,
  createLiveTimetableScopeKey,
  describeLiveStageManagementTarget,
  getLivePollingDelay,
  isLiveStateStale,
  isLiveTimetableReadAtLeastAsFresh,
  isMatchingLiveRealtimePayload,
  resolveLiveOperatorCandidateSelection,
  runLiveAuthorizedReadWithDeadline,
} from '../src/live/liveTimetableSync.ts'

const liveId = '10000000-0000-0000-0000-000000000001'
const workspaceId = '20000000-0000-0000-0000-000000000001'
const userId = '30000000-0000-0000-0000-000000000001'

const createLive = ({
  projectionVersion = '1',
  managementRevision = '1',
  stageRevision = '1',
  role = 'viewer',
  canOperate = false,
} = {}) => ({
  liveId,
  publicId: '10000000-0000-0000-0000-000000000002',
  workspaceId,
  eventId: 'event-a',
  eventName: 'Event A',
  timeZone: 'Asia/Tokyo',
  eventDays: [{
    sourceEventDayId: 'day-a', date: '2026-11-01', label: null, position: 0,
  }],
  sourceRevision: 1,
  sourceSnapshotFingerprint: 'a'.repeat(64),
  projectionVersion,
  managementRevision,
  isPublished: true,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  role,
  canManage: role === 'owner',
  operators: [],
  stages: [{
    stageId: '40000000-0000-0000-0000-000000000001',
    sourceEventDayId: 'day-a',
    sourceStageId: 'stage-a',
    eventDayPosition: 0,
    name: 'Main',
    position: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '10:10',
    sections: [],
    revision: stageRevision,
    projectionVersion,
    progressStatus: 'not_started',
    currentEntryPosition: null,
    nextEntryPosition: 0,
    nextPerformancePosition: 0,
    updatedAt: '2026-10-21T00:00:00.000Z',
    canOperate,
    entries: [{
      position: 0,
      kind: 'performance',
      displayName: 'Band A',
      plannedStartMinute: 600,
      plannedEndMinute: 610,
      status: 'pending',
      actualStartedAt: null,
      actualEndedAt: null,
      sourceScheduleItemId: 'item-a',
      sourceSectionId: null,
      afterSectionId: null,
      startedBy: null,
      endedBy: null,
    }],
  }],
})

test('Live routeはEvent IDを安全に往復し#shareと混同しない', () => {
  const hash = createLiveTimetableHash('event/日本語 & live')
  assert.deepEqual(resolveLiveTimetableHash(hash), {
    kind: 'live', eventId: 'event/日本語 & live',
  })
  assert.equal(resolveLiveTimetableHash('#share=payload'), undefined)
  assert.equal(resolveLiveTimetableHash('#live='), undefined)
  assert.equal(resolveLiveTimetableHash('#live=%E0%A4%A'), undefined)
  assert.equal(shouldKeepCloudEditorMounted(false, { kind: 'live', eventId: 'a' }), false)
  assert.equal(shouldKeepCloudEditorMounted(false, undefined), true)
  assert.equal(shouldKeepCloudEditorMounted(true, { kind: 'live', eventId: 'a' }), true)
  assert.equal(createLocalAppReturnUrl('/app/', '?mode=local'), '/app/?mode=local')
})

test('retained editor account guardはdraft・scope・登録解除をfail closedで扱う', () => {
  const registry = createRetainedEditorAccountGuardRegistry()
  const draft = { dirty: true, value: 'unsaved' }
  const releaseA = registry.register('visit-a', () => !draft.dirty)

  assert.equal(registry.canRun({
    required: true, scopeKey: 'visit-a', action: 'sign-out',
  }), false)
  assert.equal(registry.canRun({
    required: true, scopeKey: 'visit-a', action: 'workspace-switch',
  }), false)
  assert.equal(draft.value, 'unsaved')
  assert.equal(registry.canRun({
    required: true, scopeKey: 'visit-b', action: 'sign-out',
  }), false)

  draft.dirty = false
  assert.equal(registry.canRun({
    required: true, scopeKey: 'visit-a', action: 'sign-out',
  }), true)

  const releaseB = registry.register('visit-b', () => true)
  releaseA()
  assert.equal(registry.canRun({
    required: true, scopeKey: 'visit-b', action: 'workspace-switch',
  }), true, 'stale cleanup must not clear the current registration')
  releaseB()
  assert.equal(registry.canRun({
    required: true, scopeKey: 'visit-b', action: 'sign-out',
  }), false)
  assert.equal(registry.canRun({
    required: false, scopeKey: 'direct-live', action: 'sign-out',
  }), true, 'direct #live must not require editor hydration')
})

test('Stage管理ラベルはEventDay ID完全一致で同名Stageを日付別に識別する', () => {
  const eventDays = [
    { sourceEventDayId: 'day-a', date: '2026-11-01', label: '1日目', position: 0 },
    { sourceEventDayId: 'day-b', date: '2026-11-02', label: '2日目', position: 1 },
  ]
  assert.equal(describeLiveStageManagementTarget({
    sourceEventDayId: 'day-a', name: 'メインステージ',
  }, eventDays), '2026/11/1（1日目）／メインステージ')
  assert.equal(describeLiveStageManagementTarget({
    sourceEventDayId: 'day-b', name: 'メインステージ',
  }, eventDays), '2026/11/2（2日目）／メインステージ')
  assert.equal(describeLiveStageManagementTarget({
    sourceEventDayId: 'missing', name: 'メインステージ',
  }, eventDays), '開催日不明／メインステージ')
  assert.equal(describeLiveStageManagementTarget({
    sourceEventDayId: 'day-invalid', name: 'サブステージ',
  }, [...eventDays, {
    sourceEventDayId: 'day-invalid', date: 'invalid', label: null, position: 2,
  }]), '開催日不明／サブステージ')
  assert.equal(describeLiveStageManagementTarget({
    sourceEventDayId: 'day-a', name: 'Main',
  }, [{ ...eventDays[0], label: null }]), '2026/11/1／Main')
})

test('実績時刻はLive timezoneで端末timezoneに依存せず日付境界も表示する', () => {
  assert.equal(
    formatLiveTimetableTimestamp('2026-10-31T15:30:45.000Z', 'Asia/Tokyo'),
    '11/01 00:30:45',
  )
  assert.equal(
    formatLiveTimetableTimestamp('2026-10-31T15:30:45.000Z', 'America/New_York'),
    '10/31 11:30:45',
  )
  assert.equal(formatLiveTimetableTimestamp(null, 'Asia/Tokyo'), '—')
  assert.equal(
    formatLiveTimetableTimestamp('2026-10-31T15:30:45.000Z', 'Invalid/Zone'),
    '表示不可',
  )
  assert.equal(formatLiveTimetableTimestamp('invalid', 'Asia/Tokyo'), '表示不可')
})

test('Live readはscopeとbigint revision vectorで古い応答を破棄する', () => {
  const scopeKey = createLiveTimetableScopeKey({
    userId, workspaceId, workspaceVisitId: 'visit-1', eventId: 'event-a', liveId,
  })
  const current = createLive({
    projectionVersion: '9223372036854775806',
    managementRevision: '9007199254740993',
    stageRevision: '9007199254740995',
  })
  const olderStage = createLive({
    projectionVersion: '9223372036854775806',
    managementRevision: '9007199254740994',
    stageRevision: '9007199254740994',
  })
  const newerProjection = createLive({
    projectionVersion: '9223372036854775807',
    managementRevision: '1',
    stageRevision: '1',
  })
  assert.equal(isLiveTimetableReadAtLeastAsFresh(olderStage, current), false)
  assert.equal(isLiveTimetableReadAtLeastAsFresh(newerProjection, current), true)
  assert.equal(canApplyLiveRead({
    token: { scopeKey, sequence: 4 },
    activeScopeKey: scopeKey,
    latestAppliedSequence: 3,
    incoming: newerProjection,
    current,
  }), true)
  assert.equal(canApplyLiveRead({
    token: { scopeKey: `${scopeKey}-old`, sequence: 5 },
    activeScopeKey: scopeKey,
    latestAppliedSequence: 3,
    incoming: newerProjection,
    current,
  }), false)
  const barrier = createPostMutationReadBarrier(5)
  assert.equal(barrier, 6)
  assert.equal(canApplyLiveRead({
    token: { scopeKey, sequence: 5 },
    activeScopeKey: scopeKey,
    latestAppliedSequence: 3,
    minimumRequiredSequence: barrier,
    incoming: newerProjection,
    current,
  }), false)
  assert.equal(canApplyLiveRead({
    token: { scopeKey, sequence: 6 },
    activeScopeKey: scopeKey,
    latestAppliedSequence: 3,
    minimumRequiredSequence: barrier,
    incoming: newerProjection,
    current,
  }), true)
})

test('polling backoff・stale・offline mutation gateはfail closed', () => {
  assert.equal(getLivePollingDelay(0, false), 1_000)
  assert.equal(getLivePollingDelay(4, false), 15_000)
  assert.equal(getLivePollingDelay(99, false), 15_000)
  assert.equal(getLivePollingDelay(0, true), 30_000)
  assert.equal(getLivePollingDelay(1, true), 2_000)
  assert.equal(getLivePollingDelay(4, true), 15_000)
  assert.ok(LIVE_HEALTHY_POLLING_INTERVAL_MS < LIVE_STATE_MAX_AGE_MS)
  assert.equal(isLiveStateStale(undefined, 100), true)
  assert.equal(isLiveStateStale(1_000, 45_000), false)
  assert.equal(isLiveStateStale(1_000, 46_001), true)
  assert.equal(canRunLiveMutation({
    online: true, stale: false, pending: false,
    canOperate: true, progressEnabled: true,
  }), true)
  for (const override of [
    { online: false }, { stale: true }, { pending: true },
    { canOperate: false }, { progressEnabled: false },
  ]) {
    assert.equal(canRunLiveMutation({
      online: true, stale: false, pending: false,
      canOperate: true, progressEnabled: true,
      ...override,
    }), false)
  }
})

test('polling timerはin-flight readと再scheduleが重なっても1本だけを維持する', async () => {
  let nextHandle = 0
  const callbacks = new Map()
  const controller = createLivePollingTimerController({
    setTimer(callback) {
      const handle = ++nextHandle
      callbacks.set(handle, callback)
      return handle
    },
    clearTimer(handle) {
      callbacks.delete(handle)
    },
  })
  let finishFirstRead
  const firstRead = new Promise(resolve => { finishFirstRead = resolve })
  let oldReadRescheduled = false

  controller.schedule(30_000, async isCurrent => {
    await firstRead
    if (isCurrent()) oldReadRescheduled = true
  })
  assert.equal(callbacks.size, 1)
  const firstCallback = callbacks.values().next().value
  callbacks.clear()
  firstCallback()

  // visibility復帰相当の再scheduleは、実行中だった旧readを失効させる。
  controller.schedule(30_000, async () => {})
  controller.schedule(2_000, async () => {})
  assert.equal(callbacks.size, 1)
  finishFirstRead()
  await firstRead
  await Promise.resolve()
  assert.equal(oldReadRescheduled, false)
  assert.equal(callbacks.size, 1)

  controller.dispose()
  assert.equal(callbacks.size, 0)
  controller.schedule(1_000, async () => {})
  assert.equal(callbacks.size, 0)
})

test('authorized read deadlineはhung slotを解放しlate responseを状態へ適用しない', async () => {
  let timerId = 0
  const timers = new Map()
  const timerOptions = {
    setTimer(callback) {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
  }
  let finishHungRead
  const hungRead = new Promise(resolve => { finishHungRead = resolve })
  let inFlight = null
  let applied = 'initial'
  let lastSynchronizedAt = 123
  let freshnessBarrier = 7

  const run = async read => {
    if (inFlight) return inFlight
    const controller = new AbortController()
    const operation = runLiveAuthorizedReadWithDeadline({
      controller,
      read,
      timeoutMilliseconds: LIVE_AUTHORIZED_READ_TIMEOUT_MS,
      ...timerOptions,
    })
    inFlight = operation
    try {
      const outcome = await operation
      if (outcome.status === 'completed') {
        applied = outcome.value
        lastSynchronizedAt = 456
        freshnessBarrier = 0
      }
      return outcome
    } finally {
      if (inFlight === operation) inFlight = null
    }
  }

  const firstRun = run(() => hungRead)
  assert.equal(timers.size, 1)
  timers.values().next().value()
  assert.deepEqual(await firstRun, { status: 'timed-out' })
  assert.equal(inFlight, null)
  assert.equal(applied, 'initial')
  assert.equal(lastSynchronizedAt, 123)
  assert.equal(freshnessBarrier, 7)

  const recovered = await run(async () => 'fresh')
  assert.deepEqual(recovered, { status: 'completed', value: 'fresh' })
  assert.equal(applied, 'fresh')
  assert.equal(lastSynchronizedAt, 456)
  assert.equal(freshnessBarrier, 0)

  finishHungRead('late')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(applied, 'fresh')
  assert.equal(lastSynchronizedAt, 456)
  assert.equal(freshnessBarrier, 0)
  assert.equal(timers.size, 0)
})

test('visibility・online・scope cleanup相当のabortはhung readを即時失効する', async () => {
  for (const reason of ['visibility', 'online', 'scope-cleanup', 'strict-cleanup']) {
    const controller = new AbortController()
    let finishRead
    const read = new Promise(resolve => { finishRead = resolve })
    const outcomePromise = runLiveAuthorizedReadWithDeadline({
      controller,
      read: () => read,
      timeoutMilliseconds: LIVE_AUTHORIZED_READ_TIMEOUT_MS,
    })
    controller.abort(reason)
    assert.deepEqual(await outcomePromise, { status: 'aborted' })
    finishRead('late')
  }
})

test('正常authorized readはdeadline前に完了しSupabase adapterへAbortSignalを渡す', async () => {
  const controller = new AbortController()
  let receivedSignal
  let rpcName
  const response = { data: null, error: null }
  const request = {
    abortSignal(signal) {
      receivedSignal = signal
      return Promise.resolve(response)
    },
    then(resolve, reject) {
      return Promise.resolve(response).then(resolve, reject)
    },
  }
  const gateway = createSupabaseLiveTimetableGateway({
    rpc(name) {
      rpcName = name
      return request
    },
  })
  const outcome = await runLiveAuthorizedReadWithDeadline({
    controller,
    read: signal => gateway.loadAuthorized(liveId, signal),
  })
  assert.deepEqual(outcome, { status: 'completed', value: response })
  assert.equal(rpcName, 'load_live_timetable_authorized')
  assert.equal(receivedSignal, controller.signal)
})

test('担当候補readは最新sequence・現在scope・現在Liveだけを反映する', () => {
  const token = { liveId, scopeKey: 'scope-a', sequence: 3 }
  assert.equal(canApplyLiveOperatorCandidateRead({
    token,
    activeLiveId: liveId,
    activeScopeKey: 'scope-a',
    latestStartedSequence: 3,
  }), true)
  for (const override of [
    { activeLiveId: '10000000-0000-0000-0000-000000000099' },
    { activeScopeKey: 'scope-b' },
    { latestStartedSequence: 4 },
  ]) {
    assert.equal(canApplyLiveOperatorCandidateRead({
      token,
      activeLiveId: liveId,
      activeScopeKey: 'scope-a',
      latestStartedSequence: 3,
      ...override,
    }), false)
  }
})

test('候補read失効はloadingを解除し旧Aを無視して再取得Bを適用できる', () => {
  const tokenA = { liveId, scopeKey: 'scope-a', sequence: 1 }
  const invalidated = createInvalidatedLiveOperatorCandidateRead({
    currentSequence: tokenA.sequence,
    liveId,
    scopeKey: 'scope-a',
    error: '再取得してください。',
  })
  assert.equal(invalidated.loading, false)
  assert.deepEqual(invalidated.candidates, [])
  assert.deepEqual(invalidated.context, { liveId, scopeKey: 'scope-a' })
  assert.equal(invalidated.error, '再取得してください。')
  assert.equal(canApplyLiveOperatorCandidateRead({
    token: tokenA,
    activeLiveId: liveId,
    activeScopeKey: 'scope-a',
    latestStartedSequence: invalidated.nextSequence,
  }), false)

  const tokenB = {
    liveId,
    scopeKey: 'scope-a',
    sequence: invalidated.nextSequence + 1,
  }
  assert.equal(canApplyLiveOperatorCandidateRead({
    token: tokenB,
    activeLiveId: liveId,
    activeScopeKey: 'scope-a',
    latestStartedSequence: tokenB.sequence,
  }), true)
  assert.equal(canApplyLiveOperatorCandidateRead({
    token: tokenA,
    activeLiveId: liveId,
    activeScopeKey: 'scope-b',
    latestStartedSequence: tokenB.sequence,
  }), false)
})

test('確認ダイアログ後は実時刻・通信・scope・barrierを再評価する', () => {
  const base = {
    online: true,
    lastSynchronizedAt: 10_000,
    now: 10_100,
    pending: false,
    freshnessRequiredSequence: 0,
    expectedScopeKey: 'scope-a',
    activeScopeKey: 'scope-a',
    expectedLiveId: liveId,
    activeLiveId: liveId,
    authorized: true,
  }
  assert.equal(canDispatchConfirmedLiveMutation(base), true)
  assert.equal(canDispatchConfirmedLiveMutation({
    ...base,
    now: 10_000 + LIVE_STATE_MAX_AGE_MS + 1,
  }), false)
  assert.equal(canDispatchConfirmedLiveMutation({ ...base, online: false }), false)
  assert.equal(canDispatchConfirmedLiveMutation({
    ...base, activeScopeKey: 'scope-b',
  }), false)
  assert.equal(canDispatchConfirmedLiveMutation({
    ...base, freshnessRequiredSequence: 5,
  }), false)
  assert.equal(canDispatchConfirmedLiveMutation({ ...base, pending: true }), false)
  assert.equal(canDispatchConfirmedLiveMutation({ ...base, authorized: false }), false)
  assert.equal(canDispatchConfirmedLiveMutation({
    ...base, activeLiveId: '10000000-0000-0000-0000-000000000099',
  }), false)
  assert.equal(canDispatchConfirmedLiveMutation({
    ...base,
    lastSynchronizedAt: 60_000,
    now: 60_001,
  }), true)
})

test('担当候補更新後は消失IDを送らず有効候補へfallbackする', () => {
  const candidateA = { userId: 'candidate-a' }
  const candidateB = { userId: 'candidate-b' }
  assert.equal(resolveLiveOperatorCandidateSelection(
    candidateA.userId,
    [candidateA, candidateB],
  ), candidateA.userId)
  assert.equal(resolveLiveOperatorCandidateSelection(
    candidateA.userId,
    [candidateB],
  ), candidateB.userId)
  assert.equal(resolveLiveOperatorCandidateSelection(
    candidateA.userId,
    [],
  ), '')
  assert.equal(resolveLiveOperatorCandidateSelection(
    undefined,
    [candidateB],
  ), candidateB.userId)
})

test('Realtime更新がない正常な長時間進行でも補助readによりstaleにならない', () => {
  let lastSuccessfulAuthorizedRead = 0
  for (let now = 0; now <= 5 * 60_000; now += 1_000) {
    if (now > 0 && now % LIVE_HEALTHY_POLLING_INTERVAL_MS === 0) {
      lastSuccessfulAuthorizedRead = now
    }
    assert.equal(
      isLiveStateStale(lastSuccessfulAuthorizedRead, now),
      false,
      `normal authorized polling should keep the state fresh at ${now}ms`,
    )
  }
})

test('authorized readが失敗し続ける通信断ではstale後のmutationを停止する', () => {
  const lastSuccessfulAuthorizedRead = 0
  assert.equal(isLiveStateStale(
    lastSuccessfulAuthorizedRead,
    LIVE_STATE_MAX_AGE_MS,
  ), false)
  const stale = isLiveStateStale(
    lastSuccessfulAuthorizedRead,
    LIVE_STATE_MAX_AGE_MS + 1,
  )
  assert.equal(stale, true)
  assert.equal(canRunLiveMutation({
    online: true,
    stale,
    pending: false,
    canOperate: true,
    progressEnabled: true,
  }), false)
})

test('Realtime通知は7列・現在scopeだけを再取得トリガーにする', () => {
  const row = {
    id: '40000000-0000-0000-0000-000000000001',
    workspace_id: workspaceId,
    live_timetable_id: liveId,
    projection_version: 1,
    revision: 2,
    progress_status: 'in_progress',
    updated_at: '2026-10-21T00:00:00.000Z',
  }
  assert.deepEqual(Object.keys(row).sort(), [...LIVE_TIMETABLE_REALTIME_COLUMNS].sort())
  assert.equal(isMatchingLiveRealtimePayload(row, workspaceId, liveId), true)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, name: 'leak' }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, workspace_id: 'other' }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, revision: Number.MAX_SAFE_INTEGER + 1 }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, progress_status: 'unknown' }, workspaceId, liveId,
  ), false)
})

test('discovery/candidate parserはexact responseとID一意性を要求する', () => {
  assert.deepEqual(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId: null,
  }, workspaceId, 'event-a'), {
    workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId: null,
  })
  assert.equal(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId, extra: true,
  }, workspaceId, 'event-a'), undefined)
  assert.equal(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 0, liveId,
  }, workspaceId, 'event-a'), undefined)
  assert.deepEqual(parseLiveTimetableOperatorCandidates({
    status: 'ok', liveId, candidates: [
      { userId, displayName: 'Viewer A' },
    ],
  }, liveId), [{ userId, displayName: 'Viewer A' }])
  assert.equal(parseLiveTimetableOperatorCandidates({
    status: 'ok', liveId, candidates: [
      { userId, displayName: 'Viewer A', email: 'must-not-leak@example.invalid' },
    ],
  }, liveId), undefined)
  assert.equal(parseLiveTimetableOperatorCandidates({
    status: 'ok', liveId, candidates: [
      { userId, displayName: 'A' }, { userId, displayName: 'B' },
    ],
  }, liveId), undefined)
})

test('repositoryは不正discovery/candidate引数でRPCを呼ばない', async () => {
  let calls = 0
  const gateway = {
    async createProjection() { return { data: null, error: null } },
    async loadAuthorized() { return { data: null, error: null } },
    async loadPublic() { return { data: null, error: null } },
    async findForEvent() { calls += 1; return { data: null, error: null } },
    async listOperatorCandidates() { calls += 1; return { data: null, error: null } },
    async setPublication() { return { data: null, error: null } },
    async setStageOperator() { return { data: null, error: null } },
    async transitionEntry() { return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  assert.equal((await repository.findForEvent('bad', 'event-a')).error.code,
    'INVALID_ARGUMENT')
  assert.equal((await repository.findForEvent(workspaceId, '')).error.code,
    'INVALID_ARGUMENT')
  assert.equal((await repository.listOperatorCandidates('bad')).error.code,
    'INVALID_ARGUMENT')
  assert.equal(calls, 0)
})

test('repositoryはdiscovery/candidateのscopeとexact応答を維持する', async () => {
  const calls = []
  const gateway = {
    async createProjection() { return { data: null, error: null } },
    async loadAuthorized() { return { data: null, error: null } },
    async loadPublic() { return { data: null, error: null } },
    async findForEvent(input) {
      calls.push(['find', input])
      return {
        data: {
          status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
          sourceRevision: 7, liveId,
        },
        error: null,
      }
    },
    async listOperatorCandidates(inputLiveId) {
      calls.push(['candidates', inputLiveId])
      return {
        data: {
          status: 'ok', liveId,
          candidates: [{ userId, displayName: 'Viewer A' }],
        },
        error: null,
      }
    },
    async setPublication() { return { data: null, error: null } },
    async setStageOperator() { return { data: null, error: null } },
    async transitionEntry() { return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  assert.deepEqual(await repository.findForEvent(workspaceId, 'event-a'), {
    ok: true,
    value: {
      workspaceId, eventId: 'event-a', eventName: 'Event A',
      sourceRevision: 7, liveId,
    },
  })
  assert.deepEqual(await repository.listOperatorCandidates(liveId), {
    ok: true,
    value: [{ userId, displayName: 'Viewer A' }],
  })
  assert.deepEqual(calls, [
    ['find', { workspaceId, eventId: 'event-a' }],
    ['candidates', liveId],
  ])
})

test('migration #16はviewer grant snapshot・public分離・RPC ACLを追加する', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261021050414_live_timetable_operator_ui.sql',
    import.meta.url,
  ), 'utf8')
  assert.equal((sql.match(/^begin;$/gmi) ?? []).length, 1)
  assert.equal((sql.match(/^commit;$/gmi) ?? []).length, 1)
  assert.match(sql, /add column granted_role text/i)
  assert.match(sql, /add column authorization_epoch uuid not null default gen_random_uuid\(\)/i)
  assert.match(sql, /workspace_members_rotate_authorization_epoch/i)
  assert.match(sql, /new\.role is distinct from old\.role/i)
  assert.match(sql, /new\.authorization_epoch := old\.authorization_epoch/i)
  assert.match(sql, /add column granted_authorization_epoch uuid/i)
  assert.match(sql, /set granted_role = 'editor'/i)
  assert.match(sql, /granted_role in \('editor', 'viewer'\)/i)
  assert.match(sql, /assignment\.granted_role = membership_role/i)
  assert.match(sql, /assignment\.granted_authorization_epoch =[\s\S]*membership_authorization_epoch/i)
  assert.ok(
    sql.indexOf('assignment.granted_role = membership_role') <
      sql.indexOf('if not live_row.is_published'),
    'Stage authorization must be checked before progress enablement',
  )
  assert.match(sql, /operator_role not in \('editor', 'viewer'\)/i)
  assert.match(sql, /on conflict \(stage_id, user_id\) do update[\s\S]*granted_role/i)
  assert.match(sql, /granted_authorization_epoch =[\s\S]*excluded\.granted_authorization_epoch/i)
  assert.match(sql, /add column public_view_enabled boolean not null default false/i)
  assert.match(sql, /is_published[\s\S]*public_view_enabled/i)
  assert.match(sql, /create function public\.find_live_timetable_for_event_authorized/i)
  assert.match(sql, /create function public\.list_live_timetable_operator_candidates/i)
  assert.match(sql, /workspace_members\.role in \('editor', 'viewer'\)/i)
  assert.doesNotMatch(sql, /auth\.users[\s\S]*email/i)
  assert.match(sql, /revoke all on function public\.find_live_timetable_for_event_authorized[\s\S]*grant execute[\s\S]*to authenticated/i)
  assert.match(sql,
    /foreach signature in array array\[[\s\S]*public\.build_live_timetable_stages_json\(uuid,uuid,text,boolean\)[\s\S]*has_function_privilege\(role_name, function_oid, 'EXECUTE'\)/i)
  assert.match(sql, /PUBLIC can execute internal helper/i)
})

test('Live UIは独立route・再read・確認・非永続scopeを維持する', async () => {
  const [page, routeApp, app, main, eventList] = await Promise.all([
    readFile(new URL('../src/components/LiveTimetableOperatorPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/cloud/CloudRouteApp.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EventList.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(routeApp, /resolveLiveTimetableHash/)
  assert.match(routeApp, /editorMounted &&/)
  assert.match(routeApp, /hidden=\{route !== undefined\}/)
  assert.match(routeApp, /inert=\{route !== undefined\}/)
  assert.match(routeApp, /key=\{cloud\?\.workspaceVisitId\}/)
  assert.match(routeApp, /isActive=\{route === undefined\}/)
  assert.match(routeApp, /createRetainedEditorAccountGuardRegistry/)
  assert.match(routeApp, /required: editorMounted/)
  assert.match(app, /registerRetainedEditorAccountGuard/)
  assert.match(app, /retainedEditorAccountGuardRef\.current/)
  assert.match(app, /const timetableHistoryShortcutsEnabled = timetableHistoryActive && isActive/)
  assert.match(app, /if \(!timetableHistoryShortcutsEnabled\) return/)
  assert.match(app, /if \(!timetableHistoryActive\) \{[\s\S]*timetableHistoryController\.reset\(\)/)
  assert.match(main, /CloudRouteApp/)
  assert.match(main, /createLocalAppReturnUrl/)
  assert.match(eventList, /運営向けLive TTを開く/)
  assert.match(page, /未保存の変更は反映されません/)
  assert.match(page, /mode: 'create'/)
  assert.doesNotMatch(page, /mode: 'replace'/)
  assert.match(page, /LIVE_TIMETABLE_REALTIME_COLUMNS/)
  assert.match(page, /loadAuthorized/)
  assert.doesNotMatch(page, /loadEvent|createSupabaseCloudEventRepository/)
  assert.match(page, /post-mutation/)
  assert.match(page, /createPostMutationReadBarrier/)
  assert.match(page, /minimumRequiredSequence: freshnessRequiredSequenceRef\.current/)
  assert.match(page, /if \(mutationPendingRef\.current\) return/)
  assert.match(page, /mutationPendingRef\.current = true/)
  assert.match(page, /mutationPendingRef\.current = false/)
  assert.match(page, /navigator\.onLine/)
  assert.match(page, /document\.visibilityState/)
  assert.match(page, /createLivePollingTimerController/)
  assert.match(page, /runLiveAuthorizedReadWithDeadline/)
  assert.match(page, /activeReadControllerRef\.current\?\.abort\(\)/)
  assert.match(page, /pollingTimer\.cancel\(\)/)
  assert.match(page, /if \(isCurrent\(\)\) schedule\(\)/)
  assert.match(page, /setFreshnessVerificationPending\(true\)/)
  assert.match(page, /setFreshnessVerificationPending\(false\)/)
  assert.match(page, /canDispatchConfirmedLiveMutation/)
  assert.match(page, /now: Date\.now\(\)/)
  assert.match(page, /pre-mutation-confirmation/)
  assert.match(page, /formatLiveTimetableTimestamp\(entry\.actualStartedAt, live\.timeZone\)/)
  assert.match(page, /const discoveryState = await discover\(\)/)
  assert.match(page, /作成結果を確認できませんでした/)
  assert.match(page, /role=\{feedback\.kind === 'error' \? 'alert' : 'status'\}/)
  assert.match(page, /担当候補を再取得/)
  assert.match(page, /Live TTの作成状況を再確認/)
  assert.match(page, /if \(!candidateLive\?\.canManage\) return/)
  assert.match(page, /canApplyLiveOperatorCandidateRead/)
  assert.match(page, /resolveLiveOperatorCandidateSelection/)
  assert.match(page, /createInvalidatedLiveOperatorCandidateRead/)
  assert.equal(
    page.match(/handleBeforeAccountAction\('sign-out'\)/g)?.length,
    2,
  )
  assert.equal(
    page.match(/handleBeforeAccountAction\('workspace-switch'\)/g)?.length,
    2,
  )
  assert.match(page, /describeLiveStageManagementTarget\(stage, live\.eventDays\)/)
  assert.match(page, /left\.eventDayPosition - right\.eventDayPosition/)
  assert.match(page, /setCandidates\(\[\]\)/)
  assert.doesNotMatch(page, /localStorage|sessionStorage/)
})

