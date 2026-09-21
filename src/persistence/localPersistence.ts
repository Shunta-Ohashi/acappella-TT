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
} from '../domain/models'

export const CURRENT_STORAGE_VERSION = 1 as const
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
}

export interface PersistedAppStateV1 extends PersistedDomainState {
  version: typeof CURRENT_STORAGE_VERSION
}

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const collectionKeys = [
  'members',
  'bands',
  'events',
  'eventDays',
  'stages',
  'sections',
  'eventMembers',
  'eventMemberDays',
  'eventBands',
  'scheduleItems',
  'paAssignments',
  'dutyTypes',
  'dutyAssignments',
] as const satisfies readonly (keyof PersistedDomainState)[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isPersistedAppStateV1 = (
  value: unknown,
): value is PersistedAppStateV1 =>
  isRecord(value) &&
  value.version === CURRENT_STORAGE_VERSION &&
  collectionKeys.every((key) => Array.isArray(value[key]))

export const createPersistedAppState = (
  state: PersistedDomainState,
): PersistedAppStateV1 => ({
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
})

export const serializePersistedState = (
  state: PersistedDomainState,
): string => JSON.stringify(createPersistedAppState(state))

export const parsePersistedState = (
  serialized: string,
): PersistedAppStateV1 | undefined => {
  try {
    const parsed: unknown = JSON.parse(serialized)
    return isPersistedAppStateV1(parsed) ? parsed : undefined
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
): PersistedAppStateV1 | undefined => {
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
): PersistedAppStateV1 =>
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
