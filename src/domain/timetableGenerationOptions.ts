import type { DutyAssignment, Event, EventDay, PaAssignment, ScheduleItem, Section, Stage,
  TimetableLock } from './models'
import { isValidBreakDurationMinutes, isValidScheduleItemSectionAssignment } from './schedule.ts'

export interface TimetableGenerationUiOptions {
  keepIntraSectionBreaks: boolean
  keepInterSectionBreaks: boolean
}

export const DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS: Readonly<TimetableGenerationUiOptions> = {
  keepIntraSectionBreaks: true,
  keepInterSectionBreaks: true,
}

/** Preprocess only valid target-day Breaks; malformed data must reach core validation. */
export const createScheduleItemsForTimetableGeneration = ({
  event, eventDay, eventDays, stages, sections, scheduleItems, options,
}: {
  event: Pick<Event, 'id'>
  eventDay: Pick<EventDay, 'id' | 'eventId'>
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  scheduleItems: ScheduleItem[]
  options: TimetableGenerationUiOptions
}): ScheduleItem[] => {
  const matchingDays = eventDays.filter(day => day.id === eventDay.id)
  const validScope = eventDay.eventId === event.id && matchingDays.length === 1 &&
    matchingDays[0].eventId === event.id
  return scheduleItems.filter(item => {
    if (!validScope || item.kind !== 'break' ||
      scheduleItems.filter(candidate => candidate.id === item.id).length !== 1) return true
    const matchingStages = stages.filter(stage => stage.id === item.stageId)
    if (matchingStages.length !== 1 || matchingStages[0].eventDayId !== eventDay.id) return true
    const anchorId = item.sectionId ?? item.afterSectionId
    if (anchorId === undefined) return true // Sectionless Stage Breaks are always retained.
    if (sections.filter(section => section.id === anchorId).length !== 1 ||
      !isValidScheduleItemSectionAssignment(item.stageId, sections.filter(s => s.stageId === item.stageId), item) ||
      !isValidBreakDurationMinutes(item.durationMinutes) || !Number.isSafeInteger(item.order) || item.order < 0 ||
      typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string') return true
    return item.sectionId !== undefined
      ? options.keepIntraSectionBreaks : options.keepInterSectionBreaks
  })
}

export type BreakRemovalValidation = { ok: true } | { ok: false; code: 'CROSS_SCOPE_BREAK_REFERENCE' }

/** Reject option-removed Breaks while any assignment or lock kept after apply still references them. */
export const validateTimetableGenerationBreakRemoval = ({
  event, eventDay, originalScheduleItems, generationScheduleItems,
  paAssignments, dutyAssignments, timetableLocks,
}: {
  event: Pick<Event, 'id'>
  eventDay: Pick<EventDay, 'id'>
  originalScheduleItems: ScheduleItem[]
  generationScheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
}): BreakRemovalValidation => {
  const generationIds = new Set(generationScheduleItems.map(item => item.id))
  const removedBreakIds = new Set(originalScheduleItems
    .filter(item => item.kind === 'break' && !generationIds.has(item.id))
    .map(item => item.id))
  const referencesRemovedBreak = ({ from, until }: Pick<PaAssignment, 'from' | 'until'>): boolean =>
    removedBreakIds.has(from.scheduleItemId) || removedBreakIds.has(until.scheduleItemId)
  if (timetableLocks.some(lock => removedBreakIds.has(lock.scheduleItemId)) ||
    dutyAssignments.some(referencesRemovedBreak) ||
    paAssignments.some(pa => (pa.eventId !== event.id || pa.eventDayId !== eventDay.id) &&
      referencesRemovedBreak(pa))) return { ok: false, code: 'CROSS_SCOPE_BREAK_REFERENCE' }
  return { ok: true }
}
