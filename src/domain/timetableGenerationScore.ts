import type { MemberId, PaRole, Section, Stage } from './models'
import type { CalculatedScheduleItem } from './timeline'
import { DEFAULT_SCHEDULING_WEIGHTS, type SoftConstraintViolation } from './schedulingConstraints.ts'

export interface TimetableGenerationScore {
  lastResortActivityCount: number
  schedulingSoftPenalty: number
  activitySpacingPenalty: number
  sectionDurationImbalance: number
  paMainWorkloadImbalance: number
  paSubWorkloadImbalance: number
  sectionBandCountImbalance: number
  undecidedPaShiftCount: number
}

/** Internal ranking only: never include these BigInts in a public plan. */
export interface ExactTimetableGenerationScore extends Omit<TimetableGenerationScore,
  'schedulingSoftPenalty' | 'sectionDurationImbalance' | 'paMainWorkloadImbalance' |
  'paSubWorkloadImbalance' | 'sectionBandCountImbalance'> {
  schedulingSoftPenalty: number | bigint
  sectionDurationImbalance: bigint
  paMainWorkloadImbalance: bigint
  paSubWorkloadImbalance: bigint
  sectionBandCountImbalance: bigint
}

/** Saturation is for display/diagnostics only, never for candidate ranking. */
const toPublicScoreValue = (value: number | bigint): number =>
  typeof value === 'number' ? value :
    value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)

export const toPublicTimetableGenerationScore = (
  score: ExactTimetableGenerationScore,
): TimetableGenerationScore => ({
  ...score,
  schedulingSoftPenalty: toPublicScoreValue(score.schedulingSoftPenalty),
  sectionDurationImbalance: toPublicScoreValue(score.sectionDurationImbalance),
  paMainWorkloadImbalance: toPublicScoreValue(score.paMainWorkloadImbalance),
  paSubWorkloadImbalance: toPublicScoreValue(score.paSubWorkloadImbalance),
  sectionBandCountImbalance: toPublicScoreValue(score.sectionBandCountImbalance),
})

const scoreKeys: (keyof TimetableGenerationScore)[] = [
  'lastResortActivityCount',
  'schedulingSoftPenalty',
  'activitySpacingPenalty',
  'sectionDurationImbalance',
  'paMainWorkloadImbalance',
  'paSubWorkloadImbalance',
  'sectionBandCountImbalance',
  'undecidedPaShiftCount',
]

const compareScores = (
  left: ExactTimetableGenerationScore | TimetableGenerationScore,
  right: ExactTimetableGenerationScore | TimetableGenerationScore,
): number => {
  for (const key of scoreKeys) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  return 0
}

export const compareExactTimetableGenerationScores = (
  left: ExactTimetableGenerationScore,
  right: ExactTimetableGenerationScore,
): number => compareScores(left, right)

export const compareTimetableGenerationScores = (
  left: TimetableGenerationScore,
  right: TimetableGenerationScore,
): number => compareScores(left, right)

// Generation uses the default integer weights. Multiply before rounding and
// aggregate exactly; retain existing number semantics for fractional policies.
export const getExactSchedulingSoftPenalty = (
  violations: readonly SoftConstraintViolation[],
): number | bigint => {
  const weights = DEFAULT_SCHEDULING_WEIGHTS
  const weightByCode: Partial<Record<SoftConstraintViolation['code'], number>> = {
    BACK_TO_BACK: weights.backToBack,
    SHORT_GAP: weights.shortGapPerBand,
    SHORT_REST: weights.shortRestPerMinute,
    PREFERENCE_NOT_MET: weights.preferredOutsidePerMinute,
    MEMBER_PARTICIPATION_UNDECIDED: weights.undecided,
  }
  if (violations.some(violation => !Number.isSafeInteger(violation.amount))) {
    return violations.reduce((total, violation) => total + violation.penalty, 0)
  }
  return violations.reduce((total, violation) => total +
    BigInt(violation.amount!) * BigInt(weightByCode[violation.code]!), 0n)
}

const getBigIntImbalance = (values: bigint[]): bigint => {
  const minimum = values.reduce((minimum, value) => value < minimum ? value : minimum)
  const maximum = values.reduce((maximum, value) => value > maximum ? value : maximum)
  return maximum - minimum
}

