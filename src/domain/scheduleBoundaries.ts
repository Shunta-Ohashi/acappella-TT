import type {
  EventDayId,
  ScheduleBoundary,
  StageId,
} from './models'
import type { CalculatedScheduleItem } from './timeline'

export interface ResolvedScheduleInterval {
  fromMinute: number
  untilMinute: number
}

export type ResolveScheduleIntervalResult =
  | { ok: true; interval: ResolvedScheduleInterval }
  | { ok: false; reason: string }

interface ScheduleBoundaryScope {
  eventDayId: EventDayId
  stageId: StageId
  from: ScheduleBoundary
  until: ScheduleBoundary
}

const getBoundaryMinute = (
  boundary: ScheduleBoundary,
  item: CalculatedScheduleItem,
): number => boundary.edge === 'start'
  ? item.plannedStartMinute
  : item.plannedEndMinute

export const intervalsOverlap = (
  first: ResolvedScheduleInterval,
  second: ResolvedScheduleInterval,
): boolean => first.fromMinute < second.untilMinute &&
  second.fromMinute < first.untilMinute

export const resolveScheduleBoundaryInterval = (
  assignment: ScheduleBoundaryScope,
  calculatedItems: CalculatedScheduleItem[],
  subjectLabel: string,
): ResolveScheduleIntervalResult => {
  const itemById = new Map(
    calculatedItems.map((item) => [item.scheduleItemId, item]),
  )
  const fromItem = itemById.get(assignment.from.scheduleItemId)
  const untilItem = itemById.get(assignment.until.scheduleItemId)

  if (!fromItem) {
    return { ok: false, reason: `${subjectLabel}範囲の開始参照先が存在しません。` }
  }
  if (!untilItem) {
    return { ok: false, reason: `${subjectLabel}範囲の終了参照先が存在しません。` }
  }
  if (
    fromItem.stageId !== assignment.stageId ||
    fromItem.eventDayId !== assignment.eventDayId
  ) {
    return {
      ok: false,
      reason: `${subjectLabel}範囲の開始は同じ開催日・Stageから選択してください。`,
    }
  }
  if (
    untilItem.stageId !== assignment.stageId ||
    untilItem.eventDayId !== assignment.eventDayId
  ) {
    return {
      ok: false,
      reason: `${subjectLabel}範囲の終了は同じ開催日・Stageから選択してください。`,
    }
  }

  const fromMinute = getBoundaryMinute(assignment.from, fromItem)
  const untilMinute = getBoundaryMinute(assignment.until, untilItem)
  if (fromMinute >= untilMinute) {
    return {
      ok: false,
      reason: fromMinute === untilMinute
        ? `${subjectLabel}範囲の開始と終了を同じ時刻にできません。`
        : `${subjectLabel}範囲の終了は開始より後にしてください。`,
    }
  }

  return { ok: true, interval: { fromMinute, untilMinute } }
}
