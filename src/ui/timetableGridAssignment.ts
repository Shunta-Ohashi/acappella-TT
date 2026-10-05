import type {
  DutyAssignment,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  Section,
  Stage,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import {
  createPaAssignmentsDraft,
  createPaAssignmentsUpdate,
  getPaMemberCandidates,
  type PaAssignmentsValidationErrors,
} from '../domain/paAssignments.ts'
import {
  createDutySettingsDraft,
  createDutySettingsUpdate,
  getDutyMemberCandidates,
  type DutySettingsValidationErrors,
} from '../domain/dutyAssignments.ts'
import { detectScheduleIssues } from '../domain/issues.ts'
import {
  getTimetableGridAssignmentTargetLabel,
  type ResolvedTimetableGridRangeSelection,
} from './timetableGridSelection.ts'

export interface TimetableGridAssignmentCandidate {
  memberId: Member['id']
  memberName: string
  participationStatus: EventMemberDay['participationStatus']
  warning?: string
}

export interface TimetableGridAssignmentContext {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
}

export type TimetableGridAssignmentCandidateResult =
  | {
      ok: true
      targetLabel: string
      candidates: TimetableGridAssignmentCandidate[]
    }
  | { ok: false; errors: string[] }

export type TimetableGridAssignmentResult =
  | {
      ok: true
      kind: 'pa'
      paAssignments: PaAssignment[]
      memberName: string
      targetLabel: string
      warnings: string[]
    }
  | {
      ok: true
      kind: 'duty'
      dutyAssignments: DutyAssignment[]
      memberName: string
      targetLabel: string
      warnings: string[]
    }
  | { ok: false; errors: string[] }

const uniqueMessages = (messages: Array<string | undefined>): string[] => [
  ...new Set(messages.filter((message): message is string => Boolean(message))),
]

const validateSelectionScope = (
  context: TimetableGridAssignmentContext,
  selection: ResolvedTimetableGridRangeSelection,
): string[] => {
  const eventDays = context.eventDays.filter((eventDay) =>
    eventDay.id === selection.eventDayId,
  )
  if (eventDays.length !== 1 || eventDays[0].eventId !== context.event.id) {
    return ['選択した開催日を現在のイベントで確認できません。範囲を選択し直してください。']
  }

  const stages = context.stages.filter((stage) => stage.id === selection.stageId)
  if (stages.length !== 1 || stages[0].eventDayId !== selection.eventDayId) {
    return ['選択したStageを現在の開催日で確認できません。範囲を選択し直してください。']
  }

  if (
    selection.fromMinute >= selection.untilMinute ||
    selection.rowCount < 1 ||
    selection.scheduleItemIds.length !== selection.rowCount
  ) {
    return ['選択範囲を確認できません。範囲を選択し直してください。']
  }

  const target = selection.target
  if (target.kind === 'duty') {
    const dutyTypes = context.dutyTypes.filter((dutyType) =>
      dutyType.id === target.dutyTypeId,
    )
    if (dutyTypes.length !== 1 || dutyTypes[0].eventId !== context.event.id) {
      return ['選択した当日運営の仕事を現在のイベントで確認できません。範囲を選択し直してください。']
    }
  }

  return []
}

export const getTimetableGridAssignmentCandidates = (
  context: TimetableGridAssignmentContext,
  selection: ResolvedTimetableGridRangeSelection,
): TimetableGridAssignmentCandidateResult => {
  const scopeErrors = validateSelectionScope(context, selection)
  if (scopeErrors.length > 0) return { ok: false, errors: scopeErrors }

  const domainCandidates = selection.target.kind === 'pa'
    ? getPaMemberCandidates({
        event: context.event,
        eventDayId: selection.eventDayId,
        role: selection.target.role,
        members: context.members,
        eventMembers: context.eventMembers,
        eventMemberDays: context.eventMemberDays,
      })
    : getDutyMemberCandidates({
        event: context.event,
        eventDayId: selection.eventDayId,
        members: context.members,
        eventMembers: context.eventMembers,
        eventMemberDays: context.eventMemberDays,
      })

  return {
    ok: true,
    targetLabel: getTimetableGridAssignmentTargetLabel(
      selection.target,
      context.dutyTypes,
    ),
    candidates: domainCandidates.map((candidate) => ({
      memberId: candidate.member.id,
      memberName: candidate.member.realName,
      participationStatus: candidate.participationStatus,
      ...(candidate.warning ? { warning: candidate.warning } : {}),
    })),
  }
}

const flattenPaErrors = (errors: PaAssignmentsValidationErrors): string[] =>
  uniqueMessages([
    errors.form,
    ...Object.values(errors.items).flatMap((item) => Object.values(item)),
  ])

const flattenDutyErrors = (errors: DutySettingsValidationErrors): string[] =>
  uniqueMessages([
    errors.form,
    ...Object.values(errors.dutyTypes).flatMap((item) => Object.values(item)),
    ...Object.values(errors.assignments).flatMap((item) => Object.values(item)),
  ])

const haveSameDutyTypes = (
  left: readonly DutyType[],
  right: readonly DutyType[],
): boolean => left.length === right.length && left.every((dutyType) => {
  const candidate = right.find((item) => item.id === dutyType.id)
  return candidate !== undefined &&
    candidate.eventId === dutyType.eventId &&
    candidate.name === dutyType.name &&
    candidate.order === dutyType.order
})

export const createTimetableGridAssignment = ({
  context,
  selection,
  memberId,
  newAssignmentId,
}: {
  context: TimetableGridAssignmentContext
  selection: ResolvedTimetableGridRangeSelection
  memberId: Member['id']
  newAssignmentId: string
}): TimetableGridAssignmentResult => {
  const candidateResult = getTimetableGridAssignmentCandidates(context, selection)
  if (!candidateResult.ok) return candidateResult

  const memberCandidate = candidateResult.candidates.find((candidate) =>
    candidate.memberId === memberId,
  )
  if (!memberCandidate) {
    return { ok: false, errors: ['選択したメンバーは現在この担当の候補ではありません。'] }
  }

  if (selection.target.kind === 'pa') {
    const draft = createPaAssignmentsDraft(context.event, context.paAssignments)
    const draftId = `timetable-grid-pa-${newAssignmentId}`
    draft.items.push({
      draftId,
      eventId: context.event.id,
      eventDayId: selection.eventDayId,
      stageId: selection.stageId,
      memberId,
      role: selection.target.role,
      from: { ...selection.fromBoundary },
      until: { ...selection.untilBoundary },
    })
    const update = createPaAssignmentsUpdate({
      event: context.event,
      eventDays: context.eventDays,
      stages: context.stages,
      sections: context.sections,
      members: context.members,
      eventMembers: context.eventMembers,
      eventMemberDays: context.eventMemberDays,
      eventBands: context.eventBands,
      calculatedItems: context.calculatedItems,
      paAssignments: context.paAssignments,
      draft,
      newPaAssignmentIds: [newAssignmentId],
    })
    if (!update.ok) return { ok: false, errors: flattenPaErrors(update.errors) }

    const relatedIssues = detectScheduleIssues({
      ...context,
      paAssignments: update.paAssignments,
    }).filter((issue) => issue.paAssignmentIds?.includes(newAssignmentId))
    const errors = uniqueMessages(relatedIssues
      .filter((issue) => issue.severity === 'ERROR')
      .map((issue) => issue.message))
    if (errors.length > 0) return { ok: false, errors }

    return {
      ok: true,
      kind: 'pa',
      paAssignments: update.paAssignments,
      memberName: memberCandidate.memberName,
      targetLabel: candidateResult.targetLabel,
      warnings: uniqueMessages([
        memberCandidate.warning,
        ...relatedIssues
          .filter((issue) => issue.severity !== 'ERROR')
          .map((issue) => issue.message),
      ]),
    }
  }

  const dutyTypeId = selection.target.dutyTypeId
  const draft = createDutySettingsDraft(
    context.event,
    context.stages,
    context.dutyTypes,
    context.dutyAssignments,
  )
  const dutyTypeDraft = draft.dutyTypes.find((dutyType) =>
    dutyType.dutyTypeId === dutyTypeId,
  )
  if (!dutyTypeDraft) {
    return { ok: false, errors: ['選択した当日運営の仕事を確認できません。'] }
  }
  draft.assignments.push({
    draftId: `timetable-grid-duty-${newAssignmentId}`,
    dutyTypeDraftId: dutyTypeDraft.draftId,
    eventDayId: selection.eventDayId,
    stageId: selection.stageId,
    memberId,
    from: { ...selection.fromBoundary },
    until: { ...selection.untilBoundary },
  })
  const update = createDutySettingsUpdate({
    event: context.event,
    eventDays: context.eventDays,
    stages: context.stages,
    sections: context.sections,
    members: context.members,
    eventMembers: context.eventMembers,
    eventMemberDays: context.eventMemberDays,
    eventBands: context.eventBands,
    paAssignments: context.paAssignments,
    calculatedItems: context.calculatedItems,
    dutyTypes: context.dutyTypes,
    dutyAssignments: context.dutyAssignments,
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: [newAssignmentId],
  })
  if (!update.ok) return { ok: false, errors: flattenDutyErrors(update.errors) }
  if (!haveSameDutyTypes(context.dutyTypes, update.dutyTypes)) {
    return { ok: false, errors: ['当日運営の仕事設定が変更されたため、担当を追加できませんでした。'] }
  }

  const relatedIssues = detectScheduleIssues({
    ...context,
    dutyTypes: update.dutyTypes,
    dutyAssignments: update.dutyAssignments,
  }).filter((issue) => issue.dutyAssignmentIds?.includes(newAssignmentId))
  const errors = uniqueMessages(relatedIssues
    .filter((issue) => issue.severity === 'ERROR')
    .map((issue) => issue.message))
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    kind: 'duty',
    dutyAssignments: update.dutyAssignments,
    memberName: memberCandidate.memberName,
    targetLabel: candidateResult.targetLabel,
    warnings: uniqueMessages([
      memberCandidate.warning,
      ...relatedIssues
        .filter((issue) => issue.severity !== 'ERROR')
        .map((issue) => issue.message),
    ]),
  }
}
