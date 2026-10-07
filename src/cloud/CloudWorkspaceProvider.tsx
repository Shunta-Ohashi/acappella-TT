import type { ReactNode } from 'react'
import {
  CloudWorkspaceContext,
  type CloudWorkspaceContextValue,
} from './CloudWorkspaceContext.ts'

export function CloudWorkspaceProvider({
  value,
  children,
}: {
  value: CloudWorkspaceContextValue
  children: ReactNode
}) {
  return (
    <CloudWorkspaceContext.Provider value={value}>
      {children}
    </CloudWorkspaceContext.Provider>
  )
}
