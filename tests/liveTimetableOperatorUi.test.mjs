import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createLiveTimetableRepository,
  createSupabaseLiveTimetableGateway,
  parseAuthorizedLiveTimetable,
  parseLiveTimetableDiscovery,
  parseLiveTimetableOperatorCandidates,
  parsePublicLiveTimetable,
} from '../src/live/liveTimetableRepository.ts'
import {
  createRetainedEditorAccountGuardRegistry,
  createLiveTimetableHash,
  createLiveTimetableRouteInstanceKey,
  createLocalAppReturnUrl,
  resolveRetainedEditorAccountGuardDecision,
  resolveLiveTimetableHash,
  shouldKeepCloudEditorMounted,
} from '../src/live/liveTimetableRouting.ts'
import { formatLiveTimetableTimestamp } from '../src/live/liveTimetablePresentation.ts'
import {
  LIVE_TIMETABLE_REALTIME_COLUMNS,
  LIVE_AUTHORIZED_READ_TIMEOUT_MS,
  LIVE_HEALTHY_POLLING_INTERVAL_MS,
  LIVE_MUTATION_WAIT_TIMEOUT_MS,
  LIVE_STATE_MAX_AGE_MS,
  canApplyLiveOperatorCandidateRead,
  canApplyLiveRead,
  canApplyLatestScopedRequest,
  canDispatchConfirmedLiveMutation,
  canResolveLiveMutationReconciliation,
  canRunLiveMutation,
  createInvalidatedLiveOperatorCandidateRead,
  createLivePollingTimerController,
  createPostMutationReadBarrier,
  createLiveTimetableScopeKey,
  describeLiveStageManagementTarget,
  getLivePollingDelay,
  isLiveEntryTransitionReconciled,
  isLiveOperatorMutationReconciled,
  isLiveStateStale,
  isLiveTimetableReadAtLeastAsFresh,
  isMatchingLiveRealtimePayload,
  resolveLiveOperatorCandidateSelection,
  runLiveAuthorizedReadWithDeadline,
  runLiveMutationWithDeadline,
} from '../src/live/liveTimetableSync.ts'
import {
  consumeNativeDialogActivityClose,
  synchronizeNativeDialogActivity,
} from '../src/ui/nativeDialogActivityState.ts'

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
  sourceRevision: '1',
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

const createAuthorizedRpcValue = options => {
  const value = structuredClone(createLive(options))
  const {
    role, canManage, operators, stages,
    ...live
  } = value
  return {
    status: 'ok',
    live,
    permissions: { role, canManage },
    operators,
    stages,
  }
}

const createPublicRpcValue = options => {
  const value = structuredClone(createLive(options))
  return {
    status: 'ok',
    live: {
      publicId: value.publicId,
      eventName: value.eventName,
      timeZone: value.timeZone,
      projectionVersion: value.projectionVersion,
      managementRevision: value.managementRevision,
      eventDays: value.eventDays.map(({ date, position }) => ({ date, position })),
    },
    stages: value.stages.map(stage => ({
      name: stage.name,
      eventDayPosition: stage.eventDayPosition,
      position: stage.position,
      plannedStartTime: stage.plannedStartTime,
      plannedEndTime: stage.plannedEndTime,
      sections: stage.sections.map(section => ({
        name: section.name,
        position: section.position,
        plannedStartTime: section.plannedStartTime,
        plannedEndTime: section.plannedEndTime,
      })),
      revision: stage.revision,
      projectionVersion: stage.projectionVersion,
      progressStatus: stage.progressStatus,
      currentEntryPosition: stage.currentEntryPosition,
      nextEntryPosition: stage.nextEntryPosition,
      nextPerformancePosition: stage.nextPerformancePosition,
      updatedAt: stage.updatedAt,
      entries: stage.entries.map(entry => ({
        position: entry.position,
        kind: entry.kind,
        displayName: entry.displayName,
        plannedStartMinute: entry.plannedStartMinute,
        plannedEndMinute: entry.plannedEndMinute,
        status: entry.status,
        actualStartedAt: entry.actualStartedAt,
        actualEndedAt: entry.actualEndedAt,
      })),
    })),
  }
}

test('Live routeはEvent IDを安全に往復し#shareと混同しない', () => {
  const hash = createLiveTimetableHash('event/日本語 & live')
  assert.deepEqual(resolveLiveTimetableHash(hash), {
    kind: 'live', eventId: 'event/日本語 & live',
  })
  assert.equal(resolveLiveTimetableHash('#share=payload'), undefined)
  assert.equal(resolveLiveTimetableHash('#live='), undefined)
  assert.equal(resolveLiveTimetableHash('#live=%E0%A4%A'), undefined)
  assert.notEqual(
    createLiveTimetableRouteInstanceKey('workspace-a', 'event-a'),
    createLiveTimetableRouteInstanceKey('workspace-a', 'event-b'),
  )
  assert.notEqual(
    createLiveTimetableRouteInstanceKey('workspace-a', 'event-a'),
    createLiveTimetableRouteInstanceKey('workspace-b', 'event-a'),
  )
  assert.equal(shouldKeepCloudEditorMounted(false, { kind: 'live', eventId: 'a' }), false)
  assert.equal(shouldKeepCloudEditorMounted(false, undefined), true)
  assert.equal(shouldKeepCloudEditorMounted(true, { kind: 'live', eventId: 'a' }), true)
  assert.equal(createLocalAppReturnUrl('/app/', '?mode=local'), '/app/?mode=local')
})

