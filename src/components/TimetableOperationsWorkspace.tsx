import { useState, type ReactNode } from 'react'
import type { EventDay, EventDayId, Stage, StageId } from '../domain/models'

type OperationsPanel = 'issues' | 'pa' | 'operations'

interface TimetableOperationsWorkspaceProps {
  eventDays: EventDay[]
  stages: Stage[]
  selectedEventDayId?: EventDayId
  selectedStageId?: StageId
  onSelectEventDay: (eventDayId: EventDayId) => void
  onSelectStage: (stageId: StageId) => void
  unavailableContent?: ReactNode
  pool: ReactNode
  timetable: ReactNode
  issuePanel: ReactNode
  paPanel: ReactNode
  footer: ReactNode
}

const panelLabels: Record<OperationsPanel, string> = {
  issues: '問題',
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
  unavailableContent,
  pool,
  timetable,
  issuePanel,
  paPanel,
  footer,
}: TimetableOperationsWorkspaceProps) {
  const [activePanel, setActivePanel] = useState<OperationsPanel>('issues')

  return (
    <div className="timetable-operations-workspace">
      <section className="timetable-scope" aria-label="表示するタイムテーブル">
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
                  {isSelected && <small>選択中</small>}
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
                    {isSelected && <small>選択中</small>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {unavailableContent ?? (
        <>
          <div className="timetable-operations-grid">
            <section className="timetable-operations-pane timetable-operations-pane--pool">
              {pool}
            </section>
            <section className="timetable-operations-pane timetable-operations-pane--timeline">
              {timetable}
            </section>
            <aside
              className="timetable-operations-pane timetable-operations-pane--side"
              aria-label="タイムテーブル関連設定"
            >
              <div className="operations-panel-selector" aria-label="表示するサイドパネル">
                {(Object.keys(panelLabels) as OperationsPanel[]).map((panel) => (
                  <button
                    key={panel}
                    type="button"
                    aria-pressed={activePanel === panel}
                    className={activePanel === panel
                      ? 'operations-panel-selector__button operations-panel-selector__button--active'
                      : 'operations-panel-selector__button'}
                    onClick={() => setActivePanel(panel)}
                  >
                    {panelLabels[panel]}
                  </button>
                ))}
              </div>

              <div className="operations-panel-content" hidden={activePanel !== 'issues'}>
                {issuePanel}
              </div>
              <div className="operations-panel-content" hidden={activePanel !== 'pa'}>
                {paPanel}
              </div>
              <div className="operations-panel-content" hidden={activePanel !== 'operations'}>
                <section className="operations-placeholder">
                  <h3>当日運営</h3>
                  <p>
                    受付・撮影・TKなどの担当割り当ては、今後この画面から設定できるようにする予定です。
                  </p>
                </section>
              </div>
            </aside>
          </div>
          <footer className="timetable-operations-footer">{footer}</footer>
        </>
      )}
    </div>
  )
}
