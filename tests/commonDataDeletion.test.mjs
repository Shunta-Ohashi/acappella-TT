import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkCommonBandDeletion,
  checkCommonMemberDeletion,
  createCommonBandDeletion,
  createCommonMemberDeletion,
} from '../src/domain/commonDataDeletion.ts'

const targetMember = {
  id: 'member-target',
  realName: '削除対象',
  active: true,
}
const otherMember = {
  id: 'member-other',
  realName: '維持対象',
  active: true,
}

const createMemberInput = (overrides = {}) => ({
  memberId: targetMember.id,
  members: [targetMember, otherMember],
  bands: [],
  eventMembers: [],
  eventBands: [],
  paAssignments: [],
  dutyAssignments: [],
  ...overrides,
})

test('どこからも参照されないMemberだけを削除する', () => {
  const input = createMemberInput({
    bands: [{ defaultMemberIds: ['missing-member'] }],
    eventMembers: [{ memberId: 'missing-member' }],
    eventBands: [{ memberIds: ['missing-member'] }],
    paAssignments: [{ memberId: 'missing-member' }],
    dutyAssignments: [{ memberId: 'missing-member' }],
  })
  const before = structuredClone(input)

  assert.deepEqual(checkCommonMemberDeletion(input), { ok: true })
  const result = createCommonMemberDeletion(input)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.members, [otherMember])
  assert.deepEqual(input, before)
})

test('Memberを参照する各collectionがHard Deleteを個別にblockする', () => {
  const references = [
    { key: 'bands', value: [{ defaultMemberIds: [targetMember.id] }] },
    { key: 'eventMembers', value: [{ memberId: targetMember.id }] },
    { key: 'eventBands', value: [{ memberIds: [targetMember.id] }] },
  ]

  for (const reference of references) {
    const input = createMemberInput({ [reference.key]: reference.value })
    assert.deepEqual(
      checkCommonMemberDeletion(input),
      { ok: false, reason: 'MEMBER_REFERENCED' },
      reference.key,
    )
    assert.deepEqual(
      createCommonMemberDeletion(input),
      { ok: false, reason: 'MEMBER_REFERENCED' },
      reference.key,
    )
  }
})

test('PA担当と当日運営担当の各参照がMember削除をblockする', () => {
  for (const key of ['paAssignments', 'dutyAssignments']) {
    const input = createMemberInput({
      [key]: [{ memberId: targetMember.id }],
    })

    assert.deepEqual(
      checkCommonMemberDeletion(input),
      { ok: false, reason: 'MEMBER_REFERENCED' },
      key,
    )
    assert.deepEqual(
      createCommonMemberDeletion(input),
      { ok: false, reason: 'MEMBER_REFERENCED' },
      key,
    )
  }
})

test('非在籍Memberも参照関係だけで削除可否を判定する', () => {
  const inactiveMember = { ...targetMember, active: false }

  assert.deepEqual(
    checkCommonMemberDeletion(createMemberInput({
      members: [inactiveMember],
    })),
    { ok: true },
  )
  assert.deepEqual(
    checkCommonMemberDeletion(createMemberInput({
      members: [inactiveMember],
      eventMembers: [{ memberId: inactiveMember.id }],
    })),
    { ok: false, reason: 'MEMBER_REFERENCED' },
  )
})

test('対象Memberが存在しない場合は他データを変更せず失敗する', () => {
  const input = createMemberInput({ memberId: 'member-missing' })
  const before = structuredClone(input)

  assert.deepEqual(
    createCommonMemberDeletion(input),
    { ok: false, reason: 'MEMBER_NOT_FOUND' },
  )
  assert.deepEqual(input, before)
})

const targetBand = {
  id: 'band-target',
  name: '削除対象バンド',
  defaultMemberIds: [targetMember.id],
  active: true,
}
const otherBand = {
  id: 'band-other',
  name: '維持対象バンド',
  defaultMemberIds: [otherMember.id],
  active: true,
}

const createBandInput = (overrides = {}) => ({
  bandId: targetBand.id,
  bands: [targetBand, otherBand],
  eventBands: [],
  ...overrides,
})

test('EventBandから参照されないBandだけを削除する', () => {
  const input = createBandInput({
    eventBands: [{ bandId: 'missing-band' }, { bandId: undefined }],
  })
  const before = structuredClone(input)

  assert.deepEqual(checkCommonBandDeletion(input), { ok: true })
  const result = createCommonBandDeletion(input)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.bands, [otherBand])
  assert.deepEqual(input, before)
})

test('EventBand.bandIdから参照中のBandは削除しない', () => {
  const input = createBandInput({
    eventBands: [{ bandId: targetBand.id }],
  })

  assert.deepEqual(
    checkCommonBandDeletion(input),
    { ok: false, reason: 'BAND_REFERENCED' },
  )
  assert.deepEqual(
    createCommonBandDeletion(input),
    { ok: false, reason: 'BAND_REFERENCED' },
  )
})

test('活動終了Bandも参照関係だけで削除可否を判定する', () => {
  const inactiveBand = { ...targetBand, active: false }

  assert.deepEqual(
    checkCommonBandDeletion(createBandInput({ bands: [inactiveBand] })),
    { ok: true },
  )
  assert.deepEqual(
    checkCommonBandDeletion(createBandInput({
      bands: [inactiveBand],
      eventBands: [{ bandId: inactiveBand.id }],
    })),
    { ok: false, reason: 'BAND_REFERENCED' },
  )
})

test('対象Bandが存在しない場合はEventBandを変更せず失敗する', () => {
  const input = createBandInput({ bandId: 'band-missing' })
  const before = structuredClone(input)

  assert.deepEqual(
    createCommonBandDeletion(input),
    { ok: false, reason: 'BAND_NOT_FOUND' },
  )
  assert.deepEqual(input, before)
})