test('retained editor account guardはdraft・scope・登録解除をfail closedで扱う', () => {
  const registry = createRetainedEditorAccountGuardRegistry()
  const draft = { dirty: true, value: 'unsaved' }
  const releaseA = registry.register('visit-a', () =>
    resolveRetainedEditorAccountGuardDecision({
      cloudNavigationLocked: false,
      editorNavigationAllowed: !draft.dirty,
    }))

  assert.deepEqual(registry.canRun({
    required: true, scopeKey: 'visit-a', action: 'sign-out',
  }), { allowed: false, reason: 'editor-state' })
  assert.deepEqual(registry.canRun({
    required: true, scopeKey: 'visit-a', action: 'workspace-switch',
  }), { allowed: false, reason: 'editor-state' })
  assert.equal(draft.value, 'unsaved')
  assert.deepEqual(registry.canRun({
    required: true, scopeKey: 'visit-b', action: 'sign-out',
  }), { allowed: false, reason: 'guard-unavailable' })

  draft.dirty = false
  assert.deepEqual(registry.canRun({
    required: true, scopeKey: 'visit-a', action: 'sign-out',
  }), { allowed: true })

  const releaseB = registry.register('visit-b', () => ({ allowed: true }))
  releaseA()
  assert.deepEqual(registry.canRun({
    required: true, scopeKey: 'visit-b', action: 'workspace-switch',
  }), { allowed: true }, 'stale cleanup must not clear the current registration')
  releaseB()
  assert.deepEqual(registry.canRun({
    required: true, scopeKey: 'visit-b', action: 'sign-out',
  }), { allowed: false, reason: 'guard-unavailable' })
  assert.deepEqual(registry.canRun({
    required: false, scopeKey: 'direct-live', action: 'sign-out',
  }), { allowed: true }, 'direct #live must not require editor hydration')
})

test('retained editor account guardはCloud処理lockをdraftより先に判定する', () => {
  assert.deepEqual(resolveRetainedEditorAccountGuardDecision({
    cloudNavigationLocked: true,
    editorNavigationAllowed: true,
  }), { allowed: false, reason: 'cloud-operation' }, 'pending + clean')
  assert.deepEqual(resolveRetainedEditorAccountGuardDecision({
    cloudNavigationLocked: true,
    editorNavigationAllowed: false,
  }), { allowed: false, reason: 'cloud-operation' }, 'pending + dirty')
  assert.deepEqual(resolveRetainedEditorAccountGuardDecision({
    cloudNavigationLocked: false,
    editorNavigationAllowed: true,
  }), { allowed: true }, 'save success/failure後にlockが解除されcleanなら許可')
  assert.deepEqual(resolveRetainedEditorAccountGuardDecision({
    cloudNavigationLocked: false,
    editorNavigationAllowed: false,
  }), { allowed: false, reason: 'editor-state' }, 'lock解除後もdraftは拒否')
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
  assert.equal(isLiveStateStale(1_000, 46_000), true)
  assert.equal(isLiveStateStale(1_001, 1_000), true)
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

test('authorized parserはowner専用operator情報をscopeと一意性まで検証する', () => {
  const owner = createAuthorizedRpcValue({ role: 'owner' })
  owner.operators = [{
    stageId: owner.stages[0].stageId,
    userId,
    assignedAt: '2026-10-21T00:00:01.000Z',
  }]
  assert.equal(parseAuthorizedLiveTimetable(owner)?.operators.length, 1)

  const leaked = structuredClone(owner)
  leaked.permissions = { role: 'editor', canManage: false }
  assert.equal(parseAuthorizedLiveTimetable(leaked), undefined)

  const duplicate = structuredClone(owner)
  duplicate.operators.push(structuredClone(duplicate.operators[0]))
  assert.equal(parseAuthorizedLiveTimetable(duplicate), undefined)

  const unknownStage = structuredClone(owner)
  unknownStage.operators[0].stageId =
    '40000000-0000-0000-0000-000000000099'
  assert.equal(parseAuthorizedLiveTimetable(unknownStage), undefined)
})

test('Live read parserはDBと同じ階層・revision・実績時刻契約を要求する', () => {
  const authorized = createAuthorizedRpcValue({ role: 'owner' })
  assert.notEqual(parseAuthorizedLiveTimetable(authorized), undefined)

  for (const damage of [
    value => { value.live.eventDays[0].position = 1 },
    value => { value.stages[0].sourceEventDayId = 'unknown-day' },
    value => { value.stages[0].projectionVersion = '2' },
    value => { value.stages[0].plannedStartTime = '29:99' },
    value => {
      value.stages[0].entries[0].actualStartedAt =
        '2026-10-21T00:00:01.000Z'
    },
    value => { value.stages[0].entries[0].sourceSectionId = '' },
    value => { value.stages[0].entries[0].startedBy = userId },
  ]) {
    const invalid = structuredClone(authorized)
    damage(invalid)
    assert.equal(parseAuthorizedLiveTimetable(invalid), undefined)
  }

  const inProgressWithoutActor = structuredClone(authorized)
  Object.assign(inProgressWithoutActor.stages[0].entries[0], {
    status: 'in_progress',
    actualStartedAt: '2026-10-21T00:00:01.000Z',
    startedBy: null,
  })
  Object.assign(inProgressWithoutActor.stages[0], {
    progressStatus: 'in_progress',
    currentEntryPosition: 0,
    nextEntryPosition: null,
    nextPerformancePosition: null,
  })
  assert.equal(parseAuthorizedLiveTimetable(inProgressWithoutActor), undefined)

  const publicResponse = createPublicRpcValue()
  assert.notEqual(parsePublicLiveTimetable(publicResponse), undefined)
  publicResponse.stages[0].projectionVersion = '2'
  assert.equal(parsePublicLiveTimetable(publicResponse), undefined)
})

test('Repository readは要求したLive・公開IDと応答identityを照合する', async () => {
  const authorized = createAuthorizedRpcValue({ role: 'owner' })
  const publicResponse = createPublicRpcValue()
  const gateway = {
    async createProjection() { return { data: null, error: null } },
    async loadAuthorized() { return { data: authorized, error: null } },
    async loadPublic() { return { data: publicResponse, error: null } },
    async findForEvent() { return { data: null, error: null } },
    async listOperatorCandidates() { return { data: null, error: null } },
    async setPublication() { return { data: null, error: null } },
    async setStageOperator() { return { data: null, error: null } },
    async transitionEntry() { return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  assert.equal((await repository.loadAuthorized(liveId)).ok, true)
  assert.equal((await repository.loadPublic(publicResponse.live.publicId)).ok, true)

  const otherLiveId = '10000000-0000-0000-0000-000000000099'
  const otherPublicId = '10000000-0000-0000-0000-000000000098'
  assert.equal((await repository.loadAuthorized(otherLiveId)).error.code,
    'INVALID_RESPONSE')
  assert.equal((await repository.loadPublic(otherPublicId)).error.code,
    'INVALID_RESPONSE')

  assert.equal(parseAuthorizedLiveTimetable(authorized)?.liveId, liveId)
  assert.equal(parsePublicLiveTimetable(publicResponse)?.publicId,
    publicResponse.live.publicId)
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

test('native dialogはApp非active中だけtop layerから外れdraftを保持して復帰する', () => {
  const draft = { eventName: '入力途中', validationError: '日付を確認してください' }
  const dialog = {
    open: false,
    isConnected: true,
    showCount: 0,
    closeCount: 0,
    showModal() {
      this.showCount += 1
      this.open = true
    },
    close() {
      this.closeCount += 1
      this.open = false
    },
  }

  assert.equal(synchronizeNativeDialogActivity(dialog, true), 'opened')
  assert.equal(synchronizeNativeDialogActivity(dialog, true), 'unchanged')
  assert.equal(dialog.showCount, 1)
  assert.equal(synchronizeNativeDialogActivity(dialog, false, true), 'suspended')
  assert.equal(dialog.open, false)
  assert.equal(consumeNativeDialogActivityClose(dialog), true)
  assert.equal(consumeNativeDialogActivityClose(dialog), false)
  assert.deepEqual(draft, {
    eventName: '入力途中', validationError: '日付を確認してください',
  })
  assert.equal(synchronizeNativeDialogActivity(dialog, true), 'opened')
  assert.equal(dialog.showCount, 2)
  assert.equal(dialog.closeCount, 1)
})

test('切断済みnative dialogやStrictMode相当の重複cleanupは再表示しない', () => {
  const dialog = {
    open: true,
    isConnected: true,
    showCount: 0,
    closeCount: 0,
    showModal() { this.showCount += 1; this.open = true },
    close() { this.closeCount += 1; this.open = false },
  }
  assert.equal(synchronizeNativeDialogActivity(dialog, false), 'suspended')
  assert.equal(synchronizeNativeDialogActivity(dialog, false), 'unchanged')
  dialog.isConnected = false
  assert.equal(synchronizeNativeDialogActivity(dialog, true), 'unchanged')
  assert.equal(dialog.showCount, 0)
  assert.equal(dialog.closeCount, 1)
})

test('mutation deadlineはserver処理を取消扱いせずpendingを解放しlate結果を無視する', async () => {
  let timerCallback
  let finishMutation
  const pendingMutation = new Promise(resolve => { finishMutation = resolve })
  let onResultCount = 0
  let pending = true
  let reconciliationPending = false

  const operation = runLiveMutationWithDeadline({
    mutation: () => pendingMutation,
    timeoutMilliseconds: LIVE_MUTATION_WAIT_TIMEOUT_MS,
    setTimer(callback) { timerCallback = callback; return 1 },
    clearTimer() {},
  }).then(outcome => {
    if (outcome.status === 'completed') onResultCount += 1
    if (outcome.status === 'timed-out') reconciliationPending = true
    pending = false
    return outcome
  })

  await Promise.resolve()
  timerCallback()
  assert.deepEqual(await operation, { status: 'timed-out' })
  assert.equal(pending, false)
  assert.equal(reconciliationPending, true)
  assert.equal(onResultCount, 0)

  finishMutation({ ok: true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(onResultCount, 0)
  assert.equal(reconciliationPending, true)
})

test('結果不明mutationは同一scopeのauthorized readが期待revisionを確認するまで解消しない', () => {
  const before = createLive({ managementRevision: '5' })
  const reconciliation = {
    operationId: 9,
    scopeKey: 'scope-a',
    liveId,
    confirms: current => current.isPublished === false &&
      BigInt(current.managementRevision) > 5n,
  }
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-a',
    current: before,
  }), false)
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-b',
    current: { ...before, isPublished: false, managementRevision: '6' },
  }), false)
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-a',
    current: { ...before, isPublished: false, managementRevision: '6' },
  }), true)
})

