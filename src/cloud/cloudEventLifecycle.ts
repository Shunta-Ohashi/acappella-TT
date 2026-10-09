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
  arePersistedValuesEqual,
  createCloudEventSnapshot,
  createCloudWorkspaceState,
  type CloudEventSnapshotV1,
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
  | { scopeKey: string; visitId: string; kind: 'loading' }
  | { scopeKey: string; visitId: string; kind: 'ready' }
  | { scopeKey: string; visitId: string; kind: 'error'; message: string }

export const getCloudEventHydrationView = ({
  cloudEnabled,
  persistenceScopeReady,
  requestedScopeKey,
  requestedVisitId,
  hydration,
}: {
  cloudEnabled: boolean
  persistenceScopeReady: boolean
  requestedScopeKey: string
  requestedVisitId: string
  hydration: CloudEventHydrationState
}): 'loading' | 'error' | 'content' => {
  if (!persistenceScopeReady) return 'loading'
  if (!cloudEnabled) return 'content'
  if (
    hydration.scopeKey !== requestedScopeKey ||
    hydration.visitId !== requestedVisitId ||
    hydration.kind === 'loading'
  ) {
    return 'loading'
  }
  return hydration.kind === 'error' ? 'error' : 'content'
}

export type CloudEventHydrationAttemptResult =
  | { kind: 'ignored' }
  | { kind: 'error'; error: CloudEventRepositoryError }
  | { kind: 'ready' }

const unexpectedHydrationError = (): CloudEventRepositoryError => ({
  code: 'SUPABASE_ERROR',
  message: 'Cloud Eventの通信に失敗しました。',
})

export const runCloudEventHydrationAttempt = async <T>({
  scopeKey,
  visitId,
  isCurrent,
  load,
  apply,
  onStateChange,
}: {
  scopeKey: string
  visitId: string
  isCurrent: () => boolean
  load: () => Promise<CloudEventLifecycleResult<T>>
  apply: (value: T) => void
  onStateChange: (state: CloudEventHydrationState) => void
}): Promise<CloudEventHydrationAttemptResult> => {
  if (!isCurrent()) return { kind: 'ignored' }
  onStateChange({ scopeKey, visitId, kind: 'loading' })

  let result: CloudEventLifecycleResult<T>
  try {
    result = await load()
  } catch {
    if (!isCurrent()) return { kind: 'ignored' }
    const error = unexpectedHydrationError()
    onStateChange({ scopeKey, visitId, kind: 'error', message: error.message })
    return { kind: 'error', error }
  }

  if (!isCurrent()) return { kind: 'ignored' }
  if (!result.ok) {
    onStateChange({ scopeKey, visitId, kind: 'error', message: result.error.message })
    return { kind: 'error', error: result.error }
  }

  apply(result.value)
  onStateChange({ scopeKey, visitId, kind: 'ready' })
  return { kind: 'ready' }
}

const createCloudEventOperationKey = (
  scopeKey: string,
  eventId: EventId,
): string => JSON.stringify([scopeKey, eventId])

export type CloudEventOperationKind = 'save' | 'delete'

export interface CloudEventOperationLease {
  key: string
  kind: CloudEventOperationKind
  visitId: string
  token: symbol
}

export interface CloudEventOperationRegistry {
  tryStart: (
    scopeKey: string,
    eventId: EventId,
    kind: CloudEventOperationKind,
    visitId: string,
  ) => CloudEventOperationLease | undefined
  finish: (lease: CloudEventOperationLease) => void
  get: (scopeKey: string, eventId: EventId) => CloudEventOperationKind | undefined
  snapshot: () => ReadonlyMap<string, CloudEventOperationKind>
}

