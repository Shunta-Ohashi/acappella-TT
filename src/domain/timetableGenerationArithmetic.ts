import {
  getScheduleLaneItems, getSectionsForStage, isValidScheduleItemSectionAssignment,
} from './schedule.ts'
import { parseLocalTimeToMinute, type CalculateStageTimelineInput } from './timeline.ts'

/**
 * Check an actual proposal before Number-based Timeline evaluation. Individual
 * times, durations and transitions must already have passed input validation.
 * Match calculateStageTimeline's traversal, anchors and transition semantics.
 */
export const hasSafeStageTimelineArithmetic = ({
  event, stage, sections, scheduleItems, eventBands,
}: CalculateStageTimelineInput): boolean => {
  const stageSections = getSectionsForStage(sections, stage.id)
  const stageItems = scheduleItems.filter(item => item.stageId === stage.id)
  if (stageItems.some(item => !isValidScheduleItemSectionAssignment(
    stage.id, stageSections, item,
  ))) return false
  const bandsById = new Map(eventBands.map(band => [band.id, band]))
  const transition = BigInt(stage.transitionMinutes ?? event.defaultTransitionMinutes)
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  let current = BigInt(parseLocalTimeToMinute(stage.plannedStartTime))
  let previousKind: 'performance' | 'break' | undefined
  let anchored = false

  const advanceLane = (lane: Parameters<typeof getScheduleLaneItems>[1]): boolean => {
    for (const item of getScheduleLaneItems(stageItems, lane)) {
      if (previousKind === 'performance' && item.kind === 'performance' && !anchored) {
        current += transition
      }
      if (current > maximum) return false
      const duration = item.kind === 'break'
        ? item.durationMinutes : bandsById.get(item.eventBandId)?.durationMinutes
      if (duration === undefined) return false
      current += BigInt(duration)
      if (current > maximum) return false
      previousKind = item.kind
      anchored = false
    }
    return true
  }

  if (stageSections.length === 0) return advanceLane({ stageId: stage.id })
  for (const [index, section] of stageSections.entries()) {
    if (section.plannedStartTime !== undefined) {
      current = BigInt(parseLocalTimeToMinute(section.plannedStartTime))
      anchored = true
    }
    if (!advanceLane({ stageId: stage.id, sectionId: section.id })) return false
    if (index < stageSections.length - 1 &&
      !advanceLane({ stageId: stage.id, afterSectionId: section.id })) return false
  }
  return true
}
