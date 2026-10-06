import type { Member, MemberId } from '../domain/models.ts'
import {
  createCommonMemberUpdate,
  type CommonMemberDraft,
} from '../domain/commonMembers.ts'
import {
  type CsvImportError,
  type CsvImportPlan,
} from './csv.ts'
import { parseSpreadsheetCsvTable, serializeSpreadsheetCsv } from './spreadsheetCsv.ts'

export const COMMON_MEMBER_CSV_HEADERS = [
  '本名', 'アカペラネーム', '入学年度', '状態', '備考', 'メンバーID',
] as const

const COMMON_MEMBER_REQUIRED_HEADERS = ['本名'] as const

const parseStatus = (value: string): boolean | undefined => {
  const normalized = value.trim().toLowerCase()
  if (['在籍中', 'active', 'true', '1'].includes(normalized)) return true
  if (['非在籍', 'inactive', 'false', '0'].includes(normalized)) return false
  return undefined
}

export const createCommonMemberCsv = (members: Member[]): string => serializeSpreadsheetCsv([
  COMMON_MEMBER_CSV_HEADERS,
  ...members.map((member) => [
    member.realName,
    member.acaName ?? '',
    member.entryAcademicYear?.toString() ?? '',
    member.active ? '在籍中' : '非在籍',
    member.notes ?? '',
    member.id,
  ]),
])

export const planCommonMemberCsvImport = ({
  csv,
  members,
  createMemberId,
}: {
  csv: string
  members: Member[]
  createMemberId: () => MemberId
}): CsvImportPlan<Member[]> => {
  const table = parseSpreadsheetCsvTable(csv, COMMON_MEMBER_REQUIRED_HEADERS)
  if (!table.ok) return table
  const errors: CsvImportError[] = []
  const seenIds = new Set<string>()
  const existingById = new Map(members.map((member) => [member.id, member]))
  const updatedById = new Map<MemberId, Member>()
  let createdCount = 0
  let updatedCount = 0

  for (const row of table.rows) {
    const explicitId = row.values['メンバーID']?.trim() ?? ''
    if (explicitId && seenIds.has(explicitId)) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID', message: 'CSV内でIDが重複しています。' })
      continue
    }
    if (explicitId) seenIds.add(explicitId)
    const existingMember = explicitId ? existingById.get(explicitId) : undefined
    const statusValue = row.values['状態']?.trim() ?? ''
    const active = statusValue ? parseStatus(statusValue) : existingMember?.active ?? true
    if (statusValue && active === undefined) {
      errors.push({ rowNumber: row.rowNumber, column: '状態', message: '在籍中または非在籍を入力してください。' })
      continue
    }
    const memberId = explicitId || createMemberId()
    if (!memberId.trim() || updatedById.has(memberId) || (!explicitId && existingById.has(memberId))) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID', message: '新しいメンバーIDを生成できませんでした。' })
      continue
    }
    const draft: CommonMemberDraft = {
      realName: row.values['本名'] ?? '',
      acaName: Object.hasOwn(row.values, 'アカペラネーム')
        ? row.values['アカペラネーム']
        : existingMember?.acaName ?? '',
      entryAcademicYear: Object.hasOwn(row.values, '入学年度')
        ? row.values['入学年度']
        : existingMember?.entryAcademicYear?.toString() ?? '',
      active: active as boolean,
      notes: Object.hasOwn(row.values, '備考')
        ? row.values['備考']
        : existingMember?.notes ?? '',
    }
    const update = createCommonMemberUpdate({ memberId, existingMember, draft })
    if (!update.ok) {
      Object.entries(update.errors).forEach(([column, message]) => {
        if (message) errors.push({
          rowNumber: row.rowNumber,
          column: column === 'realName' ? '本名' : column === 'entryAcademicYear' ? '入学年度' : 'データ',
          message,
        })
      })
      continue
    }
    updatedById.set(memberId, { ...update.member, active: active as boolean })
    if (existingMember) updatedCount += 1
    else createdCount += 1
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    candidate: [
      ...members.map((member) => updatedById.get(member.id) ?? member),
      ...[...updatedById.values()].filter((member) => !existingById.has(member.id)),
    ],
    rowCount: table.rows.length,
    createdCount,
    updatedCount,
  }
}

