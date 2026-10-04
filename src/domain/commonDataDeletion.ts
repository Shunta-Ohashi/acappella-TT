import type {
  Band,
  BandId,
  DutyAssignment,
  EventBand,
  EventMember,
  Member,
  MemberId,
  PaAssignment,
} from './models'

export type CommonMemberDeletionFailureReason =
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_REFERENCED'

export type CommonBandDeletionFailureReason =
  | 'BAND_NOT_FOUND'
  | 'BAND_REFERENCED'

export type CommonMemberDeletionCheck =
  | { ok: true }
  | { ok: false; reason: CommonMemberDeletionFailureReason }

export type CommonBandDeletionCheck =
  | { ok: true }
  | { ok: false; reason: CommonBandDeletionFailureReason }

export interface CommonMemberDeletionInput {
  memberId: MemberId
  members: readonly Member[]
  bands: readonly Pick<Band, 'defaultMemberIds'>[]
  eventMembers: readonly Pick<EventMember, 'memberId'>[]
  eventBands: readonly Pick<EventBand, 'memberIds'>[]
  paAssignments: readonly Pick<PaAssignment, 'memberId'>[]
  dutyAssignments: readonly Pick<DutyAssignment, 'memberId'>[]
}

export interface CommonBandDeletionInput {
  bandId: BandId
  bands: readonly Band[]
  eventBands: readonly Pick<EventBand, 'bandId'>[]
}

export type CommonMemberDeletionResult =
  | { ok: true; members: Member[] }
  | { ok: false; reason: CommonMemberDeletionFailureReason }

export type CommonBandDeletionResult =
  | { ok: true; bands: Band[] }
  | { ok: false; reason: CommonBandDeletionFailureReason }

export const checkCommonMemberDeletion = ({
  memberId,
  members,
  bands,
  eventMembers,
  eventBands,
  paAssignments,
  dutyAssignments,
}: CommonMemberDeletionInput): CommonMemberDeletionCheck => {
  if (!members.some((member) => member.id === memberId)) {
    return { ok: false, reason: 'MEMBER_NOT_FOUND' }
  }

  const isReferenced =
    bands.some((band) => band.defaultMemberIds.includes(memberId)) ||
    eventMembers.some((eventMember) => eventMember.memberId === memberId) ||
    eventBands.some((eventBand) => eventBand.memberIds.includes(memberId)) ||
    paAssignments.some((assignment) => assignment.memberId === memberId) ||
    dutyAssignments.some((assignment) => assignment.memberId === memberId)

  return isReferenced
    ? { ok: false, reason: 'MEMBER_REFERENCED' }
    : { ok: true }
}

export const createCommonMemberDeletion = (
  input: CommonMemberDeletionInput,
): CommonMemberDeletionResult => {
  const check = checkCommonMemberDeletion(input)
  if (!check.ok) return check

  return {
    ok: true,
    members: input.members.filter((member) => member.id !== input.memberId),
  }
}

export const checkCommonBandDeletion = ({
  bandId,
  bands,
  eventBands,
}: CommonBandDeletionInput): CommonBandDeletionCheck => {
  if (!bands.some((band) => band.id === bandId)) {
    return { ok: false, reason: 'BAND_NOT_FOUND' }
  }

  return eventBands.some((eventBand) => eventBand.bandId === bandId)
    ? { ok: false, reason: 'BAND_REFERENCED' }
    : { ok: true }
}

export const createCommonBandDeletion = (
  input: CommonBandDeletionInput,
): CommonBandDeletionResult => {
  const check = checkCommonBandDeletion(input)
  if (!check.ok) return check

  return {
    ok: true,
    bands: input.bands.filter((band) => band.id !== input.bandId),
  }
}
