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

export const isLiveStateStale = (
  lastSynchronizedAt: number | undefined,
  now: number,
  maximumAgeMilliseconds = LIVE_STATE_MAX_AGE_MS,
): boolean => lastSynchronizedAt === undefined ||
  now - lastSynchronizedAt > maximumAgeMilliseconds

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

