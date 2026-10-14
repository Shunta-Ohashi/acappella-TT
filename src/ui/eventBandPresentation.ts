import type {
  EventBand,
  EventDay,
  EventDayId,
  Member,
  MemberId,
} from '../domain/models'

export interface EventBandMemberPresentation {
  memberId: MemberId
  displayName: string
  resolved: boolean
}

export const getMemberDisplayName = (
  member: Pick<Member, 'acaName' | 'realName'>,
): string => member.acaName?.trim() || member.realName

export const getEventBandMemberPresentations = (
  eventBand: Pick<EventBand, 'memberIds'>,
  members: Member[],
): EventBandMemberPresentation[] => {
  const memberById = new Map(members.map((member) => [member.id, member]))

  return eventBand.memberIds.map((memberId) => {
    const member = memberById.get(memberId)
    return {
      memberId,
      displayName: member ? getMemberDisplayName(member) : '不明なメンバー',
      resolved: member !== undefined,
    }
  })
}

export const getEventBandMemberDisplayNames = (
  eventBand: Pick<EventBand, 'memberIds'>,
  members: Member[],
): string[] => getEventBandMemberPresentations(eventBand, members)
  .map(member => member.displayName)

export const getEventBandItemsWithInvalidEventDay = <T extends {
  eventDayId: EventDayId
}>(
  items: readonly T[],
  eventDays: readonly Pick<EventDay, 'id'>[],
): T[] => {
  const validEventDayIds = new Set(eventDays.map(eventDay => eventDay.id))
  return items.filter(item => !validEventDayIds.has(item.eventDayId))
}
