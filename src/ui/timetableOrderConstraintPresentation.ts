import type { ScheduleItem, TimetableOrderConstraint } from '../domain/models'
import {
  evaluateScheduledTimetableOrderConstraints,
  type TimetableOrderConstraintViolation,
} from '../domain/timetableOrderConstraints.ts'

export type TimetableOrderConstraintScheduleStatus =
  | { kind: 'invalid'; label: '出演順制約：要修正' }
  | { kind: 'satisfied'; label: '現在のTT：条件どおり' }
  | { kind: 'missing'; label: '現在のTT：未配置あり' }
  | { kind: 'unmet'; label: '現在のTT：条件未達' }

export const getTimetableOrderConstraintScheduleStatus = ({
  constraint,
  scheduleItems,
  semanticViolations,
}: {
  constraint: TimetableOrderConstraint
  scheduleItems: ScheduleItem[]
  semanticViolations: TimetableOrderConstraintViolation[]
}): TimetableOrderConstraintScheduleStatus => {
  if (semanticViolations.length > 0) {
    return { kind: 'invalid', label: '出演順制約：要修正' }
  }
  const evaluation = evaluateScheduledTimetableOrderConstraints({
    timetableOrderConstraints: [constraint],
    scheduleItems,
  })
  if (evaluation.valid) return { kind: 'satisfied', label: '現在のTT：条件どおり' }
  if (evaluation.violations.some(violation => violation.code === 'MISSING_EVENT_BAND')) {
    return { kind: 'missing', label: '現在のTT：未配置あり' }
  }
  return { kind: 'unmet', label: '現在のTT：条件未達' }
}
