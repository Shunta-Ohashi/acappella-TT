import type {
  AuthorizedLiveTimetable,
  LiveTimetableStageView,
} from './liveTimetableRepository.ts'

export const LIVE_TIMETABLE_REALTIME_COLUMNS = [
  'id',
  'workspace_id',
  'live_timetable_id',
  'projection_version',
  'revision',
  'progress_status',
  'updated_at',
] as const

export interface LiveTimetableScope {
  userId: string
  workspaceId: string
  workspaceVisitId: string
  eventId: string
  liveId: string
}

export interface LiveReadToken {
  scopeKey: string
  sequence: number
}

export const LIVE_STATE_MAX_AGE_MS = 45_000
export const LIVE_HEALTHY_POLLING_INTERVAL_MS = 30_000
export const LIVE_AUTHORIZED_READ_TIMEOUT_MS = 10_000
export const LIVE_MUTATION_WAIT_TIMEOUT_MS = 30_000

export type LiveAuthorizedReadOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'timed-out' }
  | { status: 'aborted' }
  | { status: 'failed'; error: unknown }

export type LiveMutationWaitOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'timed-out' }
  | { status: 'failed'; error: unknown }

export interface LiveMutationReconciliation {
  operationId: number
  scopeKey: string
  liveId: string
  confirms: (current: AuthorizedLiveTimetable) => boolean
}

export const canResolveLiveMutationReconciliation = ({
  reconciliation,
  activeScopeKey,
  current,
}: {
  reconciliation: LiveMutationReconciliation
  activeScopeKey: string
  current: AuthorizedLiveTimetable
}): boolean => reconciliation.scopeKey === activeScopeKey &&
  reconciliation.liveId === current.liveId && reconciliation.confirms(current)

export type LiveEntryTransitionOperation = 'start' | 'end'

export interface LiveEntryTransitionReconciliationTarget {
  operation: LiveEntryTransitionOperation
  stageId: LiveTimetableStageView['stageId']
  sourceStageId: LiveTimetableStageView['sourceStageId']
  sourceScheduleItemId: string
  previousStageRevision: string
}

export const isLiveEntryTransitionReconciled = ({
  current,
  target,
}: {
  current: AuthorizedLiveTimetable
  target: LiveEntryTransitionReconciliationTarget
}): boolean => {
  const stage = current.stages.find(candidate =>
    candidate.stageId === target.stageId &&
    candidate.sourceStageId === target.sourceStageId)
  if (!stage || BigInt(stage.revision) <= BigInt(target.previousStageRevision)) {
    return false
  }
  const entry = stage.entries.find(candidate =>
    candidate.sourceScheduleItemId === target.sourceScheduleItemId)
  if (!entry) return false

  return target.operation === 'start'
    ? (entry.status === 'in_progress' || entry.status === 'completed') &&
      entry.actualStartedAt !== null
    : entry.status === 'completed' && entry.actualEndedAt !== null
}

export interface LiveOperatorMutationReconciliationTarget {
  stageId: LiveTimetableStageView['stageId']
  operatorUserId: string
  assigned: boolean
  previousManagementRevision: string
  previousAssignedAt?: string
}

export const isLiveOperatorMutationReconciled = ({
  current,
  target,
}: {
  current: AuthorizedLiveTimetable
  target: LiveOperatorMutationReconciliationTarget
}): boolean => {
  if (BigInt(current.managementRevision) !==
      BigInt(target.previousManagementRevision) + 1n) return false
  const stage = current.stages.find(candidate =>
    candidate.stageId === target.stageId)
  if (!stage || stage.updatedAt !== current.updatedAt) return false
  const assignment = current.operators.find(operator =>
    operator.stageId === target.stageId &&
    operator.userId === target.operatorUserId)
  if (target.assigned) {
    return assignment?.assignedAt === current.updatedAt &&
      assignment.assignedAt !== target.previousAssignedAt
  }
  // The UI only offers removal for an observed assignment. If it was already
  // absent, no durable row exists that can identify this particular command.
  return target.previousAssignedAt !== undefined && assignment === undefined
}

