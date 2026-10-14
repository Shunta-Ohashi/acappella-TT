import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  arePersistedValuesEqual,
  parseCloudEventSnapshotV2,
  type CloudEventSnapshotV2,
} from './cloudEventSnapshot.ts'
import { isPostgresBigintGeneration } from './cloudGeneration.ts'

export const CLOUD_EVENT_V2_SAVE_MAX_REQUEST_BYTES = 5 * 1024 * 1024

export interface CloudEventV2SaveEndpointDatabaseError {
  code?: string
  message?: string
}

export interface CloudEventV2SaveEndpointDependencies {
  authenticate: (accessToken: string) => Promise<{ id: string } | undefined>
  saveValidatedSnapshot: (input: {
    actorId: string
    workspaceId: string
    snapshot: CloudEventSnapshotV2
    expectedRevision: number | null
    expectedGeneration: string
  }) => Promise<{
    data: unknown | null
    error: CloudEventV2SaveEndpointDatabaseError | null
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
  | 'ALREADY_EXISTS'
  | 'EVENT_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'WORKSPACE_SNAPSHOT_CHANGED'
  | 'WORKSPACE_NOT_READY'
  | 'MASTER_REFERENCE_INVALID'
  | 'SNAPSHOT_VERSION_CONFLICT'
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

const successResponse = (value: unknown): Response => new Response(
  JSON.stringify(value),
  { status: 200, headers: jsonHeaders },
)

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
      if (byteLength > CLOUD_EVENT_V2_SAVE_MAX_REQUEST_BYTES) {
        await reader.cancel()
        throw new RequestBodyTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const serialized = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    serialized.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(serialized)
}

const getBearerToken = (request: Request): string | undefined => {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/iu)
  return match?.[1]?.trim() || undefined
}

const hasJsonMediaType = (request: Request): boolean =>
  request.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === 'application/json'

const standardUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const normalizeWorkspaceId = (value: unknown): string | undefined =>
  typeof value === 'string' && standardUuidPattern.test(value)
    ? value.toLowerCase()
    : undefined

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Number.isFinite(Date.parse(value))

const isExpectedRevision = (value: unknown): value is number | null =>
  value === null || (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  )

const getEvent = (snapshot: CloudEventSnapshotV2) => snapshot.eventState.events[0]

const isNextGeneration = (before: string, after: string): boolean => {
  try {
    return BigInt(after) === BigInt(before) + 1n
  } catch {
    return false
  }
}

const isValidSavedValue = (
  value: unknown,
  workspaceId: string,
  snapshot: CloudEventSnapshotV2,
  expectedRevision: number | null,
  expectedGeneration: string,
): boolean => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.workspaceId !== workspaceId ||
    !isPostgresBigintGeneration(value.workspaceGeneration) ||
    !isRecord(value.record) ||
    Object.hasOwn(value, 'error')
  ) return false

  const event = getEvent(snapshot)
  const record = value.record
  const returnedSnapshot = parseCloudEventSnapshotV2(record.event_snapshot)
  const returnedEvent = returnedSnapshot?.eventState.events[0]
  const expectedSavedRevision = expectedRevision === null ? 1 : expectedRevision + 1
  return record.workspace_id === workspaceId &&
    record.event_id === event.id &&
    record.event_name === event.name &&
    returnedEvent?.id === event.id &&
    returnedEvent.name === event.name &&
    returnedSnapshot !== undefined &&
    arePersistedValuesEqual(returnedSnapshot, snapshot) &&
    record.revision === expectedSavedRevision &&
    isTimestamp(record.created_at) &&
    isTimestamp(record.updated_at) &&
    isNextGeneration(expectedGeneration, value.workspaceGeneration)
}

const getThrownCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined

