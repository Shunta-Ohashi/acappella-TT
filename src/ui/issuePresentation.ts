import type { IssueSeverity, ScheduleIssue } from '../domain/issues'
import type { ScheduleItemId } from '../domain/models'

export const ISSUE_SEVERITIES: IssueSeverity[] = [
  'ERROR',
  'WARNING',
  'INFO',
]

const severityPriority: Record<IssueSeverity, number> = {
  ERROR: 3,
  WARNING: 2,
  INFO: 1,
}

export type IssueSeverityCounts = Record<IssueSeverity, number>

export const countIssuesBySeverity = (
  issues: ScheduleIssue[],
): IssueSeverityCounts => {
  const counts: IssueSeverityCounts = {
    ERROR: 0,
    WARNING: 0,
    INFO: 0,
  }

  issues.forEach((issue) => {
    counts[issue.severity] += 1
  })

  return counts
}

export const getHighestSeverityByScheduleItem = (
  issues: ScheduleIssue[],
): Map<ScheduleItemId, IssueSeverity> => {
  const severityByScheduleItem = new Map<ScheduleItemId, IssueSeverity>()

  issues.forEach((issue) => {
    issue.scheduleItemIds?.forEach((scheduleItemId) => {
      const currentSeverity = severityByScheduleItem.get(scheduleItemId)
      if (
        !currentSeverity ||
        severityPriority[issue.severity] > severityPriority[currentSeverity]
      ) {
        severityByScheduleItem.set(scheduleItemId, issue.severity)
      }
    })
  })

  return severityByScheduleItem
}