test('operator結果不明は後続管理操作があっても対象Stage/Userの到達状態で解消する', () => {
  const before = createLive({ managementRevision: '5' })
  const previousAssignedAt = '2026-10-21T00:00:00.000Z'
  const receiptAt = '2026-10-21T00:01:00.000Z'
  const laterReceiptAt = '2026-10-21T00:02:00.000Z'
  const otherUserId = '30000000-0000-0000-0000-000000000002'
  const otherStage = {
    ...before.stages[0],
    stageId: '40000000-0000-0000-0000-000000000002',
    sourceStageId: 'stage-b',
    name: 'Sub',
    position: 1,
  }
  const target = {
    stageId: before.stages[0].stageId,
    operatorUserId: userId,
    assigned: true,
    previousManagementRevision: '5',
    previousAssignedAt,
  }
  const assigned = {
    ...before,
    managementRevision: '6',
    updatedAt: receiptAt,
    stages: [{ ...before.stages[0], updatedAt: receiptAt }],
    operators: [{ stageId: target.stageId, userId, assignedAt: receiptAt }],
  }
  assert.equal(isLiveOperatorMutationReconciled({ current: assigned, target }), true)
  assert.equal(isLiveOperatorMutationReconciled({
    current: { ...assigned, managementRevision: '5' }, target,
  }), false, 'unchanged revision')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      stages: before.stages,
      operators: [{
        stageId: target.stageId, userId, assignedAt: previousAssignedAt,
      }],
    },
    target,
  }), false, 'unrelated management revision')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      operators: [{
        stageId: target.stageId, userId, assignedAt: previousAssignedAt,
      }],
    },
    target,
  }), false, 'same-stage unrelated operator mutation')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      managementRevision: '7',
      updatedAt: laterReceiptAt,
      stages: [
        { ...assigned.stages[0], updatedAt: receiptAt },
        { ...otherStage, updatedAt: laterReceiptAt },
      ],
      operators: [
        ...assigned.operators,
        { stageId: otherStage.stageId, userId: otherUserId, assignedAt: laterReceiptAt },
      ],
    },
    target,
  }), true, 'a later different-stage command does not hide the target receipt')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      managementRevision: '8',
      updatedAt: laterReceiptAt,
      stages: [{ ...assigned.stages[0], updatedAt: laterReceiptAt }],
      operators: [
        ...assigned.operators,
        { stageId: target.stageId, userId: otherUserId, assignedAt: laterReceiptAt },
      ],
    },
    target,
  }), true, 'a later same-stage command for another user preserves target evidence')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      managementRevision: '7',
      updatedAt: laterReceiptAt,
      stages: [{ ...assigned.stages[0], updatedAt: laterReceiptAt }],
      operators: [{
        stageId: target.stageId, userId, assignedAt: previousAssignedAt,
      }],
    },
    target,
  }), false, 'revision advancement alone is not target-row evidence')
  assert.equal(isLiveOperatorMutationReconciled({
    current: assigned,
    target: { ...target, stageId: '40000000-0000-0000-0000-000000000099' },
  }), false)
  assert.equal(isLiveOperatorMutationReconciled({
    current: assigned,
    target: { ...target, operatorUserId: '30000000-0000-0000-0000-000000000099' },
  }), false)
  assert.equal(isLiveOperatorMutationReconciled({
    current: { ...assigned, operators: [] },
    target: { ...target, assigned: false },
  }), true, 'observed assignment removal also requires a durable revision receipt')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      managementRevision: '9',
      updatedAt: laterReceiptAt,
      stages: [assigned.stages[0], otherStage],
      operators: [{
        stageId: otherStage.stageId, userId: otherUserId, assignedAt: laterReceiptAt,
      }],
    },
    target: { ...target, assigned: false },
  }), true, 'later different-stage changes do not hide an observed removal')
  assert.equal(isLiveOperatorMutationReconciled({
    current: { ...assigned, operators: [] },
    target: { ...target, assigned: false, previousAssignedAt: undefined },
  }), false, 'an already-absent removal has no target-row receipt')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      managementRevision: '7',
      operators: [{ stageId: target.stageId, userId, assignedAt: receiptAt }],
    },
    target: { ...target, previousAssignedAt: receiptAt },
  }), false, 'an unrelated revision cannot prove an unchanged no-op assignment')
  assert.equal(isLiveOperatorMutationReconciled({
    current: {
      ...assigned,
      managementRevision: '7',
      operators: [{ stageId: target.stageId, userId, assignedAt: laterReceiptAt }],
    },
    target: { ...target, previousAssignedAt: receiptAt },
  }), true, 'a no-op reassignment is proved by its refreshed assignedAt receipt')
  assert.equal(isLiveOperatorMutationReconciled({
    current: { ...assigned, managementRevision: '9223372036854775807' },
    target: {
      ...target,
      previousManagementRevision: '9007199254740993',
    },
  }), true, 'PostgreSQL bigint revisions are compared without number coercion')
  assert.equal(isLiveOperatorMutationReconciled({
    current: { ...assigned, managementRevision: 'not-a-revision' }, target,
  }), false, 'invalid current revision fails closed')
  assert.equal(isLiveOperatorMutationReconciled({
    current: assigned,
    target: { ...target, previousManagementRevision: '01' },
  }), false, 'invalid previous revision fails closed')
})

