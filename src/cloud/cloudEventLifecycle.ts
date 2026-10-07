import type { EventId } from '../domain/models.ts'
import type {
  PersistedAppStateV5,
  PersistedDomainState,
} from '../persistence/localPersistence.ts'
import {
  createCloudEventSnapshot,
  createCloudWorkspaceState,
} from './cloudEventSnapshot.ts'
import type {
  CloudEventRecord,
  CloudEventRepository,
  CloudEventRepositoryError,
} from './cloudEventRepository.ts'

export type CloudEventLifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudEventRepositoryError }

export type CloudEventHydrationState =
  | { scopeKey: string; kind: 'loading' }
  | { scopeKey: string; kind: 'ready' }
  | { scopeKey: string; kind: 'error'; message: string }

const createCloudEventSaveKey = (
  scopeKey: string,
  eventId: EventId,
): string => JSON.stringify([scopeKey, eventId])

export interface CloudEventSaveRegistry {
  tryStart: (scopeKey: string, eventId: EventId) => boolean
  finish: (scopeKey: string, eventId: EventId) => void
  isSaving: (scopeKey: string, eventId: EventId) => boolean
  snapshot: () => ReadonlySet<string>
}

export const createCloudEventSaveRegistry = (): CloudEventSaveRegistry => {
  const inFlightSaveKeys = new Set<string>()

  return {
    tryStart(scopeKey, eventId) {
      const key = createCloudEventSaveKey(scopeKey, eventId)
      if (inFlightSaveKeys.has(key)) return false
      inFlightSaveKeys.add(key)
      return true
    },
    finish(scopeKey, eventId) {
      inFlightSaveKeys.delete(createCloudEventSaveKey(scopeKey, eventId))
    },
    isSaving(scopeKey, eventId) {
      return inFlightSaveKeys.has(createCloudEventSaveKey(scopeKey, eventId))
    },
    snapshot() {
      return new Set(inFlightSaveKeys)
    },
  }
}

export const isCloudEventSaving = (
  inFlightSaveKeys: ReadonlySet<string>,
  scopeKey: string,
  eventId: EventId,
): boolean => inFlightSaveKeys.has(createCloudEventSaveKey(scopeKey, eventId))

export const canStartCloudEventDelete = (
  registry: CloudEventSaveRegistry,
  scopeKey: string,
  eventId: EventId,
): boolean => !registry.isSaving(scopeKey, eventId)

export type CloudEventSaveExecution<T> =
  | { started: false }
  | { started: true; value: T }

export const runExclusiveCloudEventSave = async <T>({
  registry,
  scopeKey,
  eventId,
  operation,
  onChange,
}: {
  registry: CloudEventSaveRegistry
  scopeKey: string
  eventId: EventId
  operation: () => Promise<T>
  onChange?: (inFlightSaveKeys: ReadonlySet<string>) => void
}): Promise<CloudEventSaveExecution<T>> => {
  if (!registry.tryStart(scopeKey, eventId)) return { started: false }

  try {
    onChange?.(registry.snapshot())
    return { started: true, value: await operation() }
  } finally {
    registry.finish(scopeKey, eventId)
    onChange?.(registry.snapshot())
  }
}

export const isCloudEventCacheWriteReady = ({
  cloudEnabled,
  persistenceScopeReady,
  requestedScopeKey,
  hydration,
}: {
  cloudEnabled: boolean
  persistenceScopeReady: boolean
  requestedScopeKey: string
  hydration: CloudEventHydrationState
}): boolean => persistenceScopeReady && (
  !cloudEnabled || (
    hydration.scopeKey === requestedScopeKey && hydration.kind === 'ready'
  )
)

const invalidSnapshotError = (): CloudEventRepositoryError => ({
  code: 'INVALID_SNAPSHOT',
  message: 'Cloud Eventのデータ形式が正しくありません。',
})

const sharedMasterConflictError = (): CloudEventRepositoryError => ({
  code: 'SHARED_MASTER_CONFLICT',
  message: 'Cloud Event間で共有メンバーまたは固定バンドのデータが一致しないため、安全に読み込めませんでした。',
})

export interface LoadedCloudWorkspaceEvents {
  state: PersistedAppStateV5
  records: CloudEventRecord[]
}

export interface DeletedCloudEvent {
  deleted: boolean
}

export const deleteCloudEvent = async (
  repository: CloudEventRepository,
  workspaceId: string,
  eventId: EventId,
): Promise<CloudEventLifecycleResult<DeletedCloudEvent>> => {
  const deleted = await repository.deleteEvent(workspaceId, eventId)
  if (!deleted.ok) {
    return deleted.error.code === 'NOT_FOUND'
      ? { ok: true, value: { deleted: false } }
      : deleted
  }
  return { ok: true, value: { deleted: true } }
}

export const loadCloudWorkspaceEvents = async (
  repository: CloudEventRepository,
  workspaceId: string,
  localState: PersistedDomainState,
): Promise<CloudEventLifecycleResult<LoadedCloudWorkspaceEvents>> => {
  const listed = await repository.listEvents(workspaceId)
  if (!listed.ok) return listed

  const loaded = await Promise.all(
    listed.value.map(summary => repository.loadEvent(workspaceId, summary.eventId)),
  )
  const failed = loaded.find(result => !result.ok)
  if (failed && !failed.ok) return failed

  const records = loaded.flatMap(result => result.ok ? [result.value] : [])
  const assembled = createCloudWorkspaceState(
    localState,
    records.map(record => record.snapshot),
  )
  if (!assembled.ok) {
    return {
      ok: false,
      error: assembled.reason === 'SHARED_MASTER_CONFLICT'
        ? sharedMasterConflictError()
        : invalidSnapshotError(),
    }
  }

  return {
    ok: true,
    value: {
      state: assembled.state,
      records,
    },
  }
}

export const saveCloudEventFromState = async (
  repository: CloudEventRepository,
  workspaceId: string,
  state: PersistedDomainState,
  eventId: EventId,
): Promise<CloudEventLifecycleResult<CloudEventRecord>> => {
  const created = createCloudEventSnapshot(state, eventId)
  if (!created.ok) {
    return { ok: false, error: invalidSnapshotError() }
  }
  return repository.saveEvent(workspaceId, created.snapshot)
}
