import type {
  Band,
  BandId,
  Event,
  EventBand,
  EventBandId,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  ScheduleItem,
  TimeRange,
} from './models'
import {
  formatMinuteAsLocalTime,
  parseLocalTimeToMinute,
} from './timeline.ts'

export interface EventBandSettingsItemDraft {
  draftId: string
  eventBandId?: EventBandId
  eventId: Event['id']
  eventDayId: EventDayId
  bandId?: BandId
  name: string
  memberIds: MemberId[]
  durationMinutes: string
}

export interface EventBandSettingsDraft {
  items: EventBandSettingsItemDraft[]
}

export interface EventBandSettingsItemErrors {
  eventDayId?: string
  name?: string
  memberIds?: string
  durationMinutes?: string
  form?: string
}

export interface EventBandSettingsValidationErrors {
  items: Record<string, EventBandSettingsItemErrors>
  form?: string
}

export type EventBandSettingsUpdateResult =
  | { ok: true; eventBands: EventBand[] }
  | { ok: false; errors: EventBandSettingsValidationErrors }

export interface FixedBandDraftResult {
  draft: EventBandSettingsItemDraft
  unregisteredDefaultMemberIds: MemberId[]
}

export type EventBandDayFeasibilityStatus = 'available' | 'warning' | 'blocked'

export interface EventBandDayFeasibility {
  eventDayId: EventDayId
  status: EventBandDayFeasibilityStatus
  commonAvailabilityWindows?: TimeRange[]
  blockingReasons: string[]
  warnings: string[]
}

interface MinuteWindow {
  start: number
  end: number
}

const MINUTES_PER_DAY = 24 * 60

const toMinuteWindows = (
  windows: TimeRange[] | undefined,
): MinuteWindow[] => windows === undefined
  ? [{ start: 0, end: MINUTES_PER_DAY }]
  : windows.map((window) => ({
      start: window.from ? parseLocalTimeToMinute(window.from) : 0,
      end: window.until
        ? parseLocalTimeToMinute(window.until)
        : MINUTES_PER_DAY,
    }))

const intersectMinuteWindows = (
  leftWindows: MinuteWindow[],
  rightWindows: MinuteWindow[],
): MinuteWindow[] => {
  const intersections = leftWindows.flatMap((left) =>
    rightWindows.flatMap((right) => {
      const start = Math.max(left.start, right.start)
      const end = Math.min(left.end, right.end)
      return start < end ? [{ start, end }] : []
    }),
  ).sort((left, right) => left.start - right.start || left.end - right.end)

  return intersections.reduce<MinuteWindow[]>((merged, window) => {
    const previous = merged.at(-1)
    if (!previous || window.start > previous.end) {
      merged.push({ ...window })
    } else {
      previous.end = Math.max(previous.end, window.end)
    }
    return merged
  }, [])
}

const fromMinuteWindow = ({ start, end }: MinuteWindow): TimeRange => {
  if (start === 0 && end === MINUTES_PER_DAY) return { from: '00:00' }
  if (start === 0) return { until: formatMinuteAsLocalTime(end) }
  if (end === MINUTES_PER_DAY) return { from: formatMinuteAsLocalTime(start) }
  return {
    from: formatMinuteAsLocalTime(start),
    until: formatMinuteAsLocalTime(end),
  }
}

