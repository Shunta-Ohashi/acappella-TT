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
  PaCapabilities,
  PaAssignment,
  ScheduleItem,
  Section,
  Stage,
  TimetableLock,
  TimetableOrderConstraint,
} from '../domain/models'
import { isSectionWithinStageTimeRange } from '../domain/eventStageSettings.ts'
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
  isLegacyDutyAssignment,
  isLegacyEventMemberV1,
  isLegacyMemberV1,
  isLegacyPaAssignment,
  isMember,
  isPaAssignment,
  isPersistedCollection,
  isRecord,
  isScheduleItem,
  isSection,
  isStage,
  isTimetableLock,
} from './persistenceValidation.ts'

export const CURRENT_STORAGE_VERSION = 4 as const
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

export interface PersistedAppStateV4 extends PersistedDomainState {
  version: typeof CURRENT_STORAGE_VERSION
}

interface LegacyScheduleBoundary {
  scheduleItemId: string
  edge: 'start' | 'end'
}

type LegacyPaAssignment = Omit<PaAssignment, 'from' | 'until'> & {
  from: LegacyScheduleBoundary
  until: LegacyScheduleBoundary
}

type LegacyDutyAssignment = Omit<DutyAssignment, 'from' | 'until'> & {
  from: LegacyScheduleBoundary
  until: LegacyScheduleBoundary
}

interface PersistedLegacyBoundaryState extends Omit<
  PersistedDomainState,
  'paAssignments' | 'dutyAssignments'
> {
  paAssignments: LegacyPaAssignment[]
  dutyAssignments: LegacyDutyAssignment[]
}

interface PersistedAppStateV3 extends PersistedLegacyBoundaryState {
  version: 3
}

interface PersistedAppStateV2 extends Omit<
  PersistedLegacyBoundaryState, 'timetableOrderConstraints'
> {
  version: 2
}

interface PersistedAppStateV1 extends Omit<
  PersistedLegacyBoundaryState,
  'members' | 'eventMembers' | 'timetableLocks' | 'timetableOrderConstraints'
> {
  version: 1
  members: Array<Member & { paCapabilities?: PaCapabilities }>
  eventMembers: Array<Omit<EventMember, 'paCapabilities'>>
  timetableLocks?: TimetableLock[]
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
  assignmentValidators: {
    pa: (value: unknown) => value is PaAssignment | Record<string, unknown>
    duty: (value: unknown) => value is DutyAssignment | Record<string, unknown>
  },
): boolean =>
  isPersistedCollection(value.bands, isBand) &&
  isPersistedCollection(value.events, isEvent) &&
  isPersistedCollection(value.eventDays, isEventDay) &&
  isPersistedCollection(value.stages, isStage) &&
  isPersistedCollection(value.sections, isSection) &&
  isPersistedCollection(value.eventMemberDays, isEventMemberDay) &&
  isPersistedCollection(value.eventBands, isEventBand) &&
  isPersistedCollection(value.scheduleItems, isScheduleItem) &&
  isPersistedCollection(value.paAssignments, assignmentValidators.pa) &&
  isPersistedCollection(value.dutyTypes, isDutyType) &&
  isPersistedCollection(value.dutyAssignments, assignmentValidators.duty)

export const isPersistedAppStateV4 = (
  value: unknown,
): boolean =>
  isRecord(value) &&
  value.version === CURRENT_STORAGE_VERSION &&
  isPersistedCollection(value.members, isMember) &&
  isPersistedCollection(value.eventMembers, isEventMember) &&
  hasValidSharedCollections(value, { pa: isPaAssignment, duty: isDutyAssignment }) &&
  isPersistedCollection(value.timetableLocks, isTimetableLock) &&
  isPersistedCollection(
    value.timetableOrderConstraints,
    isTimetableOrderConstraint,
  ) &&
  hasValidSnapshotRelationships(value as unknown as PersistedDomainState)

const isPersistedAppStateV2 = (value: unknown): boolean =>
  isRecord(value) &&
  value.version === 2 &&
  isPersistedCollection(value.members, isMember) &&
  isPersistedCollection(value.eventMembers, isEventMember) &&
  hasValidSharedCollections(value, {
    pa: isLegacyPaAssignment,
    duty: isLegacyDutyAssignment,
  }) &&
  isPersistedCollection(value.timetableLocks, isTimetableLock) &&
  hasValidSnapshotRelationships(value as unknown as PersistedDomainState)

