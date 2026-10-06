import type { Band, Event, EventBand, EventDay, EventMember, EventMemberDay, Member } from '../domain/models.ts'
import {
  hasEventBandSettingsErrors,
  validateEventBandSettingsDraft,
  type EventBandSettingsDraft,
  type EventBandSettingsItemDraft,
} from '../domain/eventBandSettings.ts'
import {
  parseCsv, splitListCell, type CsvImportError, type CsvImportPlan,
} from './csv.ts'
import { parseSpreadsheetCsvTable, serializeSpreadsheetCsv } from './spreadsheetCsv.ts'
import { getOrderedEventDays, resolveEventDayId } from './eventCsvShared.ts'
import { getCsvMemberName, resolveMemberList } from './memberResolution.ts'
import {
  createBandMemberHeaders,
  getBandMemberHeaders,
  getMemberNamesFromRow,
  MEMBER_ID_LIST_HEADER,
} from './bandMemberColumns.ts'

export const createEventBandCsvHeaders = (memberCount = 0): string[] => [
  'バンド名', '開催日', ...createBandMemberHeaders(memberCount), '出演枠', '固定バンド名',
  '出演バンドID', '開催日ID', '固定バンドID', MEMBER_ID_LIST_HEADER, '下書きID',
]

export const EVENT_BAND_CSV_HEADERS = createEventBandCsvHeaders()

const EVENT_BAND_REQUIRED_HEADERS = ['バンド名', '開催日', '出演枠'] as const

export const createEventBandCsv = ({
  event, eventDays, bands, members, draft,
}: {
  event: Event
  eventDays: EventDay[]
  bands: Band[]
  members: Member[]
  draft: EventBandSettingsDraft
}): string => {
  const dayById = new Map(getOrderedEventDays(event, eventDays).map((day) => [day.id, day]))
  const bandById = new Map(bands.map((band) => [band.id, band]))
  const memberById = new Map(members.map((member) => [member.id, member]))
  const memberColumnCount = Math.max(0, ...draft.items.map((item) => item.memberIds.length))
  const headers = createEventBandCsvHeaders(memberColumnCount)
  const memberHeaders = createBandMemberHeaders(memberColumnCount)
  return serializeSpreadsheetCsv([
    headers,
    ...draft.items.map((item) => {
      const day = dayById.get(item.eventDayId)
      return [
        item.name,
        day?.date ?? '',
        ...memberHeaders.map((_, index) => {
          const member = memberById.get(item.memberIds[index])
          return getCsvMemberName(member)
        }),
        item.durationMinutes,
        item.bandId ? bandById.get(item.bandId)?.name ?? '' : '',
        item.eventBandId ?? '',
        item.eventDayId,
        item.bandId ?? '',
        item.memberIds.join('|'),
        item.draftId,
      ]
    }),
  ])
}

