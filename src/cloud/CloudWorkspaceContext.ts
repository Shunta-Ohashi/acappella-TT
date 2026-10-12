import { createContext } from 'react'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import type {
  CloudProfile,
  CloudWorkspace,
  CloudWorkspaceAccess,
  CloudWorkspaceMembership,
} from './cloudWorkspace.ts'

export interface CloudWorkspaceContextValue {
  user: User
  profile: CloudProfile
  workspace: CloudWorkspace
  membership: CloudWorkspaceMembership
  availableWorkspaces: CloudWorkspaceAccess[]
  workspaceVisitId: string
  selectWorkspace: (workspaceId: string) => void
  signOut: () => Promise<void>
  supabase: SupabaseClient
}

export const CloudWorkspaceContext = createContext<CloudWorkspaceContextValue | null>(null)
