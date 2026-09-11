import { useState, type FormEvent } from 'react'
import type {
  Event,
  EventDay,
  EventDayId,
  Section,
  SectionId,
  Stage,
  StageId,
} from '../domain/models'
import {
  createEventStageSettingsDraft,
  addPerformanceSlotMinute,
  FIRST_SECTION_ADD_BLOCKED_MESSAGE,
  getEventStageSettingsErrorEventDayIds,
  hasEventStageSettingsErrors,
  SECTION_DELETE_BLOCKED_MESSAGE,
  STAGE_DELETE_BLOCKED_MESSAGE,
  validateEventStageSettingsDraft,
  type EventStageSettingsUpdateResult,
  type SectionSettingsDraft,
  type StageSettingsDraft,
  type EventStageSettingsValidationErrors,
} from '../domain/eventStageSettings'
import { StageSectionSettings } from './StageSectionSettings'

interface EventStageSettingsProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  canAddFirstSection: (stageId: StageId) => boolean
  canDeleteStage: (stageId: StageId) => boolean
  canDeleteSection: (sectionId: SectionId) => boolean
  onSave: (
    defaultTransitionMinutes: string,
    performanceSlotMinutes: number[],
    stages: StageSettingsDraft[],
    sections: SectionSettingsDraft[],
  ) => EventStageSettingsUpdateResult
  onSaveAndNext: () => void
}

const formatEventDay = (date: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
}

