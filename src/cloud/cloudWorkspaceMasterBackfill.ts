import type { Band, Member } from '../domain/models.ts'
import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  arePersistedValuesEqual,
  parseCloudEventSnapshot,
  type CloudEventSnapshotV1,
} from './cloudEventSnapshot.ts'
import {
  isValidCloudWorkspaceBand,
  isValidCloudWorkspaceMember,
} from './cloudWorkspaceMasterValidation.ts'

export const CLOUD_WORKSPACE_MASTER_BACKFILL_PLAN_VERSION = 1 as const

export type CloudWorkspaceMasterBackfillStatus = 'legacy' | 'conflict' | 'ready'

export interface CloudWorkspaceMasterBackfillSourceEvent {
  workspaceId: string
  eventId: string
  eventName: string
  snapshot: CloudEventSnapshotV1
  snapshotFingerprint: string
  revision: number
}

export interface CloudWorkspaceMasterBackfillSource {
  workspaceId: string
  workspaceStatus: CloudWorkspaceMasterBackfillStatus
  workspaceGeneration: string
  events: CloudWorkspaceMasterBackfillSourceEvent[]
  existing: {
    members: number
    bands: number
    bandMembers: number
    eventMemberReferences: number
    eventBandReferences: number
    completedBackfills: number
    completedBackfill: null | {
      planFingerprint: string
      sourceGeneration: string
      resultGeneration: string
      eventCount: number
      memberCount: number
      bandCount: number
      bandMemberRelationCount: number
      eventMemberReferenceCount: number
      eventBandReferenceCount: number
    }
  }
}

export interface CloudWorkspaceMasterBackfillConflict {
  kind: 'member' | 'band'
  id: string
  eventIds: string[]
}

export interface CloudWorkspaceMasterBackfillIssue {
  code:
    | 'INVALID_SOURCE'
    | 'WORKSPACE_NOT_LEGACY'
    | 'EXISTING_NORMALIZED_DATA'
    | 'INVALID_SNAPSHOT'
    | 'INVALID_MEMBER'
    | 'INVALID_BAND'
    | 'SHARED_MASTER_CONFLICT'
  eventId?: string
  kind?: 'member' | 'band'
  masterId?: string
}

export interface CloudWorkspaceMasterBackfillReport {
  workspaceId: string
  eventCount: number
  memberCount: number
  bandCount: number
  bandMemberRelationCount: number
  eventMemberReferenceCount: number
  eventBandReferenceCount: number
  conflictCount: number
  conflicts: CloudWorkspaceMasterBackfillConflict[]
  eligible: boolean
  issues: CloudWorkspaceMasterBackfillIssue[]
  /** Snapshot V1 only contains masters referenced by a saved Event. */
  canRecoverUnreferencedMasters: false
}

export interface CloudWorkspaceMasterBackfillPlan {
  version: typeof CLOUD_WORKSPACE_MASTER_BACKFILL_PLAN_VERSION
  workspaceId: string
  sourceGeneration: string
  sourceEvents: Array<{
    eventId: string
    revision: number
    snapshotFingerprint: string
  }>
  members: Member[]
  bands: Band[]
  bandMembers: Array<{
    bandId: string
    memberId: string
    position: number
  }>
  eventMemberReferences: Array<{ eventId: string; memberId: string }>
  eventBandReferences: Array<{ eventId: string; bandId: string }>
}

export type CloudWorkspaceMasterBackfillPlanResult =
  | {
      ok: true
      report: CloudWorkspaceMasterBackfillReport
      plan: CloudWorkspaceMasterBackfillPlan
    }
  | { ok: false; report: CloudWorkspaceMasterBackfillReport }

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)

