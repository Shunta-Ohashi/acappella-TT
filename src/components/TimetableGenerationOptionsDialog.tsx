import { useEffect, useRef } from 'react'
import type { TimetableGenerationUiOptions } from '../domain/timetableGenerationOptions'

export function TimetableGenerationOptionsDialog({ dayLabel, options, onChange, onCancel, onGenerate }: {
  dayLabel: string
  options: TimetableGenerationUiOptions
  onChange: (options: TimetableGenerationUiOptions) => void
  onCancel: () => void
  onGenerate: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog ref={dialogRef} className="generation-preview-dialog timetable-action-dialog"
      aria-labelledby="generation-options-title"
      onCancel={event => { event.preventDefault(); onCancel() }}
      onClose={() => { if (dialogRef.current && !dialogRef.current.open) onCancel() }}>
      <h2 id="generation-options-title">自動生成設定</h2>
      <p>{dayLabel}</p>
      <p>選択中の開催日の全Stageを対象にタイムテーブルを自動生成します。
        TT固定・出演条件・当日運営の担当条件は引き続き守られます。</p>
      <fieldset className="timetable-generation-options">
        <legend>既存の休憩</legend>
        <label><input type="checkbox" checked={options.keepIntraSectionBreaks}
          onChange={event => onChange({ ...options, keepIntraSectionBreaks: event.target.checked })} />
          既存の部内休憩を残す</label>
        <label><input type="checkbox" checked={options.keepInterSectionBreaks}
          onChange={event => onChange({ ...options, keepInterSectionBreaks: event.target.checked })} />
          既存の部間休憩を残す</label>
      </fieldset>
      <p>OFFにした休憩は、プレビューを適用した時点で削除されます。
        SectionなしStageの休憩は常に残します。休憩を参照する当日運営の担当がある場合は生成できません。</p>
      <footer>
        <button type="button" className="secondary-button" onClick={onCancel}>キャンセル</button>
        <button type="button" className="primary-button" onClick={onGenerate}>この条件で自動生成</button>
      </footer>
    </dialog>
  )
}
