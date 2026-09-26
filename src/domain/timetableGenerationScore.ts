import type { MemberId, PaRole, Section, Stage } from './models'
import type { CalculatedScheduleItem } from './timeline'

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

export const compareTimetableGenerationScores = (
  left: TimetableGenerationScore,
  right: TimetableGenerationScore,
): number => {
  for (const key of scoreKeys) {
    const difference = left[key] - right[key]
    if (difference !== 0) return difference
  }
  return 0
}

export const getSectionBalance = (
  stages: Stage[],
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
): { durationImbalance: number; bandCountImbalance: number } => {
  let durationImbalance = 0
  let bandCountImbalance = 0
  for (const stage of stages) {
    const stageSections = sections.filter(section => section.stageId === stage.id)
    if (stageSections.length < 2) continue
    const durations = stageSections.map(section => {
      const items = calculatedItems.filter(item => item.sectionId === section.id)
      return items.length === 0 ? 0 :
        Math.max(...items.map(item => item.plannedEndMinute)) -
        Math.min(...items.map(item => item.plannedStartMinute))
    })
    const counts = stageSections.map(section => calculatedItems.filter(item =>
      item.sectionId === section.id && item.kind === 'performance',
    ).length)
    durationImbalance += Math.max(...durations) - Math.min(...durations)
    bandCountImbalance += Math.max(...counts) - Math.min(...counts)
  }
  return { durationImbalance, bandCountImbalance }
}

export const getPaWorkloadImbalance = (
  role: PaRole,
  shifts: readonly { role: PaRole; memberId: MemberId; fromMinute: number; untilMinute: number }[],
  eligibleMemberIds: readonly MemberId[],
): number => {
  if (eligibleMemberIds.length < 2) return 0
  const minutesByMember = new Map(eligibleMemberIds.map(id => [id, 0]))
  for (const shift of shifts) {
    if (shift.role !== role || !minutesByMember.has(shift.memberId)) continue
    minutesByMember.set(
      shift.memberId,
      (minutesByMember.get(shift.memberId) ?? 0) + shift.untilMinute - shift.fromMinute,
    )
  }
  const minutes = [...minutesByMember.values()]
  return Math.max(...minutes) - Math.min(...minutes)
}