const compareUtf8 = (left: string, right: string): number => {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = Number(leftBytes[index]) - Number(rightBytes[index])
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

const toPersistedJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0

const isCompletedBackfill = (
  value: unknown,
): value is NonNullable<
  CloudWorkspaceMasterBackfillSource['existing']['completedBackfill']
> => isRecord(value) &&
  Object.keys(value).length === 9 &&
  typeof value.planFingerprint === 'string' &&
  /^[0-9a-f]{64}$/u.test(value.planFingerprint) &&
  isGeneration(value.sourceGeneration) &&
  isGeneration(value.resultGeneration) &&
  [
    value.eventCount,
    value.memberCount,
    value.bandCount,
    value.bandMemberRelationCount,
    value.eventMemberReferenceCount,
    value.eventBandReferenceCount,
  ].every(isNonNegativeSafeInteger)

const isBackfillSourceEvent = (
  value: unknown,
  workspaceId: string,
): value is CloudWorkspaceMasterBackfillSourceEvent => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    ![
      'workspaceId', 'eventId', 'eventName', 'snapshot',
      'snapshotFingerprint', 'revision',
    ].every(key => Object.hasOwn(value, key)) ||
    value.workspaceId !== workspaceId ||
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.eventName) ||
    typeof value.snapshotFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.snapshotFingerprint) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  ) return false
  const snapshot = parseCloudEventSnapshot(value.snapshot)
  const event = snapshot?.appState.events[0]
  return snapshot !== undefined &&
    event?.id === value.eventId &&
    event.name === value.eventName
}

export const parseCloudWorkspaceMasterBackfillSource = (
  value: unknown,
): CloudWorkspaceMasterBackfillSource | undefined => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    ![
      'status', 'workspaceId', 'workspaceStatus',
      'workspaceGeneration', 'events', 'existing',
    ].every(key => Object.hasOwn(value, key)) ||
    value.status !== 'ok' ||
    !isNonEmptyString(value.workspaceId) ||
    !(
      value.workspaceStatus === 'legacy' ||
      value.workspaceStatus === 'conflict' ||
      value.workspaceStatus === 'ready'
    ) ||
    !isGeneration(value.workspaceGeneration) ||
    !Array.isArray(value.events) ||
    !isRecord(value.existing)
  ) return undefined

  const workspaceId = value.workspaceId
  if (!Array.from(value.events).every(event =>
    isBackfillSourceEvent(event, workspaceId))) return undefined

  const existing = value.existing
  const existingCountKeys = [
    'members',
    'bands',
    'bandMembers',
    'eventMemberReferences',
    'eventBandReferences',
    'completedBackfills',
  ] as const
  const existingKeys = [
    ...existingCountKeys,
    'completedBackfill',
  ] as const
  if (
    Object.keys(value.existing).length !== existingKeys.length ||
    !existingKeys.every(key => Object.hasOwn(existing, key)) ||
    !existingCountKeys.every(key =>
      Object.hasOwn(existing, key) &&
      isNonNegativeSafeInteger(existing[key]))
  ) return undefined

  if (
    existing.completedBackfill !== null &&
    !isCompletedBackfill(existing.completedBackfill)
  ) return undefined

  const events = value.events as CloudWorkspaceMasterBackfillSourceEvent[]
  if (new Set(events.map(event => event.eventId)).size !== events.length) return undefined

  return {
    workspaceId,
    workspaceStatus: value.workspaceStatus as CloudWorkspaceMasterBackfillStatus,
    workspaceGeneration: value.workspaceGeneration,
    events: toPersistedJson(events),
    existing: {
      members: Number(existing.members),
      bands: Number(existing.bands),
      bandMembers: Number(existing.bandMembers),
      eventMemberReferences: Number(existing.eventMemberReferences),
      eventBandReferences: Number(existing.eventBandReferences),
      completedBackfills: Number(existing.completedBackfills),
      completedBackfill: existing.completedBackfill === null
        ? null
        : toPersistedJson(existing.completedBackfill),
    },
  }
}

