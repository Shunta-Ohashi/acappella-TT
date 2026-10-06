import { useMemo, useState } from 'react'
import type { IssueSeverity } from '../domain/issues'
import type {
  EventFinalCheckFinding,
  EventFinalCheckReport,
} from '../domain/eventFinalCheck'
import type { EventDay, Stage } from '../domain/models'
import { ISSUE_SEVERITIES } from '../ui/issuePresentation'
import { eventEditorSteps, type EventEditorStepId } from '../ui/eventEditorSteps'
import type { EventFinalCheckRepairTarget } from '../ui/eventFinalCheckPresentation'

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
  const eventDayById = new Map(eventDays.map(day => [day.id, day]))
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const globalFindings = visibleFindings.filter(finding => !finding.eventDayId)
  const dayGroups = eventDays.flatMap(eventDay => {
    const dayFindings = visibleFindings.filter(finding => finding.eventDayId === eventDay.id)
    if (dayFindings.length === 0) return []
    const dayOnly = dayFindings.filter(finding => !finding.stageId)
    const stageGroups = stages.filter(stage => stage.eventDayId === eventDay.id)
      .flatMap(stage => {
        const findings = dayFindings.filter(finding => finding.stageId === stage.id)
        return findings.length > 0 ? [{ stage, findings }] : []
      })
    const staleStageFindings = dayFindings.filter(finding =>
      finding.stageId !== undefined && !stageById.has(finding.stageId),
    )
    return [{ eventDay, dayOnly, stageGroups, staleStageFindings }]
  })
  const ungrouped = visibleFindings.filter(finding =>
    finding.eventDayId !== undefined && !eventDayById.has(finding.eventDayId),
  )
  const totalCount = report.findings.length
  const hasErrors = report.counts.ERROR > 0

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
          <p>{hasErrors
            ? 'ERRORの項目を確認し、各Stepで修正してください。'
            : report.counts.WARNING > 0
              ? '致命的な問題はありません。警告を確認してください。'
              : '致命的な問題はありません。'}</p>
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
            {dayGroups.map(({ eventDay, dayOnly, stageGroups, staleStageFindings }) => (
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
                {staleStageFindings.length > 0 && (
                  <section className="event-final-check__stage-group">
                    <h4>不明なStage</h4>
                    <div className="event-final-check__finding-list">
                      {staleStageFindings.map(finding => (
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
