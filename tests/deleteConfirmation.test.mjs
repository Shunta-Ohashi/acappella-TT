import test from 'node:test'
import assert from 'node:assert/strict'

import { getDeleteConfirmationCopy } from '../src/ui/deleteConfirmation.ts'

test('開催日の削除確認に対象日と保存前の変更であることを示す', () => {
  const copy = getDeleteConfirmationCopy('event-day', '2026-10-03')

  assert.equal(copy.title, '開催日を削除しますか？')
  assert.match(copy.description, /2026-10-03/)
  assert.match(copy.description, /保存すると変更が反映されます/)
})

test('StageとSectionの削除確認に対象名を示す', () => {
  const stageCopy = getDeleteConfirmationCopy('stage', 'Main Stage')
  const sectionCopy = getDeleteConfirmationCopy('section', '第1部')

  assert.match(stageCopy.title, /Main Stage/)
  assert.match(stageCopy.description, /Stage設定を一覧から削除/)
  assert.match(sectionCopy.title, /第1部/)
  assert.match(sectionCopy.description, /Section設定を一覧から削除/)
})

test('参加メンバーと出演バンドの削除確認に対象名を示す', () => {
  const memberCopy = getDeleteConfirmationCopy('event-member', '山田 花子')
  const bandCopy = getDeleteConfirmationCopy('event-band', 'Choir')

  assert.match(memberCopy.description, /山田 花子/)
  assert.match(memberCopy.description, /参加メンバーから削除/)
  assert.match(bandCopy.description, /Choir/)
  assert.match(bandCopy.description, /出演バンドから削除/)
})

test('共通メンバーと固定バンドの確認は即時削除と取消不可を示す', () => {
  const memberCopy = getDeleteConfirmationCopy('common-member', '山田 太郎')
  const bandCopy = getDeleteConfirmationCopy('common-band', 'Choir')

  assert.equal(memberCopy.title, 'メンバーを削除しますか？')
  assert.match(memberCopy.description, /山田 太郎/)
  assert.match(memberCopy.description, /この操作は元に戻せません/)
  assert.doesNotMatch(memberCopy.description, /保存すると/)
  assert.equal(bandCopy.title, '固定バンドを削除しますか？')
  assert.match(bandCopy.description, /Choir/)
  assert.match(bandCopy.description, /この操作は元に戻せません/)
  assert.doesNotMatch(bandCopy.description, /保存すると/)
})

test('Event削除確認はcascade範囲と共通データ保持と取消不可を示す', () => {
  const copy = getDeleteConfirmationCopy('event', 'Autumn Live')

  assert.match(copy.title, /Autumn Live/)
  assert.match(copy.description, /開催日/)
  assert.match(copy.description, /タイムテーブル/)
  assert.match(copy.description, /PA・当日運営/)
  assert.match(copy.description, /メンバーと固定バンドは削除されません/)
  assert.match(copy.description, /この操作は元に戻せません/)
  assert.equal(copy.confirmLabel, 'イベントを削除')
})

test('削除確認の操作ラベルを全対象で共通化する', () => {
  const targets = [
    'event-day',
    'stage',
    'section',
    'event-member',
    'event-band',
    'common-member',
    'common-band',
  ]

  for (const target of targets) {
    const copy = getDeleteConfirmationCopy(target, '対象')
    assert.equal(copy.cancelLabel, 'キャンセル')
    assert.equal(copy.confirmLabel, '削除する')
  }

  assert.equal(
    getDeleteConfirmationCopy('event', '対象').confirmLabel,
    'イベントを削除',
  )
})