export const createCloudEventOperationRegistry = (): CloudEventOperationRegistry => {
  const inFlightOperations = new Map<string, {
    kind: CloudEventOperationKind
    visitId: string
    token: symbol
  }>()

  return {
    tryStart(scopeKey, eventId, kind, visitId) {
      const key = createCloudEventOperationKey(scopeKey, eventId)
      if (inFlightOperations.has(key)) return undefined
      const lease = { key, kind, visitId, token: Symbol(kind) }
      inFlightOperations.set(key, { kind, visitId, token: lease.token })
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
  visitId,
  operation,
  onChange,
}: {
  registry: CloudEventOperationRegistry
  scopeKey: string
  eventId: EventId
  kind: CloudEventOperationKind
  visitId: string
  operation: (lease: CloudEventOperationLease) => Promise<T>
  onChange?: (
    inFlightOperations: ReadonlyMap<string, CloudEventOperationKind>,
  ) => void
}): Promise<CloudEventOperationExecution<T>> => {
  const lease = registry.tryStart(scopeKey, eventId, kind, visitId)
  if (!lease) return { started: false }

  try {
    onChange?.(registry.snapshot())
    return { started: true, value: await operation(lease) }
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
  requestedVisitId,
  hydration,
}: {
  cloudEnabled: boolean
  persistenceScopeReady: boolean
  requestedScopeKey: string
  requestedVisitId: string
  hydration: CloudEventHydrationState
}): boolean => persistenceScopeReady && (
  !cloudEnabled || (
    hydration.scopeKey === requestedScopeKey &&
    hydration.visitId === requestedVisitId &&
    hydration.kind === 'ready'
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
  visitId,
  workspaceId,
  eventId,
  repository,
  isVisitCurrent,
  getLatestState,
  commit,
  onChange,
}: {
  registry: CloudEventOperationRegistry
  scopeKey: string
  visitId: string
  workspaceId: string
  eventId: EventId
  repository: CloudEventRepository
  isVisitCurrent: (visitId: string) => boolean
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
    visitId,
    onChange,
    operation: async (lease) => {
      const deleted = await deleteCloudEvent(repository, workspaceId, eventId)
      if (!deleted.ok || !isVisitCurrent(lease.visitId)) {
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
  const loaded = await repository.loadWorkspaceEvents(workspaceId)
  if (!loaded.ok) return loaded

  const records = loaded.value
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

export interface SavedCloudEvent {
  record: CloudEventRecord
  snapshot: CloudEventSnapshotV1
}

export const saveCloudEventFromState = async (
  repository: CloudEventRepository,
  workspaceId: string,
  state: PersistedDomainState,
  eventId: EventId,
): Promise<CloudEventLifecycleResult<SavedCloudEvent>> => {
  const created = createCloudEventSnapshot(state, eventId)
  if (!created.ok) {
    return { ok: false, error: invalidSnapshotError() }
  }
  const saved = await repository.saveEvent(workspaceId, created.snapshot)
  if (!saved.ok) return saved
  return {
    ok: true,
    value: { record: saved.value, snapshot: created.snapshot },
  }
}

export type CloudEventSaveCompletion =
  | { kind: 'ignored' }
  | { kind: 'failed'; error: CloudEventRepositoryError }
  | { kind: 'stale'; record: CloudEventRecord }
  | { kind: 'saved'; record: CloudEventRecord }

export const resolveCloudEventSaveCompletion = ({
  result,
  currentState,
  eventId,
  isVisitCurrent,
}: {
  result: CloudEventLifecycleResult<SavedCloudEvent>
  currentState: PersistedDomainState
  eventId: EventId
  isVisitCurrent: boolean
}): CloudEventSaveCompletion => {
  if (!isVisitCurrent) return { kind: 'ignored' }
  if (!result.ok) return { kind: 'failed', error: result.error }
  const current = createCloudEventSnapshot(currentState, eventId)
  if (
    !current.ok ||
    !arePersistedValuesEqual(result.value.snapshot, current.snapshot)
  ) return { kind: 'stale', record: result.value.record }
  return { kind: 'saved', record: result.value.record }
}
