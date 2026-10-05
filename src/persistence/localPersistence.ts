import type {
  Band,
  DutyAssignment,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  ScheduleItem,
  Section,
  Stage,
  TimetableLock,
  TimetableOrderConstraint,
} from '../domain/models'
import { isSectionWithinStageTimeRange } from '../domain/stageTimeRanges.ts'
import { isTimetableOrderConstraint } from '../domain/timetableOrderConstraints.ts'
import {
  isBand,
  isDutyAssignment,
  isDutyType,
  isEvent,
  isEventBand,
  isEventDay,
  isEventMember,
  isEventMemberDay,
  isMember,
  isPaAssignment,
  isPersistedCollection,
  isRecord,
  isScheduleItem,
  isSection,
  isStage,
  isTimetableLock,
} from './persistenceValidation.ts'

export const CURRENT_STORAGE_VERSION = 5 as const
export const STORAGE_KEY = 'acappella-tt:app-state'

export interface PersistedDomainState {
  members: Member[]
  bands: Band[]
  events: Event[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
  timetableOrderConstraints: TimetableOrderConstraint[]
}

export interface PersistedAppStateV5 extends PersistedDomainState {
  version: typeof CURRENT_STORAGE_VERSION
}

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const hasResolvablePerformanceEventBands = ({
  eventBands,
  eventDays,
  scheduleItems,
  stages,
}: Pick<PersistedDomainState, 'eventBands' | 'eventDays' | 'scheduleItems' | 'stages'>): boolean => {
  const eventBandsById = new Map(eventBands.map((eventBand) => [eventBand.id, eventBand]))
  const eventIdByDayId = new Map(eventDays.map((day) => [day.id, day.eventId]))
  const eventDayIdByStageId = new Map(stages.map((stage) =>
    [stage.id, stage.eventDayId]))

  return scheduleItems.every((item) => {
    if (item.kind !== 'performance') return true
    const eventBand = eventBandsById.get(item.eventBandId)
    if (!eventBand) return false
    const stageEventDayId = eventDayIdByStageId.get(item.stageId)
    if (stageEventDayId !== undefined && eventBand.eventDayId !== stageEventDayId) {
      return false
    }
    const stageEventId = stageEventDayId === undefined
      ? undefined
      : eventIdByDayId.get(stageEventDayId)
    return stageEventId === undefined || eventBand.eventId === stageEventId
  })
}

const hasValidSectionStageIntervals = ({
  sections,
  stages,
}: Pick<PersistedDomainState, 'sections' | 'stages'>): boolean => {
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]))

  return sections.every((section) => {
    const stage = stagesById.get(section.stageId)
    if (!stage) return true
    return isSectionWithinStageTimeRange(stage, section)
  })
}

const hasValidSnapshotRelationships = (
  value: PersistedDomainState,
): boolean =>
  hasResolvablePerformanceEventBands(value) &&
  hasValidSectionStageIntervals(value)

const hasValidSharedCollections = (
  value: Record<string, unknown>,
): boolean =>
  isPersistedCollection(value.bands, isBand) &&
  isPersistedCollection(value.events, isEvent) &&
  isPersistedCollection(value.eventDays, isEventDay) &&
  isPersistedCollection(value.stages, isStage) &&
  isPersistedCollection(value.sections, isSection) &&
  isPersistedCollection(value.eventMemberDays, isEventMemberDay) &&
  isPersistedCollection(value.eventBands, isEventBand) &&
  isPersistedCollection(value.scheduleItems, isScheduleItem) &&
  isPersistedCollection(value.paAssignments, isPaAssignment) &&
  isPersistedCollection(value.dutyTypes, isDutyType) &&
  isPersistedCollection(value.dutyAssignments, isDutyAssignment)

export const isPersistedAppStateV5 = (
  value: unknown,
): boolean =>
  isRecord(value) &&
  value.version === CURRENT_STORAGE_VERSION &&
  isPersistedCollection(value.members, isMember) &&
  isPersistedCollection(value.eventMembers, isEventMember) &&
  hasValidSharedCollections(value) &&
  isPersistedCollection(value.timetableLocks, isTimetableLock) &&
  isPersistedCollection(
    value.timetableOrderConstraints,
    isTimetableOrderConstraint,
  ) &&
  hasValidSnapshotRelationships(value as unknown as PersistedDomainState)

export const createPersistedAppState = (
  state: PersistedDomainState,
): PersistedAppStateV5 => ({
  version: CURRENT_STORAGE_VERSION,
  members: state.members,
  bands: state.bands,
  events: state.events,
  eventDays: state.eventDays,
  stages: state.stages,
  sections: state.sections,
  eventMembers: state.eventMembers,
  eventMemberDays: state.eventMemberDays,
  eventBands: state.eventBands,
  scheduleItems: state.scheduleItems,
  paAssignments: state.paAssignments,
  dutyTypes: state.dutyTypes,
  dutyAssignments: state.dutyAssignments,
  timetableLocks: state.timetableLocks,
  timetableOrderConstraints: state.timetableOrderConstraints,
})

export const serializePersistedState = (
  state: PersistedDomainState,
): string => JSON.stringify(createPersistedAppState(state))

export const parsePersistedState = (
  serialized: string,
): PersistedAppStateV5 | undefined => {
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (isPersistedAppStateV5(parsed)) return parsed as PersistedAppStateV5
    return undefined
  } catch {
    return undefined
  }
}

const getBrowserStorage = (): StorageLike | undefined => {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export const loadPersistedState = (
  storage: StorageLike | undefined = getBrowserStorage(),
): PersistedAppStateV5 | undefined => {
  if (!storage) return undefined

  try {
    const serialized = storage.getItem(STORAGE_KEY)
    if (serialized === null) return undefined

    const state = parsePersistedState(serialized)
    if (state) return state

    storage.removeItem(STORAGE_KEY)
    return undefined
  } catch {
    return undefined
  }
}

export const loadPersistedStateOrFallback = (
  createFallback: () => PersistedDomainState,
  storage: StorageLike | undefined = getBrowserStorage(),
): PersistedAppStateV5 =>
  loadPersistedState(storage) ?? createPersistedAppState(createFallback())

export const savePersistedState = (
  state: PersistedDomainState,
  storage: StorageLike | undefined = getBrowserStorage(),
): boolean => {
  if (!storage) return false

  try {
    storage.setItem(STORAGE_KEY, serializePersistedState(state))
    return true
  } catch (error) {
    console.warn('ローカルデータを保存できませんでした。', error)
    return false
  }
}

export const clearPersistedState = (
  storage: StorageLike | undefined = getBrowserStorage(),
): boolean => {
  if (!storage) return false

  try {
    storage.removeItem(STORAGE_KEY)
    return true
  } catch (error) {
    console.warn('ローカルデータを削除できませんでした。', error)
    return false
  }
}
