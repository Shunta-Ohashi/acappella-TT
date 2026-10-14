import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventId } from '../domain/models.ts'
import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  arePersistedValuesEqual,
  parseCloudEventSnapshotV2,
  type CloudEventSnapshotV2,
} from './cloudEventSnapshot.ts'
import { isPostgresBigintGeneration } from './cloudGeneration.ts'

export const CLOUD_EVENT_V2_WORKSPACE_PAGE_SIZE = 100

export interface CloudEventV2Record {
  workspaceId: string
  eventId: EventId
  eventName: string
  snapshot: CloudEventSnapshotV2
  revision: number
  createdAt: string
  updatedAt: string
}

export interface CloudEventV2WorkspaceSnapshot {
  generation: string
  records: CloudEventV2Record[]
}

export type CloudEventV2RepositoryErrorCode =
  | 'ACCESS_DENIED'
  | 'ALREADY_EXISTS'
  | 'CONFIGURATION_ERROR'
  | 'EVENT_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE'
  | 'INVALID_SNAPSHOT'
  | 'MASTER_REFERENCE_INVALID'
  | 'REVISION_CONFLICT'
  | 'SNAPSHOT_VERSION_CONFLICT'
  | 'SUPABASE_ERROR'
  | 'WORKSPACE_NOT_READY'
  | 'WORKSPACE_SNAPSHOT_CHANGED'

export interface CloudEventV2RepositoryError {
  code: CloudEventV2RepositoryErrorCode
  message: string
}

export type CloudEventV2RepositoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudEventV2RepositoryError }

export interface CloudEventV2DatabaseError {
  code?: string
  message?: string
}

export interface CloudEventV2DatabaseResult<T> {
  data: T | null
  error: CloudEventV2DatabaseError | null
}

export interface CloudEventV2DatabaseGateway {
  loadAuthorizedWorkspacePage: (
    workspaceId: string,
    afterEventId: EventId | null,
    limit: number,
    expectedGeneration: string | null,
  ) => Promise<CloudEventV2DatabaseResult<unknown>>
  saveValidatedSnapshot: (input: {
    workspaceId: string
    snapshot: CloudEventSnapshotV2
    expectedRevision: number | null
    expectedGeneration: string
  }) => Promise<CloudEventV2DatabaseResult<unknown>>
}

export interface CloudEventV2Repository {
  loadWorkspaceEventsAtGeneration: (
    workspaceId: string,
    expectedGeneration?: string,
  ) => Promise<CloudEventV2RepositoryResult<CloudEventV2WorkspaceSnapshot>>
  saveEvent: (
    workspaceId: string,
    snapshot: CloudEventSnapshotV2,
    expectedRevision: number | null,
    expectedGeneration: string,
  ) => Promise<CloudEventV2RepositoryResult<{
    generation: string
    record: CloudEventV2Record
  }>>
}

const standardUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const normalizeWorkspaceId = (value: string): string | undefined =>
  standardUuidPattern.test(value) ? value.toLowerCase() : undefined

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value))

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isNextGeneration = (before: string, after: string): boolean => {
  try {
    return BigInt(after) === BigInt(before) + 1n
  } catch {
    return false
  }
}

const errorResult = (
  code: CloudEventV2RepositoryErrorCode,
  message: string,
): CloudEventV2RepositoryResult<never> => ({ ok: false, error: { code, message } })

const invalidResponse = () => errorResult(
  'INVALID_RESPONSE',
  'Cloud Event Snapshot V2の応答を確認できませんでした。',
)

const invalidSnapshot = () => errorResult(
  'INVALID_SNAPSHOT',
  'Cloud Event Snapshot V2の形式またはversionが正しくありません。',
)

