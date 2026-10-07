import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAppStartupMode } from '../src/appStartup.ts'

test('Share routeはCloud設定にかかわらず公開Shareとして起動する', () => {
  assert.equal(resolveAppStartupMode({
    isShare: true,
    cloudStatus: 'disabled',
  }), 'share')
  assert.equal(resolveAppStartupMode({
    isShare: true,
    cloudStatus: 'enabled',
  }), 'share')
})

test('通常routeはCloud設定状態ごとの起動境界を選ぶ', () => {
  assert.equal(resolveAppStartupMode({
    isShare: false,
    cloudStatus: 'disabled',
  }), 'local')
  assert.equal(resolveAppStartupMode({
    isShare: false,
    cloudStatus: 'invalid',
  }), 'cloud-invalid')
  assert.equal(resolveAppStartupMode({
    isShare: false,
    cloudStatus: 'enabled',
  }), 'cloud-enabled')
})
