export const WORKSPACE_ROLES = ['owner', 'editor', 'viewer'] as const

export type WorkspaceRole = typeof WORKSPACE_ROLES[number]

export interface CloudProfile {
  userId: string
  displayName: string
}

export interface CloudWorkspace {
  id: string
  name: string
}

export interface CloudWorkspaceMembership {
  workspaceId: string
  userId: string
  role: WorkspaceRole
}

export interface CloudWorkspaceAccess {
  workspace: CloudWorkspace
  membership: CloudWorkspaceMembership
}

export interface CloudWorkspaceSelection {
  authRevision: number
  workspaceId: string
  visitRevision: number
}

export const createCloudAppBoundaryKey = (
  authRevision: number,
  userId: string,
): string => `${authRevision}:${userId}`

export const createCloudWorkspaceVisitId = (
  authRevision: number,
  userId: string,
  reloadToken: number,
  visitRevision: number,
): string => JSON.stringify([
  authRevision,
  userId,
  reloadToken,
  visitRevision,
])

export const selectCloudWorkspaceVisit = ({
  current,
  authRevision,
  currentWorkspaceId,
  nextWorkspaceId,
}: {
  current: CloudWorkspaceSelection | undefined
  authRevision: number
  currentWorkspaceId: string
  nextWorkspaceId: string
}): CloudWorkspaceSelection | undefined => {
  if (currentWorkspaceId === nextWorkspaceId) return current
  const visitRevision = current?.authRevision === authRevision
    ? current.visitRevision + 1
    : 1
  return { authRevision, workspaceId: nextWorkspaceId, visitRevision }
}

const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export const compareCloudWorkspaceAccess = (
  left: CloudWorkspaceAccess,
  right: CloudWorkspaceAccess,
): number =>
  compareStableText(left.workspace.name, right.workspace.name) ||
  compareStableText(left.workspace.id, right.workspace.id)

export const sortCloudWorkspaceAccesses = (
  accesses: readonly CloudWorkspaceAccess[],
): CloudWorkspaceAccess[] => [...accesses].sort(compareCloudWorkspaceAccess)

export const isWorkspaceRole = (value: unknown): value is WorkspaceRole =>
  typeof value === 'string' && WORKSPACE_ROLES.includes(value as WorkspaceRole)

export const canEditCloudWorkspace = (role: unknown): boolean =>
  role === 'owner' || role === 'editor'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const parseCloudProfile = (value: unknown): CloudProfile | undefined => {
  if (!isRecord(value) || !isNonEmptyString(value.user_id) ||
    !isNonEmptyString(value.display_name)) return undefined
  return { userId: value.user_id, displayName: value.display_name }
}

export const parseCloudWorkspace = (value: unknown): CloudWorkspace | undefined => {
  if (!isRecord(value) || !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name)) return undefined
  return { id: value.id, name: value.name }
}

export const parseCloudWorkspaceMembership = (
  value: unknown,
): CloudWorkspaceMembership | undefined => {
  if (!isRecord(value) || !isNonEmptyString(value.workspace_id) ||
    !isNonEmptyString(value.user_id) || !isWorkspaceRole(value.role)) return undefined
  return {
    workspaceId: value.workspace_id,
    userId: value.user_id,
    role: value.role,
  }
}
