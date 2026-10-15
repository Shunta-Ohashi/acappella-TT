import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  parseCloudEventSnapshotEnvelope,
} from './cloudEventSnapshot.ts'
import { isPostgresBigintGeneration } from './cloudGeneration.ts'
import {
  createCloudV2CutoverPreflight,
  type CloudV2CutoverPreflightIssue,
  type CloudV2CutoverPreflightResult,
} from './cloudV2CutoverPreflight.ts'
import {
  createCloudWorkspaceMasterBackfillPlan,
  parseCloudWorkspaceMasterBackfillSource,
  type CloudWorkspaceMasterBackfillSource,
} from './cloudWorkspaceMasterBackfill.ts'
import type {
  CloudWorkspaceBandRecord,
  CloudWorkspaceMastersSnapshot,
  CloudWorkspaceMemberRecord,
} from './cloudWorkspaceMasterRepository.ts'
import {
  isValidCloudWorkspaceBand,
  isValidCloudWorkspaceMember,
} from './cloudWorkspaceMasterValidation.ts'

export type CloudV2CutoverReferenceKind =
  | 'bandMembers'
  | 'eventMemberReferences'
  | 'eventBandReferences'

export type CloudV2CutoverReferenceStatus =
  | 'consistent'
  | 'not-backfilled'
  | 'partial'
  | 'inconsistent'
  | 'indeterminate'

export interface CloudV2CutoverBandMemberRelation {
  workspaceId: string
  bandId: string
  memberId: string
  position: number
}

export interface CloudV2CutoverEventMemberReference {
  workspaceId: string
  eventId: string
  memberId: string
}

export interface CloudV2CutoverEventBandReference {
  workspaceId: string
  eventId: string
  bandId: string
}

export interface CloudV2CutoverInspection {
  source: CloudWorkspaceMasterBackfillSource
  masters: CloudWorkspaceMastersSnapshot
  relations: {
    bandMembers: CloudV2CutoverBandMemberRelation[]
    eventMemberReferences: CloudV2CutoverEventMemberReference[]
    eventBandReferences: CloudV2CutoverEventBandReference[]
  }
}

export interface CloudV2CutoverReferenceEvidence {
  status: CloudV2CutoverReferenceStatus
  expectedCounts?: {
    bandMembers: number
    eventMemberReferences: number
    eventBandReferences: number
  }
  actualCounts: {
    bandMembers: number
    eventMemberReferences: number
    eventBandReferences: number
  }
  mismatchedRelations: CloudV2CutoverReferenceKind[]
  affectedEventIds: string[]
}

export interface CloudV2CutoverInspectionReport {
  preflight: CloudV2CutoverPreflightResult
  referenceEvidence: CloudV2CutoverReferenceEvidence
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const fingerprintPattern = /^[0-9a-f]{64}$/u

const isExactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key))

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value))

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const parseMemberRecord = (
  value: unknown,
  workspaceId: string,
): CloudWorkspaceMemberRecord | undefined => {
  if (
    !isExactRecord(value, [
      'kind', 'workspaceId', 'value', 'revision', 'createdAt', 'updatedAt',
    ]) ||
    value.kind !== 'member' ||
    value.workspaceId !== workspaceId ||
    !isValidCloudWorkspaceMember(value.value) ||
    !isPositiveSafeInteger(value.revision) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) return undefined
  return copy(value) as unknown as CloudWorkspaceMemberRecord
}

const parseBandRecord = (
  value: unknown,
  workspaceId: string,
): CloudWorkspaceBandRecord | undefined => {
  if (
    !isExactRecord(value, [
      'kind', 'workspaceId', 'value', 'revision', 'createdAt', 'updatedAt',
    ]) ||
    value.kind !== 'band' ||
    value.workspaceId !== workspaceId ||
    !isValidCloudWorkspaceBand(value.value) ||
    !isPositiveSafeInteger(value.revision) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) return undefined
  return copy(value) as unknown as CloudWorkspaceBandRecord
}

