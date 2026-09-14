import type { ScheduleIssue } from '../domain/issues'
import type {
  EventBand,
  EventDayId,
  Member,
  PaAssignment,
  PaAssignmentId,
  PaRole,
  ScheduleItem,
  StageId,
} from '../domain/models'
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

export interface TimetableWorkspaceRowsResult {
  rows: TimetableWorkspaceRow[]
  unresolvedPaAssignments: UnresolvedPaAssignment[]
  offGridPaAssignments: OffGridPaAssignment[]
}

interface CreateTimetableWorkspaceRowsInput {
  eventDayId: EventDayId
  stageId: StageId
  scheduleItems: ScheduleItem[]
  calculatedItems: CalculatedScheduleItem[]
  eventBands: EventBand[]
  members: Member[]
  paAssignments: PaAssignment[]
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

  return { rows, unresolvedPaAssignments, offGridPaAssignments }
}
