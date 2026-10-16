import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  validateCloudDeploymentEnvironment,
} from '../scripts/validateCloudDeployment.mjs'

const validCloudEnvironment = {
  VERCEL: '1',
  VITE_CLOUD_REQUIRED: 'true',
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
}

test('local buildはCloud envなしでlocal-onlyを維持する', () => {
  assert.deepEqual(validateCloudDeploymentEnvironment({}), { cloudRequired: false })
})

test('Vercel buildは明示Cloud設定と両方の公開値を必須にする', () => {
  assert.deepEqual(validateCloudDeploymentEnvironment(validCloudEnvironment), {
    cloudRequired: true,
  })
  for (const environment of [
    { VERCEL: '1' },
    { ...validCloudEnvironment, VITE_CLOUD_REQUIRED: 'false' },
    { ...validCloudEnvironment, VITE_SUPABASE_URL: '' },
    { ...validCloudEnvironment, VITE_SUPABASE_PUBLISHABLE_KEY: '' },
  ]) {
    assert.throws(() => validateCloudDeploymentEnvironment(environment))
  }
})

test('Vercel設定の明示flagはsystem env公開設定に依存せずCloudを必須にする', () => {
  assert.throws(() => validateCloudDeploymentEnvironment({}, { forceCloud: true }))
  assert.deepEqual(validateCloudDeploymentEnvironment({
    ...validCloudEnvironment,
    VERCEL: undefined,
  }, { forceCloud: true }), { cloudRequired: true })
})

test('公開Cloud URLはremote HTTPS originだけを許可する', () => {
  for (const VITE_SUPABASE_URL of [
    'http://project.supabase.co',
    'https://localhost',
    'https://127.0.0.1',
    'https://127.10.20.30',
    'https://user:password@project.supabase.co',
    'https://project.supabase.co/rest/v1',
    'https://project.supabase.co?override=true',
    'https://project.supabase.co#fragment',
  ]) {
    assert.throws(() => validateCloudDeploymentEnvironment({
      ...validCloudEnvironment,
      VITE_SUPABASE_URL,
    }), undefined, VITE_SUPABASE_URL)
  }
})

test('公開buildはserver keyを拒否する', () => {
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')
  for (const VITE_SUPABASE_PUBLISHABLE_KEY of [
    'sb_secret_example',
    `header.${payload}.signature`,
  ]) {
    assert.throws(() => validateCloudDeploymentEnvironment({
      ...validCloudEnvironment,
      VITE_SUPABASE_PUBLISHABLE_KEY,
    }))
  }
})

test('不正な公開URLを拒否しても入力値をstderrへ漏らさない', () => {
  const secret = 'do-not-print-this-password'
  const result = spawnSync(process.execPath, ['scripts/validateCloudDeployment.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      VERCEL: '1',
      VITE_CLOUD_REQUIRED: 'true',
      VITE_SUPABASE_URL: `not-a-url-${secret}`,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    },
  })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, new RegExp(secret))
  assert.match(result.stderr, /invalid Supabase URL/u)
})

test('Vercel設定はVite build・frozen pnpm install・dist出力だけを定義する', async () => {
  const configuration = JSON.parse(await readFile(
    new URL('../vercel.json', import.meta.url),
    'utf8',
  ))
  assert.deepEqual(configuration, {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: 'vite',
    installCommand: 'pnpm install --frozen-lockfile',
    buildCommand: 'node scripts/validateCloudDeployment.mjs --require-cloud && pnpm build',
    outputDirectory: 'dist',
  })
})
