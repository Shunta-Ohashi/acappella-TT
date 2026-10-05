import type {
  DutyType,
  DutyTypeId,
  EventDayId,
  PaRole,
  ScheduleBoundary,
  ScheduleItemId,
  StageId,
} from '../domain/models'
import type { TimetableWorkspaceRow } from './timetableWorkspaceRows'

export type TimetableGridAssignmentTarget =
  | { kind: 'pa'; role: PaRole }
  | { kind: 'duty'; dutyTypeId: DutyTypeId }

export interface TimetableGridRangeSelection {
  eventDayId: EventDayId
  stageId: StageId
  target: TimetableGridAssignmentTarget
  anchorScheduleItemId: ScheduleItemId
  focusScheduleItemId: ScheduleItemId
}

export interface ResolvedTimetableGridRangeSelection {
  eventDayId: EventDayId
  stageId: StageId
  target: TimetableGridAssignmentTarget
  firstRow: TimetableWorkspaceRow
  lastRow: TimetableWorkspaceRow
  scheduleItemIds: ScheduleItemId[]
  rowCount: number
  fromMinute: number
  untilMinute: number
  fromBoundary: ScheduleBoundary
  untilBoundary: ScheduleBoundary
}

interface SelectTimetableGridCellInput {
  selection: TimetableGridRangeSelection | null
  eventDayId: EventDayId
  stageId: StageId
  target: TimetableGridAssignmentTarget
  scheduleItemId: ScheduleItemId
  extend: boolean
}

export const areTimetableGridAssignmentTargetsEqual = (
  left: TimetableGridAssignmentTarget,
  right: TimetableGridAssignmentTarget,
): boolean => left.kind === right.kind && (
  left.kind === 'pa'
    ? right.kind === 'pa' && left.role === right.role
    : right.kind === 'duty' && left.dutyTypeId === right.dutyTypeId
)

export const selectTimetableGridCell = ({
  selection,
  eventDayId,
  stageId,
  target,
  scheduleItemId,
  extend,
}: SelectTimetableGridCellInput): TimetableGridRangeSelection => {
  const canExtend = extend && selection !== null &&
    selection.eventDayId === eventDayId &&
    selection.stageId === stageId &&
    areTimetableGridAssignmentTargetsEqual(selection.target, target)

  return {
    eventDayId,
    stageId,
    target,
    anchorScheduleItemId: canExtend
      ? selection.anchorScheduleItemId
      : scheduleItemId,
    focusScheduleItemId: scheduleItemId,
  }
}

export const resolveTimetableGridSelection = (
  selection: TimetableGridRangeSelection,
  rows: readonly TimetableWorkspaceRow[],
): ResolvedTimetableGridRangeSelection | undefined => {
  const rowIndexByScheduleItemId = new Map<ScheduleItemId, number>()
  for (const [index, row] of rows.entries()) {
    const scheduleItemId = row.scheduleItem.id
    if (rowIndexByScheduleItemId.has(scheduleItemId)) return undefined
    rowIndexByScheduleItemId.set(scheduleItemId, index)
  }

  const anchorIndex = rowIndexByScheduleItemId.get(
    selection.anchorScheduleItemId,
  )
  const focusIndex = rowIndexByScheduleItemId.get(
    selection.focusScheduleItemId,
  )
  if (anchorIndex === undefined || focusIndex === undefined) return undefined

  const firstIndex = Math.min(anchorIndex, focusIndex)
  const lastIndex = Math.max(anchorIndex, focusIndex)
  const selectedRows = rows.slice(firstIndex, lastIndex + 1)
  if (selectedRows.some((row) =>
    row.calculatedItem.eventDayId !== selection.eventDayId ||
    row.calculatedItem.stageId !== selection.stageId,
  )) return undefined

  const firstRow = selectedRows[0]
  const lastRow = selectedRows.at(-1)
  if (!firstRow || !lastRow) return undefined

  return {
    eventDayId: selection.eventDayId,
    stageId: selection.stageId,
    target: selection.target,
    firstRow,
    lastRow,
    scheduleItemIds: selectedRows.map((row) => row.scheduleItem.id),
    rowCount: selectedRows.length,
    fromMinute: firstRow.calculatedItem.plannedStartMinute,
    untilMinute: lastRow.calculatedItem.plannedEndMinute,
    fromBoundary: {
      kind: 'schedule-item',
      scheduleItemId: firstRow.scheduleItem.id,
      edge: 'start',
    },
    untilBoundary: {
      kind: 'schedule-item',
      scheduleItemId: lastRow.scheduleItem.id,
      edge: 'end',
    },
  }
}

export const getTimetableGridAssignmentTargetLabel = (
  target: TimetableGridAssignmentTarget,
  dutyTypes: readonly Pick<DutyType, 'id' | 'name'>[],
): string => {
  if (target.kind === 'pa') {
    return target.role === 'main' ? 'Main PA' : 'Sub PA'
  }

  return dutyTypes.find((dutyType) => dutyType.id === target.dutyTypeId)?.name
    ?? '不明な当日運営担当'
}
