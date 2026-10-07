import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createCloudAuthRedirectUrl } from './cloudAuth.ts'
import { observeCloudAuth, reduceCloudAuthState } from './cloudAuthState.ts'
import { cloudConfig, type CloudConfig } from './cloudConfig.ts'
import type { CloudWorkspaceContextValue } from './CloudWorkspaceContext.ts'
import { CloudWorkspaceProvider } from './CloudWorkspaceProvider.tsx'
import {
  parseCloudProfile,
  parseCloudWorkspace,
  parseCloudWorkspaceMembership,
  type CloudProfile,
  type CloudWorkspaceAccess,
} from './cloudWorkspace.ts'
import {
  createSupabaseBrowserClient,
  type EnabledCloudConfig,
} from './supabaseClient.ts'
import './CloudAppGate.css'

type AccessState =
  | { kind: 'loading' }
  | { kind: 'profile-missing' }
  | { kind: 'no-workspace'; profile: CloudProfile }
  | {
      kind: 'ready'
      profile: CloudProfile
      accesses: CloudWorkspaceAccess[]
    }
  | { kind: 'error'; message: string }

const describeCloudError = (fallback: string): string => fallback

const loadCloudAccess = async (
  client: SupabaseClient,
  userId: string,
): Promise<AccessState> => {
  const profileResult = await client
    .from('profiles')
    .select('user_id, display_name')
    .eq('user_id', userId)
    .maybeSingle()
  if (profileResult.error) {
    return { kind: 'error', message: describeCloudError('プロフィールを読み込めませんでした。') }
  }
  if (!profileResult.data) return { kind: 'profile-missing' }

  const profile = parseCloudProfile(profileResult.data)
  if (!profile || profile.userId !== userId) {
    return { kind: 'error', message: 'プロフィールの形式が正しくありません。' }
  }

  const membershipResult = await client
    .from('workspace_members')
    .select('workspace_id, user_id, role')
    .eq('user_id', userId)
  if (membershipResult.error) {
    return { kind: 'error', message: describeCloudError('ワークスペース所属情報を読み込めませんでした。') }
  }

  const memberships = (membershipResult.data ?? []).map(
    parseCloudWorkspaceMembership,
  )
  if (memberships.some(membership => !membership) || memberships.some(
    membership => membership?.userId !== userId,
  )) {
    return { kind: 'error', message: 'ワークスペース所属情報の形式が正しくありません。' }
  }
  const validMemberships = memberships.filter(
    membership => membership !== undefined,
  )
  if (validMemberships.length === 0) return { kind: 'no-workspace', profile }

  const workspaceResult = await client
    .from('workspaces')
    .select('id, name')
    .in('id', validMemberships.map(membership => membership.workspaceId))
  if (workspaceResult.error) {
    return { kind: 'error', message: describeCloudError('ワークスペースを読み込めませんでした。') }
  }
  const workspaces = (workspaceResult.data ?? []).map(parseCloudWorkspace)
  if (workspaces.some(workspace => !workspace)) {
    return { kind: 'error', message: 'ワークスペース情報の形式が正しくありません。' }
  }
  const workspaceById = new Map(
    workspaces
      .filter(workspace => workspace !== undefined)
      .map(workspace => [workspace.id, workspace]),
  )
  const accesses = validMemberships.map((membership) => {
    const workspace = workspaceById.get(membership.workspaceId)
    return workspace ? { workspace, membership } : undefined
  })
  if (accesses.some(access => !access)) {
    return { kind: 'error', message: '所属先ワークスペースを確認できませんでした。' }
  }

  return {
    kind: 'ready',
    profile,
    accesses: accesses
      .filter(access => access !== undefined)
      .sort((first, second) =>
        first.workspace.name.localeCompare(second.workspace.name) ||
        first.workspace.id.localeCompare(second.workspace.id),
      ),
  }
}

