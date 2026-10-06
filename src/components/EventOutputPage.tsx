import { useState } from 'react'
import { downloadCsv } from '../csv/csvBrowser'
import {
  createTimetableCsv,
  createTimetableCsvFilename,
  type TimetableCsvInput,
} from '../csv/timetableCsv'

export function EventOutputPage(props: TimetableCsvInput) {
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error' | 'warning'
    message: string
  }>()

  const handleExport = () => {
    const result = createTimetableCsv(props)
    if (!result.ok) {
      setFeedback({ kind: 'error', message: result.message })
      return
    }
    downloadCsv(result.csv, createTimetableCsvFilename(props.event))
    setFeedback(result.warnings.length > 0
      ? { kind: 'warning', message: result.warnings.join(' ') }
      : { kind: 'success', message: `タイムテーブル${result.rowCount}行を書き出しました。` })
  }

  return (
    <section className="event-output-page" aria-labelledby="event-output-title">
      <div>
        <h3 id="event-output-title">タイムテーブルCSV</h3>
        <p>全開催日・全Stageの出演、休憩、PA、当日運営、Issue件数を書き出します。</p>
        <p>タイムテーブルCSVは書き出し専用です。アプリ全体の復元にはJSONバックアップを利用してください。</p>
      </div>
      <button type="button" className="primary-button" onClick={handleExport}>
        タイムテーブルCSVを書き出す
      </button>
      {feedback && (
        <p
          className={feedback.kind === 'error' ? 'form-error' : 'event-output-page__feedback'}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      )}
    </section>
  )
}
