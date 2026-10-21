import { useEffect, useState } from 'react'
import App from '../App.tsx'
import { LiveTimetableOperatorPage } from '../components/LiveTimetableOperatorPage.tsx'
import {
  resolveLiveTimetableHash,
  shouldKeepCloudEditorMounted,
} from '../live/liveTimetableRouting.ts'
import { useOptionalCloudWorkspace } from './useCloudWorkspace.ts'

export function CloudRouteApp() {
  const [route, setRoute] = useState(() =>
    resolveLiveTimetableHash(window.location.hash))
  const [editorMounted, setEditorMounted] = useState(() => route === undefined)
  const cloud = useOptionalCloudWorkspace()

  useEffect(() => {
    const handleHashChange = () => {
      const nextRoute = resolveLiveTimetableHash(window.location.hash)
      setRoute(nextRoute)
      setEditorMounted(current => shouldKeepCloudEditorMounted(
        current,
        nextRoute,
      ))
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  return (
    <>
      {editorMounted && (
        <div
          hidden={route !== undefined}
          inert={route !== undefined}
          aria-hidden={route !== undefined}
        >
          <App
            key={cloud?.workspaceVisitId}
            isActive={route === undefined}
          />
        </div>
      )}
      {route && <LiveTimetableOperatorPage eventId={route.eventId} />}
    </>
  )
}