export const planEventBandCsvImport = ({
  csv, event, eventDays, bands, members, eventMembers, eventMemberDays,
  eventBands, draft, createDraftId,
}: {
  csv: string
  event: Event
  eventDays: EventDay[]
  bands: Band[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  draft: EventBandSettingsDraft
  createDraftId: () => string
}): CsvImportPlan<EventBandSettingsDraft> => {
  const parsed = parseCsv(csv)
  if (!parsed.ok) return parsed
  const table = parseSpreadsheetCsvTable(csv, EVENT_BAND_REQUIRED_HEADERS)
  if (!table.ok) return table
  const memberHeaderResult = getBandMemberHeaders(
    parsed.rows[0]?.cells.map((header) => header.trim()) ?? [],
  )
  if (!memberHeaderResult.ok) return memberHeaderResult
  const errors: CsvImportError[] = []
  const candidate = structuredClone(draft)
  const currentEventBands = eventBands.filter((item) => item.eventId === event.id)
  const existingById = new Map(currentEventBands.map((item) => [item.id, item]))
  const draftByEventBandId = new Map(candidate.items.flatMap((item) =>
    item.eventBandId ? [[item.eventBandId, item] as const] : [],
  ))
  const unsavedDraftsById = new Map<string, EventBandSettingsItemDraft[]>()
  candidate.items.filter((item) => !item.eventBandId).forEach((item) => {
    const matches = unsavedDraftsById.get(item.draftId) ?? []
    matches.push(item)
    unsavedDraftsById.set(item.draftId, matches)
  })
  const seenIds = new Set<string>()
  const seenDraftIds = new Set<string>()
  const rowByDraftId = new Map<string, number>()
  let createdCount = 0
  let updatedCount = 0

  for (const row of table.rows) {
    const eventBandId = row.values['出演バンドID']?.trim() ?? ''
    const importedDraftId = row.values['下書きID']?.trim() ?? ''
    if (eventBandId && seenIds.has(eventBandId)) {
      errors.push({ rowNumber: row.rowNumber, column: '出演バンドID', message: 'CSV内でIDが重複しています。' })
      continue
    }
    if (eventBandId) seenIds.add(eventBandId)
    if (importedDraftId && seenDraftIds.has(importedDraftId)) {
      errors.push({ rowNumber: row.rowNumber, column: '下書きID', message: 'CSV内で下書きIDが重複しています。' })
      continue
    }
    if (importedDraftId) seenDraftIds.add(importedDraftId)
    const existing = eventBandId ? existingById.get(eventBandId) : undefined
    if (eventBandId && !existing) {
      errors.push({ rowNumber: row.rowNumber, column: '出演バンドID', message: '現在のイベントに存在しない出演バンドIDです。新規行では空欄にしてください。' })
      continue
    }
    const matchingDrafts = !eventBandId && importedDraftId
      ? unsavedDraftsById.get(importedDraftId) ?? []
      : []
    if (matchingDrafts.length > 1) {
      errors.push({ rowNumber: row.rowNumber, column: '下書きID', message: '現在の下書きに同じIDの出演バンドが複数あります。' })
      continue
    }
    const matchingDraft = matchingDrafts[0]
    const day = resolveEventDayId(
      event,
      eventDays,
      row.values['開催日ID'] ?? '',
      row.values['開催日'] ?? '',
    )
    if (!day.ok) {
      errors.push({ rowNumber: row.rowNumber, column: '開催日ID', message: day.message })
      continue
    }
    const hasBandIdColumn = Object.hasOwn(row.values, '固定バンドID')
    const hasBandNameColumn = Object.hasOwn(row.values, '固定バンド名')
    const hasBandSourceColumns = hasBandIdColumn || hasBandNameColumn
    const explicitBandId = row.values['固定バンドID']?.trim() ?? ''
    const bandName = row.values['固定バンド名']?.trim() ?? ''
    let bandId = hasBandSourceColumns
      ? explicitBandId || undefined
      : existing?.bandId ?? matchingDraft?.bandId
    if (bandId && !bands.some((band) => band.id === bandId)) {
      errors.push({ rowNumber: row.rowNumber, column: '固定バンドID', message: '固定バンドが見つかりません。' })
      continue
    }
    if (!bandId && bandName) {
      const matches = bands.filter((band) => band.name.trim() === bandName)
      if (matches.length !== 1) {
        errors.push({
          rowNumber: row.rowNumber,
          column: '固定バンド名',
          message: matches.length === 0
            ? `固定バンド「${bandName}」が見つかりません。`
            : `固定バンド名「${bandName}」に一致するバンドが複数あります。`,
        })
        continue
      }
      bandId = matches[0].id
    }
    if (existing && existing.bandId !== bandId) {
      errors.push({ rowNumber: row.rowNumber, column: '固定バンドID', message: '既存出演バンドの作成元は変更できません。' })
      continue
    }
    const memberResult = resolveMemberList(
      splitListCell(row.values[MEMBER_ID_LIST_HEADER] ?? ''),
      getMemberNamesFromRow(row, memberHeaderResult.headers),
      members,
    )
    if (!memberResult.ok) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID一覧', message: memberResult.message })
      continue
    }
    const item: EventBandSettingsItemDraft = {
      draftId: eventBandId
        ? draftByEventBandId.get(eventBandId)?.draftId ?? `event-band-${eventBandId}`
        : matchingDraft?.draftId ?? createDraftId(),
      ...(eventBandId ? { eventBandId } : {}),
      eventId: event.id,
      eventDayId: day.eventDayId,
      ...(bandId ? { bandId } : {}),
      name: row.values['バンド名'] ?? '',
      memberIds: memberResult.memberIds,
      durationMinutes: row.values['出演枠']?.trim() ?? '',
    }
    rowByDraftId.set(item.draftId, row.rowNumber)
    if (eventBandId) {
      const index = candidate.items.findIndex((current) => current.eventBandId === eventBandId)
      if (index < 0) candidate.items.push(item)
      else candidate.items[index] = item
      updatedCount += 1
    } else if (matchingDraft) {
      const index = candidate.items.findIndex((current) => current === matchingDraft)
      candidate.items[index] = item
      updatedCount += 1
    } else {
      candidate.items.push(item)
      createdCount += 1
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const validation = validateEventBandSettingsDraft({
    draft: candidate, event, eventDays, members, bands, eventMembers, eventMemberDays,
  })
  if (hasEventBandSettingsErrors(validation)) {
    const domainErrors: CsvImportError[] = []
    Object.entries(validation.items).forEach(([draftId, itemErrors]) => {
      Object.entries(itemErrors).filter((entry) => entry[1]).forEach(([field, message]) => {
        domainErrors.push({
          rowNumber: rowByDraftId.get(draftId),
          column: field === 'eventDayId' ? '開催日ID'
            : field === 'name' ? 'バンド名'
              : field === 'memberIds' ? 'メンバーID一覧'
                : field === 'durationMinutes' ? '出演枠' : 'データ',
          message,
        })
      })
    })
    if (validation.form) domainErrors.push({ column: 'データ', message: validation.form })
    return { ok: false, errors: domainErrors }
  }
  return { ok: true, candidate, rowCount: table.rows.length, createdCount, updatedCount }
}
