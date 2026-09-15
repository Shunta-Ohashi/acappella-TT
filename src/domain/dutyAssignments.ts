import type {
  DutyAssignment,
  DutyAssignmentId,
  DutyType,
  DutyTypeId,
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  ScheduleBoundary,
  Stage,
  StageId,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import { isIntervalWithinAvailabilityWindows } from './eventBandSettings.ts'
import {
  getOverlappingMemberPerformances,
  resolvePaAssignmentInterval,
} from './paAssignments.ts'
import {
  intervalsOverlap,
  resolveScheduleBoundaryInterval,
  type ResolvedScheduleInterval,
  type ResolveScheduleIntervalResult,
} from './scheduleBoundaries.ts'

export interface DutyTypeDraftItem {
  draftId: string
  dutyTypeId?: DutyTypeId
  name: string
}

export interface DutyAssignmentDraftItem {
  draftId: string
  dutyAssignmentId?: DutyAssignmentId
  dutyTypeDraftId?: string
  missingDutyTypeId?: DutyTypeId
  eventDayId: EventDayId
  stageId: StageId
  memberId: string
  from: ScheduleBoundary
  until: ScheduleBoundary
}

export interface DutySettingsDraft {
  dutyTypes: DutyTypeDraftItem[]
  assignments: DutyAssignmentDraftItem[]
}

export interface DutyTypeItemErrors {
  name?: string
  form?: string
}

export interface DutyAssignmentItemErrors {
  dutyTypeId?: string
  stageId?: string
  memberId?: string
  interval?: string
  availability?: string
  conflict?: string
  form?: string
}

export interface DutySettingsValidationErrors {
  dutyTypes: Record<string, DutyTypeItemErrors>
  assignments: Record<string, DutyAssignmentItemErrors>
  form?: string
}

export type DutySettingsUpdateResult =
  | {
      ok: true
      dutyTypes: DutyType[]
      dutyAssignments: DutyAssignment[]
    }
  | { ok: false; errors: DutySettingsValidationErrors }

export interface DutyMemberCandidate {
  member: Member
  participationStatus: EventMemberDay['participationStatus']
  warning?: string
}

interface DutyAssignmentScope {
  eventDayId: EventDayId
  stageId: StageId
  from: ScheduleBoundary
  until: ScheduleBoundary
}

export const resolveDutyAssignmentInterval = (
  assignment: DutyAssignmentScope,
  calculatedItems: CalculatedScheduleItem[],
): ResolveScheduleIntervalResult => resolveScheduleBoundaryInterval(
  assignment,
  calculatedItems,
  '一般業務担当',
)

const normalizeDutyTypeName = (name: string): string =>
  name.trim().toLocaleLowerCase('ja')

export const validateDutyTypeDrafts = (
  dutyTypes: DutyTypeDraftItem[],
): Record<string, DutyTypeItemErrors> => {
  const errors: Record<string, DutyTypeItemErrors> = {}
  const countByName = new Map<string, number>()

  dutyTypes.forEach((dutyType) => {
    const normalizedName = normalizeDutyTypeName(dutyType.name)
    if (normalizedName) {
      countByName.set(normalizedName, (countByName.get(normalizedName) ?? 0) + 1)
    }
  })

  dutyTypes.forEach((dutyType) => {
    const normalizedName = normalizeDutyTypeName(dutyType.name)
    if (!normalizedName) {
      errors[dutyType.draftId] = { name: '仕事名を入力してください。' }
    } else if ((countByName.get(normalizedName) ?? 0) > 1) {
      errors[dutyType.draftId] = {
        name: '同じイベント内で同名の仕事を重複して登録できません。',
      }
    }
  })

  return errors
}

export const canDeleteDutyType = (
  dutyType: Pick<DutyTypeDraftItem, 'draftId' | 'dutyTypeId'>,
  draftAssignments: Pick<DutyAssignmentDraftItem, 'dutyTypeDraftId'>[],
  persistedAssignments: Pick<DutyAssignment, 'dutyTypeId'>[],
): boolean =>
  !draftAssignments.some((assignment) =>
    assignment.dutyTypeDraftId === dutyType.draftId,
  ) &&
  (!dutyType.dutyTypeId || !persistedAssignments.some((assignment) =>
    assignment.dutyTypeId === dutyType.dutyTypeId,
  ))

export const getDutyAssignmentsForEvent = ({
  event,
  stages,
  dutyTypes,
  dutyAssignments,
}: {
  event: Pick<Event, 'id'>
  stages: Pick<Stage, 'id'>[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
}): DutyAssignment[] => {
  const eventDutyTypeIds = new Set(
    dutyTypes
      .filter((dutyType) => dutyType.eventId === event.id)
      .map((dutyType) => dutyType.id),
  )
  const allDutyTypeIds = new Set(dutyTypes.map((dutyType) => dutyType.id))
  const eventStageIds = new Set(stages.map((stage) => stage.id))

  return dutyAssignments.filter((assignment) =>
    eventDutyTypeIds.has(assignment.dutyTypeId) ||
    (
      eventStageIds.has(assignment.stageId) &&
      !allDutyTypeIds.has(assignment.dutyTypeId)
    ),
  )
}

export const moveDutyTypeDraft = (
  dutyTypes: DutyTypeDraftItem[],
  draftId: string,
  direction: -1 | 1,
): DutyTypeDraftItem[] => {
  const index = dutyTypes.findIndex((dutyType) => dutyType.draftId === draftId)
  const destinationIndex = index + direction
  if (index < 0 || destinationIndex < 0 || destinationIndex >= dutyTypes.length) {
    return dutyTypes
  }

  const reordered = [...dutyTypes]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(destinationIndex, 0, moved)
  return reordered
}

const getMemberDay = ({
  event,
  eventDayId,
  memberId,
  eventMembers,
  eventMemberDays,
}: {
  event: Event
  eventDayId: EventDayId
  memberId: string
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventMemberDay | undefined => {
  const eventMember = eventMembers.find((candidate) =>
    candidate.eventId === event.id && candidate.memberId === memberId,
  )
  return eventMember
    ? eventMemberDays.find((candidate) =>
        candidate.eventMemberId === eventMember.id &&
        candidate.eventDayId === eventDayId,
      )
    : undefined
}

export const getDutyMemberCandidates = ({
  event,
  eventDayId,
  members,
  eventMembers,
  eventMemberDays,
}: {
  event: Event
  eventDayId: EventDayId
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): DutyMemberCandidate[] => {
  const memberById = new Map(members.map((member) => [member.id, member]))

  return eventMembers
    .filter((eventMember) => eventMember.eventId === event.id)
    .flatMap((eventMember): DutyMemberCandidate[] => {
      const member = memberById.get(eventMember.memberId)
      const memberDay = eventMemberDays.find((candidate) =>
        candidate.eventMemberId === eventMember.id &&
        candidate.eventDayId === eventDayId,
      )
      if (!member || !memberDay || memberDay.participationStatus === 'absent') {
        return []
      }
      return [{
        member,
        participationStatus: memberDay.participationStatus,
        ...(memberDay.participationStatus === 'undecided'
          ? { warning: 'この開催日の参加状況が未定です。' }
          : {}),
      }]
    })
    .sort((first, second) =>
      first.member.realName.localeCompare(second.member.realName, 'ja') ||
      first.member.id.localeCompare(second.member.id),
    )
}

export const getDutyAssignmentParticipationWarning = ({
  item,
  event,
  eventMembers,
  eventMemberDays,
}: {
  item: Pick<DutyAssignmentDraftItem, 'eventDayId' | 'memberId'>
  event: Event
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): string | undefined => getMemberDay({
  event,
  eventDayId: item.eventDayId,
  memberId: item.memberId,
  eventMembers,
  eventMemberDays,
})?.participationStatus === 'undecided'
  ? 'このメンバーの参加状況は未定です。'
  : undefined

export const validateDutyAssignmentDraftItem = ({
  item,
  dutyTypes,
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  paAssignments,
  calculatedItems,
}: {
  item: DutyAssignmentDraftItem
  dutyTypes: DutyTypeDraftItem[]
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  paAssignments: PaAssignment[]
  calculatedItems: CalculatedScheduleItem[]
}): DutyAssignmentItemErrors => {
  const errors: DutyAssignmentItemErrors = {}
  const eventDayExists = eventDays.some((eventDay) =>
    eventDay.id === item.eventDayId && eventDay.eventId === event.id,
  )
  const stage = stages.find((candidate) => candidate.id === item.stageId)
  const member = members.find((candidate) => candidate.id === item.memberId)
  const memberDay = getMemberDay({
    event,
    eventDayId: item.eventDayId,
    memberId: item.memberId,
    eventMembers,
    eventMemberDays,
  })

  const hasValidDutyType = item.dutyTypeDraftId !== undefined &&
    dutyTypes.some((dutyType) => dutyType.draftId === item.dutyTypeDraftId)
  const preservesMissingDutyType = item.dutyAssignmentId !== undefined &&
    item.dutyTypeDraftId === undefined &&
    item.missingDutyTypeId !== undefined
  if (!hasValidDutyType && !preservesMissingDutyType) {
    errors.dutyTypeId = '仕事の種類を選択してください。'
  }
  if (!eventDayExists) {
    errors.form = '一般業務担当の開催日が正しくありません。'
  }
  if (!stage || stage.eventDayId !== item.eventDayId) {
    errors.stageId = '同じ開催日のStageを選択してください。'
  }
  if (!item.memberId || !member) {
    errors.memberId = '担当メンバーを選択してください。'
  } else if (!memberDay) {
    errors.memberId = 'この開催日の参加情報が設定されていません。'
  } else if (memberDay.participationStatus === 'absent') {
    errors.memberId = 'この開催日に不参加のメンバーは選択できません。'
  }

  const resolution = resolveDutyAssignmentInterval(item, calculatedItems)
  if (!resolution.ok) {
    errors.interval = resolution.reason
  } else if (
    memberDay && memberDay.participationStatus !== 'absent' &&
    !isIntervalWithinAvailabilityWindows(
      memberDay.availabilityWindows,
      resolution.interval.fromMinute,
      resolution.interval.untilMinute,
    )
  ) {
    errors.availability = '一般業務の担当時間がメンバーの出演可能時間外です。'
  }

  if (resolution.ok && member) {
    if (getOverlappingMemberPerformances({
      memberId: member.id,
      eventDayId: item.eventDayId,
      interval: resolution.interval,
      eventBands,
      calculatedItems,
    }).length > 0) {
      errors.conflict = '一般業務の担当時間中にこのメンバー自身の出演があります。'
    } else if (paAssignments.some((assignment) => {
      if (
        assignment.memberId !== member.id ||
        assignment.eventDayId !== item.eventDayId
      ) return false
      const paResolution = resolvePaAssignmentInterval(assignment, calculatedItems)
      return paResolution.ok && intervalsOverlap(
        resolution.interval,
        paResolution.interval,
      )
    })) {
      errors.conflict = '一般業務とPAの担当時間が重複しています。'
    }
  }

  return errors
}

export const hasDutyAssignmentItemErrors = (
  errors: DutyAssignmentItemErrors,
): boolean => Object.values(errors).some(Boolean)

export const validateDutySettingsDraft = ({
  draft,
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  paAssignments,
  calculatedItems,
}: {
  draft: DutySettingsDraft
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  paAssignments: PaAssignment[]
  calculatedItems: CalculatedScheduleItem[]
}): DutySettingsValidationErrors => {
  const errors: DutySettingsValidationErrors = {
    dutyTypes: validateDutyTypeDrafts(draft.dutyTypes),
    assignments: {},
  }
  const draftIds = new Set<string>()
  const assignmentIds = new Set<DutyAssignmentId>()

  draft.assignments.forEach((item) => {
    const itemErrors = validateDutyAssignmentDraftItem({
      item,
      dutyTypes: draft.dutyTypes,
      event,
      eventDays,
      stages,
      members,
      eventMembers,
      eventMemberDays,
      eventBands,
      paAssignments,
      calculatedItems,
    })
    if (hasDutyAssignmentItemErrors(itemErrors)) {
      errors.assignments[item.draftId] = itemErrors
    }
    if (draftIds.has(item.draftId)) {
      errors.form = '同じ一般業務担当draftが重複しています。'
    }
    draftIds.add(item.draftId)
    if (item.dutyAssignmentId) {
      if (assignmentIds.has(item.dutyAssignmentId)) {
        errors.assignments[item.draftId] = {
          ...errors.assignments[item.draftId],
          form: '同じ一般業務担当が重複しています。',
        }
      }
      assignmentIds.add(item.dutyAssignmentId)
    }
  })

  for (let firstIndex = 0; firstIndex < draft.assignments.length; firstIndex += 1) {
    const first = draft.assignments[firstIndex]
    const firstResolution = resolveDutyAssignmentInterval(first, calculatedItems)
    if (!firstResolution.ok) continue

    for (
      let secondIndex = firstIndex + 1;
      secondIndex < draft.assignments.length;
      secondIndex += 1
    ) {
      const second = draft.assignments[secondIndex]
      if (
        first.memberId !== second.memberId ||
        first.eventDayId !== second.eventDayId
      ) continue

      const secondResolution = resolveDutyAssignmentInterval(
        second,
        calculatedItems,
      )
      if (
        secondResolution.ok &&
        intervalsOverlap(firstResolution.interval, secondResolution.interval)
      ) {
        const message = '同じメンバーの一般業務担当時間が重複しています。'
        errors.assignments[first.draftId] = {
          ...errors.assignments[first.draftId],
          conflict: message,
        }
        errors.assignments[second.draftId] = {
          ...errors.assignments[second.draftId],
          conflict: message,
        }
      }
    }
  }

  return errors
}

export const hasDutySettingsErrors = (
  errors: DutySettingsValidationErrors,
): boolean => Boolean(errors.form) ||
  Object.keys(errors.dutyTypes).length > 0 ||
  Object.keys(errors.assignments).length > 0

export const createDutySettingsDraft = (
  event: Event,
  stages: Stage[],
  dutyTypes: DutyType[],
  dutyAssignments: DutyAssignment[],
): DutySettingsDraft => {
  const eventDutyTypes = dutyTypes
    .filter((dutyType) => dutyType.eventId === event.id)
    .sort((first, second) =>
      first.order - second.order || first.id.localeCompare(second.id),
    )
  const draftIdByDutyTypeId = new Map(
    eventDutyTypes.map((dutyType) => [
      dutyType.id,
      `duty-type-${dutyType.id}`,
    ]),
  )
  const assignmentsForEvent = getDutyAssignmentsForEvent({
    event,
    stages,
    dutyTypes,
    dutyAssignments,
  })

  return {
    dutyTypes: eventDutyTypes.map((dutyType) => ({
      draftId: draftIdByDutyTypeId.get(dutyType.id)!,
      dutyTypeId: dutyType.id,
      name: dutyType.name,
    })),
    assignments: assignmentsForEvent.map((assignment) => {
      const dutyTypeDraftId = draftIdByDutyTypeId.get(assignment.dutyTypeId)
      return {
        draftId: `duty-assignment-${assignment.id}`,
        dutyAssignmentId: assignment.id,
        ...(dutyTypeDraftId
          ? { dutyTypeDraftId }
          : { missingDutyTypeId: assignment.dutyTypeId }),
        eventDayId: assignment.eventDayId,
        stageId: assignment.stageId,
        memberId: assignment.memberId,
        from: { ...assignment.from },
        until: { ...assignment.until },
      }
    }),
  }
}

export const createDutyAssignmentDraftItem = ({
  draftId,
  dutyTypeDraftId,
  eventDayId,
  stageId,
  calculatedItems,
}: {
  draftId: string
  dutyTypeDraftId: string
  eventDayId: EventDayId
  stageId: StageId
  calculatedItems: CalculatedScheduleItem[]
}): DutyAssignmentDraftItem | undefined => {
  const stageItems = calculatedItems.filter((item) =>
    item.eventDayId === eventDayId && item.stageId === stageId,
  )
  const first = stageItems[0]
  const last = stageItems.at(-1)
  if (!first || !last) return undefined

  return {
    draftId,
    dutyTypeDraftId,
    eventDayId,
    stageId,
    memberId: '',
    from: { scheduleItemId: first.scheduleItemId, edge: 'start' },
    until: { scheduleItemId: last.scheduleItemId, edge: 'end' },
  }
}

export const createDutySettingsUpdate = ({
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  paAssignments,
  calculatedItems,
  dutyTypes,
  dutyAssignments,
  draft,
  newDutyTypeIds,
  newDutyAssignmentIds,
}: {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  paAssignments: PaAssignment[]
  calculatedItems: CalculatedScheduleItem[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  draft: DutySettingsDraft
  newDutyTypeIds: DutyTypeId[]
  newDutyAssignmentIds: DutyAssignmentId[]
}): DutySettingsUpdateResult => {
  const errors = validateDutySettingsDraft({
    draft,
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays,
    eventBands,
    paAssignments,
    calculatedItems,
  })
  if (hasDutySettingsErrors(errors)) return { ok: false, errors }

  const currentTypes = dutyTypes.filter((dutyType) => dutyType.eventId === event.id)
  const currentAssignments = getDutyAssignmentsForEvent({
    event,
    stages,
    dutyTypes,
    dutyAssignments,
  })
  const currentAssignmentIds = new Set(
    currentAssignments.map((assignment) => assignment.id),
  )
  const currentTypesById = new Map(currentTypes.map((item) => [item.id, item]))
  const currentAssignmentsById = new Map(
    currentAssignments.map((item) => [item.id, item]),
  )
  const retainedDutyTypeIds = new Set(
    draft.dutyTypes.flatMap((item) =>
      item.dutyTypeId ? [item.dutyTypeId] : [],
    ),
  )
  const referencedDeletedType = currentTypes.find(
    (dutyType) =>
      !retainedDutyTypeIds.has(dutyType.id) &&
      dutyAssignments.some(
        (assignment) => assignment.dutyTypeId === dutyType.id,
      ),
  )
  if (referencedDeletedType) {
    return {
      ok: false,
      errors: {
        dutyTypes: {},
        assignments: {},
        form: `「${referencedDeletedType.name}」には担当設定があります。先に担当を削除して保存してください。`,
      },
    }
  }

  for (const item of draft.dutyTypes) {
    if (item.dutyTypeId && !currentTypesById.has(item.dutyTypeId)) {
      return {
        ok: false,
        errors: {
          dutyTypes: { [item.draftId]: { form: '編集する仕事が見つかりません。' } },
          assignments: {},
        },
      }
    }
  }
  for (const item of draft.assignments) {
    if (item.dutyAssignmentId && !currentAssignmentsById.has(item.dutyAssignmentId)) {
      return {
        ok: false,
        errors: {
          dutyTypes: {},
          assignments: {
            [item.draftId]: { form: '編集する一般業務担当が見つかりません。' },
          },
        },
      }
    }
  }

  const newTypeDrafts = draft.dutyTypes.filter((item) => !item.dutyTypeId)
  const existingTypeIds = new Set(dutyTypes.map((item) => item.id))
  if (
    newTypeDrafts.length !== newDutyTypeIds.length ||
    new Set(newDutyTypeIds).size !== newDutyTypeIds.length ||
    newDutyTypeIds.some((id) => !id || existingTypeIds.has(id))
  ) {
    return {
      ok: false,
      errors: { dutyTypes: {}, assignments: {}, form: '新しい仕事のIDを生成できませんでした。' },
    }
  }

  let newTypeIndex = 0
  const dutyTypeIdByDraftId = new Map<string, DutyTypeId>()
  const updatedTypesForEvent = draft.dutyTypes.map((item, order): DutyType => {
    const id = item.dutyTypeId ?? newDutyTypeIds[newTypeIndex++]
    dutyTypeIdByDraftId.set(item.draftId, id)
    return { id, eventId: event.id, name: item.name.trim(), order }
  })

  const newAssignmentDrafts = draft.assignments.filter(
    (item) => !item.dutyAssignmentId,
  )
  const existingAssignmentIds = new Set(dutyAssignments.map((item) => item.id))
  if (
    newAssignmentDrafts.length !== newDutyAssignmentIds.length ||
    new Set(newDutyAssignmentIds).size !== newDutyAssignmentIds.length ||
    newDutyAssignmentIds.some((id) => !id || existingAssignmentIds.has(id))
  ) {
    return {
      ok: false,
      errors: { dutyTypes: {}, assignments: {}, form: '新しい担当のIDを生成できませんでした。' },
    }
  }

  let newAssignmentIndex = 0
  const updatedAssignmentsForEvent = draft.assignments.map(
    (item): DutyAssignment => ({
      id: item.dutyAssignmentId ?? newDutyAssignmentIds[newAssignmentIndex++],
      dutyTypeId: item.dutyTypeDraftId
        ? dutyTypeIdByDraftId.get(item.dutyTypeDraftId)!
        : item.missingDutyTypeId!,
      eventDayId: item.eventDayId,
      stageId: item.stageId,
      memberId: item.memberId,
      from: { ...item.from },
      until: { ...item.until },
    }),
  )

  return {
    ok: true,
    dutyTypes: [
      ...dutyTypes.filter((dutyType) => dutyType.eventId !== event.id),
      ...updatedTypesForEvent,
    ],
    dutyAssignments: [
      ...dutyAssignments.filter((assignment) =>
        !currentAssignmentIds.has(assignment.id),
      ),
      ...updatedAssignmentsForEvent,
    ],
  }
}

export type { ResolvedScheduleInterval as ResolvedDutyAssignmentInterval }
