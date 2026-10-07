import type {
  Band,
  EventId,
  Member,
} from '../domain/models.ts'
import {
  createEventDeletion,
  type EventDeletionInput,
} from '../domain/eventDeletion.ts'
import {
  createPersistedAppState,
  isPersistedAppStateV5,
  type PersistedAppStateV5,
  type PersistedDomainState,
} from '../persistence/localPersistence.ts'
import { isRecord } from '../persistence/persistenceValidation.ts'

export const CLOUD_EVENT_SNAPSHOT_VERSION = 1 as const
export const CLOUD_EVENT_SNAPSHOT_FORMAT = 'acappella-tt-cloud-event' as const

export interface CloudEventSnapshotV1 {
  format: typeof CLOUD_EVENT_SNAPSHOT_FORMAT
  version: typeof CLOUD_EVENT_SNAPSHOT_VERSION
  appState: PersistedAppStateV5
}

export type CloudEventSnapshotResult =
  | { ok: true; snapshot: CloudEventSnapshotV1 }
  | {
      ok: false
      reason: 'EVENT_NOT_FOUND' | 'EVENT_RELATIONSHIP_CONFLICT' | 'INVALID_SNAPSHOT'
    }

export type CloudWorkspaceSnapshotResult =
  | { ok: true; state: PersistedAppStateV5 }
  | {
      ok: false
      reason: 'INVALID_SNAPSHOT' | 'SHARED_MASTER_CONFLICT'
    }

const eventOwnedCollectionKeys = [
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
  'timetableLocks',
  'timetableOrderConstraints',
] as const

type EventOwnedCollectionKey = typeof eventOwnedCollectionKeys[number]

