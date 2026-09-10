import type {
  Band,
  Member,
  MemberId,
  PaCapabilities,
} from './models'

export type CommonMemberStatusFilter = 'active' | 'inactive' | 'all'

export interface CommonMemberDraft {
  realName: string
  acaName: string
  entryAcademicYear: string
  active: boolean
  paCapabilities: PaCapabilities
  notes: string
}

export interface CommonMemberValidationErrors {
  realName?: string
  entryAcademicYear?: string
  form?: string
}

interface CommonMemberUpdateInput {
  memberId: MemberId
  existingMember?: Member
  draft: CommonMemberDraft
}

export type CommonMemberUpdateResult =
  | { ok: true; member: Member }
  | { ok: false; errors: CommonMemberValidationErrors }

const normalizeOptionalText = (value: string): string | undefined => {
  const normalized = value.trim()
  return normalized || undefined
}

const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').trim().toLocaleLowerCase()

export const createCommonMemberDraft = (
  member?: Member,
): CommonMemberDraft => ({
  realName: member?.realName ?? '',
  acaName: member?.acaName ?? '',
  entryAcademicYear: member?.entryAcademicYear?.toString() ?? '',
  active: member?.active ?? true,
  paCapabilities: {
    main: member?.paCapabilities?.main ?? false,
    sub: member?.paCapabilities?.sub ?? false,
  },
  notes: member?.notes ?? '',
})

export const validateCommonMemberDraft = (
  draft: CommonMemberDraft,
): CommonMemberValidationErrors => {
  const errors: CommonMemberValidationErrors = {}
  const normalizedYear = draft.entryAcademicYear.trim()

  if (!draft.realName.trim()) {
    errors.realName = '本名を入力してください。'
  }

  if (normalizedYear) {
    const numericYear = Number(normalizedYear)
    if (
      !/^\d+$/.test(normalizedYear) ||
      !Number.isSafeInteger(numericYear) ||
      numericYear < 1
    ) {
      errors.entryAcademicYear = '入学年度は1以上の整数で入力してください。'
    }
  }

  return errors
}

export const createCommonMemberUpdate = ({
  memberId,
  existingMember,
  draft,
}: CommonMemberUpdateInput): CommonMemberUpdateResult => {
  const errors = validateCommonMemberDraft(draft)
  if (errors.realName || errors.entryAcademicYear) {
    return { ok: false, errors }
  }

  const normalizedEntryAcademicYear = draft.entryAcademicYear.trim()

  return {
    ok: true,
    member: {
      ...existingMember,
      id: existingMember?.id ?? memberId,
      realName: draft.realName.trim(),
      acaName: normalizeOptionalText(draft.acaName),
      entryAcademicYear: normalizedEntryAcademicYear
        ? Number(normalizedEntryAcademicYear)
        : undefined,
      notes: normalizeOptionalText(draft.notes),
      active: existingMember ? draft.active : true,
      paCapabilities: {
        main: draft.paCapabilities.main,
        sub: draft.paCapabilities.sub,
      },
    },
  }
}

export const filterCommonMembers = (
  members: Member[],
  searchText: string,
  statusFilter: CommonMemberStatusFilter,
): Member[] => {
  const normalizedSearchText = normalizeSearchText(searchText)

  return members.filter((member) => {
    if (statusFilter === 'active' && !member.active) return false
    if (statusFilter === 'inactive' && member.active) return false
    if (!normalizedSearchText) return true

    return [member.realName, member.acaName ?? ''].some((value) =>
      normalizeSearchText(value).includes(normalizedSearchText),
    )
  })
}

export const getBandsForMember = (
  memberId: MemberId,
  bands: Band[],
): Band[] => bands.filter((band) => band.defaultMemberIds.includes(memberId))
