import { useEffect, useId, useRef } from 'react'
import type { TimetableGridAssignmentDeletionPresentation } from '../ui/timetableGridAssignment.ts'
import { formatMinuteAsLocalTime } from '../domain/timeline.ts'

interface TimetableGridAssignmentDeletionDialogProps {
  items: readonly TimetableGridAssignmentDeletionPresentation[]
  includesOutsideSelection: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function TimetableGridAssignmentDeletionDialog({
  items,
  includesOutsideSelection,
  onConfirm,
  onCancel,
}: TimetableGridAssignmentDeletionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="delete-confirmation-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <div className="delete-confirmation-dialog__content">
        <header>
          <h2 id={titleId}>担当を削除</h2>
        </header>
        <div id={descriptionId} className="timetable-grid-assignment-deletion-dialog__description">
          <p>選択範囲に含まれる担当設定をAssignment単位で削除します。</p>
          <strong>削除する担当 {items.length}件</strong>
          <ul>
            {items.map((item) => (
              <li key={`${item.target.kind}:${item.target.assignmentId}`}>
                {item.targetLabel} {item.memberName}{' '}
                {formatMinuteAsLocalTime(item.fromMinute)}〜
                {formatMinuteAsLocalTime(item.untilMinute)}
              </li>
            ))}
          </ul>
          {includesOutsideSelection && (
            <p className="timetable-grid-assignment-deletion-dialog__warning">
              選択範囲外まで続く担当も、担当設定全体が削除されます。
            </p>
          )}
        </div>
        <footer className="delete-confirmation-dialog__actions">
          <button type="button" className="secondary-button" autoFocus onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="delete-confirmation-dialog__confirm"
            onClick={onConfirm}
          >
            削除
          </button>
        </footer>
      </div>
    </dialog>
  )
}
