import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCommonMemberDraft,
  createCommonMemberUpdate,
  filterCommonMembers,
  getBandsForMember,
  validateCommonMemberDraft,
} from '../src/domain/commonMembers.ts'

const createDraft = (overrides = {}) => ({
  realName: '佐藤 太郎',
  acaName: '',
  entryAcademicYear: '',
  active: true,
  paCapabilities: { main: false, sub: false },
  notes: '',
  ...overrides,
})

const members = [
  { id: 'member-1', realName: '佐藤 太郎', acaName: 'TARO', active: true },
  { id: 'member-2', realName: '鈴木 花子', acaName: 'はな', active: false },
  { id: 'member-3', realName: '高橋 一郎', active: true },
]

test('共通Memberを正規化して作成し、新規Memberは在籍中になる', () => {
  const result = createCommonMemberUpdate({
    memberId: 'member-new',
    draft: createDraft({
      realName: '  山田 花  ',
      acaName: '  はな  ',
      entryAcademicYear: ' 2027 ',
      active: false,
      paCapabilities: { main: true, sub: false },
      notes: '  共通メモ  ',
    }),
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.member, {
    id: 'member-new',
    realName: '山田 花',
    acaName: 'はな',
    entryAcademicYear: 2027,
    notes: '共通メモ',
    active: true,
    paCapabilities: { main: true, sub: false },
  })
})

test('任意文字列と入学年度の空欄をundefinedへ正規化する', () => {
  const result = createCommonMemberUpdate({
    memberId: 'member-new',
    draft: createDraft({
      acaName: '   ',
      entryAcademicYear: '   ',
      notes: '   ',
    }),
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.member.acaName, undefined)
  assert.equal(result.member.entryAcademicYear, undefined)
  assert.equal(result.member.notes, undefined)
  assert.deepEqual(result.member.paCapabilities, { main: false, sub: false })
})

test('空の本名と不正な入学年度を拒否する', () => {
  assert.deepEqual(
    validateCommonMemberDraft(createDraft({
      realName: '   ',
      entryAcademicYear: '2024.5',
    })),
    {
      realName: '本名を入力してください。',
      entryAcademicYear: '入学年度は1以上の整数で入力してください。',
    },
  )

  for (const entryAcademicYear of ['0', '-1', '9007199254740992', '二千二十四']) {
    const errors = validateCommonMemberDraft(createDraft({ entryAcademicYear }))
    assert.equal(
      errors.entryAcademicYear,
      '入学年度は1以上の整数で入力してください。',
    )
  }
})

test('既存MemberのIDを維持して全編集項目を更新できる', () => {
  const existingMember = {
    id: 'member-existing',
    realName: '変更前',
    acaName: 'まえ',
    entryAcademicYear: 2022,
    notes: '変更前メモ',
    active: true,
    paCapabilities: { main: false, sub: true },
  }
  const result = createCommonMemberUpdate({
    memberId: 'ignored-new-id',
    existingMember,
    draft: createDraft({
      realName: '  変更後  ',
      acaName: '',
      entryAcademicYear: '2025',
      notes: '更新メモ',
      active: false,
      paCapabilities: { main: true, sub: false },
    }),
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.member.id, existingMember.id)
  assert.equal(result.member.realName, '変更後')
  assert.equal(result.member.acaName, undefined)
  assert.equal(result.member.entryAcademicYear, 2025)
  assert.equal(result.member.notes, '更新メモ')
  assert.equal(result.member.active, false)
  assert.deepEqual(result.member.paCapabilities, { main: true, sub: false })
})

test('非在籍Memberを在籍中へ戻せ、既存の未設定PAはfalseとしてdraft化する', () => {
  const existingMember = {
    id: 'member-inactive',
    realName: '卒業生',
    notes: '維持するメモ',
    active: false,
  }
  const draft = createCommonMemberDraft(existingMember)

  assert.deepEqual(draft.paCapabilities, { main: false, sub: false })
  assert.equal(draft.notes, '維持するメモ')

  const result = createCommonMemberUpdate({
    memberId: existingMember.id,
    existingMember,
    draft: { ...draft, active: true },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.member.active, true)
  assert.equal(result.member.notes, '維持するメモ')
})

test('本名・アカペラネームを空白と大小文字を無視して検索する', () => {
  assert.deepEqual(
    filterCommonMembers(members, '  佐藤  ', 'all').map((member) => member.id),
    ['member-1'],
  )
  assert.deepEqual(
    filterCommonMembers(members, 'taro', 'all').map((member) => member.id),
    ['member-1'],
  )
  assert.deepEqual(
    filterCommonMembers(members, 'はな', 'all').map((member) => member.id),
    ['member-2'],
  )
  assert.deepEqual(filterCommonMembers(members, '不一致', 'all'), [])
  assert.deepEqual(filterCommonMembers(members, ' ', 'all'), members)
})

test('在籍状態でMemberを絞り込める', () => {
  assert.deepEqual(
    filterCommonMembers(members, '', 'active').map((member) => member.id),
    ['member-1', 'member-3'],
  )
  assert.deepEqual(
    filterCommonMembers(members, '', 'inactive').map((member) => member.id),
    ['member-2'],
  )
  assert.deepEqual(filterCommonMembers(members, '', 'all'), members)
})

test('固定バンド所属をBand.defaultMemberIdsからBand単位で逆引きする', () => {
  const bands = [
    {
      id: 'band-1',
      name: 'あおぞら',
      defaultMemberIds: ['member-1'],
      active: true,
    },
    {
      id: 'band-2',
      name: '夕焼けコーラス',
      defaultMemberIds: ['member-1', 'member-1', 'member-2'],
      active: false,
    },
  ]

  assert.deepEqual(
    getBandsForMember('member-1', bands).map((band) => band.id),
    ['band-1', 'band-2'],
  )
  assert.deepEqual(
    getBandsForMember('member-2', bands).map((band) => band.id),
    ['band-2'],
  )
  assert.deepEqual(getBandsForMember('member-3', bands), [])
  assert.equal('bandIds' in members[0], false)
})
