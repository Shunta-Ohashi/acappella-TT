import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventId } from '../domain/models.ts'
import {
  parseCloudEventSnapshot,
  type CloudEventSnapshotV1,
} from './cloudEventSnapshot.ts'

const CLOUD_EVENT_COLUMNS =
  'workspace_id, event_id, event_name, event_snapshot, revision, created_at, updated_at'
const CLOUD_EVENT_LIST_COLUMNS =
  'workspace_id, event_id, event_name, revision, created_at, updated_at'

export const CLOUD_EVENT_WORKSPACE_PAGE_SIZE = 100

export interface CloudEventSummary {
  workspaceId: string
  eventId: EventId
  eventName: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface CloudEventRecord extends CloudEventSummary {
  snapshot: CloudEventSnapshotV1
}

export type CloudEventDeletionStatus = 'deleted' | 'already_absent'

export interface CloudEventDeletionConfirmation {
  status: CloudEventDeletionStatus
  workspaceId: string
  eventId: EventId
}

export type CloudEventRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_RESPONSE'
  | 'SHARED_MASTER_CONFLICT'
  | 'CONFIGURATION_ERROR'
  | 'SUPABASE_ERROR'
  | 'INVALID_ARGUMENT'

export interface CloudEventRepositoryError {
  code: CloudEventRepositoryErrorCode
  message: string
}

export type CloudEventRepositoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudEventRepositoryError }

export interface CloudEventDatabaseError {
  code?: string
  message?: string
}

export interface CloudEventDatabaseResult<T> {
  data: T | null
  error: CloudEventDatabaseError | null
}

export interface CloudEventDatabaseGateway {
  getWorkspaceRole: (
    workspaceId: string,
  ) => Promise<CloudEventDatabaseResult<unknown>>
  listRows: (workspaceId: string) => Promise<CloudEventDatabaseResult<unknown[]>>
  loadAuthorizedWorkspacePage: (
    workspaceId: string,
    afterEventId: EventId | null,
    limit: number,
  ) => Promise<CloudEventDatabaseResult<unknown>>
  loadRow: (
    workspaceId: string,
    eventId: EventId,
  ) => Promise<CloudEventDatabaseResult<unknown>>
  saveRow: (input: {
    workspaceId: string
    snapshot: CloudEventSnapshotV1
  }) => Promise<CloudEventDatabaseResult<unknown>>
  deleteAuthorizedEvent: (
    workspaceId: string,
    eventId: EventId,
  ) => Promise<CloudEventDatabaseResult<unknown>>
}

export interface CloudEventRepository {
  listEvents: (
    workspaceId: string,
  ) => Promise<CloudEventRepositoryResult<CloudEventSummary[]>>
  loadEvent: (
    workspaceId: string,
    eventId: EventId,
  ) => Promise<CloudEventRepositoryResult<CloudEventRecord>>
  loadWorkspaceEvents: (
    workspaceId: string,
  ) => Promise<CloudEventRepositoryResult<CloudEventRecord[]>>
  saveEvent: (
    workspaceId: string,
    snapshot: CloudEventSnapshotV1,
  ) => Promise<CloudEventRepositoryResult<CloudEventRecord>>
  deleteEvent: (
    workspaceId: string,
    eventId: EventId,
  ) => Promise<CloudEventRepositoryResult<CloudEventDeletionConfirmation>>
}

export interface CloudEventRepositoryOptions {
  workspacePageSize?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value))