export function EventStageSettings({
  event,
  eventDays,
  stages,
  sections,
  canAddFirstSection,
  canDeleteStage,
  canDeleteSection,
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
  const initialDraft = createEventStageSettingsDraft(
    event,
    eventDays,
    stages,
    sections,
  )
  const [selectedEventDayIdState, setSelectedEventDayId] =
    useState<EventDayId | undefined>(orderedEventDays[0]?.id)
  const [defaultTransitionMinutes, setDefaultTransitionMinutes] = useState(
    initialDraft.defaultTransitionMinutes,
  )
  const [performanceSlotMinutes, setPerformanceSlotMinutes] = useState(
    initialDraft.performanceSlotMinutes,
  )
  const [isAddingPerformanceSlot, setIsAddingPerformanceSlot] = useState(false)
  const [newPerformanceSlotMinute, setNewPerformanceSlotMinute] = useState('')
  const [performanceSlotInputError, setPerformanceSlotInputError] = useState('')
  const [stageDrafts, setStageDrafts] = useState(initialDraft.stages)
  const [sectionDrafts, setSectionDrafts] = useState(initialDraft.sections)
  const [nextStageDraftKey, setNextStageDraftKey] = useState(0)
  const [nextSectionDraftKey, setNextSectionDraftKey] = useState(0)
  const [errors, setErrors] = useState<EventStageSettingsValidationErrors>({
    stages: {},
    sections: {},
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
  const errorEventDayIds = new Set(
    getEventStageSettingsErrorEventDayIds(
      {
        defaultTransitionMinutes,
        performanceSlotMinutes,
        stages: stageDrafts,
        sections: sectionDrafts,
      },
      errors,
    ),
  )

  const clearFeedback = () => {
    setSaveMessage('')
    setErrors((previous) => ({ ...previous, form: undefined }))
  }

  const handleAddPerformanceSlot = () => {
    const result = addPerformanceSlotMinute(
      performanceSlotMinutes,
      newPerformanceSlotMinute,
    )
    if (!result.ok) {
      setPerformanceSlotInputError(result.error)
      return
    }

    setPerformanceSlotMinutes(result.performanceSlotMinutes)
    setNewPerformanceSlotMinute('')
    setPerformanceSlotInputError('')
    setIsAddingPerformanceSlot(false)
    setErrors((previous) => ({
      ...previous,
      performanceSlotMinutes: undefined,
      form: undefined,
    }))
    setSaveMessage('')
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
      const nextSectionErrors = { ...previous.sections }
      delete nextStageErrors[draftId]
      for (const section of sectionDrafts) {
        if (section.stageDraftId === draftId) {
          delete nextSectionErrors[section.draftId]
        }
      }
      return {
        ...previous,
        stages: nextStageErrors,
        sections: nextSectionErrors,
        form: undefined,
      }
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
    const hasSectionDrafts = sectionDrafts.some(
      (section) => section.stageDraftId === stage.draftId,
    )
    if (
      hasSectionDrafts ||
      (stage.stageId && !canDeleteStage(stage.stageId))
    ) {
      setErrors((previous) => ({
        ...previous,
        stages: {
          ...previous.stages,
          [stage.draftId]: {
            ...previous.stages[stage.draftId],
            form: STAGE_DELETE_BLOCKED_MESSAGE,
          },
        },
      }))
      setSaveMessage('')
      return
    }

    setStageDrafts((previous) => previous.filter(
      (candidate) => candidate.draftId !== stage.draftId,
    ))
    setErrors((previous) => {
      const nextStageErrors = { ...previous.stages }
      delete nextStageErrors[stage.draftId]
      return { ...previous, stages: nextStageErrors, form: undefined }
    })
    setSaveMessage('')
  }

  const handleAddSection = (stage: StageSettingsDraft) => {
    const stageSections = sectionDrafts.filter(
      (section) => section.stageDraftId === stage.draftId,
    )
    if (
      stageSections.length === 0 &&
      stage.stageId &&
      !canAddFirstSection(stage.stageId)
    ) {
      setErrors((previous) => ({
        ...previous,
        stages: {
          ...previous.stages,
          [stage.draftId]: {
            ...previous.stages[stage.draftId],
            form: FIRST_SECTION_ADD_BLOCKED_MESSAGE,
          },
        },
      }))
      setSaveMessage('')
      return
    }

    setSectionDrafts((previous) => [
      ...previous,
      {
        draftId: `new-section-${nextSectionDraftKey}`,
        stageDraftId: stage.draftId,
        name: '',
        startMode: 'automatic',
        plannedStartTime: '',
        endMode: 'automatic',
        plannedEndTime: '',
      },
    ])
    setNextSectionDraftKey((previous) => previous + 1)
    setErrors((previous) => {
      const nextStageErrors = { ...previous.stages }
      delete nextStageErrors[stage.draftId]
      return { ...previous, stages: nextStageErrors, form: undefined }
    })
    setSaveMessage('')
  }

  const updateSection = (
    draftId: string,
    update: (section: SectionSettingsDraft) => SectionSettingsDraft,
  ) => {
    setSectionDrafts((previous) => previous.map((section) =>
      section.draftId === draftId ? update(section) : section,
    ))
    setErrors((previous) => {
      const nextSectionErrors = { ...previous.sections }
      delete nextSectionErrors[draftId]
      return { ...previous, sections: nextSectionErrors, form: undefined }
    })
    setSaveMessage('')
  }

  const handleRemoveSection = (section: SectionSettingsDraft) => {
    if (section.sectionId && !canDeleteSection(section.sectionId)) {
      setErrors((previous) => ({
        ...previous,
        sections: {
          ...previous.sections,
          [section.draftId]: {
            ...previous.sections[section.draftId],
            form: SECTION_DELETE_BLOCKED_MESSAGE,
          },
        },
      }))
      setSaveMessage('')
      return
    }

    setSectionDrafts((previous) => previous.filter(
      (candidate) => candidate.draftId !== section.draftId,
    ))
    setErrors((previous) => {
      const nextSectionErrors = { ...previous.sections }
      delete nextSectionErrors[section.draftId]
      return { ...previous, sections: nextSectionErrors, form: undefined }
    })
    setSaveMessage('')
  }

  const save = (moveToNext: boolean) => {
    const draft = {
      defaultTransitionMinutes,
      performanceSlotMinutes,
      stages: stageDrafts,
      sections: sectionDrafts,
    }
    const validationErrors = validateEventStageSettingsDraft(draft)
    setErrors(validationErrors)
    setSaveMessage('')

    if (hasEventStageSettingsErrors(validationErrors)) {
      const [firstErrorEventDayId] = getEventStageSettingsErrorEventDayIds(
        draft,
        validationErrors,
      )
      if (firstErrorEventDayId) {
        setSelectedEventDayId(firstErrorEventDayId)
      }
      return
    }

    const result = onSave(
      defaultTransitionMinutes,
      performanceSlotMinutes,
      stageDrafts,
      sectionDrafts,
    )
    if (!result.ok) {
      setErrors(result.errors)
      const [firstErrorEventDayId] = getEventStageSettingsErrorEventDayIds(
        draft,
        result.errors,
      )
      if (firstErrorEventDayId) {
        setSelectedEventDayId(firstErrorEventDayId)
      }
      return
    }

    const savedDraft = createEventStageSettingsDraft(
      result.event,
      eventDays,
      result.stages,
      result.sections,
    )
    setDefaultTransitionMinutes(savedDraft.defaultTransitionMinutes)
    setPerformanceSlotMinutes(savedDraft.performanceSlotMinutes)
    setStageDrafts(savedDraft.stages)
    setSectionDrafts(savedDraft.sections)

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
                const hasErrors = errorEventDayIds.has(eventDay.id)

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
                    {hasErrors && (
                      <small className="event-day-tabs__error">
                        エラーあり
                      </small>
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

          <div className="event-stage-settings__common-slots">
            <p>このイベントで使用する出演枠</p>
            <div className="event-stage-settings__slot-list" aria-label="設定済みの出演枠">
              {performanceSlotMinutes.map((minutes) => (
                <span key={minutes}>{minutes}分枠</span>
              ))}
            </div>
            <button
              type="button"
              className="event-stage-settings__add-slot"
              onClick={() => {
                setIsAddingPerformanceSlot(true)
                setPerformanceSlotInputError('')
              }}
            >
              <span aria-hidden="true">＋</span> 出演枠を追加
            </button>
            {isAddingPerformanceSlot && (
              <div className="event-stage-settings__custom-slot">
                <label htmlFor="event-stage-new-slot">追加する出演枠（分）</label>
                <div>
                  <input
                    id="event-stage-new-slot"
                    type="number"
                    min="1"
                    step="1"
                    value={newPerformanceSlotMinute}
                    aria-invalid={performanceSlotInputError ? 'true' : undefined}
                    aria-describedby={performanceSlotInputError
                      ? 'event-stage-new-slot-error'
                      : undefined}
                    onChange={(changeEvent) => {
                      setNewPerformanceSlotMinute(changeEvent.target.value)
                      setPerformanceSlotInputError('')
                    }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setIsAddingPerformanceSlot(false)
                      setNewPerformanceSlotMinute('')
                      setPerformanceSlotInputError('')
                    }}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label="出演枠を追加"
                    onClick={handleAddPerformanceSlot}
                  >
                    追加
                  </button>
                </div>
                {performanceSlotInputError && (
                  <p
                    id="event-stage-new-slot-error"
                    className="form-error"
                    role="alert"
                  >
                    {performanceSlotInputError}
                  </p>
                )}
              </div>
            )}
            {errors.performanceSlotMinutes && (
              <p className="form-error" role="alert">
                {errors.performanceSlotMinutes}
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
                const stageSectionDrafts = sectionDrafts.filter(
                  (section) => section.stageDraftId === stage.draftId,
                )
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

                    <StageSectionSettings
                      stageName={stage.name}
                      sections={stageSectionDrafts}
                      errors={errors.sections}
                      onAdd={() => handleAddSection(stage)}
                      onUpdate={updateSection}
                      onRemove={handleRemoveSection}
                    />

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
