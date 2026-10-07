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