const parseRelation = <T>(
  value: unknown,
  workspaceId: string,
  keys: readonly string[],
  parse: (record: Record<string, unknown>) => T | undefined,
): T | undefined => {
  if (!isExactRecord(value, ['workspaceId', ...keys]) || value.workspaceId !== workspaceId) {
    return undefined
  }
  return parse(value)
}

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

const sortedUnique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length &&
  values.every((value, index) => index === 0 || compareUtf8(values[index - 1]!, value) <= 0)

/**
 * Strictly validates the complete response from inspect_cloud_v2_cutover_state().
 * Invalid, truncated, cross-Workspace, or internally inconsistent evidence is
 * rejected rather than converted into an empty/partial inspection.
 */
export const parseCloudV2CutoverInspection = (
  value: unknown,
  expectedWorkspaceId: string,
): CloudV2CutoverInspection | undefined => {
  if (
    !uuidPattern.test(expectedWorkspaceId) ||
    !isExactRecord(value, [
      'status', 'workspaceId', 'workspaceStatus', 'workspaceGeneration',
      'events', 'existing', 'masters', 'relations', 'counts',
    ]) ||
    value.status !== 'ok' ||
    value.workspaceId !== expectedWorkspaceId ||
    !['legacy', 'conflict', 'ready'].includes(String(value.workspaceStatus)) ||
    !isPostgresBigintGeneration(value.workspaceGeneration) ||
    !Array.isArray(value.events) ||
    !isRecord(value.existing) ||
    !isExactRecord(value.masters, ['members', 'bands']) ||
    !Array.isArray(value.masters.members) ||
    !Array.isArray(value.masters.bands) ||
    !isExactRecord(value.relations, [
      'bandMembers', 'eventMemberReferences', 'eventBandReferences',
    ]) ||
    !Array.isArray(value.relations.bandMembers) ||
    !Array.isArray(value.relations.eventMemberReferences) ||
    !Array.isArray(value.relations.eventBandReferences) ||
    !isExactRecord(value.counts, [
      'events', 'members', 'bands', 'bandMembers',
      'eventMemberReferences', 'eventBandReferences',
    ])
  ) return undefined

  const workspaceId = expectedWorkspaceId
  const rawEvents = value.events
  const sourceEvents = rawEvents.map(event => {
    if (
      !isExactRecord(event, [
        'workspaceId', 'eventId', 'eventName', 'snapshotVersion', 'snapshot',
        'snapshotFingerprint', 'revision',
      ]) ||
      event.workspaceId !== workspaceId ||
      !isNonEmptyString(event.eventId) ||
      !isNonEmptyString(event.eventName) ||
      !isPositiveSafeInteger(event.revision) ||
      typeof event.snapshotFingerprint !== 'string' ||
      !fingerprintPattern.test(event.snapshotFingerprint)
    ) return undefined
    const snapshot = parseCloudEventSnapshotEnvelope(event.snapshot)
    if (!snapshot || event.snapshotVersion !== snapshot.version) return undefined
    return {
      workspaceId,
      eventId: event.eventId,
      eventName: event.eventName,
      snapshot: copy(event.snapshot),
      snapshotFingerprint: event.snapshotFingerprint,
      revision: event.revision,
    }
  })
  if (sourceEvents.some(event => event === undefined)) return undefined
  const eventIds = sourceEvents.map(event => event!.eventId)
  if (!sortedUnique(eventIds)) return undefined

  const members = value.masters.members.map(member => parseMemberRecord(member, workspaceId))
  const bands = value.masters.bands.map(band => parseBandRecord(band, workspaceId))
  if (members.some(member => member === undefined) || bands.some(band => band === undefined)) {
    return undefined
  }
  const memberRecords = members as CloudWorkspaceMemberRecord[]
  const bandRecords = bands as CloudWorkspaceBandRecord[]
  const memberIds = memberRecords.map(record => record.value.id)
  const bandIds = bandRecords.map(record => record.value.id)
  if (!sortedUnique(memberIds) || !sortedUnique(bandIds)) return undefined

  const bandMembers = value.relations.bandMembers.map(relation => parseRelation(
    relation,
    workspaceId,
    ['bandId', 'memberId', 'position'],
    record => isNonEmptyString(record.bandId) &&
      isNonEmptyString(record.memberId) &&
      isNonNegativeSafeInteger(record.position)
      ? {
          workspaceId,
          bandId: record.bandId,
          memberId: record.memberId,
          position: record.position,
        }
      : undefined,
  ))
  const eventMemberReferences = value.relations.eventMemberReferences.map(relation =>
    parseRelation(
      relation,
      workspaceId,
      ['eventId', 'memberId'],
      record => isNonEmptyString(record.eventId) && isNonEmptyString(record.memberId)
        ? { workspaceId, eventId: record.eventId, memberId: record.memberId }
        : undefined,
    ))
  const eventBandReferences = value.relations.eventBandReferences.map(relation =>
    parseRelation(
      relation,
      workspaceId,
      ['eventId', 'bandId'],
      record => isNonEmptyString(record.eventId) && isNonEmptyString(record.bandId)
        ? { workspaceId, eventId: record.eventId, bandId: record.bandId }
        : undefined,
    ))
  if (
    bandMembers.some(relation => relation === undefined) ||
    eventMemberReferences.some(relation => relation === undefined) ||
    eventBandReferences.some(relation => relation === undefined)
  ) return undefined

  const parsedBandMembers = bandMembers as CloudV2CutoverBandMemberRelation[]
  const parsedEventMemberReferences = eventMemberReferences as CloudV2CutoverEventMemberReference[]
  const parsedEventBandReferences = eventBandReferences as CloudV2CutoverEventBandReference[]
  const bandMemberKeys = parsedBandMembers.map(relation =>
    `${relation.bandId}\u0000${String(relation.position).padStart(16, '0')}\u0000${relation.memberId}`)
  const eventMemberKeys = parsedEventMemberReferences.map(relation =>
    `${relation.eventId}\u0000${relation.memberId}`)
  const eventBandKeys = parsedEventBandReferences.map(relation =>
    `${relation.eventId}\u0000${relation.bandId}`)
  if (
    !sortedUnique(bandMemberKeys) ||
    !sortedUnique(eventMemberKeys) ||
    !sortedUnique(eventBandKeys)
  ) return undefined

  const memberIdSet = new Set(memberIds)
  const bandIdSet = new Set(bandIds)
  const eventIdSet = new Set(eventIds)
  if (
    parsedBandMembers.some(relation =>
      !bandIdSet.has(relation.bandId) || !memberIdSet.has(relation.memberId)) ||
    parsedEventMemberReferences.some(relation =>
      !eventIdSet.has(relation.eventId) || !memberIdSet.has(relation.memberId)) ||
    parsedEventBandReferences.some(relation =>
      !eventIdSet.has(relation.eventId) || !bandIdSet.has(relation.bandId))
  ) return undefined

  for (const band of bandRecords) {
    const relations = parsedBandMembers.filter(relation => relation.bandId === band.value.id)
    if (
      relations.some((relation, index) => relation.position !== index) ||
      relations.length !== band.value.defaultMemberIds.length ||
      relations.some((relation, index) => relation.memberId !== band.value.defaultMemberIds[index])
    ) return undefined
  }

  const countKeys = [
    'events', 'members', 'bands', 'bandMembers',
    'eventMemberReferences', 'eventBandReferences',
  ] as const
  const counts = value.counts as Record<string, unknown>
  if (!countKeys.every(key => isNonNegativeSafeInteger(counts[key]))) return undefined
  const actualCounts = {
    events: rawEvents.length,
    members: memberRecords.length,
    bands: bandRecords.length,
    bandMembers: parsedBandMembers.length,
    eventMemberReferences: parsedEventMemberReferences.length,
    eventBandReferences: parsedEventBandReferences.length,
  }
  if (countKeys.some(key => counts[key] !== actualCounts[key])) return undefined

  const rawSource = {
    status: 'ok',
    workspaceId,
    workspaceStatus: value.workspaceStatus,
    workspaceGeneration: value.workspaceGeneration,
    events: sourceEvents,
    existing: copy(value.existing),
  }
  const source = parseCloudWorkspaceMasterBackfillSource(rawSource)
  if (
    !source ||
    source.existing.members !== actualCounts.members ||
    source.existing.bands !== actualCounts.bands ||
    source.existing.bandMembers !== actualCounts.bandMembers ||
    source.existing.eventMemberReferences !== actualCounts.eventMemberReferences ||
    source.existing.eventBandReferences !== actualCounts.eventBandReferences
  ) return undefined

  return {
    source,
    masters: {
      workspaceId,
      generation: source.workspaceGeneration,
      members: copy(memberRecords),
      bands: copy(bandRecords),
    },
    relations: {
      bandMembers: copy(parsedBandMembers),
      eventMemberReferences: copy(parsedEventMemberReferences),
      eventBandReferences: copy(parsedEventBandReferences),
    },
  }
}

