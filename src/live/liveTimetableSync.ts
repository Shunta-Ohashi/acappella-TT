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
  incoming,
  current,
}: {
  token: LiveReadToken
  activeScopeKey: string
  latestAppliedSequence: number
  incoming: AuthorizedLiveTimetable
  current: AuthorizedLiveTimetable | undefined
}): boolean => token.scopeKey === activeScopeKey &&
  token.sequence >= latestAppliedSequence &&
  isLiveTimetableReadAtLeastAsFresh(incoming, current)

export const getLivePollingDelay = (
  consecutiveFailures: number,
  realtimeHealthy: boolean,
): number => {
  if (realtimeHealthy) return LIVE_HEALTHY_POLLING_INTERVAL_MS
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 4)
  return Math.min(1_000 * (2 ** exponent), 15_000)
}

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

