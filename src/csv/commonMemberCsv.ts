import type { Member, MemberId } from '../domain/models.ts'
import {
  createCommonMemberUpdate,
  type CommonMemberDraft,
} from '../domain/commonMembers.ts'
import {
  parseCsvTable,
  serializeCsv,
  type CsvImportError,
  type CsvImportPlan,
} from './csv.ts'

export const COMMON_MEMBER_CSV_HEADERS = [
  'メンバーID', '本名', 'アカペラネーム', '入学年度', '状態', '備考',
] as const

const parseStatus = (value: string): boolean | undefined => {
  const normalized = value.trim().toLocaleLowerCase()
  if (['在籍中', 'active', 'true', '1'].includes(normalized)) return true
  if (['非在籍', 'inactive', 'false', '0'].includes(normalized)) return false
  return undefined
}

export const createCommonMemberCsv = (members: Member[]): string => serializeCsv([
  COMMON_MEMBER_CSV_HEADERS,
  ...members.map((member) => [
    member.id,
    member.realName,
    member.acaName ?? '',
    member.entryAcademicYear?.toString() ?? '',
    member.active ? '在籍中' : '非在籍',
    member.notes ?? '',
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
  const table = parseCsvTable(csv, COMMON_MEMBER_CSV_HEADERS)
  if (!table.ok) return table
  const errors: CsvImportError[] = []
  const seenIds = new Set<string>()
  const existingById = new Map(members.map((member) => [member.id, member]))
  const updatedById = new Map<MemberId, Member>()
  let createdCount = 0
  let updatedCount = 0

  for (const row of table.rows) {
    const explicitId = row.values['メンバーID'].trim()
    if (explicitId && seenIds.has(explicitId)) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID', message: 'CSV内でIDが重複しています。' })
      continue
    }
    if (explicitId) seenIds.add(explicitId)
    const active = parseStatus(row.values['状態'])
    if (active === undefined) {
      errors.push({ rowNumber: row.rowNumber, column: '状態', message: '在籍中または非在籍を入力してください。' })
      continue
    }
    const memberId = explicitId || createMemberId()
    if (!memberId.trim() || updatedById.has(memberId) || (!explicitId && existingById.has(memberId))) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID', message: '新しいメンバーIDを生成できませんでした。' })
      continue
    }
    const existingMember = existingById.get(memberId)
    const draft: CommonMemberDraft = {
      realName: row.values['本名'],
      acaName: row.values['アカペラネーム'],
      entryAcademicYear: row.values['入学年度'],
      active,
      notes: row.values['備考'],
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
    updatedById.set(memberId, { ...update.member, active })
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