const parseSummary = (value: unknown): CloudEventSummary | undefined => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.workspace_id) ||
    !isNonEmptyString(value.event_id) ||
    !isNonEmptyString(value.event_name) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) <= 0 ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) return undefined

  return {
    workspaceId: value.workspace_id,
    eventId: value.event_id,
    eventName: value.event_name,
    revision: Number(value.revision),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

const parseRecord = (value: unknown): CloudEventRecord | undefined => {
  const summary = parseSummary(value)
  if (!summary || !isRecord(value)) return undefined
  const snapshot = parseCloudEventSnapshot(value.event_snapshot)
  const event = snapshot?.appState.events[0]
  if (
    !snapshot ||
    event?.id !== summary.eventId ||
    event.name !== summary.eventName
  ) return undefined
  return { ...summary, snapshot }
}

const parseDeletionConfirmation = (
  value: unknown,
  workspaceId: string,
  eventId: EventId,
): CloudEventDeletionConfirmation | undefined => {
  if (
    !isRecord(value) ||
    (value.status !== 'deleted' && value.status !== 'already_absent') ||
    !isNonEmptyString(value.workspace_id) ||
    !isNonEmptyString(value.event_id) ||
    value.workspace_id !== workspaceId ||
    value.event_id !== eventId
  ) return undefined

  return {
    status: value.status as CloudEventDeletionStatus,
    workspaceId: value.workspace_id,
    eventId: value.event_id,
  }
}

interface AuthorizedWorkspacePage {
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
    !Array.isArray(value.rows) ||
    !('next_cursor' in value) ||
    ('error' in value) ||
    value.rows.length > pageSize ||
    (value.next_cursor !== null && !isNonEmptyString(value.next_cursor))
  ) return undefined

  const nextCursor = value.next_cursor as EventId | null
  if (
    (value.rows.length === 0 && nextCursor !== null) ||
    (nextCursor !== null && value.rows.length !== pageSize)
  ) return undefined

  return { rows: value.rows, nextCursor }
}

const invalidArgument = (message: string): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: { code: 'INVALID_ARGUMENT', message },
})

const databaseFailure = (
  error: CloudEventDatabaseError,
): CloudEventRepositoryResult<never> => {
  if (
    error.code === '42501' ||
    error.code === 'ACCESS_DENIED' ||
    error.code === 'AUTHENTICATION_REQUIRED'
  ) {
    return {
      ok: false,
      error: { code: 'ACCESS_DENIED', message: 'ワークスペースのEventへアクセスできません。' },
    }
  }
  if (error.code === 'INVALID_SNAPSHOT') return invalidSnapshot()
  if (error.code === 'INVALID_RESPONSE') return invalidResponse()
  if (error.code === 'CONFIGURATION_ERROR') {
    return {
      ok: false,
      error: {
        code: 'CONFIGURATION_ERROR',
        message: 'Cloud Eventの保存機能が設定されていません。',
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'SUPABASE_ERROR',
      message: 'Cloud Eventの通信に失敗しました。',
    },
  }
}

const invalidSnapshot = (): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: { code: 'INVALID_SNAPSHOT', message: 'Cloud Eventのデータ形式が正しくありません。' },
})

const invalidResponse = (): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: { code: 'INVALID_RESPONSE', message: 'Cloud Eventの応答を確認できませんでした。' },
})

const notFound = (): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: { code: 'NOT_FOUND', message: 'Cloud Eventが見つかりません。' },
})

const hasValidScope = (value: unknown): value is string => isNonEmptyString(value)

const requireWorkspaceAccess = async (
  gateway: CloudEventDatabaseGateway,
  workspaceId: string,
  mode: 'read' | 'write',
): Promise<CloudEventRepositoryResult<true>> => {
  try {
    const result = await gateway.getWorkspaceRole(workspaceId)
    if (result.error) return databaseFailure(result.error)
    if (!isRecord(result.data) || !isNonEmptyString(result.data.role)) {
      return {
        ok: false,
        error: { code: 'ACCESS_DENIED', message: 'ワークスペースへアクセスできません。' },
      }
    }
    if (
      !['owner', 'editor', 'viewer'].includes(result.data.role) ||
      (mode === 'write' && result.data.role === 'viewer')
    ) {
      return {
        ok: false,
        error: { code: 'ACCESS_DENIED', message: 'Cloud Eventを変更する権限がありません。' },
      }
    }
    return { ok: true, value: true }
  } catch {
    return databaseFailure({})
  }
}

