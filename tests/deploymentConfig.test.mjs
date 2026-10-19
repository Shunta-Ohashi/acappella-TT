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

test('packageとGitHub ActionsはNode.js 24を明示する', async () => {
  const packageConfiguration = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(packageConfiguration.engines?.node, '24.x')

  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /^\s*node-version:\s*24\s*$/mu)
})

test('local buildはCloud flag未設定またはfalseでlocal-onlyを維持する', () => {
  assert.deepEqual(validateCloudDeploymentEnvironment({}), { cloudRequired: false })
  assert.deepEqual(validateCloudDeploymentEnvironment({
    VITE_CLOUD_REQUIRED: 'false',
  }), { cloudRequired: false })
  assert.throws(() => validateCloudDeploymentEnvironment({
    VITE_CLOUD_REQUIRED: 'unexpected',
  }), /must be true or false/u)
})

test('Vercel buildは明示Cloud設定と両方の公開値を必須にする', () => {
  assert.deepEqual(validateCloudDeploymentEnvironment(validCloudEnvironment), {
    cloudRequired: true,
  })
  for (const environment of [
    { VERCEL: '1' },
    { ...validCloudEnvironment, VITE_CLOUD_REQUIRED: 'false' },
    { ...validCloudEnvironment, VITE_CLOUD_REQUIRED: 'unexpected' },
    { ...validCloudEnvironment, VITE_SUPABASE_URL: '' },
    { ...validCloudEnvironment, VITE_SUPABASE_PUBLISHABLE_KEY: '' },
  ]) {
    assert.throws(() => validateCloudDeploymentEnvironment(environment))
  }
})

test('Vercel設定の明示flagはsystem env公開設定に依存せずCloudを必須にする', () => {
  assert.throws(() => validateCloudDeploymentEnvironment({}, { forceCloud: true }))
  assert.throws(() => validateCloudDeploymentEnvironment({
    ...validCloudEnvironment,
    VERCEL: undefined,
    VITE_CLOUD_REQUIRED: 'false',
  }, { forceCloud: true }))
  assert.deepEqual(validateCloudDeploymentEnvironment({
    ...validCloudEnvironment,
    VERCEL: undefined,
  }, { forceCloud: true }), { cloudRequired: true })
})

test('公開Cloud URLはremote HTTPS originだけを許可する', () => {
  for (const VITE_SUPABASE_URL of [
    'http://project.supabase.co',
    'https://localhost',
    'https://localhost.',
    'https://subdomain.localhost.',
    'https://127.0.0.1',
    'https://127.10.20.30',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://[::ffff:7fff:ffff]',
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

test('CLIはlocal falseを許可しpublicまたはforceCloudのfalseを拒否する', () => {
  const script = 'scripts/validateCloudDeployment.mjs'
  const local = spawnSync(process.execPath, [script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { VITE_CLOUD_REQUIRED: 'false' },
  })
  assert.equal(local.status, 0)

  const publicBuild = spawnSync(process.execPath, [script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      VERCEL: '1',
      VITE_CLOUD_REQUIRED: 'false',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    },
  })
  assert.equal(publicBuild.status, 1)
  assert.match(publicBuild.stderr, /requires VITE_CLOUD_REQUIRED=true/u)

  const forced = spawnSync(process.execPath, [script, '--require-cloud'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      VITE_CLOUD_REQUIRED: 'false',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    },
  })
  assert.equal(forced.status, 1)
  assert.match(forced.stderr, /requires VITE_CLOUD_REQUIRED=true/u)

  const validForced = spawnSync(process.execPath, [script, '--require-cloud'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      VITE_CLOUD_REQUIRED: 'true',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    },
  })
  assert.equal(validForced.status, 0)
  assert.match(validForced.stdout, /Cloud deployment environment: OK/u)
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
