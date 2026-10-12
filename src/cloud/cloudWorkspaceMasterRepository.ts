import type { SupabaseClient } from '@supabase/supabase-js'
import type { Band, Member } from '../domain/models.ts'
import { isRecord } from '../persistence/persistenceValidation.ts'
import {
  isValidCloudWorkspaceBand,
  isValidCloudWorkspaceMember,
} from './cloudWorkspaceMasterValidation.ts'

export {
  isValidCloudWorkspaceBand,
  isValidCloudWorkspaceMember,
} from './cloudWorkspaceMasterValidation.ts'

export const CLOUD_WORKSPACE_MASTER_PAGE_SIZE = 100

export interface CloudWorkspaceMasterRecord<T extends Member | Band> {
  workspaceId: string
  value: T
  revision: number
  createdAt: string
  updatedAt: string
}

export type CloudWorkspaceMemberRecord = CloudWorkspaceMasterRecord<Member> & {
  kind: 'member'
}

export type CloudWorkspaceBandRecord = CloudWorkspaceMasterRecord<Band> & {
  kind: 'band'
}

export type CloudWorkspaceMasterRecordUnion =
  | CloudWorkspaceMemberRecord
  | CloudWorkspaceBandRecord

export interface CloudWorkspaceMastersSnapshot {
  workspaceId: string
  generation: string
  members: CloudWorkspaceMemberRecord[]
  bands: CloudWorkspaceBandRecord[]
}

export interface CloudWorkspaceMasterDeletion {
  kind: 'member' | 'band'
  workspaceId: string
  id: string
  revision: number
}

export interface CloudWorkspaceMasterWriteResult<T> {
  generation: string
  result: T
}

export type CloudWorkspaceMasterMutation =
  | { operation: 'create-member'; member: Member }
  | { operation: 'update-member'; member: Member; expectedRevision: number }
  | { operation: 'delete-member'; memberId: string; expectedRevision: number }
  | { operation: 'create-band'; band: Band }
  | { operation: 'update-band'; band: Band; expectedRevision: number }
  | { operation: 'delete-band'; bandId: string; expectedRevision: number }

export type CloudWorkspaceMasterMutationValue =
  | { generation: string; record: CloudWorkspaceMasterRecordUnion }
  | { generation: string; deletion: CloudWorkspaceMasterDeletion }

export type CloudWorkspaceMasterErrorCode =
  | 'ACCESS_DENIED'
  | 'ALREADY_EXISTS'
  | 'CONFIGURATION_ERROR'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE'
  | 'MASTER_MEMBER_NOT_FOUND'
  | 'MASTER_NOT_FOUND'
  | 'MASTER_REFERENCED'
  | 'REVISION_CONFLICT'
  | 'SUPABASE_ERROR'
  | 'WORKSPACE_NOT_READY'
  | 'WORKSPACE_SNAPSHOT_CHANGED'

export interface CloudWorkspaceMasterError {
  code: CloudWorkspaceMasterErrorCode
  message: string
}

export type CloudWorkspaceMasterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudWorkspaceMasterError }

export interface CloudWorkspaceMasterDatabaseError {
  code?: string
  message?: string
}

export interface CloudWorkspaceMasterDatabaseResult<T> {
  data: T | null
  error: CloudWorkspaceMasterDatabaseError | null
}

export interface CloudWorkspaceMasterDatabaseGateway {
  loadAuthorizedPage: (
    workspaceId: string,
    afterKind: 'member' | 'band' | null,
    afterId: string | null,
    limit: number,
    expectedGeneration: string | null,
  ) => Promise<CloudWorkspaceMasterDatabaseResult<unknown>>
  mutate: (
    workspaceId: string,
    mutation: CloudWorkspaceMasterMutation,
  ) => Promise<CloudWorkspaceMasterDatabaseResult<unknown>>
}

