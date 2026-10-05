import {
  getScheduleLaneItems, getSectionsForStage, isValidScheduleItemSectionAssignment,
} from './schedule.ts'
import { parseLocalTimeToMinute, type CalculateStageTimelineInput } from './timeline.ts'

/**
 * Check an actual proposal before Number-based Timeline evaluation. Individual
 * times and durations must already have passed input validation. Match
 * calculateStageTimeline's traversal and anchor semantics.
 */
export const hasSafeStageTimelineArithmetic = ({
  stage, sections, scheduleItems, eventBands,
}: CalculateStageTimelineInput): boolean => {
  const stageSections = getSectionsForStage(sections, stage.id)
  const stageItems = scheduleItems.filter(item => item.stageId === stage.id)
  if (stageItems.some(item => !isValidScheduleItemSectionAssignment(
    stage.id, stageSections, item,
  ))) return false
  const bandsById = new Map(eventBands.map(band => [band.id, band]))
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  let current = BigInt(parseLocalTimeToMinute(stage.plannedStartTime))

  const advanceLane = (lane: Parameters<typeof getScheduleLaneItems>[1]): boolean => {
    for (const item of getScheduleLaneItems(stageItems, lane)) {
      if (current > maximum) return false
      const duration = item.kind === 'break'
        ? item.durationMinutes : bandsById.get(item.eventBandId)?.durationMinutes
      if (duration === undefined) return false
      current += BigInt(duration)
      if (current > maximum) return false
    }
    return true
  }

  if (stageSections.length === 0) return advanceLane({ stageId: stage.id })
  for (const [index, section] of stageSections.entries()) {
    if (section.plannedStartTime !== undefined) {
      current = BigInt(parseLocalTimeToMinute(section.plannedStartTime))
    }
    if (!advanceLane({ stageId: stage.id, sectionId: section.id })) return false
    if (index < stageSections.length - 1 &&
      !advanceLane({ stageId: stage.id, afterSectionId: section.id })) return false
  }
  return true
}
