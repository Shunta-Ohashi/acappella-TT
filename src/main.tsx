import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isTimetablePreShareHash } from './share/timetablePreShareRouting.ts'
import './index.css'

const root = createRoot(document.getElementById('root')!)

if (!isTimetablePreShareHash(window.location.hash)) {
  void import('./App.tsx').then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
} else {
  void Promise.all([
    import('./share/timetablePreShareCodec.ts'),
    import('./components/TimetablePreSharePage.tsx'),
    import('./components/TimetablePreShareErrorPage.tsx'),
  ]).then(([routing, sharePage, errorPage]) => {
    const route = routing.resolveTimetablePreShareRoute(window.location.hash)
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
