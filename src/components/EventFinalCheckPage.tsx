import { useMemo, useState } from 'react'
import type { IssueSeverity } from '../domain/issues'
import type {
  EventFinalCheckFinding,
  EventFinalCheckReport,
} from '../ui/eventFinalCheckReport'
import type { EventDay, Stage } from '../domain/models'
import { ISSUE_SEVERITIES } from '../ui/issuePresentation'
import { eventEditorSteps, type EventEditorStepId } from '../ui/eventEditorSteps'
import {
  getEventFinalCheckStatusMessage,
  groupEventFinalCheckFindingsForDisplay,
  type EventFinalCheckRepairTarget,
} from '../ui/eventFinalCheckPresentation'

interface EventFinalCheckPageProps {
  report: EventFinalCheckReport
  eventDays: EventDay[]
  stages: Stage[]
  onNavigateToRepair: (target: EventFinalCheckRepairTarget) => void
  onProceed: () => void
}

type SeverityFilter = 'ALL' | IssueSeverity

const filterLabels: Record<SeverityFilter, string> = {
  ALL: 'すべて', ERROR: 'ERROR', WARNING: 'WARNING', INFO: 'INFO',
}

const getStepLabel = (stepId: EventEditorStepId): string => {
  const step = eventEditorSteps.find(candidate => candidate.id === stepId)
  return `Step ${stepId}${step ? ` ${step.label}` : ''}へ`
}

const FindingCard = ({
  finding,
  onNavigate,
}: {
  finding: EventFinalCheckFinding
  onNavigate: (target: EventFinalCheckRepairTarget) => void
}) => (
  <article className={`event-final-check__finding event-final-check__finding--${finding.severity.toLowerCase()}`}>
    <div className="event-final-check__finding-heading">
      <span className={`issue-severity-label issue-severity-label--${finding.severity.toLowerCase()}`}>
        {finding.severity}
      </span>
      <p>{finding.message}</p>
    </div>
    {finding.details && finding.details.length > 0 && (
      <ul className="event-final-check__details">
        {finding.details.map(detail => <li key={detail}>{detail}</li>)}
      </ul>
    )}
    <button
      type="button"
      className="secondary-button"
      onClick={() => onNavigate({
        step: finding.targetStep,
        eventDayId: finding.eventDayId,
        stageId: finding.stageId,
      })}
    >
      {getStepLabel(finding.targetStep)}
    </button>
  </article>
)

export function EventFinalCheckPage({
  report,
  eventDays,
  stages,
  onNavigateToRepair,
  onProceed,
}: EventFinalCheckPageProps) {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL')
  const visibleFindings = useMemo(() => severityFilter === 'ALL'
    ? report.findings
    : report.findings.filter(finding => finding.severity === severityFilter),
  [report.findings, severityFilter])
  const { globalFindings, dayGroups, ungrouped } = useMemo(() =>
    groupEventFinalCheckFindingsForDisplay({
      findings: visibleFindings,
      eventDays,
      stages,
    }), [eventDays, stages, visibleFindings])
  const totalCount = report.findings.length
  const hasErrors = report.counts.ERROR > 0
  const statusMessage = getEventFinalCheckStatusMessage(report.counts)

  return (
    <div className="event-final-check">
      <section
        className={`event-final-check__status event-final-check__status--${hasErrors ? 'error' : 'ready'}`}
        aria-labelledby="event-final-check-status-title"
      >
        <div>
          <h3 id="event-final-check-status-title">
            {hasErrors ? '公開前に修正が必要な項目があります' : totalCount === 0
              ? '問題は見つかりませんでした' : '公開・出力へ進めます'}
          </h3>
          <p>{statusMessage}</p>
        </div>
        <div className="event-final-check__summary" aria-label="問題件数">
          {ISSUE_SEVERITIES.map(severity => (
            <span key={severity} className={`event-final-check__count event-final-check__count--${severity.toLowerCase()}`}>
              <strong>{severity}</strong>
              <b>{report.counts[severity]}</b>
            </span>
          ))}
        </div>
      </section>

      <div className="event-final-check__filters" aria-label="重要度で絞り込み">
        {(['ALL', ...ISSUE_SEVERITIES] as SeverityFilter[]).map(filter => {
          const count = filter === 'ALL' ? totalCount : report.counts[filter]
          return (
            <button
              key={filter}
              type="button"
              className={severityFilter === filter ? 'is-active' : ''}
              aria-pressed={severityFilter === filter}
              onClick={() => setSeverityFilter(filter)}
            >
              {filterLabels[filter]} {count}
            </button>
          )
        })}
      </div>

      <div className="event-final-check__groups" aria-live="polite">
        {visibleFindings.length === 0 ? (
          <p className="event-final-check__empty">
            {totalCount === 0 ? '問題は見つかりませんでした。' : 'この重要度の問題はありません。'}
          </p>
        ) : (
          <>
            {globalFindings.length > 0 && (
              <section className="event-final-check__group">
                <h3>イベント全体</h3>
                <div className="event-final-check__finding-list">
                  {globalFindings.map(finding => (
                    <FindingCard key={finding.key} finding={finding} onNavigate={onNavigateToRepair} />
                  ))}
                </div>
              </section>
            )}
            {dayGroups.map(({
              eventDay,
              dayOnly,
              stageGroups,
              unresolvedStageFindings,
            }) => (
              <section key={eventDay.id} className="event-final-check__group">
                <h3>{eventDay.label || eventDay.date}</h3>
                {dayOnly.length > 0 && (
                  <div className="event-final-check__finding-list">
                    {dayOnly.map(finding => (
                      <FindingCard key={finding.key} finding={finding} onNavigate={onNavigateToRepair} />
                    ))}
                  </div>
                )}
                {stageGroups.map(({ stage, findings }) => (
                  <section key={stage.id} className="event-final-check__stage-group">
                    <h4>{stage.name}</h4>
                    <div className="event-final-check__finding-list">
                      {findings.map(finding => (
                        <FindingCard key={finding.key} finding={finding} onNavigate={onNavigateToRepair} />
                      ))}
                    </div>
                  </section>
                ))}
                {unresolvedStageFindings.length > 0 && (
                  <section className="event-final-check__stage-group">
                    <h4>Stage参照を確認してください</h4>
                    <div className="event-final-check__finding-list">
                      {unresolvedStageFindings.map(finding => (
                        <FindingCard key={finding.key} finding={finding} onNavigate={onNavigateToRepair} />
                      ))}
                    </div>
                  </section>
                )}
              </section>
            ))}
            {ungrouped.length > 0 && (
              <section className="event-final-check__group">
                <h3>参照を確認できない項目</h3>
                <div className="event-final-check__finding-list">
                  {ungrouped.map(finding => (
                    <FindingCard key={finding.key} finding={finding} onNavigate={onNavigateToRepair} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="event-final-check__footer">
        {hasErrors && <p>ERRORが残っています。公開前に修正内容を確認してください。</p>}
        <button type="button" className="primary-button" onClick={onProceed}>
          Step 8 公開・出力へ <span aria-hidden="true">→</span>
        </button>
      </footer>
    </div>
  )
}