test('operator結果不明の解除は同一scope・Liveの新しいauthorized readだけが行う', () => {
  const before = createLive({ managementRevision: '5' })
  const receiptAt = '2026-10-21T00:01:00.000Z'
  const target = {
    stageId: before.stages[0].stageId,
    operatorUserId: userId,
    assigned: true,
    previousManagementRevision: before.managementRevision,
    previousAssignedAt: undefined,
  }
  const reconciliation = {
    operationId: 10,
    scopeKey: 'scope-a',
    liveId,
    confirms: current => isLiveOperatorMutationReconciled({ current, target }),
  }
  const reconciled = {
    ...before,
    managementRevision: '7',
    operators: [{ stageId: target.stageId, userId, assignedAt: receiptAt }],
  }

  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-a',
    current: before,
  }), false, 'an old authorized read keeps navigation and account actions blocked')
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-b',
    current: reconciled,
  }), false, 'a different scope cannot clear the block')
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-a',
    current: { ...reconciled, liveId: '10000000-0000-0000-0000-000000000099' },
  }), false, 'a different Live cannot clear the block')
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-a',
    current: reconciled,
  }), true, 'matching authorized read clears the reconciliation block')
})

test('start結果不明は対象entryが別端末で終了済みでも開始記録とrevision前進で解消する', () => {
  const target = {
    operation: 'start',
    stageId: '40000000-0000-0000-0000-000000000001',
    sourceStageId: 'stage-a',
    sourceScheduleItemId: 'item-a',
    previousStageRevision: '1',
  }
  const withEntry = (overrides = {}, stageOverrides = {}) => {
    const current = createLive({ stageRevision: stageOverrides.revision ?? '2' })
    return {
      ...current,
      stages: [{
        ...current.stages[0],
        ...stageOverrides,
        entries: [{ ...current.stages[0].entries[0], ...overrides }],
      }],
    }
  }
  const inProgress = withEntry({
    status: 'in_progress', actualStartedAt: '2026-10-22T01:00:00Z',
  })
  const completed = withEntry({
    status: 'completed',
    actualStartedAt: '2026-10-22T01:00:00Z',
    actualEndedAt: '2026-10-22T01:10:00Z',
  })
  assert.equal(isLiveEntryTransitionReconciled({ current: inProgress, target }), true)
  assert.equal(isLiveEntryTransitionReconciled({ current: completed, target }), true)
  assert.equal(isLiveEntryTransitionReconciled({
    current: withEntry({ status: 'pending', actualStartedAt: null }), target,
  }), false)
  assert.equal(isLiveEntryTransitionReconciled({
    current: withEntry({ status: 'completed', actualStartedAt: null }), target,
  }), false)
  assert.equal(isLiveEntryTransitionReconciled({
    current: withEntry({
      status: 'completed', actualStartedAt: '2026-10-22T01:00:00Z',
    }, { revision: '1' }), target,
  }), false, 'stale read/revision前進なし')
  assert.equal(isLiveEntryTransitionReconciled({
    current: completed, target: { ...target, stageId: 'different-stage' },
  }), false)
  assert.equal(isLiveEntryTransitionReconciled({
    current: completed, target: { ...target, sourceStageId: 'different-source-stage' },
  }), false)
  assert.equal(isLiveEntryTransitionReconciled({
    current: completed, target: { ...target, sourceScheduleItemId: 'different-item' },
  }), false)

  const reconciliation = {
    operationId: 10,
    scopeKey: 'scope-a',
    liveId,
    confirms: current => isLiveEntryTransitionReconciled({ current, target }),
  }
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation, activeScopeKey: 'scope-b', current: completed,
  }), false, '別scope')
  assert.equal(canResolveLiveMutationReconciliation({
    reconciliation,
    activeScopeKey: 'scope-a',
    current: { ...completed, liveId: 'different-live' },
  }), false, '別Live')
})

