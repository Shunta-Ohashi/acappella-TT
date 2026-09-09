import type { ReactNode } from 'react'

export type AppSection = 'events' | 'shared-data' | 'settings'

interface AppShellProps {
  activeSection: AppSection
  onNavigate: (section: AppSection) => void
  children: ReactNode
}

const navigationItems: Array<{ id: AppSection; label: string }> = [
  { id: 'events', label: 'イベント' },
  { id: 'shared-data', label: '共通データ' },
  { id: 'settings', label: '設定' },
]

export function AppShell({
  activeSection,
  onNavigate,
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
