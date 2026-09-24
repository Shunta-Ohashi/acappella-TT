import type { EventId, TimetableLockId } from '../domain/models'
import type { TimetableLockViolation } from '../domain/timetableLocks'

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
