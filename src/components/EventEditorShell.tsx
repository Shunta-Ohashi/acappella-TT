import type { ReactNode } from 'react'
import {
  eventEditorSteps,
  type EventEditorStepId,
} from '../ui/eventEditorSteps'

export type { EventEditorStepId } from '../ui/eventEditorSteps'

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
  const hasImplementedContent = [1, 2, 3, 4, 5, 6].includes(activeStep)

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

          {hasImplementedContent ? (
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
