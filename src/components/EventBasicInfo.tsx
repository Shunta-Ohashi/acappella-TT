import { useState, type FormEvent } from 'react'
import type { Event, EventDay, EventDayId, LocalDate } from '../domain/models'
import {
  createEventBasicInfoDraft,
  validateEventBasicInfoDraft,
  type EventBasicInfoDraft,
  type EventBasicInfoUpdateResult,
  type EventBasicInfoValidationErrors,
} from '../domain/eventBasicInfo'
import { getDeleteConfirmationCopy } from '../ui/deleteConfirmation'
import type {
  EventDeletionCheck,
  EventDeletionResult,
} from '../domain/eventDeletion'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'

interface EventBasicInfoProps {
  event: Event
  eventDays: EventDay[]
  canDeleteEventDay: (eventDayId: EventDayId) => boolean
  checkEventDeletion: (eventId: Event['id']) => EventDeletionCheck
  onDeleteEvent: (eventId: Event['id']) => Promise<EventDeletionActionResult>
  onSave: (draft: EventBasicInfoDraft) => EventBasicInfoUpdateResult
  onSaveAndNext: () => void
}

export type EventDeletionActionResult = EventDeletionResult | {
  ok: false
  reason: 'CLOUD_DELETE_FAILED'
}

interface DateInput {
  key: string
  eventDayId?: EventDayId
  value: LocalDate
}

const DELETE_BLOCKED_MESSAGE =
  'この開催日にはStage・出演バンドなどの設定があるため削除できません。関連する設定を先に削除してください。'

const createDateInputs = (eventDays: EventDay[]): DateInput[] => eventDays.map(
  (eventDay) => ({
    key: `event-day-${eventDay.id}`,
    eventDayId: eventDay.id,
    value: eventDay.date,
  }),
)

