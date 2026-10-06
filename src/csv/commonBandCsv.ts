import type { Band, BandId, Member } from '../domain/models.ts'
import { createCommonBandUpdate, type CommonBandDraft } from '../domain/commonBands.ts'
import {
  parseCsv,
  parseCsvTable,
  serializeCsv,
  splitListCell,
  type CsvImportError,
  type CsvImportPlan,
} from './csv.ts'
import { resolveMemberList } from './memberResolution.ts'
import {
  createBandMemberHeaders,
  getBandMemberHeaders,
  getMemberNamesFromRow,
  MEMBER_ID_LIST_HEADER,
} from './bandMemberColumns.ts'

export const createCommonBandCsvHeaders = (memberCount = 0): string[] => [
  'バンド名', ...createBandMemberHeaders(memberCount), '状態', '備考',
  'バンドID', MEMBER_ID_LIST_HEADER,
]

export const COMMON_BAND_CSV_HEADERS = createCommonBandCsvHeaders()

const COMMON_BAND_REQUIRED_HEADERS = ['バンド名'] as const

const parseStatus = (value: string): boolean | undefined => {
  const normalized = value.trim().toLocaleLowerCase()
  if (['活動中', 'active', 'true', '1'].includes(normalized)) return true
  if (['活動終了', 'inactive', 'false', '0'].includes(normalized)) return false
  return undefined
}

export const createCommonBandCsv = (bands: Band[], members: Member[]): string => {
  const memberById = new Map(members.map((member) => [member.id, member]))
  const memberColumnCount = Math.max(0, ...bands.map((band) => band.defaultMemberIds.length))
  const headers = createCommonBandCsvHeaders(memberColumnCount)
  const memberHeaders = createBandMemberHeaders(memberColumnCount)
  return serializeCsv([
    headers,
    ...bands.map((band) => [
      band.name,
      ...memberHeaders.map((_, index) => {
        const member = memberById.get(band.defaultMemberIds[index])
        return member?.acaName ?? member?.realName ?? ''
      }),
      band.active ? '活動中' : '活動終了',
      band.notes ?? '',
      band.id,
      band.defaultMemberIds.join('|'),
    ]),
  ])
}

export const planCommonBandCsvImport = ({
  csv,
  bands,
  members,
  createBandId,
}: {
  csv: string
  bands: Band[]
  members: Member[]
  createBandId: () => BandId
}): CsvImportPlan<Band[]> => {
  const parsed = parseCsv(csv)
  if (!parsed.ok) return parsed
  const table = parseCsvTable(csv, COMMON_BAND_REQUIRED_HEADERS)
  if (!table.ok) return table
  const memberHeaderResult = getBandMemberHeaders(
    parsed.rows[0]?.cells.map((header) => header.trim()) ?? [],
  )
  if (!memberHeaderResult.ok) return memberHeaderResult
  const errors: CsvImportError[] = []
  const existingById = new Map(bands.map((band) => [band.id, band]))
  const updatedById = new Map<BandId, Band>()
  const seenIds = new Set<string>()
  let createdCount = 0
  let updatedCount = 0
  for (const row of table.rows) {
    const explicitId = row.values['バンドID']?.trim() ?? ''
    if (explicitId && seenIds.has(explicitId)) {
      errors.push({ rowNumber: row.rowNumber, column: 'バンドID', message: 'CSV内でIDが重複しています。' })
      continue
    }
    if (explicitId) seenIds.add(explicitId)
    const existingBand = explicitId ? existingById.get(explicitId) : undefined
    const statusValue = row.values['状態']?.trim() ?? ''
    const active = statusValue ? parseStatus(statusValue) : existingBand?.active ?? true
    if (statusValue && active === undefined) {
      errors.push({ rowNumber: row.rowNumber, column: '状態', message: '活動中または活動終了を入力してください。' })
      continue
    }
    const resolved = resolveMemberList(
      splitListCell(row.values[MEMBER_ID_LIST_HEADER] ?? ''),
      getMemberNamesFromRow(row, memberHeaderResult.headers),
      members,
    )
    if (!resolved.ok) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID一覧', message: resolved.message })
      continue
    }
    const bandId = explicitId || createBandId()
    if (!bandId.trim() || updatedById.has(bandId) || (!explicitId && existingById.has(bandId))) {
      errors.push({ rowNumber: row.rowNumber, column: 'バンドID', message: '新しいバンドIDを生成できませんでした。' })
      continue
    }
    const draft: CommonBandDraft = {
      name: row.values['バンド名'] ?? '',
      defaultMemberIds: resolved.memberIds,
      active: active as boolean,
      notes: Object.hasOwn(row.values, '備考')
        ? row.values['備考']
        : existingBand?.notes ?? '',
    }
    const update = createCommonBandUpdate({ bandId, existingBand, draft, members })
    if (!update.ok) {
      Object.values(update.errors).filter(Boolean).forEach((message) => errors.push({
        rowNumber: row.rowNumber, column: 'データ', message,
      }))
      continue
    }
    updatedById.set(bandId, { ...update.band, active: active as boolean })
    if (existingBand) updatedCount += 1
    else createdCount += 1
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    candidate: [
      ...bands.map((band) => updatedById.get(band.id) ?? band),
      ...[...updatedById.values()].filter((band) => !existingById.has(band.id)),
    ],
    rowCount: table.rows.length,
    createdCount,
    updatedCount,
  }
}
