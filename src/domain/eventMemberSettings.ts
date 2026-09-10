import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventId,
  EventMember,
  EventMemberDay,
  EventMemberDayId,
  EventMemberId,
  Member,
  MemberId,
  ParticipationStatus,
} from './models'

export interface EventMemberDaySettingsDraft {
  eventMemberDayId?: EventMemberDayId
  eventDayId: EventDayId
  participationStatus: ParticipationStatus
}

export interface EventMemberSettingsMemberDraft {
  draftId: string
  eventMemberId?: EventMemberId
  memberId: MemberId
  days: EventMemberDaySettingsDraft[]
}

export interface EventMemberSettingsDraft {
  members: EventMemberSettingsMemberDraft[]
}

export interface EventMemberSettingsValidationErrors {
  members: Record<string, string>
  days: Record<string, string>
  form?: string
}

interface ValidateEventMemberSettingsDraftInput {
  event: Event
  eventDays: EventDay[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  draft: EventMemberSettingsDraft
}

interface AddEventMembersToDraftInput {
  draft: EventMemberSettingsDraft
  event: Event
  eventDays: EventDay[]
  memberIds: MemberId[]
  newDraftIds: string[]
}

interface CreateEventMemberSettingsUpdateInput
  extends ValidateEventMemberSettingsDraftInput {
  eventBands: EventBand[]
  newEventMemberIds: EventMemberId[]
  newEventMemberDayIds: EventMemberDayId[]
}

export type EventMemberSettingsUpdateResult =
  | {
      ok: true
      eventMembers: EventMember[]
      eventMemberDays: EventMemberDay[]
    }
  | { ok: false; errors: EventMemberSettingsValidationErrors }

export const EVENT_MEMBER_DELETE_BLOCKED_MESSAGE =
  'このメンバーは出演バンドに登録されているため、イベントから削除できません。先に出演バンドのメンバー設定を変更してください。'

const participationStatuses = new Set<ParticipationStatus>([
  'participating',
  'absent',
  'undecided',
])

const getOrderedEventDays = (
  event: Pick<Event, 'id'>,
  eventDays: EventDay[],
): EventDay[] => eventDays
  .filter((eventDay) => eventDay.eventId === event.id)
  .sort((first, second) =>
    first.order - second.order ||
    first.date.localeCompare(second.date) ||
    first.id.localeCompare(second.id),
  )

export const getEventMemberDayDraftErrorKey = (
  memberDraftId: string,
  eventDayId: EventDayId,
): string => `${memberDraftId}:${eventDayId}`

export const createEventMemberSettingsDraft = (
  event: Event,
  eventDays: EventDay[],
  eventMembers: EventMember[],
  eventMemberDays: EventMemberDay[],
): EventMemberSettingsDraft => {
  const orderedEventDays = getOrderedEventDays(event, eventDays)
  const eventMemberDayByPair = new Map(
    eventMemberDays.map((eventMemberDay) => [
      `${eventMemberDay.eventMemberId}:${eventMemberDay.eventDayId}`,
      eventMemberDay,
    ]),
  )

  return {
    members: eventMembers
      .filter((eventMember) => eventMember.eventId === event.id)
      .map((eventMember) => ({
        draftId: `existing-${eventMember.id}`,
        eventMemberId: eventMember.id,
        memberId: eventMember.memberId,
        days: orderedEventDays.map((eventDay) => {
          const existing = eventMemberDayByPair.get(
            `${eventMember.id}:${eventDay.id}`,
          )

          return {
            eventMemberDayId: existing?.id,
            eventDayId: eventDay.id,
            participationStatus:
              existing?.participationStatus ?? 'undecided',
          }
        }),
      })),
  }
}

export const addEventMembersToDraft = ({
  draft,
  event,
  eventDays,
  memberIds,
  newDraftIds,
}: AddEventMembersToDraftInput): EventMemberSettingsDraft => {
  const existingMemberIds = new Set(
    draft.members.map((member) => member.memberId),
  )
  const uniqueNewMemberIds = [...new Set(memberIds)].filter(
    (memberId) => !existingMemberIds.has(memberId),
  )

  if (newDraftIds.length !== uniqueNewMemberIds.length) {
    throw new Error('A draft ID is required for every new EventMember')
  }

  const orderedEventDays = getOrderedEventDays(event, eventDays)
  return {
    members: [
      ...draft.members,
      ...uniqueNewMemberIds.map((memberId, index) => ({
        draftId: newDraftIds[index],
        memberId,
        days: orderedEventDays.map((eventDay) => ({
          eventDayId: eventDay.id,
          participationStatus: 'undecided' as const,
        })),
      })),
    ],
  }
}

export const getEventBandCountByMember = (
  eventId: EventId,
  eventBands: EventBand[],
): Map<MemberId, number> => {
  const counts = new Map<MemberId, number>()

  eventBands
    .filter((eventBand) => eventBand.eventId === eventId)
    .forEach((eventBand) => {
      new Set(eventBand.memberIds).forEach((memberId) => {
        counts.set(memberId, (counts.get(memberId) ?? 0) + 1)
      })
    })

  return counts
}

export const canDeleteEventMember = (
  memberId: MemberId,
  eventId: EventId,
  eventBands: Pick<EventBand, 'eventId' | 'memberIds'>[],
): boolean => !eventBands.some(
  (eventBand) =>
    eventBand.eventId === eventId && eventBand.memberIds.includes(memberId),
)

export const hasEventMemberSettingsErrors = (
  errors: EventMemberSettingsValidationErrors,
): boolean => Boolean(
  errors.form ||
  Object.keys(errors.members).length > 0 ||
  Object.keys(errors.days).length > 0,
)

export const validateEventMemberSettingsDraft = ({
  event,
  eventDays,
  members,
  eventMembers,
  eventMemberDays,
  draft,
}: ValidateEventMemberSettingsDraftInput): EventMemberSettingsValidationErrors => {
  const errors: EventMemberSettingsValidationErrors = {
    members: {},
    days: {},
  }
  const orderedEventDays = getOrderedEventDays(event, eventDays)
  const eventDayIds = new Set(orderedEventDays.map((eventDay) => eventDay.id))
  const memberIds = new Set(members.map((member) => member.id))
  const currentEventMembers = eventMembers.filter(
    (eventMember) => eventMember.eventId === event.id,
  )
  const currentEventMemberById = new Map(
    currentEventMembers.map((eventMember) => [eventMember.id, eventMember]),
  )
  const currentEventMemberByMemberId = new Map<MemberId, EventMember>()

  currentEventMembers.forEach((eventMember) => {
    if (currentEventMemberByMemberId.has(eventMember.memberId)) {
      errors.form = '同じメンバーのEventMemberが重複しています。'
    } else {
      currentEventMemberByMemberId.set(eventMember.memberId, eventMember)
    }
  })

  if (orderedEventDays.length === 0) {
    errors.form = '開催日が設定されていないためメンバー設定を保存できません。'
  }

  const eventMemberDayById = new Map(
    eventMemberDays.map((eventMemberDay) => [eventMemberDay.id, eventMemberDay]),
  )
  const seenExistingDayPairs = new Set<string>()
  const currentEventMemberIds = new Set(currentEventMemberById.keys())

  eventMemberDays.forEach((eventMemberDay) => {
    if (!currentEventMemberIds.has(eventMemberDay.eventMemberId)) return

    if (!eventDayIds.has(eventMemberDay.eventDayId)) {
      errors.form = '選択中のイベントに属さない開催日の参加情報があります。'
      return
    }

    const pairKey = `${eventMemberDay.eventMemberId}:${eventMemberDay.eventDayId}`
    if (seenExistingDayPairs.has(pairKey)) {
      errors.form = '同じメンバーと開催日の参加情報が重複しています。'
    }
    seenExistingDayPairs.add(pairKey)
  })

  const seenDraftMemberIds = new Set<MemberId>()
  draft.members.forEach((memberDraft) => {
    if (seenDraftMemberIds.has(memberDraft.memberId)) {
      errors.members[memberDraft.draftId] =
        '同じメンバーをイベントへ複数回追加することはできません。'
    }
    seenDraftMemberIds.add(memberDraft.memberId)

    if (!memberIds.has(memberDraft.memberId)) {
      errors.members[memberDraft.draftId] =
        '共通データに存在しないメンバーは追加できません。'
    }

    if (memberDraft.eventMemberId) {
      const existing = currentEventMemberById.get(memberDraft.eventMemberId)
      if (!existing || existing.memberId !== memberDraft.memberId) {
        errors.members[memberDraft.draftId] =
          '選択中のイベントに属さないEventMemberは保存できません。'
      }
    } else if (currentEventMemberByMemberId.has(memberDraft.memberId)) {
      errors.members[memberDraft.draftId] =
        '既存のEventMemberを新規データとして保存することはできません。'
    }

    const seenDayIds = new Set<EventDayId>()
    memberDraft.days.forEach((dayDraft) => {
      const errorKey = getEventMemberDayDraftErrorKey(
        memberDraft.draftId,
        dayDraft.eventDayId,
      )
      if (
        !eventDayIds.has(dayDraft.eventDayId) ||
        seenDayIds.has(dayDraft.eventDayId)
      ) {
        errors.days[errorKey] =
          '選択中のイベントに属する開催日を1件ずつ指定してください。'
      }
      seenDayIds.add(dayDraft.eventDayId)

      if (!participationStatuses.has(dayDraft.participationStatus)) {
        errors.days[errorKey] = '参加状況が正しくありません。'
      }

      if (dayDraft.eventMemberDayId) {
        const existing = eventMemberDayById.get(dayDraft.eventMemberDayId)
        if (
          !memberDraft.eventMemberId ||
          !existing ||
          existing.eventMemberId !== memberDraft.eventMemberId ||
          existing.eventDayId !== dayDraft.eventDayId
        ) {
          errors.days[errorKey] =
            'EventMemberDayの参照先が現在の設定と一致しません。'
        }
      }
    })

    orderedEventDays.forEach((eventDay) => {
      if (seenDayIds.has(eventDay.id)) return
      errors.days[
        getEventMemberDayDraftErrorKey(memberDraft.draftId, eventDay.id)
      ] = 'この開催日の参加状況を設定してください。'
    })
  })

  return errors
}

export const createEventMemberSettingsUpdate = ({
  event,
  eventDays,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  draft,
  newEventMemberIds,
  newEventMemberDayIds,
}: CreateEventMemberSettingsUpdateInput): EventMemberSettingsUpdateResult => {
  const errors = validateEventMemberSettingsDraft({
    event,
    eventDays,
    members,
    eventMembers,
    eventMemberDays,
    draft,
  })
  if (hasEventMemberSettingsErrors(errors)) return { ok: false, errors }

  const currentEventMembers = eventMembers.filter(
    (eventMember) => eventMember.eventId === event.id,
  )
  const currentEventMemberById = new Map(
    currentEventMembers.map((eventMember) => [eventMember.id, eventMember]),
  )
  const retainedEventMemberIds = new Set(
    draft.members.flatMap((memberDraft) =>
      memberDraft.eventMemberId ? [memberDraft.eventMemberId] : []),
  )
  const blockedDeletion = currentEventMembers.find(
    (eventMember) =>
      !retainedEventMemberIds.has(eventMember.id) &&
      !canDeleteEventMember(eventMember.memberId, event.id, eventBands),
  )

  if (blockedDeletion) {
    return {
      ok: false,
      errors: {
        members: {},
        days: {},
        form: EVENT_MEMBER_DELETE_BLOCKED_MESSAGE,
      },
    }
  }

  const newMemberCount = draft.members.filter(
    (memberDraft) => !memberDraft.eventMemberId,
  ).length
  const newDayCount = draft.members.reduce(
    (count, memberDraft) => count + memberDraft.days.filter(
      (dayDraft) => !dayDraft.eventMemberDayId,
    ).length,
    0,
  )
  if (newEventMemberIds.length !== newMemberCount) {
    throw new Error('An EventMember ID is required for every new EventMember')
  }
  if (newEventMemberDayIds.length !== newDayCount) {
    throw new Error(
      'An EventMemberDay ID is required for every new EventMemberDay',
    )
  }

  const existingEventMemberDayById = new Map(
    eventMemberDays.map((eventMemberDay) => [eventMemberDay.id, eventMemberDay]),
  )
  const orderedEventDays = getOrderedEventDays(event, eventDays)
  let newEventMemberIndex = 0
  let newEventMemberDayIndex = 0
  const updatedEventMembers: EventMember[] = []
  const updatedEventMemberDays: EventMemberDay[] = []

  draft.members.forEach((memberDraft) => {
    const existingEventMember = memberDraft.eventMemberId
      ? currentEventMemberById.get(memberDraft.eventMemberId)
      : undefined
    const eventMember: EventMember = existingEventMember ?? {
      id: newEventMemberIds[newEventMemberIndex++],
      eventId: event.id,
      memberId: memberDraft.memberId,
    }
    updatedEventMembers.push(eventMember)

    orderedEventDays.forEach((eventDay) => {
      const dayDraft = memberDraft.days.find(
        (candidate) => candidate.eventDayId === eventDay.id,
      )
      if (!dayDraft) return

      const existingEventMemberDay = dayDraft.eventMemberDayId
        ? existingEventMemberDayById.get(dayDraft.eventMemberDayId)
        : undefined
      updatedEventMemberDays.push(existingEventMemberDay
        ? {
            ...existingEventMemberDay,
            participationStatus: dayDraft.participationStatus,
          }
        : {
            id: newEventMemberDayIds[newEventMemberDayIndex++],
            eventMemberId: eventMember.id,
            eventDayId: eventDay.id,
            participationStatus: dayDraft.participationStatus,
          })
    })
  })

  const currentEventMemberIds = new Set(
    currentEventMembers.map((eventMember) => eventMember.id),
  )

  return {
    ok: true,
    eventMembers: [
      ...eventMembers.filter((eventMember) => eventMember.eventId !== event.id),
      ...updatedEventMembers,
    ],
    eventMemberDays: [
      ...eventMemberDays.filter(
        (eventMemberDay) =>
          !currentEventMemberIds.has(eventMemberDay.eventMemberId),
      ),
      ...updatedEventMemberDays,
    ],
  }
}
