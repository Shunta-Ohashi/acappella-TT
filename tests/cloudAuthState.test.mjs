import assert from 'node:assert/strict'
import test from 'node:test'
import {
  observeCloudAuth,
  reduceCloudAuthState,
} from '../src/cloud/cloudAuthState.ts'
import { createSupabaseBrowserClient } from '../src/cloud/supabaseClient.ts'

const createAuthMock = () => {
  let resolveSession
  let rejectSession
  let listener
  let unsubscribed = false
  const sessionResult = new Promise((resolve, reject) => {
    resolveSession = resolve
    rejectSession = reject
  })
  return {
    auth: {
      getSession: () => sessionResult,
      onAuthStateChange: callback => {
        listener = callback
        return { data: { subscription: { unsubscribe: () => { unsubscribed = true } } } }
      },
    },
    emit: (user, event = 'SIGNED_IN') => listener(event, user ? { user } : null),
    resolve: (user, error = null) => resolveSession({ data: { session: user ? { user } : null }, error }),
    reject: () => rejectSession(new Error('network failure')),
    isUnsubscribed: () => unsubscribed,
  }
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }

test('初期session取得が遅れても、後発のログアウト・ユーザー切替を上書きしない', async () => {
  for (const currentUser of [null, { id: 'user-b' }]) {
    const mock = createAuthMock()
    const updates = []
    const stop = observeCloudAuth(mock.auth, change => updates.push(change))
    mock.emit(currentUser)
    mock.resolve({ id: 'user-a' })
    await flush()
    assert.deepEqual(updates, [{ user: currentUser, error: '' }])
    stop()
  }
})

test('初期session取得の失敗Resultとrejectを画面向けエラーへ変換する', async () => {
  for (const rejected of [false, true]) {
    const mock = createAuthMock()
    const updates = []
    const stop = observeCloudAuth(mock.auth, change => updates.push(change))
    if (rejected) mock.reject()
    else mock.resolve(null, new Error('session failure'))
    await flush()
    assert.equal(updates.length, 1)
    assert.equal(updates[0].user, null)
    assert.equal(updates[0].error, 'ログイン状態を確認できませんでした。')
    stop()
  }
})

test('cleanup後は遅延結果や認証通知を反映せずsubscriptionを解除する', async () => {
  const mock = createAuthMock()
  const updates = []
  const stop = observeCloudAuth(mock.auth, change => updates.push(change))
  stop()
  mock.emit({ id: 'user-b' })
  mock.resolve({ id: 'user-a' })
  await flush()
  assert.equal(mock.isUnsubscribed(), true)
  assert.deepEqual(updates, [])
})

test('新しい認証通知が来た後の初期取得rejectで有効sessionをエラーにしない', async () => {
  const mock = createAuthMock()
  const updates = []
  const stop = observeCloudAuth(mock.auth, change => updates.push(change))
  mock.emit({ id: 'user-b' })
  mock.reject()
  await flush()
  assert.deepEqual(updates, [{ user: { id: 'user-b' }, error: '' }])
  stop()
})

test('通常の初期session取得はsigned-inとsigned-outの両方を通知する', async () => {
  for (const user of [null, { id: 'user-a' }]) {
    const mock = createAuthMock()
    const updates = []
    const stop = observeCloudAuth(mock.auth, change => updates.push(change))
    mock.resolve(user)
    await flush()
    assert.deepEqual(updates, [{ user, error: '' }])
    stop()
  }
})

test('同じユーザーの認証再通知では所属取得キーを維持しuser情報だけ更新する', () => {
  const initial = { user: undefined, error: '', revision: 0 }
  const signedIn = reduceCloudAuthState(initial, { user: { id: 'user-a' }, error: '' })
  const refreshedUser = { id: 'user-a', email: 'updated@example.com' }
  const refreshed = reduceCloudAuthState(signedIn, { user: refreshedUser, error: '' })
  assert.equal(refreshed.revision, signedIn.revision)
  assert.deepEqual(refreshed.user, refreshedUser)
  assert.deepEqual(initial, { user: undefined, error: '', revision: 0 })
})

test('ログアウト後の同じユーザーの再ログインも古い所属取得キーを再利用しない', () => {
  const initial = { user: undefined, error: '', revision: 0 }
  const signedIn = reduceCloudAuthState(initial, { user: { id: 'user-a' }, error: '' })
  const signedOut = reduceCloudAuthState(signedIn, { user: null, error: '' })
  const signedInAgain = reduceCloudAuthState(signedOut, { user: { id: 'user-a' }, error: '' })
  assert.notEqual(signedInAgain.revision, signedIn.revision)
  const switchedUser = reduceCloudAuthState(signedInAgain, { user: { id: 'user-b' }, error: '' })
  assert.notEqual(switchedUser.revision, signedInAgain.revision)
})

test('同じ設定でinitializerを複数回呼んでもSupabase clientを重複生成しない', async () => {
  const config = {
    status: 'enabled',
    supabaseUrl: 'https://test.supabase.co',
    supabasePublishableKey: 'test-publishable-key',
  }
  const original = structuredClone(config)
  const first = createSupabaseBrowserClient(config)
  try {
    assert.equal(createSupabaseBrowserClient({ ...config }), first)
    assert.deepEqual(config, original)
  } finally {
    await first.auth.dispose()
  }
})
