import type {
  CloudEventRecord,
  CloudEventRepository,
  CloudEventRepositoryError,
} from './cloudEventRepository.ts'
import type {
  CloudEventV2Record,
  CloudEventV2Repository,
  CloudEventV2RepositoryError,
} from './cloudEventV2Repository.ts'
import { hasResolvedCloudEventSnapshotV2Masters } from './cloudEventSnapshot.ts'
import type {
  CloudWorkspaceMasterError,
  CloudWorkspaceMasterRepository,
  CloudWorkspaceMastersSnapshot,
} from './cloudWorkspaceMasterRepository.ts'

export interface CloudWorkspaceGenerationReadModel {
  workspaceId: string
  generation: string
  events: CloudEventRecord[]
  masters: CloudWorkspaceMastersSnapshot
}

export type CloudWorkspaceGenerationReadResult =
  | { ok: true; value: CloudWorkspaceGenerationReadModel }
  | {
      ok: false
      source: 'events'
      error: CloudEventRepositoryError
    }
  | {
      ok: false
      source: 'masters'
      error: CloudWorkspaceMasterError
    }

export interface CloudWorkspaceV2GenerationReadModel {
  workspaceId: string
  generation: string
  events: CloudEventV2Record[]
  masters: CloudWorkspaceMastersSnapshot
}

export type CloudWorkspaceV2GenerationReadResult =
  | { ok: true; value: CloudWorkspaceV2GenerationReadModel }
  | {
      ok: false
      source: 'events'
      error: CloudEventV2RepositoryError
    }
  | {
      ok: false
      source: 'masters'
      error: CloudWorkspaceMasterError
    }
  | {
      ok: false
      source: 'references'
      error: CloudEventV2RepositoryError
    }

/**
 * Reads Event pages first, then requires every Master page to match the exact
 * same Workspace generation. No domain/cache mutation occurs here; callers
 * receive either one complete generation or a failure.
 */
export const loadCloudWorkspaceAtOneGeneration = async (
  workspaceId: string,
  eventRepository: CloudEventRepository,
  masterRepository: CloudWorkspaceMasterRepository,
): Promise<CloudWorkspaceGenerationReadResult> => {
  const events = await eventRepository.loadWorkspaceEventsAtGeneration(workspaceId)
  if (!events.ok) return { ok: false, source: 'events', error: events.error }

  const masters = await masterRepository.loadWorkspaceMasters(
    workspaceId,
    events.value.generation,
  )
  if (!masters.ok) return { ok: false, source: 'masters', error: masters.error }
  if (masters.value.generation !== events.value.generation) {
    return {
      ok: false,
      source: 'masters',
      error: {
        code: 'WORKSPACE_SNAPSHOT_CHANGED',
        message: 'EventとWorkspace共通データの世代が一致しません。',
      },
    }
  }

  return {
    ok: true,
    value: {
      workspaceId,
      generation: events.value.generation,
      events: events.value.records,
      masters: masters.value,
    },
  }
}

/**
 * V2-only read boundary. Event pages and normalized Masters must resolve at
 * one Workspace generation, and every Event must have the exact direct plus
 * transitive Master closure. This helper returns data only; it never mutates
 * App state or the Workspace-scoped local cache.
 */
export const loadCloudWorkspaceV2AtOneGeneration = async (
  workspaceId: string,
  eventRepository: CloudEventV2Repository,
  masterRepository: CloudWorkspaceMasterRepository,
): Promise<CloudWorkspaceV2GenerationReadResult> => {
  const events = await eventRepository.loadWorkspaceEventsAtGeneration(workspaceId)
  if (!events.ok) return { ok: false, source: 'events', error: events.error }

  const masters = await masterRepository.loadWorkspaceMasters(
    workspaceId,
    events.value.generation,
  )
  if (!masters.ok) return { ok: false, source: 'masters', error: masters.error }
  if (masters.value.generation !== events.value.generation) {
    return {
      ok: false,
      source: 'masters',
      error: {
        code: 'WORKSPACE_SNAPSHOT_CHANGED',
        message: 'EventとWorkspace共通データの世代が一致しません。',
      },
    }
  }

  const memberValues = masters.value.members.map(record => record.value)
  const bandValues = masters.value.bands.map(record => record.value)
  if (events.value.records.some(record =>
    !hasResolvedCloudEventSnapshotV2Masters(
      record.snapshot,
      memberValues,
      bandValues,
    ))) {
    return {
      ok: false,
      source: 'references',
      error: {
        code: 'MASTER_REFERENCE_INVALID',
        message: 'Cloud EventとWorkspace共通データの参照が一致しません。',
      },
    }
  }

  return {
    ok: true,
    value: {
      workspaceId,
      generation: events.value.generation,
      events: events.value.records,
      masters: masters.value,
    },
  }
}