const createDeletionInput = (
  state: PersistedDomainState,
  eventId: EventId,
): EventDeletionInput => ({
  eventId,
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

const selectRemovedRecords = <T extends { id: string }>(
  current: readonly T[],
  retained: readonly T[],
): T[] => {
  const retainedIds = new Set(retained.map(item => item.id))
  return current.filter(item => !retainedIds.has(item.id))
}

const collectReferencedMasterIds = (
  eventState: Pick<
    PersistedDomainState,
    | 'eventMembers'
    | 'eventBands'
    | 'paAssignments'
    | 'dutyAssignments'
  >,
  bands: readonly Band[],
): { memberIds: Set<string>; bandIds: Set<string> } => {
  const memberIds = new Set<string>()
  const bandIds = new Set<string>()

  for (const eventMember of eventState.eventMembers) {
    memberIds.add(eventMember.memberId)
  }
  for (const eventBand of eventState.eventBands) {
    for (const memberId of eventBand.memberIds) memberIds.add(memberId)
    if (eventBand.bandId) bandIds.add(eventBand.bandId)
  }
  for (const assignment of eventState.paAssignments) {
    memberIds.add(assignment.memberId)
  }
  for (const assignment of eventState.dutyAssignments) {
    memberIds.add(assignment.memberId)
  }
  for (const band of bands) {
    if (!bandIds.has(band.id)) continue
    for (const memberId of band.defaultMemberIds) memberIds.add(memberId)
  }

  return { memberIds, bandIds }
}

const hasExactReferencedMasters = (state: PersistedAppStateV5): boolean => {
  const referenced = collectReferencedMasterIds(state, state.bands)
  const includedMemberIds = new Set(state.members.map(member => member.id))
  const includedBandIds = new Set(state.bands.map(band => band.id))
  return state.members.every(member => referenced.memberIds.has(member.id)) &&
    state.bands.every(band => referenced.bandIds.has(band.id)) &&
    [...referenced.memberIds].every(memberId => includedMemberIds.has(memberId)) &&
    [...referenced.bandIds].every(bandId => includedBandIds.has(bandId))
}

const hasUniqueIds = (items: readonly { id: string }[]): boolean =>
  new Set(items.map(item => item.id)).size === items.length

const hasOnlyOneEvent = (state: PersistedAppStateV5): boolean => {
  if (state.events.length !== 1) return false
  const deletion = createEventDeletion(createDeletionInput(state, state.events[0].id))
  if (!deletion.ok) return false
  return eventOwnedCollectionKeys.every(key => deletion[key].length === 0)
}

const hasValidCloudEventIdentity = (state: PersistedAppStateV5): boolean => {
  const event = state.events[0]
  return event !== undefined &&
    event.id.trim().length > 0 &&
    event.name.trim().length > 0
}

export const createCloudEventSnapshot = (
  state: PersistedDomainState,
  eventId: EventId,
): CloudEventSnapshotResult => {
  const deletion = createEventDeletion(createDeletionInput(state, eventId))
  if (!deletion.ok) return deletion

  const eventState = {
    events: selectRemovedRecords(state.events, deletion.events),
    eventDays: selectRemovedRecords(state.eventDays, deletion.eventDays),
    stages: selectRemovedRecords(state.stages, deletion.stages),
    sections: selectRemovedRecords(state.sections, deletion.sections),
    eventMembers: selectRemovedRecords(state.eventMembers, deletion.eventMembers),
    eventMemberDays: selectRemovedRecords(
      state.eventMemberDays,
      deletion.eventMemberDays,
    ),
    eventBands: selectRemovedRecords(state.eventBands, deletion.eventBands),
    scheduleItems: selectRemovedRecords(state.scheduleItems, deletion.scheduleItems),
    paAssignments: selectRemovedRecords(state.paAssignments, deletion.paAssignments),
    dutyTypes: selectRemovedRecords(state.dutyTypes, deletion.dutyTypes),
    dutyAssignments: selectRemovedRecords(
      state.dutyAssignments,
      deletion.dutyAssignments,
    ),
    timetableLocks: selectRemovedRecords(state.timetableLocks, deletion.timetableLocks),
    timetableOrderConstraints: selectRemovedRecords(
      state.timetableOrderConstraints,
      deletion.timetableOrderConstraints,
    ),
  }
  const referenced = collectReferencedMasterIds(eventState, state.bands)
  const appState = createPersistedAppState({
    members: state.members.filter(member => referenced.memberIds.has(member.id)),
    bands: state.bands.filter(band => referenced.bandIds.has(band.id)),
    ...eventState,
  })

  if (
    !isPersistedAppStateV5(appState) ||
    !hasUniqueIds(appState.members) ||
    !hasUniqueIds(appState.bands) ||
    !hasOnlyOneEvent(appState) ||
    !hasValidCloudEventIdentity(appState) ||
    !hasExactReferencedMasters(appState)
  ) {
    return { ok: false, reason: 'INVALID_SNAPSHOT' }
  }
  return {
    ok: true,
    snapshot: {
      format: CLOUD_EVENT_SNAPSHOT_FORMAT,
      version: CLOUD_EVENT_SNAPSHOT_VERSION,
      appState,
    },
  }
}

export const parseCloudEventSnapshot = (
  value: unknown,
): CloudEventSnapshotV1 | undefined => {
  if (
    !isRecord(value) ||
    value.format !== CLOUD_EVENT_SNAPSHOT_FORMAT ||
    value.version !== CLOUD_EVENT_SNAPSHOT_VERSION ||
    !isPersistedAppStateV5(value.appState)
  ) return undefined

  const snapshot = value as unknown as CloudEventSnapshotV1
  if (
    !hasUniqueIds(snapshot.appState.members) ||
    !hasUniqueIds(snapshot.appState.bands) ||
    !hasOnlyOneEvent(snapshot.appState) ||
    !hasValidCloudEventIdentity(snapshot.appState) ||
    !hasExactReferencedMasters(snapshot.appState)
  ) {
    return undefined
  }
  return snapshot
}

const mergeMasterRecords = <T extends Member | Band>(
  localRecords: readonly T[],
  snapshots: readonly CloudEventSnapshotV1[],
  selectRecords: (snapshot: CloudEventSnapshotV1) => readonly T[],
): T[] => {
  const byId = new Map(localRecords.map(record => [record.id, record]))
  for (const snapshot of snapshots) {
    for (const record of selectRecords(snapshot)) {
      byId.set(record.id, record)
    }
  }
  return [...byId.values()]
}

const arePersistedValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => arePersistedValuesEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false

  // JSON persistence omits undefined object fields, and object key order has no
  // semantic meaning. Arrays remain ordered because their order is persisted.
  const leftKeys = Object.keys(left)
    .filter(key => left[key] !== undefined)
    .sort()
  const rightKeys = Object.keys(right)
    .filter(key => right[key] !== undefined)
    .sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && arePersistedValuesEqual(left[key], right[key]))
}

