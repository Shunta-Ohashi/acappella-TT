import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getEventBandItemsWithInvalidEventDay,
  getEventBandMemberDisplayNames,
  getMemberDisplayName,
} from '../src/ui/eventBandPresentation.ts'

const members = [
  { id: 'member-1', realName: '山田太郎', acaName: 'こてつ', active: true },
  { id: 'member-2', realName: '佐藤花子', acaName: '', active: true },
  { id: 'member-default-only', realName: '固定メンバー', active: true },
]

test('Member表示名はacaNameを優先し、空なら本名へfallbackする', () => {
  assert.equal(getMemberDisplayName(members[0]), 'こてつ')
  assert.equal(getMemberDisplayName(members[1]), '佐藤花子')
})

test('実出演MemberをEventBand.memberIds順に解決する', () => {
  const eventBand = {
    memberIds: ['member-2', 'member-1'],
  }

  assert.deepEqual(
    getEventBandMemberDisplayNames(eventBand, members),
    ['佐藤花子', 'こてつ'],
  )
})

test('固定BandのdefaultMemberIdsを使わず、missing Memberも安全に表示する', () => {
  const band = { defaultMemberIds: ['member-default-only'] }
  const eventBand = {
    bandId: 'band-1',
    memberIds: ['member-1', 'missing-member'],
  }

  assert.deepEqual(band.defaultMemberIds, ['member-default-only'])
  assert.deepEqual(
    getEventBandMemberDisplayNames(eventBand, members),
    ['こてつ', '不明なメンバー'],
  )
})

test('有効な開催日tabへ表示できない出演バンドを修復対象として抽出する', () => {
  const items = [
    { draftId: 'valid', eventDayId: 'day-1', name: '正常' },
    { draftId: 'missing', eventDayId: 'missing-day', name: '参照切れ' },
    { draftId: 'foreign', eventDayId: 'foreign-day', name: '別イベント日' },
  ]

  assert.deepEqual(getEventBandItemsWithInvalidEventDay(
    items,
    [{ id: 'day-1' }],
  ), [items[1], items[2]])
  assert.deepEqual(items.map(item => item.draftId), ['valid', 'missing', 'foreign'])
})
