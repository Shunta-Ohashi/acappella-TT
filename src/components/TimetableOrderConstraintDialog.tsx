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
import { getInitialTimetableOrderConstraintSectionId } from '../ui/timetableOrderConstraintPresentation'

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

interface BandDraftRow {
  rowId: string
  eventBandId: string
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
  const [sectionId, setSectionId] = useState(() =>
    getInitialTimetableOrderConstraintSectionId({ constraint, sections: orderedSections }))
  const initialEventBandIds = constraint ? constraint.eventBandIds : ['', '']
  const nextRowSequence = useRef(initialEventBandIds.length)
  const [bandRows, setBandRows] = useState<BandDraftRow[]>(
    () => initialEventBandIds.map((eventBandId, index) => ({
      rowId: `initial-${index}`,
      eventBandId,
    })),
  )
  const [errors, setErrors] = useState<string[]>([])
  const bandById = new Map(eventBands.map(band => [band.id, band]))
  const sectionById = new Map(sections.map(section => [section.id, section]))
  const cannotAddBandRow = bandRows.length >= orderedBands.length ||
    bandRows.some(row => !row.eventBandId)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const updateBand = (rowId: string, eventBandId: string) => {
    setBandRows(previous => previous.map(row =>
      row.rowId === rowId ? { ...row, eventBandId } : row))
    setErrors([])
  }

  const moveBand = (rowId: string, offset: -1 | 1) => {
    setBandRows(previous => {
      const index = previous.findIndex(row => row.rowId === rowId)
      const destination = index + offset
      if (index < 0 || destination < 0 || destination >= previous.length) return previous
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
      eventBandIds: bandRows.map(row => row.eventBandId),
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
          <span>{event.name} / {eventDay.label?.trim() || eventDay.date} / {stage.name}</span>
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
          {bandRows.map((row, index) => {
            const bandLabel = bandById.get(row.eventBandId)?.name ??
              (row.eventBandId ? `参照先不明（${row.eventBandId}）` : `${index + 1}組目`)
            const selectedElsewhere = new Set(bandRows
              .filter(candidate => candidate.rowId !== row.rowId)
              .map(candidate => candidate.eventBandId))
            return (
              <div className="timetable-order-dialog__band-row" key={row.rowId}>
                <span aria-hidden="true">{index + 1}</span>
                <label>
                  <span className="visually-hidden">{index + 1}組目のバンド</span>
                  <select
                    value={row.eventBandId}
                    aria-label={`${index + 1}組目のバンド`}
                    aria-invalid={errors.length ? 'true' : undefined}
                    onChange={changeEvent => updateBand(row.rowId, changeEvent.target.value)}
                  >
                    <option value="">選択してください</option>
                    {row.eventBandId && !bandById.has(row.eventBandId) && (
                      <option value={row.eventBandId} disabled>{bandLabel}</option>
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
                  onClick={() => moveBand(row.rowId, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`${bandLabel}を下へ移動`}
                  disabled={index === bandRows.length - 1}
                  onClick={() => moveBand(row.rowId, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="timetable-order-dialog__remove"
                  aria-label={`${bandLabel}を出演順から削除`}
                  disabled={bandRows.length <= 2}
                  onClick={() => {
                    setBandRows(previous => previous.filter(candidate =>
                      candidate.rowId !== row.rowId))
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
            disabled={cannotAddBandRow}
            onClick={() => {
              const rowId = `added-${nextRowSequence.current}`
              nextRowSequence.current += 1
              setBandRows(previous => [...previous, { rowId, eventBandId: '' }])
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