const hasSharedMasterConflict = <T extends Member | Band>(
  snapshots: readonly CloudEventSnapshotV1[],
  selectRecords: (snapshot: CloudEventSnapshotV1) => readonly T[],
): boolean => {
  const byId = new Map<string, T>()
  for (const snapshot of snapshots) {
    for (const record of selectRecords(snapshot)) {
      const existing = byId.get(record.id)
      if (existing && !arePersistedValuesEqual(existing, record)) return true
      if (!existing) byId.set(record.id, record)
    }
  }
  return false
}

export const createCloudWorkspaceState = (
  localState: PersistedDomainState,
  snapshots: readonly CloudEventSnapshotV1[],
): CloudWorkspaceSnapshotResult => {
  if (snapshots.some(snapshot => !parseCloudEventSnapshot(snapshot))) {
    return { ok: false, reason: 'INVALID_SNAPSHOT' }
  }
  const eventIds = snapshots.map(snapshot => snapshot.appState.events[0]?.id)
  if (
    eventIds.some(eventId => eventId === undefined) ||
    new Set(eventIds).size !== eventIds.length
  ) return { ok: false, reason: 'INVALID_SNAPSHOT' }
  // Member/Band are Workspace-wide masters temporarily duplicated into Event
  // snapshots. Conflicting copies must never be silently resolved by Event
  // order or timestamps; fail closed until masters are normalized separately.
  if (
    hasSharedMasterConflict(snapshots, snapshot => snapshot.appState.members) ||
    hasSharedMasterConflict(snapshots, snapshot => snapshot.appState.bands)
  ) return { ok: false, reason: 'SHARED_MASTER_CONFLICT' }

  const eventCollections: Pick<PersistedDomainState, EventOwnedCollectionKey> = {
    events: snapshots.flatMap(snapshot => snapshot.appState.events),
    eventDays: snapshots.flatMap(snapshot => snapshot.appState.eventDays),
    stages: snapshots.flatMap(snapshot => snapshot.appState.stages),
    sections: snapshots.flatMap(snapshot => snapshot.appState.sections),
    eventMembers: snapshots.flatMap(snapshot => snapshot.appState.eventMembers),
    eventMemberDays: snapshots.flatMap(snapshot => snapshot.appState.eventMemberDays),
    eventBands: snapshots.flatMap(snapshot => snapshot.appState.eventBands),
    scheduleItems: snapshots.flatMap(snapshot => snapshot.appState.scheduleItems),
    paAssignments: snapshots.flatMap(snapshot => snapshot.appState.paAssignments),
    dutyTypes: snapshots.flatMap(snapshot => snapshot.appState.dutyTypes),
    dutyAssignments: snapshots.flatMap(snapshot => snapshot.appState.dutyAssignments),
    timetableLocks: snapshots.flatMap(snapshot => snapshot.appState.timetableLocks),
    timetableOrderConstraints: snapshots.flatMap(
      snapshot => snapshot.appState.timetableOrderConstraints,
    ),
  }
  if (eventOwnedCollectionKeys.some(key => !hasUniqueIds(eventCollections[key]))) {
    return { ok: false, reason: 'INVALID_SNAPSHOT' }
  }

  const state = createPersistedAppState({
    members: mergeMasterRecords(localState.members, snapshots, snapshot =>
      snapshot.appState.members),
    bands: mergeMasterRecords(localState.bands, snapshots, snapshot =>
      snapshot.appState.bands),
    ...eventCollections,
  })
  return isPersistedAppStateV5(state)
    ? { ok: true, state }
    : { ok: false, reason: 'INVALID_SNAPSHOT' }
}
