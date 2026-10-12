import type {
  Band,
  EventId,
  Member,
  ScheduleBoundary,
} from '../domain/models.ts'
import {
  createEventDeletion,
  type EventDeletionInput,
} from '../domain/eventDeletion.ts'
import { isValidScheduleItemSectionAssignment } from '../domain/schedule.ts'
import {
  createPersistedAppState,
  isPersistedAppStateV5,
  type PersistedAppStateV5,
  type PersistedDomainState,
} from '../persistence/localPersistence.ts'
import {
  isBand,
  isMember,
  isRecord,
} from '../persistence/persistenceValidation.ts'

export const CLOUD_EVENT_SNAPSHOT_VERSION = 1 as const
export const CLOUD_EVENT_SNAPSHOT_V2_VERSION = 2 as const
export const CLOUD_EVENT_SNAPSHOT_FORMAT = 'acappella-tt-cloud-event' as const

export interface CloudEventSnapshotV1 {
  format: typeof CLOUD_EVENT_SNAPSHOT_FORMAT
  version: typeof CLOUD_EVENT_SNAPSHOT_VERSION
  appState: PersistedAppStateV5
}

export type CloudEventOwnedStateV2 = Pick<
  PersistedAppStateV5,
  'version' | EventOwnedCollectionKey
>

export interface CloudEventSnapshotV2 {
  format: typeof CLOUD_EVENT_SNAPSHOT_FORMAT
  version: typeof CLOUD_EVENT_SNAPSHOT_V2_VERSION
  eventState: CloudEventOwnedStateV2
  masterReferences: {
    memberIds: string[]
    bandIds: string[]
  }
}

export type CloudEventSnapshot = CloudEventSnapshotV1 | CloudEventSnapshotV2

export type CloudEventSnapshotResult =
  | { ok: true; snapshot: CloudEventSnapshotV1 }
  | {
      ok: false
      reason: 'EVENT_NOT_FOUND' | 'EVENT_RELATIONSHIP_CONFLICT' | 'INVALID_SNAPSHOT'
    }

export type CloudEventSnapshotV2Result =
  | { ok: true; snapshot: CloudEventSnapshotV2 }
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

const cloudEventSnapshotV2Keys = [
  'format',
  'version',
  'eventState',
  'masterReferences',
] as const

const cloudEventOwnedStateV2Keys = [
  'version',
  ...eventOwnedCollectionKeys,
] as const

const cloudEventMasterReferenceKeys = ['memberIds', 'bandIds'] as const

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every(key => Object.hasOwn(value, key))
}

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

