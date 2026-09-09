import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { LocalDate } from '../domain/models'
import {
  validateNewEventDraft,
  type NewEventDraft,
  type NewEventValidationErrors,
} from '../domain/eventCreation'

interface CreateEventDialogProps {
  onCancel: () => void
  onCreate: (draft: NewEventDraft) => void
}

interface DateInput {
  key: number
  value: LocalDate
}

export function CreateEventDialog({
  onCancel,
  onCreate,
}: CreateEventDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [eventName, setEventName] = useState('')
  const [dateInputs, setDateInputs] = useState<DateInput[]>([
    { key: 0, value: '' },
  ])
  const [nextDateInputKey, setNextDateInputKey] = useState(1)
  const [errors, setErrors] = useState<NewEventValidationErrors>({})

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const handleAddDate = () => {
    setDateInputs((previous) => [
      ...previous,
      { key: nextDateInputKey, value: '' },
    ])
    setNextDateInputKey((previous) => previous + 1)
    setErrors((previous) => ({ ...previous, dates: undefined }))
  }

  const handleDateChange = (key: number, value: LocalDate) => {
    setDateInputs((previous) => previous.map((dateInput) =>
      dateInput.key === key ? { ...dateInput, value } : dateInput,
    ))
    setErrors((previous) => ({ ...previous, dates: undefined }))
  }

  const handleRemoveDate = (key: number) => {
    setDateInputs((previous) => previous.length > 1
      ? previous.filter((dateInput) => dateInput.key !== key)
      : previous)
    setErrors((previous) => ({ ...previous, dates: undefined }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const draft: NewEventDraft = {
      name: eventName,
      dates: dateInputs.map((dateInput) => dateInput.value),
    }
    const validationErrors = validateNewEventDraft(draft)
    setErrors(validationErrors)

    if (validationErrors.name || validationErrors.dates) return
    onCreate(draft)
  }

  return (
    <dialog
      ref={dialogRef}
      className="create-event-dialog"
      aria-modal="true"
      aria-labelledby="create-event-dialog-title"
      aria-describedby="create-event-dialog-description"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form className="create-event-form" noValidate onSubmit={handleSubmit}>
        <header className="create-event-form__header">
          <p className="create-event-form__eyebrow">イベント</p>
          <h2 id="create-event-dialog-title">新しいイベントを作成</h2>
          <p id="create-event-dialog-description">
            イベント名と開催日を入力してください。詳細は作成後に設定できます。
          </p>
        </header>

        <div className="create-event-form__field">
          <label htmlFor="new-event-name">
            イベント名 <span aria-hidden="true">*</span>
          </label>
          <input
            id="new-event-name"
            type="text"
            autoFocus
            required
            value={eventName}
            aria-invalid={errors.name ? 'true' : undefined}
            aria-describedby={errors.name ? 'new-event-name-error' : undefined}
            onChange={(event) => {
              setEventName(event.target.value)
              setErrors((previous) => ({ ...previous, name: undefined }))
            }}
          />
          {errors.name && (
            <p id="new-event-name-error" className="form-error" role="alert">
              {errors.name}
            </p>
          )}
        </div>

        <fieldset
          className="create-event-form__dates"
          aria-describedby={errors.dates ? 'new-event-dates-error' : undefined}
        >
          <legend>
            開催日 <span aria-hidden="true">*</span>
          </legend>
          <div className="create-event-form__date-list">
            {dateInputs.map((dateInput, index) => {
              const inputId = `new-event-date-${dateInput.key}`

              return (
                <div key={dateInput.key} className="create-event-form__date-row">
                  <label className="visually-hidden" htmlFor={inputId}>
                    開催日 {index + 1}
                  </label>
                  <input
                    id={inputId}
                    type="date"
                    required
                    value={dateInput.value}
                    aria-invalid={errors.dates ? 'true' : undefined}
                    onChange={(event) =>
                      handleDateChange(dateInput.key, event.target.value)}
                  />
                  {dateInputs.length > 1 && (
                    <button
                      type="button"
                      className="create-event-form__remove-date"
                      aria-label={`開催日 ${index + 1}を削除`}
                      onClick={() => handleRemoveDate(dateInput.key)}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {errors.dates && (
            <p id="new-event-dates-error" className="form-error" role="alert">
              {errors.dates}
            </p>
          )}
          <button
            type="button"
            className="create-event-form__add-date"
            onClick={handleAddDate}
          >
            <span aria-hidden="true">＋</span> 開催日を追加
          </button>
        </fieldset>

        <footer className="create-event-form__actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">
            作成
          </button>
        </footer>
      </form>
    </dialog>
  )
}
