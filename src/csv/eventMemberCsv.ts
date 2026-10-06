import type {
  Event, EventDay, EventMember, EventMemberDay, Member, ParticipationStatus,
} from '../domain/models.ts'
import {
  hasEventMemberSettingsErrors,
  getEventMemberDayDraftErrorKey,
  validateEventMemberSettingsDraft,
  type EventMemberSettingsDraft,
} from '../domain/eventMemberSettings.ts'
import { type CsvImportError, type CsvImportPlan } from './csv.ts'
import { parseSpreadsheetCsvTable, serializeSpreadsheetCsv } from './spreadsheetCsv.ts'
import {
  formatTimeRange,
  getOrderedEventDays,
  parseAvailabilityCell,
  parsePreferredTimeRangeCell,
  resolveEventDayId,
} from './eventCsvShared.ts'
import { resolveMemberId } from './memberResolution.ts'

export const EVENT_MEMBER_CSV_HEADERS = [
  'メンバー', '開催日', '参加状態', 'Main PA', 'Sub PA', '出演可能時間帯',
  '希望時間帯', '備考', 'メンバーID', '開催日ID',
] as const

const EVENT_MEMBER_REQUIRED_HEADERS = ['メンバー', '開催日', '参加状態'] as const

const parseParticipation = (value: string): ParticipationStatus | undefined => {
  const normalized = value.trim().toLowerCase()
  if (['参加', 'participating'].includes(normalized)) return 'participating'
  if (['不参加', 'absent'].includes(normalized)) return 'absent'
  if (['未定', 'undecided'].includes(normalized)) return 'undecided'
  return undefined
}

const parseCapability = (value: string): boolean | undefined => {
  const normalized = value.trim().toLowerCase()
  if (['可', 'true', '1', 'yes'].includes(normalized)) return true
  if (['不可', 'false', '0', 'no'].includes(normalized)) return false
  return undefined
}

export const createEventMemberCsv = ({
  event, eventDays, members, draft,
}: {
  event: Event
  eventDays: EventDay[]
  members: Member[]
  draft: EventMemberSettingsDraft
}): string => {
  const memberById = new Map(members.map((member) => [member.id, member]))
  const dayById = new Map(getOrderedEventDays(event, eventDays).map((day) => [day.id, day]))
  return serializeSpreadsheetCsv([
    EVENT_MEMBER_CSV_HEADERS,
    ...draft.members.flatMap((memberDraft) => {
      const member = memberById.get(memberDraft.memberId)
      return memberDraft.days.map((dayDraft) => {
        const day = dayById.get(dayDraft.eventDayId)
        return [
          member?.acaName ?? member?.realName ?? '',
          day?.date ?? '',
          dayDraft.participationStatus === 'participating' ? '参加'
            : dayDraft.participationStatus === 'absent' ? '不参加' : '未定',
          memberDraft.paCapabilities.main ? '可' : '不可',
          memberDraft.paCapabilities.sub ? '可' : '不可',
          dayDraft.availabilityWindows?.map(formatTimeRange).join('|') ?? '',
          dayDraft.preferredTimeRange ? formatTimeRange(dayDraft.preferredTimeRange) : '',
          dayDraft.notes ?? '',
          memberDraft.memberId,
          dayDraft.eventDayId,
        ]
      })
    }),
  ])
}