export interface CloudWorkspaceMasterRepository {
  loadWorkspaceMasters: (
    workspaceId: string,
    expectedGeneration?: string,
  ) => Promise<CloudWorkspaceMasterResult<CloudWorkspaceMastersSnapshot>>
  listMembers: (
    workspaceId: string,
    expectedGeneration?: string,
  ) => Promise<CloudWorkspaceMasterResult<CloudWorkspaceMemberRecord[]>>
  listBands: (
    workspaceId: string,
    expectedGeneration?: string,
  ) => Promise<CloudWorkspaceMasterResult<CloudWorkspaceBandRecord[]>>
  createMember: (
    workspaceId: string,
    member: Member,
  ) => Promise<CloudWorkspaceMasterResult<
    CloudWorkspaceMasterWriteResult<CloudWorkspaceMemberRecord>
  >>
  updateMember: (
    workspaceId: string,
    member: Member,
    expectedRevision: number,
  ) => Promise<CloudWorkspaceMasterResult<
    CloudWorkspaceMasterWriteResult<CloudWorkspaceMemberRecord>
  >>
  deleteMember: (
    workspaceId: string,
    memberId: string,
    expectedRevision: number,
  ) => Promise<CloudWorkspaceMasterResult<
    CloudWorkspaceMasterWriteResult<CloudWorkspaceMasterDeletion>
  >>
  createBand: (
    workspaceId: string,
    band: Band,
  ) => Promise<CloudWorkspaceMasterResult<
    CloudWorkspaceMasterWriteResult<CloudWorkspaceBandRecord>
  >>
  updateBand: (
    workspaceId: string,
    band: Band,
    expectedRevision: number,
  ) => Promise<CloudWorkspaceMasterResult<
    CloudWorkspaceMasterWriteResult<CloudWorkspaceBandRecord>
  >>
  deleteBand: (
    workspaceId: string,
    bandId: string,
    expectedRevision: number,
  ) => Promise<CloudWorkspaceMasterResult<
    CloudWorkspaceMasterWriteResult<CloudWorkspaceMasterDeletion>
  >>
}

interface MasterCursor {
  kind: 'member' | 'band'
  id: string
}

interface MasterPage {
  generation: string
  rows: CloudWorkspaceMasterRecordUnion[]
  nextCursor: MasterCursor | null
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value))

const parseRecord = (
  value: unknown,
  workspaceId: string,
): CloudWorkspaceMasterRecordUnion | undefined => {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    !isPositiveSafeInteger(value.revision) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) return undefined

  if (value.kind === 'member' && isValidCloudWorkspaceMember(value.value)) {
    return {
      kind: 'member',
      workspaceId,
      value: value.value,
      revision: value.revision,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
  }
  if (value.kind === 'band' && isValidCloudWorkspaceBand(value.value)) {
    return {
      kind: 'band',
      workspaceId,
      value: value.value,
      revision: value.revision,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
  }
  return undefined
}

const parseCursor = (value: unknown): MasterCursor | null | undefined => {
  if (value === null) return null
  if (
    !isRecord(value) ||
    (value.kind !== 'member' && value.kind !== 'band') ||
    !isNonEmptyString(value.id)
  ) return undefined
  return { kind: value.kind, id: value.id }
}

const parsePage = (
  value: unknown,
  workspaceId: string,
  pageSize: number,
): MasterPage | undefined => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.workspaceId !== workspaceId ||
    !isGeneration(value.workspaceGeneration) ||
    !Array.isArray(value.rows) ||
    value.rows.length > pageSize ||
    !Object.hasOwn(value, 'nextCursor')
  ) return undefined

  const rows = Array.from(value.rows, row => parseRecord(row, workspaceId))
  const nextCursor = parseCursor(value.nextCursor)
  if (
    rows.some(row => !row) ||
    nextCursor === undefined ||
    (rows.length === 0 && nextCursor !== null) ||
    (nextCursor !== null && rows.length !== pageSize)
  ) return undefined

  return {
    generation: value.workspaceGeneration,
    rows: rows.filter(row => row !== undefined),
    nextCursor,
  }
}

const errorResult = (
  code: CloudWorkspaceMasterErrorCode,
  message: string,
): CloudWorkspaceMasterResult<never> => ({ ok: false, error: { code, message } })