export const runLiveAuthorizedReadWithDeadline = async <T>({
  read,
  controller,
  timeoutMilliseconds = LIVE_AUTHORIZED_READ_TIMEOUT_MS,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}: {
  read: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  timeoutMilliseconds?: number
  setTimer?: (callback: () => void, delayMilliseconds: number) => unknown
  clearTimer?: (handle: unknown) => void
}): Promise<LiveAuthorizedReadOutcome<T>> => {
  if (controller.signal.aborted) return { status: 'aborted' }

  let timerHandle: unknown
  let handleAbort = () => {}
  const request = Promise.resolve()
    .then(() => read(controller.signal))
    .then<LiveAuthorizedReadOutcome<T>, LiveAuthorizedReadOutcome<T>>(
      value => controller.signal.aborted
        ? { status: 'aborted' }
        : { status: 'completed', value },
      error => controller.signal.aborted
        ? { status: 'aborted' }
        : { status: 'failed', error },
    )
  const aborted = new Promise<LiveAuthorizedReadOutcome<T>>(resolve => {
    handleAbort = () => resolve({ status: 'aborted' })
    controller.signal.addEventListener('abort', handleAbort, { once: true })
  })
  const timedOut = new Promise<LiveAuthorizedReadOutcome<T>>(resolve => {
    timerHandle = setTimer(
      () => resolve({ status: 'timed-out' }),
      timeoutMilliseconds,
    )
  })

  try {
    const outcome = await Promise.race([request, aborted, timedOut])
    if (outcome.status === 'timed-out' && !controller.signal.aborted) {
      controller.abort()
    }
    return outcome
  } finally {
    if (timerHandle !== undefined) clearTimer(timerHandle)
    controller.signal.removeEventListener('abort', handleAbort)
  }
}

export const runLiveMutationWithDeadline = async <T>({
  mutation,
  timeoutMilliseconds = LIVE_MUTATION_WAIT_TIMEOUT_MS,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}: {
  mutation: () => Promise<T>
  timeoutMilliseconds?: number
  setTimer?: (callback: () => void, delayMilliseconds: number) => unknown
  clearTimer?: (handle: unknown) => void
}): Promise<LiveMutationWaitOutcome<T>> => {
  let timerHandle: unknown
  const request = Promise.resolve()
    .then(mutation)
    .then<LiveMutationWaitOutcome<T>, LiveMutationWaitOutcome<T>>(
      value => ({ status: 'completed', value }),
      error => ({ status: 'failed', error }),
    )
  const timedOut = new Promise<LiveMutationWaitOutcome<T>>(resolve => {
    timerHandle = setTimer(
      () => resolve({ status: 'timed-out' }),
      timeoutMilliseconds,
    )
  })

  try {
    return await Promise.race([request, timedOut])
  } finally {
    if (timerHandle !== undefined) clearTimer(timerHandle)
  }
}

export const canApplyLatestScopedRequest = ({
  token,
  activeScopeKey,
  latestStartedSequence,
}: {
  token: LiveReadToken
  activeScopeKey: string
  latestStartedSequence: number
}): boolean => token.scopeKey === activeScopeKey &&
  token.sequence === latestStartedSequence

export const createLiveTimetableScopeKey = (
  scope: LiveTimetableScope,
): string => JSON.stringify([
  scope.userId,
  scope.workspaceId,
  scope.workspaceVisitId,
  scope.eventId,
  scope.liveId,
])

const compareRevision = (left: string, right: string): number => {
  const leftRevision = BigInt(left)
  const rightRevision = BigInt(right)
  return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0
}

const stageByIdentity = (
  stages: readonly LiveTimetableStageView[],
): Map<string, LiveTimetableStageView> => new Map(stages.map(stage => [
  `${stage.stageId ?? ''}\u0000${stage.sourceStageId ?? ''}`,
  stage,
]))

