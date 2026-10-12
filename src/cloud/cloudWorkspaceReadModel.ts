import type {
  CloudEventRecord,
  CloudEventRepository,
  CloudEventRepositoryError,
} from './cloudEventRepository.ts'
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