const addMergedMaster = <T extends Member | Band>(
  byId: Map<string, { value: T; eventIds: Set<string> }>,
  conflicts: Map<string, CloudWorkspaceMasterBackfillConflict>,
  kind: 'member' | 'band',
  value: T,
  eventId: string,
): void => {
  const existing = byId.get(value.id)
  if (!existing) {
    byId.set(value.id, { value: toPersistedJson(value), eventIds: new Set([eventId]) })
    return
  }
  existing.eventIds.add(eventId)
  const conflictKey = `${kind}:${value.id}`
  if (arePersistedValuesEqual(existing.value, value)) {
    const conflict = conflicts.get(conflictKey)
    if (conflict) conflict.eventIds = [...existing.eventIds].sort(compareUtf8)
    return
  }
  conflicts.set(conflictKey, {
    kind,
    id: value.id,
    eventIds: [...existing.eventIds].sort(compareUtf8),
  })
}

const createEmptyReport = (workspaceId: string): CloudWorkspaceMasterBackfillReport => ({
  workspaceId,
  eventCount: 0,
  memberCount: 0,
  bandCount: 0,
  bandMemberRelationCount: 0,
  eventMemberReferenceCount: 0,
  eventBandReferenceCount: 0,
  conflictCount: 0,
  conflicts: [],
  eligible: false,
  issues: [],
  canRecoverUnreferencedMasters: false,
})

