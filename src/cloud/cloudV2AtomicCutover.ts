import {
  createCloudEventSnapshotV2,
  parseCloudEventSnapshot,
  type CloudEventSnapshotV2,
} from './cloudEventSnapshot.ts'
import {
  createCloudV2CutoverInspectionReport,
  parseCloudV2CutoverInspection,
} from './cloudV2CutoverInspection.ts'

export const CLOUD_V2_ATOMIC_CUTOVER_PLAN_VERSION = 1 as const

export interface CloudV2AtomicCutoverPlanEvent {
  eventId: string
  expectedRevision: number
  expectedSnapshotFingerprint: string
  snapshotV2: CloudEventSnapshotV2
}

/**
 * A versioned request body for the backend-only atomic cutover RPC.
 *
 * The V2 candidates are conveniences, not authority: the database re-derives
 * and compares their Event-owned state and Master reference closure from the
 * locked Snapshot V1 rows before it writes anything.
 */
export interface CloudV2AtomicCutoverPlan {
  version: typeof CLOUD_V2_ATOMIC_CUTOVER_PLAN_VERSION
  workspaceId: string
  expectedGeneration: string
  expectedBackfillPlanFingerprint: string
  events: CloudV2AtomicCutoverPlanEvent[]
}

export type CloudV2AtomicCutoverPlanResult =
  | {
      ok: true
      plan: CloudV2AtomicCutoverPlan
      summary: {
        eventCount: number
        memberCount: number
        bandCount: number
        eventMemberReferenceCount: number
        eventBandReferenceCount: number
      }
    }
  | {
      ok: false
      reason:
        | 'INVALID_INSPECTION'
        | 'WORKSPACE_NOT_LEGACY'
        | 'BACKFILL_NOT_COMPLETED'
        | 'EVIDENCE_NOT_CONSISTENT'
        | 'CONVERSION_FAILED'
      eventIds?: string[]
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

/**
 * Creates the complete, immutable input expected by cutover_cloud_v2_validated.
 * This helper remains read-only and never changes Preflight's safeToCutover=false
 * operational boundary.
 */
export const createCloudV2AtomicCutoverPlan = async (
  rawInspection: unknown,
  expectedWorkspaceId: string,
): Promise<CloudV2AtomicCutoverPlanResult> => {
  const inspection = await parseCloudV2CutoverInspection(
    rawInspection,
    expectedWorkspaceId,
  )
  if (!inspection) return { ok: false, reason: 'INVALID_INSPECTION' }

  const report = await createCloudV2CutoverInspectionReport(
    rawInspection,
    expectedWorkspaceId,
    inspection.source.workspaceGeneration,
  )
  if (!report) return { ok: false, reason: 'INVALID_INSPECTION' }
  if (inspection.source.workspaceStatus !== 'legacy') {
    return { ok: false, reason: 'WORKSPACE_NOT_LEGACY' }
  }

  const completedBackfill = inspection.source.existing.completedBackfill
  if (completedBackfill === null) {
    return { ok: false, reason: 'BACKFILL_NOT_COMPLETED' }
  }
  if (
    report.preflight.structuralStatus !== 'convertible' ||
    report.preflight.issues.length > 0 ||
    report.referenceEvidence.status !== 'consistent' ||
    report.preflight.unverifiedRequirements.includes(
      'NORMALIZED_MASTER_CONTENTS_NOT_OBSERVED',
    ) ||
    report.preflight.unverifiedRequirements.includes(
      'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED',
    )
  ) {
    return { ok: false, reason: 'EVIDENCE_NOT_CONSISTENT' }
  }

  const events: CloudV2AtomicCutoverPlanEvent[] = []
  const failedEventIds: string[] = []
  for (const sourceEvent of inspection.source.events) {
    const snapshot = parseCloudEventSnapshot(sourceEvent.snapshot)
    if (!snapshot) {
      failedEventIds.push(sourceEvent.eventId)
      continue
    }
    const converted = createCloudEventSnapshotV2(
      snapshot.appState,
      sourceEvent.eventId,
    )
    if (!converted.ok) {
      failedEventIds.push(sourceEvent.eventId)
      continue
    }
    events.push({
      eventId: sourceEvent.eventId,
      expectedRevision: sourceEvent.revision,
      expectedSnapshotFingerprint: sourceEvent.snapshotFingerprint,
      snapshotV2: converted.snapshot,
    })
  }
  if (failedEventIds.length > 0 || events.length !== inspection.source.events.length) {
    return {
      ok: false,
      reason: 'CONVERSION_FAILED',
      eventIds: [...new Set(failedEventIds)].sort(compareUtf8),
    }
  }

  events.sort((left, right) => compareUtf8(left.eventId, right.eventId))
  return {
    ok: true,
    plan: {
      version: CLOUD_V2_ATOMIC_CUTOVER_PLAN_VERSION,
      workspaceId: inspection.source.workspaceId,
      expectedGeneration: inspection.source.workspaceGeneration,
      expectedBackfillPlanFingerprint: completedBackfill.planFingerprint,
      events,
    },
    summary: {
      eventCount: events.length,
      memberCount: inspection.masters.members.length,
      bandCount: inspection.masters.bands.length,
      eventMemberReferenceCount:
        inspection.relations.eventMemberReferences.length,
      eventBandReferenceCount: inspection.relations.eventBandReferences.length,
    },
  }
}
