import { createNormalAppUrl } from '../share/timetablePreShareCodec.ts'
import './TimetablePreSharePage.css'

export function TimetablePreShareErrorPage() {
  const openNormalApp = () => {
    window.location.assign(createNormalAppUrl(window.location.href))
  }

  return (
    <main className="pre-share-error">
      <p>事前共有タイムテーブル</p>
      <h1>共有リンクを開けませんでした</h1>
      <p>このリンクが壊れているか、対応していない形式の可能性があります。</p>
      <button type="button" onClick={openNormalApp}>通常画面を開く</button>
    </main>
  )
}
