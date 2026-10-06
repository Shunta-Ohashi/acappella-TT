import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CsvImportHelpContent } from '../csv/csvHelp'

interface CsvImportHelpPopoverProps {
  content: CsvImportHelpContent
}

function ColumnTable({ columns }: { columns: CsvImportHelpContent['columns'] }) {
  return (
    <div className="csv-import-help__table-wrap">
      <table>
        <thead><tr><th scope="col">列</th><th scope="col">内容</th></tr></thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.name}>
              <th scope="row">{column.name}</th>
              <td>{column.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CsvImportHelpPopover({ content }: CsvImportHelpPopoverProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const generatedId = useId()
  const popoverId = `csv-import-help-${generatedId}`
  const titleId = `${popoverId}-title`

  const close = useCallback(() => {
    setIsOpen(false)
    setIsPinned(false)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, isOpen])

  return (
    <div
      ref={rootRef}
      className="csv-import-help"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => {
        if (!isPinned && !rootRef.current?.contains(document.activeElement)) {
          setIsOpen(false)
        }
      }}
      onFocusCapture={() => setIsOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close()
      }}
    >
      <button
        type="button"
        className="csv-import-help__button"
        aria-label={`${content.title}の形式を確認`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        onClick={() => {
          if (isOpen && isPinned) {
            close()
          } else {
            setIsOpen(true)
            setIsPinned(true)
          }
        }}
      >
        <span aria-hidden="true">?</span>
      </button>

      {isOpen && (
        <div className="csv-import-help__popover-hit-area">
          <section
            id={popoverId}
            className="csv-import-help__popover"
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
          >
            <header>
              <h3 id={titleId}>{content.title}</h3>
              <p>{content.description}</p>
            </header>
            <ColumnTable columns={content.columns} />
            <div className="csv-import-help__example">
              <strong>CSV例</strong>
              <pre>{content.example}</pre>
            </div>
            <ul>
              {content.notes.map((note) => <li key={note}>{note}</li>)}
              <li>現在のデータをCSV書き出しすると、そのまま編集用テンプレートとして利用できます。データがなくても入力用のheaderを取得できます。</li>
            </ul>
            {content.technicalColumns.length > 0 && (
              <div className="csv-import-help__technical">
                <h4>詳細設定 / ID列</h4>
                <p>ID列は通常入力・編集不要です。書き出したCSVを正確に再読み込みするときに使用します。</p>
                <ColumnTable columns={content.technicalColumns} />
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
