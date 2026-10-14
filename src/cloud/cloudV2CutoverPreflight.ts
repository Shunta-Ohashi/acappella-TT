import type { Band, Member } from '../domain/models.ts'
import { createPersistedAppState } from '../persistence/localPersistence.ts'
import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  arePersistedValuesEqual,
  createCloudEventSnapshotV2,
  hasResolvedCloudEventSnapshotV2Masters,
  parseCloudEventSnapshot,
  parseCloudEventSnapshotEnvelope,
  type CloudEventSnapshotV1,
  type CloudEventSnapshotV2,
} from './cloudEventSnapshot.ts'
import { isPostgresBigintGeneration } from './cloudGeneration.ts'
import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
  parseCloudWorkspaceMasterBackfillSource,
  type CloudWorkspaceMasterBackfillIssue,
  type CloudWorkspaceMasterBackfillPlan,
  type CloudWorkspaceMasterBackfillSource,
} from './cloudWorkspaceMasterBackfill.ts'
import type {
  CloudWorkspaceMastersSnapshot,
} from './cloudWorkspaceMasterRepository.ts'

export type CloudV2CutoverStructuralStatus =
  | 'convertible'
  | 'not-convertible'
  | 'indeterminate'

export type CloudV2CutoverReadiness = 'blocked' | 'indeterminate'

export type CloudV2CutoverPreflightIssueCode =
  | 'INVALID_SOURCE'
  | 'INVALID_SNAPSHOT'
  | 'DUPLICATE_EVENT_ID'
  | 'MIXED_SNAPSHOT_VERSIONS'
  | 'SNAPSHOT_V2_PRESENT'
  | 'INVALID_MEMBER'
  | 'INVALID_BAND'
  | 'SHARED_MASTER_CONFLICT'
  | 'V2_CONVERSION_FAILED'
  | 'V2_MASTER_REFERENCE_INVALID'
  | 'V2_ROUND_TRIP_MISMATCH'
  | 'WORKSPACE_CONFLICT'
  | 'WORKSPACE_ALREADY_READY'
  | 'GENERATION_EVIDENCE_MISMATCH'
  | 'BACKFILL_STATE_INCONSISTENT'
  | 'BACKFILL_FINGERPRINT_MISMATCH'
  | 'NORMALIZED_MASTER_MISMATCH'

export interface CloudV2CutoverPreflightIssue {
  code: CloudV2CutoverPreflightIssueCode
  eventId?: string
  kind?: 'member' | 'band'
  masterId?: string
}

export type CloudV2CutoverUnverifiedRequirement =
  | 'BACKFILL_NOT_COMPLETED'
  | 'NORMALIZED_MASTER_CONTENTS_NOT_OBSERVED'
  | 'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED'
  | 'BACKUP_NOT_VERIFIED'
  | 'MAINTENANCE_WINDOW_NOT_VERIFIED'
  | 'V1_WRITERS_NOT_PROVEN_DRAINED'
  | 'ATOMIC_CUTOVER_REVALIDATION_UNAVAILABLE'
  | 'ROLLBACK_PROCEDURE_NOT_VERIFIED'

export interface CloudV2CutoverConvertedEventSummary {
  eventId: string
  revision: number
  memberReferenceCount: number
  bandReferenceCount: number
}

export interface CloudV2CutoverPreflightSummary {
  eventCount: number
  convertedEventCount: number
  memberCount: number
  bandCount: number
  bandMemberRelationCount: number
  eventMemberReferenceCount: number
  eventBandReferenceCount: number
  conflictCount: number
}

export interface CloudV2CutoverPreflightResult {
  workspaceId: string
  workspaceStatus?: 'legacy' | 'conflict' | 'ready'
  generation?: string
  structuralStatus: CloudV2CutoverStructuralStatus
  cutoverReadiness: CloudV2CutoverReadiness
  /** Read-only preflight never authorizes or performs the production cutover. */
  safeToCutover: false
  summary: CloudV2CutoverPreflightSummary
  convertedEvents: CloudV2CutoverConvertedEventSummary[]
  invalidEventIds: string[]
  issues: CloudV2CutoverPreflightIssue[]
  unverifiedRequirements: CloudV2CutoverUnverifiedRequirement[]
}

