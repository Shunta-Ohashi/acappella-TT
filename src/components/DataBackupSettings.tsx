import { useRef } from 'react'

interface DataBackupSettingsProps {
  isImporting: boolean
  onExport: () => void
  onImportFile: (file: File) => void
}

export function DataBackupSettings({
  isImporting,
  onExport,
  onImportFile,
}: DataBackupSettingsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <main className="app-placeholder-wrap">
      <section className="app-placeholder data-backup-settings" aria-labelledby="data-backup-title">
        <p className="app-placeholder__eyebrow">Acappella TT</p>
        <h1 id="data-backup-title">設定</h1>
        <h2>データのバックアップ</h2>
        <p>イベントと共通データをまとめてJSONファイルに保存・復元できます。</p>
        <div className="data-backup-settings__actions">
          <button type="button" className="secondary-button" onClick={onExport}>
            バックアップを書き出す
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={isImporting}
            onClick={() => fileInputRef.current?.click()}
          >
            {isImporting ? '読み込み中…' : 'バックアップから復元'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          aria-label="復元するJSONバックアップファイル"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) onImportFile(file)
          }}
        />
        <p className="data-backup-settings__notice">
          復元すると現在のデータは置き換わります。復元前にバックアップを書き出してください。
        </p>
      </section>
    </main>
  )
}
