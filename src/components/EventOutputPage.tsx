import { useState } from 'react'
import {
  createTimetableWorkbookModel,
  createTimetableWorkbookFilename,
  type TimetableWorkbookInput,
} from '../export/timetableWorkbook'
import {
  createTimetableWorkbookXlsx,
  TIMETABLE_WORKBOOK_MIME,
} from '../export/excelWorkbook'
import { downloadBinaryFile } from '../export/fileDownload'

export function EventOutputPage(props: TimetableWorkbookInput) {
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error' | 'warning'
    message: string
  }>()
  const [isExporting, setIsExporting] = useState(false)

  const handleExport = async () => {
    const result = createTimetableWorkbookModel(props)
    if (!result.ok) {
      setFeedback({ kind: 'error', message: result.message })
      return
    }
    setIsExporting(true)
    try {
      const content = await createTimetableWorkbookXlsx(result.model)
      downloadBinaryFile(
        content,
        createTimetableWorkbookFilename(props.event),
        TIMETABLE_WORKBOOK_MIME,
      )
      setFeedback(result.model.warnings.length > 0
        ? { kind: 'warning', message: result.model.warnings.join(' ') }
        : {
            kind: 'success',
            message: `タイムテーブル${result.model.rowCount}行をExcelへ書き出しました。`,
          })
    } catch {
      setFeedback({ kind: 'error', message: 'Excelファイルを作成できませんでした。' })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <section className="event-output-page" aria-labelledby="event-output-title">
      <div>
        <h3 id="event-output-title">タイムテーブルExcel</h3>
        <p>イベント全体を1つのExcelファイルとして書き出します。開催日・Stageごとにシートが分かれます。</p>
        <p>Excel出力は書き出し専用です。アプリ全体の復元にはJSONバックアップを利用してください。</p>
      </div>
      <button
        type="button"
        className="primary-button"
        onClick={handleExport}
        disabled={isExporting}
      >
        {isExporting ? 'Excelを作成中…' : 'Excelを書き出す（.xlsx）'}
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
