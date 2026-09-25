import type {
  DutyAssignment,
  EventBand,
  EventDayId,
  MemberId,
  PaAssignment,
  ScheduleItemId,
  StageId,
} from './models'
import { resolveDutyAssignmentInterval } from './dutyAssignments.ts'
import { resolvePaAssignmentInterval } from './paAssignments.ts'
import type { CalculatedScheduleItem } from './timeline'

export type MemberActivityKind = 'performance' | 'pa' | 'duty'
export type ActivitySpacingCategory =
  | 'performance-to-performance'
  | 'work-to-performance'
  | 'performance-to-work'
  | 'work-to-work'
export type ActivityRestLevel =
  | 'hard-violation'
  | 'last-resort'
  | 'preferred'
  | 'sufficient'
export type ActivityBandGapLevel =
  | 'hard-violation'
  | 'last-resort'
  | 'good'
  | 'break-substituted'

export interface MemberActivity {
  /** Stable within one member's activity list; source IDs are suitable. */
  id: string
  memberId: MemberId
  eventDayId: EventDayId
  stageId?: StageId
  kind: MemberActivityKind
  /** Half-open interval [fromMinute, untilMinute). */
  fromMinute: number
  untilMinute: number
  scheduleItemId?: ScheduleItemId
  eventBandId?: EventBand['id']
  paAssignmentId?: PaAssignment['id']
  dutyAssignmentId?: DutyAssignment['id']
}

export interface ActivityRestThresholds {
  minimumMinutes: number
  preferredMinutes: number
  sufficientMinutes: number
}

export type ActivitySpacingPolicy = Record<
  ActivitySpacingCategory,
  ActivityRestThresholds
>

export const DEFAULT_ACTIVITY_SPACING_POLICY: Readonly<ActivitySpacingPolicy> =
  Object.freeze({
    'performance-to-performance': Object.freeze({
      minimumMinutes: 5, preferredMinutes: 15, sufficientMinutes: 30,
    }),
    'work-to-performance': Object.freeze({
      minimumMinutes: 5, preferredMinutes: 15, sufficientMinutes: 20,
    }),
    'performance-to-work': Object.freeze({
      minimumMinutes: 5, preferredMinutes: 10, sufficientMinutes: 15,
    }),
    'work-to-work': Object.freeze({
      minimumMinutes: 5, preferredMinutes: 10, sufficientMinutes: 15,
    }),
  })

const categories: ActivitySpacingCategory[] = [
  'performance-to-performance',
  'work-to-performance',
  'performance-to-work',
  'work-to-work',
]

export const validateActivitySpacingPolicy = (
  policy: ActivitySpacingPolicy,
): void => {
  for (const category of categories) {
    const thresholds = policy[category]
    if (
      !thresholds ||
      !Number.isSafeInteger(thresholds.minimumMinutes) ||
      !Number.isSafeInteger(thresholds.preferredMinutes) ||
      !Number.isSafeInteger(thresholds.sufficientMinutes) ||
      thresholds.minimumMinutes < 0 ||
      thresholds.minimumMinutes > thresholds.preferredMinutes ||
      thresholds.preferredMinutes > thresholds.sufficientMinutes
    ) {
      throw new RangeError(`Invalid activity spacing policy: ${category}`)
    }
  }
}

export const getActivitySpacingCategory = (
  previous: MemberActivityKind,
  next: MemberActivityKind,
): ActivitySpacingCategory => {
  if (previous === 'performance') {
    return next === 'performance'
      ? 'performance-to-performance'
      : 'performance-to-work'
  }
  return next === 'performance' ? 'work-to-performance' : 'work-to-work'
}

const validateActivity = (activity: MemberActivity): void => {
  if (
    !activity.id || !activity.memberId || !activity.eventDayId ||
    !['performance', 'pa', 'duty'].includes(activity.kind) ||
    !Number.isSafeInteger(activity.fromMinute) ||
    !Number.isSafeInteger(activity.untilMinute) ||
    activity.fromMinute >= activity.untilMinute
  ) {
    throw new RangeError(`Invalid member activity: ${activity.id}`)
  }
}

const compareActivities = (left: MemberActivity, right: MemberActivity): number =>
  left.fromMinute - right.fromMinute ||
  left.untilMinute - right.untilMinute ||
  left.kind.localeCompare(right.kind) ||
  (left.stageId ?? '').localeCompare(right.stageId ?? '') ||
  left.id.localeCompare(right.id)

export interface ActivityPairEvaluation {
  memberId: MemberId
  previous: MemberActivity
  next: MemberActivity
  category: ActivitySpacingCategory
  restMinutes: number
  overlaps: boolean
  restLevel: ActivityRestLevel
  /** Undefined when no trustworthy same-Stage sequence was supplied. */
  bandGap?: number
  bandGapLevel?: ActivityBandGapLevel
  level: ActivityRestLevel
  feasible: boolean
  penalty: number
}