test('end結果不明はcompletedかつ終了記録とrevision前進のときだけ解消する', () => {
  const base = createLive({ stageRevision: '2' })
  const current = status => ({
    ...base,
    stages: [{
      ...base.stages[0],
      entries: [{
        ...base.stages[0].entries[0],
        status,
        actualStartedAt: '2026-10-22T01:00:00Z',
        actualEndedAt: status === 'completed' ? '2026-10-22T01:10:00Z' : null,
      }],
    }],
  })
  const target = {
    operation: 'end',
    stageId: base.stages[0].stageId,
    sourceStageId: base.stages[0].sourceStageId,
    sourceScheduleItemId: 'item-a',
    previousStageRevision: '1',
  }
  assert.equal(isLiveEntryTransitionReconciled({
    current: current('completed'), target,
  }), true)
  assert.equal(isLiveEntryTransitionReconciled({
    current: current('in_progress'), target,
  }), false, 'end未完了')
  const missingEnd = current('completed')
  missingEnd.stages[0].entries[0].actualEndedAt = null
  assert.equal(isLiveEntryTransitionReconciled({ current: missingEnd, target }), false)
})

test('discovery retryは同一scopeでも最新sequenceだけを適用する', () => {
  const tokenA = { scopeKey: 'scope-a', sequence: 1 }
  const tokenB = { scopeKey: 'scope-a', sequence: 2 }
  assert.equal(canApplyLatestScopedRequest({
    token: tokenA,
    activeScopeKey: 'scope-a',
    latestStartedSequence: tokenB.sequence,
  }), false)
  assert.equal(canApplyLatestScopedRequest({
    token: tokenB,
    activeScopeKey: 'scope-a',
    latestStartedSequence: tokenB.sequence,
  }), true)
  assert.equal(canApplyLatestScopedRequest({
    token: tokenB,
    activeScopeKey: 'scope-b',
    latestStartedSequence: tokenB.sequence,
  }), false)
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

test('discoveryと担当候補readもSupabase adapterへAbortSignalを渡す', async () => {
  const calls = []
  const response = { data: null, error: null }
  const client = {
    rpc(name) {
      return {
        abortSignal(signal) {
          calls.push([name, signal])
          return Promise.resolve(response)
        },
        then(resolve, reject) {
          return Promise.resolve(response).then(resolve, reject)
        },
      }
    },
  }
  const gateway = createSupabaseLiveTimetableGateway(client)
  const discoveryController = new AbortController()
  const candidateController = new AbortController()
  await gateway.findForEvent({ workspaceId, eventId: 'event-a' },
    discoveryController.signal)
  await gateway.listOperatorCandidates(liveId, candidateController.signal)
  assert.deepEqual(calls, [
    ['find_live_timetable_for_event_authorized', discoveryController.signal],
    ['list_live_timetable_operator_candidates', candidateController.signal],
  ])
})

test('Supabase adapterはmutation対象の期待identityをRPCへ渡す', async () => {
  const calls = []
  const expectedStageId = '10000000-0000-0000-0000-000000000003'
  const client = {
    rpc(name, params) {
      calls.push([name, params])
      return Promise.resolve({ data: null, error: null })
    },
  }
  const gateway = createSupabaseLiveTimetableGateway(client)
  await gateway.setStageOperator({
    liveId,
    sourceStageId: 'stage-main',
    expectedStageId,
    operatorUserId: userId,
    assign: true,
    expectedManagementRevision: '4',
    expectedProjectionVersion: '2',
  })
  await gateway.transitionEntry({
    operation: 'start',
    liveId,
    sourceStageId: 'stage-main',
    expectedStageId,
    sourceScheduleItemId: 'item-main',
    expectedEntryPosition: 7,
    expectedStageRevision: '8',
    expectedProjectionVersion: '2',
  })
  assert.deepEqual(calls, [
    ['set_live_timetable_stage_operator', {
      p_live_id: liveId,
      p_source_stage_id: 'stage-main',
      p_expected_stage_id: expectedStageId,
      p_operator_user_id: userId,
      p_assign: true,
      p_expected_management_revision: '4',
      p_expected_projection_version: '2',
    }],
    ['start_live_timetable_entry', {
      p_live_id: liveId,
      p_source_stage_id: 'stage-main',
      p_expected_stage_id: expectedStageId,
      p_source_schedule_item_id: 'item-main',
      p_expected_entry_position: 7,
      p_expected_stage_revision: '8',
      p_expected_projection_version: '2',
    }],
  ])
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

test('担当候補Aのtimeout後にretry Bだけを適用しAのlate成功を無視する', async () => {
  let timerId = 0
  const timers = new Map()
  const timerOptions = {
    setTimer(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimer(id) { timers.delete(id) },
  }
  let finishA
  const pendingA = new Promise(resolve => { finishA = resolve })
  let latestSequence = 1
  let loading = true
  let candidates = []
  const tokenA = { liveId, scopeKey: 'scope-a', sequence: 1 }
  const controllerA = new AbortController()
  const requestA = runLiveAuthorizedReadWithDeadline({
    controller: controllerA,
    read: () => pendingA,
    ...timerOptions,
  }).then(outcome => {
    if (!canApplyLiveOperatorCandidateRead({
      token: tokenA,
      activeLiveId: liveId,
      activeScopeKey: 'scope-a',
      latestStartedSequence: latestSequence,
    })) return
    loading = false
    if (outcome.status === 'completed') candidates = outcome.value
  })
  timers.values().next().value()
  await requestA
  assert.equal(loading, false)
  assert.deepEqual(candidates, [])

  const tokenB = { liveId, scopeKey: 'scope-a', sequence: ++latestSequence }
  loading = true
  const controllerB = new AbortController()
  const outcomeB = await runLiveAuthorizedReadWithDeadline({
    controller: controllerB,
    read: async () => [{ userId: 'candidate-b' }],
    ...timerOptions,
  })
  if (outcomeB.status === 'completed' && canApplyLiveOperatorCandidateRead({
    token: tokenB,
    activeLiveId: liveId,
    activeScopeKey: 'scope-a',
    latestStartedSequence: latestSequence,
  })) candidates = outcomeB.value
  loading = false
  assert.deepEqual(candidates, [{ userId: 'candidate-b' }])
  assert.equal(loading, false)

  finishA([{ userId: 'candidate-a' }])
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(candidates, [{ userId: 'candidate-b' }])
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
  ), true)
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
  ), true)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, live_timetable_id: 'other' }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, progress_status: 'unknown' }, workspaceId, liveId,
  ), false)
})

