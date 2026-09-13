import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