const databaseFailure = (
  error: CloudWorkspaceMasterDatabaseError,
): CloudWorkspaceMasterResult<never> => {
  switch (error.code) {
    case '40001':
    case 'REVISION_CONFLICT':
      return errorResult('REVISION_CONFLICT', '他の端末で更新されています。再読み込みしてください。')
    case 'WORKSPACE_SNAPSHOT_CHANGED':
      return errorResult(
        'WORKSPACE_SNAPSHOT_CHANGED',
        'Workspaceの読込中にデータが更新されました。再読み込みしてください。',
      )
    case '42501':
    case 'ACCESS_DENIED':
    case 'AUTHENTICATION_REQUIRED':
      return errorResult('ACCESS_DENIED', 'Workspace共通データへアクセスできません。')
    case '23503':
    case 'MASTER_REFERENCED':
      return errorResult('MASTER_REFERENCED', '参照中の共通データは削除できません。')
    case 'PMA01':
    case 'MASTER_MEMBER_NOT_FOUND':
      return errorResult(
        'MASTER_MEMBER_NOT_FOUND',
        '指定されたバンドメンバーが見つかりません。',
      )
    case '23505':
    case 'ALREADY_EXISTS':
      return errorResult('ALREADY_EXISTS', '同じIDの共通データが既に存在します。')
    case 'MASTER_NOT_FOUND':
      return errorResult('MASTER_NOT_FOUND', 'Workspace共通データが見つかりません。')
    case '55000':
    case 'WORKSPACE_NOT_READY':
      return errorResult('WORKSPACE_NOT_READY', 'Workspace共通データはまだ利用できません。')
    case 'CONFIGURATION_ERROR':
      return errorResult('CONFIGURATION_ERROR', 'Cloud共通データ機能が設定されていません。')
    case 'INVALID_ARGUMENT':
      return errorResult('INVALID_ARGUMENT', 'Workspace共通データの入力が正しくありません。')
    case 'INVALID_RESPONSE':
      return errorResult('INVALID_RESPONSE', 'Workspace共通データの応答を確認できませんでした。')
    default:
      return errorResult('SUPABASE_ERROR', 'Workspace共通データの通信に失敗しました。')
  }
}

const standardUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const normalizeWorkspaceId = (workspaceId: string): string | undefined =>
  standardUuidPattern.test(workspaceId) ? workspaceId.toLowerCase() : undefined

const validateExpectedRevision = (expectedRevision: number): boolean =>
  Number.isSafeInteger(expectedRevision) && expectedRevision > 0

export const parseCloudWorkspaceMasterMutationValue = (
  value: unknown,
  workspaceId: string,
  mutation: CloudWorkspaceMasterMutation,
): CloudWorkspaceMasterMutationValue | undefined => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.workspaceId !== workspaceId ||
    !isGeneration(value.workspaceGeneration)
  ) return undefined

  if (
    mutation.operation === 'delete-member' ||
    mutation.operation === 'delete-band'
  ) {
    const deletion = value.deletion
    const expectedKind = mutation.operation === 'delete-member' ? 'member' : 'band'
    const expectedId = mutation.operation === 'delete-member'
      ? mutation.memberId
      : mutation.bandId
    if (
      !isRecord(deletion) ||
      deletion.kind !== expectedKind ||
      deletion.workspaceId !== workspaceId ||
      deletion.id !== expectedId ||
      !isPositiveSafeInteger(deletion.revision)
    ) return undefined
    return {
      generation: value.workspaceGeneration,
      deletion: deletion as unknown as CloudWorkspaceMasterDeletion,
    }
  }

  const record = parseRecord(value.record, workspaceId)
  const expectedKind = mutation.operation.endsWith('member') ? 'member' : 'band'
  const expectedId = mutation.operation === 'create-member' ||
    mutation.operation === 'update-member'
    ? mutation.member.id
    : mutation.band.id
  if (
    !record ||
    record.kind !== expectedKind ||
    record.value.id !== expectedId
  ) return undefined
  return { generation: value.workspaceGeneration, record }
}

