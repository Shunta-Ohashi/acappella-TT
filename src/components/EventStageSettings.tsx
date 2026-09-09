import { useState, type FormEvent } from 'react'
import type { Event, EventDay, EventDayId, Stage, StageId } from '../domain/models'
import {
  createEventStageSettingsDraft,
  hasEventStageSettingsErrors,
  validateEventStageSettingsDraft,
  type EventStageSettingsUpdateResult,
  type StageSettingsDraft,
  type EventStageSettingsValidationErrors,
} from '../domain/eventStageSettings'

interface EventStageSettingsProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  canDeleteStage: (stageId: StageId) => boolean
  onSave: (
    defaultTransitionMinutes: string,
    stages: StageSettingsDraft[],
  ) => EventStageSettingsUpdateResult
  onSaveAndNext: () => void
}

const DELETE_BLOCKED_MESSAGE =
  'このStageにはタイムテーブルまたはSectionが設定されているため削除できません。関連する設定を先に削除してください。'

const formatEventDay = (date: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
}

export function EventStageSettings({
  event,
  eventDays,
  stages,
  canDeleteStage,
  onSave,
  onSaveAndNext,
}: EventStageSettingsProps) {
  const orderedEventDays = eventDays
    .filter((eventDay) => eventDay.eventId === event.id)
    .sort((first, second) =>
      first.order - second.order ||
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
    )
  const initialDraft = createEventStageSettingsDraft(event, eventDays, stages)
  const [selectedEventDayIdState, setSelectedEventDayId] =
    useState<EventDayId | undefined>(orderedEventDays[0]?.id)
  const [defaultTransitionMinutes, setDefaultTransitionMinutes] = useState(
    initialDraft.defaultTransitionMinutes,
  )
  const [stageDrafts, setStageDrafts] = useState(initialDraft.stages)
  const [nextStageDraftKey, setNextStageDraftKey] = useState(0)
  const [errors, setErrors] = useState<EventStageSettingsValidationErrors>({
    stages: {},
  })
  const [saveMessage, setSaveMessage] = useState('')

  const selectedEventDayId = orderedEventDays.some(
    (eventDay) => eventDay.id === selectedEventDayIdState,
  )
    ? selectedEventDayIdState
    : orderedEventDays[0]?.id
  const selectedEventDay = orderedEventDays.find(
    (eventDay) => eventDay.id === selectedEventDayId,
  )
  const selectedStageDrafts = stageDrafts.filter(
    (stage) => stage.eventDayId === selectedEventDayId,
  )

  const clearFeedback = () => {
    setSaveMessage('')
    setErrors((previous) => ({ ...previous, form: undefined }))
  }

  const updateStage = (
    draftId: string,
    update: (stage: StageSettingsDraft) => StageSettingsDraft,
  ) => {
    setStageDrafts((previous) => previous.map((stage) =>
      stage.draftId === draftId ? update(stage) : stage,
    ))
    setErrors((previous) => {
      const nextStageErrors = { ...previous.stages }
      delete nextStageErrors[draftId]
      return { ...previous, stages: nextStageErrors, form: undefined }
    })
    setSaveMessage('')
  }

  const handleAddStage = () => {
    if (!selectedEventDayId) return

    setStageDrafts((previous) => [
      ...previous,
      {
        draftId: `new-stage-${nextStageDraftKey}`,
        eventDayId: selectedEventDayId,
        name: '',
        location: '',
        plannedStartTime: '',
        endMode: 'automatic',
        plannedEndTime: '',
        transitionMode: 'event-default',
        transitionMinutes: '',
      },
    ])
    setNextStageDraftKey((previous) => previous + 1)
    clearFeedback()
  }

  const handleRemoveStage = (stage: StageSettingsDraft) => {
    if (stage.stageId && !canDeleteStage(stage.stageId)) {
      setErrors((previous) => ({
        ...previous,
        stages: {
          ...previous.stages,
          [stage.draftId]: {
            ...previous.stages[stage.draftId],
            form: DELETE_BLOCKED_MESSAGE,
          },
        },
      }))
      setSaveMessage('')
      return
    }

    setStageDrafts((previous) => previous.filter(
      (candidate) => candidate.draftId !== stage.draftId,
    ))
    clearFeedback()
  }

  const save = (moveToNext: boolean) => {
    const draft = { defaultTransitionMinutes, stages: stageDrafts }
    const validationErrors = validateEventStageSettingsDraft(draft)
    setErrors(validationErrors)
    setSaveMessage('')

    if (hasEventStageSettingsErrors(validationErrors)) return

    const result = onSave(defaultTransitionMinutes, stageDrafts)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    const savedDraft = createEventStageSettingsDraft(
      result.event,
      eventDays,
      result.stages,
    )
    setDefaultTransitionMinutes(savedDraft.defaultTransitionMinutes)
    setStageDrafts(savedDraft.stages)

    if (moveToNext) {
      onSaveAndNext()
    } else {
      setSaveMessage('✓ 保存しました')
    }
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    save(false)
  }

  return (
    <section className="event-stage-settings" aria-label="会場とStageの設定フォーム">
      <form noValidate onSubmit={handleSubmit}>
        <div className="event-stage-settings__overview">
          <div className="event-stage-settings__days">
            <p>開催日</p>
            <div className="event-day-tabs">
              {orderedEventDays.map((eventDay) => {
                const isSelected = eventDay.id === selectedEventDayId

                return (
                  <button
                    key={eventDay.id}
                    type="button"
                    className={isSelected
                      ? 'event-day-tabs__button event-day-tabs__button--active'
                      : 'event-day-tabs__button'}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedEventDayId(eventDay.id)}
                  >
                    <span>{formatEventDay(eventDay.date)}</span>
                    {isSelected && (
                      <small>選択中</small>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="event-stage-settings__common-transition">
            <label htmlFor="event-default-transition-minutes">
              イベント共通の転換時間
            </label>
            <div>
              <input
                id="event-default-transition-minutes"
                type="number"
                min="0"
                step="1"
                required
                value={defaultTransitionMinutes}
                aria-invalid={errors.defaultTransitionMinutes
                  ? 'true'
                  : undefined}
                aria-describedby={errors.defaultTransitionMinutes
                  ? 'event-default-transition-error'
                  : undefined}
                onChange={(changeEvent) => {
                  setDefaultTransitionMinutes(changeEvent.target.value)
                  setErrors((previous) => ({
                    ...previous,
                    defaultTransitionMinutes: undefined,
                    form: undefined,
                  }))
                  setSaveMessage('')
                }}
              />
              <span>分</span>
            </div>
            {errors.defaultTransitionMinutes && (
              <p
                id="event-default-transition-error"
                className="form-error"
                role="alert"
              >
                {errors.defaultTransitionMinutes}
              </p>
            )}
          </div>
        </div>

        <div className="event-stage-settings__day-panel">
          <header className="event-stage-settings__day-header">
            <div>
              <p>Stage設定</p>
              <h3>
                {selectedEventDay
                  ? `${formatEventDay(selectedEventDay.date)}のStage`
                  : '開催日が設定されていません'}
              </h3>
            </div>
            {selectedEventDayId && (
              <button
                type="button"
                className="secondary-button"
                onClick={handleAddStage}
              >
                <span aria-hidden="true">＋</span> Stageを追加
              </button>
            )}
          </header>

          {selectedStageDrafts.length === 0 ? (
            <div className="event-stage-settings__empty">
              <p>この開催日にはまだStageがありません。</p>
              {selectedEventDayId && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleAddStage}
                >
                  <span aria-hidden="true">＋</span> Stageを追加
                </button>
              )}
            </div>
          ) : (
            <div className="stage-settings-list">
              {selectedStageDrafts.map((stage, index) => {
                const stageErrors = errors.stages[stage.draftId] ?? {}
                const idPrefix = `stage-settings-${stage.draftId}`

                return (
                  <article key={stage.draftId} className="stage-settings-card">
                    <header className="stage-settings-card__header">
                      <div>
                        <p>Stage {index + 1}</p>
                        <h4>{stage.name.trim() || '新しいStage'}</h4>
                      </div>
                      <button
                        type="button"
                        className="stage-settings-card__delete"
                        aria-label={`${stage.name.trim() || '新しいStage'}を削除`}
                        onClick={() => handleRemoveStage(stage)}
                      >
                        削除
                      </button>
                    </header>

                    <div className="stage-settings-card__fields">
                      <div className="stage-settings-field">
                        <label htmlFor={`${idPrefix}-name`}>
                          Stage名 <span aria-hidden="true">*</span>
                        </label>
                        <input
                          id={`${idPrefix}-name`}
                          type="text"
                          required
                          placeholder="Main Stage"
                          value={stage.name}
                          aria-invalid={stageErrors.name ? 'true' : undefined}
                          aria-describedby={stageErrors.name
                            ? `${idPrefix}-name-error`
                            : undefined}
                          onChange={(changeEvent) => updateStage(
                            stage.draftId,
                            (current) => ({
                              ...current,
                              name: changeEvent.target.value,
                            }),
                          )}
                        />
                        {stageErrors.name && (
                          <p
                            id={`${idPrefix}-name-error`}
                            className="form-error"
                            role="alert"
                          >
                            {stageErrors.name}
                          </p>
                        )}
                      </div>

                      <div className="stage-settings-field">
                        <label htmlFor={`${idPrefix}-location`}>場所</label>
                        <input
                          id={`${idPrefix}-location`}
                          type="text"
                          placeholder="大学祭ステージ"
                          value={stage.location}
                          onChange={(changeEvent) => updateStage(
                            stage.draftId,
                            (current) => ({
                              ...current,
                              location: changeEvent.target.value,
                            }),
                          )}
                        />
                      </div>

                      <div className="stage-settings-field stage-settings-field--time">
                        <label htmlFor={`${idPrefix}-start-time`}>
                          開始時刻 <span aria-hidden="true">*</span>
                        </label>
                        <input
                          id={`${idPrefix}-start-time`}
                          type="time"
                          required
                          value={stage.plannedStartTime}
                          aria-invalid={stageErrors.plannedStartTime
                            ? 'true'
                            : undefined}
                          aria-describedby={stageErrors.plannedStartTime
                            ? `${idPrefix}-start-time-error`
                            : undefined}
                          onChange={(changeEvent) => updateStage(
                            stage.draftId,
                            (current) => ({
                              ...current,
                              plannedStartTime: changeEvent.target.value,
                            }),
                          )}
                        />
                        {stageErrors.plannedStartTime && (
                          <p
                            id={`${idPrefix}-start-time-error`}
                            className="form-error"
                            role="alert"
                          >
                            {stageErrors.plannedStartTime}
                          </p>
                        )}
                      </div>
                    </div>

                    <fieldset className="stage-settings-choice">
                      <legend>終了時刻</legend>
                      <label>
                        <input
                          type="radio"
                          name={`${idPrefix}-end-mode`}
                          checked={stage.endMode === 'automatic'}
                          onChange={() => updateStage(
                            stage.draftId,
                            (current) => ({ ...current, endMode: 'automatic' }),
                          )}
                        />
                        自動
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`${idPrefix}-end-mode`}
                          checked={stage.endMode === 'fixed'}
                          onChange={() => updateStage(
                            stage.draftId,
                            (current) => ({ ...current, endMode: 'fixed' }),
                          )}
                        />
                        固定
                      </label>
                      {stage.endMode === 'fixed' && (
                        <div className="stage-settings-choice__value">
                          <label className="visually-hidden" htmlFor={`${idPrefix}-end-time`}>
                            固定終了時刻
                          </label>
                          <input
                            id={`${idPrefix}-end-time`}
                            type="time"
                            required
                            value={stage.plannedEndTime}
                            aria-invalid={stageErrors.plannedEndTime
                              ? 'true'
                              : undefined}
                            aria-describedby={stageErrors.plannedEndTime
                              ? `${idPrefix}-end-time-error`
                              : undefined}
                            onChange={(changeEvent) => updateStage(
                              stage.draftId,
                              (current) => ({
                                ...current,
                                plannedEndTime: changeEvent.target.value,
                              }),
                            )}
                          />
                          {stageErrors.plannedEndTime && (
                            <p
                              id={`${idPrefix}-end-time-error`}
                              className="form-error"
                              role="alert"
                            >
                              {stageErrors.plannedEndTime}
                            </p>
                          )}
                        </div>
                      )}
                    </fieldset>

                    <fieldset className="stage-settings-choice">
                      <legend>転換時間</legend>
                      <label>
                        <input
                          type="radio"
                          name={`${idPrefix}-transition-mode`}
                          checked={stage.transitionMode === 'event-default'}
                          onChange={() => updateStage(
                            stage.draftId,
                            (current) => ({
                              ...current,
                              transitionMode: 'event-default',
                            }),
                          )}
                        />
                        イベント共通（{defaultTransitionMinutes
                          ? `${defaultTransitionMinutes}分`
                          : '未設定'}）
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`${idPrefix}-transition-mode`}
                          checked={stage.transitionMode === 'stage-specific'}
                          onChange={() => updateStage(
                            stage.draftId,
                            (current) => ({
                              ...current,
                              transitionMode: 'stage-specific',
                            }),
                          )}
                        />
                        このStageのみ
                      </label>
                      {stage.transitionMode === 'stage-specific' && (
                        <div className="stage-settings-choice__value stage-settings-choice__value--minutes">
                          <label className="visually-hidden" htmlFor={`${idPrefix}-transition-minutes`}>
                            Stage固有の転換時間
                          </label>
                          <input
                            id={`${idPrefix}-transition-minutes`}
                            type="number"
                            min="0"
                            step="1"
                            required
                            value={stage.transitionMinutes}
                            aria-invalid={stageErrors.transitionMinutes
                              ? 'true'
                              : undefined}
                            aria-describedby={stageErrors.transitionMinutes
                              ? `${idPrefix}-transition-error`
                              : undefined}
                            onChange={(changeEvent) => updateStage(
                              stage.draftId,
                              (current) => ({
                                ...current,
                                transitionMinutes: changeEvent.target.value,
                              }),
                            )}
                          />
                          <span>分</span>
                          {stageErrors.transitionMinutes && (
                            <p
                              id={`${idPrefix}-transition-error`}
                              className="form-error"
                              role="alert"
                            >
                              {stageErrors.transitionMinutes}
                            </p>
                          )}
                        </div>
                      )}
                    </fieldset>

                    {stageErrors.form && (
                      <p className="form-error stage-settings-card__error" role="alert">
                        {stageErrors.form}
                      </p>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>

        {errors.form && (
          <p className="form-error event-stage-settings__form-error" role="alert">
            {errors.form}
          </p>
        )}

        <footer className="event-stage-settings__actions">
          <span className="event-stage-settings__save-status" role="status">
            {saveMessage}
          </span>
          <div>
            <button type="submit" className="secondary-button">
              保存
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => save(true)}
            >
              保存して次へ <span aria-hidden="true">→</span>
            </button>
          </div>
        </footer>
      </form>
    </section>
  )
}
