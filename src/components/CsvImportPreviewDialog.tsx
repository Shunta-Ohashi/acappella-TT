import { useEffect, useId, useRef } from 'react'
import type { CsvImportError } from '../csv/csv'
import { formatCsvImportError } from '../csv/csv'

export interface CsvImportPreview {
  datasetName: string
  fileName: string
  rowCount?: number
  createdCount?: number
  updatedCount?: number
  eventName?: string
  draftOnly?: boolean
  errors: CsvImportError[]
}

interface CsvImportPreviewDialogProps {
  preview: CsvImportPreview
  onCancel: () => void
  onConfirm?: () => void
}

export function CsvImportPreviewDialog({
  preview,
  onCancel,
  onConfirm,
}: CsvImportPreviewDialogProps) {
  const visibleErrors = preview.errors.slice(0, 50)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const id = useId()
  const titleId = `${id}-title`

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
      className="csv-import-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <div className="csv-import-dialog__content">
        <header>
          <p>CSV読み込み</p>
          <h2 id={titleId}>{preview.datasetName}</h2>
          <span>{preview.fileName}</span>
        </header>
        {preview.errors.length > 0 ? (
          <section className="csv-import-dialog__errors" aria-label="CSVエラー">
            <p role="alert">CSVを取り込めません。内容を修正してください。</p>
            <ol>
              {visibleErrors.map((error, index) => (
                <li key={`${error.rowNumber ?? 'file'}:${error.column ?? ''}:${index}`}>
                  {formatCsvImportError(error)}
                </li>
              ))}
            </ol>
            {preview.errors.length > visibleErrors.length && (
              <p>ほか{preview.errors.length - visibleErrors.length}件のエラーがあります。</p>
            )}
          </section>
        ) : (
          <dl className="csv-import-dialog__summary">
            <div><dt>対象</dt><dd>{preview.datasetName}</dd></div>
            {preview.eventName && <div><dt>イベント</dt><dd>{preview.eventName}</dd></div>}
            <div><dt>行数</dt><dd>{preview.rowCount ?? 0}件</dd></div>
            <div><dt>追加</dt><dd>{preview.createdCount ?? 0}件</dd></div>
            <div><dt>更新</dt><dd>{preview.updatedCount ?? 0}件</dd></div>
          </dl>
        )}
        {preview.draftOnly && preview.errors.length === 0 && (
          <p className="csv-import-dialog__notice">
            取り込み後、内容を確認して「保存」してください。
          </p>
        )}
        <footer>
          <button type="button" className="secondary-button" autoFocus onClick={onCancel}>キャンセル</button>
          {preview.errors.length === 0 && onConfirm && (
            <button type="button" className="primary-button" onClick={onConfirm}>取り込む</button>
          )}
        </footer>
      </div>
    </dialog>
  )
}

