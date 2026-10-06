import { CSV_IMPORT_MAX_BYTES, type CsvImportError } from '../csv/csv'

interface CsvFileButtonProps {
  onRead: (fileName: string, text: string) => void
  onError: (fileName: string, errors: CsvImportError[]) => void
}

export function CsvFileButton({ onRead, onError }: CsvFileButtonProps) {
  return (
    <label className="secondary-button csv-file-button">
      CSV読み込み
      <input
        className="visually-hidden"
        type="file"
        accept=".csv,text/csv"
        onChange={async (event) => {
          const input = event.currentTarget
          const file = input.files?.[0]
          if (!file) return
          try {
            if (file.size > CSV_IMPORT_MAX_BYTES) {
              onError(file.name, [{ message: 'CSVファイルは5 MB以下にしてください。' }])
              return
            }
            onRead(file.name, await file.text())
          } catch {
            onError(file.name, [{ message: 'CSVファイルを読み込めませんでした。' }])
          } finally {
            input.value = ''
          }
        }}
      />
    </label>
  )
}