export function EventBasicInfo({
  event,
  eventDays,
  canDeleteEventDay,
  checkEventDeletion,
  onDeleteEvent,
  onSave,
  onSaveAndNext,
}: EventBasicInfoProps) {
  const initialDraft = createEventBasicInfoDraft(event, eventDays)
  const initialEventDays = eventDays
    .filter((eventDay) => eventDay.eventId === event.id)
    .sort((first, second) => first.order - second.order)
  const [eventName, setEventName] = useState(initialDraft.name)
  const [description, setDescription] = useState(initialDraft.description)
  const [notes, setNotes] = useState(initialDraft.notes)
  const [dateInputs, setDateInputs] = useState<DateInput[]>(
    createDateInputs(initialEventDays),
  )
  const [nextDateInputKey, setNextDateInputKey] = useState(0)
  const [errors, setErrors] = useState<EventBasicInfoValidationErrors>({})
  const [saveMessage, setSaveMessage] = useState('')
  const [pendingDeletion, setPendingDeletion] = useState<Pick<DateInput, 'key' | 'value'>>()
  const [pendingEventDeletion, setPendingEventDeletion] = useState<{
    eventId: Event['id']
    label: string
  }>()
  const [eventDeletionError, setEventDeletionError] = useState('')
  const [isDeletingEvent, setIsDeletingEvent] = useState(false)

  const getEventDeletionError = (
    result: Exclude<EventDeletionActionResult, { ok: true }>,
  ) => {
    if (result.reason === 'EVENT_NOT_FOUND') {
      return '削除するイベントが見つかりません。イベント一覧へ戻って状態を確認してください。'
    }
    if (result.reason === 'CLOUD_DELETE_FAILED') {
      return 'Cloud Eventを削除できませんでした。通信状態とワークスペース権限を確認してください。'
    }
    return 'イベント間の参照に矛盾があるため削除できません。データの整合性を確認してください。'
  }

  const clearFeedback = () => {
    setSaveMessage('')
    setErrors((previous) => ({ ...previous, form: undefined }))
  }

  const handleAddDate = () => {
    setDateInputs((previous) => [
      ...previous,
      { key: `new-event-day-${nextDateInputKey}`, value: '' },
    ])
    setNextDateInputKey((previous) => previous + 1)
    setErrors((previous) => ({
      ...previous,
      dates: undefined,
      form: undefined,
    }))
    setSaveMessage('')
  }

  const handleDateChange = (key: string, value: LocalDate) => {
    setDateInputs((previous) => previous.map((dateInput) =>
      dateInput.key === key ? { ...dateInput, value } : dateInput,
    ))
    setErrors((previous) => ({
      ...previous,
      dates: undefined,
      form: undefined,
    }))
    setSaveMessage('')
  }

  const handleRemoveDate = (dateInput: DateInput) => {
    if (dateInputs.length <= 1) return

    if (
      dateInput.eventDayId &&
      !canDeleteEventDay(dateInput.eventDayId)
    ) {
      setErrors((previous) => ({
        ...previous,
        form: DELETE_BLOCKED_MESSAGE,
      }))
      setSaveMessage('')
      return
    }

    setPendingDeletion({ key: dateInput.key, value: dateInput.value })
  }

  const confirmRemoveDate = () => {
    if (!pendingDeletion) return

    setDateInputs((previous) => previous.filter(
      (candidate) => candidate.key !== pendingDeletion.key,
    ))
    setErrors((previous) => ({
      ...previous,
      dates: undefined,
      form: undefined,
    }))
    setSaveMessage('')
    setPendingDeletion(undefined)
  }

  const requestEventDeletion = () => {
    const result = checkEventDeletion(event.id)
    if (!result.ok) {
      setEventDeletionError(getEventDeletionError(result))
      return
    }
    setEventDeletionError('')
    setPendingEventDeletion({
      eventId: event.id,
      label: event.name,
    })
  }

  const confirmEventDeletion = async () => {
    if (!pendingEventDeletion || isDeletingEvent) return
    setIsDeletingEvent(true)
    try {
      const result = await onDeleteEvent(pendingEventDeletion.eventId)
      if (!result.ok) {
        setPendingEventDeletion(undefined)
        setEventDeletionError(getEventDeletionError(result))
      }
    } finally {
      setIsDeletingEvent(false)
    }
  }

  const save = (moveToNext: boolean) => {
    const draft: EventBasicInfoDraft = {
      name: eventName,
      eventDays: dateInputs.map((dateInput) => ({
        eventDayId: dateInput.eventDayId,
        date: dateInput.value,
      })),
      description,
      notes,
    }
    const validationErrors = validateEventBasicInfoDraft(draft)
    setErrors(validationErrors)
    setSaveMessage('')

    if (validationErrors.name || validationErrors.dates) return

    const result = onSave(draft)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setEventName(result.event.name)
    setDescription(result.event.description ?? '')
    setNotes(result.event.notes ?? '')
    setDateInputs(createDateInputs(result.eventDays))

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
    <section className="event-basic-info" aria-label="イベント基本情報フォーム">
      <form noValidate onSubmit={handleSubmit}>
        <div className="event-basic-info__card">
          <div className="event-basic-info__field">
            <label htmlFor="event-basic-info-name">
              イベント名 <span aria-hidden="true">*</span>
            </label>
            <input
              id="event-basic-info-name"
              type="text"
              required
              value={eventName}
              aria-invalid={errors.name ? 'true' : undefined}
              aria-describedby={errors.name
                ? 'event-basic-info-name-error'
                : undefined}
              onChange={(changeEvent) => {
                setEventName(changeEvent.target.value)
                setErrors((previous) => ({
                  ...previous,
                  name: undefined,
                  form: undefined,
                }))
                setSaveMessage('')
              }}
            />
            {errors.name && (
              <p id="event-basic-info-name-error" className="form-error" role="alert">
                {errors.name}
              </p>
            )}
          </div>

          <fieldset
            className="event-basic-info__dates"
            aria-describedby={errors.dates
              ? 'event-basic-info-dates-error'
              : undefined}
          >
            <legend>
              開催日 <span aria-hidden="true">*</span>
            </legend>
            <div className="event-basic-info__date-list">
              {dateInputs.map((dateInput, index) => {
                const inputId = `event-basic-info-date-${dateInput.key}`

                return (
                  <div key={dateInput.key} className="event-basic-info__date-row">
                    <label className="visually-hidden" htmlFor={inputId}>
                      開催日 {index + 1}
                    </label>
                    <input
                      id={inputId}
                      type="date"
                      required
                      value={dateInput.value}
                      aria-invalid={errors.dates ? 'true' : undefined}
                      onChange={(changeEvent) =>
                        handleDateChange(dateInput.key, changeEvent.target.value)}
                    />
                    {dateInputs.length > 1 && (
                      <button
                        type="button"
                        className="event-basic-info__remove-date"
                        aria-label={`開催日 ${index + 1}を削除`}
                        onClick={() => handleRemoveDate(dateInput)}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {errors.dates && (
              <p id="event-basic-info-dates-error" className="form-error" role="alert">
                {errors.dates}
              </p>
            )}
            <button
              type="button"
              className="event-basic-info__add-date"
              onClick={handleAddDate}
            >
              <span aria-hidden="true">＋</span> 開催日を追加
            </button>
          </fieldset>

          <div className="event-basic-info__field">
            <label htmlFor="event-basic-info-description">イベント説明</label>
            <textarea
              id="event-basic-info-description"
              rows={5}
              value={description}
              onChange={(changeEvent) => {
                setDescription(changeEvent.target.value)
                clearFeedback()
              }}
            />
            <p className="event-basic-info__help">
              イベントの概要など、将来の公開情報にも使える内容です。
            </p>
          </div>

          <div className="event-basic-info__field">
            <label htmlFor="event-basic-info-notes">運営メモ</label>
            <textarea
              id="event-basic-info-notes"
              rows={5}
              value={notes}
              onChange={(changeEvent) => {
                setNotes(changeEvent.target.value)
                clearFeedback()
              }}
            />
            <p className="event-basic-info__help">
              会場への連絡事項など、運営内部向けの覚え書きです。
            </p>
          </div>

          {errors.form && (
            <p className="form-error event-basic-info__form-error" role="alert">
              {errors.form}
            </p>
          )}
        </div>

        <footer className="event-basic-info__actions">
          <span className="event-basic-info__save-status" role="status">
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
      <div className="event-basic-info__danger-zone">
        <div>
          <h3>危険な操作</h3>
          <p>
            このイベントとイベント内の設定を完全に削除します。共通データのメンバーと固定バンドは残ります。
          </p>
          {eventDeletionError && (
            <p className="form-error" role="alert">
              {eventDeletionError}
            </p>
          )}
        </div>
        <button
          type="button"
          className="event-basic-info__delete-event"
          onClick={requestEventDeletion}
        >
          このイベントを削除
        </button>
      </div>
      {pendingDeletion && (() => {
        const copy = getDeleteConfirmationCopy(
          'event-day',
          pendingDeletion.value || '未入力の開催日',
        )
        return (
          <DeleteConfirmationDialog
            {...copy}
            onCancel={() => setPendingDeletion(undefined)}
            onConfirm={confirmRemoveDate}
          />
        )
      })()}
      {pendingEventDeletion && (() => {
        const copy = getDeleteConfirmationCopy(
          'event',
          pendingEventDeletion.label,
        )
        return (
          <DeleteConfirmationDialog
            {...copy}
            onCancel={() => setPendingEventDeletion(undefined)}
            onConfirm={confirmEventDeletion}
          />
        )
      })()}
    </section>
  )
}