const getBandGap = (
  previous: MemberActivity,
  next: MemberActivity,
  stageItems: readonly CalculatedScheduleItem[] | undefined,
  sufficientMinutes: number,
  restMinutes: number,
): { bandGap?: number; bandGapLevel?: ActivityBandGapLevel; penalty: number } => {
  if (
    !stageItems || !previous.stageId ||
    previous.stageId !== next.stageId ||
    (previous.kind !== 'performance' && next.kind !== 'performance')
  ) return { penalty: 0 }

  const between = stageItems.filter(item =>
    item.eventDayId === previous.eventDayId &&
    item.stageId === previous.stageId &&
    item.plannedStartMinute >= previous.untilMinute &&
    item.plannedEndMinute <= next.fromMinute,
  )
  const bandGap = new Set(between
    .filter(item => item.kind === 'performance')
    .map(item => item.scheduleItemId)).size

  if (bandGap >= 2) return { bandGap, bandGapLevel: 'good', penalty: 0 }
  if (bandGap === 1) return { bandGap, bandGapLevel: 'last-resort', penalty: 50 }

  const breaks = between
    .filter(item => item.kind === 'break')
    .sort((left, right) => left.plannedStartMinute - right.plannedStartMinute)
  let explicitBreakMinutes = 0
  let coveredUntil = previous.untilMinute
  for (const item of breaks) {
    explicitBreakMinutes += Math.max(0, item.plannedEndMinute - Math.max(item.plannedStartMinute, coveredUntil))
    coveredUntil = Math.max(coveredUntil, item.plannedEndMinute)
  }
  return breaks.length > 0 &&
    restMinutes >= sufficientMinutes &&
    explicitBreakMinutes >= sufficientMinutes
    ? { bandGap, bandGapLevel: 'break-substituted', penalty: 0 }
    : { bandGap, bandGapLevel: 'hard-violation', penalty: 0 }
}

export const evaluateActivityPair = ({
  previous,
  next,
  policy = DEFAULT_ACTIVITY_SPACING_POLICY,
  stageItems,
}: {
  previous: MemberActivity
  next: MemberActivity
  policy?: ActivitySpacingPolicy
  stageItems?: readonly CalculatedScheduleItem[]
}): ActivityPairEvaluation => {
  validateActivitySpacingPolicy(policy)
  validateActivity(previous)
  validateActivity(next)
  if (
    previous.memberId !== next.memberId ||
    previous.eventDayId !== next.eventDayId ||
    compareActivities(previous, next) > 0
  ) throw new RangeError('Activity pair must be chronological for one member and day')

  const category = getActivitySpacingCategory(previous.kind, next.kind)
  const { minimumMinutes, preferredMinutes, sufficientMinutes } = policy[category]
  const restMinutes = next.fromMinute - previous.untilMinute
  const overlaps = restMinutes < 0
  const restLevel: ActivityRestLevel = restMinutes < minimumMinutes
    ? 'hard-violation'
    : restMinutes < preferredMinutes
      ? 'last-resort'
      : restMinutes < sufficientMinutes
        ? 'preferred'
        : 'sufficient'
  // A fixed zone cost keeps every last-resort candidate worse than a preferred one.
  const restPenalty = restLevel === 'last-resort'
    ? 100 + preferredMinutes - restMinutes
    : restLevel === 'preferred'
      ? 20 + sufficientMinutes - restMinutes
      : 0
  const gap = getBandGap(
    previous, next, stageItems, sufficientMinutes, restMinutes,
  )
  const feasible = restLevel !== 'hard-violation' &&
    gap.bandGapLevel !== 'hard-violation'
  const level: ActivityRestLevel = !feasible
    ? 'hard-violation'
    : gap.bandGapLevel === 'last-resort' && restLevel !== 'last-resort'
      ? 'last-resort'
      : restLevel

  return {
    memberId: previous.memberId,
    previous, next, category, restMinutes, overlaps, restLevel,
    ...(gap.bandGap === undefined ? {} : { bandGap: gap.bandGap }),
    ...(gap.bandGapLevel === undefined ? {} : { bandGapLevel: gap.bandGapLevel }),
    level, feasible, penalty: feasible ? restPenalty + gap.penalty : 0,
  }
}

export interface MemberActivitySpacingEvaluation {
  pairs: ActivityPairEvaluation[]
  feasible: boolean
  totalPenalty: number
}