export interface CloudV2CutoverPreflightInput {
  /** Raw response from inspect_workspace_master_backfill_source(). */
  source: unknown
  /** Optional generation held by the caller before this inspection. */
  expectedGeneration?: string
  /** Optional generation-consistent read from the existing Master repository. */
  masters?: CloudWorkspaceMastersSnapshot
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

const baseUnverifiedRequirements: CloudV2CutoverUnverifiedRequirement[] = [
  'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED',
  'BACKUP_NOT_VERIFIED',
  'MAINTENANCE_WINDOW_NOT_VERIFIED',
  'V1_WRITERS_NOT_PROVEN_DRAINED',
  'ATOMIC_CUTOVER_REVALIDATION_UNAVAILABLE',
  'ROLLBACK_PROCEDURE_NOT_VERIFIED',
]

const emptySummary = (): CloudV2CutoverPreflightSummary => ({
  eventCount: 0,
  convertedEventCount: 0,
  memberCount: 0,
  bandCount: 0,
  bandMemberRelationCount: 0,
  eventMemberReferenceCount: 0,
  eventBandReferenceCount: 0,
  conflictCount: 0,
})

const addUnique = <T>(target: T[], value: T): void => {
  if (!target.includes(value)) target.push(value)
}

const addIssue = (
  issues: CloudV2CutoverPreflightIssue[],
  issue: CloudV2CutoverPreflightIssue,
): void => {
  if (!issues.some(candidate =>
    candidate.code === issue.code &&
    candidate.eventId === issue.eventId &&
    candidate.kind === issue.kind &&
    candidate.masterId === issue.masterId)) {
    issues.push(issue)
  }
}

const getRawEventId = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.eventId === 'string' && value.eventId.trim().length > 0
    ? value.eventId
    : undefined

const diagnoseInvalidSource = (
  value: unknown,
): {
  structuralStatus: CloudV2CutoverStructuralStatus
  issues: CloudV2CutoverPreflightIssue[]
  eventCount: number
} => {
  const issues: CloudV2CutoverPreflightIssue[] = []
  if (!isRecord(value) || !Array.isArray(value.events)) {
    return {
      structuralStatus: 'indeterminate',
      issues: [{ code: 'INVALID_SOURCE' }],
      eventCount: 0,
    }
  }

  const rawEvents = Array.from(value.events)
  const ids = rawEvents.map(getRawEventId).filter((id): id is string => id !== undefined)
  if (new Set(ids).size !== ids.length) addIssue(issues, { code: 'DUPLICATE_EVENT_ID' })

  const versions = new Set<number>()
  for (const rawEvent of rawEvents) {
    const eventId = getRawEventId(rawEvent)
    const snapshotValue = isRecord(rawEvent) ? rawEvent.snapshot : undefined
    if (isRecord(snapshotValue) && typeof snapshotValue.version === 'number') {
      versions.add(snapshotValue.version)
    }
    if (!parseCloudEventSnapshotEnvelope(snapshotValue)) {
      addIssue(issues, eventId === undefined
        ? { code: 'INVALID_SNAPSHOT' }
        : { code: 'INVALID_SNAPSHOT', eventId })
    }
  }

  if (versions.has(1) && versions.has(2)) {
    addIssue(issues, { code: 'MIXED_SNAPSHOT_VERSIONS' })
  } else if (versions.has(2)) {
    addIssue(issues, { code: 'SNAPSHOT_V2_PRESENT' })
  }
  if (issues.length === 0) addIssue(issues, { code: 'INVALID_SOURCE' })

  const knownDataProblem = issues.some(issue =>
    issue.code !== 'INVALID_SOURCE')
  return {
    structuralStatus: knownDataProblem ? 'not-convertible' : 'indeterminate',
    issues,
    eventCount: rawEvents.length,
  }
}

const createStructuralSource = (
  source: CloudWorkspaceMasterBackfillSource,
): unknown => ({
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

const mapBackfillIssue = (
  issue: CloudWorkspaceMasterBackfillIssue,
): CloudV2CutoverPreflightIssue | undefined => {
  if (issue.code === 'WORKSPACE_NOT_LEGACY') return undefined
  if (issue.code === 'EXISTING_NORMALIZED_DATA') {
    return { code: 'BACKFILL_STATE_INCONSISTENT' }
  }
  if (
    issue.code === 'INVALID_SOURCE' ||
    issue.code === 'INVALID_SNAPSHOT' ||
    issue.code === 'INVALID_MEMBER' ||
    issue.code === 'INVALID_BAND' ||
    issue.code === 'SHARED_MASTER_CONFLICT'
  ) {
    return {
      code: issue.code,
      ...(issue.eventId === undefined ? {} : { eventId: issue.eventId }),
      ...(issue.kind === undefined ? {} : { kind: issue.kind }),
      ...(issue.masterId === undefined ? {} : { masterId: issue.masterId }),
    }
  }
  return undefined
}

const haveSameIdsAndValues = <T extends Member | Band>(
  planned: readonly T[],
  observed: readonly { value: T }[],
): boolean => {
  if (planned.length !== observed.length) return false
  const observedById = new Map(observed.map(record => [record.value.id, record.value]))
  return observedById.size === observed.length && planned.every(value => {
    const actual = observedById.get(value.id)
    return actual !== undefined && arePersistedValuesEqual(value, actual)
  })
}

const haveExactReferences = (
  snapshot: CloudEventSnapshotV1,
  converted: CloudEventSnapshotV2,
): boolean => {
  const expectedMembers = [...snapshot.appState.members.map(member => member.id)].sort()
  const expectedBands = [...snapshot.appState.bands.map(band => band.id)].sort()
  return arePersistedValuesEqual(expectedMembers, converted.masterReferences.memberIds) &&
    arePersistedValuesEqual(expectedBands, converted.masterReferences.bandIds)
}

const roundTripsWithoutLoss = (
  snapshot: CloudEventSnapshotV1,
  converted: CloudEventSnapshotV2,
  plan: CloudWorkspaceMasterBackfillPlan,
): boolean => {
  if (!eventOwnedCollectionKeys.every(key =>
    arePersistedValuesEqual(snapshot.appState[key], converted.eventState[key]))) {
    return false
  }
  const memberById = new Map(plan.members.map(member => [member.id, member]))
  const bandById = new Map(plan.bands.map(band => [band.id, band]))
  const members = snapshot.appState.members.map(member => memberById.get(member.id))
  const bands = snapshot.appState.bands.map(band => bandById.get(band.id))
  if (members.some(member => member === undefined) || bands.some(band => band === undefined)) {
    return false
  }
  const reconstructed = createPersistedAppState({
    members: members as Member[],
    bands: bands as Band[],
    ...converted.eventState,
  })
  return arePersistedValuesEqual(snapshot.appState, reconstructed)
}

const addWorkspaceEvidenceIssues = (
  source: CloudWorkspaceMasterBackfillSource,
  input: CloudV2CutoverPreflightInput,
  issues: CloudV2CutoverPreflightIssue[],
): void => {
  if (source.workspaceStatus === 'conflict') {
    addIssue(issues, { code: 'WORKSPACE_CONFLICT' })
  } else if (source.workspaceStatus === 'ready') {
    addIssue(issues, { code: 'WORKSPACE_ALREADY_READY' })
  }
  if (
    input.expectedGeneration !== undefined &&
    (
      !isPostgresBigintGeneration(input.expectedGeneration) ||
      input.expectedGeneration !== source.workspaceGeneration
    )
  ) {
    addIssue(issues, { code: 'GENERATION_EVIDENCE_MISMATCH' })
  }
}

/**
 * Performs a read-only V1-to-V2 structural proof. It does not authorize a
 * cutover: live writers, backups and the final transactional revalidation are
 * deliberately reported as unverified requirements.
 */
export const createCloudV2CutoverPreflight = async (
  input: CloudV2CutoverPreflightInput,
): Promise<CloudV2CutoverPreflightResult> => {
  const parsedSource = parseCloudWorkspaceMasterBackfillSource(input.source)
  if (!parsedSource || !isPostgresBigintGeneration(parsedSource.workspaceGeneration)) {
    const diagnosed = diagnoseInvalidSource(input.source)
    return {
      workspaceId: isRecord(input.source) && typeof input.source.workspaceId === 'string'
        ? input.source.workspaceId
        : '',
      structuralStatus: diagnosed.structuralStatus,
      cutoverReadiness: 'blocked',
      safeToCutover: false,
      summary: { ...emptySummary(), eventCount: diagnosed.eventCount },
      convertedEvents: [],
      invalidEventIds: diagnosed.issues.flatMap(issue =>
        issue.eventId === undefined ? [] : [issue.eventId]),
      issues: diagnosed.issues,
      unverifiedRequirements: [...baseUnverifiedRequirements],
    }
  }

  const issues: CloudV2CutoverPreflightIssue[] = []
  const unverifiedRequirements = [...baseUnverifiedRequirements]
  addWorkspaceEvidenceIssues(parsedSource, input, issues)

  const structuralPlan = createCloudWorkspaceMasterBackfillPlan(
    createStructuralSource(parsedSource),
  )
  for (const issue of structuralPlan.report.issues) {
    const mapped = mapBackfillIssue(issue)
    if (mapped) addIssue(issues, mapped)
  }

  const summary: CloudV2CutoverPreflightSummary = {
    eventCount: structuralPlan.report.eventCount,
    convertedEventCount: 0,
    memberCount: structuralPlan.report.memberCount,
    bandCount: structuralPlan.report.bandCount,
    bandMemberRelationCount: structuralPlan.report.bandMemberRelationCount,
    eventMemberReferenceCount: structuralPlan.report.eventMemberReferenceCount,
    eventBandReferenceCount: structuralPlan.report.eventBandReferenceCount,
    conflictCount: structuralPlan.report.conflictCount,
  }
  const convertedEvents: CloudV2CutoverConvertedEventSummary[] = []

  if (structuralPlan.ok) {
    for (const sourceEvent of parsedSource.events) {
      const parsedSnapshot = parseCloudEventSnapshot(sourceEvent.snapshot)
      if (!parsedSnapshot) {
        addIssue(issues, { code: 'INVALID_SNAPSHOT', eventId: sourceEvent.eventId })
        continue
      }
      const converted = createCloudEventSnapshotV2(
        parsedSnapshot.appState,
        sourceEvent.eventId,
      )
      if (!converted.ok) {
        addIssue(issues, { code: 'V2_CONVERSION_FAILED', eventId: sourceEvent.eventId })
        continue
      }
      if (
        !haveExactReferences(parsedSnapshot, converted.snapshot) ||
        !hasResolvedCloudEventSnapshotV2Masters(
          converted.snapshot,
          structuralPlan.plan.members,
          structuralPlan.plan.bands,
        )
      ) {
        addIssue(issues, {
          code: 'V2_MASTER_REFERENCE_INVALID',
          eventId: sourceEvent.eventId,
        })
        continue
      }
      if (!roundTripsWithoutLoss(parsedSnapshot, converted.snapshot, structuralPlan.plan)) {
        addIssue(issues, { code: 'V2_ROUND_TRIP_MISMATCH', eventId: sourceEvent.eventId })
        continue
      }
      convertedEvents.push({
        eventId: sourceEvent.eventId,
        revision: sourceEvent.revision,
        memberReferenceCount: converted.snapshot.masterReferences.memberIds.length,
        bandReferenceCount: converted.snapshot.masterReferences.bandIds.length,
      })
    }
  }
  summary.convertedEventCount = convertedEvents.length

  const actualPlan = createCloudWorkspaceMasterBackfillPlan(input.source)
  for (const issue of actualPlan.report.issues) {
    const mapped = mapBackfillIssue(issue)
    if (mapped?.code === 'BACKFILL_STATE_INCONSISTENT') addIssue(issues, mapped)
  }

  const completedBackfill = parsedSource.existing.completedBackfill
  if (completedBackfill === null) {
    addUnique(unverifiedRequirements, 'BACKFILL_NOT_COMPLETED')
  } else if (actualPlan.ok) {
    const fingerprint = await createCloudWorkspaceMasterBackfillFingerprint(actualPlan.plan)
    if (fingerprint !== completedBackfill.planFingerprint) {
      addIssue(issues, { code: 'BACKFILL_FINGERPRINT_MISMATCH' })
    }
    if (input.masters === undefined) {
      addUnique(unverifiedRequirements, 'NORMALIZED_MASTER_CONTENTS_NOT_OBSERVED')
    } else if (
      input.masters.workspaceId !== parsedSource.workspaceId ||
      input.masters.generation !== parsedSource.workspaceGeneration ||
      !haveSameIdsAndValues(actualPlan.plan.members, input.masters.members) ||
      !haveSameIdsAndValues(actualPlan.plan.bands, input.masters.bands)
    ) {
      addIssue(issues, { code: 'NORMALIZED_MASTER_MISMATCH' })
    }
  }

  const conversionFailureCodes = new Set<CloudV2CutoverPreflightIssueCode>([
    'INVALID_SOURCE',
    'INVALID_SNAPSHOT',
    'DUPLICATE_EVENT_ID',
    'MIXED_SNAPSHOT_VERSIONS',
    'SNAPSHOT_V2_PRESENT',
    'INVALID_MEMBER',
    'INVALID_BAND',
    'SHARED_MASTER_CONFLICT',
    'V2_CONVERSION_FAILED',
    'V2_MASTER_REFERENCE_INVALID',
    'V2_ROUND_TRIP_MISMATCH',
  ])
  const structuralStatus: CloudV2CutoverStructuralStatus = issues.some(issue =>
    conversionFailureCodes.has(issue.code)) ||
    summary.convertedEventCount !== summary.eventCount
    ? 'not-convertible'
    : 'convertible'

  return {
    workspaceId: parsedSource.workspaceId,
    workspaceStatus: parsedSource.workspaceStatus,
    generation: parsedSource.workspaceGeneration,
    structuralStatus,
    cutoverReadiness: issues.length > 0 ||
      unverifiedRequirements.includes('BACKFILL_NOT_COMPLETED')
      ? 'blocked'
      : 'indeterminate',
    safeToCutover: false,
    summary,
    convertedEvents,
    invalidEventIds: [...new Set(issues.flatMap(issue =>
      issue.eventId === undefined ? [] : [issue.eventId]))].sort(),
    issues,
    unverifiedRequirements,
  }
}
