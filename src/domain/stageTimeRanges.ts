import type { LocalTime, Section, Stage } from './models.ts'
import { isValidLocalTime, parseLocalTimeToMinute } from './timeline.ts'

export const isValidStageTimeRange = (
  plannedStartTime: LocalTime,
  plannedEndTime?: LocalTime,
): boolean => {
  if (!isValidLocalTime(plannedStartTime)) return false
  if (plannedEndTime === undefined) return true
  if (!isValidLocalTime(plannedEndTime)) return false

  return parseLocalTimeToMinute(plannedStartTime) <
    parseLocalTimeToMinute(plannedEndTime)
}

export const isMinuteRangeWithinStageTimeRange = (
  stage: Pick<Stage, 'plannedStartTime' | 'plannedEndTime'>,
  fromMinute?: number,
  untilMinute?: number,
): boolean => {
  if (!isValidStageTimeRange(stage.plannedStartTime, stage.plannedEndTime) ||
    (fromMinute !== undefined && !Number.isSafeInteger(fromMinute)) ||
    (untilMinute !== undefined && !Number.isSafeInteger(untilMinute)) ||
    (fromMinute !== undefined && untilMinute !== undefined && fromMinute >= untilMinute)) return false

  const stageStart = parseLocalTimeToMinute(stage.plannedStartTime)
  const stageEnd = stage.plannedEndTime === undefined
    ? undefined
    : parseLocalTimeToMinute(stage.plannedEndTime)
  return (fromMinute === undefined ||
    (fromMinute >= stageStart && (stageEnd === undefined || fromMinute < stageEnd))) &&
    (untilMinute === undefined ||
      (untilMinute > stageStart && (stageEnd === undefined || untilMinute <= stageEnd)))
}

export const isSectionWithinStageTimeRange = (
  stage: Pick<Stage, 'plannedStartTime' | 'plannedEndTime'>,
  section: Pick<Section, 'plannedStartTime' | 'plannedEndTime'>,
): boolean => {
  if (section.plannedStartTime !== undefined &&
    !isValidLocalTime(section.plannedStartTime)) return false
  if (section.plannedEndTime !== undefined &&
    !isValidLocalTime(section.plannedEndTime)) return false

  return isMinuteRangeWithinStageTimeRange(
    stage,
    section.plannedStartTime === undefined
      ? undefined
      : parseLocalTimeToMinute(section.plannedStartTime),
    section.plannedEndTime === undefined
      ? undefined
      : parseLocalTimeToMinute(section.plannedEndTime),
  )
}
