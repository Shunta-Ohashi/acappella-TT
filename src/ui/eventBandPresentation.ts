import type { EventBand, Member } from '../domain/models'

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
