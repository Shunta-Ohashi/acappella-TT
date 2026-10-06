import type { IssueSeverity, ScheduleIssue, ScheduleIssueCode } from './issues'
import { detectScheduleIssues } from './issues.ts'
import type {
  DutyAssignment,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  ScheduleItem,
  Section,
  Stage,
  StageId,
  TimetableLock,
  TimetableOrderConstraint,
} from './models'
import {
  compareStableText,
  getEventDaysForEvent,
  getStagesForEventDay,
  getUnscheduledEventBandsForEventDay,
} from './schedule.ts'
import { calculateEventDayTimelines } from './timetable.ts'
import { evaluateTimetableLocks } from './timetableLocks.ts'
import {
  evaluateScheduledTimetableOrderConstraints,
  evaluateTimetableOrderConstraints,
  type ScheduledTimetableOrderConstraintViolationCode,
} from './timetableOrderConstraints.ts'
import { getDutyAssignmentsForEvent } from './dutyAssignments.ts'
import { createTimetableWorkspaceRows } from '../ui/timetableWorkspaceRows.ts'
import {
  countIssuesBySeverity,
  formatScheduleIssueMessage,
  type IssueSeverityCounts,
} from '../ui/issuePresentation.ts'
import type { EventEditorStepId } from '../ui/eventEditorSteps.ts'

export type EventFinalCheckCategory =
  | 'structure'
  | 'schedule'
  | 'timetable-lock'
  | 'order-constraint'
  | 'operations'

export interface EventFinalCheckFinding {
  key: string
  severity: IssueSeverity
  category: EventFinalCheckCategory
  code: string
  message: string
  details?: string[]
  targetStep: EventEditorStepId
  eventDayId?: EventDayId
  stageId?: StageId
}

export interface EventFinalCheckReport {
  findings: EventFinalCheckFinding[]
  counts: IssueSeverityCounts
}

export interface CreateEventFinalCheckReportInput {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
  timetableOrderConstraints: TimetableOrderConstraint[]
}

const MEMBER_ISSUE_CODES = new Set<ScheduleIssueCode>([
  'MEMBER_NOT_REGISTERED_FOR_EVENT',
  'MEMBER_DAY_NOT_CONFIGURED',
  'MEMBER_ABSENT',
  'MEMBER_PARTICIPATION_UNDECIDED',
  'OUTSIDE_MEMBER_AVAILABILITY',
  'PA_CAPABILITY_MISMATCH',
  'PA_MEMBER_NOT_CONFIGURED',
  'PA_MEMBER_ABSENT',
  'PA_MEMBER_UNDECIDED',
  'PA_OUTSIDE_MEMBER_AVAILABILITY',
  'DUTY_MEMBER_NOT_CONFIGURED',
  'DUTY_MEMBER_ABSENT',
  'DUTY_MEMBER_UNDECIDED',
  'DUTY_OUTSIDE_MEMBER_AVAILABILITY',
])

const BAND_CONDITION_ISSUE_CODES = new Set<ScheduleIssueCode>([
  'OUTSIDE_BAND_AVAILABILITY',
  'PREFERENCE_NOT_MET',
])

export const getFinalCheckRepairTarget = (
  issueCode: ScheduleIssueCode,
): EventEditorStepId => {
  if (MEMBER_ISSUE_CODES.has(issueCode)) return 3
  if (issueCode === 'EVENT_BAND_DAY_MISMATCH') return 4
  if (BAND_CONDITION_ISSUE_CODES.has(issueCode)) return 5
  return 6
}

const severityOrder: Record<IssueSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
}

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values)].sort(compareStableText)

const issueKey = (issue: ScheduleIssue): string => [
  issue.code,
  uniqueSorted(issue.memberIds ?? []).join(','),
  uniqueSorted(issue.eventBandIds ?? []).join(','),
  uniqueSorted(issue.scheduleItemIds ?? []).join(','),
  uniqueSorted(issue.stageIds ?? []).join(','),
  uniqueSorted(issue.sectionIds ?? []).join(','),
  uniqueSorted(issue.paAssignmentIds ?? []).join(','),
  uniqueSorted(issue.dutyAssignmentIds ?? []).join(','),
  uniqueSorted(issue.eventDayIds ?? []).join(','),
].join('|')

