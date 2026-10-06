import { useState, type ReactNode } from 'react'
import type { EventDay, EventDayId, Stage, StageId } from '../domain/models'
import type { IssueSeverityCounts } from '../ui/issuePresentation'

type OperationsPanel = 'issues' | 'order' | 'pa' | 'operations'

interface TimetableOperationsWorkspaceProps {
  eventDays: EventDay[]
  stages: Stage[]
  selectedEventDayId?: EventDayId
  selectedStageId?: StageId
  onSelectEventDay: (eventDayId: EventDayId) => void
  onSelectStage: (stageId: StageId) => void
  poolCount: number
  issueCounts: IssueSeverityCounts
  settings: ReactNode
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  historyFeedback: { kind: 'success' | 'error'; message: string } | null
  generationAction?: ReactNode
  unavailableContent?: ReactNode
  pool: ReactNode
  timetable: ReactNode
  issuePanel: ReactNode
  orderPanel: ReactNode
  renderPaPanel: (onValidationFailed: () => void) => ReactNode
  renderOperationsPanel: (onValidationFailed: () => void) => ReactNode
  footer: ReactNode
}

const panelLabels: Record<OperationsPanel, string> = {
  issues: '問題',
  order: '出演順',
  pa: 'PA',
  operations: '当日運営',
}

const formatEventDayLabel = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function TimetableOperationsWorkspace({
  eventDays,
  stages,
  selectedEventDayId,
  selectedStageId,
  onSelectEventDay,
  onSelectStage,
  poolCount,
  issueCounts,
  settings,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  historyFeedback,
  generationAction,
  unavailableContent,
  pool,
  timetable,
  issuePanel,
  orderPanel,
  renderPaPanel,
  renderOperationsPanel,
  footer,
}: TimetableOperationsWorkspaceProps) {
  const [activePanel, setActivePanel] = useState<OperationsPanel>('issues')
  const [isPoolOpen, setIsPoolOpen] = useState(true)
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(true)
  const issueCount = issueCounts.ERROR + issueCounts.WARNING + issueCounts.INFO

  const openPanel = (panel: OperationsPanel) => {
    setActivePanel(panel)
    setIsSidePanelOpen(true)
  }

  return (
    <div className="timetable-operations-workspace">
      <section className="timetable-workspace-toolbar" aria-label="タイムテーブル表示設定">
        <div className="timetable-workspace-toolbar__scope">
          <div className="timetable-scope__group">
            <p>開催日</p>
            <div className="timetable-scope__choices">
              {eventDays.map((eventDay) => {
                const isSelected = eventDay.id === selectedEventDayId
                return (
                  <button
                    key={eventDay.id}
                    type="button"
                    className={isSelected
                      ? 'timetable-scope__button timetable-scope__button--active'
                      : 'timetable-scope__button'}
                    aria-pressed={isSelected}
                    onClick={() => onSelectEventDay(eventDay.id)}
                  >
                    {formatEventDayLabel(eventDay)}
                  </button>
                )
              })}
            </div>
          </div>

          {selectedEventDayId && (
            <div className="timetable-scope__group">
              <p>Stage</p>
              <div className="timetable-scope__choices">
                {stages.map((stage) => {
                  const isSelected = stage.id === selectedStageId
                  return (
                    <button
                      key={stage.id}
                      type="button"
                      className={isSelected
                        ? 'timetable-scope__button timetable-scope__button--active'
                        : 'timetable-scope__button'}
                      aria-pressed={isSelected}
                      onClick={() => onSelectStage(stage.id)}
                    >
                      {stage.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="timetable-workspace-toolbar__settings">{settings}</div>
        </div>

        <div className="timetable-workspace-toolbar__action-stack">
          <div className="timetable-workspace-toolbar__actions">
            <div className="timetable-history-controls" aria-label="タイムテーブル編集履歴">
              <button type="button" disabled={!canUndo} onClick={onUndo}>
                <span aria-hidden="true">↶</span> 元に戻す
              </button>
              <button type="button" disabled={!canRedo} onClick={onRedo}>
                <span aria-hidden="true">↷</span> やり直す
              </button>
            </div>
            {generationAction}
            <button
              type="button"
              className="workspace-toggle-button"
              aria-expanded={isPoolOpen}
              aria-label={isPoolOpen
                ? `未配置バンド${poolCount}件を閉じる`
                : `未配置バンド${poolCount}件を開く`}
              onClick={() => setIsPoolOpen((isOpen) => !isOpen)}
            >
              未配置 {poolCount}件
            </button>
            <span className="workspace-issue-count workspace-issue-count--error">
              ERROR {issueCounts.ERROR}
            </span>
            <span className="workspace-issue-count workspace-issue-count--warning">
              WARNING {issueCounts.WARNING}
            </span>
            <div className="operations-panel-selector" aria-label="表示するサイドパネル">
              {(Object.keys(panelLabels) as OperationsPanel[]).map((panel) => (
                <button
                  key={panel}
                  type="button"
                  aria-pressed={isSidePanelOpen && activePanel === panel}
                  className={isSidePanelOpen && activePanel === panel
                    ? 'operations-panel-selector__button operations-panel-selector__button--active'
                    : 'operations-panel-selector__button'}
                  onClick={() => openPanel(panel)}
                >
                  {panelLabels[panel]}
                  {panel === 'issues' ? ` ${issueCount}` : ''}
                </button>
              ))}
            </div>
          </div>
          <div className="timetable-history-feedback-slot">
            {historyFeedback && (
              <p
                className={`timetable-history-feedback timetable-history-feedback--${historyFeedback.kind}`}
                role={historyFeedback.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
              >
                {historyFeedback.message}
              </p>
            )}
          </div>
        </div>
      </section>

      {unavailableContent ?? (
        <>
          <div className={[
            'timetable-operations-grid',
            isPoolOpen ? '' : 'timetable-operations-grid--pool-closed',
            isSidePanelOpen ? '' : 'timetable-operations-grid--side-closed',
          ].filter(Boolean).join(' ')}>
            <section
              className="timetable-operations-pane timetable-operations-pane--pool"
              hidden={!isPoolOpen}
            >
              {pool}
            </section>
            <section className="timetable-operations-pane timetable-operations-pane--timeline">
              {timetable}
            </section>
            <aside
              className="timetable-operations-pane timetable-operations-pane--side"
              aria-label="タイムテーブル関連設定"
              hidden={!isSidePanelOpen}
            >
              <header className="operations-panel-heading">
                <strong>{panelLabels[activePanel]}</strong>
                <button
                  type="button"
                  aria-label="サイドパネルを閉じる"
                  onClick={() => setIsSidePanelOpen(false)}
                >
                  閉じる
                </button>
              </header>

              <div className="operations-panel-content" hidden={activePanel !== 'issues'}>
                {issuePanel}
              </div>
              <div className="operations-panel-content" hidden={activePanel !== 'order'}>
                {orderPanel}
              </div>
              <div className="operations-panel-content" hidden={activePanel !== 'pa'}>
                {renderPaPanel(() => openPanel('pa'))}
              </div>
              <div className="operations-panel-content" hidden={activePanel !== 'operations'}>
                {renderOperationsPanel(() => openPanel('operations'))}
              </div>
            </aside>
          </div>
          <footer className="timetable-operations-footer">{footer}</footer>
        </>
      )}
    </div>
  )
}
