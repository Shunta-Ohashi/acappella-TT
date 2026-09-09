import type { ReactNode } from 'react'

export type EventEditorStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

interface EventEditorStep {
  id: EventEditorStepId
  label: string
  description: string
}

const eventEditorSteps: EventEditorStep[] = [
  { id: 1, label: '基本情報', description: 'イベントの基本情報を設定します。' },
  { id: 2, label: '会場・Stage', description: '開催日ごとのStageや時間構成を設定します。' },
  { id: 3, label: 'メンバー', description: '今回のイベントに参加するメンバーを設定します。' },
  { id: 4, label: '出演バンド', description: '今回出演するバンドを設定します。' },
  { id: 5, label: '出演条件', description: 'バンドごとの出演条件や希望を設定します。' },
  { id: 6, label: 'PA設定', description: 'タイムテーブル作成で使用するPA体制を設定します。' },
  { id: 7, label: 'タイムテーブル', description: '出演順と時間を調整し、問題を確認します。' },
  { id: 8, label: '当日運営', description: '受付・撮影・TKなど当日の担当を設定します。' },
  { id: 9, label: '最終チェック', description: '出演・PA・当日運営などの問題をまとめて確認します。' },
  { id: 10, label: '公開・出力', description: 'タイムテーブルの公開やデータ出力を設定します。' },
]

interface EventEditorShellProps {
  eventName: string
  activeStep: EventEditorStepId
  onStepChange: (step: EventEditorStepId) => void
  onBackToEvents: () => void
  children: ReactNode
}

export function EventEditorShell({
  eventName,
  activeStep,
  onStepChange,
  onBackToEvents,
  children,
}: EventEditorShellProps) {
  const currentStep = eventEditorSteps.find((step) => step.id === activeStep)

  if (!currentStep) {
    throw new Error(`Event editor step not found: ${activeStep}`)
  }

  return (
    <main className="event-editor">
      <header className="event-editor__header">
        <div className="event-editor__header-inner">
          <button
            type="button"
            className="event-editor__back"
            onClick={onBackToEvents}
          >
            <span aria-hidden="true">←</span> イベント一覧
          </button>
          <div className="event-editor__title-row">
            <div>
              <p className="event-editor__eyebrow">イベント編集</p>
              <h1>{eventName}</h1>
            </div>
            <span className="event-editor__status" aria-label="編集状態: 下書き">
              下書き
            </span>
          </div>
        </div>
      </header>

      <div className="event-editor__layout">
        <aside className="step-sidebar">
          <p className="step-sidebar__title">作成ステップ</p>
          <nav aria-label="イベント作成ステップ">
            <ol className="step-sidebar__list">
              {eventEditorSteps.map((step) => (
                <li key={step.id}>
                  <button
                    type="button"
                    className={step.id === activeStep
                      ? 'step-sidebar__button step-sidebar__button--active'
                      : 'step-sidebar__button'}
                    aria-current={step.id === activeStep ? 'step' : undefined}
                    onClick={() => onStepChange(step.id)}
                  >
                    <span className="step-sidebar__number">{step.id}</span>
                    <span>{step.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <section className="event-editor__content" aria-labelledby="current-step-title">
          <header className="event-editor__step-header">
            <p>STEP {currentStep.id}</p>
            <h2 id="current-step-title">{currentStep.label}</h2>
            <span>{currentStep.description}</span>
          </header>

          {activeStep === 1 || activeStep === 2 || activeStep === 7 ? (
            children
          ) : (
            <div className="step-placeholder">
              <p>{currentStep.description}</p>
              <span>この画面は後続PRで実装します。</span>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
