import { useEffect, useRef } from 'react'

export function TimetableResetConfirmDialog({ dayLabel, onCancel, onReset }: {
  dayLabel: string
  onCancel: () => void
  onReset: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog ref={dialogRef} className="generation-preview-dialog timetable-action-dialog"
      aria-labelledby="timetable-reset-title"
      onCancel={event => { event.preventDefault(); onCancel() }}
      onClose={() => { if (dialogRef.current && !dialogRef.current.open) onCancel() }}>
      <h2 id="timetable-reset-title">この開催日のTTを初期化しますか？</h2>
      <p>{dayLabel}の全Stageが対象です。</p>
      <p>この開催日の出演バンド配置とPA担当を削除し、すべての出演バンドを未配置へ戻します。</p>
      <p>配置を参照する当日運営の担当とTT固定も削除されます。</p>
      <p>部内休憩・部間休憩・出演条件・Dutyの種類は残ります。他の開催日は変更しません。</p>
      <p className="form-error">この操作は元に戻せません。</p>
      <footer>
        <button type="button" className="secondary-button" autoFocus onClick={onCancel}>キャンセル</button>
        <button type="button" className="timetable-reset-button" onClick={onReset}>TTを初期化</button>
      </footer>
    </dialog>
  )
}
