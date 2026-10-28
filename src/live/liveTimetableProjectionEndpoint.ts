import { isRecord } from '../persistence/persistenceValidation.ts'
import { parseCloudEventSnapshot } from '../cloud/cloudEventSnapshot.ts'
import { isPostgresBigintGeneration } from '../cloud/cloudGeneration.ts'
import { parseLiveTimetableSourceRevision } from './liveTimetableSourceRevision.ts'
import {
  createLiveTimetableProjection,
  type LiveTimetableProjection,
} from './liveTimetableProjection.ts'

export const LIVE_TIMETABLE_PROJECTION_MAX_REQUEST_BYTES = 64 * 1024

export interface LiveTimetableProjectionDatabaseError {
  code?: string
  message?: string
}

export interface LiveTimetableProjectionEndpointDependencies {
  authenticate: (accessToken: string) => Promise<{ id: string } | undefined>
  loadProjectionSource: (input: {
    actorId: string
    workspaceId: string
    eventId: string
    expectedSourceRevision: string
  }) => Promise<{
    data: unknown | null
    error: LiveTimetableProjectionDatabaseError | null
  }>
  persistProjection: (input: {
    actorId: string
    workspaceId: string
    eventId: string
    expectedSourceRevision: string
    sourceSnapshotFingerprint: string
    projection: LiveTimetableProjection
    mode: 'create' | 'replace'
    expectedManagementRevision: string | null
  }) => Promise<{
    data: unknown | null
    error: LiveTimetableProjectionDatabaseError | null
  }>
}

type EndpointErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'REQUEST_TOO_LARGE'
  | 'INVALID_REQUEST'
  | 'INVALID_SOURCE'
  | 'ACCESS_DENIED'
  | 'EVENT_NOT_FOUND'
  | 'LIVE_ALREADY_EXISTS'
  | 'LIVE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'PROJECTION_REPLACEMENT_FORBIDDEN'
  | 'CONFIGURATION_ERROR'
  | 'INVALID_RESPONSE'
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
      if (byteLength > LIVE_TIMETABLE_PROJECTION_MAX_REQUEST_BYTES) {
        await reader.cancel()
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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const fingerprintPattern = /^[0-9a-f]{64}$/u

const normalizeUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && uuidPattern.test(value)
    ? value.toLowerCase()
    : undefined

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const allowed = new Set(keys)
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => allowed.has(key))
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

const getThrownCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined

const databaseErrorResponse = (
  error: LiveTimetableProjectionDatabaseError,
  phase: 'source' | 'persist',
): Response => {
  switch (error.code) {
    case '42501':
    case 'ACCESS_DENIED':
      return errorResponse(403, 'ACCESS_DENIED', 'Live TTを管理する権限がありません。')
    case 'P0002':
    case 'EVENT_NOT_FOUND':
      return errorResponse(409, 'EVENT_NOT_FOUND', '元のCloud Eventが見つかりません。')
    case '23505':
    case 'LIVE_ALREADY_EXISTS':
      return errorResponse(409, 'LIVE_ALREADY_EXISTS', 'このEventのLive TTは既に存在します。')
    case 'P0003':
    case 'LIVE_NOT_FOUND':
      return errorResponse(409, 'LIVE_NOT_FOUND', 'Live TTが見つかりません。')
    case '40001':
    case 'REVISION_CONFLICT':
      return errorResponse(409, 'REVISION_CONFLICT', '元EventまたはLive TTが更新されています。')
    case 'PROJECTION_REPLACEMENT_FORBIDDEN':
      return errorResponse(409, 'PROJECTION_REPLACEMENT_FORBIDDEN', '進行開始後または公開中の投影は差し替えできません。')
    case '55000':
      return phase === 'source'
        ? errorResponse(400, 'INVALID_SOURCE', '投影元のCloud Eventを検証できません。')
        : errorResponse(409, 'PROJECTION_REPLACEMENT_FORBIDDEN', '進行開始後または公開中の投影は差し替えできません。')
    case '22023':
    case 'INVALID_SOURCE':
      return errorResponse(400, 'INVALID_SOURCE', '投影元のCloud Eventを検証できません。')
    default:
      return errorResponse(502, 'SAVE_FAILED', 'Live TT投影を保存できませんでした。')
  }
}

interface ProjectionRequest {
  workspaceId: string
  eventId: string
  expectedSourceRevision: string
  mode: 'create' | 'replace'
  expectedManagementRevision: string | null
}

const parseRequest = (value: unknown): ProjectionRequest | undefined => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => ![
      'workspaceId',
      'eventId',
      'expectedSourceRevision',
      'mode',
      'expectedManagementRevision',
    ].includes(key))
  ) return undefined

  const workspaceId = normalizeUuid(value.workspaceId)
  const expectedSourceRevision = parseLiveTimetableSourceRevision(
    value.expectedSourceRevision,
  )
  if (
    !workspaceId ||
    !isNonEmptyString(value.eventId) ||
    !expectedSourceRevision ||
    (value.mode !== 'create' && value.mode !== 'replace') ||
    (value.mode === 'create' && value.expectedManagementRevision !== null) ||
    (value.mode === 'replace' &&
      (!isPostgresBigintGeneration(value.expectedManagementRevision) ||
        value.expectedManagementRevision === '0'))
  ) return undefined

  return {
    workspaceId,
    eventId: value.eventId,
    expectedSourceRevision,
    mode: value.mode,
    expectedManagementRevision: value.expectedManagementRevision as string | null,
  }
}

