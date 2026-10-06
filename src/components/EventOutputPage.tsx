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

interface OutputFeedback {
  kind: 'success' | 'error' | 'warning'
  message: string
}

const OutputFeedbackMessage = ({ feedback }: { feedback?: OutputFeedback }) => feedback ? (
  <p
    className={feedback.kind === 'error' ? 'form-error' : 'event-output-page__feedback'}
    role={feedback.kind === 'error' ? 'alert' : 'status'}
  >
    {feedback.message}
  </p>
) : null

export function EventOutputPage(props: TimetableWorkbookInput) {
  const [excelFeedback, setExcelFeedback] = useState<OutputFeedback>()
  const [shareFeedback, setShareFeedback] = useState<OutputFeedback>()
  const [isExporting, setIsExporting] = useState(false)
  const [isCreatingShare, setIsCreatingShare] = useState(false)

  const handleExport = async () => {
    const result = createTimetableWorkbookModel(props)
    if (!result.ok) {
      setExcelFeedback({ kind: 'error', message: result.message })
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
      setExcelFeedback(result.model.warnings.length > 0
        ? { kind: 'warning', message: result.model.warnings.join(' ') }
        : {
            kind: 'success',
            message: `タイムテーブル${result.model.rowCount}行をExcelへ書き出しました。`,
          })
    } catch {
      setExcelFeedback({ kind: 'error', message: 'Excelファイルを作成できませんでした。' })
    } finally {
      setIsExporting(false)
    }
  }

  const createShareUrl = async (): Promise<{
    url: string
    warnings: string[]
  } | undefined> => {
    const [{ createTimetablePreShareSnapshot }, { createTimetablePreShareUrl }] =
      await Promise.all([
        import('../share/timetablePreShare.ts'),
        import('../share/timetablePreShareCodec.ts'),
      ])
    const result = createTimetablePreShareSnapshot(props)
    if (!result.ok) {
      setShareFeedback({ kind: 'error', message: result.message })
      return undefined
    }
    const urlResult = createTimetablePreShareUrl(result.snapshot, window.location.href)
    if (!urlResult.ok) {
      setShareFeedback({ kind: 'error', message: urlResult.message })
      return undefined
    }
    return { url: urlResult.url, warnings: result.warnings }
  }

  const successFeedback = (message: string, warnings: string[]): OutputFeedback =>
    warnings.length > 0
      ? { kind: 'warning', message: `${message} ${warnings.join(' ')}` }
      : { kind: 'success', message }

  const handleOpenShare = async () => {
    const pendingWindow = window.open('about:blank', '_blank')
    if (!pendingWindow) {
      setShareFeedback({
        kind: 'error',
        message: '共有ページを開けませんでした。ポップアップの許可を確認してください。',
      })
      return
    }
    pendingWindow.opener = null
    setIsCreatingShare(true)
    try {
      const result = await createShareUrl()
      if (!result) {
        pendingWindow.close()
        return
      }
      pendingWindow.location.replace(result.url)
      setShareFeedback(successFeedback('共有ページを新しいタブで開きました。', result.warnings))
    } catch {
      pendingWindow.close()
      setShareFeedback({ kind: 'error', message: '共有ページを作成できませんでした。' })
    } finally {
      setIsCreatingShare(false)
    }
  }

  const handleCopyShare = async () => {
    setIsCreatingShare(true)
    try {
      const result = await createShareUrl()
      if (!result) return
      await navigator.clipboard.writeText(result.url)
      setShareFeedback(successFeedback('共有リンクをコピーしました。', result.warnings))
    } catch {
      setShareFeedback({ kind: 'error', message: '共有リンクをコピーできませんでした。' })
    } finally {
      setIsCreatingShare(false)
    }
  }

  return (
    <div className="event-output-sections">
      <section className="event-output-page" aria-labelledby="event-output-excel-title">
        <div className="event-output-page__content">
          <h3 id="event-output-excel-title">タイムテーブルExcel</h3>
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
        <OutputFeedbackMessage feedback={excelFeedback} />
      </section>

      <section className="event-output-page" aria-labelledby="event-output-share-title">
        <div className="event-output-page__content">
          <h3 id="event-output-share-title">事前共有タイムテーブル</h3>
          <p>演者・運営向けに、出演時刻・メンバー・PA・当日運営担当を確認できる閲覧専用ページを共有します。</p>
          <p className="event-output-page__notice">
            共有リンクは作成時点のタイムテーブルです。その後の編集内容は自動反映されません。
          </p>
          <p className="event-output-page__privacy">
            共有リンクには、タイムテーブル上に表示されるバンド名、メンバー名、Main / Sub PA、当日運営担当が含まれます。リンクを知っている人は内容を閲覧できます。
          </p>
        </div>
        <div className="event-output-page__actions">
          <button
            type="button"
            className="primary-button"
            onClick={handleOpenShare}
            disabled={isCreatingShare}
          >
            共有ページを開く
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleCopyShare}
            disabled={isCreatingShare}
          >
            共有リンクをコピー
          </button>
        </div>
        <OutputFeedbackMessage feedback={shareFeedback} />
      </section>
    </div>
  )
}
