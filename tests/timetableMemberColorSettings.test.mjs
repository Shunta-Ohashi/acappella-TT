import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTimetableMemberColorCandidates,
  createTimetableMemberColorMap,
  createTimetableMemberColorStorageKey,
  filterTimetableMemberColorAssignments,
  getNextAvailableTimetableMemberColorId,
  loadTimetableMemberColorAssignments,
  parseTimetableMemberColorStorageValue,
  removeTimetableMemberColorAssignment,
  saveTimetableMemberColorAssignments,
  setTimetableMemberColorAssignment,
  TIMETABLE_MEMBER_COLOR_PALETTE,
} from '../src/ui/timetableMemberColorSettings.ts'

const members = [
  { id: 'member-a', realName: '同姓 同名', active: true },
  { id: 'member-b', realName: '同姓 同名', active: true },
  { id: 'member-c', realName: '出演 多子', acaName: 'たこ', active: true },
  { id: 'member-unused', realName: '出演 なし', active: true },
]

const eventBands = [
  {
    id: 'event-band-1',
    eventId: 'event-a',
    eventDayId: 'day-a',
    name: 'Alpha',
    memberIds: ['member-a', 'member-c', 'member-c'],
    durationMinutes: 10,
  },
  {
    id: 'event-band-2',
    eventId: 'event-a',
    eventDayId: 'day-a',
    name: 'Beta',
    memberIds: ['member-b', 'member-c'],
    durationMinutes: 10,
  },
  {
    id: 'event-band-3',
    eventId: 'event-a',
    eventDayId: 'day-b',
    name: 'Gamma',
    memberIds: ['member-c'],
    durationMinutes: 10,
  },
  {
    id: 'event-band-other',
    eventId: 'event-b',
    eventDayId: 'day-a',
    name: 'Other Event',
    memberIds: ['member-a'],
    durationMinutes: 10,
  },
]

const createMemoryStorage = () => {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  }
}

