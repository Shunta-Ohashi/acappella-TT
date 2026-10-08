import {
  parseCloudEventSnapshot,
  type CloudEventSnapshotV1,
} from './cloudEventSnapshot.ts'
import { isRecord } from '../persistence/persistenceValidation.ts'

export const CLOUD_EVENT_SAVE_MAX_REQUEST_BYTES = 5 * 1024 * 1024

export interface CloudEventSaveEndpointDatabaseError {
  code?: string
  message?: string
}

export interface CloudEventSaveEndpointDependencies {
  authenticate: (accessToken: string) => Promise<{ id: string } | undefined>
  saveValidatedSnapshot: (input: {
    actorId: string
    workspaceId: string
    snapshot: CloudEventSnapshotV1
  }) => Promise<{
    data: unknown | null
    error: CloudEventSaveEndpointDatabaseError | null
  }>
}

type EndpointErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'REQUEST_TOO_LARGE'
  | 'INVALID_REQUEST'
  | 'INVALID_SNAPSHOT'
  | 'ACCESS_DENIED'
  | 'INVALID_RESPONSE'
  | 'CONFIGURATION_ERROR'
  | 'SAVE_FAILED'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
} as const

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
} as const

const errorResponse = (
  status: number,
  code: EndpointErrorCode,
  message: string,
): Response => new Response(JSON.stringify({
  status: 'error',
  error: { code, message },
}), { status, headers: jsonHeaders })

const successResponse = (record: unknown): Response => new Response(JSON.stringify({
  status: 'ok',
  record,
}), { status: 200, headers: jsonHeaders })

class RequestBodyTooLargeError extends Error {}

const readRequestText = async (request: Request): Promise<string> => {
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > CLOUD_EVENT_SAVE_MAX_REQUEST_BYTES) {
        throw new RequestBodyTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

const getBearerToken = (request: Request): string | undefined => {
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || undefined
}

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Number.isFinite(Date.parse(value))

const isValidSavedRecord = (
  value: unknown,
  workspaceId: string,
  snapshot: CloudEventSnapshotV1,
): boolean => {
  if (!isRecord(value)) return false
  const event = snapshot.appState.events[0]
  const returnedSnapshot = parseCloudEventSnapshot(value.event_snapshot)
  return value.workspace_id === workspaceId &&
    value.event_id === event.id &&
    value.event_name === event.name &&
    returnedSnapshot !== undefined &&
    returnedSnapshot.appState.events[0]?.id === event.id &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
}

const getThrownCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined

export const handleCloudEventSaveRequest = async (
  request: Request,
  dependencies: CloudEventSaveEndpointDependencies,
): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (request.method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'POSTのみ利用できます。')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON形式のrequestが必要です。')
  }

  const accessToken = getBearerToken(request)
  if (!accessToken) {
    return errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証が必要です。')
  }

  let actor: { id: string } | undefined
  try {
    actor = await dependencies.authenticate(accessToken)
  } catch (error) {
    return getThrownCode(error) === 'CONFIGURATION_ERROR'
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Cloud保存のserver設定が不足しています。')
      : errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証を確認できませんでした。')
  }
  if (!actor || actor.id.trim().length === 0) {
    return errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証を確認できませんでした。')
  }

  let body: unknown
  try {
    const serialized = await readRequestText(request)
    body = JSON.parse(serialized)
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? errorResponse(413, 'REQUEST_TOO_LARGE', 'Cloud Eventの保存データが大きすぎます。')
      : errorResponse(400, 'INVALID_REQUEST', 'JSON requestを読み取れませんでした。')
  }

  if (!isRecord(body) ||
    typeof body.workspaceId !== 'string' ||
    body.workspaceId.trim().length === 0) {
    return errorResponse(400, 'INVALID_REQUEST', 'Workspace IDが必要です。')
  }
  const snapshot = parseCloudEventSnapshot(body.snapshot)
  if (!snapshot) {
    return errorResponse(400, 'INVALID_SNAPSHOT', 'Cloud Eventのデータ形式が正しくありません。')
  }

  try {
    const result = await dependencies.saveValidatedSnapshot({
      actorId: actor.id,
      workspaceId: body.workspaceId,
      snapshot,
    })
    if (result.error) {
      if (result.error.code === '42501' || result.error.code === 'ACCESS_DENIED') {
        return errorResponse(403, 'ACCESS_DENIED', 'Cloud Eventを変更する権限がありません。')
      }
      return errorResponse(502, 'SAVE_FAILED', 'Cloud Eventを保存できませんでした。')
    }
    if (!isValidSavedRecord(result.data, body.workspaceId, snapshot)) {
      return errorResponse(502, 'INVALID_RESPONSE', 'Cloud Eventの保存結果を確認できませんでした。')
    }
    return successResponse(result.data)
  } catch (error) {
    return getThrownCode(error) === 'CONFIGURATION_ERROR'
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Cloud保存のserver設定が不足しています。')
      : errorResponse(502, 'SAVE_FAILED', 'Cloud Eventを保存できませんでした。')
  }
}
