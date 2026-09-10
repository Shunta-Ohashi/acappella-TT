import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCommonBandDraft,
  createCommonBandUpdate,
  filterCommonBands,
  resolveCommonBandMembers,
  validateCommonBandDraft,
} from '../src/domain/commonBands.ts'
import { getBandsForMember } from '../src/domain/commonMembers.ts'

const members = [
  { id: 'member-1', realName: '佐藤 太郎', acaName: 'TARO', active: true },
  { id: 'member-2', realName: '鈴木 花子', acaName: 'はな', active: false },
  { id: 'member-3', realName: '高橋 一郎', active: true },
]

const createDraft = (overrides = {}) => ({
  name: 'Choir',
  defaultDurationMinutes: '10',
  defaultMemberIds: ['member-1'],
  active: true,
  notes: '',
  ...overrides,
})

test('共通Bandを正規化して作成し、Member ID重複を除き活動中にする', () => {
  const result = createCommonBandUpdate({
    bandId: 'band-new',
    draft: createDraft({
      name: '  Choir  ',
      defaultDurationMinutes: ' 15 ',
      defaultMemberIds: ['member-1', 'member-2', 'member-1'],
      active: false,
      notes: '  共通メモ  ',
    }),
    members,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.band, {
    id: 'band-new',
    name: 'Choir',
    defaultMemberIds: ['member-1', 'member-2'],
    defaultDurationMinutes: 15,
    notes: '共通メモ',
    active: true,
  })
})

test('空のBand名と不正な標準出演時間を拒否する', () => {
  const errors = validateCommonBandDraft(
    createDraft({ name: '   ', defaultDurationMinutes: '0' }),
    members,
  )
  assert.deepEqual(errors, {
    name: 'バンド名を入力してください。',
    defaultDurationMinutes: '標準出演時間は1以上の整数で入力してください。',
  })

  for (const defaultDurationMinutes of [
    '',
    '-1',
    '1.5',
    'Infinity',
    '9007199254740992',
  ]) {
    const durationErrors = validateCommonBandDraft(
      createDraft({ defaultDurationMinutes }),
      members,
    )
    assert.equal(
      durationErrors.defaultDurationMinutes,
      '標準出演時間は1以上の整数で入力してください。',
    )
  }
})

test('Memberが0人のBandと新たな不明Member IDを拒否する', () => {
  assert.equal(
    validateCommonBandDraft(
      createDraft({ defaultMemberIds: [] }),
      members,
    ).defaultMemberIds,
    'メンバーを1人以上選択してください。',
  )
  assert.equal(
    validateCommonBandDraft(
      createDraft({ defaultMemberIds: ['unknown-member'] }),
      members,
    ).defaultMemberIds,
    '登録されていないメンバーを新しく追加することはできません。',
  )
})

test('既存BandのIDを維持して全編集項目を更新できる', () => {
  const existingBand = {
    id: 'band-existing',
    name: '変更前',
    defaultMemberIds: ['member-1', 'member-2'],
    defaultDurationMinutes: 5,
    notes: '変更前メモ',
    active: true,
  }
  const result = createCommonBandUpdate({
    bandId: 'ignored-new-id',
    existingBand,
    draft: createDraft({
      name: '  変更後  ',
      defaultDurationMinutes: '20',
      defaultMemberIds: ['member-2', 'member-3'],
      active: false,
      notes: '更新メモ',
    }),
    members,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.band, {
    id: existingBand.id,
    name: '変更後',
    defaultMemberIds: ['member-2', 'member-3'],
    defaultDurationMinutes: 20,
    notes: '更新メモ',
    active: false,
  })
})

test('活動終了Bandを活動中へ戻し、空のnotesを削除できる', () => {
  const existingBand = {
    id: 'band-inactive',
    name: '活動再開バンド',
    defaultMemberIds: ['member-1'],
    defaultDurationMinutes: 10,
    notes: '削除するメモ',
    active: false,
  }
  const draft = createCommonBandDraft(existingBand)
  const result = createCommonBandUpdate({
    bandId: existingBand.id,
    existingBand,
    draft: { ...draft, active: true, notes: '   ' },
    members,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.band.active, true)
  assert.equal(result.band.notes, undefined)
})

test('Band名を空白と大小文字を無視して検索し、状態で絞り込む', () => {
  const bands = [
    {
      id: 'band-1',
      name: 'MY PALS',
      defaultMemberIds: ['member-1'],
      defaultDurationMinutes: 5,
      active: true,
    },
    {
      id: 'band-2',
      name: 'あいおひ',
      defaultMemberIds: ['member-2'],
      defaultDurationMinutes: 10,
      active: false,
    },
  ]

  assert.deepEqual(
    filterCommonBands(bands, '  my pals ', 'all').map((band) => band.id),
    ['band-1'],
  )
  assert.deepEqual(filterCommonBands(bands, '不一致', 'all'), [])
  assert.deepEqual(filterCommonBands(bands, ' ', 'all'), bands)
  assert.deepEqual(
    filterCommonBands(bands, '', 'active').map((band) => band.id),
    ['band-1'],
  )
  assert.deepEqual(
    filterCommonBands(bands, '', 'inactive').map((band) => band.id),
    ['band-2'],
  )
})

test('Memberを重複なく解決し、不明Member IDはfallback表示する', () => {
  const resolvedMembers = resolveCommonBandMembers(
    {
      defaultMemberIds: [
        'member-1',
        'unknown-member',
        'member-1',
        'member-2',
      ],
    },
    members,
  )

  assert.deepEqual(
    resolvedMembers.map(({ memberId, displayName, member }) => ({
      memberId,
      displayName,
      active: member?.active,
    })),
    [
      { memberId: 'member-1', displayName: '佐藤 太郎', active: true },
      {
        memberId: 'unknown-member',
        displayName: '不明なメンバー',
        active: undefined,
      },
      { memberId: 'member-2', displayName: '鈴木 花子', active: false },
    ],
  )
})

test('既存の不明Member参照は勝手に削除せず、Member側の逆引きも同じbandsを参照する', () => {
  const existingBand = {
    id: 'band-existing',
    name: '参照切れを含むバンド',
    defaultMemberIds: ['member-1', 'unknown-member'],
    defaultDurationMinutes: 10,
    active: true,
  }
  const result = createCommonBandUpdate({
    bandId: existingBand.id,
    existingBand,
    draft: createCommonBandDraft(existingBand),
    members,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.band.defaultMemberIds, [
    'member-1',
    'unknown-member',
  ])
  assert.deepEqual(
    getBandsForMember('member-1', [result.band]).map((band) => band.id),
    [existingBand.id],
  )
})
