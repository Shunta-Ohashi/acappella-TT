import type { EventDayId, EventId, MemberId } from '../domain/models'
import type { TimetableWorkspaceRow } from './timetableWorkspaceRows'

export const TIMETABLE_MEMBER_MATRIX_MINIMUM_MEMBER_COLUMNS = 7

export type TimetableViewMode = 'standard' | 'member-matrix'

export interface TimetableMemberHighlight {
  persistenceScopeKey: string
  persistenceVisitId: string
  eventId: EventId
  eventDayId: EventDayId
  memberId: MemberId
}

export interface TimetableMemberHighlightContext {
  persistenceScopeKey: string
  persistenceVisitId: string
  eventId?: EventId
  eventDayId?: EventDayId
}

export const getTimetableMemberColumnCount = (
  rows: readonly TimetableWorkspaceRow[],
): number => Math.max(
  TIMETABLE_MEMBER_MATRIX_MINIMUM_MEMBER_COLUMNS,
  ...rows.map(row => row.memberCells.length),
)

export const countTimetableMemberAppearances = (
  rows: readonly TimetableWorkspaceRow[],
  memberId: MemberId,
): number => rows.reduce(
  (count, row) => count + row.memberCells.filter(
    member => member.memberId === memberId,
  ).length,
  0,
)

export const resolveTimetableMemberHighlight = (
  highlight: TimetableMemberHighlight | null,
  context: TimetableMemberHighlightContext,
  existingMemberIds: ReadonlySet<MemberId>,
): MemberId | null => (
  highlight &&
  context.eventId !== undefined &&
  context.eventDayId !== undefined &&
  highlight.persistenceScopeKey === context.persistenceScopeKey &&
  highlight.persistenceVisitId === context.persistenceVisitId &&
  highlight.eventId === context.eventId &&
  highlight.eventDayId === context.eventDayId &&
  existingMemberIds.has(highlight.memberId)
    ? highlight.memberId
    : null
)

export const toggleTimetableMemberHighlight = (
  current: TimetableMemberHighlight | null,
  context: Required<TimetableMemberHighlightContext>,
  memberId: MemberId,
): TimetableMemberHighlight | null => {
  const next = { ...context, memberId }
  return current &&
    current.persistenceScopeKey === next.persistenceScopeKey &&
    current.persistenceVisitId === next.persistenceVisitId &&
    current.eventId === next.eventId &&
    current.eventDayId === next.eventDayId &&
    current.memberId === next.memberId
    ? null
    : next
}
