import type { EventId } from '../domain/models.ts'
import {
  createEventDeletion,
  type EventDeletionResult,
} from '../domain/eventDeletion.ts'
import type {
  PersistedAppStateV5,
  PersistedDomainState,
} from '../persistence/localPersistence.ts'
import {
  createCloudEventSnapshot,
  createCloudWorkspaceState,
} from './cloudEventSnapshot.ts'
import type {
  CloudEventDeletionStatus,
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

const createCloudEventOperationKey = (
  scopeKey: string,
  eventId: EventId,
): string => JSON.stringify([scopeKey, eventId])

export type CloudEventOperationKind = 'save' | 'delete'

interface CloudEventOperationLease {
  key: string
  kind: CloudEventOperationKind
  token: symbol
}

export interface CloudEventOperationRegistry {
  tryStart: (
    scopeKey: string,
    eventId: EventId,
    kind: CloudEventOperationKind,
  ) => CloudEventOperationLease | undefined
  finish: (lease: CloudEventOperationLease) => void
  get: (scopeKey: string, eventId: EventId) => CloudEventOperationKind | undefined
  snapshot: () => ReadonlyMap<string, CloudEventOperationKind>
}

export const createCloudEventOperationRegistry = (): CloudEventOperationRegistry => {
  const inFlightOperations = new Map<string, {
    kind: CloudEventOperationKind
    token: symbol
  }>()

  return {
    tryStart(scopeKey, eventId, kind) {
      const key = createCloudEventOperationKey(scopeKey, eventId)
      if (inFlightOperations.has(key)) return undefined
      const lease = { key, kind, token: Symbol(kind) }
      inFlightOperations.set(key, { kind, token: lease.token })
      return lease
    },
    finish(lease) {
      if (inFlightOperations.get(lease.key)?.token === lease.token) {
        inFlightOperations.delete(lease.key)
      }
    },
    get(scopeKey, eventId) {
      return inFlightOperations.get(
        createCloudEventOperationKey(scopeKey, eventId),
      )?.kind
    },
    snapshot() {
      return new Map([...inFlightOperations].map(([key, operation]) => [
        key,
        operation.kind,
      ]))
    },
  }
}

export const getCloudEventOperation = (
  inFlightOperations: ReadonlyMap<string, CloudEventOperationKind>,
  scopeKey: string,
  eventId: EventId,
): CloudEventOperationKind | undefined => inFlightOperations.get(
  createCloudEventOperationKey(scopeKey, eventId),
)

export type CloudEventOperationExecution<T> =
  | { started: false }
  | { started: true; value: T }

export const runExclusiveCloudEventOperation = async <T>({
  registry,
  scopeKey,
  eventId,
  kind,
  operation,
  onChange,
}: {
  registry: CloudEventOperationRegistry
  scopeKey: string
  eventId: EventId
  kind: CloudEventOperationKind
  operation: () => Promise<T>
  onChange?: (
    inFlightOperations: ReadonlyMap<string, CloudEventOperationKind>,
  ) => void
}): Promise<CloudEventOperationExecution<T>> => {
  const lease = registry.tryStart(scopeKey, eventId, kind)
  if (!lease) return { started: false }

  try {
    onChange?.(registry.snapshot())
    return { started: true, value: await operation() }
  } finally {
    registry.finish(lease)
    onChange?.(registry.snapshot())
  }
}

export const runExclusiveCloudEventSave = async <T>(input: Omit<
  Parameters<typeof runExclusiveCloudEventOperation<T>>[0],
  'kind'
>): Promise<CloudEventOperationExecution<T>> => runExclusiveCloudEventOperation({
  ...input,
  kind: 'save',
})

export const runExclusiveCloudEventDelete = async <T>(input: Omit<
  Parameters<typeof runExclusiveCloudEventOperation<T>>[0],
  'kind'
>): Promise<CloudEventOperationExecution<T>> => runExclusiveCloudEventOperation({
  ...input,
  kind: 'delete',
})

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
  status: CloudEventDeletionStatus
}

export const deleteCloudEvent = async (
  repository: CloudEventRepository,
  workspaceId: string,
  eventId: EventId,
): Promise<CloudEventLifecycleResult<DeletedCloudEvent>> => {
  const deleted = await repository.deleteEvent(workspaceId, eventId)
  if (!deleted.ok) return deleted
  return {
    ok: true,
    value: {
      deleted: deleted.value.status === 'deleted',
      status: deleted.value.status,
    },
  }
}

export type CloudEventDeletionResult = EventDeletionResult | {
  ok: false
  reason: 'CLOUD_DELETE_FAILED'
}

export const runExclusiveCloudEventDeletion = ({
  registry,
  scopeKey,
  workspaceId,
  eventId,
  repository,
  isScopeCurrent,
  getLatestState,
  commit,
  onChange,
}: {
  registry: CloudEventOperationRegistry
  scopeKey: string
  workspaceId: string
  eventId: EventId
  repository: CloudEventRepository
  isScopeCurrent: () => boolean
  getLatestState: () => PersistedDomainState
  commit: (result: Extract<EventDeletionResult, { ok: true }>) => void
  onChange?: (
    inFlightOperations: ReadonlyMap<string, CloudEventOperationKind>,
  ) => void
}): Promise<CloudEventOperationExecution<CloudEventDeletionResult>> =>
  runExclusiveCloudEventDelete({
    registry,
    scopeKey,
    eventId,
    onChange,
    operation: async () => {
      const deleted = await deleteCloudEvent(repository, workspaceId, eventId)
      if (!deleted.ok || !isScopeCurrent()) {
        return { ok: false, reason: 'CLOUD_DELETE_FAILED' }
      }
      const result = createEventDeletion({ eventId, ...getLatestState() })
      if (!result.ok) return result
      commit(result)
      return result
    },
  })

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
