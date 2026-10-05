import type {
  EventDay,
  ScheduleItem,
  Section,
  Stage,
  TimetableOrderConstraint,
} from '../domain/models'
import {
  evaluateScheduledTimetableOrderConstraints,
  type TimetableOrderConstraintViolation,
} from '../domain/timetableOrderConstraints.ts'

export type TimetableOrderConstraintScheduleStatus =
  | { kind: 'invalid'; label: '出演順制約：要修正' }
  | { kind: 'satisfied'; label: '現在のTT：条件どおり' }
  | { kind: 'missing'; label: '現在のTT：未配置あり' }
  | { kind: 'unmet'; label: '現在のTT：条件未達' }

export const getInitialTimetableOrderConstraintSectionId = ({
  constraint,
  sections,
}: {
  constraint?: TimetableOrderConstraint
  sections: Section[]
}): string => sections.length > 0 ? constraint?.sectionId ?? '' : ''

export const isTimetableOrderConstraintScopeReachable = ({
  constraint,
  eventId,
  eventDays,
  stages,
}: {
  constraint: TimetableOrderConstraint
  eventId: string
  eventDays: EventDay[]
  stages: Stage[]
}): boolean => {
  if (constraint.eventId !== eventId) return false
  const eventDay = eventDays.find(candidate => candidate.id === constraint.eventDayId)
  if (!eventDay || eventDay.eventId !== eventId) return false
  const stage = stages.find(candidate => candidate.id === constraint.stageId)
  return stage?.eventDayId === constraint.eventDayId
}

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
