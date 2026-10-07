import type { SupabaseClient, User } from '@supabase/supabase-js'

export interface CloudAuthChange {
  user: User | null
  error: string
}

export interface CloudAuthState {
  user: User | null | undefined
  error: string
  revision: number
}

export const reduceCloudAuthState = (
  previous: CloudAuthState,
  change: CloudAuthChange,
): CloudAuthState => ({
  ...change,
  // Refreshing the same account must not refetch access and tear down drafts.
  // Signing out and back in must invalidate access, even for the same user ID.
  revision: previous.revision + (previous.user?.id !== change.user?.id ? 1 : 0),
})

export const observeCloudAuth = (
  auth: Pick<SupabaseClient['auth'], 'getSession' | 'onAuthStateChange'>,
  onChange: (change: CloudAuthChange) => void,
): (() => void) => {
  let active = true
  let receivedAuthEvent = false
  const { data: { subscription } } = auth.onAuthStateChange((_event, session) => {
    if (!active) return
    receivedAuthEvent = true
    onChange({ user: session?.user ?? null, error: '' })
  })

  void (async () => {
    try {
      const { data, error } = await auth.getSession()
      // A newer auth event is authoritative over this initial snapshot.
      if (!active || receivedAuthEvent) return
      onChange({
        user: error ? null : data.session?.user ?? null,
        error: error ? 'ログイン状態を確認できませんでした。' : '',
      })
    } catch {
      if (active && !receivedAuthEvent) {
        onChange({ user: null, error: 'ログイン状態を確認できませんでした。' })
      }
    }
  })()

  return () => {
    active = false
    subscription.unsubscribe()
  }
}