test('Realtime bigint列は正のnumberとPostgreSQL bigint文字列を通知として受理する', () => {
  const row = {
    id: '40000000-0000-0000-0000-000000000001',
    workspace_id: workspaceId,
    live_timetable_id: liveId,
    projection_version: 1,
    revision: 2,
    progress_status: 'in_progress',
    updated_at: '2026-10-21T00:00:00.000Z',
  }
  const acceptedValues = [
    1,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    '9007199254740992',
    '9223372036854775807',
  ]
  for (const value of acceptedValues) {
    assert.equal(isMatchingLiveRealtimePayload(
      { ...row, projection_version: value, revision: value }, workspaceId, liveId,
    ), true, `expected accepted Realtime bigint signal: ${String(value)}`)
  }

  const rejectedValues = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_VALUE,
    '',
    '0',
    '-1',
    '01',
    '1.0',
    '1e3',
    '9223372036854775808',
  ]
  for (const value of rejectedValues) {
    assert.equal(isMatchingLiveRealtimePayload(
      { ...row, projection_version: value }, workspaceId, liveId,
    ), false, `expected rejected projection_version: ${String(value)}`)
    assert.equal(isMatchingLiveRealtimePayload(
      { ...row, revision: value }, workspaceId, liveId,
    ), false, `expected rejected revision: ${String(value)}`)
  }
})

test('Live discoveryはsafe numberを文字列へ正規化しbigint最大値を保持する', () => {
  const revision = 2147483648
  const result = parseLiveTimetableDiscovery({
    status: 'ok',
    workspaceId,
    eventId: 'event-a',
    eventName: 'Event A',
    sourceRevision: revision,
    liveId: null,
  }, workspaceId, 'event-a')

  assert.equal(result?.sourceRevision, String(revision))
  const maxRevision = '9223372036854775807'
  assert.equal(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: maxRevision, liveId,
  }, workspaceId, 'event-a')?.sourceRevision, maxRevision)
  const authorized = createAuthorizedRpcValue({ role: 'owner' })
  authorized.live.sourceRevision = maxRevision
  assert.equal(parseAuthorizedLiveTimetable(authorized)?.sourceRevision, maxRevision)
})

test('discovery/candidate parserはexact responseとID一意性を要求する', () => {
  assert.deepEqual(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId: null,
  }, workspaceId, 'event-a'), {
    workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: '3', liveId: null,
  })
  assert.equal(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId, extra: true,
  }, workspaceId, 'event-a'), undefined)
  for (const sourceRevision of [
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    '01',
    '1e3',
    '9223372036854775808',
  ]) {
    assert.equal(parseLiveTimetableDiscovery({
      status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
      sourceRevision, liveId,
    }, workspaceId, 'event-a'), undefined, String(sourceRevision))
  }
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
      sourceRevision: '7', liveId,
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

