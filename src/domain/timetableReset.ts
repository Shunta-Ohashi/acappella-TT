import type { DutyAssignment, DutyType, Event, EventBand, EventDay, PaAssignment,
  ScheduleItem, Stage, TimetableLock } from './models'
import { getDutyAssignmentsForEvent } from './dutyAssignments.ts'

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

const uniqueIds = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length

/** Explicit, atomic reset; known foreign/other-day ownership outranks stale Stage references. */
export const resetEventDayTimetable = (input: TimetableResetInput): TimetableResetResult => {
  const { event, eventDay, eventDays, stages, eventBands, scheduleItems,
    paAssignments, dutyTypes, dutyAssignments, timetableLocks } = input
  if (eventDay.eventId !== event.id || !eventDays.some(day => day.id === eventDay.id && day.eventId === event.id) ||
    ![eventDays, stages, eventBands, scheduleItems, dutyTypes].every(uniqueIds)) {
    // Ambiguous reused IDs must not authorize a destructive operation.
    return { ok: false, code: 'INVALID_SCOPE' }
  }
  const eventDayById = new Map(eventDays.map(day => [day.id, day]))
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const bandById = new Map(eventBands.map(band => [band.id, band]))
  const itemById = new Map(scheduleItems.map(item => [item.id, item]))
  const targetStages = stages.filter(stage => stage.eventDayId === eventDay.id)
  const targetStageIds = new Set(targetStages.map(stage => stage.id))
  const removedPerformanceIds = new Set(scheduleItems.filter(item => {
    if (item.kind !== 'performance') return false
    const band = bandById.get(item.eventBandId)
    return band ? band.eventId === event.id && band.eventDayId === eventDay.id
      : targetStageIds.has(item.stageId)
  }).map(item => item.id))
  const nextItems = scheduleItems.filter(item => !removedPerformanceIds.has(item.id))
  const nextPa = paAssignments.filter(pa => pa.eventId !== event.id || pa.eventDayId !== eventDay.id)
  const eventStages = stages.filter(stage => eventDayById.get(stage.eventDayId)?.eventId === event.id)
  const targetDuties = new Set(getDutyAssignmentsForEvent({ event, stages: eventStages, dutyTypes, dutyAssignments })
    .filter(duty => duty.eventDayId === eventDay.id))
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
    return !targetStageIds.has(lock.stageId)
  })
  return { ok: true,
    hasChanges: nextItems.length !== scheduleItems.length || nextPa.length !== paAssignments.length ||
      nextDuty.length !== dutyAssignments.length || nextLocks.length !== timetableLocks.length,
    scheduleItems: nextItems, paAssignments: nextPa, dutyAssignments: nextDuty, timetableLocks: nextLocks,
  }
}