function CloudGateLayout({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <main className="cloud-gate">
      <section className="cloud-gate__card" aria-labelledby="cloud-gate-title">
        <p className="cloud-gate__eyebrow">アカペラTT</p>
        <h1 id="cloud-gate-title">{title}</h1>
        {children}
      </section>
    </main>
  )
}

function CloudSignIn({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      setErrorMessage('メールアドレスを入力してください。')
      return
    }
    setSubmitting(true)
    setMessage('')
    setErrorMessage('')
    try {
      const result = await client.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: createCloudAuthRedirectUrl(window.location.href),
        },
      })
      if (result.error) {
        setErrorMessage('ログインリンクを送信できませんでした。アカウントとメールアドレスを確認してください。')
        return
      }
      setMessage('ログイン用リンクをメールへ送信しました。')
    } catch {
      setErrorMessage('ログインリンクを送信できませんでした。アカウントとメールアドレスを確認してください。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <CloudGateLayout title="ログイン">
      <p>登録済みの幹部アカウントでログインしてください。</p>
      <form className="cloud-gate__form" onSubmit={submit}>
        <label>
          メールアドレス
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? '送信中…' : 'ログインリンクを送信'}
        </button>
      </form>
      {message && <p className="cloud-gate__success" role="status">{message}</p>}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
    </CloudGateLayout>
  )
}

