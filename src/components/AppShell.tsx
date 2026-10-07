import { useState, type ReactNode } from 'react'
import { useOptionalCloudWorkspace } from '../cloud/useCloudWorkspace.ts'

export type AppSection = 'events' | 'shared-data' | 'settings'

interface AppShellProps {
  activeSection: AppSection
  onNavigate: (section: AppSection) => void
  onBeforeSignOut?: () => boolean
  onBeforeWorkspaceChange?: () => boolean
  children: ReactNode
}

const navigationItems: Array<{ id: AppSection; label: string }> = [
  { id: 'events', label: 'イベント' },
  { id: 'shared-data', label: '共通データ' },
  { id: 'settings', label: '設定' },
]

function CloudAccountControls({
  onBeforeSignOut,
  onBeforeWorkspaceChange,
}: {
  onBeforeSignOut?: () => boolean
  onBeforeWorkspaceChange?: () => boolean
}) {
  const cloud = useOptionalCloudWorkspace()
  const [signOutError, setSignOutError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  if (!cloud) return null

  const signOut = async () => {
    setSignOutError('')
    if (onBeforeSignOut && !onBeforeSignOut()) return
    setSigningOut(true)
    try {
      await cloud.signOut()
    } catch {
      setSignOutError('ログアウトできませんでした。')
    } finally {
      setSigningOut(false)
    }
  }

  const selectWorkspace = (workspaceId: string) => {
    if (workspaceId === cloud.workspace.id) return
    if (onBeforeWorkspaceChange && !onBeforeWorkspaceChange()) return
    cloud.selectWorkspace(workspaceId)
  }

  return (
    <div className="top-navigation__cloud-account">
      {cloud.availableWorkspaces.length > 1 ? (
        <select
          aria-label="ワークスペース"
          value={cloud.workspace.id}
          onChange={event => selectWorkspace(event.target.value)}
        >
          {cloud.availableWorkspaces.map(access => (
            <option key={access.workspace.id} value={access.workspace.id}>
              {access.workspace.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="top-navigation__workspace-name">{cloud.workspace.name}</span>
      )}
      <span className="top-navigation__profile-name">{cloud.profile.displayName}</span>
      <button type="button" disabled={signingOut} onClick={() => void signOut()}>
        {signingOut ? 'ログアウト中…' : 'ログアウト'}
      </button>
      {signOutError && <span className="top-navigation__cloud-error" role="alert">{signOutError}</span>}
    </div>
  )
}

export function AppShell({
  activeSection,
  onNavigate,
  onBeforeSignOut,
  onBeforeWorkspaceChange,
  children,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="top-navigation">
        <div className="top-navigation__inner">
          <button
            type="button"
            className="top-navigation__brand"
            onClick={() => onNavigate('events')}
          >
            Acappella TT
          </button>

          <div className="top-navigation__right">
            <nav className="top-navigation__links" aria-label="メインナビゲーション">
              {navigationItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === activeSection
                    ? 'top-navigation__link top-navigation__link--active'
                    : 'top-navigation__link'}
                  aria-current={item.id === activeSection ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <CloudAccountControls
              onBeforeSignOut={onBeforeSignOut}
              onBeforeWorkspaceChange={onBeforeWorkspaceChange}
            />
          </div>
        </div>
      </header>

      {children}
    </div>
  )
}

interface AppSectionPlaceholderProps {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}

export function AppSectionPlaceholder({
  title,
  description,
  actionLabel,
  onAction,
}: AppSectionPlaceholderProps) {
  return (
    <main className="app-placeholder-wrap">
      <section className="app-placeholder" aria-labelledby="app-placeholder-title">
        <p className="app-placeholder__eyebrow">Acappella TT</p>
        <h1 id="app-placeholder-title">{title}</h1>
        <p>{description}</p>
        {actionLabel && onAction && (
          <button type="button" className="secondary-button" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </section>
    </main>
  )
}