export const getEventBandDayFeasibility = ({
  event,
  eventDayId,
  memberIds,
  durationMinutes,
  members,
  eventMembers,
  eventMemberDays,
}: {
  event: Event
  eventDayId: EventDayId
  memberIds: MemberId[]
  durationMinutes: number
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventBandDayFeasibility => {
  const memberById = new Map(members.map((member) => [member.id, member]))
  const eventMemberByMemberId = new Map(
    eventMembers
      .filter((eventMember) => eventMember.eventId === event.id)
      .map((eventMember) => [eventMember.memberId, eventMember]),
  )
  const eventMemberDayByKey = new Map(eventMemberDays.map((day) => [
    `${day.eventMemberId}:${day.eventDayId}`,
    day,
  ]))
  const blockingReasons: string[] = []
  const warnings: string[] = []
  let commonWindows: MinuteWindow[] = [{ start: 0, end: MINUTES_PER_DAY }]

  for (const memberId of [...new Set(memberIds)]) {
    const memberName = memberById.get(memberId)?.realName ?? '不明なメンバー'
    const eventMember = eventMemberByMemberId.get(memberId)
    const eventMemberDay = eventMember
      ? eventMemberDayByKey.get(`${eventMember.id}:${eventDayId}`)
      : undefined

    if (!eventMemberDay) {
      blockingReasons.push(
        `${memberName}さんの参加設定がありません。Step 3で設定してください。`,
      )
      commonWindows = []
      continue
    }
    if (eventMemberDay.participationStatus === 'absent') {
      blockingReasons.push(`${memberName}さんが不参加です。`)
      commonWindows = []
      continue
    }
    if (eventMemberDay.participationStatus === 'undecided') {
      warnings.push(`${memberName}さんの参加状況が未定です。`)
    }
    commonWindows = intersectMinuteWindows(
      commonWindows,
      toMinuteWindows(eventMemberDay.availabilityWindows),
    )
  }

  if (memberIds.length > 0 && blockingReasons.length === 0) {
    if (commonWindows.length === 0) {
      blockingReasons.push('全員が同時に参加可能な時間帯がありません。')
    } else if (
      Number.isFinite(durationMinutes) &&
      durationMinutes > 0 &&
      !commonWindows.some((window) => window.end - window.start >= durationMinutes)
    ) {
      blockingReasons.push(
        `出演時間${durationMinutes}分を確保できる共通の参加可能時間がありません。`,
      )
    }
  }

  const commonAvailabilityWindows = commonWindows.length === 1 &&
    commonWindows[0].start === 0 &&
    commonWindows[0].end === MINUTES_PER_DAY
    ? undefined
    : commonWindows.map(fromMinuteWindow)

  return {
    eventDayId,
    status: blockingReasons.length > 0
      ? 'blocked'
      : warnings.length > 0
        ? 'warning'
        : 'available',
    ...(commonAvailabilityWindows !== undefined
      ? { commonAvailabilityWindows }
      : {}),
    blockingReasons,
    warnings,
  }
}

const isPerformanceReference = (
  scheduleItem: ScheduleItem,
  eventBandId: EventBandId,
): boolean => scheduleItem.kind === 'performance' &&
  scheduleItem.eventBandId === eventBandId

export const isEventBandScheduled = (
  eventBandId: EventBandId,
  scheduleItems: ScheduleItem[],
): boolean => scheduleItems.some((item) =>
  isPerformanceReference(item, eventBandId),
)

export const canDeleteEventBand = (
  eventBandId: EventBandId,
  scheduleItems: ScheduleItem[],
): boolean => !isEventBandScheduled(eventBandId, scheduleItems)

export const canChangeEventBandDay = canDeleteEventBand

export const getEventBandSourceLabel = (
  eventBand: Pick<EventBand, 'bandId'>,
): string => eventBand.bandId ? '固定バンド由来' : 'イベント限定'

export const createEventBandSettingsDraft = (
  event: Event,
  eventBands: EventBand[],
): EventBandSettingsDraft => ({
  items: eventBands
    .filter((eventBand) => eventBand.eventId === event.id)
    .map((eventBand) => ({
      draftId: `event-band-${eventBand.id}`,
      eventBandId: eventBand.id,
      eventId: eventBand.eventId,
      eventDayId: eventBand.eventDayId,
      ...(eventBand.bandId ? { bandId: eventBand.bandId } : {}),
      name: eventBand.name,
      memberIds: [...eventBand.memberIds],
      durationMinutes: String(eventBand.durationMinutes),
    })),
})

export const createEventOnlyBandDraft = ({
  draftId,
  event,
  eventDayId,
}: {
  draftId: string
  event: Event
  eventDayId: EventDayId
}): EventBandSettingsItemDraft => ({
  draftId,
  eventId: event.id,
  eventDayId,
  name: '',
  memberIds: [],
  durationMinutes: '',
})

export const createFixedBandDraft = ({
  draftId,
  event,
  eventDayId,
  band,
  eventMembers,
}: {
  draftId: string
  event: Event
  eventDayId: EventDayId
  band: Band
  eventMembers: EventMember[]
}): FixedBandDraftResult => {
  const eventMemberIds = new Set(
    eventMembers
      .filter((eventMember) => eventMember.eventId === event.id)
      .map((eventMember) => eventMember.memberId),
  )
  const defaultMemberIds = [...new Set(band.defaultMemberIds)]

  return {
    draft: {
      draftId,
      eventId: event.id,
      eventDayId,
      bandId: band.id,
      name: band.name,
      memberIds: defaultMemberIds.filter((memberId) =>
        eventMemberIds.has(memberId),
      ),
      durationMinutes: '',
    },
    unregisteredDefaultMemberIds: defaultMemberIds.filter((memberId) =>
      !eventMemberIds.has(memberId),
    ),
  }
}

export const validateEventBandSettingsItem = ({
  item,
  event,
  eventDays,
  members,
  bands,
  performanceSlotMinutes,
}: {
  item: EventBandSettingsItemDraft
  event: Event
  eventDays: EventDay[]
  members: Member[]
  bands: Band[]
  performanceSlotMinutes: number[]
}): EventBandSettingsItemErrors => {
  const errors: EventBandSettingsItemErrors = {}
  const eventDay = eventDays.find((candidate) =>
    candidate.id === item.eventDayId && candidate.eventId === event.id,
  )
  const uniqueMemberIds = new Set(item.memberIds)
  const memberIds = new Set(members.map((member) => member.id))
  const durationMinutes = Number(item.durationMinutes)

  if (item.eventId !== event.id) {
    errors.form = '別のイベントの出演バンドは編集できません。'
  }
  if (!eventDay) {
    errors.eventDayId = '出演日を選択してください。'
  }
  if (!item.name.trim()) {
    errors.name = 'バンド名を入力してください。'
  }
  if (
    !Number.isFinite(durationMinutes) ||
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    errors.durationMinutes = '出演時間は1分以上の整数で入力してください。'
  } else if (
    !performanceSlotMinutes.includes(durationMinutes)
  ) {
    errors.durationMinutes = 'イベントに設定された出演枠を選択してください。'
  }
  if (item.memberIds.length === 0) {
    errors.memberIds = '出演メンバーを1人以上選択してください。'
  } else if (uniqueMemberIds.size !== item.memberIds.length) {
    errors.memberIds = '同じメンバーを重複して選択できません。'
  } else if (item.memberIds.some((memberId) => !memberIds.has(memberId))) {
    errors.memberIds = '存在しないメンバーが含まれています。'
  }
  if (item.bandId && !bands.some((band) => band.id === item.bandId)) {
    errors.form = '作成元の固定バンドが見つかりません。'
  }

  return errors
}

export const hasEventBandSettingsItemErrors = (
  errors: EventBandSettingsItemErrors,
): boolean => Object.values(errors).some(Boolean)

export const validateEventBandSettingsDraft = ({
  draft,
  event,
  eventDays,
  members,
  bands,
  eventMembers,
  eventMemberDays,
}: {
  draft: EventBandSettingsDraft
  event: Event
  eventDays: EventDay[]
  members: Member[]
  bands: Band[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventBandSettingsValidationErrors => {
  const errors: EventBandSettingsValidationErrors = {
    items: {},
  }
  const draftIds = new Set<string>()
  const eventBandIds = new Set<EventBandId>()

  for (const item of draft.items) {
    const itemErrors = validateEventBandSettingsItem({
      item,
      event,
      eventDays,
      members,
      bands,
      performanceSlotMinutes: event.performanceSlotMinutes,
    })
    if (hasEventBandSettingsItemErrors(itemErrors)) {
      errors.items[item.draftId] = itemErrors
    }
    if (!hasEventBandSettingsItemErrors(itemErrors)) {
      const feasibility = getEventBandDayFeasibility({
        event,
        eventDayId: item.eventDayId,
        memberIds: item.memberIds,
        durationMinutes: Number(item.durationMinutes),
        members,
        eventMembers,
        eventMemberDays,
      })
      if (feasibility.status === 'blocked') {
        errors.items[item.draftId] = {
          form: feasibility.blockingReasons.join(' '),
        }
      }
    }
    if (draftIds.has(item.draftId)) {
      errors.form = '同じ出演バンドdraftが重複しています。'
    }
    draftIds.add(item.draftId)
    if (item.eventBandId) {
      if (eventBandIds.has(item.eventBandId)) {
        errors.items[item.draftId] = {
          ...errors.items[item.draftId],
          form: '同じ出演バンドが重複しています。',
        }
      }
      eventBandIds.add(item.eventBandId)
    }
  }

  return errors
}

export const hasEventBandSettingsErrors = (
  errors: EventBandSettingsValidationErrors,
): boolean => Boolean(errors.form) || Object.keys(errors.items).length > 0

export const createEventBandSettingsUpdate = ({
  event,
  eventDays,
  members,
  bands,
  eventBands,
  eventMembers,
  eventMemberDays,
  scheduleItems,
  draft,
  newEventBandIds,
}: {
  event: Event
  eventDays: EventDay[]
  members: Member[]
  bands: Band[]
  eventBands: EventBand[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  scheduleItems: ScheduleItem[]
  draft: EventBandSettingsDraft
  newEventBandIds: EventBandId[]
}): EventBandSettingsUpdateResult => {
  const errors = validateEventBandSettingsDraft({
    draft,
    event,
    eventDays,
    members,
    bands,
    eventMembers,
    eventMemberDays,
  })
  const currentEventBands = eventBands.filter((eventBand) =>
    eventBand.eventId === event.id,
  )
  const currentById = new Map(
    currentEventBands.map((eventBand) => [eventBand.id, eventBand]),
  )
  const retainedIds = new Set(
    draft.items.flatMap((item) => item.eventBandId ? [item.eventBandId] : []),
  )

  for (const eventBand of currentEventBands) {
    if (
      !retainedIds.has(eventBand.id) &&
      isEventBandScheduled(eventBand.id, scheduleItems)
    ) {
      errors.form = `「${eventBand.name}」はタイムテーブルに配置されているため削除できません。先にStep 7でPoolへ戻してください。`
      break
    }
  }

  for (const item of draft.items) {
    if (!item.eventBandId) continue
    const existing = currentById.get(item.eventBandId)
    if (!existing) {
      errors.items[item.draftId] = {
        ...errors.items[item.draftId],
        form: '編集する出演バンドが見つかりません。',
      }
      continue
    }
    if (existing.bandId !== item.bandId) {
      errors.items[item.draftId] = {
        ...errors.items[item.draftId],
        form: '作成元の固定バンドは変更できません。',
      }
    }
    if (
      existing.eventDayId !== item.eventDayId &&
      isEventBandScheduled(existing.id, scheduleItems)
    ) {
      errors.items[item.draftId] = {
        ...errors.items[item.draftId],
        eventDayId: 'タイムテーブルに配置済みのため出演日を変更できません。先にStep 7でPoolへ戻してください。',
      }
    }
  }

  if (hasEventBandSettingsErrors(errors)) return { ok: false, errors }

  const newItems = draft.items.filter((item) => !item.eventBandId)
  const allExistingIds = new Set(eventBands.map((eventBand) => eventBand.id))
  const uniqueNewIds = new Set(newEventBandIds)
  if (
    newItems.length !== newEventBandIds.length ||
    uniqueNewIds.size !== newEventBandIds.length ||
    newEventBandIds.some((id) => !id || allExistingIds.has(id))
  ) {
    return {
      ok: false,
      errors: {
        items: {},
        form: '新しい出演バンドのIDを生成できませんでした。',
      },
    }
  }

  let newIdIndex = 0
  const updatedForEvent = draft.items.map((item): EventBand => {
    const existing = item.eventBandId
      ? currentById.get(item.eventBandId)
      : undefined
    const editableFields = {
      eventId: event.id,
      eventDayId: item.eventDayId,
      name: item.name.trim(),
      memberIds: [...item.memberIds],
      durationMinutes: Number(item.durationMinutes),
    }

    if (existing) return { ...existing, ...editableFields }
    return {
      id: newEventBandIds[newIdIndex++],
      ...editableFields,
      ...(item.bandId ? { bandId: item.bandId } : {}),
    }
  })

  return {
    ok: true,
    eventBands: [
      ...eventBands.filter((eventBand) => eventBand.eventId !== event.id),
      ...updatedForEvent,
    ],
  }
}