test('色パレットは識別用の20色以上を重複IDなしで提供する', () => {
  assert.ok(TIMETABLE_MEMBER_COLOR_PALETTE.length >= 20)
  assert.equal(
    new Set(TIMETABLE_MEMBER_COLOR_PALETTE.map(color => color.id)).size,
    TIMETABLE_MEMBER_COLOR_PALETTE.length,
  )
  assert.equal(
    new Set(TIMETABLE_MEMBER_COLOR_PALETTE.map(color => color.background)).size,
    TIMETABLE_MEMBER_COLOR_PALETTE.length,
    'すべての色見本が同じ背景へ潰れない',
  )
  for (const color of TIMETABLE_MEMBER_COLOR_PALETTE) {
    assert.ok(color.label)
    assert.match(color.background, /^#[0-9a-f]{6}$/i)
    assert.match(color.border, /^#[0-9a-f]{6}$/i)
    assert.match(color.text, /^#[0-9a-f]{6}$/i)
  }
})

test('未使用色を順に提案し、手動変更・個別解除・人数無制限を扱う', () => {
  let assignments = []
  assignments = setTimetableMemberColorAssignment(assignments, 'member-a')
  assignments = setTimetableMemberColorAssignment(assignments, 'member-b')
  assert.deepEqual(assignments.map(value => value.colorId), ['rose', 'coral'])
  assert.equal(getNextAvailableTimetableMemberColorId(assignments), 'orange')

  assignments = setTimetableMemberColorAssignment(assignments, 'member-a', 'blue')
  assert.deepEqual(assignments, [
    { memberId: 'member-a', colorId: 'blue' },
    { memberId: 'member-b', colorId: 'coral' },
  ])
  assert.deepEqual(
    removeTimetableMemberColorAssignment(assignments, 'member-b'),
    [{ memberId: 'member-a', colorId: 'blue' }],
  )
  assert.deepEqual(
    setTimetableMemberColorAssignment(assignments, 'member-a', 'unknown'),
    assignments,
    '未知のpalette IDは設定しない',
  )

  const many = Array.from(
    { length: TIMETABLE_MEMBER_COLOR_PALETTE.length + 8 },
    (_, index) => ({
      memberId: `member-${index}`,
      colorId: TIMETABLE_MEMBER_COLOR_PALETTE[
        index % TIMETABLE_MEMBER_COLOR_PALETTE.length
      ].id,
    }),
  )
  assert.equal(many.length, TIMETABLE_MEMBER_COLOR_PALETTE.length + 8)
  assert.ok(getNextAvailableTimetableMemberColorId(many))
})

test('出演数はEvent・開催日ごとにEventBand IDを重複なく数え、多い順にする', () => {
  const candidates = createTimetableMemberColorCandidates({
    members,
    eventBands,
    eventId: 'event-a',
    selectedEventDayId: 'day-a',
  })

  assert.deepEqual(candidates, [
    {
      memberId: 'member-c',
      displayName: 'たこ',
      eventBandCount: 3,
      selectedEventDayBandCount: 2,
    },
    {
      memberId: 'member-a',
      displayName: '同姓 同名',
      eventBandCount: 1,
      selectedEventDayBandCount: 1,
    },
    {
      memberId: 'member-b',
      displayName: '同姓 同名',
      eventBandCount: 1,
      selectedEventDayBandCount: 1,
    },
  ])
})

test('着色は表示名・行・Band位置ではなくMember IDだけで解決する', () => {
  const assignments = [
    { memberId: 'member-a', colorId: 'rose' },
    { memberId: 'member-b', colorId: 'blue' },
  ]
  const beforeMove = [
    ['member-a', 'member-c'],
    ['member-b', 'member-a'],
  ]
  const afterMove = [...beforeMove].reverse()
  const afterUndo = [...afterMove].reverse()
  const colors = createTimetableMemberColorMap(assignments)
  const resolveColors = rows => rows.map(row => row.map(
    memberId => colors.get(memberId)?.id,
  ))

  assert.deepEqual(resolveColors(beforeMove), [
    ['rose', undefined],
    ['blue', 'rose'],
  ])
  assert.deepEqual(resolveColors(afterMove), [
    ['blue', 'rose'],
    ['rose', undefined],
  ])
  assert.deepEqual(resolveColors(afterUndo), resolveColors(beforeMove))
  assert.notEqual(colors.get('member-a')?.id, colors.get('member-b')?.id)
})

test('保存キーはlocal/Cloud scope・user・Workspace・Eventを分離し日やStageに依存しない', () => {
  const localEventA = createTimetableMemberColorStorageKey(
    'acappella-tt:app-state',
    'event-a',
  )
  const cloudUserAWorkspaceA = createTimetableMemberColorStorageKey(
    'acappella-tt:app-state:cloud:user-a:workspace-a',
    'event-a',
  )
  const keys = new Set([
    localEventA,
    createTimetableMemberColorStorageKey('acappella-tt:app-state', 'event-b'),
    cloudUserAWorkspaceA,
    createTimetableMemberColorStorageKey(
      'acappella-tt:app-state:cloud:user-a:workspace-b',
      'event-a',
    ),
    createTimetableMemberColorStorageKey(
      'acappella-tt:app-state:cloud:user-b:workspace-a',
      'event-a',
    ),
  ])
  assert.equal(keys.size, 5)
  assert.match(localEventA, /event-a$/)
  assert.equal(
    createTimetableMemberColorStorageKey(
      'acappella-tt:app-state:cloud:user-a:workspace-a',
      'event-a',
    ),
    cloudUserAWorkspaceA,
    'EventDay・Stage・visitは個人設定の保存keyに含めない',
  )
})

test('localStorageへ保存・再読込し、別scope/Eventには混入しない', () => {
  const storage = createMemoryStorage()
  const keyA = createTimetableMemberColorStorageKey('scope-a', 'event-a')
  const keyB = createTimetableMemberColorStorageKey('scope-b', 'event-a')
  const keyEventB = createTimetableMemberColorStorageKey('scope-a', 'event-b')
  const assignments = [
    { memberId: 'member-a', colorId: 'rose' },
    { memberId: 'member-b', colorId: 'blue' },
  ]

  assert.equal(saveTimetableMemberColorAssignments(keyA, assignments, storage), true)
  assert.deepEqual(
    loadTimetableMemberColorAssignments(keyA, storage),
    { assignments },
  )
  assert.deepEqual(
    loadTimetableMemberColorAssignments(keyB, storage),
    { assignments: [] },
  )
  assert.deepEqual(
    loadTimetableMemberColorAssignments(keyEventB, storage),
    { assignments: [] },
  )
})

test('不正保存値・重複Member・未知色・storage例外を安全に無視する', () => {
  assert.equal(parseTimetableMemberColorStorageValue(null), undefined)
  assert.equal(parseTimetableMemberColorStorageValue({
    version: 1,
    assignments: [{ memberId: 'member-a', colorId: 'unknown' }],
  }), undefined)
  assert.equal(parseTimetableMemberColorStorageValue({
    version: 1,
    assignments: [
      { memberId: 'member-a', colorId: 'rose' },
      { memberId: 'member-a', colorId: 'blue' },
    ],
  }), undefined)

  const corruptStorage = {
    getItem: () => '{not-json',
    setItem: () => { throw new Error('quota') },
  }
  const loaded = loadTimetableMemberColorAssignments('key', corruptStorage)
  assert.deepEqual(loaded.assignments, [])
  assert.match(loaded.warning, /読み込めません/)
  assert.equal(saveTimetableMemberColorAssignments(
    'key',
    [{ memberId: 'member-a', colorId: 'rose' }],
    corruptStorage,
  ), false)
})

test('存在しなくなったMember IDだけを表示対象から除外する', () => {
  const assignments = [
    { memberId: 'member-a', colorId: 'rose' },
    { memberId: 'missing-member', colorId: 'blue' },
  ]
  assert.deepEqual(
    filterTimetableMemberColorAssignments(assignments, new Set(['member-a'])),
    [{ memberId: 'member-a', colorId: 'rose' }],
  )
})
