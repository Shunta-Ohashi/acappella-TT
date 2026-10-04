import type {
  ScheduleBoundary,
  Section,
  Stage,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import { formatMinuteAsLocalTime } from './timeline.ts'
import {
  isScheduleItemBoundary,
  isSectionBoundary,
  isTimeBoundary,
} from './scheduleBoundaries.ts'

export type AssignmentRangeMode =
  | 'schedule-item'
  | 'section-whole'
  | 'section-partial'
  | 'time'

export const getAssignmentRangeMode = (
  from: ScheduleBoundary,
  until: ScheduleBoundary,
): AssignmentRangeMode | undefined => {
  if (isScheduleItemBoundary(from) && isScheduleItemBoundary(until)) {
    return 'schedule-item'
  }
  if (isTimeBoundary(from) && isTimeBoundary(until)) return 'time'
  if (
    isSectionBoundary(from) && isSectionBoundary(until) &&
    from.sectionId === until.sectionId &&
    from.edge === 'start' && until.edge === 'end'
  ) {
    // Explicit zero offsets still represent the user's selected partial mode.
    // Whole-Section ranges use the canonical form with both offsets omitted.
    return from.offsetMinutes === undefined && until.offsetMinutes === undefined
      ? 'section-whole'
      : 'section-partial'
  }
  return undefined
}

export const createDefaultAssignmentRange = ({
  mode,
  stage,
  sections,
  calculatedItems,
}: {
  mode: AssignmentRangeMode
  stage: Stage
  sections: Section[]
  calculatedItems: CalculatedScheduleItem[]
}): { from: ScheduleBoundary; until: ScheduleBoundary } | undefined => {
  const stageItems = calculatedItems.filter((item) => item.stageId === stage.id)
  const firstItem = stageItems[0]
  const lastItem = stageItems.at(-1)
  if (mode === 'schedule-item') {
    if (!firstItem || !lastItem) return undefined
    return {
      from: {
        kind: 'schedule-item',
        scheduleItemId: firstItem.scheduleItemId,
        edge: 'start',
      },
      until: {
        kind: 'schedule-item',
        scheduleItemId: lastItem.scheduleItemId,
        edge: 'end',
      },
    }
  }
  if (mode === 'time') {
    return {
      from: { kind: 'time', time: stage.plannedStartTime },
      until: {
        kind: 'time',
        time: stage.plannedEndTime ?? (lastItem
          ? formatMinuteAsLocalTime(lastItem.plannedEndMinute)
          : stage.plannedStartTime),
      },
    }
  }
  const section = sections
    .filter((candidate) => candidate.stageId === stage.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))[0]
  if (!section) return undefined
  const offset = mode === 'section-partial' ? { offsetMinutes: 0 } : {}
  return {
    from: { kind: 'section', sectionId: section.id, edge: 'start', ...offset },
    until: { kind: 'section', sectionId: section.id, edge: 'end', ...offset },
  }
}
