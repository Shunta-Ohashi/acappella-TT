import type { DutyAssignment, DutyType, Event, EventDay, PaAssignment, ScheduleItem, Section, Stage,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isNonEmptyId = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim()

/** Validate only the DutyType fields generation uses for identity and Event ownership. */
export const hasValidTimetableGenerationDutyTypes = (value: unknown): value is DutyType[] =>
  Array.isArray(value) && value.every(type => isRecord(type) &&
    isNonEmptyId(type.id) && isNonEmptyId(type.eventId)) &&
  new Set(value.map(type => type.id)).size === value.length

const hasBoundaryId = (value: unknown): boolean => isRecord(value) && isNonEmptyId(value.scheduleItemId)

const hasValidBreakScope = (scope: GenerationBreakScope): boolean =>
  isRecord(scope.event) && isNonEmptyId(scope.event.id) &&
  isRecord(scope.eventDay) && isNonEmptyId(scope.eventDay.id) && isNonEmptyId(scope.eventDay.eventId) &&
  [scope.eventDays, scope.stages, scope.sections, scope.scheduleItems].every(items =>
    Array.isArray(items) && items.every(item => isRecord(item) && isNonEmptyId(item.id)))

const hasValidBreakReferences = (
  paAssignments: PaAssignment[], dutyAssignments: DutyAssignment[], timetableLocks: TimetableLock[],
): boolean =>
  Array.isArray(paAssignments) && paAssignments.every(pa => isRecord(pa) &&
    isNonEmptyId(pa.eventId) && isNonEmptyId(pa.eventDayId) &&
    hasBoundaryId(pa.from) && hasBoundaryId(pa.until)) &&
  Array.isArray(dutyAssignments) && dutyAssignments.every(duty => isRecord(duty) &&
    hasBoundaryId(duty.from) && hasBoundaryId(duty.until)) &&
  Array.isArray(timetableLocks) && timetableLocks.every(lock =>
    isRecord(lock) && isNonEmptyId(lock.scheduleItemId))

/** Check runtime shapes before App's first generation preprocessing step. */
export const hasValidTimetableGenerationPreprocessingInput = (input: GenerationBreakScope & {
  options: TimetableGenerationUiOptions
  paAssignments: PaAssignment[]
  dutyAssignments: DutyAssignment[]
  dutyTypes: DutyType[]
  timetableLocks: TimetableLock[]
}): boolean => hasValidBreakScope(input) && isRecord(input.options) &&
  typeof input.options.keepIntraSectionBreaks === 'boolean' &&
  typeof input.options.keepInterSectionBreaks === 'boolean' &&
  hasValidTimetableGenerationDutyTypes(input.dutyTypes) &&
  hasValidBreakReferences(input.paAssignments, input.dutyAssignments, input.timetableLocks)

/** Only well-formed Section-anchored Breaks on the target day can be removed by an option. */
const isTimetableGenerationRemovableBreak = (item: ScheduleItem, {
  event, eventDay, eventDays, stages, sections, scheduleItems,
}: GenerationBreakScope): boolean => {
  if (!isRecord(item) || item.kind !== 'break' ||
    !hasValidBreakScope({ event, eventDay, eventDays, stages, sections, scheduleItems })) return false
  const matchingDays = eventDays.filter(day => day.id === eventDay.id)
  if (eventDay.eventId !== event.id || matchingDays.length !== 1 ||
    matchingDays[0].eventId !== event.id ||
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
}): ScheduleItem[] => {
  // Preserve malformed source data; App's preflight reports the error before this helper is called.
  if (!hasValidBreakScope(input) || !isRecord(input.options) ||
    typeof input.options.keepIntraSectionBreaks !== 'boolean' ||
    typeof input.options.keepInterSectionBreaks !== 'boolean') return input.scheduleItems
  return input.scheduleItems.filter(item =>
  !isTimetableGenerationRemovableBreak(item, input) ||
    (item.sectionId !== undefined
      ? input.options.keepIntraSectionBreaks : input.options.keepInterSectionBreaks
    ))
}

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
  if (!Array.isArray(sourceScheduleItems) || !Array.isArray(generationScheduleItems)) return false
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

export type BreakRemovalValidation = { ok: true } |
  { ok: false; code: 'CROSS_SCOPE_BREAK_REFERENCE' | 'INVALID_REFERENCE_SHAPE' }

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
  if (!isRecord(event) || !isNonEmptyId(event.id) ||
    !isRecord(eventDay) || !isNonEmptyId(eventDay.id) ||
    !Array.isArray(originalScheduleItems) || !Array.isArray(generationScheduleItems) ||
    [...originalScheduleItems, ...generationScheduleItems].some(item =>
      !isRecord(item) || !isNonEmptyId(item.id)) ||
    !hasValidBreakReferences(paAssignments, dutyAssignments, timetableLocks)) {
    return { ok: false, code: 'INVALID_REFERENCE_SHAPE' }
  }
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
