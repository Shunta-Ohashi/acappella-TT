import type { DutyAssignment, DutyType, Event, EventBand, EventDay, PaAssignment,
  ScheduleItem, Stage, TimetableLock } from './models'
import { getDutyAssignmentsForEvent } from './dutyAssignments.ts'
import { getReferencedScheduleItemIds } from './scheduleBoundaries.ts'
import { hasConsistentPaOwnership, hasValidDutyAssignments, hasValidPaAssignments, hasValidTimetableLocks,
  hasValidTimetableScheduleItems } from './timetableRuntimeValidation.ts'

interface TimetableResetInput {
  event: Pick<Event, 'id'>
  eventDay: Pick<EventDay, 'id' | 'eventId'>
  eventDays: EventDay[]
  stages: Stage[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
}

export type TimetableResetResult = {
  ok: true
  hasChanges: boolean
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
} | { ok: false; code: 'INVALID_SCOPE' }

const isNonEmptyId = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasValidId = (value: unknown): value is { id: string } =>
  isRecord(value) && isNonEmptyId(value.id)

const uniqueIds = (items: unknown): boolean => {
  if (!Array.isArray(items)) return false
  const ids = new Set<string>()
  for (const item of items) {
    if (!hasValidId(item) || ids.has(item.id)) return false
    ids.add(item.id)
  }
  return true
}

const hasValidScopeReferences = (input: TimetableResetInput): boolean =>
  input.eventDays.every(day => isNonEmptyId(day.eventId)) &&
  input.stages.every(stage => isNonEmptyId(stage.eventDayId)) &&
  input.eventBands.every(band => isNonEmptyId(band.eventId) && isNonEmptyId(band.eventDayId)) &&
  input.dutyTypes.every(dutyType => isNonEmptyId(dutyType.eventId))

/** Explicit, atomic reset; known foreign/other-day ownership outranks stale Stage references. */
export const resetEventDayTimetable = (input: TimetableResetInput): TimetableResetResult => {
  if (!isRecord(input)) return { ok: false, code: 'INVALID_SCOPE' }
  const { event, eventDay, eventDays, stages, eventBands, scheduleItems,
    paAssignments, dutyTypes, dutyAssignments, timetableLocks } = input
  if (!hasValidId(event) || !hasValidId(eventDay) || !isNonEmptyId(eventDay.eventId) ||
    ![eventDays, stages, eventBands, dutyTypes].every(uniqueIds) ||
    !hasValidTimetableScheduleItems(scheduleItems) ||
    !hasValidPaAssignments(paAssignments) || !hasValidDutyAssignments(dutyAssignments) ||
    !hasValidTimetableLocks(timetableLocks) ||
    !hasValidScopeReferences(input) ||
    eventDay.eventId !== event.id ||
    !eventDays.some(day => day.id === eventDay.id && day.eventId === event.id)) {
    // Malformed or ambiguous IDs must not authorize a destructive operation.
    return { ok: false, code: 'INVALID_SCOPE' }
  }
  const eventDayById = new Map(eventDays.map(day => [day.id, day]))
  if (stages.some(stage => !eventDayById.has(stage.eventDayId)) ||
    eventBands.some(band => eventDayById.get(band.eventDayId)?.eventId !== band.eventId) ||
    !hasConsistentPaOwnership(paAssignments, eventDays, stages)) {
    return { ok: false, code: 'INVALID_SCOPE' }
  }
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const bandById = new Map(eventBands.map(band => [band.id, band]))
  const itemById = new Map(scheduleItems.map(item => [item.id, item]))
  const dutyTypeById = new Map(dutyTypes.map(type => [type.id, type]))
  const targetStages = stages.filter(stage => stage.eventDayId === eventDay.id)
  const targetStageIds = new Set(targetStages.map(stage => stage.id))
  if (dutyAssignments.some(duty => {
    const stage = stageById.get(duty.stageId)
    if (stage && stage.eventDayId !== duty.eventDayId &&
      (duty.eventDayId === eventDay.id || targetStageIds.has(stage.id))) return true
    const dutyType = dutyTypeById.get(duty.dutyTypeId)
    return duty.eventDayId === eventDay.id && targetStageIds.has(duty.stageId) &&
      dutyType !== undefined && dutyType.eventId !== event.id
  })) return { ok: false, code: 'INVALID_SCOPE' }
  if (scheduleItems.some(item => item.kind === 'performance' && targetStageIds.has(item.stageId) &&
    !bandById.has(item.eventBandId))) return { ok: false, code: 'INVALID_SCOPE' }
  const removedPerformanceIds = new Set(scheduleItems.filter(item => {
    if (item.kind !== 'performance') return false
    const band = bandById.get(item.eventBandId)
    return band !== undefined && band.eventId === event.id && band.eventDayId === eventDay.id
  }).map(item => item.id))
  const eventStages = stages.filter(stage => eventDayById.get(stage.eventDayId)?.eventId === event.id)
  const targetDuties = new Set(getDutyAssignmentsForEvent({ event, stages: eventStages, dutyTypes, dutyAssignments })
    .filter(duty => duty.eventDayId === eventDay.id))
  const referencesRemovedPerformance = ({ from, until }: Pick<PaAssignment, 'from' | 'until'>): boolean =>
    getReferencedScheduleItemIds([from, until])
      .some((id) => removedPerformanceIds.has(id))
  // A Lock's own Stage must belong to the reset day before its referenced Performance may be removed.
  if (timetableLocks.some(lock => removedPerformanceIds.has(lock.scheduleItemId) &&
    (lock.eventId !== event.id || !targetStageIds.has(lock.stageId))) ||
    paAssignments.some(pa => (pa.eventId !== event.id || pa.eventDayId !== eventDay.id) &&
      referencesRemovedPerformance(pa)) ||
    dutyAssignments.some(duty => !targetDuties.has(duty) && referencesRemovedPerformance(duty))) {
    return { ok: false, code: 'INVALID_SCOPE' }
  }
  const nextItems = scheduleItems.filter(item => !removedPerformanceIds.has(item.id))
  const nextPa = paAssignments.filter(pa => pa.eventId !== event.id || pa.eventDayId !== eventDay.id)
  const nextDuty = dutyAssignments.filter(duty => !targetDuties.has(duty))
  const nextLocks = timetableLocks.filter(lock => {
    if (lock.eventId !== event.id) return true
    const item = itemById.get(lock.scheduleItemId)
    if (item?.kind === 'performance') {
      const band = bandById.get(item.eventBandId)
      if (band && (band.eventId !== event.id || band.eventDayId !== eventDay.id)) return true
      if (removedPerformanceIds.has(item.id)) return false
    }
    // An existing item on another day is affirmative ownership evidence, not a broken target Lock.
    if (item && stageById.has(item.stageId) && !targetStageIds.has(item.stageId)) return true
    // The referenced item's target Stage outranks a stale Stage stored on the Lock.
    if (item && targetStageIds.has(item.stageId)) return false
    return !targetStageIds.has(lock.stageId)
  })
  return { ok: true,
    hasChanges: nextItems.length !== scheduleItems.length || nextPa.length !== paAssignments.length ||
      nextDuty.length !== dutyAssignments.length || nextLocks.length !== timetableLocks.length,
    scheduleItems: nextItems, paAssignments: nextPa, dutyAssignments: nextDuty, timetableLocks: nextLocks,
  }
}
