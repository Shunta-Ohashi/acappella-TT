import { useEffect, useState } from 'react'
import App from '../App.tsx'
import { LiveTimetableOperatorPage } from '../components/LiveTimetableOperatorPage.tsx'
import {
  createLiveTimetableRouteInstanceKey,
  createRetainedEditorAccountGuardRegistry,
  resolveLiveTimetableHash,
  shouldKeepCloudEditorMounted,
} from '../live/liveTimetableRouting.ts'
import { useOptionalCloudWorkspace } from './useCloudWorkspace.ts'
import { NativeDialogActivityProvider } from '../ui/NativeDialogActivityProvider.tsx'

export function CloudRouteApp() {
  const [route, setRoute] = useState(() =>
    resolveLiveTimetableHash(window.location.hash))
  const [editorMounted, setEditorMounted] = useState(() => route === undefined)
  const [retainedEditorAccountGuards] = useState(
    createRetainedEditorAccountGuardRegistry,
  )
  const cloud = useOptionalCloudWorkspace()
  const accountScopeKey = cloud
    ? JSON.stringify([
        cloud.user.id,
        cloud.workspace.id,
        cloud.workspaceVisitId,
      ])
    : ''

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
          <NativeDialogActivityProvider active={route === undefined}>
            <App
              key={cloud?.workspaceVisitId}
              isActive={route === undefined}
              registerRetainedEditorAccountGuard={
                retainedEditorAccountGuards.register
              }
            />
          </NativeDialogActivityProvider>
        </div>
      )}
      {route && (
        <LiveTimetableOperatorPage
          key={createLiveTimetableRouteInstanceKey(
            accountScopeKey,
            route.eventId,
          )}
          eventId={route.eventId}
          onBeforeAccountAction={action =>
            retainedEditorAccountGuards.canRun({
              required: editorMounted,
              scopeKey: accountScopeKey,
              action,
            })}
        />
      )}
    </>
  )
}