/** Cross-Section transitions belong to the preceding Section, not idle time. */
export const getCrossSectionTransitions = (
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
): Map<Section['id'], { durationMinutes: number; untilItem: CalculatedScheduleItem }> => {
  const transitions = new Map<Section['id'], {
    durationMinutes: number; untilItem: CalculatedScheduleItem
  }>()
  for (const stageId of new Set(calculatedItems.map(item => item.stageId))) {
    const stageSections = sections.filter(section => section.stageId === stageId)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    // Preserve Timeline traversal order, including explicit Break items.
    const stageItems = calculatedItems.filter(item => item.stageId === stageId)
    for (let index = 1; index < stageItems.length; index += 1) {
      const previous = stageItems[index - 1]
      const next = stageItems[index]
      if (previous.kind !== 'performance' || next.kind !== 'performance' ||
        previous.sectionId === undefined || next.sectionId === undefined ||
        previous.sectionId === next.sectionId) continue
      const previousIndex = stageSections.findIndex(section => section.id === previous.sectionId)
      const nextIndex = stageSections.findIndex(section => section.id === next.sectionId)
      if (previousIndex < 0 || nextIndex <= previousIndex ||
        // An anchor in an empty intervening Section also suppresses transition.
        stageSections.slice(previousIndex + 1, nextIndex + 1)
          .some(section => section.plannedStartTime !== undefined)) continue
      const durationMinutes = next.plannedStartMinute - previous.plannedEndMinute
      if (durationMinutes < 0) continue
      transitions.set(previous.sectionId, { durationMinutes, untilItem: next })
    }
  }
  return transitions
}

export const getExactSectionBalance = (
  stages: Stage[],
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
): { durationImbalance: bigint; bandCountImbalance: bigint } => {
  const transitions = getCrossSectionTransitions(sections, calculatedItems)
  let durationImbalance = 0n
  let bandCountImbalance = 0n
  for (const stage of stages) {
    const stageSections = sections.filter(section => section.stageId === stage.id)
    if (stageSections.length < 2) continue
    const durations = stageSections.map(section => {
      const items = calculatedItems.filter(item => item.sectionId === section.id)
      return items.length === 0 ? 0n :
        BigInt(Math.max(...items.map(item => item.plannedEndMinute))) -
        BigInt(Math.min(...items.map(item => item.plannedStartMinute))) +
        BigInt(transitions.get(section.id)?.durationMinutes ?? 0)
    })
    const counts = stageSections.map(section => calculatedItems.filter(item =>
      item.sectionId === section.id && item.kind === 'performance',
    ).length).map(count => BigInt(count))
    durationImbalance += getBigIntImbalance(durations)
    bandCountImbalance += getBigIntImbalance(counts)
  }
  return { durationImbalance, bandCountImbalance }
}

export const getSectionBalance = (
  stages: Stage[],
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
): { durationImbalance: number; bandCountImbalance: number } => {
  const balance = getExactSectionBalance(stages, sections, calculatedItems)
  return {
    durationImbalance: toPublicScoreValue(balance.durationImbalance),
    bandCountImbalance: toPublicScoreValue(balance.bandCountImbalance),
  }
}

export const getExactPaWorkloadImbalance = (
  role: PaRole,
  shifts: readonly { role: PaRole; memberId: MemberId; fromMinute: number; untilMinute: number }[],
  eligibleMemberIds: readonly MemberId[],
): bigint => {
  if (eligibleMemberIds.length < 2) return 0n
  const minutesByMember = new Map(eligibleMemberIds.map(id => [id, 0n]))
  for (const shift of shifts) {
    if (shift.role !== role || !minutesByMember.has(shift.memberId)) continue
    minutesByMember.set(
      shift.memberId,
      (minutesByMember.get(shift.memberId) ?? 0n) +
        BigInt(shift.untilMinute) - BigInt(shift.fromMinute),
    )
  }
  return getBigIntImbalance([...minutesByMember.values()])
}

export const getPaWorkloadImbalance = (
  role: PaRole,
  shifts: Parameters<typeof getExactPaWorkloadImbalance>[1],
  eligibleMemberIds: readonly MemberId[],
): number => toPublicScoreValue(getExactPaWorkloadImbalance(role, shifts, eligibleMemberIds))
