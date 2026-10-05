import type {
  DutyAssignment,
  DutyAssignmentId,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  PaAssignmentId,
  Section,
  Stage,
  StageId,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import type { TimetableWorkspaceRow } from './timetableWorkspaceRows.ts'
import {
  createPaAssignmentAddition,
  getPaMemberCandidates,
  resolvePaAssignmentInterval,
} from '../domain/paAssignments.ts'
import {
  createDutyAssignmentAddition,
  getDutyMemberCandidates,
  resolveDutyAssignmentInterval,
} from '../domain/dutyAssignments.ts'
import { detectScheduleIssues } from '../domain/issues.ts'
import { getMemberDisplayName } from './eventBandPresentation.ts'
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

export type TimetableGridAssignmentDeletionTarget =
  | { kind: 'pa'; assignmentId: PaAssignmentId }
  | { kind: 'duty'; assignmentId: DutyAssignmentId }

export type TimetableGridAssignmentDeletionResult =
  | {
      ok: true
      kind: 'pa'
      paAssignments: PaAssignment[]
      targetLabel: string
      memberName: string
      fromMinute: number
      untilMinute: number
    }
  | {
      ok: true
      kind: 'duty'
      dutyAssignments: DutyAssignment[]
      targetLabel: string
      memberName: string
      fromMinute: number
      untilMinute: number
    }
  | { ok: false; errors: string[] }

export interface TimetableGridAssignmentDeletionPresentation {
  target: TimetableGridAssignmentDeletionTarget
  targetLabel: string
  memberName: string
  fromMinute: number
  untilMinute: number
}

export type TimetableGridAssignmentsDeletionResult =
  | {
      ok: true
      kind: 'pa'
      paAssignments: PaAssignment[]
      deleted: TimetableGridAssignmentDeletionPresentation[]
    }
  | {
      ok: true
      kind: 'duty'
      dutyAssignments: DutyAssignment[]
      deleted: TimetableGridAssignmentDeletionPresentation[]
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
    const update = createPaAssignmentAddition({
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
      item: {
        eventId: context.event.id,
        eventDayId: selection.eventDayId,
        stageId: selection.stageId,
        memberId,
        role: selection.target.role,
        from: { ...selection.fromBoundary },
        until: { ...selection.untilBoundary },
      },
      newPaAssignmentId: newAssignmentId,
    })
    if (!update.ok) {
      return { ok: false, errors: uniqueMessages(Object.values(update.errors)) }
    }

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
  const update = createDutyAssignmentAddition({
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
    item: {
      dutyTypeId,
      eventDayId: selection.eventDayId,
      stageId: selection.stageId,
      memberId,
      from: { ...selection.fromBoundary },
      until: { ...selection.untilBoundary },
    },
    newDutyAssignmentId: newAssignmentId,
  })
  if (!update.ok) {
    return { ok: false, errors: uniqueMessages(Object.values(update.errors)) }
  }

  const relatedIssues = detectScheduleIssues({
    ...context,
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

const getDeletionScopeError = (
  context: TimetableGridAssignmentContext,
  eventDayId: EventDayId,
  stageId: StageId,
): string | undefined => {
  const eventDays = context.eventDays.filter((eventDay) =>
    eventDay.id === eventDayId,
  )
  if (eventDays.length !== 1 || eventDays[0].eventId !== context.event.id) {
    return '削除対象の開催日を現在のイベントで確認できません。'
  }
  const stages = context.stages.filter((stage) => stage.id === stageId)
  if (stages.length !== 1 || stages[0].eventDayId !== eventDayId) {
    return '削除対象のStageを現在の開催日で確認できません。'
  }
  return undefined
}

export const deleteTimetableGridAssignment = ({
  context,
  target,
  eventDayId,
  stageId,
}: {
  context: TimetableGridAssignmentContext
  target: TimetableGridAssignmentDeletionTarget
  eventDayId: EventDayId
  stageId: StageId
}): TimetableGridAssignmentDeletionResult => {
  const scopeError = getDeletionScopeError(context, eventDayId, stageId)
  if (scopeError) return { ok: false, errors: [scopeError] }

  if (target.kind === 'pa') {
    const assignments = context.paAssignments.filter((assignment) =>
      assignment.id === target.assignmentId,
    )
    const assignment = assignments[0]
    if (assignments.length !== 1 || !assignment) {
      return { ok: false, errors: ['削除するPA担当を一意に確認できません。'] }
    }
    if (
      assignment.eventId !== context.event.id ||
      assignment.eventDayId !== eventDayId ||
      assignment.stageId !== stageId
    ) {
      return { ok: false, errors: ['削除するPA担当は現在のEvent・開催日・Stageに属していません。'] }
    }
    const interval = resolvePaAssignmentInterval(
      assignment,
      context.calculatedItems,
      { stages: context.stages, sections: context.sections },
    )
    if (!interval.ok) return { ok: false, errors: [interval.reason] }
    const member = context.members.find((candidate) =>
      candidate.id === assignment.memberId,
    )
    return {
      ok: true,
      kind: 'pa',
      paAssignments: context.paAssignments.filter((candidate) =>
        candidate.id !== assignment.id,
      ),
      targetLabel: assignment.role === 'main' ? 'Main PA' : 'Sub PA',
      memberName: member ? getMemberDisplayName(member) : '不明なメンバー',
      fromMinute: interval.interval.fromMinute,
      untilMinute: interval.interval.untilMinute,
    }
  }

  const assignments = context.dutyAssignments.filter((assignment) =>
    assignment.id === target.assignmentId,
  )
  const assignment = assignments[0]
  if (assignments.length !== 1 || !assignment) {
    return { ok: false, errors: ['削除する当日運営担当を一意に確認できません。'] }
  }
  const dutyTypes = context.dutyTypes.filter((dutyType) =>
    dutyType.id === assignment.dutyTypeId,
  )
  const dutyType = dutyTypes[0]
  if (
    dutyTypes.length !== 1 || !dutyType ||
    dutyType.eventId !== context.event.id
  ) {
    return { ok: false, errors: ['削除する担当の仕事が見つからないか、別Eventに属しています。'] }
  }
  if (
    assignment.eventDayId !== eventDayId ||
    assignment.stageId !== stageId
  ) {
    return { ok: false, errors: ['削除する当日運営担当は現在の開催日・Stageに属していません。'] }
  }
  const interval = resolveDutyAssignmentInterval(
    assignment,
    context.calculatedItems,
    { stages: context.stages, sections: context.sections },
  )
  if (!interval.ok) return { ok: false, errors: [interval.reason] }
  const member = context.members.find((candidate) =>
    candidate.id === assignment.memberId,
  )
  return {
    ok: true,
    kind: 'duty',
    dutyAssignments: context.dutyAssignments.filter((candidate) =>
      candidate.id !== assignment.id,
    ),
    targetLabel: dutyType.name,
    memberName: member ? getMemberDisplayName(member) : '不明なメンバー',
    fromMinute: interval.interval.fromMinute,
    untilMinute: interval.interval.untilMinute,
  }
}

export const getTimetableGridSelectionAssignmentTargets = (
  selection: ResolvedTimetableGridRangeSelection,
  rows: readonly TimetableWorkspaceRow[],
): TimetableGridAssignmentDeletionTarget[] => {
  const rowByScheduleItemId = new Map<string, TimetableWorkspaceRow>()
  for (const row of rows) {
    const scheduleItemId = row.scheduleItem.id
    if (rowByScheduleItemId.has(scheduleItemId)) return []
    rowByScheduleItemId.set(scheduleItemId, row)
  }

  const targets: TimetableGridAssignmentDeletionTarget[] = []
  const seenAssignmentIds = new Set<string>()
  for (const scheduleItemId of selection.scheduleItemIds) {
    const row = rowByScheduleItemId.get(scheduleItemId)
    if (!row) return []
    const coverage = selection.target.kind === 'pa'
      ? row.paCoverage[selection.target.role]
      : row.dutyCoverage[selection.target.dutyTypeId] ?? []
    for (const item of coverage) {
      if (seenAssignmentIds.has(item.assignmentId)) continue
      seenAssignmentIds.add(item.assignmentId)
      targets.push(selection.target.kind === 'pa'
        ? { kind: 'pa', assignmentId: item.assignmentId }
        : { kind: 'duty', assignmentId: item.assignmentId })
    }
  }
  return targets
}

export const deleteTimetableGridAssignments = ({
  context,
  targets,
  eventDayId,
  stageId,
}: {
  context: TimetableGridAssignmentContext
  targets: readonly TimetableGridAssignmentDeletionTarget[]
  eventDayId: EventDayId
  stageId: StageId
}): TimetableGridAssignmentsDeletionResult => {
  const uniqueTargets = targets.filter((target, index) =>
    targets.findIndex((candidate) =>
      candidate.kind === target.kind &&
      candidate.assignmentId === target.assignmentId,
    ) === index,
  )
  const kind = uniqueTargets[0]?.kind
  if (!kind || uniqueTargets.some((target) => target.kind !== kind)) {
    return { ok: false, errors: ['削除する担当を同じ列から確認できません。'] }
  }

  const deleted: TimetableGridAssignmentDeletionPresentation[] = []
  for (const target of uniqueTargets) {
    const result = deleteTimetableGridAssignment({
      context,
      target,
      eventDayId,
      stageId,
    })
    if (!result.ok) return result
    deleted.push({
      target,
      targetLabel: result.targetLabel,
      memberName: result.memberName,
      fromMinute: result.fromMinute,
      untilMinute: result.untilMinute,
    })
  }

  const assignmentIds = new Set(uniqueTargets.map((target) => target.assignmentId))
  if (kind === 'pa') {
    return {
      ok: true,
      kind,
      paAssignments: context.paAssignments.filter((assignment) =>
        !assignmentIds.has(assignment.id),
      ),
      deleted,
    }
  }
  return {
    ok: true,
    kind,
    dutyAssignments: context.dutyAssignments.filter((assignment) =>
      !assignmentIds.has(assignment.id),
    ),
    deleted,
  }
}