const isPersistedAppStateV1 = (value: unknown): boolean =>
  isRecord(value) &&
  value.version === 1 &&
  isPersistedCollection(value.members, isLegacyMemberV1) &&
  isPersistedCollection(value.eventMembers, isLegacyEventMemberV1) &&
  hasValidSharedCollections(value, {
    pa: isLegacyPaAssignment,
    duty: isLegacyDutyAssignment,
  }) &&
  (value.timetableLocks === undefined ||
    isPersistedCollection(value.timetableLocks, isTimetableLock)) &&
  hasValidSnapshotRelationships(value as unknown as PersistedDomainState)

const isPersistedAppStateV3 = (value: unknown): boolean =>
  isRecord(value) &&
  value.version === 3 &&
  isPersistedCollection(value.members, isMember) &&
  isPersistedCollection(value.eventMembers, isEventMember) &&
  hasValidSharedCollections(value, {
    pa: isLegacyPaAssignment,
    duty: isLegacyDutyAssignment,
  }) &&
  isPersistedCollection(value.timetableLocks, isTimetableLock) &&
  isPersistedCollection(value.timetableOrderConstraints, isTimetableOrderConstraint) &&
  hasValidSnapshotRelationships(value as unknown as PersistedDomainState)

const migrateBoundary = (boundary: LegacyScheduleBoundary): PaAssignment['from'] => ({
  kind: 'schedule-item',
  scheduleItemId: boundary.scheduleItemId,
  edge: boundary.edge,
})

const migrateLegacyBoundaries = <T extends {
  paAssignments: LegacyPaAssignment[]
  dutyAssignments: LegacyDutyAssignment[]
}>(
  legacy: T,
) => ({
  ...legacy,
  paAssignments: legacy.paAssignments.map((assignment) => ({
    ...assignment,
    from: migrateBoundary(assignment.from),
    until: migrateBoundary(assignment.until),
  })),
  dutyAssignments: legacy.dutyAssignments.map((assignment) => ({
    ...assignment,
    from: migrateBoundary(assignment.from),
    until: migrateBoundary(assignment.until),
  })),
})

const migrateV1ToV4 = (legacy: PersistedAppStateV1): PersistedAppStateV4 => {
  const capabilitiesByMemberId = new Map(legacy.members.map((member) => [
    member.id,
    member.paCapabilities,
  ]))
  return {
    ...migrateLegacyBoundaries(legacy),
    version: CURRENT_STORAGE_VERSION,
    members: legacy.members.map((member) => {
      const migratedMember = { ...member }
      delete migratedMember.paCapabilities
      return migratedMember
    }),
    eventMembers: legacy.eventMembers.map((eventMember) => ({
      ...eventMember,
      paCapabilities: {
        main: capabilitiesByMemberId.get(eventMember.memberId)?.main ?? false,
        sub: capabilitiesByMemberId.get(eventMember.memberId)?.sub ?? false,
      },
    })),
    timetableLocks: legacy.timetableLocks ?? [],
    timetableOrderConstraints: [],
  }
}

const migrateV2ToV4 = (legacy: PersistedAppStateV2): PersistedAppStateV4 => ({
  ...migrateLegacyBoundaries(legacy),
  version: CURRENT_STORAGE_VERSION,
  timetableOrderConstraints: [],
})

const migrateV3ToV4 = (legacy: PersistedAppStateV3): PersistedAppStateV4 => ({
  ...migrateLegacyBoundaries(legacy),
  version: CURRENT_STORAGE_VERSION,
})

export const createPersistedAppState = (
  state: PersistedDomainState,
): PersistedAppStateV4 => ({
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
): PersistedAppStateV4 | undefined => {
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (isPersistedAppStateV4(parsed)) return parsed as PersistedAppStateV4
    if (isPersistedAppStateV3(parsed)) {
      return migrateV3ToV4(parsed as PersistedAppStateV3)
    }
    if (isPersistedAppStateV2(parsed)) {
      return migrateV2ToV4(parsed as PersistedAppStateV2)
    }
    if (isPersistedAppStateV1(parsed)) {
      return migrateV1ToV4(parsed as PersistedAppStateV1)
    }
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
): PersistedAppStateV4 | undefined => {
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
): PersistedAppStateV4 =>
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