const databaseFailure = (
  error: CloudEventV2DatabaseError,
): CloudEventV2RepositoryResult<never> => {
  switch (error.code) {
    case '42501':
    case 'ACCESS_DENIED':
    case 'AUTHENTICATION_REQUIRED':
      return errorResult('ACCESS_DENIED', 'Cloud Eventを変更する権限がありません。')
    case '23505':
    case 'ALREADY_EXISTS':
      return errorResult('ALREADY_EXISTS', '同じIDのCloud Eventが既に存在します。')
    case 'P0002':
    case 'EVENT_NOT_FOUND':
      return errorResult('EVENT_NOT_FOUND', 'Cloud Eventが見つかりません。')
    case '40001':
    case 'REVISION_CONFLICT':
      return errorResult('REVISION_CONFLICT', 'Cloud Eventが他の端末で更新されています。')
    case 'PVE04':
    case 'WORKSPACE_SNAPSHOT_CHANGED':
      return errorResult('WORKSPACE_SNAPSHOT_CHANGED', 'Workspaceが更新されています。')
    case '55000':
    case 'WORKSPACE_NOT_READY':
      return errorResult('WORKSPACE_NOT_READY', 'WorkspaceはSnapshot V2を利用できません。')
    case 'PVE02':
    case 'MASTER_REFERENCE_INVALID':
      return errorResult('MASTER_REFERENCE_INVALID', 'Workspace共通データの参照が一致しません。')
    case 'PVE01':
    case 'SNAPSHOT_VERSION_CONFLICT':
      return errorResult('SNAPSHOT_VERSION_CONFLICT', 'Snapshot V1をV2保存APIから上書きできません。')
    case 'INVALID_SNAPSHOT':
      return invalidSnapshot()
    case 'INVALID_RESPONSE':
      return invalidResponse()
    case 'CONFIGURATION_ERROR':
      return errorResult('CONFIGURATION_ERROR', 'Cloud Event V2保存機能が設定されていません。')
    default:
      return errorResult('SUPABASE_ERROR', 'Cloud Event V2の通信に失敗しました。')
  }
}

export const parseCloudEventV2Record = (
  value: unknown,
  expectedWorkspaceId?: string,
): CloudEventV2Record | undefined => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.workspace_id) ||
    (expectedWorkspaceId !== undefined && value.workspace_id !== expectedWorkspaceId) ||
    !isNonEmptyString(value.event_id) ||
    !isNonEmptyString(value.event_name) ||
    !isPositiveSafeInteger(value.revision) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) return undefined

  const snapshot = parseCloudEventSnapshotV2(value.event_snapshot)
  const event = snapshot?.eventState.events[0]
  if (
    !snapshot ||
    event?.id !== value.event_id ||
    event.name !== value.event_name
  ) return undefined

  return {
    workspaceId: value.workspace_id,
    eventId: value.event_id,
    eventName: value.event_name,
    snapshot,
    revision: value.revision,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

interface AuthorizedWorkspacePage {
  generation: string
  rows: unknown[]
  nextCursor: EventId | null
}

const parseAuthorizedWorkspacePage = (
  value: unknown,
  workspaceId: string,
  pageSize: number,
): AuthorizedWorkspacePage | undefined => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.workspace_id !== workspaceId ||
    !isPostgresBigintGeneration(value.workspace_generation) ||
    !Array.isArray(value.rows) ||
    value.rows.length > pageSize ||
    !Object.hasOwn(value, 'next_cursor') ||
    Object.hasOwn(value, 'error') ||
    (value.next_cursor !== null && !isNonEmptyString(value.next_cursor))
  ) return undefined
  const nextCursor = value.next_cursor as EventId | null
  if (
    (value.rows.length === 0 && nextCursor !== null) ||
    (nextCursor !== null && value.rows.length !== pageSize)
  ) return undefined
  return {
    generation: value.workspace_generation,
    rows: value.rows,
    nextCursor,
  }
}

const parseSavedValue = (
  value: unknown,
  workspaceId: string,
  snapshot: CloudEventSnapshotV2,
  expectedRevision: number | null,
  expectedGeneration: string,
): { generation: string; record: CloudEventV2Record } | undefined => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.workspaceId !== workspaceId ||
    !isPostgresBigintGeneration(value.workspaceGeneration) ||
    !isRecord(value.record)
  ) return undefined
  const record = parseCloudEventV2Record(value.record, workspaceId)
  const event = snapshot.eventState.events[0]
  if (
    !record ||
    record.eventId !== event.id ||
    record.eventName !== event.name ||
    record.revision !== (expectedRevision === null ? 1 : expectedRevision + 1) ||
    !isNextGeneration(expectedGeneration, value.workspaceGeneration) ||
    !arePersistedValuesEqual(record.snapshot, snapshot)
  ) return undefined
  return { generation: value.workspaceGeneration, record }
}

