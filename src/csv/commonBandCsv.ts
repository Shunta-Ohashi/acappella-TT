import type { Band, BandId, Member } from '../domain/models.ts'
import { createCommonBandUpdate, type CommonBandDraft } from '../domain/commonBands.ts'
import {
  parseCsvTable,
  serializeCsv,
  splitListCell,
  type CsvImportError,
  type CsvImportPlan,
} from './csv.ts'
import { resolveMemberList } from './memberResolution.ts'

export const COMMON_BAND_CSV_HEADERS = [
  'バンドID', 'バンド名', 'メンバーID一覧', 'メンバー名一覧', '状態', '備考',
] as const

const parseStatus = (value: string): boolean | undefined => {
  const normalized = value.trim().toLocaleLowerCase()
  if (['活動中', 'active', 'true', '1'].includes(normalized)) return true
  if (['活動終了', 'inactive', 'false', '0'].includes(normalized)) return false
  return undefined
}

export const createCommonBandCsv = (bands: Band[], members: Member[]): string => {
  const memberById = new Map(members.map((member) => [member.id, member]))
  return serializeCsv([
    COMMON_BAND_CSV_HEADERS,
    ...bands.map((band) => [
      band.id,
      band.name,
      band.defaultMemberIds.join('|'),
      band.defaultMemberIds.map((id) => memberById.get(id)?.realName ?? '').join('|'),
      band.active ? '活動中' : '活動終了',
      band.notes ?? '',
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
  const table = parseCsvTable(csv, COMMON_BAND_CSV_HEADERS)
  if (!table.ok) return table
  const errors: CsvImportError[] = []
  const existingById = new Map(bands.map((band) => [band.id, band]))
  const updatedById = new Map<BandId, Band>()
  const seenIds = new Set<string>()
  let createdCount = 0
  let updatedCount = 0
  for (const row of table.rows) {
    const explicitId = row.values['バンドID'].trim()
    if (explicitId && seenIds.has(explicitId)) {
      errors.push({ rowNumber: row.rowNumber, column: 'バンドID', message: 'CSV内でIDが重複しています。' })
      continue
    }
    if (explicitId) seenIds.add(explicitId)
    const active = parseStatus(row.values['状態'])
    if (active === undefined) {
      errors.push({ rowNumber: row.rowNumber, column: '状態', message: '活動中または活動終了を入力してください。' })
      continue
    }
    const resolved = resolveMemberList(
      splitListCell(row.values['メンバーID一覧']),
      splitListCell(row.values['メンバー名一覧']),
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
    const existingBand = existingById.get(bandId)
    const draft: CommonBandDraft = {
      name: row.values['バンド名'],
      defaultMemberIds: resolved.memberIds,
      active,
      notes: row.values['備考'],
    }
    const update = createCommonBandUpdate({ bandId, existingBand, draft, members })
    if (!update.ok) {
      Object.values(update.errors).filter(Boolean).forEach((message) => errors.push({
        rowNumber: row.rowNumber, column: 'データ', message,
      }))
      continue
    }
    updatedById.set(bandId, { ...update.band, active })
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
