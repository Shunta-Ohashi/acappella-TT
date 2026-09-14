import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  PaAssignment,
  PaAssignmentId,
  PaRole,
  ScheduleBoundary,
  Stage,
  StageId,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import { isIntervalWithinAvailabilityWindows } from './eventBandSettings.ts'
import {
  intervalsOverlap,
  resolveScheduleBoundaryInterval,
  type ResolvedScheduleInterval,
  type ResolveScheduleIntervalResult,
} from './scheduleBoundaries.ts'

export { intervalsOverlap } from './scheduleBoundaries.ts'

export interface PaAssignmentDraftItem {
  draftId: string
  paAssignmentId?: PaAssignmentId
  eventId: Event['id']
  eventDayId: EventDayId
  stageId: StageId
  memberId: string
  role: PaRole
  from: ScheduleBoundary
  until: ScheduleBoundary
}

export interface PaAssignmentsDraft {
  items: PaAssignmentDraftItem[]
}

export interface PaAssignmentItemErrors {
  stageId?: string
  memberId?: string
  from?: string
  until?: string
  interval?: string
  availability?: string
  conflict?: string
  form?: string
}

export interface PaAssignmentsValidationErrors {
  items: Record<string, PaAssignmentItemErrors>
  form?: string
}

export type PaAssignmentsUpdateResult =
  | { ok: true; paAssignments: PaAssignment[] }
  | { ok: false; errors: PaAssignmentsValidationErrors }

export type ResolvedPaAssignmentInterval = ResolvedScheduleInterval
export type ResolvePaAssignmentIntervalResult = ResolveScheduleIntervalResult

export interface PaMemberCandidate {
  member: Member
  participationStatus: EventMemberDay['participationStatus']
  warning?: string
}

interface PaAssignmentScope {
  eventDayId: EventDayId
  stageId: StageId
  from: ScheduleBoundary
  until: ScheduleBoundary
}

interface PaMemberPerformanceOverlapInput {
  memberId: MemberId
  eventDayId: EventDayId
  interval: ResolvedPaAssignmentInterval
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
}

export const resolvePaAssignmentInterval = (
  assignment: PaAssignmentScope,
  calculatedItems: CalculatedScheduleItem[],
): ResolvePaAssignmentIntervalResult => resolveScheduleBoundaryInterval(
  assignment,
  calculatedItems,
  'PA担当',
)

