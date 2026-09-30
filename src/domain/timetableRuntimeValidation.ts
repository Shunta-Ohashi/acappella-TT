import type { DutyAssignment, PaAssignment, ScheduleItem, TimetableLock } from './models'
import { isValidBreakDurationMinutes } from './schedule.ts'
import { isValidFixedPosition } from './timetableLocks.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isNonEmptyId = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim()

const hasUniqueIds = (items: unknown): items is (Record<string, unknown> & { id: string })[] =>
  Array.isArray(items) && items.every(item => isRecord(item) && isNonEmptyId(item.id)) &&
  new Set(items.map(item => item.id)).size === items.length

const hasValidBoundary = (value: unknown): boolean =>
  isRecord(value) && isNonEmptyId(value.scheduleItemId) &&
  (value.edge === 'start' || value.edge === 'end')

export const hasValidTimetableScheduleItems = (value: unknown): value is ScheduleItem[] =>
  hasUniqueIds(value) && value.every(item => {
    if (!isNonEmptyId(item.stageId) || !Number.isSafeInteger(item.order) || (item.order as number) < 0 ||
      (item.sectionId !== undefined && !isNonEmptyId(item.sectionId))) return false
    if (item.kind === 'performance') {
      return isNonEmptyId(item.eventBandId) && item.afterSectionId === undefined
    }
    if (item.kind === 'break') {
      return typeof item.title === 'string' && isValidBreakDurationMinutes(item.durationMinutes) &&
        (item.afterSectionId === undefined || isNonEmptyId(item.afterSectionId))
    }
    return false
  })

export const hasValidPaAssignments = (value: unknown): value is PaAssignment[] =>
  hasUniqueIds(value) && value.every(pa =>
    isNonEmptyId(pa.eventId) && isNonEmptyId(pa.eventDayId) &&
    isNonEmptyId(pa.stageId) && isNonEmptyId(pa.memberId) &&
    (pa.role === 'main' || pa.role === 'sub') &&
    hasValidBoundary(pa.from) && hasValidBoundary(pa.until))

export const hasValidDutyAssignments = (value: unknown): value is DutyAssignment[] =>
  hasUniqueIds(value) && value.every(duty =>
    isNonEmptyId(duty.dutyTypeId) && isNonEmptyId(duty.eventDayId) &&
    isNonEmptyId(duty.stageId) && isNonEmptyId(duty.memberId) &&
    hasValidBoundary(duty.from) && hasValidBoundary(duty.until))

export const hasValidTimetableLocks = (value: unknown): value is TimetableLock[] =>
  hasUniqueIds(value) && value.every(lock =>
    isNonEmptyId(lock.eventId) && isNonEmptyId(lock.scheduleItemId) &&
    isNonEmptyId(lock.stageId) &&
    (lock.sectionId === undefined || isNonEmptyId(lock.sectionId)) &&
    isValidFixedPosition(lock.position))
