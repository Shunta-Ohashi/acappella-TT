import type { Band, Event, EventBand, EventDay, EventMember, EventMemberDay, Member } from '../domain/models.ts'
import {
  hasEventBandSettingsErrors,
  validateEventBandSettingsDraft,
  type EventBandSettingsDraft,
  type EventBandSettingsItemDraft,
} from '../domain/eventBandSettings.ts'
import {
  parseCsvTable, serializeCsv, splitListCell, type CsvImportError, type CsvImportPlan,
} from './csv.ts'
import { getOrderedEventDays, resolveEventDayId } from './eventCsvShared.ts'
import { resolveMemberList } from './memberResolution.ts'

export const EVENT_BAND_CSV_HEADERS = [
  '出演バンドID', '開催日ID', '開催日', '開催日ラベル', '固定バンドID',
  'バンド名', 'メンバーID一覧', 'メンバー名一覧', '出演枠',
] as const

export const createEventBandCsv = ({
  event, eventDays, members, draft,
}: {
  event: Event
  eventDays: EventDay[]
  members: Member[]
  draft: EventBandSettingsDraft
}): string => {
  const dayById = new Map(getOrderedEventDays(event, eventDays).map((day) => [day.id, day]))
  const memberById = new Map(members.map((member) => [member.id, member]))
  return serializeCsv([
    EVENT_BAND_CSV_HEADERS,
    ...draft.items.map((item) => {
      const day = dayById.get(item.eventDayId)
      return [
        item.eventBandId ?? '', item.eventDayId, day?.date ?? '', day?.label ?? '',
        item.bandId ?? '', item.name, item.memberIds.join('|'),
        item.memberIds.map((id) => memberById.get(id)?.realName ?? '').join('|'),
        item.durationMinutes,
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
  const table = parseCsvTable(csv, EVENT_BAND_CSV_HEADERS)
  if (!table.ok) return table
  const errors: CsvImportError[] = []
  const candidate = structuredClone(draft)
  const currentEventBands = eventBands.filter((item) => item.eventId === event.id)
  const existingById = new Map(currentEventBands.map((item) => [item.id, item]))
  const draftByEventBandId = new Map(candidate.items.flatMap((item) =>
    item.eventBandId ? [[item.eventBandId, item] as const] : [],
  ))
  const seenIds = new Set<string>()
  const rowByDraftId = new Map<string, number>()
  let createdCount = 0
  let updatedCount = 0

  for (const row of table.rows) {
    const eventBandId = row.values['出演バンドID'].trim()
    if (eventBandId && seenIds.has(eventBandId)) {
      errors.push({ rowNumber: row.rowNumber, column: '出演バンドID', message: 'CSV内でIDが重複しています。' })
      continue
    }
    if (eventBandId) seenIds.add(eventBandId)
    const existing = eventBandId ? existingById.get(eventBandId) : undefined
    if (eventBandId && !existing) {
      errors.push({ rowNumber: row.rowNumber, column: '出演バンドID', message: '現在のイベントに存在しない出演バンドIDです。新規行では空欄にしてください。' })
      continue
    }
    const day = resolveEventDayId(event, eventDays, row.values['開催日ID'], row.values['開催日'])
    if (!day.ok) {
      errors.push({ rowNumber: row.rowNumber, column: '開催日ID', message: day.message })
      continue
    }
    const bandId = row.values['固定バンドID'].trim() || undefined
    if (bandId && !bands.some((band) => band.id === bandId)) {
      errors.push({ rowNumber: row.rowNumber, column: '固定バンドID', message: '固定バンドが見つかりません。' })
      continue
    }
    if (existing && existing.bandId !== bandId) {
      errors.push({ rowNumber: row.rowNumber, column: '固定バンドID', message: '既存出演バンドの作成元は変更できません。' })
      continue
    }
    const memberResult = resolveMemberList(
      splitListCell(row.values['メンバーID一覧']),
      splitListCell(row.values['メンバー名一覧']),
      members,
    )
    if (!memberResult.ok) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID一覧', message: memberResult.message })
      continue
    }
    const item: EventBandSettingsItemDraft = {
      draftId: eventBandId
        ? draftByEventBandId.get(eventBandId)?.draftId ?? `event-band-${eventBandId}`
        : createDraftId(),
      ...(eventBandId ? { eventBandId } : {}),
      eventId: event.id,
      eventDayId: day.eventDayId,
      ...(bandId ? { bandId } : {}),
      name: row.values['バンド名'],
      memberIds: memberResult.memberIds,
      durationMinutes: row.values['出演枠'].trim(),
    }
    rowByDraftId.set(item.draftId, row.rowNumber)
    if (eventBandId) {
      const index = candidate.items.findIndex((current) => current.eventBandId === eventBandId)
      if (index < 0) candidate.items.push(item)
      else candidate.items[index] = item
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