export const isLiveTimetableReadAtLeastAsFresh = (
  incoming: AuthorizedLiveTimetable,
  current: AuthorizedLiveTimetable | undefined,
): boolean => {
  if (!current) return true
  if (
    incoming.liveId !== current.liveId ||
    incoming.workspaceId !== current.workspaceId ||
    incoming.eventId !== current.eventId
  ) return false

  const projectionComparison = compareRevision(
    incoming.projectionVersion,
    current.projectionVersion,
  )
  if (projectionComparison !== 0) return projectionComparison > 0
  if (compareRevision(
    incoming.managementRevision,
    current.managementRevision,
  ) < 0) return false

  const incomingStages = stageByIdentity(incoming.stages)
  for (const currentStage of current.stages) {
    const incomingStage = incomingStages.get(
      `${currentStage.stageId ?? ''}\u0000${currentStage.sourceStageId ?? ''}`,
    )
    if (!incomingStage || compareRevision(
      incomingStage.revision,
      currentStage.revision,
    ) < 0) return false
  }
  return true
}

export const canApplyLiveRead = ({
  token,
  activeScopeKey,
  latestAppliedSequence,
  minimumRequiredSequence = 0,
  incoming,
  current,
}: {
  token: LiveReadToken
  activeScopeKey: string
  latestAppliedSequence: number
  minimumRequiredSequence?: number
  incoming: AuthorizedLiveTimetable
  current: AuthorizedLiveTimetable | undefined
}): boolean => token.scopeKey === activeScopeKey &&
  token.sequence >= latestAppliedSequence &&
  token.sequence >= minimumRequiredSequence &&
  isLiveTimetableReadAtLeastAsFresh(incoming, current)

export const createPostMutationReadBarrier = (
  latestStartedReadSequence: number,
): number => latestStartedReadSequence + 1

export const getLivePollingDelay = (
  consecutiveFailures: number,
  realtimeHealthy: boolean,
): number => {
  // Realtime health only describes the notification transport. A failed
  // authorized HTTP read must retry promptly even while the channel remains
  // subscribed, because only a successful read proves state freshness.
  if (consecutiveFailures <= 0 && realtimeHealthy) {
    return LIVE_HEALTHY_POLLING_INTERVAL_MS
  }
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 4)
  return Math.min(1_000 * (2 ** exponent), 15_000)
}

export interface LivePollingTimerController {
  cancel: () => void
  dispose: () => void
  hasScheduledTimer: () => boolean
  schedule: (
    delayMilliseconds: number,
    task: (isCurrent: () => boolean) => Promise<void>,
  ) => void
}

export const createLivePollingTimerController = ({
  setTimer,
  clearTimer,
}: {
  setTimer: (callback: () => void, delayMilliseconds: number) => unknown
  clearTimer: (handle: unknown) => void
}): LivePollingTimerController => {
  let timerHandle: unknown
  let generation = 0
  let disposed = false

  const cancel = () => {
    generation += 1
    if (timerHandle !== undefined) clearTimer(timerHandle)
    timerHandle = undefined
  }

  return {
    cancel,
    dispose: () => {
      disposed = true
      cancel()
    },
    hasScheduledTimer: () => timerHandle !== undefined,
    schedule: (delayMilliseconds, task) => {
      cancel()
      if (disposed) return
      const scheduledGeneration = generation
      timerHandle = setTimer(() => {
        if (disposed || scheduledGeneration !== generation) return
        timerHandle = undefined
        const isCurrent = () => !disposed && scheduledGeneration === generation
        void task(isCurrent)
      }, delayMilliseconds)
    },
  }
}

export interface LiveOperatorCandidateReadToken {
  liveId: string
  scopeKey: string
  sequence: number
}

export const canApplyLiveOperatorCandidateRead = ({
  token,
  activeLiveId,
  activeScopeKey,
  latestStartedSequence,
}: {
  token: LiveOperatorCandidateReadToken
  activeLiveId: string | undefined
  activeScopeKey: string
  latestStartedSequence: number
}): boolean => token.scopeKey === activeScopeKey &&
  token.liveId === activeLiveId && token.sequence === latestStartedSequence