export const createCloudEventV2Repository = (
  gateway: CloudEventV2DatabaseGateway,
  pageSize = CLOUD_EVENT_V2_WORKSPACE_PAGE_SIZE,
): CloudEventV2Repository => {
  const effectivePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 &&
    pageSize <= CLOUD_EVENT_V2_WORKSPACE_PAGE_SIZE
    ? pageSize
    : CLOUD_EVENT_V2_WORKSPACE_PAGE_SIZE

  return {
    async loadWorkspaceEventsAtGeneration(workspaceId, initialGeneration) {
      const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
      if (!normalizedWorkspaceId ||
        (initialGeneration !== undefined &&
          !isPostgresBigintGeneration(initialGeneration))) {
        return errorResult('INVALID_ARGUMENT', 'Workspace IDまたはgenerationが正しくありません。')
      }

      const records: CloudEventV2Record[] = []
      const seenIds = new Set<string>()
      const seenCursors = new Set<string>()
      let cursor: EventId | null = null
      let generation: string | null = initialGeneration ?? null
      try {
        while (true) {
          const result = await gateway.loadAuthorizedWorkspacePage(
            normalizedWorkspaceId,
            cursor,
            effectivePageSize,
            generation,
          )
          if (
            result.error?.code === '40001' ||
            result.error?.code === 'WORKSPACE_SNAPSHOT_CHANGED'
          ) {
            return errorResult(
              'WORKSPACE_SNAPSHOT_CHANGED',
              'Cloud Eventの読込中にWorkspaceが更新されました。再読み込みしてください。',
            )
          }
          if (result.error) return databaseFailure(result.error)
          const page = parseAuthorizedWorkspacePage(
            result.data,
            normalizedWorkspaceId,
            effectivePageSize,
          )
          if (!page || (generation !== null && page.generation !== generation)) {
            return invalidResponse()
          }
          generation = page.generation

          for (const row of page.rows) {
            const record = parseCloudEventV2Record(row, normalizedWorkspaceId)
            // A V1 row or a malformed V2 row makes the ready Workspace load
            // fail closed; mixed snapshots are never silently filtered out.
            if (!record || seenIds.has(record.eventId)) return invalidSnapshot()
            seenIds.add(record.eventId)
            records.push(record)
          }

          if (page.nextCursor === null) {
            return { ok: true, value: { generation, records } }
          }
          const last = records.at(-1)
          if (
            !last ||
            last.eventId !== page.nextCursor ||
            page.nextCursor === cursor ||
            seenCursors.has(page.nextCursor)
          ) return invalidResponse()
          seenCursors.add(page.nextCursor)
          cursor = page.nextCursor
        }
      } catch {
        return databaseFailure({})
      }
    },

    async saveEvent(
      workspaceId,
      snapshot,
      expectedRevision,
      expectedGeneration,
    ) {
      const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
      const validatedSnapshot = parseCloudEventSnapshotV2(snapshot)
      if (
        !normalizedWorkspaceId ||
        !validatedSnapshot ||
        (expectedRevision !== null && !isPositiveSafeInteger(expectedRevision)) ||
        !isPostgresBigintGeneration(expectedGeneration)
      ) return errorResult('INVALID_ARGUMENT', 'V2保存引数が正しくありません。')

      try {
        const result = await gateway.saveValidatedSnapshot({
          workspaceId: normalizedWorkspaceId,
          snapshot: validatedSnapshot,
          expectedRevision,
          expectedGeneration,
        })
        if (result.error) return databaseFailure(result.error)
        const saved = parseSavedValue(
          result.data,
          normalizedWorkspaceId,
          validatedSnapshot,
          expectedRevision,
          expectedGeneration,
        )
        return saved ? { ok: true, value: saved } : invalidResponse()
      } catch {
        return databaseFailure({})
      }
    },
  }
}

const parseFunctionError = async (error: unknown): Promise<CloudEventV2DatabaseError> => {
  if (!isRecord(error)) return {}
  const context = error.context
  if (context && typeof (context as { json?: unknown }).json === 'function') {
    try {
      const payload: unknown = await (context as { json: () => Promise<unknown> }).json()
      if (
        isRecord(payload) && payload.status === 'error' &&
        isRecord(payload.error) && typeof payload.error.code === 'string'
      ) {
        return {
          code: payload.error.code,
          message: typeof payload.error.message === 'string'
            ? payload.error.message
            : undefined,
        }
      }
    } catch {
      return {}
    }
  }
  return error
}

export const createSupabaseCloudEventV2Gateway = (
  client: SupabaseClient,
): CloudEventV2DatabaseGateway => ({
  async loadAuthorizedWorkspacePage(
    workspaceId,
    afterEventId,
    limit,
    expectedGeneration,
  ) {
    const result = await client.rpc('load_cloud_events_page_authorized', {
      p_workspace_id: workspaceId,
      p_after_event_id: afterEventId,
      p_page_size: limit,
      p_expected_generation: expectedGeneration,
    })
    return { data: result.data, error: result.error }
  },
  async saveValidatedSnapshot(input) {
    const result = await client.functions.invoke('save-cloud-event-v2', {
      body: input,
    })
    if (result.error) {
      return { data: null, error: await parseFunctionError(result.error) }
    }
    return { data: result.data, error: null }
  },
})

export const createSupabaseCloudEventV2Repository = (
  client: SupabaseClient,
): CloudEventV2Repository => createCloudEventV2Repository(
  createSupabaseCloudEventV2Gateway(client),
)
