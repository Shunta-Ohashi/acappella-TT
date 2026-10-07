import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isTimetablePreShareHash } from './share/timetablePreShareRouting.ts'
import './index.css'

const root = createRoot(document.getElementById('root')!)

if (!isTimetablePreShareHash(window.location.hash)) {
  void Promise.all([
    import('./App.tsx'),
    import('./cloud/CloudAppGate.tsx'),
  ]).then(([app, cloud]) => {
    const App = app.default
    root.render(
      <StrictMode>
        <cloud.CloudAppGate>
          <App />
        </cloud.CloudAppGate>
      </StrictMode>,
    )
  }).catch(() => {
    root.render(
      <main role="alert">
        <h1>アプリを起動できませんでした</h1>
        <p>設定または通信状態を確認して、ページを再読み込みしてください。</p>
      </main>,
    )
  })
} else {
  void Promise.all([
    import('./share/timetablePreShareCodec.ts'),
    import('./components/TimetablePreSharePage.tsx'),
    import('./components/TimetablePreShareErrorPage.tsx'),
  ]).then(([routing, sharePage, errorPage]) => {
    const route = routing.resolveTimetablePreShareRoute(
      window.location.hash,
      window.location.href.length,
    )
    root.render(
      <StrictMode>
        {route.kind === 'share'
          ? <sharePage.TimetablePreSharePage snapshot={route.snapshot} />
          : <errorPage.TimetablePreShareErrorPage />}
      </StrictMode>,
    )
  }).catch(() => {
    root.render(
      <main role="alert">
        <h1>共有リンクを開けませんでした</h1>
        <p>このリンクが壊れているか、対応していない形式の可能性があります。</p>
      </main>,
    )
  })
}
