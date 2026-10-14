import type { ScheduleIssue } from '../domain/issues'
import type {
  EventBand,
  DutyType,
  Member,
  Section,
  Stage,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import {
  countIssuesBySeverity,
  createScheduleIssueDetailPresentation,
  ISSUE_SEVERITIES,
} from '../ui/issuePresentation'

interface IssuePanelProps {
  issues: ScheduleIssue[]
  members: Member[]
  eventBands: EventBand[]
  dutyTypes?: DutyType[]
  stages: Stage[]
  sections: Section[]
  calculatedItems: CalculatedScheduleItem[]
}

export function IssuePanel({
  issues,
  members,
  eventBands,
  dutyTypes = [],
  stages,
  sections,
  calculatedItems,
}: IssuePanelProps) {
  const counts = countIssuesBySeverity(issues)
  const issueContext = { members, eventBands, dutyTypes, stages, sections }

  return (
    <section className="issue-panel" aria-labelledby="issue-panel-title">
      <h3 id="issue-panel-title" className="issue-panel__title">
        問題チェック
      </h3>

      <div className="issue-summary" aria-live="polite">
        {ISSUE_SEVERITIES.map((severity) => (
          <span
            key={severity}
            className={`issue-summary__count issue-summary__count--${severity.toLowerCase()}`}
          >
            <strong>{severity}</strong> {counts[severity]}件
          </span>
        ))}
      </div>

      {issues.length === 0 ? (
        <p className="issue-panel__empty">
          現在、検出された問題はありません
        </p>
      ) : (
        <ul className="issue-list">
          {issues.map((issue, index) => {
            const details = createScheduleIssueDetailPresentation(
              issue,
              issueContext,
              calculatedItems,
            )

            return (
              <li
                key={[
                  issue.code,
                  issue.memberIds?.join('-'),
                  issue.eventBandIds?.join('-'),
                  issue.scheduleItemIds?.join('-'),
                  issue.stageIds?.join('-'),
                  issue.sectionIds?.join('-'),
                  issue.paAssignmentIds?.join('-'),
                  issue.dutyAssignmentIds?.join('-'),
                  index,
                ].join('|')}
                className={`issue-list__item issue-list__item--${issue.severity.toLowerCase()}`}
              >
                <div className="issue-list__heading">
                  <span
                    className={`issue-severity-label issue-severity-label--${issue.severity.toLowerCase()}`}
                  >
                    {issue.severity}
                  </span>
                  <span className="issue-list__message">
                    {details.message}
                  </span>
                </div>
                {details.targets.length > 0 && (
                  <div className="issue-list__details">
                    対象: {details.targets.join(' / ')}
                  </div>
                )}
                {details.metrics.length > 0 && (
                  <div className="issue-list__details">
                    {details.metrics.join(' / ')}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