export const createCloudEventRepository = (
  gateway: CloudEventDatabaseGateway,
  options: CloudEventRepositoryOptions = {},
): CloudEventRepository => {
  const workspacePageSize = Number.isSafeInteger(options.workspacePageSize) &&
    Number(options.workspacePageSize) > 0 &&
    Number(options.workspacePageSize) <= CLOUD_EVENT_WORKSPACE_PAGE_SIZE
    ? Number(options.workspacePageSize)
    : CLOUD_EVENT_WORKSPACE_PAGE_SIZE

  return ({
  async listEvents(workspaceId) {
    if (!hasValidScope(workspaceId)) return invalidArgument('Workspace IDが必要です。')
    const access = await requireWorkspaceAccess(gateway, workspaceId, 'read')
    if (!access.ok) return access
    try {
      const result = await gateway.listRows(workspaceId)
      if (result.error) return databaseFailure(result.error)
      if (!Array.isArray(result.data)) return invalidSnapshot()
      const summaries = result.data.map(parseSummary)
      if (summaries.some(summary => !summary)) return invalidSnapshot()
      const validSummaries = summaries.filter(summary => summary !== undefined)
      if (validSummaries.some(summary => summary.workspaceId !== workspaceId)) {
        return invalidSnapshot()
      }
      return {
        ok: true,
        value: [...validSummaries].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.eventId.localeCompare(right.eventId)),
      }
    } catch {
      return databaseFailure({})
    }
  },

  async loadEvent(workspaceId, eventId) {
    if (!hasValidScope(workspaceId) || !hasValidScope(eventId)) {
      return invalidArgument('Workspace IDとEvent IDが必要です。')
    }
    const access = await requireWorkspaceAccess(gateway, workspaceId, 'read')
    if (!access.ok) return access
    try {
      const result = await gateway.loadRow(workspaceId, eventId)
      if (result.error) return databaseFailure(result.error)
      if (result.data === null) return notFound()
      const record = parseRecord(result.data)
      if (
        !record ||
        record.workspaceId !== workspaceId ||
        record.eventId !== eventId
      ) return invalidSnapshot()
      return { ok: true, value: record }
    } catch {
      return databaseFailure({})
    }
  },

  async loadWorkspaceEvents(workspaceId) {
    if (!hasValidScope(workspaceId)) return invalidArgument('Workspace IDが必要です。')

    const records: CloudEventRecord[] = []
    const seenEventIds = new Set<EventId>()
    const requestedCursors = new Set<EventId>()
    let afterEventId: EventId | null = null

    try {
      while (true) {
        const result = await gateway.loadAuthorizedWorkspacePage(
          workspaceId,
          afterEventId,
          workspacePageSize,
        )
        if (result.error) return databaseFailure(result.error)
        const page = parseAuthorizedWorkspacePage(
          result.data,
          workspaceId,
          workspacePageSize,
        )
        if (!page) return invalidResponse()

        // The authorized RPC owns the C-collated keyset order. Do not re-sort
        // or compare Unicode IDs with JavaScript locale/UTF-16 semantics here.
        const pageRecords = page.rows.map(parseRecord)
        if (pageRecords.some(record => !record)) return invalidSnapshot()

        for (const record of pageRecords) {
          if (
            !record ||
            record.workspaceId !== workspaceId ||
            seenEventIds.has(record.eventId)
          ) return invalidSnapshot()

          seenEventIds.add(record.eventId)
          records.push(record)
        }

        if (page.nextCursor === null) return { ok: true, value: records }

        const lastRecord = pageRecords.at(-1)
        if (
          !lastRecord ||
          page.nextCursor !== lastRecord.eventId ||
          page.nextCursor === afterEventId ||
          requestedCursors.has(page.nextCursor)
        ) {
          return invalidResponse()
        }
        requestedCursors.add(page.nextCursor)
        afterEventId = page.nextCursor
      }
    } catch {
      return databaseFailure({})
    }
  },

  async saveEvent(workspaceId, snapshot) {
    if (!hasValidScope(workspaceId)) {
      return invalidArgument('Workspace IDが必要です。')
    }
    const validatedSnapshot = parseCloudEventSnapshot(snapshot)
    if (!validatedSnapshot) return invalidSnapshot()
    const event = validatedSnapshot.appState.events[0]
    const access = await requireWorkspaceAccess(gateway, workspaceId, 'write')
    if (!access.ok) return access
    try {
      const result = await gateway.saveRow({
        workspaceId,
        snapshot: validatedSnapshot,
      })
      if (result.error) return databaseFailure(result.error)
      if (result.data === null) return invalidResponse()
      const record = parseRecord(result.data)
      if (
        !record ||
        record.workspaceId !== workspaceId ||
        record.eventId !== event.id
      ) return invalidSnapshot()
      return { ok: true, value: record }
    } catch {
      return databaseFailure({})
    }
  },

  async deleteEvent(workspaceId, eventId) {
    if (!hasValidScope(workspaceId) || !hasValidScope(eventId)) {
      return invalidArgument('Workspace IDとEvent IDが必要です。')
    }
    const access = await requireWorkspaceAccess(gateway, workspaceId, 'write')
    if (!access.ok) return access
    try {
      const result = await gateway.deleteAuthorizedEvent(workspaceId, eventId)
      if (result.error) return databaseFailure(result.error)
      const confirmation = parseDeletionConfirmation(
        result.data,
        workspaceId,
        eventId,
      )
      return confirmation
        ? { ok: true, value: confirmation }
        : invalidResponse()
    } catch {
      return databaseFailure({})
    }
  },
  })
}

