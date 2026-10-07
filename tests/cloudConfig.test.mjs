import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCloudAuthRedirectUrl } from '../src/cloud/cloudAuth.ts'
import { resolveCloudConfig } from '../src/cloud/cloudConfig.ts'
import {
  createCloudAppBoundaryKey,
  isWorkspaceRole,
  sortCloudWorkspaceAccesses,
} from '../src/cloud/cloudWorkspace.ts'

test('Supabase envが両方未設定ならCloudをdisabledにする', () => {
  assert.deepEqual(resolveCloudConfig({}), { status: 'disabled' })
  assert.deepEqual(resolveCloudConfig({
    supabaseUrl: '  ', supabasePublishableKey: '',
  }), { status: 'disabled' })
})

test('Supabase envが両方設定済みなら正規化してCloudをenabledにする', () => {
  assert.deepEqual(resolveCloudConfig({
    supabaseUrl: ' https://project.supabase.co ',
    supabasePublishableKey: ' publishable-key ',
  }), {
    status: 'enabled',
    supabaseUrl: 'https://project.supabase.co',
    supabasePublishableKey: 'publishable-key',
  })
})

test('Supabase URLはHTTPSと開発用loopback HTTPだけを許可する', () => {
  for (const supabaseUrl of [
    'https://project.supabase.co',
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://[::1]:54321',
  ]) {
    assert.equal(resolveCloudConfig({
      supabaseUrl,
      supabasePublishableKey: 'publishable-key',
    }).status, 'enabled', supabaseUrl)
  }

  for (const supabaseUrl of [
    'http://example.com',
    'ftp://127.0.0.1/resource',
    'not-a-url',
  ]) {
    assert.equal(resolveCloudConfig({
      supabaseUrl,
      supabasePublishableKey: 'publishable-key',
    }).status, 'invalid', supabaseUrl)
  }
})

test('Supabase URLまたはkeyの片方だけならCloud設定をinvalidにする', () => {
  assert.equal(resolveCloudConfig({
    supabaseUrl: 'https://project.supabase.co',
  }).status, 'invalid')
  assert.equal(resolveCloudConfig({
    supabasePublishableKey: 'publishable-key',
  }).status, 'invalid')
  assert.equal(resolveCloudConfig({
    supabaseUrl: 'not-a-url', supabasePublishableKey: 'publishable-key',
  }).status, 'invalid')
})

test('Auth redirect URLは実行中originのrootへ戻しqueryとshare hashを除く', () => {
  assert.equal(
    createCloudAuthRedirectUrl('http://localhost:5173/events?mode=edit#share=payload'),
    'http://localhost:5173/',
  )
  assert.equal(
    createCloudAuthRedirectUrl('https://acappella.example/app?mode=edit#other'),
    'https://acappella.example/',
  )
})

test('Workspace roleはowner・editor・viewerだけを許可する', () => {
  assert.equal(isWorkspaceRole('owner'), true)
  assert.equal(isWorkspaceRole('editor'), true)
  assert.equal(isWorkspaceRole('viewer'), true)
  assert.equal(isWorkspaceRole('admin'), false)
  assert.equal(isWorkspaceRole(undefined), false)
})

const workspaceAccess = (id, name) => ({
  workspace: { id, name },
  membership: { workspaceId: id, userId: 'user-a', role: 'editor' },
})

test('Workspace accessは入力順やruntime localeに依存せずname・id順で整列する', () => {
  const firstInput = [
    workspaceAccess('workspace-c', '乙'),
    workspaceAccess('workspace-b', 'Alpha'),
    workspaceAccess('workspace-a', 'Alpha'),
  ]
  const secondInput = [...firstInput].reverse()
  const firstSnapshot = structuredClone(firstInput)

  assert.deepEqual(
    sortCloudWorkspaceAccesses(firstInput).map(candidate => candidate.workspace.id),
    ['workspace-a', 'workspace-b', 'workspace-c'],
  )
  assert.deepEqual(
    sortCloudWorkspaceAccesses(secondInput).map(candidate => candidate.workspace.id),
    ['workspace-a', 'workspace-b', 'workspace-c'],
  )
  assert.deepEqual(firstInput, firstSnapshot)
})

test('Cloud App identityはWorkspace切替では変わらずuser・auth revisionで変わる', () => {
  const current = createCloudAppBoundaryKey(3, 'user-a')
  assert.deepEqual(
    ['workspace-a', 'workspace-b'].map(() => createCloudAppBoundaryKey(3, 'user-a')),
    [current, current],
  )
  assert.notEqual(createCloudAppBoundaryKey(4, 'user-a'), current)
  assert.notEqual(createCloudAppBoundaryKey(3, 'user-b'), current)
})

test('Auth Workspace migrationはprofilesとworkspacesのupdated_atだけをUPDATE時に更新する', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/20261007_auth_workspace.sql', import.meta.url),
    'utf8',
  )

  assert.match(sql, /new\.updated_at\s*=\s*now\(\)/)
  assert.match(sql, /before update on public\.profiles/)
  assert.match(sql, /before update on public\.workspaces/)
  assert.doesNotMatch(sql, /before update on public\.workspace_members/)
  assert.doesNotMatch(sql, /new\.created_at\s*=/)
  assert.match(sql, /revoke all on function public\.set_current_updated_at\(\) from public/)
  assert.doesNotMatch(sql, /security definer/i)
})