export const planEventMemberCsvImport = ({
  csv, event, eventDays, members, eventMembers, eventMemberDays, draft, createDraftId,
}: {
  csv: string
  event: Event
  eventDays: EventDay[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  draft: EventMemberSettingsDraft
  createDraftId: () => string
}): CsvImportPlan<EventMemberSettingsDraft> => {
  const table = parseSpreadsheetCsvTable(csv, EVENT_MEMBER_REQUIRED_HEADERS)
  if (!table.ok) return table
  const errors: CsvImportError[] = []
  const candidate = structuredClone(draft)
  const importedRowByDraftId = new Map<string, number>()
  const importedRowByDayErrorKey = new Map<string, number>()
  const draftByMemberId = new Map(candidate.members.map((item) => [item.memberId, item]))
  const pairKeys = new Set<string>()
  const capabilityByMemberId = new Map<string, { main: boolean; sub: boolean }>()
  const createdMemberIds = new Set<string>()
  const updatedMemberIds = new Set<string>()
  const orderedDays = getOrderedEventDays(event, eventDays)

  for (const row of table.rows) {
    const memberResult = resolveMemberId(
      row.values['メンバーID'] ?? '',
      row.values['メンバー'] ?? '',
      members,
    )
    if (!memberResult.ok) {
      errors.push({ rowNumber: row.rowNumber, column: 'メンバーID', message: memberResult.message })
      continue
    }
    const dayResult = resolveEventDayId(
      event,
      eventDays,
      row.values['開催日ID'] ?? '',
      row.values['開催日'] ?? '',
    )
    if (!dayResult.ok) {
      errors.push({ rowNumber: row.rowNumber, column: '開催日ID', message: dayResult.message })
      continue
    }
    const pairKey = `${memberResult.memberId}:${dayResult.eventDayId}`
    if (pairKeys.has(pairKey)) {
      errors.push({ rowNumber: row.rowNumber, column: '開催日ID', message: '同じメンバーと開催日の行が重複しています。' })
      continue
    }
    pairKeys.add(pairKey)
    const existingDraft = draftByMemberId.get(memberResult.memberId)
    const mainValue = row.values['Main PA']?.trim() ?? ''
    const subValue = row.values['Sub PA']?.trim() ?? ''
    const participationStatus = parseParticipation(row.values['参加状態'] ?? '')
    const main = mainValue ? parseCapability(mainValue) : existingDraft?.paCapabilities.main ?? false
    const sub = subValue ? parseCapability(subValue) : existingDraft?.paCapabilities.sub ?? false
    const hasAvailability = Object.hasOwn(row.values, '出演可能時間帯')
    const hasPreferred = Object.hasOwn(row.values, '希望時間帯')
    const availability = hasAvailability
      ? parseAvailabilityCell(row.values['出演可能時間帯'])
      : { ok: true as const }
    const preferred = hasPreferred
      ? parsePreferredTimeRangeCell(row.values['希望時間帯'])
      : { ok: true as const }
    if (!participationStatus) errors.push({ rowNumber: row.rowNumber, column: '参加状態', message: '参加・不参加・未定のいずれかを入力してください。' })
    if (mainValue && main === undefined) errors.push({ rowNumber: row.rowNumber, column: 'Main PA', message: '可または不可を入力してください。' })
    if (subValue && sub === undefined) errors.push({ rowNumber: row.rowNumber, column: 'Sub PA', message: '可または不可を入力してください。' })
    if (!availability.ok) errors.push({ rowNumber: row.rowNumber, column: '出演可能時間帯', message: availability.message })
    if (!preferred.ok) errors.push({ rowNumber: row.rowNumber, column: '希望時間帯', message: preferred.message })
    if (!participationStatus || main === undefined || sub === undefined || !availability.ok || !preferred.ok) continue

    const previousCapability = capabilityByMemberId.get(memberResult.memberId)
    if (previousCapability && (previousCapability.main !== main || previousCapability.sub !== sub)) {
      errors.push({ rowNumber: row.rowNumber, column: 'Main PA / Sub PA', message: '同じメンバーのPA設定が開催日ごとに異なっています。' })
      continue
    }
    capabilityByMemberId.set(memberResult.memberId, { main, sub })

    let memberDraft = draftByMemberId.get(memberResult.memberId)
    if (!memberDraft) {
      memberDraft = {
        draftId: createDraftId(),
        memberId: memberResult.memberId,
        paCapabilities: { main, sub },
        days: orderedDays.map((day) => ({
          eventDayId: day.id,
          participationStatus: 'undecided' as const,
        })),
      }
      candidate.members.push(memberDraft)
      draftByMemberId.set(memberResult.memberId, memberDraft)
      createdMemberIds.add(memberResult.memberId)
    } else {
      memberDraft.paCapabilities = { main, sub }
      if (!createdMemberIds.has(memberResult.memberId)) {
        updatedMemberIds.add(memberResult.memberId)
      }
    }
    importedRowByDraftId.set(memberDraft.draftId, row.rowNumber)
    importedRowByDayErrorKey.set(
      getEventMemberDayDraftErrorKey(memberDraft.draftId, dayResult.eventDayId),
      row.rowNumber,
    )
    const dayDraft = memberDraft.days.find((day) => day.eventDayId === dayResult.eventDayId)
    if (!dayDraft) continue
    dayDraft.participationStatus = participationStatus
    if (hasAvailability) {
      if (availability.value === undefined) delete dayDraft.availabilityWindows
      else dayDraft.availabilityWindows = availability.value
    }
    if (hasPreferred) {
      if (preferred.value === undefined) delete dayDraft.preferredTimeRange
      else dayDraft.preferredTimeRange = preferred.value
    }
    if (Object.hasOwn(row.values, '備考')) {
      const notes = row.values['備考'].trim()
      if (notes) dayDraft.notes = notes
      else delete dayDraft.notes
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const validation = validateEventMemberSettingsDraft({
    event, eventDays, members, eventMembers, eventMemberDays, draft: candidate,
  })
  if (hasEventMemberSettingsErrors(validation)) {
    const domainErrors: CsvImportError[] = []
    Object.entries(validation.members).forEach(([draftId, message]) => domainErrors.push({
      rowNumber: importedRowByDraftId.get(draftId), column: 'データ', message,
    }))
    Object.entries(validation.days).forEach(([key, message]) => domainErrors.push({
      rowNumber: importedRowByDayErrorKey.get(key), column: 'データ', message,
    }))
    if (validation.form) domainErrors.push({ column: 'データ', message: validation.form })
    return { ok: false, errors: domainErrors }
  }
  return {
    ok: true,
    candidate,
    rowCount: table.rows.length,
    createdCount: createdMemberIds.size,
    updatedCount: updatedMemberIds.size,
  }
}
