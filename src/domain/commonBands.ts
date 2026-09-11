import type {
  Band,
  BandId,
  Member,
  MemberId,
} from './models'

export type CommonBandStatusFilter = 'active' | 'inactive' | 'all'

export interface CommonBandDraft {
  name: string
  defaultMemberIds: MemberId[]
  active: boolean
  notes: string
}

export interface CommonBandValidationErrors {
  name?: string
  defaultMemberIds?: string
  form?: string
}

interface CommonBandUpdateInput {
  bandId: BandId
  existingBand?: Band
  draft: CommonBandDraft
  members: Member[]
}

export type CommonBandUpdateResult =
  | { ok: true; band: Band }
  | { ok: false; errors: CommonBandValidationErrors }

export interface ResolvedCommonBandMember {
  memberId: MemberId
  member?: Member
  displayName: string
}

const normalizeOptionalText = (value: string): string | undefined => {
  const normalized = value.trim()
  return normalized || undefined
}

const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').trim().toLocaleLowerCase()

const uniqueMemberIds = (memberIds: MemberId[]): MemberId[] =>
  [...new Set(memberIds)]

export const createCommonBandDraft = (band?: Band): CommonBandDraft => ({
  name: band?.name ?? '',
  defaultMemberIds: uniqueMemberIds(band?.defaultMemberIds ?? []),
  active: band?.active ?? true,
  notes: band?.notes ?? '',
})

export const validateCommonBandDraft = (
  draft: CommonBandDraft,
  members: Member[],
  existingBand?: Band,
): CommonBandValidationErrors => {
  const errors: CommonBandValidationErrors = {}
  const normalizedMemberIds = uniqueMemberIds(draft.defaultMemberIds)

  if (!draft.name.trim()) {
    errors.name = 'バンド名を入力してください。'
  }

  if (normalizedMemberIds.length === 0) {
    errors.defaultMemberIds = 'メンバーを1人以上選択してください。'
  } else {
    const knownMemberIds = new Set(members.map((member) => member.id))
    const existingMemberIds = new Set(existingBand?.defaultMemberIds ?? [])
    const hasNewUnknownMember = normalizedMemberIds.some(
      (memberId) =>
        !knownMemberIds.has(memberId) && !existingMemberIds.has(memberId),
    )

    if (hasNewUnknownMember) {
      errors.defaultMemberIds =
        '登録されていないメンバーを新しく追加することはできません。'
    }
  }

  return errors
}

export const createCommonBandUpdate = ({
  bandId,
  existingBand,
  draft,
  members,
}: CommonBandUpdateInput): CommonBandUpdateResult => {
  const errors = validateCommonBandDraft(draft, members, existingBand)
  if (
    errors.name ||
    errors.defaultMemberIds
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    band: {
      ...existingBand,
      id: existingBand?.id ?? bandId,
      name: draft.name.trim(),
      defaultMemberIds: uniqueMemberIds(draft.defaultMemberIds),
      notes: normalizeOptionalText(draft.notes),
      active: existingBand ? draft.active : true,
    },
  }
}

export const filterCommonBands = (
  bands: Band[],
  searchText: string,
  statusFilter: CommonBandStatusFilter,
): Band[] => {
  const normalizedSearchText = normalizeSearchText(searchText)

  return bands.filter((band) => {
    if (statusFilter === 'active' && !band.active) return false
    if (statusFilter === 'inactive' && band.active) return false
    if (!normalizedSearchText) return true

    return normalizeSearchText(band.name).includes(normalizedSearchText)
  })
}

export const resolveCommonBandMembers = (
  band: Pick<Band, 'defaultMemberIds'>,
  members: Member[],
): ResolvedCommonBandMember[] => {
  const memberById = new Map(members.map((member) => [member.id, member]))

  return uniqueMemberIds(band.defaultMemberIds).map((memberId) => {
    const member = memberById.get(memberId)
    return {
      memberId,
      member,
      displayName: member?.realName ?? '不明なメンバー',
    }
  })
}
