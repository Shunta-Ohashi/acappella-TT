import { useContext } from 'react'
import { CloudWorkspaceContext } from './CloudWorkspaceContext.ts'

export const useOptionalCloudWorkspace = () => useContext(CloudWorkspaceContext)
