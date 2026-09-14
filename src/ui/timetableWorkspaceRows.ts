import type { ScheduleIssue } from '../domain/issues'
import type {
  EventBand,
  EventDayId,
  DutyAssignment,
  DutyAssignmentId,
  DutyType,
  DutyTypeId,
  Member,
  PaAssignment,
  PaAssignmentId,
  PaRole,
  ScheduleItem,
  StageId,
} from '../domain/models'
import { resolveDutyAssignmentInterval } from '../domain/dutyAssignments.ts'
import {
  intervalsOverlap,
  resolvePaAssignmentInterval,
} from '../domain/paAssignments.ts'
import type { CalculatedScheduleItem } from '../domain/timeline'
import {
  getEventBandMemberDisplayNames,
  getMemberDisplayName,
} from './eventBandPresentation.ts'
import {
  countIssuesBySeverity,
  type IssueSeverityCounts,
} from './issuePresentation.ts'

export interface TimetableWorkspacePaCoverage {
  assignmentId: PaAssignmentId
  memberName: string
  role: PaRole
  startsHere: boolean
  endsHere: boolean
}

export interface TimetableWorkspaceDutyCoverage {
  assignmentId: DutyAssignmentId
  dutyTypeId: DutyTypeId
  memberName: string
  startsHere: boolean
  endsHere: boolean
  issueCounts: IssueSeverityCounts
}

export interface TimetableWorkspaceRow {
  scheduleItem: ScheduleItem
  calculatedItem: CalculatedScheduleItem
  eventBand?: EventBand
  memberNames: string[]
  issueCounts: IssueSeverityCounts
  fixedPlacementLabels: string[]
  hasHardTimeCondition: boolean
  hasPreferredTimeCondition: boolean
  paCoverage: Record<PaRole, TimetableWorkspacePaCoverage[]>
  dutyCoverage: Record<DutyTypeId, TimetableWorkspaceDutyCoverage[]>
}

export interface UnresolvedPaAssignment {
  assignmentId: PaAssignmentId
  memberName: string
  role: PaRole
  reason: string
}

export interface OffGridPaAssignment {
  assignmentId: PaAssignmentId
  memberName: string
  role: PaRole
  fromMinute: number
  untilMinute: number
}

export interface UnresolvedDutyAssignment {
  assignmentId: DutyAssignmentId
  dutyTypeName: string
  memberName: string
  reason: string
}

export interface OffGridDutyAssignment {
  assignmentId: DutyAssignmentId
  dutyTypeName: string
  memberName: string
  fromMinute: number
  untilMinute: number
}

export interface TimetableWorkspaceRowsResult {
  rows: TimetableWorkspaceRow[]
  unresolvedPaAssignments: UnresolvedPaAssignment[]
  offGridPaAssignments: OffGridPaAssignment[]
  unresolvedDutyAssignments: UnresolvedDutyAssignment[]
  offGridDutyAssignments: OffGridDutyAssignment[]
}