function CloudProfileSetup({
  client,
  user,
  onSaved,
}: {
  client: SupabaseClient
  user: User
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedName = displayName.trim()
    if (!normalizedName) {
      setErrorMessage('表示名を入力してください。')
      return
    }
    setSubmitting(true)
    setErrorMessage('')
    try {
      const result = await client.from('profiles').insert({
        user_id: user.id,
        display_name: normalizedName,
      })
      if (result.error) {
        setErrorMessage('プロフィールを保存できませんでした。')
        return
      }
      onSaved()
    } catch {
      setErrorMessage('プロフィールを保存できませんでした。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <CloudGateLayout title="プロフィール設定">
      <p>ワークスペースで表示する名前を設定してください。</p>
      <form className="cloud-gate__form" onSubmit={submit}>
        <label>
          表示名
          <input
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={event => setDisplayName(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </button>
      </form>
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      <CloudSignOutButton client={client} />
    </CloudGateLayout>
  )
}

function CloudSignOutButton({ client }: { client: SupabaseClient }) {
  const [signingOut, setSigningOut] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const signOut = async () => {
    setSigningOut(true)
    setErrorMessage('')
    try {
      const result = await client.auth.signOut()
      if (result.error) setErrorMessage('ログアウトできませんでした。')
    } catch {
      setErrorMessage('ログアウトできませんでした。')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="secondary-button"
        disabled={signingOut}
        onClick={() => void signOut()}
      >
        {signingOut ? 'ログアウト中…' : 'ログアウト'}
      </button>
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
    </>
  )
}

function EnabledCloudAppGate({
  config,
  children,
}: {
  config: EnabledCloudConfig
  children: ReactNode
}) {
  const [client] = useState(() => createSupabaseBrowserClient(config))
  const [authState, dispatchAuthChange] = useReducer(reduceCloudAuthState, {
    user: undefined,
    error: '',
    revision: 0,
  })
  const { user, error: authError, revision: authRevision } = authState
  const userId = user?.id
  const [loadedAccess, setLoadedAccess] = useState<{
    userId: string
    authRevision: number
    reloadToken: number
    value: AccessState
  }>()
  const [reloadToken, setReloadToken] = useState(0)
  const [workspaceSelection, setWorkspaceSelection] = useState<{
    authRevision: number
    workspaceId: string
  }>()

  useEffect(() => observeCloudAuth(client.auth, dispatchAuthChange), [client])

  useEffect(() => {
    if (!userId) return
    let active = true
    void loadCloudAccess(client, userId).then((result) => {
      if (active) {
        setLoadedAccess({ userId, authRevision, reloadToken, value: result })
      }
    }).catch(() => {
      if (active) {
        setLoadedAccess({
          userId,
          authRevision,
          reloadToken,
          value: {
            kind: 'error',
            message: 'プロフィールとワークスペースを読み込めませんでした。',
          },
        })
      }
    })
    return () => {
      active = false
    }
  }, [authRevision, client, reloadToken, userId])

  const access = useMemo<AccessState>(() => (
    userId &&
    loadedAccess?.userId === userId && loadedAccess.authRevision === authRevision &&
    loadedAccess.reloadToken === reloadToken
      ? loadedAccess.value
      : { kind: 'loading' }
  ), [authRevision, loadedAccess, reloadToken, userId])

  const selectedWorkspaceId = workspaceSelection?.authRevision === authRevision
    ? workspaceSelection.workspaceId
    : undefined

  const selectedAccess = access.kind === 'ready'
    ? access.accesses.find(candidate => candidate.workspace.id === selectedWorkspaceId) ??
      access.accesses[0]
    : undefined
  const contextValue = useMemo<CloudWorkspaceContextValue | undefined>(() => {
    if (!user || access.kind !== 'ready' || !selectedAccess) return undefined
    return {
      user,
      profile: access.profile,
      workspace: selectedAccess.workspace,
      membership: selectedAccess.membership,
      availableWorkspaces: access.accesses,
      selectWorkspace: workspaceId => setWorkspaceSelection({ authRevision, workspaceId }),
      signOut: async () => {
        const result = await client.auth.signOut()
        if (result.error) throw result.error
      },
      supabase: client,
    }
  }, [access, authRevision, client, selectedAccess, user])

  if (user === undefined) {
    return <CloudGateLayout title="読み込み中"><p>ログイン状態を確認しています…</p></CloudGateLayout>
  }
  if (authError) {
    return (
      <CloudGateLayout title="クラウド接続エラー">
        <p role="alert">{authError}</p>
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
          再読み込み
        </button>
      </CloudGateLayout>
    )
  }
  if (user === null) return <CloudSignIn client={client} />
  if (access.kind === 'loading') {
    return <CloudGateLayout title="読み込み中"><p>プロフィールとワークスペースを確認しています…</p></CloudGateLayout>
  }
  if (access.kind === 'error') {
    return (
      <CloudGateLayout title="クラウド接続エラー">
        <p role="alert">{access.message}</p>
        <div className="cloud-gate__actions">
          <button type="button" className="secondary-button" onClick={() => setReloadToken(token => token + 1)}>
            再試行
          </button>
          <CloudSignOutButton key={authRevision} client={client} />
        </div>
      </CloudGateLayout>
    )
  }
  if (access.kind === 'profile-missing') {
    return (
      <CloudProfileSetup
        key={authRevision}
        client={client}
        user={user}
        onSaved={() => setReloadToken(token => token + 1)}
      />
    )
  }
  if (access.kind === 'no-workspace') {
    return (
      <CloudGateLayout title="利用可能なワークスペースがありません">
        <p>{access.profile.displayName}さんのアカウントは、まだワークスペースへ追加されていません。</p>
        <div className="cloud-gate__actions">
          <button type="button" className="secondary-button" onClick={() => setReloadToken(token => token + 1)}>
            所属情報を再確認
          </button>
          <CloudSignOutButton key={authRevision} client={client} />
        </div>
      </CloudGateLayout>
    )
  }
  if (!contextValue) {
    return <CloudGateLayout title="クラウド接続エラー"><p role="alert">ワークスペースを選択できませんでした。</p></CloudGateLayout>
  }

  return <CloudWorkspaceProvider key={authRevision} value={contextValue}>{children}</CloudWorkspaceProvider>
}

export function CloudAppGate({
  children,
  config = cloudConfig,
}: {
  children: ReactNode
  config?: CloudConfig
}) {
  if (config.status === 'disabled') return children
  if (config.status === 'invalid') {
    return (
      <CloudGateLayout title="クラウド設定エラー">
        <p role="alert">{config.message}</p>
      </CloudGateLayout>
    )
  }
  return <EnabledCloudAppGate config={config}>{children}</EnabledCloudAppGate>
}