test('discoveryだけはP0002をEvent不存在へ変換し他RPCのLive不存在を維持する', async () => {
  const gateway = {
    async createProjection() { return { data: null, error: null } },
    async loadAuthorized() { return { data: null, error: { code: 'P0002' } } },
    async loadPublic() { return { data: null, error: null } },
    async findForEvent() { return { data: null, error: { code: 'P0002' } } },
    async listOperatorCandidates() { return { data: null, error: null } },
    async setPublication() { return { data: null, error: null } },
    async setStageOperator() { return { data: null, error: null } },
    async transitionEntry() { return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  const discovery = await repository.findForEvent(workspaceId, 'missing-event')
  assert.equal(discovery.ok, false)
  assert.deepEqual(discovery.error, {
    code: 'EVENT_NOT_FOUND',
    message: 'Cloudに保存されたEventが見つかりません。通常のイベント編集画面でCloudへ保存してから、Live TTを開いてください。',
  })
  assert.equal((await repository.loadAuthorized(liveId)).error.code, 'LIVE_NOT_FOUND')
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
  assert.match(sql, /created_at = excluded\.created_at/i)
  assert.match(sql,
    /previous_assignment_at[\s\S]*for update[\s\S]*previous_assignment_at \+ interval '1 microsecond'/i)
  assert.match(sql, /load_live_timetable_authorized_v15[\s\S]*'assignedAt', assignment\.created_at/i)
  assert.match(sql, /add column public_view_enabled boolean not null default false/i)
  assert.match(sql, /is_published[\s\S]*public_view_enabled/i)
  assert.match(sql, /target_source_revision\s+bigint\s*;/i)
  assert.doesNotMatch(sql, /target_source_revision\s+integer\s*;/i)
  assert.match(sql, /'sourceRevision', target_source_revision::text/i)
  assert.match(sql,
    /load_live_timetable_authorized_v15[\s\S]*jsonb_typeof\(response #> '\{live,sourceRevision\}'\)[\s\S]*jsonb_set\([\s\S]*to_jsonb\(response #>> '\{live,sourceRevision\}'\)/i)
  for (const signature of [
    'load_live_timetable_projection_source_serialized',
    'create_or_replace_live_timetable_projection_serialized',
  ]) {
    assert.match(sql, new RegExp(`create function public\\.${signature}`, 'i'))
    assert.match(sql, new RegExp(
      `revoke all on function public\\.${signature}\\([\\s\\S]*from public, anon, authenticated, service_role`,
      'i',
    ))
    assert.match(sql, new RegExp(
      `grant execute on function public\\.${signature}\\([\\s\\S]*to service_role`,
      'i',
    ))
  }
  assert.match(sql,
    /load_live_timetable_projection_source_serialized\([\s\S]*security invoker[\s\S]*load_live_timetable_projection_source\([\s\S]*to_jsonb\(response ->> 'revision'\)/i)
  assert.match(sql,
    /create_or_replace_live_timetable_projection_serialized\([\s\S]*security invoker[\s\S]*create_or_replace_live_timetable_projection\([\s\S]*to_jsonb\(response ->> 'sourceRevision'\)/i)
  assert.match(sql, /create function public\.find_live_timetable_for_event_authorized/i)
  assert.match(sql, /create function public\.list_live_timetable_operator_candidates/i)
  assert.match(sql, /workspace_members\.role in \('editor', 'viewer'\)/i)
  assert.doesNotMatch(sql, /auth\.users[\s\S]*email/i)
  assert.match(sql, /revoke all on function public\.find_live_timetable_for_event_authorized[\s\S]*grant execute[\s\S]*to authenticated/i)
  assert.match(sql,
    /foreach signature in array array\[[\s\S]*public\.build_live_timetable_stages_json\(uuid,uuid,text,boolean\)[\s\S]*public\.load_live_timetable_authorized_v15\(uuid\)[\s\S]*has_function_privilege\(role_name, function_oid, 'EXECUTE'\)/i)
  assert.match(sql, /PUBLIC can execute internal helper/i)

  assert.match(sql,
    /drop function public\.set_live_timetable_stage_operator\(\s*uuid, text, uuid, boolean, text, text\s*\)/i)
  assert.match(sql,
    /create function public\.set_live_timetable_stage_operator\([\s\S]*p_expected_stage_id uuid/i)
  assert.match(sql,
    /create function public\.transition_live_timetable_entry\([\s\S]*p_expected_stage_id uuid[\s\S]*p_expected_entry_position integer/i)
  assert.match(sql,
    /create function public\.start_live_timetable_entry\([\s\S]*p_expected_stage_id uuid[\s\S]*p_expected_entry_position integer/i)
  assert.match(sql,
    /create function public\.end_live_timetable_entry\([\s\S]*p_expected_stage_id uuid[\s\S]*p_expected_entry_position integer/i)
  const operatorFunction = sql.slice(
    sql.indexOf('create function public.set_live_timetable_stage_operator'),
    sql.indexOf('revoke all on function public.set_live_timetable_stage_operator'),
  )
  assert.ok(operatorFunction.indexOf(
    'target_stage_id is distinct from p_expected_stage_id',
  ) < operatorFunction.indexOf(
    'insert into public.live_timetable_stage_operators',
  ))
  const transitionFunction = sql.slice(
    sql.indexOf('create function public.transition_live_timetable_entry'),
    sql.indexOf('revoke all on function public.transition_live_timetable_entry'),
  )
  assert.ok(transitionFunction.indexOf(
    'stage_row.id is distinct from p_expected_stage_id',
  ) < transitionFunction.indexOf(
    'update public.live_timetable_entries',
  ))
  assert.ok(transitionFunction.indexOf(
    'entry_row.position is distinct from p_expected_entry_position',
  ) < transitionFunction.indexOf(
    'update public.live_timetable_entries',
  ))
  assert.match(sql, /Legacy Live mutation overload remains/i)
})

test('Live UIは独立route・再read・確認・非永続scopeを維持する', async () => {
  const [page, routeApp, app, main, eventList, csvHelp, grid] = await Promise.all([
    readFile(new URL('../src/components/LiveTimetableOperatorPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/cloud/CloudRouteApp.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EventList.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/CsvImportHelpPopover.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/TimetableGrid.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(routeApp, /resolveLiveTimetableHash/)
  assert.match(routeApp,
    /key=\{createLiveTimetableRouteInstanceKey\([\s\S]*accountScopeKey,[\s\S]*route\.eventId/i)
  assert.match(routeApp, /editorMounted &&/)
  assert.match(routeApp, /hidden=\{route !== undefined\}/)
  assert.match(routeApp, /inert=\{route !== undefined\}/)
  assert.match(routeApp, /key=\{cloud\?\.workspaceVisitId\}/)
  assert.match(routeApp, /isActive=\{route === undefined\}/)
  assert.match(routeApp, /NativeDialogActivityProvider active=\{route === undefined\}/)
  assert.match(routeApp, /createRetainedEditorAccountGuardRegistry/)
  assert.match(routeApp, /required: editorMounted/)
  assert.match(app, /registerRetainedEditorAccountGuard/)
  assert.match(app, /retainedEditorAccountGuardRef\.current/)
  assert.match(
    app,
    /retainedEditorAccountGuardRef\.current[\s\S]*if \(appNavigationDisabled\)[\s\S]*cloudNavigationLocked: true[\s\S]*handleBeforeSignOut/,
  )
  assert.match(page, /Cloudへの保存・削除処理中です/)
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
  assert.match(page, /if \(mutationPendingRef\.current \|\| mutationReconciliationRef\.current\) return/)
  assert.match(page, /mutationPendingRef\.current = true/)
  assert.match(page, /mutationPendingRef\.current = false/)
  assert.match(page, /navigator\.onLine/)
  assert.match(page, /document\.visibilityState/)
  assert.match(page, /createLivePollingTimerController/)
  assert.match(page, /runLiveAuthorizedReadWithDeadline/)
  assert.match(page, /runLiveMutationWithDeadline/)
  assert.match(page, /mutationReconciliationRef/)
  assert.match(page, /creationOutcomeUnknownRef/)
  assert.match(page, /discoveryReadControllerRef\.current\?\.abort\(\)/)
  assert.match(page, /candidateReadControllerRef\.current\?\.abort\(\)/)
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
  assert.match(page, /Live TT作成の結果が不明です/)
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
  assert.match(csvHelp, /useRetainedAppActivity/)
  assert.match(csvHelp, /if \(!active \|\| !isOpen\) return/)
  assert.match(grid, /if \(!active\) \{[\s\S]*pointerSelectionRef\.current = null/)
  assert.doesNotMatch(page, /localStorage|sessionStorage/)
})

test('Live担当者管理は狭い画面でselectと操作ボタンを横にはみ出させない', async () => {
  const [page, css] = await Promise.all([
    readFile(new URL('../src/components/LiveTimetableOperatorPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LiveTimetableOperatorPage.css', import.meta.url), 'utf8'),
  ])

  assert.match(
    css,
    /\.live-operator-controls select,\s*\.live-operator-management select\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/,
  )
  assert.match(
    css,
    /\.live-operator-controls label,\s*\.live-operator-management label\s*\{[\s\S]*?min-width:\s*0;/,
  )
  assert.match(
    css,
    /\.live-operator-management__assignment-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?width:\s*100%;/,
  )
  assert.match(
    css,
    /\.live-operator-management__assignment-name\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
  )
  assert.match(css, /\.live-operator-management__stage button\s*\{\s*min-height:\s*2\.75rem;/)
  assert.doesNotMatch(css, /\.live-operator-management[^{}]*\{[^}]*overflow:\s*hidden;/)

  assert.match(page, /className="live-operator-management__assignment-actions"/)
  assert.match(page, />\s*再割当\s*<\/button>/)
  assert.match(page, />\s*解除\s*<\/button>/)
  assert.match(
    page,
    /aria-label=\{`\$\{stageTargetLabel\}の担当者\$\{operatorDisplayName\}を現在の権限で再割当`\}/,
  )
  assert.match(
    page,
    /aria-label=\{`\$\{stageTargetLabel\}の担当者\$\{operatorDisplayName\}を解除`\}/,
  )
})

test('retained App外へ出るPortalはactivity境界に参加する3種だけである', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const paths = await readdir(sourceRoot, { recursive: true })
  const portalFiles = []
  for (const relativePath of paths) {
    if (typeof relativePath !== 'string' || !/\.(?:ts|tsx)$/.test(relativePath)) {
      continue
    }
    const source = await readFile(new URL(relativePath.replaceAll('\\', '/'), sourceRoot), 'utf8')
    if (source.includes('createPortal(')) portalFiles.push(relativePath.replaceAll('\\', '/'))
  }
  assert.deepEqual(portalFiles.sort(), ['components/TimetableGridDetailsPopover.tsx'])

  const source = await readFile(
    new URL('../src/components/TimetableGridDetailsPopover.tsx', import.meta.url),
    'utf8',
  )
  for (const exportName of [
    'TimetableGridDetailsPopover',
    'TimetableGridRowActionsMenu',
    'TimetableGridTooltip',
  ]) {
    const start = source.indexOf(`export function ${exportName}`)
    assert.notEqual(start, -1)
    const next = source.indexOf('\nexport function ', start + 1)
    const componentSource = source.slice(start, next === -1 ? undefined : next)
    assert.match(componentSource, /const active = useRetainedAppActivity\(\)/)
    assert.match(componentSource, /if \(!active\) return null/)
    assert.match(componentSource, /useLayoutEffect\(\(\) => \{\s*if \(!active\) return/)
  }
})

test('通常Appの全native dialogは共通activity境界で休止・復帰する', async () => {
  const componentsUrl = new URL('../src/components/', import.meta.url)
  const fileNames = (await readdir(componentsUrl)).filter(name => name.endsWith('.tsx'))
  const dialogFiles = []
  for (const fileName of fileNames) {
    const source = await readFile(new URL(fileName, componentsUrl), 'utf8')
    if (!source.includes('<dialog')) continue
    dialogFiles.push(fileName)
    assert.match(source, /useNativeDialogActivity\(dialogRef(?:, true)?\)/,
      `${fileName} must participate in retained App activity`)
    assert.doesNotMatch(source, /\.showModal\(\)/,
      `${fileName} must not bypass the shared activity boundary`)
  }
  assert.deepEqual(dialogFiles.sort(), [
    'AddEventMembersDialog.tsx',
    'BandEditorDialog.tsx',
    'CreateEventDialog.tsx',
    'CsvImportPreviewDialog.tsx',
    'DeleteConfirmationDialog.tsx',
    'DutyAssignmentEditorDialog.tsx',
    'EventBandConditionDialog.tsx',
    'EventBandEditorDialog.tsx',
    'EventMemberDayDetailsDialog.tsx',
    'MemberEditorDialog.tsx',
    'PaAssignmentEditorDialog.tsx',
    'TimetableDutyAutoAssignmentDialog.tsx',
    'TimetableGenerationOptionsDialog.tsx',
    'TimetableGenerationPreviewDialog.tsx',
    'TimetableGridAssignmentDeletionDialog.tsx',
    'TimetableGridAssignmentDialog.tsx',
    'TimetableOrderConstraintDialog.tsx',
    'TimetableResetConfirmDialog.tsx',
  ])

  for (const fileName of [
    'TimetableGenerationOptionsDialog.tsx',
    'TimetableResetConfirmDialog.tsx',
  ]) {
    const source = await readFile(new URL(fileName, componentsUrl), 'utf8')
    assert.match(source, /consumeNativeDialogActivityClose\(event\.currentTarget\)/)
  }
})

test('Live account actions are blocked during mutation reconciliation', async () => {
  const page = await readFile(
    new URL('../src/components/LiveTimetableOperatorPage.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    page,
    /if \(mutationPendingRef\.current \|\| mutationReconciliationRef\.current\) return false/,
  )

  assert.equal(
    (page.match(
      /navigationDisabled=\{mutationPending \|\| mutationReconciliationPending\}/g,
    ) ?? []).length,
    2,
  )
})

test('Live exit remains blocked during mutation reconciliation', async () => {
  const page = await readFile(
    new URL('../src/components/LiveTimetableOperatorPage.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    page,
    /const closeLive = \(\) => \{\s*if \(mutationPendingRef\.current \|\| mutationReconciliationRef\.current\) return/,
  )

  assert.equal(
    (page.match(
      /className="live-operator-back"\s+disabled=\{mutationPending \|\| mutationReconciliationPending\}\s+onClick=\{closeLive\}/g,
    ) ?? []).length,
    2,
  )
})
