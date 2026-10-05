import { useEffect, useId, useRef, type FormEvent } from 'react'
import type { Member } from '../domain/models'
import type { DutyAutoAssignmentPlanResult } from '../domain/dutyAutoAssignment'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import type { ResolvedTimetableGridRangeSelection } from '../ui/timetableGridSelection'

interface TimetableDutyAutoAssignmentDialogProps {
  selection: ResolvedTimetableGridRangeSelection
  dutyTypeName: string
  additionalCount: string
  preview: DutyAutoAssignmentPlanResult
  members: Member[]
  notice?: string
  errors: string[]
  onAdditionalCountChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

export function TimetableDutyAutoAssignmentDialog({
  selection,
  dutyTypeName,
  additionalCount,
  preview,
  members,
  notice,
  errors,
  onAdditionalCountChange,
  onCancel,
  onSubmit,
}: TimetableDutyAutoAssignmentDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const countId = useId()
  const memberById = new Map(members.map((member) => [member.id, member]))
  const warningMetrics = preview.ok
    ? preview.plan.candidateMetrics.filter((metric) =>
        metric.participationStatus === 'undecided',
      )
    : []

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preview.ok) return
    onSubmit()
  }

  return (
    <dialog
      ref={dialogRef}
      className="pa-assignment-dialog timetable-grid-assignment-dialog duty-auto-assignment-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form noValidate onSubmit={handleSubmit}>
        <header>
          <p>STEP 6</p>
          <h2 id={titleId}>{dutyTypeName}の自動割り当て</h2>
          <span>選択範囲全体を担当できるメンバーを自動選出します。</span>
        </header>

        <dl className="timetable-grid-assignment-dialog__summary">
          <div><dt>対象</dt><dd>{dutyTypeName}</dd></div>
          <div>
            <dt>範囲</dt>
            <dd>
              {formatMinuteAsLocalTime(selection.fromMinute)}〜
              {formatMinuteAsLocalTime(selection.untilMinute)}
            </dd>
          </div>
          <div><dt>選択枠</dt><dd>{selection.rowCount}枠</dd></div>
        </dl>

        <div className="pa-assignment-dialog__fields">
          <label htmlFor={countId}>
            追加人数
            <input
              id={countId}
              type="number"
              min="1"
              step="1"
              autoFocus
              value={additionalCount}
              aria-invalid={!preview.ok ? 'true' : undefined}
              onChange={(event) => onAdditionalCountChange(event.target.value)}
            />
            <small>既存の担当は残したまま、この人数分を追加します。</small>
          </label>
        </div>

        {notice && (
          <p className="pa-assignment-dialog__warning" role="status">{notice}</p>
        )}
        {preview.ok ? (
          <section className="duty-auto-assignment-dialog__preview" aria-label="自動選出結果">
            <h3>自動選出</h3>
            <ol>
              {preview.plan.candidateMetrics.map((metric) => (
                <li key={metric.memberId}>
                  <strong>{memberById.get(metric.memberId)?.realName ?? metric.memberId}</strong>
                  <span>
                    既存Duty {metric.existingDutyMinutes}分・
                    {metric.existingDutyAssignmentCount}件
                  </span>
                </li>
              ))}
            </ol>
            {preview.plan.warnings.map((warning, index) => {
              const metric = warningMetrics[index]
              const key = metric
                ? `${metric.memberId}:${metric.eventMemberId}:${metric.eventMemberDayId}`
                : `warning:${index}:${warning}`
              return (
                <p className="pa-assignment-dialog__warning" role="status" key={key}>
                  注意：{warning}
                </p>
              )
            })}
          </section>
        ) : (
          <p className="form-error" role="alert">{preview.message}</p>
        )}
        {errors.map((message) => (
          <p className="form-error" role="alert" key={message}>{message}</p>
        ))}

        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button" disabled={!preview.ok}>
            この内容で追加
          </button>
        </footer>
      </form>
    </dialog>
  )
}