const referenceKeySets = (inspection: CloudV2CutoverInspection) => ({
  bandMembers: new Set(inspection.relations.bandMembers.map(relation =>
    `${relation.bandId}\u0000${relation.memberId}\u0000${relation.position}`)),
  eventMemberReferences: new Set(inspection.relations.eventMemberReferences.map(relation =>
    `${relation.eventId}\u0000${relation.memberId}`)),
  eventBandReferences: new Set(inspection.relations.eventBandReferences.map(relation =>
    `${relation.eventId}\u0000${relation.bandId}`)),
})

const addUniqueIssue = (
  issues: CloudV2CutoverPreflightIssue[],
  issue: CloudV2CutoverPreflightIssue,
): void => {
  if (!issues.some(candidate => candidate.code === issue.code)) issues.push(issue)
}

const structuralSource = (source: CloudWorkspaceMasterBackfillSource): unknown => ({
  status: 'ok',
  workspaceId: source.workspaceId,
  workspaceStatus: 'legacy',
  workspaceGeneration: source.workspaceGeneration,
  events: source.events,
  existing: {
    members: 0,
    bands: 0,
    bandMembers: 0,
    eventMemberReferences: 0,
    eventBandReferences: 0,
    completedBackfills: 0,
    completedBackfill: null,
  },
})

