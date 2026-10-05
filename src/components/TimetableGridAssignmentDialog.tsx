import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import type { ResolvedTimetableGridRangeSelection } from '../ui/timetableGridSelection'
import type { TimetableGridAssignmentCandidate } from '../ui/timetableGridAssignment'

interface TimetableGridAssignmentDialogProps {
  selection: ResolvedTimetableGridRangeSelection
  targetLabel: string
  candidates: TimetableGridAssignmentCandidate[]
  errors: string[]
  onCancel: () => void
  onClearErrors: () => void
  onSubmit: (memberId: string) => void
}

export function TimetableGridAssignmentDialog({
  selection,
  targetLabel,
  candidates,
  errors,
  onCancel,
  onClearErrors,
  onSubmit,
}: TimetableGridAssignmentDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const memberSelectId = useId()
  const [memberId, setMemberId] = useState('')
  const selectedCandidate = candidates.find((candidate) =>
    candidate.memberId === memberId,
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const emptyMessage = selection.target.kind === 'pa'
    ? `この開催日に${targetLabel}を担当できるメンバーがいません。Step 3の参加状況・PA可否を確認してください。`
    : 'この開催日に担当できるメンバーがいません。Step 3の参加状況を確認してください。'

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!memberId) return
    onSubmit(memberId)
  }

  return (
    <dialog
      ref={dialogRef}
      className="pa-assignment-dialog timetable-grid-assignment-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form noValidate onSubmit={handleSubmit}>
        <header>
          <p>STEP 6</p>
          <h2 id={titleId}>{targetLabel}の担当を設定</h2>
          <span>Gridで選択した範囲へ新しい担当を追加します。</span>
        </header>

        <dl className="timetable-grid-assignment-dialog__summary">
          <div><dt>対象</dt><dd>{targetLabel}</dd></div>
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
          <label htmlFor={memberSelectId}>
            担当メンバー
            <select
              id={memberSelectId}
              autoFocus
              value={memberId}
              disabled={candidates.length === 0}
              aria-invalid={errors.length > 0 ? 'true' : undefined}
              onChange={(event) => {
                setMemberId(event.target.value)
                onClearErrors()
              }}
            >
              <option value="">選択してください</option>
              {candidates.map((candidate) => (
                <option key={candidate.memberId} value={candidate.memberId}>
                  {candidate.memberName}
                  {candidate.participationStatus === 'undecided'
                    ? '（参加未定）'
                    : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        {candidates.length === 0 && (
          <p className="pa-assignment-dialog__hint" role="status">
            {emptyMessage}
          </p>
        )}
        {selectedCandidate?.warning && (
          <p className="pa-assignment-dialog__warning" role="status">
            注意：{selectedCandidate.warning}
          </p>
        )}
        {errors.map((message) => (
          <p className="form-error" role="alert" key={message}>{message}</p>
        ))}

        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={!memberId || candidates.length === 0}
          >
            この範囲に割り当て
          </button>
        </footer>
      </form>
    </dialog>
  )
}
