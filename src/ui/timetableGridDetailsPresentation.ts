import type { IssueSeverity, ScheduleIssue } from '../domain/issues'
import type { TimeRange } from '../domain/models'

export type TimetableTimeConditionKind = 'available' | 'preferred'

export interface TimetableTimeConditionPresentation {
  title: string
  summary: string
}

export interface AnchoredOverlayPositionInput {
  anchor: {
    top: number
    right: number
    bottom: number
    left: number
  }
  overlayWidth: number
  overlayHeight: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
  gap?: number
  horizontalAlignment?: 'start' | 'end'
}

export interface AnchoredOverlayPosition {
  top: number
  left: number
  maxHeight: number
  placement: 'above' | 'below'
}

export const getScheduleItemIssuesBySeverity = (
  issues: ReadonlyArray<ScheduleIssue>,
  scheduleItemId: string,
  severity: IssueSeverity,
): ScheduleIssue[] => issues.filter(issue =>
  issue.severity === severity &&
  issue.scheduleItemIds?.includes(scheduleItemId) === true,
)

export const formatTimetableTimeCondition = (
  range: TimeRange,
  kind: TimetableTimeConditionKind,
): TimetableTimeConditionPresentation => {
  const title = kind === 'available' ? '必須時間条件' : '希望時間条件'
  const label = kind === 'available' ? '出演可能時間' : '希望時間'
  const summary = range.from && range.until
    ? `${label}：${range.from}〜${range.until}`
    : range.from
      ? `${label}：${range.from}以降`
      : `${label}：${range.until}まで`

  return { title, summary }
}

export const getIssueBadgeTooltip = (
  severity: IssueSeverity,
  messages: ReadonlyArray<string>,
): string => {
  const representative = messages[0]
  return representative
    ? `${severity} ${messages.length}件: ${representative}。クリックで全件を表示`
    : `${severity} 0件`
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))

export const getAnchoredOverlayPosition = ({
  anchor,
  overlayWidth,
  overlayHeight,
  viewportWidth,
  viewportHeight,
  margin = 8,
  gap = 6,
  horizontalAlignment = 'start',
}: AnchoredOverlayPositionInput): AnchoredOverlayPosition => {
  const availableBelow = viewportHeight - anchor.bottom - margin - gap
  const availableAbove = anchor.top - margin - gap
  const placement = availableBelow >= Math.min(overlayHeight, 180) ||
    availableBelow >= availableAbove
    ? 'below'
    : 'above'
  const viewportMaxHeight = Math.max(48, viewportHeight - margin * 2)
  const maxHeight = Math.min(
    viewportMaxHeight,
    Math.max(
      96,
      placement === 'below' ? availableBelow : availableAbove,
    ),
  )
  const visibleHeight = Math.min(overlayHeight, maxHeight)
  const top = placement === 'below'
    ? anchor.bottom + gap
    : anchor.top - gap - visibleHeight
  const left = clamp(
    horizontalAlignment === 'end'
      ? anchor.right - overlayWidth
      : anchor.left,
    margin,
    viewportWidth - overlayWidth - margin,
  )

  return {
    top: clamp(top, margin, viewportHeight - visibleHeight - margin),
    left,
    maxHeight,
    placement,
  }
}
