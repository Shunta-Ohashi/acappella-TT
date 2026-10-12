import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  isValidCloudWorkspaceBand,
  isValidCloudWorkspaceMember,
  parseCloudWorkspaceMasterMutationValue,
  type CloudWorkspaceMasterDatabaseError,
  type CloudWorkspaceMasterMutation,
} from './cloudWorkspaceMasterRepository.ts'

export const CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES = 1024 * 1024

export interface CloudWorkspaceMasterEndpointDependencies {
  authenticate: (accessToken: string) => Promise<{ id: string } | undefined>
  mutateValidatedMaster: (input: {
    actorId: string
    workspaceId: string
    mutation: CloudWorkspaceMasterMutation
  }) => Promise<{
    data: unknown | null
    error: CloudWorkspaceMasterDatabaseError | null
  }>
}

type EndpointErrorCode =
  | 'ACCESS_DENIED'
  | 'ALREADY_EXISTS'
  | 'AUTHENTICATION_REQUIRED'
  | 'CONFIGURATION_ERROR'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'MASTER_MEMBER_NOT_FOUND'
  | 'MASTER_NOT_FOUND'
  | 'MASTER_REFERENCED'
  | 'METHOD_NOT_ALLOWED'
  | 'REQUEST_TOO_LARGE'
  | 'REVISION_CONFLICT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UPDATE_FAILED'
  | 'WORKSPACE_NOT_READY'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonResponse = (status: number, body: unknown): Response => new Response(
  JSON.stringify(body),
  {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  },
)

const errorResponse = (
  status: number,
  code: EndpointErrorCode,
  message: string,
): Response => jsonResponse(status, { status: 'error', error: { code, message } })

const getBearerToken = (request: Request): string | undefined => {
  const authorization = request.headers.get('authorization')
  if (!authorization) return undefined
  const match = /^Bearer\s+(.+)$/iu.exec(authorization)
  return match?.[1]?.trim() || undefined
}

class RequestBodyTooLargeError extends Error {}

const readRequestText = async (request: Request): Promise<string> => {
  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES
  ) {
    if (request.body) await request.body.cancel().catch(() => undefined)
    throw new RequestBodyTooLargeError()
  }

  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
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

const isPositiveRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const standardUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean => Object.keys(value).every(key => allowedKeys.includes(key))

export const parseCloudWorkspaceMasterMutationRequest = (
  value: unknown,
): { workspaceId: string; mutation: CloudWorkspaceMasterMutation } | undefined => {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== 'string' ||
    !standardUuidPattern.test(value.workspaceId) ||
    typeof value.operation !== 'string'
  ) return undefined

  switch (value.operation) {
    case 'create-member':
      return hasOnlyKeys(value, ['workspaceId', 'operation', 'member']) &&
        isValidCloudWorkspaceMember(value.member)
        ? {
            workspaceId: value.workspaceId.toLowerCase(),
            mutation: { operation: value.operation, member: value.member },
          }
        : undefined
    case 'update-member':
      return hasOnlyKeys(value, [
        'workspaceId', 'operation', 'member', 'expectedRevision',
      ]) && isValidCloudWorkspaceMember(value.member) &&
        isPositiveRevision(value.expectedRevision)
        ? {
            workspaceId: value.workspaceId.toLowerCase(),
            mutation: {
              operation: value.operation,
              member: value.member,
              expectedRevision: value.expectedRevision,
            },
          }
        : undefined
    case 'delete-member':
      return hasOnlyKeys(value, [
        'workspaceId', 'operation', 'memberId', 'expectedRevision',
      ]) && typeof value.memberId === 'string' && value.memberId.trim().length > 0 &&
        isPositiveRevision(value.expectedRevision)
        ? {
            workspaceId: value.workspaceId.toLowerCase(),
            mutation: {
              operation: value.operation,
              memberId: value.memberId,
              expectedRevision: value.expectedRevision,
            },
          }
        : undefined
    case 'create-band':
      return hasOnlyKeys(value, ['workspaceId', 'operation', 'band']) &&
        isValidCloudWorkspaceBand(value.band)
        ? {
            workspaceId: value.workspaceId.toLowerCase(),
            mutation: { operation: value.operation, band: value.band },
          }
        : undefined
    case 'update-band':
      return hasOnlyKeys(value, [
        'workspaceId', 'operation', 'band', 'expectedRevision',
      ]) && isValidCloudWorkspaceBand(value.band) &&
        isPositiveRevision(value.expectedRevision)
        ? {
            workspaceId: value.workspaceId.toLowerCase(),
            mutation: {
              operation: value.operation,
              band: value.band,
              expectedRevision: value.expectedRevision,
            },
          }
        : undefined
    case 'delete-band':
      return hasOnlyKeys(value, [
        'workspaceId', 'operation', 'bandId', 'expectedRevision',
      ]) && typeof value.bandId === 'string' && value.bandId.trim().length > 0 &&
        isPositiveRevision(value.expectedRevision)
        ? {
            workspaceId: value.workspaceId.toLowerCase(),
            mutation: {
              operation: value.operation,
              bandId: value.bandId,
              expectedRevision: value.expectedRevision,
            },
          }
        : undefined
    default:
      return undefined
  }
}

const getThrownCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined

const databaseErrorResponse = (error: CloudWorkspaceMasterDatabaseError): Response => {
  switch (error.code) {
    case '42501':
    case 'ACCESS_DENIED':
      return errorResponse(403, 'ACCESS_DENIED', 'Workspace共通データを変更する権限がありません。')
    case '40001':
    case 'REVISION_CONFLICT':
      return errorResponse(409, 'REVISION_CONFLICT', '他の端末で更新されています。')
    case '23505':
    case 'ALREADY_EXISTS':
      return errorResponse(409, 'ALREADY_EXISTS', '同じIDの共通データが既に存在します。')
    case '23503':
    case 'MASTER_REFERENCED':
      return errorResponse(409, 'MASTER_REFERENCED', '参照中の共通データは削除できません。')
    case 'PMA01':
    case 'MASTER_MEMBER_NOT_FOUND':
      return errorResponse(
        409,
        'MASTER_MEMBER_NOT_FOUND',
        '指定されたバンドメンバーが見つかりません。',
      )
    case 'P0002':
    case 'MASTER_NOT_FOUND':
      return errorResponse(404, 'MASTER_NOT_FOUND', 'Workspace共通データが見つかりません。')
    case '55000':
    case 'WORKSPACE_NOT_READY':
      return errorResponse(409, 'WORKSPACE_NOT_READY', 'Workspace共通データはまだ利用できません。')
    case '22023':
    case 'INVALID_ARGUMENT':
      return errorResponse(400, 'INVALID_REQUEST', 'Workspace共通データの入力が正しくありません。')
    default:
      return errorResponse(502, 'UPDATE_FAILED', 'Workspace共通データを更新できませんでした。')
  }
}

export const handleCloudWorkspaceMasterRequest = async (
  request: Request,
  dependencies: CloudWorkspaceMasterEndpointDependencies,
): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'POST requestが必要です。')
  }
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON requestが必要です。')
  }
  const token = getBearerToken(request)
  if (!token) {
    return errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証が必要です。')
  }

  let actor: { id: string } | undefined
  try {
    actor = await dependencies.authenticate(token)
  } catch (error) {
    return getThrownCode(error) === 'CONFIGURATION_ERROR'
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Cloud共通データのserver設定が不足しています。')
      : errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証を確認できませんでした。')
  }
  if (!actor || actor.id.trim().length === 0) {
    return errorResponse(401, 'AUTHENTICATION_REQUIRED', '認証を確認できませんでした。')
  }

  let parsed: ReturnType<typeof parseCloudWorkspaceMasterMutationRequest>
  try {
    parsed = parseCloudWorkspaceMasterMutationRequest(
      JSON.parse(await readRequestText(request)),
    )
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? errorResponse(413, 'REQUEST_TOO_LARGE', 'Workspace共通データのrequestが大きすぎます。')
      : errorResponse(400, 'INVALID_REQUEST', 'JSON requestを読み取れませんでした。')
  }
  if (!parsed) {
    return errorResponse(400, 'INVALID_REQUEST', 'Workspace共通データの入力が正しくありません。')
  }

  try {
    const result = await dependencies.mutateValidatedMaster({
      actorId: actor.id,
      workspaceId: parsed.workspaceId,
      mutation: parsed.mutation,
    })
    if (result.error) return databaseErrorResponse(result.error)
    const value = parseCloudWorkspaceMasterMutationValue(
      result.data,
      parsed.workspaceId,
      parsed.mutation,
    )
    return value
      ? jsonResponse(200, result.data)
      : errorResponse(502, 'INVALID_RESPONSE', 'Workspace共通データの更新結果を確認できませんでした。')
  } catch (error) {
    return getThrownCode(error) === 'CONFIGURATION_ERROR'
      ? errorResponse(500, 'CONFIGURATION_ERROR', 'Cloud共通データのserver設定が不足しています。')
      : errorResponse(502, 'UPDATE_FAILED', 'Workspace共通データを更新できませんでした。')
  }
}
