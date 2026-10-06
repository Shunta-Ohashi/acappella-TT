import type {
  EventBand,
  EventDay,
  ScheduleItem,
  Section,
  Stage,
  TimetableOrderConstraint,
} from '../domain/models'
import {
  evaluateTimetableOrderConstraints,
  evaluateScheduledTimetableOrderConstraints,
  type TimetableOrderConstraintViolation,
} from '../domain/timetableOrderConstraints.ts'

export type TimetableOrderConstraintScheduleStatus =
  | { kind: 'invalid'; label: '出演順制約：要修正' }
  | { kind: 'satisfied'; label: '現在のTT：条件どおり' }
  | { kind: 'missing'; label: '現在のTT：未配置あり' }
  | { kind: 'unmet'; label: '現在のTT：条件未達' }

export interface TimetableOrderConstraintOccurrence {
  constraint: TimetableOrderConstraint
  occurrenceIndex: number
  semanticViolations: TimetableOrderConstraintViolation[]
}

export const evaluateTimetableOrderConstraintOccurrences = ({
  eventId,
  timetableOrderConstraints,
  eventDays,
  stages,
  sections,
  eventBands,
}: {
  eventId: string
  timetableOrderConstraints: TimetableOrderConstraint[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
}): TimetableOrderConstraintOccurrence[] => {
  const canonicalEvaluation = evaluateTimetableOrderConstraints({
    eventId,
    timetableOrderConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
  })
  const idCounts = new Map<string, number>()
  for (const constraint of timetableOrderConstraints) {
    idCounts.set(constraint.id, (idCounts.get(constraint.id) ?? 0) + 1)
  }

  return timetableOrderConstraints.map((constraint, occurrenceIndex) => {
    const canonicalViolations = canonicalEvaluation.violations.filter(
      violation => violation.constraintIds.includes(constraint.id),
    )
    if ((idCounts.get(constraint.id) ?? 0) === 1) {
      return { constraint, occurrenceIndex, semanticViolations: canonicalViolations }
    }

    const duplicateIdViolations = canonicalViolations.filter(
      violation => violation.code === 'DUPLICATE_CONSTRAINT_ID',
    )
    const occurrenceViolations = evaluateTimetableOrderConstraints({
      eventId,
      timetableOrderConstraints: [constraint],
      eventDays,
      stages,
      sections,
      eventBands,
    }).violations
    return {
      constraint,
      occurrenceIndex,
      semanticViolations: [...duplicateIdViolations, ...occurrenceViolations],
    }
  })
}

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
