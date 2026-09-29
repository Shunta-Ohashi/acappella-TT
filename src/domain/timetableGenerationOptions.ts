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

interface GenerationBreakScope {
  event: Pick<Event, 'id'>
  eventDay: Pick<EventDay, 'id' | 'eventId'>
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  scheduleItems: ScheduleItem[]
}

/** Only well-formed Section-anchored Breaks on the target day can be removed by an option. */
const isTimetableGenerationRemovableBreak = (item: ScheduleItem, {
  event, eventDay, eventDays, stages, sections, scheduleItems,
}: GenerationBreakScope): boolean => {
  const matchingDays = eventDays.filter(day => day.id === eventDay.id)
  if (eventDay.eventId !== event.id || matchingDays.length !== 1 ||
    matchingDays[0].eventId !== event.id || item.kind !== 'break' ||
    scheduleItems.filter(candidate => candidate.id === item.id).length !== 1) return false
  const matchingStages = stages.filter(stage => stage.id === item.stageId)
  if (matchingStages.length !== 1 || matchingStages[0].eventDayId !== eventDay.id) return false
  const anchorId = item.sectionId ?? item.afterSectionId
  if (anchorId === undefined) return false // Sectionless Stage Breaks are always retained.
  return sections.filter(section => section.id === anchorId).length === 1 &&
    isValidScheduleItemSectionAssignment(item.stageId, sections.filter(s => s.stageId === item.stageId), item) &&
    isValidBreakDurationMinutes(item.durationMinutes) && Number.isSafeInteger(item.order) && item.order >= 0 &&
    typeof item.id === 'string' && !!item.id.trim() && typeof item.title === 'string'
}

/** Preprocess only valid target-day Breaks; malformed data must reach core validation. */
export const createScheduleItemsForTimetableGeneration = (input: GenerationBreakScope & {
  options: TimetableGenerationUiOptions
}): ScheduleItem[] => input.scheduleItems.filter(item =>
  !isTimetableGenerationRemovableBreak(item, input) ||
    (item.sectionId !== undefined
      ? input.options.keepIntraSectionBreaks : input.options.keepInterSectionBreaks
    ))

export const hasSameItemContents = (left: ScheduleItem, right: ScheduleItem,
  ignoredFields: ReadonlySet<string> = new Set()): boolean => {
  const leftFields = left as unknown as Record<string, unknown>
  const rightFields = right as unknown as Record<string, unknown>
  const keys = Object.keys(leftFields).filter(key => !ignoredFields.has(key))
  return keys.length === Object.keys(rightFields).filter(key => !ignoredFields.has(key)).length &&
    keys.every(key => Object.hasOwn(rightFields, key) && Object.is(leftFields[key], rightFields[key]))
}

/** A generation baseline must be a pure filter of the source collection. */
export const validateTimetableGenerationBaseline = ({
  event, eventDay, eventDays, stages, sections, sourceScheduleItems, generationScheduleItems,
}: Omit<GenerationBreakScope, 'scheduleItems'> & {
  sourceScheduleItems: ScheduleItem[]
  generationScheduleItems: ScheduleItem[]
}): boolean => {
  if ([...sourceScheduleItems, ...generationScheduleItems].some(item =>
    item === null || typeof item !== 'object' || typeof item.id !== 'string')) return false
  const sourceById = new Map(sourceScheduleItems.map((item, index) => [item.id, { item, index }]))
  if (sourceById.size !== sourceScheduleItems.length) return false
  const retainedIds = new Set<string>()
  let previousIndex = -1
  for (const item of generationScheduleItems) {
    const source = sourceById.get(item.id)
    if (!source || retainedIds.has(item.id) || source.index <= previousIndex ||
      !hasSameItemContents(source.item, item)) return false
    retainedIds.add(item.id)
    previousIndex = source.index
  }
  const scope = { event, eventDay, eventDays, stages, sections, scheduleItems: sourceScheduleItems }
  return sourceScheduleItems.every(item => retainedIds.has(item.id) ||
    isTimetableGenerationRemovableBreak(item, scope))
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
