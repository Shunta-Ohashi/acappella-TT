import assert from 'node:assert/strict'
import test from 'node:test'

import { createCloudAuthRedirectUrl } from '../src/cloud/cloudAuth.ts'
import { resolveCloudConfig } from '../src/cloud/cloudConfig.ts'
import { isWorkspaceRole } from '../src/cloud/cloudWorkspace.ts'

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
