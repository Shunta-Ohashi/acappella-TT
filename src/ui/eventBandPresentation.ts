import type { EventBand, EventDay, EventDayId, Member } from '../domain/models'

export const getMemberDisplayName = (
  member: Pick<Member, 'acaName' | 'realName'>,
): string => member.acaName?.trim() || member.realName

export const getEventBandMemberDisplayNames = (
  eventBand: Pick<EventBand, 'memberIds'>,
  members: Member[],
): string[] => {
  const memberById = new Map(members.map((member) => [member.id, member]))

  return eventBand.memberIds.map((memberId) => {
    const member = memberById.get(memberId)
    return member ? getMemberDisplayName(member) : '不明なメンバー'
  })
}

export const getEventBandItemsWithInvalidEventDay = <T extends {
  eventDayId: EventDayId
}>(
  items: readonly T[],
  eventDays: readonly Pick<EventDay, 'id'>[],
): T[] => {
  const validEventDayIds = new Set(eventDays.map(eventDay => eventDay.id))
  return items.filter(item => !validEventDayIds.has(item.eventDayId))
}