const databaseErrorResponse = (
  error: CloudEventV2SaveEndpointDatabaseError,
): Response => {
  switch (error.code) {
    case '42501':
    case 'ACCESS_DENIED':
      return errorResponse(403, 'ACCESS_DENIED', 'Cloud Eventを変更する権限がありません。')
    case '23505':
    case 'ALREADY_EXISTS':
      return errorResponse(409, 'ALREADY_EXISTS', '同じIDのCloud Eventが既に存在します。')
    case 'P0002':
    case 'EVENT_NOT_FOUND':
      return errorResponse(409, 'EVENT_NOT_FOUND', '更新対象のCloud Eventが見つかりません。')
    case '40001':
    case 'REVISION_CONFLICT':
      return errorResponse(409, 'REVISION_CONFLICT', 'Cloud Eventが他の端末で更新されています。')
    case 'PVE04':
    case 'WORKSPACE_SNAPSHOT_CHANGED':
      return errorResponse(409, 'WORKSPACE_SNAPSHOT_CHANGED', 'Workspaceが更新されています。再読み込みしてください。')
    case '55000':
    case 'WORKSPACE_NOT_READY':
      return errorResponse(409, 'WORKSPACE_NOT_READY', 'WorkspaceはSnapshot V2保存の準備ができていません。')
    case 'PVE02':
    case 'MASTER_REFERENCE_INVALID':
      return errorResponse(409, 'MASTER_REFERENCE_INVALID', 'Workspace共通データの参照が一致しません。')
    case 'PVE01':
    case 'SNAPSHOT_VERSION_CONFLICT':
      return errorResponse(409, 'SNAPSHOT_VERSION_CONFLICT', 'Snapshot V1はV2保存APIから上書きできません。')
    case '22023':
    case 'INVALID_SNAPSHOT':
      return errorResponse(400, 'INVALID_SNAPSHOT', 'Cloud Event Snapshot V2の形式が正しくありません。')
    default:
      return errorResponse(502, 'SAVE_FAILED', 'Cloud Event Snapshot V2を保存できませんでした。')
  }
}

export const handleCloudEventV2SaveRequest = async (
  request: Request,
  dependencies: CloudEventV2SaveEndpointDependencies,
): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (request.method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'POSTのみ利用できます。')
  }
  if (!hasJsonMediaType(request)) {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON形式のrequestが必要です。')
  }

  const contentLength = request.headers.get('content-length')
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > CLOUD_EVENT_V2_SAVE_MAX_REQUEST_BYTES
  ) {
    return errorResponse(413, 'REQUEST_TOO_LARGE', 'Cloud Eventの保存データが大きすぎます。')
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
    body = JSON.parse(await readRequestText(request))
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? errorResponse(413, 'REQUEST_TOO_LARGE', 'Cloud Eventの保存データが大きすぎます。')
      : errorResponse(400, 'INVALID_REQUEST', 'JSON requestを読み取れませんでした。')
  }

  if (
    !isRecord(body) ||
    Object.keys(body).some(key => ![
      'workspaceId', 'snapshot', 'expectedRevision', 'expectedGeneration',
    ].includes(key))
  ) {
    return errorResponse(400, 'INVALID_REQUEST', '保存requestの形式が正しくありません。')
  }
  const workspaceId = normalizeWorkspaceId(body.workspaceId)
  const snapshot = parseCloudEventSnapshotV2(body.snapshot)
  if (!workspaceId || !isExpectedRevision(body.expectedRevision) ||
    !isPostgresBigintGeneration(body.expectedGeneration)) {
    return errorResponse(400, 'INVALID_REQUEST', 'Workspace、revision、generationが正しくありません。')
  }
  if (!snapshot) {
    return errorResponse(400, 'INVALID_SNAPSHOT', 'Cloud Event Snapshot V2の形式が正しくありません。')
  }

  try {
    const result = await dependencies.saveValidatedSnapshot({
      actorId: actor.id,
      workspaceId,
      snapshot,
      expectedRevision: body.expectedRevision,
      expectedGeneration: body.expectedGeneration,
    })
    if (result.error) return databaseErrorResponse(result.error)
    if (!isValidSavedValue(
      result.data,
      workspaceId,
      snapshot,
      body.expectedRevision,
      body.expectedGeneration,
    )) {
      return errorResponse(502, 'INVALID_RESPONSE', 'Cloud Eventの保存結果を確認できませんでした。')
    }
    return successResponse(result.data)
  } catch (error) {
    return getThrownCode(error) === 'CONFIGURATION_ERROR'
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Cloud保存のserver設定が不足しています。')
      : errorResponse(502, 'SAVE_FAILED', 'Cloud Event Snapshot V2を保存できませんでした。')
  }
}