export const createCloudWorkspaceMasterRepository = (
  gateway: CloudWorkspaceMasterDatabaseGateway,
  pageSize = CLOUD_WORKSPACE_MASTER_PAGE_SIZE,
): CloudWorkspaceMasterRepository => {
  const effectivePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 &&
    pageSize <= CLOUD_WORKSPACE_MASTER_PAGE_SIZE
    ? pageSize
    : CLOUD_WORKSPACE_MASTER_PAGE_SIZE

  const loadWorkspaceMasters = async (
    workspaceId: string,
    requestedGeneration?: string,
  ): Promise<CloudWorkspaceMasterResult<CloudWorkspaceMastersSnapshot>> => {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
    if (!normalizedWorkspaceId) {
      return errorResult('INVALID_ARGUMENT', 'Workspace IDが必要です。')
    }
    if (requestedGeneration !== undefined && !isGeneration(requestedGeneration)) {
      return errorResult('INVALID_ARGUMENT', 'Workspace generationが正しくありません。')
    }

    const members: CloudWorkspaceMemberRecord[] = []
    const bands: CloudWorkspaceBandRecord[] = []
    const seen = new Set<string>()
    const cursors = new Set<string>()
    let cursor: MasterCursor | null = null
    let generation: string | null = requestedGeneration ?? null

    try {
      while (true) {
        const result = await gateway.loadAuthorizedPage(
          normalizedWorkspaceId,
          cursor?.kind ?? null,
          cursor?.id ?? null,
          effectivePageSize,
          generation,
        )
        if (
          result.error?.code === '40001' ||
          result.error?.code === 'WORKSPACE_SNAPSHOT_CHANGED'
        ) {
          return errorResult(
            'WORKSPACE_SNAPSHOT_CHANGED',
            'Workspaceの読込中にデータが更新されました。再読み込みしてください。',
          )
        }
        if (result.error) return databaseFailure(result.error)
        const page = parsePage(result.data, normalizedWorkspaceId, effectivePageSize)
        if (!page || (generation !== null && page.generation !== generation)) {
          return errorResult('INVALID_RESPONSE', 'Workspace共通データの応答を確認できませんでした。')
        }
        generation = page.generation
        for (const record of page.rows) {
          const identity = `${record.kind}:${record.value.id}`
          if (seen.has(identity)) {
            return errorResult('INVALID_RESPONSE', 'Workspace共通データのIDが重複しています。')
          }
          seen.add(identity)
          if (record.kind === 'member') members.push(record)
          else bands.push(record)
        }

        if (page.nextCursor === null) {
          return {
            ok: true,
            value: {
              workspaceId: normalizedWorkspaceId,
              generation,
              members,
              bands,
            },
          }
        }
        const key = `${page.nextCursor.kind}:${page.nextCursor.id}`
        const last = page.rows.at(-1)
        if (
          !last ||
          last.kind !== page.nextCursor.kind ||
          last.value.id !== page.nextCursor.id ||
          cursors.has(key)
        ) {
          return errorResult('INVALID_RESPONSE', 'Workspace共通データのcursorが正しくありません。')
        }
        cursors.add(key)
        cursor = page.nextCursor
      }
    } catch {
      return databaseFailure({})
    }
  }

  const mutate = async (
    workspaceId: string,
    mutation: CloudWorkspaceMasterMutation,
  ): Promise<CloudWorkspaceMasterResult<CloudWorkspaceMasterMutationValue>> => {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
    if (!normalizedWorkspaceId) {
      return errorResult('INVALID_ARGUMENT', 'Workspace IDが必要です。')
    }
    try {
      const result = await gateway.mutate(normalizedWorkspaceId, mutation)
      if (result.error) return databaseFailure(result.error)
      const value = parseCloudWorkspaceMasterMutationValue(
        result.data,
        normalizedWorkspaceId,
        mutation,
      )
      return value
        ? { ok: true, value }
        : errorResult('INVALID_RESPONSE', 'Workspace共通データの更新結果を確認できませんでした。')
    } catch {
      return databaseFailure({})
    }
  }

  return {
    loadWorkspaceMasters,
    async listMembers(workspaceId, expectedGeneration) {
      const result = await loadWorkspaceMasters(workspaceId, expectedGeneration)
      return result.ok ? { ok: true, value: result.value.members } : result
    },
    async listBands(workspaceId, expectedGeneration) {
      const result = await loadWorkspaceMasters(workspaceId, expectedGeneration)
      return result.ok ? { ok: true, value: result.value.bands } : result
    },
    async createMember(workspaceId, member) {
      if (!isValidCloudWorkspaceMember(member)) {
        return errorResult('INVALID_ARGUMENT', 'Memberの入力が正しくありません。')
      }
      const result = await mutate(workspaceId, { operation: 'create-member', member })
      if (!result.ok) return result
      return 'record' in result.value && result.value.record.kind === 'member'
        ? {
            ok: true,
            value: { generation: result.value.generation, result: result.value.record },
          }
        : errorResult('INVALID_RESPONSE', 'Memberの更新結果を確認できませんでした。')
    },
    async updateMember(workspaceId, member, expectedRevision) {
      if (!isValidCloudWorkspaceMember(member) || !validateExpectedRevision(expectedRevision)) {
        return errorResult('INVALID_ARGUMENT', 'Memberまたはrevisionが正しくありません。')
      }
      const result = await mutate(workspaceId, {
        operation: 'update-member', member, expectedRevision,
      })
      if (!result.ok) return result
      return 'record' in result.value && result.value.record.kind === 'member'
        ? {
            ok: true,
            value: { generation: result.value.generation, result: result.value.record },
          }
        : errorResult('INVALID_RESPONSE', 'Memberの更新結果を確認できませんでした。')
    },
    async deleteMember(workspaceId, memberId, expectedRevision) {
      if (!isNonEmptyString(memberId) || !validateExpectedRevision(expectedRevision)) {
        return errorResult('INVALID_ARGUMENT', 'Member IDまたはrevisionが正しくありません。')
      }
      const result = await mutate(workspaceId, {
        operation: 'delete-member', memberId, expectedRevision,
      })
      if (!result.ok) return result
      return 'deletion' in result.value
        ? {
            ok: true,
            value: { generation: result.value.generation, result: result.value.deletion },
          }
        : errorResult('INVALID_RESPONSE', 'Memberの削除結果を確認できませんでした。')
    },
    async createBand(workspaceId, band) {
      if (!isValidCloudWorkspaceBand(band)) {
        return errorResult('INVALID_ARGUMENT', 'Bandの入力が正しくありません。')
      }
      const result = await mutate(workspaceId, { operation: 'create-band', band })
      if (!result.ok) return result
      return 'record' in result.value && result.value.record.kind === 'band'
        ? {
            ok: true,
            value: { generation: result.value.generation, result: result.value.record },
          }
        : errorResult('INVALID_RESPONSE', 'Bandの更新結果を確認できませんでした。')
    },
    async updateBand(workspaceId, band, expectedRevision) {
      if (!isValidCloudWorkspaceBand(band) || !validateExpectedRevision(expectedRevision)) {
        return errorResult('INVALID_ARGUMENT', 'Bandまたはrevisionが正しくありません。')
      }
      const result = await mutate(workspaceId, {
        operation: 'update-band', band, expectedRevision,
      })
      if (!result.ok) return result
      return 'record' in result.value && result.value.record.kind === 'band'
        ? {
            ok: true,
            value: { generation: result.value.generation, result: result.value.record },
          }
        : errorResult('INVALID_RESPONSE', 'Bandの更新結果を確認できませんでした。')
    },
    async deleteBand(workspaceId, bandId, expectedRevision) {
      if (!isNonEmptyString(bandId) || !validateExpectedRevision(expectedRevision)) {
        return errorResult('INVALID_ARGUMENT', 'Band IDまたはrevisionが正しくありません。')
      }
      const result = await mutate(workspaceId, {
        operation: 'delete-band', bandId, expectedRevision,
      })
      if (!result.ok) return result
      return 'deletion' in result.value
        ? {
            ok: true,
            value: { generation: result.value.generation, result: result.value.deletion },
          }
        : errorResult('INVALID_RESPONSE', 'Bandの削除結果を確認できませんでした。')
    },
  }
}

const parseFunctionError = async (error: unknown): Promise<CloudWorkspaceMasterDatabaseError> => {
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

export const createSupabaseCloudWorkspaceMasterGateway = (
  client: SupabaseClient,
): CloudWorkspaceMasterDatabaseGateway => ({
  async loadAuthorizedPage(
    workspaceId,
    afterKind,
    afterId,
    limit,
    expectedGeneration,
  ) {
    const result = await client.rpc('load_workspace_masters_page_authorized', {
      p_workspace_id: workspaceId,
      p_after_kind: afterKind,
      p_after_master_id: afterId,
      p_page_size: limit,
      p_expected_generation: expectedGeneration,
    })
    return { data: result.data, error: result.error }
  },
  async mutate(workspaceId, mutation) {
    const result = await client.functions.invoke('workspace-masters', {
      body: { workspaceId, ...mutation },
    })
    if (result.error) {
      return { data: null, error: await parseFunctionError(result.error) }
    }
    return { data: result.data, error: null }
  },
})

export const createSupabaseCloudWorkspaceMasterRepository = (
  client: SupabaseClient,
): CloudWorkspaceMasterRepository => createCloudWorkspaceMasterRepository(
  createSupabaseCloudWorkspaceMasterGateway(client),
)