const preflightSource = (source: CloudWorkspaceMasterBackfillSource): unknown => ({
  status: 'ok',
  workspaceId: source.workspaceId,
  workspaceStatus: source.workspaceStatus,
  workspaceGeneration: source.workspaceGeneration,
  events: source.events,
  existing: source.existing,
})

export const createCloudV2CutoverInspectionReport = async (
  rawInspection: unknown,
  expectedWorkspaceId: string,
  expectedGeneration?: string,
): Promise<CloudV2CutoverInspectionReport | undefined> => {
  const inspection = parseCloudV2CutoverInspection(rawInspection, expectedWorkspaceId)
  if (!inspection) return undefined

  const base = await createCloudV2CutoverPreflight({
    source: preflightSource(inspection.source),
    masters: inspection.masters,
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
  })
  const planResult = createCloudWorkspaceMasterBackfillPlan(
    structuralSource(inspection.source),
  )
  const actual = referenceKeySets(inspection)
  const actualCounts = {
    bandMembers: actual.bandMembers.size,
    eventMemberReferences: actual.eventMemberReferences.size,
    eventBandReferences: actual.eventBandReferences.size,
  }
  let referenceEvidence: CloudV2CutoverReferenceEvidence = {
    status: 'indeterminate',
    actualCounts,
    mismatchedRelations: [],
    affectedEventIds: [],
  }

  const issues = [...base.issues]
  const unverifiedRequirements = base.unverifiedRequirements.filter(requirement =>
    requirement !== 'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED')
  if (planResult.ok) {
    const expected = {
      bandMembers: new Set(planResult.plan.bandMembers.map(relation =>
        `${relation.bandId}\u0000${relation.memberId}\u0000${relation.position}`)),
      eventMemberReferences: new Set(planResult.plan.eventMemberReferences.map(relation =>
        `${relation.eventId}\u0000${relation.memberId}`)),
      eventBandReferences: new Set(planResult.plan.eventBandReferences.map(relation =>
        `${relation.eventId}\u0000${relation.bandId}`)),
    }
    const mismatchedRelations = (Object.keys(expected) as CloudV2CutoverReferenceKind[])
      .filter(kind => expected[kind].size !== actual[kind].size ||
        [...expected[kind]].some(key => !actual[kind].has(key)))
    const expectedCounts = {
      bandMembers: expected.bandMembers.size,
      eventMemberReferences: expected.eventMemberReferences.size,
      eventBandReferences: expected.eventBandReferences.size,
    }
    const expectedTotal = Object.values(expectedCounts).reduce((sum, count) => sum + count, 0)
    const actualTotal = Object.values(actualCounts).reduce((sum, count) => sum + count, 0)
    const differingKeys = <T extends string>(left: Set<T>, right: Set<T>): T[] => [
      ...[...left].filter(key => !right.has(key)),
      ...[...right].filter(key => !left.has(key)),
    ]
    const affectedEventIds = new Set<string>()
    for (const key of differingKeys(
      expected.eventMemberReferences,
      actual.eventMemberReferences,
    )) affectedEventIds.add(key.split('\u0000', 1)[0]!)
    for (const key of differingKeys(
      expected.eventBandReferences,
      actual.eventBandReferences,
    )) affectedEventIds.add(key.split('\u0000', 1)[0]!)
    const affectedBandIds = new Set(differingKeys(
      expected.bandMembers,
      actual.bandMembers,
    ).map(key => key.split('\u0000', 1)[0]!))
    for (const reference of [
      ...planResult.plan.eventBandReferences,
      ...inspection.relations.eventBandReferences,
    ]) {
      if (affectedBandIds.has(reference.bandId)) affectedEventIds.add(reference.eventId)
    }
    let status: CloudV2CutoverReferenceStatus = 'consistent'
    if (mismatchedRelations.length > 0) {
      if (inspection.source.existing.completedBackfill === null && actualTotal === 0 && expectedTotal > 0) {
        status = 'not-backfilled'
        addUniqueIssue(issues, { code: 'REFERENCE_INDEX_NOT_BACKFILLED' })
      } else if (inspection.source.existing.completedBackfill === null) {
        status = 'partial'
        addUniqueIssue(issues, { code: 'REFERENCE_INDEX_MISMATCH' })
      } else {
        status = 'inconsistent'
        addUniqueIssue(issues, { code: 'REFERENCE_INDEX_MISMATCH' })
      }
    }
    referenceEvidence = {
      status,
      expectedCounts,
      actualCounts,
      mismatchedRelations,
      affectedEventIds: [...affectedEventIds].sort(compareUtf8),
    }
  }

  const invalidEventIds = [...new Set([
    ...base.invalidEventIds,
    ...referenceEvidence.affectedEventIds,
  ])].sort()
  const referenceBlocksCutover = referenceEvidence.status === 'not-backfilled' ||
    referenceEvidence.status === 'partial' ||
    referenceEvidence.status === 'inconsistent'
  return {
    referenceEvidence,
    preflight: {
      ...base,
      cutoverReadiness: referenceBlocksCutover ? 'blocked' : base.cutoverReadiness,
      safeToCutover: false,
      issues,
      invalidEventIds,
      unverifiedRequirements,
    },
  }
}
