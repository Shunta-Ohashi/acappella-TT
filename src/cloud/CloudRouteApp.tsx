import { useEffect, useState } from 'react'
import App from '../App.tsx'
import { LiveTimetableOperatorPage } from '../components/LiveTimetableOperatorPage.tsx'
import { resolveLiveTimetableHash } from '../live/liveTimetableRouting.ts'

export function CloudRouteApp() {
  const [route, setRoute] = useState(() =>
    resolveLiveTimetableHash(window.location.hash))

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(resolveLiveTimetableHash(window.location.hash))
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  return route
    ? <LiveTimetableOperatorPage eventId={route.eventId} />
    : <App />
}