interface CreateTimetableWorkspaceRowsInput {
  eventDayId: EventDayId
  stageId: StageId
  scheduleItems: ScheduleItem[]
  calculatedItems: CalculatedScheduleItem[]
  eventBands: EventBand[]
  members: Member[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  issues: ScheduleIssue[]
}

const getFixedPlacementLabels = (eventBand: EventBand): string[] => {
  const placement = eventBand.fixedPlacement
  if (!placement) return []

  const labels = ['Stage固定']
  if (placement.sectionId) labels.push('Section固定')
  if (placement.plannedStartTime) {
    labels.push(`開始 ${placement.plannedStartTime}`)
  }
  if (placement.position?.kind === 'first') labels.push('先頭固定')
  if (placement.position?.kind === 'last') labels.push('最後固定')
  if (placement.position?.kind === 'index') {
    labels.push(`${placement.position.index + 1}番目固定`)
  }

  return labels
}

export const createTimetableWorkspaceRows = ({
  eventDayId,
  stageId,
  scheduleItems,
  calculatedItems,
  eventBands,
  members,
  paAssignments,
  dutyTypes,
  dutyAssignments,
  issues,
}: CreateTimetableWorkspaceRowsInput): TimetableWorkspaceRowsResult => {
  const scheduleItemById = new Map(
    scheduleItems.map((scheduleItem) => [scheduleItem.id, scheduleItem]),
  )
  const eventBandById = new Map(
    eventBands.map((eventBand) => [eventBand.id, eventBand]),
  )
  const memberById = new Map(members.map((member) => [member.id, member]))
  const rows = calculatedItems.flatMap((calculatedItem): TimetableWorkspaceRow[] => {
    const scheduleItem = scheduleItemById.get(calculatedItem.scheduleItemId)
    if (!scheduleItem) return []

    const eventBand = scheduleItem.kind === 'performance'
      ? eventBandById.get(scheduleItem.eventBandId)
      : undefined
    const rowIssues = issues.filter((issue) =>
      issue.scheduleItemIds?.includes(scheduleItem.id),
    )

    return [{
      scheduleItem,
      calculatedItem,
      ...(eventBand ? { eventBand } : {}),
      memberNames: eventBand
        ? getEventBandMemberDisplayNames(eventBand, members)
        : [],
      issueCounts: countIssuesBySeverity(rowIssues),
      fixedPlacementLabels: eventBand
        ? getFixedPlacementLabels(eventBand)
        : [],
      hasHardTimeCondition: eventBand?.availableTimeRange !== undefined,
      hasPreferredTimeCondition: eventBand?.preferredTimeRange !== undefined,
      paCoverage: { main: [], sub: [] },
      dutyCoverage: Object.fromEntries(
        dutyTypes.map((dutyType) => [dutyType.id, []]),
      ),
    }]
  })

  const unresolvedPaAssignments: UnresolvedPaAssignment[] = []
  const offGridPaAssignments: OffGridPaAssignment[] = []
  for (const assignment of paAssignments.filter((candidate) =>
    candidate.eventDayId === eventDayId && candidate.stageId === stageId,
  )) {
    const member = memberById.get(assignment.memberId)
    const memberName = member
      ? getMemberDisplayName(member)
      : '不明なメンバー'
    const resolution = resolvePaAssignmentInterval(assignment, calculatedItems)
    if (!resolution.ok) {
      unresolvedPaAssignments.push({
        assignmentId: assignment.id,
        memberName,
        role: assignment.role,
        reason: resolution.reason,
      })
      continue
    }

    const coveredRowIndexes = rows.flatMap((row, index) =>
      intervalsOverlap(resolution.interval, {
        fromMinute: row.calculatedItem.plannedStartMinute,
        untilMinute: row.calculatedItem.plannedEndMinute,
      })
        ? [index]
        : [],
    )

    if (coveredRowIndexes.length === 0) {
      offGridPaAssignments.push({
        assignmentId: assignment.id,
        memberName,
        role: assignment.role,
        fromMinute: resolution.interval.fromMinute,
        untilMinute: resolution.interval.untilMinute,
      })
      continue
    }

    coveredRowIndexes.forEach((rowIndex, coveredIndex) => {
      rows[rowIndex].paCoverage[assignment.role].push({
        assignmentId: assignment.id,
        memberName,
        role: assignment.role,
        startsHere: coveredIndex === 0,
        endsHere: coveredIndex === coveredRowIndexes.length - 1,
      })
    })
  }

  const dutyTypeById = new Map(
    dutyTypes.map((dutyType) => [dutyType.id, dutyType]),
  )
  const unresolvedDutyAssignments: UnresolvedDutyAssignment[] = []
  const offGridDutyAssignments: OffGridDutyAssignment[] = []
  for (const assignment of dutyAssignments.filter((candidate) =>
    candidate.eventDayId === eventDayId && candidate.stageId === stageId,
  )) {
    const dutyType = dutyTypeById.get(assignment.dutyTypeId)
    const dutyTypeName = dutyType?.name ?? '不明な仕事'
    const member = memberById.get(assignment.memberId)
    const memberName = member
      ? getMemberDisplayName(member)
      : '不明なメンバー'

    if (!dutyType) {
      unresolvedDutyAssignments.push({
        assignmentId: assignment.id,
        dutyTypeName,
        memberName,
        reason: '仕事の種類が見つかりません。',
      })
      continue
    }

    const resolution = resolveDutyAssignmentInterval(
      assignment,
      calculatedItems,
    )
    if (!resolution.ok) {
      unresolvedDutyAssignments.push({
        assignmentId: assignment.id,
        dutyTypeName,
        memberName,
        reason: resolution.reason,
      })
      continue
    }

    const coveredRowIndexes = rows.flatMap((row, index) =>
      intervalsOverlap(resolution.interval, {
        fromMinute: row.calculatedItem.plannedStartMinute,
        untilMinute: row.calculatedItem.plannedEndMinute,
      })
        ? [index]
        : [],
    )

    if (coveredRowIndexes.length === 0) {
      offGridDutyAssignments.push({
        assignmentId: assignment.id,
        dutyTypeName,
        memberName,
        fromMinute: resolution.interval.fromMinute,
        untilMinute: resolution.interval.untilMinute,
      })
      continue
    }

    const assignmentIssues = issues.filter((issue) =>
      issue.dutyAssignmentIds?.includes(assignment.id),
    )
    coveredRowIndexes.forEach((rowIndex, coveredIndex) => {
      rows[rowIndex].dutyCoverage[dutyType.id].push({
        assignmentId: assignment.id,
        dutyTypeId: dutyType.id,
        memberName,
        startsHere: coveredIndex === 0,
        endsHere: coveredIndex === coveredRowIndexes.length - 1,
        issueCounts: countIssuesBySeverity(assignmentIssues),
      })
    })
  }

  return {
    rows,
    unresolvedPaAssignments,
    offGridPaAssignments,
    unresolvedDutyAssignments,
    offGridDutyAssignments,
  }
}
