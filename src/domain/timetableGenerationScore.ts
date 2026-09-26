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

export const getSectionBalance = (
  stages: Stage[],
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
): { durationImbalance: number; bandCountImbalance: number } => {
  const transitions = getCrossSectionTransitions(sections, calculatedItems)
  let durationImbalance = 0
  let bandCountImbalance = 0
  for (const stage of stages) {
    const stageSections = sections.filter(section => section.stageId === stage.id)
    if (stageSections.length < 2) continue
    const durations = stageSections.map(section => {
      const items = calculatedItems.filter(item => item.sectionId === section.id)
      return items.length === 0 ? 0 :
        Math.max(...items.map(item => item.plannedEndMinute)) -
        Math.min(...items.map(item => item.plannedStartMinute)) +
        (transitions.get(section.id)?.durationMinutes ?? 0)
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
