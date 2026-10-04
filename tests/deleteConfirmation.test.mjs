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

test('削除確認の操作ラベルを全対象で共通化する', () => {
  const targets = ['event-day', 'stage', 'section', 'event-member', 'event-band']

  for (const target of targets) {
    const copy = getDeleteConfirmationCopy(target, '対象')
    assert.equal(copy.cancelLabel, 'キャンセル')
    assert.equal(copy.confirmLabel, '削除する')
  }
})