const parseSource = (
  value: unknown,
  request: ProjectionRequest,
): { snapshot: unknown; fingerprint: string } | undefined => {
  const sourceRevision = isRecord(value)
    ? parseLiveTimetableSourceRevision(value.revision)
    : undefined
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'status', 'workspace_id', 'event_id', 'event_name',
      'event_snapshot', 'revision', 'snapshot_fingerprint',
    ]) ||
    value.status !== 'ok' ||
    value.workspace_id !== request.workspaceId ||
    value.event_id !== request.eventId ||
    !isNonEmptyString(value.event_name) ||
    sourceRevision !== request.expectedSourceRevision ||
    typeof value.snapshot_fingerprint !== 'string' ||
    !fingerprintPattern.test(value.snapshot_fingerprint)
  ) return undefined
  const snapshot = parseCloudEventSnapshot(value.event_snapshot)
  if (!snapshot || snapshot.appState.events[0]?.id !== value.event_id ||
    snapshot.appState.events[0]?.name !== value.event_name) return undefined
  return {
    snapshot,
    fingerprint: value.snapshot_fingerprint,
  }
}

const parseMutationResponse = (
  value: unknown,
  request: ProjectionRequest,
  fingerprint: string,
): Record<string, unknown> | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'status', 'workspaceId', 'eventId', 'liveId', 'publicId',
    'sourceRevision', 'sourceSnapshotFingerprint', 'projectionVersion',
    'managementRevision', 'isPublished',
  ])) return undefined
  const expectedStatus = request.mode === 'create' ? 'created' : 'replaced'
  const sourceRevision = parseLiveTimetableSourceRevision(value.sourceRevision)
  return value.status === expectedStatus &&
    value.workspaceId === request.workspaceId &&
    value.eventId === request.eventId &&
    normalizeUuid(value.liveId) !== undefined &&
    normalizeUuid(value.publicId) !== undefined &&
    sourceRevision === request.expectedSourceRevision &&
    value.sourceSnapshotFingerprint === fingerprint &&
    isPostgresBigintGeneration(value.projectionVersion) &&
    value.projectionVersion !== '0' &&
    isPostgresBigintGeneration(value.managementRevision) &&
    value.managementRevision !== '0' &&
    value.isPublished === false
    ? { ...value, sourceRevision }
    : undefined
}

export const handleLiveTimetableProjectionRequest = async (
  request: Request,
  dependencies: LiveTimetableProjectionEndpointDependencies,
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
    Number(contentLength) > LIVE_TIMETABLE_PROJECTION_MAX_REQUEST_BYTES
  ) {
    return errorResponse(413, 'REQUEST_TOO_LARGE', 'requestが大きすぎます。')
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
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Live TTのserver設定が不足しています。')
      : errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証を確認できませんでした。')
  }
  if (!actor || normalizeUuid(actor.id) === undefined) {
    return errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証を確認できませんでした。')
  }

  let body: unknown
  try {
    body = JSON.parse(await readRequestText(request))
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? errorResponse(413, 'REQUEST_TOO_LARGE', 'requestが大きすぎます。')
      : errorResponse(400, 'INVALID_REQUEST', 'JSON requestを読み取れませんでした。')
  }
  const parsedRequest = parseRequest(body)
  if (!parsedRequest) {
    return errorResponse(400, 'INVALID_REQUEST', '投影作成requestの形式が正しくありません。')
  }

  try {
    const sourceResult = await dependencies.loadProjectionSource({
      actorId: actor.id,
      workspaceId: parsedRequest.workspaceId,
      eventId: parsedRequest.eventId,
      expectedSourceRevision: parsedRequest.expectedSourceRevision,
    })
    if (sourceResult.error) {
      return databaseErrorResponse(sourceResult.error, 'source')
    }
    const source = parseSource(sourceResult.data, parsedRequest)
    if (!source) {
      return errorResponse(502, 'INVALID_RESPONSE', '投影元の応答を検証できませんでした。')
    }

    const projected = createLiveTimetableProjection(source.snapshot)
    if (!projected.ok) {
      return errorResponse(409, 'INVALID_SOURCE', '投影元のCloud EventをLive TTへ変換できません。')
    }

    const persisted = await dependencies.persistProjection({
      actorId: actor.id,
      workspaceId: parsedRequest.workspaceId,
      eventId: parsedRequest.eventId,
      expectedSourceRevision: parsedRequest.expectedSourceRevision,
      sourceSnapshotFingerprint: source.fingerprint,
      projection: projected.projection,
      mode: parsedRequest.mode,
      expectedManagementRevision: parsedRequest.expectedManagementRevision,
    })
    if (persisted.error) {
      return databaseErrorResponse(persisted.error, 'persist')
    }
    const mutationResponse = parseMutationResponse(
      persisted.data,
      parsedRequest,
      source.fingerprint,
    )
    if (!mutationResponse) {
      return errorResponse(502, 'INVALID_RESPONSE', 'Live TT投影の保存結果を検証できませんでした。')
    }
    return successResponse(mutationResponse)
  } catch (error) {
    return getThrownCode(error) === 'CONFIGURATION_ERROR'
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Live TTのserver設定が不足しています。')
      : errorResponse(502, 'SAVE_FAILED', 'Live TT投影を保存できませんでした。')
  }
}