const scheduledOrderMessage = (
  code: ScheduledTimetableOrderConstraintViolationCode,
  bandNames: string[],
): string => {
  const targets = bandNames.length > 0 ? `（${bandNames.join('、')}）` : ''
  if (code === 'MISSING_EVENT_BAND') return `出演順制約のバンドが未配置です${targets}。`
  if (code === 'DUPLICATE_EVENT_BAND') return `出演順制約のバンドが複数配置されています${targets}。`
  if (code === 'LANE_MISMATCH') return `出演順制約と配置先のStage・Sectionが一致しません${targets}。`
  return `出演順制約のバンドが指定順で連続していません${targets}。`
}

export const createEventFinalCheckReport = (
  input: CreateEventFinalCheckReportInput,
): EventFinalCheckReport => {
  const eventDays = getEventDaysForEvent(input.eventDays, input.event.id)
  const eventDayIds = new Set(eventDays.map(day => day.id))
  const stages = input.stages.filter(stage => eventDayIds.has(stage.eventDayId))
  const stageIds = new Set(stages.map(stage => stage.id))
  const sections = input.sections.filter(section => stageIds.has(section.stageId))
  const eventBands = input.eventBands.filter(band => band.eventId === input.event.id)
  const scheduleItems = input.scheduleItems.filter(item => stageIds.has(item.stageId))
  const eventMembers = input.eventMembers.filter(member => member.eventId === input.event.id)
  const eventMemberIds = new Set(eventMembers.map(member => member.id))
  const eventMemberDays = input.eventMemberDays.filter(day =>
    eventMemberIds.has(day.eventMemberId),
  )
  const paAssignments = input.paAssignments.filter(assignment =>
    assignment.eventId === input.event.id,
  )
  const dutyTypes = input.dutyTypes.filter(type => type.eventId === input.event.id)
  const dutyAssignments = getDutyAssignmentsForEvent({
    event: input.event,
    stages,
    dutyTypes: input.dutyTypes,
    dutyAssignments: input.dutyAssignments,
  })
  const timetableLocks = input.timetableLocks.filter(lock => lock.eventId === input.event.id)
  const orderConstraints = input.timetableOrderConstraints.filter(
    constraint => constraint.eventId === input.event.id,
  )
  const eventDayById = new Map(eventDays.map(day => [day.id, day]))
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const scheduleItemById = new Map(scheduleItems.map(item => [item.id, item]))
  const eventBandById = new Map(eventBands.map(band => [band.id, band]))
  const dayOrder = new Map(eventDays.map((day, index) => [day.id, index]))
  const stageOrder = new Map(stages.map(stage => [
    stage.id,
    (dayOrder.get(stage.eventDayId) ?? Number.MAX_SAFE_INTEGER) * 1_000_000 + stage.order,
  ]))
  const findings = new Map<string, EventFinalCheckFinding>()
  const addFinding = (finding: EventFinalCheckFinding) => {
    if (!findings.has(finding.key)) findings.set(finding.key, finding)
  }
  const resolveScope = (issue: ScheduleIssue): {
    eventDayId?: EventDayId
    stageId?: StageId
  } => {
    const candidateStageIds = uniqueSorted([
      ...(issue.stageIds ?? []),
      ...(issue.scheduleItemIds ?? []).flatMap(itemId => {
        const stageId = scheduleItemById.get(itemId)?.stageId
        return stageId ? [stageId] : []
      }),
    ]).filter(stageId => stageById.has(stageId))
      .sort((left, right) => (stageOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (stageOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || compareStableText(left, right))
    const stageId = candidateStageIds[0]
    const candidateDayIds = uniqueSorted([
      ...(issue.eventDayIds ?? []),
      ...(stageId ? [stageById.get(stageId)?.eventDayId ?? ''] : []),
    ]).filter(dayId => eventDayById.has(dayId))
      .sort((left, right) => (dayOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (dayOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || compareStableText(left, right))
    const eventDayId = candidateDayIds[0]
    return {
      ...(eventDayId ? { eventDayId } : {}),
      ...(stageId ? { stageId } : {}),
    }
  }

  if (eventDays.length === 0) {
    addFinding({
      key: 'structure|event-days-missing', severity: 'ERROR', category: 'structure',
      code: 'EVENT_DAY_MISSING', message: '開催日が設定されていません。', targetStep: 1,
    })
  }

  for (const eventDay of eventDays) {
    const dayLabel = eventDay.label || eventDay.date
    const dayStages = getStagesForEventDay(stages, eventDay.id)
    if (dayStages.length === 0) addFinding({
      key: `structure|stage-missing|${eventDay.id}`, severity: 'ERROR', category: 'structure',
      code: 'STAGE_MISSING', message: `${dayLabel}にはStageが設定されていません。`,
      targetStep: 2, eventDayId: eventDay.id,
    })

    for (const band of getUnscheduledEventBandsForEventDay({
      eventBands,
      eventId: input.event.id,
      eventDayId: eventDay.id,
      stages: dayStages,
      scheduleItems,
    })) addFinding({
      key: `structure|unscheduled-band|${band.id}`, severity: 'ERROR', category: 'structure',
      code: 'UNSCHEDULED_EVENT_BAND', message: `バンド「${band.name}」が未配置です。`,
      targetStep: 6, eventDayId: eventDay.id,
    })

    let timelines
    try {
      timelines = calculateEventDayTimelines({
        eventDayId: eventDay.id,
        stages: dayStages,
        sections,
        scheduleItems,
        eventBands,
      })
    } catch {
      addFinding({
        key: `structure|timeline-failure|${eventDay.id}`, severity: 'ERROR', category: 'structure',
        code: 'TIMELINE_CALCULATION_FAILED',
        message: `${dayLabel}のタイムテーブルを計算できません。`,
        targetStep: 6, eventDayId: eventDay.id,
      })
      continue
    }

    for (const invalid of timelines.invalidStages) {
      const stage = stageById.get(invalid.stageId)
      addFinding({
        key: `structure|invalid-stage|${invalid.stageId}`, severity: 'ERROR', category: 'structure',
        code: 'INVALID_STAGE_TIMELINE',
        message: `${stage?.name ?? '不明なStage'}のSection設定と出演項目の所属を確認してください。`,
        details: invalid.scheduleItemIds.length > 0
          ? [`対象項目: ${invalid.scheduleItemIds.length}件`] : undefined,
        targetStep: 2, eventDayId: eventDay.id,
        ...(stage ? { stageId: stage.id } : {}),
      })
    }

    let dayIssues: ScheduleIssue[] = []
    try {
      dayIssues = detectScheduleIssues({
        event: input.event,
        members: input.members,
        eventMembers,
        eventMemberDays,
        eventBands,
        stages: dayStages,
        sections,
        paAssignments: paAssignments.filter(assignment => assignment.eventDayId === eventDay.id),
        dutyTypes,
        dutyAssignments: dutyAssignments.filter(assignment =>
          assignment.eventDayId === eventDay.id,
        ),
        calculatedItems: timelines.calculatedItems,
      })
      for (const issue of dayIssues) {
        const scope = resolveScope(issue)
        const details = [
          issue.gapBands !== undefined ? `バンド間隔: ${issue.gapBands}` : undefined,
          issue.restMinutes !== undefined ? `休憩時間: ${issue.restMinutes}分` : undefined,
          issue.overrunMinutes !== undefined ? `超過時間: ${issue.overrunMinutes}分` : undefined,
        ].filter((detail): detail is string => detail !== undefined)
        addFinding({
          key: `schedule|${issueKey(issue)}`,
          severity: issue.severity,
          category: 'schedule',
          code: issue.code,
          message: formatScheduleIssueMessage(issue, {
            members: input.members,
            eventBands,
            dutyTypes,
            stages,
            sections,
          }),
          ...(details.length > 0 ? { details } : {}),
          targetStep: getFinalCheckRepairTarget(issue.code),
          ...scope,
        })
      }
    } catch {
      addFinding({
        key: `structure|issue-detection-failure|${eventDay.id}`,
        severity: 'ERROR', category: 'structure', code: 'ISSUE_DETECTION_FAILED',
        message: `${dayLabel}の問題をすべて確認できません。タイムテーブルの参照を確認してください。`,
        targetStep: 6, eventDayId: eventDay.id,
      })
    }

    const invalidPaIds = new Set(dayIssues.filter(issue => issue.severity === 'ERROR')
      .flatMap(issue => issue.paAssignmentIds ?? []))
    const invalidDutyIds = new Set(dayIssues.filter(issue => issue.severity === 'ERROR')
      .flatMap(issue => issue.dutyAssignmentIds ?? []))
    for (const stage of dayStages) {
      try {
        const workspace = createTimetableWorkspaceRows({
          eventDayId: eventDay.id,
          stageId: stage.id,
          scheduleItems,
          calculatedItems: timelines.calculatedItems.filter(item => item.stageId === stage.id),
          eventBands,
          members: input.members,
          paAssignments,
          dutyTypes,
          dutyAssignments,
          issues: dayIssues,
          stages,
          sections,
        })
        for (const assignment of workspace.unresolvedPaAssignments) {
          if (invalidPaIds.has(assignment.assignmentId)) continue
          addFinding({
            key: `operations|unresolved-pa|${assignment.assignmentId}`,
            severity: 'WARNING', category: 'operations', code: 'UNRESOLVED_PA_ASSIGNMENT',
            message: `${assignment.memberName}の${assignment.role === 'main' ? 'Main' : 'Sub'} PA担当を表示できません。`,
            details: [assignment.reason], targetStep: 6,
            eventDayId: eventDay.id, stageId: stage.id,
          })
        }
        for (const assignment of workspace.offGridPaAssignments) addFinding({
          key: `operations|off-grid-pa|${assignment.assignmentId}`,
          severity: 'WARNING', category: 'operations', code: 'OFF_GRID_PA_ASSIGNMENT',
          message: `${assignment.memberName}の${assignment.role === 'main' ? 'Main' : 'Sub'} PA担当がタイムテーブル行の外にあります。`,
          targetStep: 6, eventDayId: eventDay.id, stageId: stage.id,
        })
        for (const assignment of workspace.unresolvedDutyAssignments) {
          if (invalidDutyIds.has(assignment.assignmentId)) continue
          addFinding({
            key: `operations|unresolved-duty|${assignment.assignmentId}`,
            severity: 'WARNING', category: 'operations', code: 'UNRESOLVED_DUTY_ASSIGNMENT',
            message: `${assignment.dutyTypeName}（${assignment.memberName}）の担当を表示できません。`,
            details: [assignment.reason], targetStep: 6,
            eventDayId: eventDay.id, stageId: stage.id,
          })
        }
        for (const assignment of workspace.offGridDutyAssignments) addFinding({
          key: `operations|off-grid-duty|${assignment.assignmentId}`,
          severity: 'WARNING', category: 'operations', code: 'OFF_GRID_DUTY_ASSIGNMENT',
          message: `${assignment.dutyTypeName}（${assignment.memberName}）の担当がタイムテーブル行の外にあります。`,
          targetStep: 6, eventDayId: eventDay.id, stageId: stage.id,
        })
      } catch {
        addFinding({
          key: `operations|workspace-failure|${stage.id}`,
          severity: 'ERROR', category: 'operations', code: 'WORKSPACE_EVALUATION_FAILED',
          message: `${stage.name}のPA・当日運営担当を確認できません。`,
          targetStep: 6, eventDayId: eventDay.id, stageId: stage.id,
        })
      }
    }
  }

  try {
    const lockEvaluation = evaluateTimetableLocks({
      eventId: input.event.id,
      timetableLocks,
      scheduleItems,
      eventBands,
      eventDays,
      stages,
      sections,
    })
    for (const violation of lockEvaluation.violations) {
      const item = violation.scheduleItemIds?.map(id => scheduleItemById.get(id)).find(Boolean)
      const lock = violation.lockIds.map(id => timetableLocks.find(candidate => candidate.id === id))
        .find(Boolean)
      const stage = stageById.get(item?.stageId ?? lock?.stageId ?? '')
      addFinding({
        key: `lock|${violation.code}|${uniqueSorted(violation.lockIds).join(',')}|${uniqueSorted(violation.scheduleItemIds ?? []).join(',')}`,
        severity: 'ERROR', category: 'timetable-lock', code: violation.code,
        message: violation.message, targetStep: 6,
        ...(stage ? { eventDayId: stage.eventDayId, stageId: stage.id } : {}),
      })
    }
  } catch {
    addFinding({
      key: 'lock|evaluation-failure', severity: 'ERROR', category: 'timetable-lock',
      code: 'TIMETABLE_LOCK_EVALUATION_FAILED', message: 'TT固定の状態を確認できません。',
      targetStep: 6,
    })
  }

  try {
    const semantic = evaluateTimetableOrderConstraints({
      eventId: input.event.id,
      timetableOrderConstraints: orderConstraints,
      eventDays,
      stages,
      sections,
      eventBands,
    })
    for (const violation of semantic.violations) {
      const constraint = violation.constraintIds.map(id =>
        orderConstraints.find(candidate => candidate.id === id)).find(Boolean)
      const stage = constraint ? stageById.get(constraint.stageId) : undefined
      const names = uniqueSorted(violation.eventBandIds.map(id =>
        eventBandById.get(id)?.name ?? '不明なバンド'))
      addFinding({
        key: `order-semantic|${violation.code}|${uniqueSorted(violation.constraintIds).join(',')}|${uniqueSorted(violation.eventBandIds).join(',')}`,
        severity: 'ERROR', category: 'order-constraint', code: violation.code,
        message: violation.message,
        ...(names.length > 0 ? { details: [`対象バンド: ${names.join('、')}`] } : {}),
        targetStep: 6,
        ...(constraint?.eventDayId ? { eventDayId: constraint.eventDayId } : {}),
        ...(stage ? { stageId: stage.id } : {}),
      })
    }
    const invalidConstraintIds = new Set(semantic.violations.flatMap(item => item.constraintIds))
    const validConstraints = orderConstraints.filter(item => !invalidConstraintIds.has(item.id))
    const scheduled = evaluateScheduledTimetableOrderConstraints({
      timetableOrderConstraints: validConstraints,
      scheduleItems,
    })
    for (const violation of scheduled.violations) {
      const constraint = validConstraints.find(item => item.id === violation.constraintId)
      const stage = constraint ? stageById.get(constraint.stageId) : undefined
      const names = uniqueSorted(violation.eventBandIds.map(id =>
        eventBandById.get(id)?.name ?? '不明なバンド'))
      addFinding({
        key: `order-scheduled|${violation.code}|${violation.constraintId}|${uniqueSorted(violation.eventBandIds).join(',')}`,
        severity: 'ERROR', category: 'order-constraint', code: violation.code,
        message: scheduledOrderMessage(violation.code, names), targetStep: 6,
        ...(constraint?.eventDayId ? { eventDayId: constraint.eventDayId } : {}),
        ...(stage ? { stageId: stage.id } : {}),
      })
    }
  } catch {
    addFinding({
      key: 'order|evaluation-failure', severity: 'ERROR', category: 'order-constraint',
      code: 'ORDER_CONSTRAINT_EVALUATION_FAILED', message: '出演順制約の状態を確認できません。',
      targetStep: 6,
    })
  }

  const orderedFindings = [...findings.values()].sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    (left.eventDayId === undefined ? -1 : dayOrder.get(left.eventDayId) ?? Number.MAX_SAFE_INTEGER) -
      (right.eventDayId === undefined ? -1 : dayOrder.get(right.eventDayId) ?? Number.MAX_SAFE_INTEGER) ||
    (left.stageId === undefined ? -1 : stageOrder.get(left.stageId) ?? Number.MAX_SAFE_INTEGER) -
      (right.stageId === undefined ? -1 : stageOrder.get(right.stageId) ?? Number.MAX_SAFE_INTEGER) ||
    compareStableText(left.category, right.category) ||
    compareStableText(left.code, right.code) ||
    compareStableText(left.key, right.key))

  return { findings: orderedFindings, counts: countIssuesBySeverity(orderedFindings) }
}