export const createCloudWorkspaceMasterBackfillPlan = (
  sourceValue: unknown,
): CloudWorkspaceMasterBackfillPlanResult => {
  const source = parseCloudWorkspaceMasterBackfillSource(sourceValue)
  if (!source) {
    const report = createEmptyReport(
      isRecord(sourceValue) && isNonEmptyString(sourceValue.workspaceId)
        ? sourceValue.workspaceId
        : '',
    )
    report.issues.push({ code: 'INVALID_SOURCE' })
    return { ok: false, report }
  }

  const report = createEmptyReport(source.workspaceId)
  report.eventCount = source.events.length
  if (source.workspaceStatus !== 'legacy') {
    report.issues.push({ code: 'WORKSPACE_NOT_LEGACY' })
  }
  const completedBackfill = source.existing.completedBackfill
  const hasUnrecordedNormalizedData = completedBackfill === null
    ? source.existing.completedBackfills !== 0 || [
      source.existing.members,
      source.existing.bands,
      source.existing.bandMembers,
      source.existing.eventMemberReferences,
      source.existing.eventBandReferences,
    ].some(count => count !== 0)
    : source.existing.completedBackfills !== 1 ||
      source.workspaceGeneration !== completedBackfill.resultGeneration
  if (hasUnrecordedNormalizedData) {
    report.issues.push({ code: 'EXISTING_NORMALIZED_DATA' })
  }

  const members = new Map<string, { value: Member; eventIds: Set<string> }>()
  const bands = new Map<string, { value: Band; eventIds: Set<string> }>()
  const conflicts = new Map<string, CloudWorkspaceMasterBackfillConflict>()
  const sourceEvents: CloudWorkspaceMasterBackfillPlan['sourceEvents'] = []
  const eventMemberReferences: CloudWorkspaceMasterBackfillPlan['eventMemberReferences'] = []
  const eventBandReferences: CloudWorkspaceMasterBackfillPlan['eventBandReferences'] = []

  for (const sourceEvent of [...source.events].sort((left, right) =>
    compareUtf8(left.eventId, right.eventId))) {
    const snapshot = parseCloudEventSnapshot(sourceEvent.snapshot)
    if (!snapshot) {
      report.issues.push({ code: 'INVALID_SNAPSHOT', eventId: sourceEvent.eventId })
      continue
    }
    const invalidMember = snapshot.appState.members.find(member =>
      !isValidCloudWorkspaceMember(member)) as Member | undefined
    if (invalidMember) {
      report.issues.push({
        code: 'INVALID_MEMBER', eventId: sourceEvent.eventId,
        kind: 'member', masterId: invalidMember.id,
      })
    }
    const invalidBand = snapshot.appState.bands.find(band =>
      !isValidCloudWorkspaceBand(band)) as Band | undefined
    if (invalidBand) {
      report.issues.push({
        code: 'INVALID_BAND', eventId: sourceEvent.eventId,
        kind: 'band', masterId: invalidBand.id,
      })
    }
    if (invalidMember || invalidBand) continue

    sourceEvents.push({
      eventId: sourceEvent.eventId,
      revision: sourceEvent.revision,
      snapshotFingerprint: sourceEvent.snapshotFingerprint,
    })
    for (const member of snapshot.appState.members) {
      addMergedMaster(members, conflicts, 'member', member, sourceEvent.eventId)
      eventMemberReferences.push({ eventId: sourceEvent.eventId, memberId: member.id })
    }
    for (const band of snapshot.appState.bands) {
      addMergedMaster(bands, conflicts, 'band', band, sourceEvent.eventId)
      eventBandReferences.push({ eventId: sourceEvent.eventId, bandId: band.id })
    }
  }

  report.conflicts = [...conflicts.values()].sort((left, right) =>
    compareUtf8(left.kind, right.kind) || compareUtf8(left.id, right.id))
  report.conflictCount = report.conflicts.length
  for (const conflict of report.conflicts) {
    report.issues.push({
      code: 'SHARED_MASTER_CONFLICT',
      kind: conflict.kind,
      masterId: conflict.id,
    })
  }

  const mergedMembers = [...members.values()]
    .map(entry => entry.value)
    .sort((left, right) => compareUtf8(left.id, right.id))
  const mergedBands = [...bands.values()]
    .map(entry => entry.value)
    .sort((left, right) => compareUtf8(left.id, right.id))
  const bandMembers = mergedBands.flatMap(band => band.defaultMemberIds.map(
    (memberId, position) => ({ bandId: band.id, memberId, position }),
  ))
  eventMemberReferences.sort((left, right) =>
    compareUtf8(left.eventId, right.eventId) || compareUtf8(left.memberId, right.memberId))
  eventBandReferences.sort((left, right) =>
    compareUtf8(left.eventId, right.eventId) || compareUtf8(left.bandId, right.bandId))

  report.memberCount = mergedMembers.length
  report.bandCount = mergedBands.length
  report.bandMemberRelationCount = bandMembers.length
  report.eventMemberReferenceCount = eventMemberReferences.length
  report.eventBandReferenceCount = eventBandReferences.length
  if (completedBackfill !== null && (
    completedBackfill.eventCount !== report.eventCount ||
    completedBackfill.memberCount !== report.memberCount ||
    completedBackfill.bandCount !== report.bandCount ||
    completedBackfill.bandMemberRelationCount !== report.bandMemberRelationCount ||
    completedBackfill.eventMemberReferenceCount !== report.eventMemberReferenceCount ||
    completedBackfill.eventBandReferenceCount !== report.eventBandReferenceCount ||
    source.existing.members !== report.memberCount ||
    source.existing.bands !== report.bandCount ||
    source.existing.bandMembers !== report.bandMemberRelationCount ||
    source.existing.eventMemberReferences !== report.eventMemberReferenceCount ||
    source.existing.eventBandReferences !== report.eventBandReferenceCount
  ) && !report.issues.some(issue => issue.code === 'EXISTING_NORMALIZED_DATA')) {
    report.issues.push({ code: 'EXISTING_NORMALIZED_DATA' })
  }
  report.eligible = report.issues.length === 0
  if (!report.eligible) return { ok: false, report }

  return {
    ok: true,
    report,
    plan: {
      version: CLOUD_WORKSPACE_MASTER_BACKFILL_PLAN_VERSION,
      workspaceId: source.workspaceId,
      sourceGeneration: completedBackfill?.sourceGeneration ?? source.workspaceGeneration,
      sourceEvents,
      members: mergedMembers,
      bands: mergedBands,
      bandMembers,
      eventMemberReferences,
      eventBandReferences,
    },
  }
}

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compareUtf8).map(key =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export const createCloudWorkspaceMasterBackfillFingerprint = async (
  plan: CloudWorkspaceMasterBackfillPlan,
): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalize(plan)),
  )
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
