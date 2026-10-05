import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  Section,
  Stage,
  TimetableOrderConstraint,
} from '../domain/models'
import type {
  TimetableOrderConstraintDraft,
  TimetableOrderConstraintMutationResult,
} from '../domain/timetableOrderConstraints'

interface TimetableOrderConstraintDialogProps {
  event: Event
  eventDay: EventDay
  stage: Stage
  sections: Section[]
  eventBands: EventBand[]
  constraint?: TimetableOrderConstraint
  onCancel: () => void
  onSave: (draft: TimetableOrderConstraintDraft) => TimetableOrderConstraintMutationResult
}

export function TimetableOrderConstraintDialog({
  event,
  eventDay,
  stage,
  sections,
  eventBands,
  constraint,
  onCancel,
  onSave,
}: TimetableOrderConstraintDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const errorId = `${generatedId}-errors`
  const orderedSections = [...sections].sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id))
  const orderedBands = [...eventBands].sort((left, right) =>
    left.name.localeCompare(right.name, 'ja') || left.id.localeCompare(right.id))
  const [sectionId, setSectionId] = useState(constraint?.sectionId ?? '')
  const [eventBandIds, setEventBandIds] = useState<string[]>(
    () => constraint ? [...constraint.eventBandIds] : ['', ''],
  )
  const [errors, setErrors] = useState<string[]>([])
  const bandById = new Map(eventBands.map(band => [band.id, band]))
  const sectionById = new Map(sections.map(section => [section.id, section]))

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const updateBand = (index: number, eventBandId: string) => {
    setEventBandIds(previous => previous.map((value, candidateIndex) =>
      candidateIndex === index ? eventBandId : value))
    setErrors([])
  }

  const moveBand = (index: number, offset: -1 | 1) => {
    setEventBandIds(previous => {
      const destination = index + offset
      if (destination < 0 || destination >= previous.length) return previous
      const next = [...previous]
      ;[next[index], next[destination]] = [next[destination], next[index]]
      return next
    })
    setErrors([])
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    const result = onSave({
      ...(sectionId ? { sectionId } : {}),
      eventBandIds: [...eventBandIds],
    })
    if (!result.ok) setErrors(result.errors)
  }

  return (
    <dialog
      ref={dialogRef}
      className="timetable-order-dialog"
      aria-labelledby={titleId}
      aria-describedby={errors.length ? errorId : undefined}
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault()
        onCancel()
      }}
    >
      <form noValidate onSubmit={handleSubmit}>
        <header>
          <p>STEP 6</p>
          <h2 id={titleId}>{constraint ? '出演順制約を編集' : '出演順制約を追加'}</h2>
          <span>{event.name} / {eventDay.label ?? eventDay.date} / {stage.name}</span>
        </header>

        {orderedSections.length > 0 ? (
          <label className="timetable-order-dialog__section">
            Section
            <select
              value={sectionId}
              aria-invalid={errors.length ? 'true' : undefined}
              onChange={(changeEvent) => {
                setSectionId(changeEvent.target.value)
                setErrors([])
              }}
            >
              <option value="">選択してください</option>
              {sectionId && !sectionById.has(sectionId) && (
                <option value={sectionId} disabled>現在は選択できないSection（{sectionId}）</option>
              )}
              {orderedSections.map(section => (
                <option key={section.id} value={section.id}>{section.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <p className="timetable-order-dialog__lane">対象：Stage全体</p>
        )}

        <fieldset className="timetable-order-dialog__bands">
          <legend>出演順</legend>
          {eventBandIds.map((eventBandId, index) => {
            const bandLabel = bandById.get(eventBandId)?.name ??
              (eventBandId ? `参照先不明（${eventBandId}）` : `${index + 1}組目`)
            const selectedElsewhere = new Set(eventBandIds.filter((_, candidateIndex) =>
              candidateIndex !== index))
            return (
              <div className="timetable-order-dialog__band-row" key={`${index}-${eventBandId}`}>
                <span aria-hidden="true">{index + 1}</span>
                <label>
                  <span className="visually-hidden">{index + 1}組目のバンド</span>
                  <select
                    value={eventBandId}
                    aria-label={`${index + 1}組目のバンド`}
                    aria-invalid={errors.length ? 'true' : undefined}
                    onChange={changeEvent => updateBand(index, changeEvent.target.value)}
                  >
                    <option value="">選択してください</option>
                    {eventBandId && !bandById.has(eventBandId) && (
                      <option value={eventBandId} disabled>{bandLabel}</option>
                    )}
                    {orderedBands.map(band => (
                      <option
                        key={band.id}
                        value={band.id}
                        disabled={selectedElsewhere.has(band.id)}
                      >
                        {band.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`${bandLabel}を上へ移動`}
                  disabled={index === 0}
                  onClick={() => moveBand(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`${bandLabel}を下へ移動`}
                  disabled={index === eventBandIds.length - 1}
                  onClick={() => moveBand(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="timetable-order-dialog__remove"
                  aria-label={`${bandLabel}を出演順から削除`}
                  disabled={eventBandIds.length <= 2}
                  onClick={() => {
                    setEventBandIds(previous => previous.filter((_, candidateIndex) =>
                      candidateIndex !== index))
                    setErrors([])
                  }}
                >
                  削除
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="secondary-button timetable-order-dialog__add-band"
            disabled={!orderedBands.some(band => !eventBandIds.includes(band.id))}
            onClick={() => {
              setEventBandIds(previous => [...previous, ''])
              setErrors([])
            }}
          >
            バンドを追加
          </button>
        </fieldset>

        {errors.length > 0 && (
          <div id={errorId} className="timetable-order-dialog__errors" role="alert">
            {errors.map(message => <p className="form-error" key={message}>{message}</p>)}
          </div>
        )}

        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">保存</button>
        </footer>
      </form>
    </dialog>
  )
}
