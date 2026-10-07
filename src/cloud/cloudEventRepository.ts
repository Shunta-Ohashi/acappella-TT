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

export type CloudEventRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'INVALID_SNAPSHOT'
  | 'SHARED_MASTER_CONFLICT'
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
  loadRow: (
    workspaceId: string,
    eventId: EventId,
  ) => Promise<CloudEventDatabaseResult<unknown>>
  saveRow: (input: {
    workspaceId: string
    eventId: EventId
    eventName: string
    snapshot: CloudEventSnapshotV1
  }) => Promise<CloudEventDatabaseResult<unknown>>
  deleteRow: (
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
  saveEvent: (
    workspaceId: string,
    snapshot: CloudEventSnapshotV1,
  ) => Promise<CloudEventRepositoryResult<CloudEventRecord>>
  deleteEvent: (
    workspaceId: string,
    eventId: EventId,
  ) => Promise<CloudEventRepositoryResult<CloudEventSummary>>
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

const invalidArgument = (message: string): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: { code: 'INVALID_ARGUMENT', message },
})

const databaseFailure = (
  error: CloudEventDatabaseError,
): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: error.code === '42501'
    ? { code: 'ACCESS_DENIED', message: 'ワークスペースのEventへアクセスできません。' }
    : { code: 'SUPABASE_ERROR', message: 'Cloud Eventの通信に失敗しました。' },
})

const invalidSnapshot = (): CloudEventRepositoryResult<never> => ({
  ok: false,
  error: { code: 'INVALID_SNAPSHOT', message: 'Cloud Eventのデータ形式が正しくありません。' },
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
): CloudEventRepository => ({
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
        eventId: event.id,
        eventName: event.name,
        snapshot: validatedSnapshot,
      })
      if (result.error) return databaseFailure(result.error)
      if (result.data === null) return notFound()
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
      const result = await gateway.deleteRow(workspaceId, eventId)
      if (result.error) return databaseFailure(result.error)
      if (result.data === null) return notFound()
      const summary = parseSummary(result.data)
      if (
        !summary ||
        summary.workspaceId !== workspaceId ||
        summary.eventId !== eventId
      ) return invalidSnapshot()
      return { ok: true, value: summary }
    } catch {
      return databaseFailure({})
    }
  },
})

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

  async loadRow(workspaceId, eventId) {
    const result = await client
      .from('cloud_events')
      .select(CLOUD_EVENT_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('event_id', eventId)
      .maybeSingle()
    return { data: result.data, error: result.error }
  },

  async saveRow({ workspaceId, eventId, eventName, snapshot }) {
    const result = await client
      .from('cloud_events')
      .upsert({
        workspace_id: workspaceId,
        event_id: eventId,
        event_name: eventName,
        event_snapshot: snapshot,
      }, { onConflict: 'workspace_id,event_id' })
      .select(CLOUD_EVENT_COLUMNS)
      .single()
    return { data: result.data, error: result.error }
  },

  async deleteRow(workspaceId, eventId) {
    const result = await client
      .from('cloud_events')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('event_id', eventId)
      .select(CLOUD_EVENT_LIST_COLUMNS)
      .maybeSingle()
    return { data: result.data, error: result.error }
  },
})

export const createSupabaseCloudEventRepository = (
  client: SupabaseClient,
): CloudEventRepository => createCloudEventRepository(
  createSupabaseCloudEventGateway(client),
)
