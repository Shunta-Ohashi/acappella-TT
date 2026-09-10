import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { EventDay, EventDayId, Member } from '../domain/models'
import type {
  EventMemberDaySettingsDraft,
  EventMemberSettingsMemberDraft,
} from '../domain/eventMemberSettings'
import {
  applyEventMemberDayDetails,
  createEventMemberDayDetailsDraft,
  type AvailabilityInputMode,
  type EditableTimeRange,
  type EventMemberDayDetailsDraft,
  type EventMemberDayDetailsValidationErrors,
} from '../domain/eventMemberDayDetails'

interface EventMemberDayDetailsDialogProps {
  member: Member
  memberDraft: EventMemberSettingsMemberDraft
  eventDays: EventDay[]
  initialEventDayId: EventDayId
  dayErrors: Record<EventDayId, string | undefined>
  onCancel: () => void
  onApply: (days: EventMemberDaySettingsDraft[]) => void
}

const formatEventDay = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}/${Number(day)}`
}

const participationStatusLabels = {
  participating: '参加',
  absent: '不参加',
  undecided: '未定',
} as const

const emptyTimeRange = (): EditableTimeRange => ({ from: '', until: '' })

export function EventMemberDayDetailsDialog({
  member,
  memberDraft,
  eventDays,
  initialEventDayId,
  dayErrors,
  onCancel,
  onApply,
}: EventMemberDayDetailsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [selectedEventDayId, setSelectedEventDayId] = useState(
    initialEventDayId,
  )
  const [detailDrafts, setDetailDrafts] = useState(() => Object.fromEntries(
    memberDraft.days.map((day) => [
      day.eventDayId,
      createEventMemberDayDetailsDraft(day),
    ]),
  ) as Record<EventDayId, EventMemberDayDetailsDraft>)
  const [validationErrors, setValidationErrors] = useState<
    Record<EventDayId, EventMemberDayDetailsValidationErrors>
  >({})
  const selectedEventDay = eventDays.find(
    (eventDay) => eventDay.id === selectedEventDayId,
  )
  const selectedDay = memberDraft.days.find(
    (day) => day.eventDayId === selectedEventDayId,
  )
  const selectedDetails = detailDrafts[selectedEventDayId]
  const selectedErrors = validationErrors[selectedEventDayId] ?? {}
  const isAbsent = selectedDay?.participationStatus === 'absent'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  if (!selectedEventDay || !selectedDay || !selectedDetails) return null

  const updateSelectedDetails = (
    update: (previous: EventMemberDayDetailsDraft) => EventMemberDayDetailsDraft,
  ) => {
    setDetailDrafts((previous) => ({
      ...previous,
      [selectedEventDayId]: update(previous[selectedEventDayId]),
    }))
    setValidationErrors((previous) => {
      const next = { ...previous }
      delete next[selectedEventDayId]
      return next
    })
  }

  const handleAvailabilityModeChange = (mode: AvailabilityInputMode) => {
    if (mode === selectedDetails.availabilityMode) return
    updateSelectedDetails((previous) => ({
      ...previous,
      availabilityMode: mode,
      availabilityRanges: mode === 'all-day' ? [] : [emptyTimeRange()],
    }))
  }

  const updateAvailabilityRange = (
    index: number,
    field: keyof EditableTimeRange,
    value: string,
  ) => {
    updateSelectedDetails((previous) => ({
      ...previous,
      availabilityRanges: previous.availabilityRanges.map((range, rangeIndex) =>
        rangeIndex === index ? { ...range, [field]: value } : range,
      ),
    }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextDays: EventMemberDaySettingsDraft[] = []
    const nextErrors: Record<
      EventDayId,
      EventMemberDayDetailsValidationErrors
    > = {}
    let firstErrorEventDayId: EventDayId | undefined

    memberDraft.days.forEach((day) => {
      const details = detailDrafts[day.eventDayId]
      if (!details) return
      const result = applyEventMemberDayDetails(day, details)
      if (result.ok) {
        nextDays.push(result.day)
      } else {
        nextErrors[day.eventDayId] = result.errors
        firstErrorEventDayId ??= day.eventDayId
      }
    })

    if (firstErrorEventDayId) {
      setValidationErrors(nextErrors)
      setSelectedEventDayId(firstErrorEventDayId)
      return
    }

    onApply(nextDays)
  }

  const dayLabel = formatEventDay(selectedEventDay)
  const availabilityRangeLabel = selectedDetails.availabilityMode === 'unavailable'
    ? '参加できない時間'
    : '参加可能時間'

  return (
    <dialog
      ref={dialogRef}
      className="event-member-details-dialog"
      aria-modal="true"
      aria-labelledby="event-member-details-title"
      aria-describedby="event-member-details-description"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form className="event-member-details-form" noValidate onSubmit={handleSubmit}>
        <header className="event-member-details-form__header">
          <p>イベントメンバー</p>
          <h2 id="event-member-details-title">{member.realName} / 日別設定</h2>
          <span id="event-member-details-description">
            開催日ごとの出演可能時間・希望・メモを設定します。
          </span>
        </header>

        <nav className="event-member-details-days" aria-label="設定する開催日">
          {eventDays.map((eventDay) => {
            const hasError = Boolean(
              dayErrors[eventDay.id] || validationErrors[eventDay.id],
            )
            return (
              <button
                key={eventDay.id}
                type="button"
                aria-pressed={eventDay.id === selectedEventDayId}
                className={eventDay.id === selectedEventDayId
                  ? 'event-member-details-days__button event-member-details-days__button--active'
                  : 'event-member-details-days__button'}
                onClick={() => setSelectedEventDayId(eventDay.id)}
              >
                {formatEventDay(eventDay)}
                {hasError && <span>エラーあり</span>}
              </button>
            )
          })}
        </nav>

        <section className="event-member-details-form__day">
          <div className="event-member-details-form__status">
            <span>参加状況</span>
            <strong>
              {participationStatusLabels[selectedDay.participationStatus]}
            </strong>
          </div>

          {dayErrors[selectedEventDayId] && (
            <p className="form-error event-member-details-form__day-error" role="alert">
              {dayErrors[selectedEventDayId]}
            </p>
          )}

          {isAbsent && (
            <p className="event-member-details-form__disabled-note">
              この日は不参加のため、時間条件は判定に使用されません。入力済みの内容は保持されます。
            </p>
          )}

          <fieldset
            className="event-member-details-choice"
            disabled={isAbsent}
          >
            <legend>参加可能時間</legend>
            <label>
              <input
                type="radio"
                name={`availability-mode-${selectedEventDayId}`}
                checked={selectedDetails.availabilityMode === 'all-day'}
                onChange={() => handleAvailabilityModeChange('all-day')}
              />
              終日参加可能
            </label>
            <label>
              <input
                type="radio"
                name={`availability-mode-${selectedEventDayId}`}
                checked={selectedDetails.availabilityMode === 'available'}
                onChange={() => handleAvailabilityModeChange('available')}
              />
              参加可能時間を指定
            </label>
            <label>
              <input
                type="radio"
                name={`availability-mode-${selectedEventDayId}`}
                checked={selectedDetails.availabilityMode === 'unavailable'}
                onChange={() => handleAvailabilityModeChange('unavailable')}
              />
              参加できない時間を指定
            </label>
          </fieldset>

          {!isAbsent && selectedDetails.availabilityMode !== 'all-day' && (
            <div className="event-member-details-ranges">
              <p>{availabilityRangeLabel}</p>
              {selectedDetails.availabilityRanges.map((range, index) => (
                <div key={index} className="event-member-details-range">
                  <label>
                    <span className="visually-hidden">
                      {dayLabel}の{availabilityRangeLabel}{index + 1}件目の開始時刻
                    </span>
                    <input
                      type="time"
                      value={range.from}
                      aria-invalid={selectedErrors.availability ? 'true' : undefined}
                      onChange={(event) => updateAvailabilityRange(
                        index,
                        'from',
                        event.target.value,
                      )}
                    />
                  </label>
                  <span>〜</span>
                  <label>
                    <span className="visually-hidden">
                      {dayLabel}の{availabilityRangeLabel}{index + 1}件目の終了時刻
                    </span>
                    <input
                      type="time"
                      value={range.until}
                      aria-invalid={selectedErrors.availability ? 'true' : undefined}
                      onChange={(event) => updateAvailabilityRange(
                        index,
                        'until',
                        event.target.value,
                      )}
                    />
                  </label>
                  <button
                    type="button"
                    className="event-member-details-range__delete"
                    aria-label={`${dayLabel}の${availabilityRangeLabel}${index + 1}件目を削除`}
                    onClick={() => updateSelectedDetails((previous) => ({
                      ...previous,
                      availabilityRanges: previous.availabilityRanges.filter(
                        (_, rangeIndex) => rangeIndex !== index,
                      ),
                    }))}
                  >
                    削除
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary-button"
                onClick={() => updateSelectedDetails((previous) => ({
                  ...previous,
                  availabilityRanges: [
                    ...previous.availabilityRanges,
                    emptyTimeRange(),
                  ],
                }))}
              >
                ＋ 時間帯を追加
              </button>
              <span className="event-member-details-form__help">
                開始・終了の片方だけでも指定できます。入力方式を変更すると、入力中の時間帯は置き換えられます。
              </span>
              {selectedErrors.availability && (
                <p className="form-error" role="alert">
                  {selectedErrors.availability}
                </p>
              )}
            </div>
          )}

          <fieldset
            className="event-member-details-choice"
            disabled={isAbsent}
          >
            <legend>希望時間</legend>
            <label>
              <input
                type="radio"
                name={`preferred-mode-${selectedEventDayId}`}
                checked={selectedDetails.preferredTimeMode === 'none'}
                onChange={() => updateSelectedDetails((previous) => ({
                  ...previous,
                  preferredTimeMode: 'none',
                }))}
              />
              指定なし
            </label>
            <label>
              <input
                type="radio"
                name={`preferred-mode-${selectedEventDayId}`}
                checked={selectedDetails.preferredTimeMode === 'specified'}
                onChange={() => updateSelectedDetails((previous) => ({
                  ...previous,
                  preferredTimeMode: 'specified',
                }))}
              />
              時間を指定
            </label>
          </fieldset>

          {!isAbsent && selectedDetails.preferredTimeMode === 'specified' && (
            <div className="event-member-details-ranges">
              <p>希望時間</p>
              <div className="event-member-details-range">
                <label>
                  <span className="visually-hidden">{dayLabel}の希望開始時刻</span>
                  <input
                    type="time"
                    value={selectedDetails.preferredTimeRange.from}
                    aria-invalid={selectedErrors.preferredTimeRange
                      ? 'true'
                      : undefined}
                    onChange={(event) => updateSelectedDetails((previous) => ({
                      ...previous,
                      preferredTimeRange: {
                        ...previous.preferredTimeRange,
                        from: event.target.value,
                      },
                    }))}
                  />
                </label>
                <span>〜</span>
                <label>
                  <span className="visually-hidden">{dayLabel}の希望終了時刻</span>
                  <input
                    type="time"
                    value={selectedDetails.preferredTimeRange.until}
                    aria-invalid={selectedErrors.preferredTimeRange
                      ? 'true'
                      : undefined}
                    onChange={(event) => updateSelectedDetails((previous) => ({
                      ...previous,
                      preferredTimeRange: {
                        ...previous.preferredTimeRange,
                        until: event.target.value,
                      },
                    }))}
                  />
                </label>
              </div>
              <span className="event-member-details-form__help">
                開始・終了の片方だけでも指定できます。
              </span>
              {selectedErrors.preferredTimeRange && (
                <p className="form-error" role="alert">
                  {selectedErrors.preferredTimeRange}
                </p>
              )}
            </div>
          )}

          <div className="event-member-details-notes">
            <label htmlFor={`event-member-details-notes-${selectedEventDayId}`}>
              日別メモ
            </label>
            <textarea
              id={`event-member-details-notes-${selectedEventDayId}`}
              rows={4}
              value={selectedDetails.notes}
              onChange={(event) => updateSelectedDetails((previous) => ({
                ...previous,
                notes: event.target.value,
              }))}
            />
          </div>
        </section>

        <footer className="event-member-details-form__actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">適用</button>
        </footer>
      </form>
    </dialog>
  )
}