const collectDirectReferencedMasterIds = (
  eventState: Pick<
    PersistedDomainState,
    | 'eventMembers'
    | 'eventBands'
    | 'paAssignments'
    | 'dutyAssignments'
  >,
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

const hasUniqueNonEmptyStrings = (items: readonly string[]): boolean =>
  Array.from(items).every(item => typeof item === 'string' && item.trim().length > 0) &&
  new Set(items).size === items.length

const hasUniqueEventOwnedCollectionIds = (
  state: Pick<PersistedDomainState, EventOwnedCollectionKey>,
): boolean => eventOwnedCollectionKeys.every(key => hasUniqueIds(state[key]))

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

const hasBoundaryInStage = (
  boundary: ScheduleBoundary,
  stageId: string,
  scheduleItemById: ReadonlyMap<string, PersistedAppStateV5['scheduleItems'][number]>,
  sectionById: ReadonlyMap<string, PersistedAppStateV5['sections'][number]>,
): boolean => {
  if (boundary.kind === 'time') return true
  if (boundary.kind === 'schedule-item') {
    return scheduleItemById.get(boundary.scheduleItemId)?.stageId === stageId
  }
  return sectionById.get(boundary.sectionId)?.stageId === stageId
}

/**
 * Cloud Event snapshots are self-contained trust-boundary documents. Unlike
 * local persistence, every Event-owned reference must resolve inside this one
 * snapshot and remain within its sole Event.
 */
export const hasValidCloudEventRelationships = (
  state: PersistedAppStateV5,
): boolean => {
  const event = state.events[0]
  if (
    !event ||
    state.events.length !== 1 ||
    !hasUniqueIds(state.members) ||
    !hasUniqueIds(state.bands) ||
    !hasUniqueEventOwnedCollectionIds(state)
  ) return false

  const memberById = new Map(state.members.map(member => [member.id, member]))
  const bandById = new Map(state.bands.map(band => [band.id, band]))
  const eventDayById = new Map(state.eventDays.map(day => [day.id, day]))
  const stageById = new Map(state.stages.map(stage => [stage.id, stage]))
  const sectionById = new Map(state.sections.map(section => [section.id, section]))
  const eventMemberById = new Map(
    state.eventMembers.map(eventMember => [eventMember.id, eventMember]),
  )
  const eventBandById = new Map(
    state.eventBands.map(eventBand => [eventBand.id, eventBand]),
  )
  const scheduleItemById = new Map(
    state.scheduleItems.map(item => [item.id, item]),
  )
  const dutyTypeById = new Map(state.dutyTypes.map(dutyType => [dutyType.id, dutyType]))

  if (state.bands.some(band =>
    band.defaultMemberIds.some(memberId => !memberById.has(memberId)))) return false
  if (state.eventDays.some(day => day.eventId !== event.id)) return false
  if (state.stages.some(stage => {
    const day = eventDayById.get(stage.eventDayId)
    return day?.eventId !== event.id
  })) return false
  if (state.sections.some(section => {
    const stage = stageById.get(section.stageId)
    const day = stage ? eventDayById.get(stage.eventDayId) : undefined
    return day?.eventId !== event.id
  })) return false
  if (state.eventMembers.some(eventMember =>
    eventMember.eventId !== event.id || !memberById.has(eventMember.memberId))) return false
  if (state.eventMemberDays.some(memberDay => {
    const eventMember = eventMemberById.get(memberDay.eventMemberId)
    const eventDay = eventDayById.get(memberDay.eventDayId)
    return eventMember?.eventId !== event.id || eventDay?.eventId !== event.id
  })) return false

  if (state.eventBands.some(eventBand => {
    const eventDay = eventDayById.get(eventBand.eventDayId)
    if (
      eventBand.eventId !== event.id ||
      eventDay?.eventId !== event.id ||
      eventBand.memberIds.some(memberId => !memberById.has(memberId)) ||
      (eventBand.bandId !== undefined && !bandById.has(eventBand.bandId))
    ) return true
    if (!eventBand.fixedPlacement) return false
    const stage = stageById.get(eventBand.fixedPlacement.stageId)
    if (!stage || stage.eventDayId !== eventBand.eventDayId) return true
    return eventBand.fixedPlacement.sectionId !== undefined &&
      sectionById.get(eventBand.fixedPlacement.sectionId)?.stageId !== stage.id
  })) return false

  if (state.scheduleItems.some(item => {
    const stage = stageById.get(item.stageId)
    const eventDay = stage ? eventDayById.get(stage.eventDayId) : undefined
    if (!stage || eventDay?.eventId !== event.id) return true
    const stageSections = state.sections.filter(section => section.stageId === stage.id)
    if (!isValidScheduleItemSectionAssignment(stage.id, stageSections, item)) return true
    if (item.kind === 'break') return false
    const eventBand = eventBandById.get(item.eventBandId)
    return eventBand?.eventId !== event.id || eventBand.eventDayId !== stage.eventDayId
  })) return false

  if (state.paAssignments.some(assignment => {
    const eventDay = eventDayById.get(assignment.eventDayId)
    const stage = stageById.get(assignment.stageId)
    return assignment.eventId !== event.id ||
      eventDay?.eventId !== event.id ||
      stage?.eventDayId !== assignment.eventDayId ||
      !memberById.has(assignment.memberId) ||
      !hasBoundaryInStage(assignment.from, assignment.stageId, scheduleItemById, sectionById) ||
      !hasBoundaryInStage(assignment.until, assignment.stageId, scheduleItemById, sectionById)
  })) return false

  if (state.dutyTypes.some(dutyType => dutyType.eventId !== event.id)) return false
  if (state.dutyAssignments.some(assignment => {
    const dutyType = dutyTypeById.get(assignment.dutyTypeId)
    const eventDay = eventDayById.get(assignment.eventDayId)
    const stage = stageById.get(assignment.stageId)
    return dutyType?.eventId !== event.id ||
      eventDay?.eventId !== event.id ||
      stage?.eventDayId !== assignment.eventDayId ||
      !memberById.has(assignment.memberId) ||
      !hasBoundaryInStage(assignment.from, assignment.stageId, scheduleItemById, sectionById) ||
      !hasBoundaryInStage(assignment.until, assignment.stageId, scheduleItemById, sectionById)
  })) return false

  if (state.timetableLocks.some(lock => {
    const item = scheduleItemById.get(lock.scheduleItemId)
    const stage = stageById.get(lock.stageId)
    const eventDay = stage ? eventDayById.get(stage.eventDayId) : undefined
    return lock.eventId !== event.id ||
      eventDay?.eventId !== event.id ||
      item?.kind !== 'performance' ||
      item.stageId !== lock.stageId ||
      item.sectionId !== lock.sectionId ||
      (lock.sectionId !== undefined &&
        sectionById.get(lock.sectionId)?.stageId !== lock.stageId)
  })) return false

  return state.timetableOrderConstraints.every(constraint => {
    const eventDay = eventDayById.get(constraint.eventDayId)
    const stage = stageById.get(constraint.stageId)
    if (
      constraint.eventId !== event.id ||
      eventDay?.eventId !== event.id ||
      stage?.eventDayId !== constraint.eventDayId ||
      (constraint.sectionId !== undefined &&
        sectionById.get(constraint.sectionId)?.stageId !== constraint.stageId)
    ) return false
    return constraint.eventBandIds.every(eventBandId => {
      const eventBand = eventBandById.get(eventBandId)
      return eventBand?.eventId === event.id &&
        eventBand.eventDayId === constraint.eventDayId
    })
  })
}

export const createCloudEventSnapshot = (
  state: PersistedDomainState,
  eventId: EventId,
): CloudEventSnapshotResult => {
  const selected = createEventOwnedState(state, eventId)
  if (!selected.ok) return selected
  const eventState = selected.eventState
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
    !hasUniqueEventOwnedCollectionIds(appState) ||
    !hasOnlyOneEvent(appState) ||
    !hasValidCloudEventIdentity(appState) ||
    !hasExactReferencedMasters(appState) ||
    !hasValidCloudEventRelationships(appState)
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

const createEventOwnedState = (
  state: PersistedDomainState,
  eventId: EventId,
): { ok: true; eventState: CloudEventOwnedStateV2 } | Exclude<
  CloudEventSnapshotV2Result,
  { ok: true }
> => {
  const deletion = createEventDeletion(createDeletionInput(state, eventId))
  if (!deletion.ok) return deletion

  return {
    ok: true,
    eventState: {
      version: 5,
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
    },
  }
}

const createReferenceMember = (id: string): Member => ({
  id,
  realName: id,
  active: true,
})

const createReferenceBand = (id: string): Band => ({
  id,
  name: id,
  defaultMemberIds: [],
  active: true,
})

const materializeV2ValidationState = (
  snapshot: CloudEventSnapshotV2,
): PersistedAppStateV5 => ({
  ...snapshot.eventState,
  members: snapshot.masterReferences.memberIds.map(createReferenceMember),
  bands: snapshot.masterReferences.bandIds.map(createReferenceBand),
})

const hasCompleteV2DirectMasterReferences = (
  state: CloudEventOwnedStateV2,
  references: CloudEventSnapshotV2['masterReferences'],
): boolean => {
  if (
    !hasUniqueNonEmptyStrings(references.memberIds) ||
    !hasUniqueNonEmptyStrings(references.bandIds)
  ) return false

  const referenced = collectDirectReferencedMasterIds(state)
  return referenced.memberIds.size <= references.memberIds.length &&
    referenced.bandIds.size === references.bandIds.length &&
    [...referenced.memberIds].every(memberId => references.memberIds.includes(memberId)) &&
    references.bandIds.every(bandId => referenced.bandIds.has(bandId))
}

const validateCloudEventSnapshotV2 = (
  snapshot: CloudEventSnapshotV2,
): boolean => {
  if (
    !hasExactKeys(snapshot as unknown as Record<string, unknown>, cloudEventSnapshotV2Keys) ||
    !hasExactKeys(
      snapshot.eventState as unknown as Record<string, unknown>,
      cloudEventOwnedStateV2Keys,
    ) ||
    !hasExactKeys(
      snapshot.masterReferences as unknown as Record<string, unknown>,
      cloudEventMasterReferenceKeys,
    ) ||
    !hasCompleteV2DirectMasterReferences(
      snapshot.eventState,
      snapshot.masterReferences,
    )
  ) {
    return false
  }
  const state = materializeV2ValidationState(snapshot)
  return isPersistedAppStateV5(state) &&
    hasUniqueEventOwnedCollectionIds(state) &&
    hasOnlyOneEvent(state) &&
    hasValidCloudEventIdentity(state) &&
    hasValidCloudEventRelationships(state)
}

/**
 * Builds the normalized-master Snapshot V2 contract without enabling it in
 * the production Cloud Event save path. V2 stores only Event-owned data and
 * the exact IDs of Workspace masters that data references.
 */
export const createCloudEventSnapshotV2 = (
  state: PersistedDomainState,
  eventId: EventId,
): CloudEventSnapshotV2Result => {
  const selected = createEventOwnedState(state, eventId)
  if (!selected.ok) return selected

  // V2 persists only Master IDs, so its serializer must prove those IDs came
  // from valid, unique source records before placeholder records are used for
  // structural parsing. Extra valid Workspace masters remain out of scope.
  if (
    !Array.isArray(state.members) ||
    !Array.isArray(state.bands) ||
    !state.members.every(isMember) ||
    !state.bands.every(isBand) ||
    !hasUniqueIds(state.members) ||
    !hasUniqueIds(state.bands)
  ) return { ok: false, reason: 'INVALID_SNAPSHOT' }

  const referenced = collectReferencedMasterIds(selected.eventState, state.bands)
  const snapshot: CloudEventSnapshotV2 = {
    format: CLOUD_EVENT_SNAPSHOT_FORMAT,
    version: CLOUD_EVENT_SNAPSHOT_V2_VERSION,
    eventState: selected.eventState,
    masterReferences: {
      memberIds: [...referenced.memberIds].sort(),
      bandIds: [...referenced.bandIds].sort(),
    },
  }
  return validateCloudEventSnapshotV2(snapshot) &&
    hasResolvedCloudEventSnapshotV2Masters(snapshot, state.members, state.bands)
    ? { ok: true, snapshot }
    : { ok: false, reason: 'INVALID_SNAPSHOT' }
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
    !hasUniqueEventOwnedCollectionIds(snapshot.appState) ||
    !hasOnlyOneEvent(snapshot.appState) ||
    !hasValidCloudEventIdentity(snapshot.appState) ||
    !hasExactReferencedMasters(snapshot.appState) ||
    !hasValidCloudEventRelationships(snapshot.appState)
  ) {
    return undefined
  }
  return snapshot
}

export const parseCloudEventSnapshotV2 = (
  value: unknown,
): CloudEventSnapshotV2 | undefined => {
  if (
    !isRecord(value) ||
    value.format !== CLOUD_EVENT_SNAPSHOT_FORMAT ||
    value.version !== CLOUD_EVENT_SNAPSHOT_V2_VERSION ||
    !isRecord(value.eventState) ||
    !isRecord(value.masterReferences) ||
    !hasExactKeys(value, cloudEventSnapshotV2Keys) ||
    !hasExactKeys(value.eventState, cloudEventOwnedStateV2Keys) ||
    !hasExactKeys(value.masterReferences, cloudEventMasterReferenceKeys) ||
    !Array.isArray(value.masterReferences.memberIds) ||
    !Array.isArray(value.masterReferences.bandIds) ||
    !Array.from(value.masterReferences.memberIds).every(item => typeof item === 'string') ||
    !Array.from(value.masterReferences.bandIds).every(item => typeof item === 'string')
  ) return undefined

  const snapshot = value as unknown as CloudEventSnapshotV2
  return validateCloudEventSnapshotV2(snapshot) ? snapshot : undefined
}

/** Explicit version dispatch for later V1/V2 hydrate integration. */
export const parseCloudEventSnapshotEnvelope = (
  value: unknown,
): CloudEventSnapshot | undefined => {
  if (!isRecord(value) || value.format !== CLOUD_EVENT_SNAPSHOT_FORMAT) {
    return undefined
  }
  if (value.version === CLOUD_EVENT_SNAPSHOT_VERSION) {
    return parseCloudEventSnapshot(value)
  }
  if (value.version === CLOUD_EVENT_SNAPSHOT_V2_VERSION) {
    return parseCloudEventSnapshotV2(value)
  }
  return undefined
}

/**
 * Resolves V2 references against one generation-consistent Workspace master
 * read. Extra Workspace masters are allowed; every referenced master and each
 * persisted Band member edge must resolve.
 */
export const hasResolvedCloudEventSnapshotV2Masters = (
  snapshot: CloudEventSnapshotV2,
  members: readonly Member[],
  bands: readonly Band[],
): boolean => {
  if (
    !parseCloudEventSnapshotV2(snapshot) ||
    !members.every(isMember) ||
    !bands.every(isBand) ||
    !hasUniqueIds(members) ||
    !hasUniqueIds(bands)
  ) return false

  const memberIds = new Set(members.map(member => member.id))
  const bandById = new Map(bands.map(band => [band.id, band]))
  if (
    !snapshot.masterReferences.memberIds.every(memberId => memberIds.has(memberId)) ||
    !snapshot.masterReferences.bandIds.every(bandId => bandById.has(bandId))
  ) return false

  const expected = collectDirectReferencedMasterIds(snapshot.eventState)
  for (const bandId of snapshot.masterReferences.bandIds) {
    const band = bandById.get(bandId)
    if (!band) return false
    for (const memberId of band.defaultMemberIds) expected.memberIds.add(memberId)
  }
  return expected.memberIds.size === snapshot.masterReferences.memberIds.length &&
    snapshot.masterReferences.memberIds.every(memberId => expected.memberIds.has(memberId))
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

export const arePersistedValuesEqual = (left: unknown, right: unknown): boolean => {
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
  if (
    !hasUniqueIds(localState.members) ||
    !hasUniqueIds(localState.bands)
  ) return { ok: false, reason: 'INVALID_SNAPSHOT' }
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
