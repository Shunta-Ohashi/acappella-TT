import { useEffect, useRef } from 'react'
import type { TimetableGenerationPreview } from '../ui/timetableGenerationPresentation'
import type { TimetableGenerationUiOptions } from '../domain/timetableGenerationOptions'

export function TimetableGenerationPreviewDialog({ preview, options, onCancel, onApply }: {
  preview: TimetableGenerationPreview
  options: TimetableGenerationUiOptions
  onCancel: () => void
  onApply: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  const { summary } = preview
  return (
    <dialog ref={dialogRef} className="generation-preview-dialog" aria-labelledby="generation-preview-title"
      onCancel={event => { event.preventDefault(); onCancel() }}>
      <header>
        <h2 id="generation-preview-title">自動生成プレビュー</h2>
        <p>{preview.dayLabel} — この開催日の全Stageを自動生成</p>
      </header>
      <div className="generation-preview-dialog__notice">
        <p>適用すると、この開催日の出演順とPA担当を自動生成結果で置き換えます。</p>
        <p>部内休憩：{options.keepIntraSectionBreaks ? '保持' : '除外'} ／ 部間休憩：{options.keepInterSectionBreaks ? '保持' : '除外'}</p>
        <p>SectionなしStageの休憩・当日運営(Duty)・TT固定・出演条件は保持されます。</p>
        <p>PA／当日運営パネルに未保存の編集がある場合は、先に保存してから自動生成してください。</p>
      </div>
      <dl className="generation-preview-dialog__summary">
        <div><dt>配置バンド</dt><dd>{summary.bands}組</dd></div>
        <div><dt>休憩</dt><dd>{summary.breaks}件</dd></div>
        <div><dt>PA担当</dt><dd>{summary.paShifts}件</dd></div>
        <div><dt>Schedule候補評価数</dt><dd>{summary.schedulesEvaluated}</dd></div>
        <div><dt>PA plan評価数</dt><dd>{summary.paPlansEvaluated}</dd></div>
        <div><dt>生成後の問題</dt><dd>ERROR {summary.issues.ERROR} / WARNING {summary.issues.WARNING} / INFO {summary.issues.INFO}</dd></div>
      </dl>
      {preview.stageRows.map(stage => (
        <section className="generation-preview-stage" key={stage.id}>
          <h3>{stage.name}</h3>
          {stage.rows.length === 0 ? <p>出演項目はありません。</p> : (
            <ul>{stage.rows.map(row => (
              <li key={row.id}>
                <span>{row.sectionLabel}</span><time>{row.time}</time>
                <strong>{row.kind === 'break' ? `休憩：${row.name}` : row.name}</strong>
              </li>
            ))}</ul>
          )}
        </section>
      ))}
      <section className="generation-preview-stage">
        <h3>PA担当</h3>
        <ul>{preview.paRows.map(row => (
          <li key={row.id}>
            <span>{row.stage} / {row.section}</span><time>{row.time}</time>
            <strong>{row.role}：{row.member}</strong>
          </li>
        ))}</ul>
      </section>
      {preview.issues.length > 0 && (
        <section className="generation-preview-stage">
          <h3>生成後の確認事項</h3>
          <ul>{preview.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{issue.severity}：{issue.message}</li>
          ))}</ul>
        </section>
      )}
      <details>
        <summary>評価情報</summary>
        <dl className="generation-preview-dialog__summary">
          {preview.scores.map(score => <div key={score.label}><dt>{score.label}</dt><dd>{score.value}</dd></div>)}
        </dl>
      </details>
      <footer>
        <button type="button" className="secondary-button" onClick={onCancel}>キャンセル</button>
        <button type="button" className="primary-button" onClick={onApply}>この内容を適用</button>
      </footer>
    </dialog>
  )
}