export const evaluateMemberActivitySpacing = ({
  activities,
  policy = DEFAULT_ACTIVITY_SPACING_POLICY,
  stageItems,
}: {
  activities: readonly MemberActivity[]
  policy?: ActivitySpacingPolicy
  stageItems?: readonly CalculatedScheduleItem[]
}): MemberActivitySpacingEvaluation => {
  validateActivitySpacingPolicy(policy)
  activities.forEach(validateActivity)
  const ordered = [...activities].sort(compareActivities)
  if (new Set(ordered.map(activity => activity.id)).size !== ordered.length) {
    throw new RangeError('Member activity IDs must be unique')
  }
  if (ordered.some(activity =>
    activity.memberId !== ordered[0].memberId ||
    activity.eventDayId !== ordered[0].eventDayId,
  )) throw new RangeError('Activities must belong to one member and event day')

  const pairs: ActivityPairEvaluation[] = []
  for (let first = 0; first < ordered.length; first += 1) {
    for (let second = first + 1; second < ordered.length; second += 1) {
      // Adjacent pairs express spacing; non-adjacent overlapping pairs are also unsafe.
      if (
        second !== first + 1 &&
        ordered[second].fromMinute >= ordered[first].untilMinute
      ) break
      pairs.push(evaluateActivityPair({
        previous: ordered[first], next: ordered[second], policy, stageItems,
      }))
    }
  }

  return {
    pairs,
    feasible: pairs.every(pair => pair.feasible),
    totalPenalty: pairs.reduce((total, pair) => total + pair.penalty, 0),
  }
}

export interface UnresolvedActivitySource {
  id: string
  reason: string
}

export interface BuildMemberActivitiesResult {
  activities: MemberActivity[]
  unresolved: UnresolvedActivitySource[]
}

export const buildPerformanceActivities = (
  calculatedItems: readonly CalculatedScheduleItem[],
  eventBands: readonly EventBand[],
): BuildMemberActivitiesResult => {
  const bandsById = new Map(eventBands.map(band => [band.id, band]))
  const activities: MemberActivity[] = []
  const unresolved: UnresolvedActivitySource[] = []
  for (const item of calculatedItems) {
    if (item.kind !== 'performance') continue
    const band = item.eventBandId && bandsById.get(item.eventBandId)
    if (!band || band.eventDayId !== item.eventDayId) {
      unresolved.push({
        id: item.scheduleItemId,
        reason: !band ? 'EventBand参照先が存在しません。' : 'EventBandの開催日が一致しません。',
      })
      continue
    }
    for (const memberId of new Set(band.memberIds)) {
      activities.push({
        id: `performance:${item.scheduleItemId}:${memberId}`,
        kind: 'performance', memberId, eventDayId: item.eventDayId,
        stageId: item.stageId,
        fromMinute: item.plannedStartMinute,
        untilMinute: item.plannedEndMinute,
        scheduleItemId: item.scheduleItemId,
        eventBandId: band.id,
      })
    }
  }
  return { activities, unresolved }
}

export const buildPaActivities = (
  assignments: readonly PaAssignment[],
  calculatedItems: CalculatedScheduleItem[],
): BuildMemberActivitiesResult => {
  const activities: MemberActivity[] = []
  const unresolved: UnresolvedActivitySource[] = []
  for (const assignment of assignments) {
    const result = resolvePaAssignmentInterval(assignment, calculatedItems)
    if (!result.ok) {
      unresolved.push({ id: assignment.id, reason: result.reason })
      continue
    }
    activities.push({
      id: `pa:${assignment.id}`,
      kind: 'pa', memberId: assignment.memberId,
      eventDayId: assignment.eventDayId, stageId: assignment.stageId,
      fromMinute: result.interval.fromMinute,
      untilMinute: result.interval.untilMinute,
      paAssignmentId: assignment.id,
    })
  }
  return { activities, unresolved }
}

export const buildDutyActivities = (
  assignments: readonly DutyAssignment[],
  calculatedItems: CalculatedScheduleItem[],
): BuildMemberActivitiesResult => {
  const activities: MemberActivity[] = []
  const unresolved: UnresolvedActivitySource[] = []
  for (const assignment of assignments) {
    const result = resolveDutyAssignmentInterval(assignment, calculatedItems)
    if (!result.ok) {
      unresolved.push({ id: assignment.id, reason: result.reason })
      continue
    }
    activities.push({
      id: `duty:${assignment.id}`,
      kind: 'duty', memberId: assignment.memberId,
      eventDayId: assignment.eventDayId, stageId: assignment.stageId,
      fromMinute: result.interval.fromMinute,
      untilMinute: result.interval.untilMinute,
      dutyAssignmentId: assignment.id,
    })
  }
  return { activities, unresolved }
}