export const createInvalidatedLiveOperatorCandidateRead = ({
  currentSequence,
  liveId,
  scopeKey,
  error,
}: {
  currentSequence: number
  liveId?: string
  scopeKey?: string
  error: string
}) => ({
  nextSequence: currentSequence + 1,
  loading: false,
  candidates: [] as const,
  context: liveId && scopeKey ? { liveId, scopeKey } : undefined,
  error,
})

const formatLiveEventDayDate = (value: string): string | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day) return undefined
  return `${year}/${month}/${day}`
}

export const describeLiveStageManagementTarget = (
  stage: Pick<LiveTimetableStageView, 'name' | 'sourceEventDayId'>,
  eventDays: AuthorizedLiveTimetable['eventDays'],
): string => {
  const day = stage.sourceEventDayId
    ? eventDays.find(candidate =>
        candidate.sourceEventDayId === stage.sourceEventDayId)
    : undefined
  const date = day ? formatLiveEventDayDate(day.date) : undefined
  if (!day || !date) return `開催日不明／${stage.name}`
  const label = day.label?.trim()
  return `${date}${label ? `（${label}）` : ''}／${stage.name}`
}

export const isLiveStateStale = (
  lastSynchronizedAt: number | undefined,
  now: number,
  maximumAgeMilliseconds = LIVE_STATE_MAX_AGE_MS,
): boolean => {
  if (lastSynchronizedAt === undefined) return true
  const age = now - lastSynchronizedAt
  return age < 0 || age >= maximumAgeMilliseconds
}

export const canRunLiveMutation = ({
  online,
  stale,
  pending,
  canOperate,
  progressEnabled,
}: {
  online: boolean
  stale: boolean
  pending: boolean
  canOperate: boolean
  progressEnabled: boolean
}): boolean => online && !stale && !pending && canOperate && progressEnabled

export const canDispatchConfirmedLiveMutation = ({
  online,
  lastSynchronizedAt,
  now,
  pending,
  freshnessRequiredSequence,
  expectedScopeKey,
  activeScopeKey,
  expectedLiveId,
  activeLiveId,
  authorized,
}: {
  online: boolean
  lastSynchronizedAt: number | undefined
  now: number
  pending: boolean
  freshnessRequiredSequence: number
  expectedScopeKey: string
  activeScopeKey: string
  expectedLiveId: string
  activeLiveId: string | undefined
  authorized: boolean
}): boolean => expectedScopeKey === activeScopeKey &&
  expectedLiveId === activeLiveId && freshnessRequiredSequence === 0 &&
  canRunLiveMutation({
    online,
    stale: isLiveStateStale(lastSynchronizedAt, now),
    pending,
    canOperate: authorized,
    progressEnabled: true,
  })

export const resolveLiveOperatorCandidateSelection = (
  selectedUserId: string | undefined,
  candidates: readonly { userId: string }[],
): string => candidates.some(candidate => candidate.userId === selectedUserId)
  ? selectedUserId as string
  : candidates[0]?.userId ?? ''

export const isMatchingLiveRealtimePayload = (
  value: unknown,
  workspaceId: string,
  liveId: string,
): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const row = value as Record<string, unknown>
  const expectedKeys = new Set<string>(LIVE_TIMETABLE_REALTIME_COLUMNS)
  if (Object.keys(row).length !== expectedKeys.size ||
    Object.keys(row).some(key => !expectedKeys.has(key))) return false
  return typeof row.id === 'string' && row.id.length > 0 &&
    row.workspace_id === workspaceId && row.live_timetable_id === liveId &&
    typeof row.projection_version === 'number' &&
    Number.isSafeInteger(row.projection_version) && row.projection_version > 0 &&
    typeof row.revision === 'number' &&
    Number.isSafeInteger(row.revision) && row.revision > 0 &&
    typeof row.progress_status === 'string' &&
    ['empty', 'not_started', 'waiting', 'in_progress', 'completed']
      .includes(row.progress_status) &&
    typeof row.updated_at === 'string'
}

