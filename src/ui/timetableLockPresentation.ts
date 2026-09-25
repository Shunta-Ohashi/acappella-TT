import type {
  EventBand,
  EventId,
  ScheduleItem,
  TimetableLock,
  TimetableLockId,
} from '../domain/models'
import {
  getTimetableLockLabel,
  type TimetableLockViolation,
} from '../domain/timetableLocks.ts'

export const TIMETABLE_LOCK_UNLOCK_VISIBLE_TEXT = '固定を解除'

export interface TimetableLockFeedback {
  eventId: EventId
  message: string
}

export const getTimetableLockFeedbackMessage = (
  feedback: TimetableLockFeedback | null,
  selectedEventId: EventId,
): string => feedback?.eventId === selectedEventId ? feedback.message : ''

export const clearTimetableLockFeedback = (): null => null

export const getAffectedTimetableLockIds = (
  violations: TimetableLockViolation[],
): TimetableLockId[] => [
  ...new Set(violations.flatMap((violation) => violation.lockIds)),
]

export const getUniqueLockIdsForViolation = (
  violation: TimetableLockViolation,
): TimetableLockId[] => [...new Set(violation.lockIds)]

export const getTimetableLockControlAccessibleName = (
  itemLabel: string,
): string => `${itemLabel}のTT固定`

export const getTimetableLockUnlockAccessibleName = ({
  lockId,
  timetableLocks,
  scheduleItems,
  eventBands,
}: {
  lockId: TimetableLockId
  timetableLocks: TimetableLock[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
}): string => {
  const lock = timetableLocks.find((candidate) => candidate.id === lockId)
  if (!lock) return `TT固定（ID: ${lockId}）を解除`

  const scheduleItem = scheduleItems.find(
    (candidate) => candidate.id === lock.scheduleItemId,
  )
  const eventBand = scheduleItem?.kind === 'performance'
    ? eventBands.find((candidate) => candidate.id === scheduleItem.eventBandId)
    : undefined
  const targetLabel = eventBand?.name.trim() || '対象不明'
  return `${targetLabel}のTT固定（${getTimetableLockLabel(lock)}、ID: ${lock.id}）を解除`
}

export const getTimetableLockRepairSummary = (
  violations: TimetableLockViolation[],
): {
  visible: boolean
  affectedLockIds: TimetableLockId[]
} => {
  const affectedLockIds = getAffectedTimetableLockIds(violations)
  return {
    visible: violations.length > 0,
    affectedLockIds,
  }
}