export const getPaMemberCandidates = ({
  event,
  eventDayId,
  role,
  members,
  eventMembers,
  eventMemberDays,
}: {
  event: Event
  eventDayId: EventDayId
  role: PaRole
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): PaMemberCandidate[] => {
  const memberById = new Map(members.map((member) => [member.id, member]))
  const memberDayByEventMemberId = new Map(
    eventMemberDays
      .filter((day) => day.eventDayId === eventDayId)
      .map((day) => [day.eventMemberId, day]),
  )

  return eventMembers
    .filter((eventMember) => eventMember.eventId === event.id)
    .flatMap((eventMember): PaMemberCandidate[] => {
      const member = memberById.get(eventMember.memberId)
      const memberDay = memberDayByEventMemberId.get(eventMember.id)
      if (
        !member || !member.paCapabilities?.[role] || !memberDay ||
        memberDay.participationStatus === 'absent'
      ) {
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

export const getPaAssignmentParticipationWarning = ({
  item,
  eventMembers,
  eventMemberDays,
}: {
  item: Pick<PaAssignmentDraftItem, 'eventId' | 'eventDayId' | 'memberId'>
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): string | undefined => {
  const eventMember = eventMembers.find((candidate) =>
    candidate.eventId === item.eventId && candidate.memberId === item.memberId,
  )
  const memberDay = eventMember
    ? eventMemberDays.find((candidate) =>
        candidate.eventMemberId === eventMember.id &&
        candidate.eventDayId === item.eventDayId,
      )
    : undefined
  return memberDay?.participationStatus === 'undecided'
    ? 'このメンバーの参加状況は未定です。'
    : undefined
}

export const getOverlappingMemberPerformances = ({
  memberId,
  eventDayId,
  interval,
  eventBands,
  calculatedItems,
}: PaMemberPerformanceOverlapInput): CalculatedScheduleItem[] => {
  const eventBandById = new Map(eventBands.map((band) => [band.id, band]))
  return calculatedItems.filter((item) => {
    if (
      item.kind !== 'performance' || !item.eventBandId ||
      item.eventDayId !== eventDayId
    ) {
      return false
    }
    const eventBand = eventBandById.get(item.eventBandId)
    return Boolean(
      eventBand?.memberIds.includes(memberId) &&
      intervalsOverlap(interval, {
        fromMinute: item.plannedStartMinute,
        untilMinute: item.plannedEndMinute,
      }),
    )
  })
}

const getMemberDay = ({
  item,
  eventMembers,
  eventMemberDays,
}: {
  item: Pick<PaAssignmentDraftItem, 'eventId' | 'eventDayId' | 'memberId'>
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventMemberDay | undefined => {
  const eventMember = eventMembers.find((candidate) =>
    candidate.eventId === item.eventId && candidate.memberId === item.memberId,
  )
  return eventMember
    ? eventMemberDays.find((candidate) =>
        candidate.eventMemberId === eventMember.id &&
        candidate.eventDayId === item.eventDayId,
      )
    : undefined
}

export const validatePaAssignmentDraftItem = ({
  item,
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  calculatedItems,
}: {
  item: PaAssignmentDraftItem
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
}): PaAssignmentItemErrors => {
  const errors: PaAssignmentItemErrors = {}
  const eventDayExists = eventDays.some((day) =>
    day.id === item.eventDayId && day.eventId === event.id,
  )
  const stage = stages.find((candidate) => candidate.id === item.stageId)
  const member = members.find((candidate) => candidate.id === item.memberId)
  const memberDay = getMemberDay({ item, eventMembers, eventMemberDays })

  if (item.eventId !== event.id || !eventDayExists) {
    errors.form = 'PA担当のイベントまたは開催日が正しくありません。'
  }
  if (!stage || stage.eventDayId !== item.eventDayId) {
    errors.stageId = '同じ開催日のStageを選択してください。'
  }
  if (!item.memberId || !member) {
    errors.memberId = 'PA担当メンバーを選択してください。'
  } else if (!member.paCapabilities?.[item.role]) {
    errors.memberId = item.role === 'main'
      ? 'Main PAを担当できるメンバーを選択してください。'
      : 'Sub PAを担当できるメンバーを選択してください。'
  } else if (!memberDay) {
    errors.memberId = 'この開催日の参加情報が設定されていません。'
  } else if (memberDay.participationStatus === 'absent') {
    errors.memberId = 'この開催日に不参加のメンバーは選択できません。'
  }

  const resolution = resolvePaAssignmentInterval(item, calculatedItems)
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
    errors.availability = 'PA担当時間がメンバーの出演可能時間外です。'
  }

  if (
    resolution.ok && member && member.paCapabilities?.[item.role] &&
    getOverlappingMemberPerformances({
      memberId: member.id,
      eventDayId: item.eventDayId,
      interval: resolution.interval,
      eventBands,
      calculatedItems,
    }).length > 0
  ) {
    errors.conflict = 'PA担当時間中にこのメンバー自身の出演があります。'
  }

  return errors
}

export const hasPaAssignmentItemErrors = (
  errors: PaAssignmentItemErrors,
): boolean => Object.values(errors).some(Boolean)

export const validatePaAssignmentsDraft = ({
  draft,
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  calculatedItems,
}: {
  draft: PaAssignmentsDraft
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
}): PaAssignmentsValidationErrors => {
  const errors: PaAssignmentsValidationErrors = { items: {} }
  const draftIds = new Set<string>()
  const assignmentIds = new Set<PaAssignmentId>()

  for (const item of draft.items) {
    const itemErrors = validatePaAssignmentDraftItem({
      item,
      event,
      eventDays,
      stages,
      members,
      eventMembers,
      eventMemberDays,
      eventBands,
      calculatedItems,
    })
    if (hasPaAssignmentItemErrors(itemErrors)) {
      errors.items[item.draftId] = itemErrors
    }
    if (draftIds.has(item.draftId)) {
      errors.form = '同じPA担当draftが重複しています。'
    }
    draftIds.add(item.draftId)
    if (item.paAssignmentId) {
      if (assignmentIds.has(item.paAssignmentId)) {
        errors.items[item.draftId] = {
          ...errors.items[item.draftId],
          form: '同じPA担当が重複しています。',
        }
      }
      assignmentIds.add(item.paAssignmentId)
    }
  }

  for (let firstIndex = 0; firstIndex < draft.items.length; firstIndex += 1) {
    const first = draft.items[firstIndex]
    const firstResolution = resolvePaAssignmentInterval(first, calculatedItems)
    if (!firstResolution.ok) continue
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < draft.items.length;
      secondIndex += 1
    ) {
      const second = draft.items[secondIndex]
      if (
        first.memberId !== second.memberId ||
        first.eventDayId !== second.eventDayId
      ) {
        continue
      }
      const secondResolution = resolvePaAssignmentInterval(
        second,
        calculatedItems,
      )
      if (
        secondResolution.ok && intervalsOverlap(
          firstResolution.interval,
          secondResolution.interval,
        )
      ) {
        const message = '同じメンバーのPA担当時間が重複しています。'
        errors.items[first.draftId] = {
          ...errors.items[first.draftId],
          conflict: message,
        }
        errors.items[second.draftId] = {
          ...errors.items[second.draftId],
          conflict: message,
        }
      }
    }
  }

  return errors
}

export const hasPaAssignmentsErrors = (
  errors: PaAssignmentsValidationErrors,
): boolean => Boolean(errors.form) || Object.keys(errors.items).length > 0

export const createPaAssignmentsDraft = (
  event: Event,
  paAssignments: PaAssignment[],
): PaAssignmentsDraft => ({
  items: paAssignments
    .filter((assignment) => assignment.eventId === event.id)
    .map((assignment) => ({
      draftId: `pa-assignment-${assignment.id}`,
      paAssignmentId: assignment.id,
      eventId: assignment.eventId,
      eventDayId: assignment.eventDayId,
      stageId: assignment.stageId,
      memberId: assignment.memberId,
      role: assignment.role,
      from: { ...assignment.from },
      until: { ...assignment.until },
    })),
})

export const createPaAssignmentDraftItem = ({
  draftId,
  event,
  eventDayId,
  stageId,
  role,
  calculatedItems,
}: {
  draftId: string
  event: Event
  eventDayId: EventDayId
  stageId: StageId
  role: PaRole
  calculatedItems: CalculatedScheduleItem[]
}): PaAssignmentDraftItem | undefined => {
  const stageItems = calculatedItems.filter((item) =>
    item.eventDayId === eventDayId && item.stageId === stageId,
  )
  const first = stageItems[0]
  const last = stageItems.at(-1)
  if (!first || !last) return undefined

  return {
    draftId,
    eventId: event.id,
    eventDayId,
    stageId,
    memberId: '',
    role,
    from: { scheduleItemId: first.scheduleItemId, edge: 'start' },
    until: { scheduleItemId: last.scheduleItemId, edge: 'end' },
  }
}

export const createPaAssignmentsUpdate = ({
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  calculatedItems,
  paAssignments,
  draft,
  newPaAssignmentIds,
}: {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
  paAssignments: PaAssignment[]
  draft: PaAssignmentsDraft
  newPaAssignmentIds: PaAssignmentId[]
}): PaAssignmentsUpdateResult => {
  const errors = validatePaAssignmentsDraft({
    draft,
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays,
    eventBands,
    calculatedItems,
  })
  if (hasPaAssignmentsErrors(errors)) return { ok: false, errors }

  const currentAssignments = paAssignments.filter((assignment) =>
    assignment.eventId === event.id,
  )
  const currentById = new Map(
    currentAssignments.map((assignment) => [assignment.id, assignment]),
  )
  for (const item of draft.items) {
    if (
      item.paAssignmentId && !currentById.has(item.paAssignmentId)
    ) {
      return {
        ok: false,
        errors: {
          items: {
            [item.draftId]: { form: '編集するPA担当が見つかりません。' },
          },
        },
      }
    }
  }

  const newItems = draft.items.filter((item) => !item.paAssignmentId)
  const existingIds = new Set(paAssignments.map((assignment) => assignment.id))
  const uniqueNewIds = new Set(newPaAssignmentIds)
  if (
    newItems.length !== newPaAssignmentIds.length ||
    uniqueNewIds.size !== newPaAssignmentIds.length ||
    newPaAssignmentIds.some((id) => !id || existingIds.has(id))
  ) {
    return {
      ok: false,
      errors: { items: {}, form: '新しいPA担当のIDを生成できませんでした。' },
    }
  }

  let newIdIndex = 0
  const updatedForEvent = draft.items.map((item): PaAssignment => ({
    id: item.paAssignmentId ?? newPaAssignmentIds[newIdIndex++],
    eventId: event.id,
    eventDayId: item.eventDayId,
    stageId: item.stageId,
    memberId: item.memberId,
    role: item.role,
    from: { ...item.from },
    until: { ...item.until },
  }))

  return {
    ok: true,
    paAssignments: [
      ...paAssignments.filter((assignment) => assignment.eventId !== event.id),
      ...updatedForEvent,
    ],
  }
}