export const createSupabaseCloudEventGateway = (
  client: SupabaseClient,
): CloudEventDatabaseGateway => ({
  async getWorkspaceRole(workspaceId) {
    const result = await client
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return { data: result.data, error: result.error }
  },

  async listRows(workspaceId) {
    const result = await client
      .from('cloud_events')
      .select(CLOUD_EVENT_LIST_COLUMNS)
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .order('event_id', { ascending: true })
    return { data: result.data, error: result.error }
  },

  async loadAuthorizedWorkspacePage(workspaceId, afterEventId, limit) {
    const result = await client.rpc('load_cloud_events_page_authorized', {
      p_workspace_id: workspaceId,
      p_after_event_id: afterEventId,
      p_page_size: limit,
    })
    return { data: result.data, error: result.error }
  },

  async loadRow(workspaceId, eventId) {
    const result = await client
      .from('cloud_events')
      .select(CLOUD_EVENT_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('event_id', eventId)
      .maybeSingle()
    return { data: result.data, error: result.error }
  },

  async saveRow({ workspaceId, snapshot }) {
    const result = await client.functions.invoke('save-cloud-event', {
      body: { workspaceId, snapshot },
    })
    if (result.error) {
      let endpointError: CloudEventDatabaseError | undefined
      const context = isRecord(result.error) ? result.error.context : undefined
      if (context && typeof (context as { json?: unknown }).json === 'function') {
        try {
          const payload: unknown = await (context as { json: () => Promise<unknown> }).json()
          if (
            isRecord(payload) &&
            payload.status === 'error' &&
            isRecord(payload.error) &&
            typeof payload.error.code === 'string'
          ) {
            endpointError = {
              code: payload.error.code,
              message: typeof payload.error.message === 'string'
                ? payload.error.message
                : undefined,
            }
          }
        } catch {
          // A non-JSON Functions error is a transport/endpoint failure.
        }
      }
      return { data: null, error: endpointError ?? result.error }
    }
    if (
      !isRecord(result.data) ||
      result.data.status !== 'ok' ||
      !('record' in result.data)
    ) {
      return { data: null, error: { code: 'INVALID_RESPONSE' } }
    }
    return { data: result.data.record, error: null }
  },

  async deleteAuthorizedEvent(workspaceId, eventId) {
    const result = await client
      .rpc('delete_cloud_event_authorized', {
        p_workspace_id: workspaceId,
        p_event_id: eventId,
      })
    return { data: result.data, error: result.error }
  },
})

export const createSupabaseCloudEventRepository = (
  client: SupabaseClient,
): CloudEventRepository => createCloudEventRepository(
  createSupabaseCloudEventGateway(client),
)
