import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTimetableLock,
  evaluateTimetableLocks,
  removeTimetableLock,
  removeTimetableLocksForEvent,
} from '../src/domain/timetableLocks.ts'
import {
  clearTimetableLockFeedback,
  getAffectedTimetableLockIds,
  getTimetableLockControlAccessibleName,
  getTimetableLockFeedbackMessage,
  getTimetableLockRepairSummary,
  getTimetableLockUnlockAccessibleName,
  getUniqueLockIdsForViolation,
  TIMETABLE_LOCK_UNLOCK_VISIBLE_TEXT,
} from '../src/ui/timetableLockPresentation.ts'

const eventDays = [
  { id: 'day-1', eventId: 'event-1', date: '2027-11-01', order: 0 },
  { id: 'day-2', eventId: 'event-1', date: '2027-11-02', order: 1 },
  { id: 'other-day', eventId: 'event-2', date: '2027-11-01', order: 0 },
]
const stages = [
  { id: 'stage-1', eventDayId: 'day-1', name: 'Main', order: 0, plannedStartTime: '10:00' },
  { id: 'stage-2', eventDayId: 'day-2', name: 'Sub', order: 0, plannedStartTime: '10:00' },
  { id: 'other-stage', eventDayId: 'other-day', name: 'Other', order: 0, plannedStartTime: '10:00' },
]
const sections = [
  { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
  { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1 },
]
const eventBands = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'].map((id) => ({
  id: `band-${id}`,
  eventId: 'event-1',
  eventDayId: id === 'f' || id === 'g' ? 'day-2' : 'day-1',
  name: id.toUpperCase(),
  memberIds: [],
  durationMinutes: 10,
}))
const performance = (id, order, sectionId = 'section-1', stageId = 'stage-1') => ({
  id: `item-${id}`,
  stageId,
  ...(sectionId ? { sectionId } : {}),
  order,
  kind: 'performance',
  eventBandId: `band-${id}`,
})
const scheduleItems = [
  performance('a', 0),
  {
    id: 'break-1', stageId: 'stage-1', sectionId: 'section-1', order: 1,
    kind: 'break', title: '休憩', durationMinutes: 5,
  },
  performance('b', 2),
  performance('c', 3),
  performance('d', 0, 'section-2'),
  performance('e', 1, 'section-2'),
  performance('f', 0, null, 'stage-2'),
  performance('g', 1, null, 'stage-2'),
]
const lock = (id, scheduleItemId, position, overrides = {}) => ({
  id,
  eventId: 'event-1',
  scheduleItemId,
  stageId: 'stage-1',
  sectionId: 'section-1',
  position,
  ...overrides,
})
const evaluate = (timetableLocks, items = scheduleItems, overrides = {}) =>
  evaluateTimetableLocks({
    eventId: 'event-1',
    timetableLocks,
    scheduleItems: items,
    eventBands,
    eventDays,
    stages,
    sections,
    ...overrides,
  })
const codes = (result) => result.violations.map((violation) => violation.code)

test('現在位置固定はBreakを数えずPerformance indexを保存する', () => {
  const result = applyTimetableLock({
    lockId: 'lock-b', eventId: 'event-1', scheduleItemId: 'item-b', mode: 'current',
    timetableLocks: [], scheduleItems, eventBands, eventDays, stages, sections,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.timetableLocks[0], lock(
    'lock-b', 'item-b', { kind: 'index', index: 1 },
  ))
  assert.equal(evaluate(result.timetableLocks, result.scheduleItems).valid, true)
})

test('同じorderの現在位置固定はID順へ変えず表示上の配列順を記録する', () => {
  const tiedItems = [
    { ...performance('a', 0), id: 'item-z' },
    { ...performance('b', 0), id: 'item-a' },
  ]
  const first = applyTimetableLock({
    lockId: 'lock-z', eventId: 'event-1', scheduleItemId: 'item-z', mode: 'current',
    timetableLocks: [], scheduleItems: tiedItems,
    eventBands, eventDays, stages, sections,
  })
  const second = applyTimetableLock({
    lockId: 'lock-a', eventId: 'event-1', scheduleItemId: 'item-a', mode: 'current',
    timetableLocks: [], scheduleItems: tiedItems,
    eventBands, eventDays, stages, sections,
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  assert.deepEqual(first.timetableLocks[0].position, { kind: 'index', index: 0 })
  assert.deepEqual(second.timetableLocks[0].position, { kind: 'index', index: 1 })
  assert.equal(evaluate(first.timetableLocks, tiedItems).valid, true)
  assert.equal(evaluate(second.timetableLocks, tiedItems).valid, true)
})

test('firstとlastをSectionごと・SectionなしStageごとに評価する', () => {
  const locks = [
    lock('first-1', 'item-a', { kind: 'first' }),
    lock('last-1', 'item-c', { kind: 'last' }),
    lock('first-2', 'item-d', { kind: 'first' }, { sectionId: 'section-2' }),
    lock('last-2', 'item-e', { kind: 'last' }, { sectionId: 'section-2' }),
    lock('first-stage', 'item-f', { kind: 'first' }, {
      stageId: 'stage-2', sectionId: undefined,
    }),
    lock('last-stage', 'item-g', { kind: 'last' }, {
      stageId: 'stage-2', sectionId: undefined,
    }),
  ]
  assert.deepEqual(evaluate(locks).violations, [])
})

test('index固定は他itemの並べ替え・追加・削除による位置ずれを拒否する', () => {
  const locks = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const reordered = scheduleItems.map((item) => item.id === 'item-a'
    ? { ...item, order: 3 }
    : item.id === 'item-c'
      ? { ...item, order: 4 }
      : item)
  assert.ok(codes(evaluate(locks, reordered)).includes('POSITION_MISMATCH'))

  const inserted = [
    ...scheduleItems.map((item) => item.stageId === 'stage-1' &&
      item.sectionId === 'section-1' ? { ...item, order: item.order + 1 } : item),
    performance('x', 0),
  ]
  assert.ok(codes(evaluate(locks, inserted)).includes('POSITION_MISMATCH'))

  const removed = scheduleItems.filter((item) => item.id !== 'item-a')
  assert.ok(codes(evaluate(locks, removed)).includes('POSITION_MISMATCH'))
})

test('固定対象自身の並べ替えとfirst前・last後への挿入を拒否する', () => {
  const currentLock = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const movedLockedItem = scheduleItems.map((item) => item.id === 'item-b'
    ? { ...item, order: 4 }
    : item.id === 'item-c'
      ? { ...item, order: 2 }
      : item)
  assert.ok(codes(evaluate(currentLock, movedLockedItem)).includes('POSITION_MISMATCH'))
  assert.ok(codes(evaluate(
    currentLock,
    scheduleItems.filter((item) => item.id !== 'item-b'),
  )).includes('SCHEDULE_ITEM_NOT_FOUND'))

  const beforeFirst = [
    ...scheduleItems,
    performance('x', -1),
  ]
  assert.ok(codes(evaluate(
    [lock('lock-a', 'item-a', { kind: 'first' })],
    beforeFirst,
  )).includes('POSITION_MISMATCH'))

  const afterLast = [
    ...scheduleItems,
    performance('x', 99),
  ]
  assert.ok(codes(evaluate(
    [lock('lock-c', 'item-c', { kind: 'last' })],
    afterLast,
  )).includes('POSITION_MISMATCH'))
})

test('Break追加だけではPerformance position lockを崩さない', () => {
  const locks = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const withBreak = [...scheduleItems, {
    id: 'break-2', stageId: 'stage-1', sectionId: 'section-1', order: 99,
    kind: 'break', title: '休憩2', durationMinutes: 10,
  }]
  assert.equal(evaluate(locks, withBreak).valid, true)
})

test('固定対象のStage・Section移動を拒否する', () => {
  const locks = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const movedSection = scheduleItems.map((item) => item.id === 'item-b'
    ? { ...item, sectionId: 'section-2' }
    : item)
  assert.ok(codes(evaluate(locks, movedSection)).includes('SECTION_MISMATCH'))

  const movedStage = scheduleItems.map((item) => item.id === 'item-b'
    ? { ...item, stageId: 'stage-2', sectionId: undefined }
    : item)
  assert.ok(codes(evaluate(locks, movedStage)).includes('STAGE_MISMATCH'))
})

test('トッパー・トリ設定は移動とLock作成をatomicに行う', () => {
  const topper = applyTimetableLock({
    lockId: 'lock-c', eventId: 'event-1', scheduleItemId: 'item-c', mode: 'first',
    timetableLocks: [], scheduleItems, eventBands, eventDays, stages, sections,
  })
  assert.equal(topper.ok, true)
  if (!topper.ok) return
  assert.deepEqual(
    topper.scheduleItems
      .filter((item) => item.kind === 'performance' && item.sectionId === 'section-1')
      .sort((left, right) => left.order - right.order)
      .map((item) => item.id),
    ['item-c', 'item-a', 'item-b'],
  )
  assert.deepEqual(topper.timetableLocks[0].position, { kind: 'first' })

  const tori = applyTimetableLock({
    lockId: 'lock-a', eventId: 'event-1', scheduleItemId: 'item-a', mode: 'last',
    timetableLocks: [], scheduleItems, eventBands, eventDays, stages, sections,
  })
  assert.equal(tori.ok, true)
  if (!tori.ok) return
  assert.deepEqual(
    tori.scheduleItems
      .filter((item) => item.kind === 'performance' && item.sectionId === 'section-1')
      .sort((left, right) => left.order - right.order)
      .map((item) => item.id),
    ['item-b', 'item-c', 'item-a'],
  )
  assert.deepEqual(tori.timetableLocks[0].position, { kind: 'last' })
})

test('トッパー設定が既存Lockと競合する場合はitemとLockを変更しない', () => {
  const existing = [lock('lock-a', 'item-a', { kind: 'first' })]
  const beforeItems = structuredClone(scheduleItems)
  const beforeLocks = structuredClone(existing)
  const result = applyTimetableLock({
    lockId: 'lock-c', eventId: 'event-1', scheduleItemId: 'item-c', mode: 'first',
    timetableLocks: existing, scheduleItems, eventBands, eventDays, stages, sections,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(scheduleItems, beforeItems)
  assert.deepEqual(existing, beforeLocks)
})

test('同じPerformanceのLock mode変更は既存Lockを置き換える', () => {
  const existing = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const result = applyTimetableLock({
    lockId: 'unused-new-id', eventId: 'event-1', scheduleItemId: 'item-b',
    mode: 'last', timetableLocks: existing, scheduleItems,
    eventBands, eventDays, stages, sections,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.timetableLocks.length, 1)
  assert.equal(result.timetableLocks[0].id, 'lock-b')
  assert.deepEqual(result.timetableLocks[0].position, { kind: 'last' })
})

test('解除はLockだけを削除し、一括解除は現在Eventだけを対象にする', () => {
  const locks = [
    lock('lock-a', 'item-a', { kind: 'first' }),
    { ...lock('other-lock', 'other-item', { kind: 'first' }), eventId: 'event-2' },
  ]
  assert.deepEqual(removeTimetableLock(locks, 'lock-a').map((item) => item.id), ['other-lock'])
  assert.deepEqual(
    removeTimetableLocksForEvent(locks, 'event-1').map((item) => item.id),
    ['other-lock'],
  )
})

test('重複target・first・last・indexのLock競合をdeterministicに検出する', () => {
  const locks = [
    lock('duplicate-a', 'item-a', { kind: 'first' }),
    lock('duplicate-a-2', 'item-a', { kind: 'index', index: 0 }),
    lock('first-b', 'item-b', { kind: 'first' }),
    lock('last-b', 'item-b', { kind: 'last' }),
    lock('last-c', 'item-c', { kind: 'last' }),
    lock('index-c', 'item-c', { kind: 'index', index: 1 }),
  ]
  const original = structuredClone(locks)
  const first = evaluate(locks)
  const second = evaluate(locks)
  assert.ok(codes(first).includes('DUPLICATE_LOCK_TARGET'))
  assert.ok(codes(first).includes('LOCK_CONFLICT'))
  assert.deepEqual(first, second)
  assert.deepEqual(locks, original)
})

test('fixedPlacementのStage・Section・position競合を検出する', () => {
  const placements = [
    { stageId: 'stage-2' },
    { stageId: 'stage-1', sectionId: 'section-2' },
    { stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'first' } },
  ]

  for (const fixedPlacement of placements) {
    const bands = eventBands.map((band) => band.id === 'band-b'
      ? { ...band, fixedPlacement }
      : band)
    const result = evaluate(
      [lock('lock-b', 'item-b', { kind: 'index', index: 1 })],
      scheduleItems,
      { eventBands: bands },
    )
    assert.ok(codes(result).includes('FIXED_PLACEMENT_CONFLICT'))
  }
})

test('別バンドの同じlaneの固定位置予約とTT固定の明確な競合を検出する', () => {
  const cases = [
    [{ kind: 'first' }, { kind: 'first' }],
    [{ kind: 'first' }, { kind: 'index', index: 0 }],
    [{ kind: 'index', index: 0 }, { kind: 'first' }],
    [{ kind: 'index', index: 2 }, { kind: 'index', index: 2 }],
    [{ kind: 'last' }, { kind: 'last' }],
  ]
  for (const [fixedPosition, lockPosition] of cases) {
    const bands = eventBands.map((band) => band.id === 'band-a'
      ? { ...band, fixedPlacement: {
        stageId: 'stage-1', sectionId: 'section-1', position: fixedPosition,
      } }
      : band)
    const result = evaluate(
      [lock('lock-b', 'item-b', lockPosition)], scheduleItems,
      { eventBands: bands },
    )
    const conflict = result.violations.find((violation) =>
      violation.code === 'FIXED_PLACEMENT_CONFLICT')
    assert.deepEqual(conflict?.lockIds, ['lock-b'])
    assert.deepEqual(conflict?.scheduleItemIds, ['item-b'])
  }
})

test('別Section・別Stageの固定位置は競合せず、自身の同じ固定位置も許可する', () => {
  const fixedBand = {
    ...eventBands[0],
    fixedPlacement: {
      stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'first' },
    },
  }
  const bands = [fixedBand, ...eventBands.slice(1)]
  assert.equal(evaluate([
    lock('lock-d', 'item-d', { kind: 'first' }, { sectionId: 'section-2' }),
  ], scheduleItems, { eventBands: bands }).valid, true)
  assert.equal(evaluate([
    lock('lock-f', 'item-f', { kind: 'first' }, {
      stageId: 'stage-2', sectionId: undefined,
    }),
  ], scheduleItems, { eventBands: bands }).valid, true)
  assert.equal(evaluate([
    lock('lock-a', 'item-a', { kind: 'first' }),
  ], scheduleItems, { eventBands: bands }).valid, true)
  assert.ok(codes(evaluate([
    lock('lock-a', 'item-a', { kind: 'last' }),
  ], scheduleItems, { eventBands: bands })).includes('FIXED_PLACEMENT_CONFLICT'))
})

test('未配置バンドの固定位置予約も考慮し、無効なlane参照は予約にしない', () => {
  const fixedBand = {
    ...eventBands.find((band) => band.id === 'band-x'),
    fixedPlacement: {
      stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'first' },
    },
  }
  const bands = [...eventBands.filter((band) => band.id !== 'band-x'), fixedBand]
  const target = [lock('lock-a', 'item-a', { kind: 'first' })]
  assert.ok(codes(evaluate(target, scheduleItems, { eventBands: bands }))
    .includes('FIXED_PLACEMENT_CONFLICT'))

  for (const fixedPlacement of [
    { ...fixedBand.fixedPlacement, stageId: 'missing-stage' },
    { ...fixedBand.fixedPlacement, sectionId: 'section-2', stageId: 'stage-2' },
    { ...fixedBand.fixedPlacement, sectionId: undefined },
  ]) {
    const invalidBands = bands.map((band) => band.id === fixedBand.id
      ? { ...band, fixedPlacement }
      : band)
    assert.equal(evaluate(target, scheduleItems, { eventBands: invalidBands }).valid, true)
  }
  assert.equal(evaluate(target, scheduleItems, {
    eventBands: bands.map((band) => band.id === fixedBand.id
      ? { ...band, eventDayId: 'day-2' }
      : band),
  }).valid, true)
  assert.equal(evaluate(target, scheduleItems, {
    eventBands: bands.map((band) => band.id === fixedBand.id
      ? { ...band, eventId: 'event-2' }
      : band),
  }).valid, true)
})

test('トッパー適用と現在位置固定は別バンドの予約を侵害せずatomicに失敗する', () => {
  const bands = eventBands.map((band) => band.id === 'band-a'
    ? { ...band, fixedPlacement: {
      stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'first' },
    } }
    : band)
  const beforeItems = structuredClone(scheduleItems)
  const beforeBands = structuredClone(bands)
  const existingLocks = [lock('lock-c', 'item-c', { kind: 'last' })]
  const beforeLocks = structuredClone(existingLocks)
  const topper = applyTimetableLock({
    lockId: 'lock-b', eventId: 'event-1', scheduleItemId: 'item-b', mode: 'first',
    timetableLocks: existingLocks, scheduleItems,
    eventBands: bands, eventDays, stages, sections,
  })
  assert.equal(topper.ok, false)
  assert.ok(codes(topper).includes('FIXED_PLACEMENT_CONFLICT'))
  assert.deepEqual(scheduleItems, beforeItems)
  assert.deepEqual(bands, beforeBands)
  assert.deepEqual(existingLocks, beforeLocks)

  const misplacedItems = scheduleItems.map((item) => item.id === 'item-b'
    ? { ...item, order: 0 }
    : item.id === 'item-a'
      ? { ...item, order: 2 }
      : item)
  const current = applyTimetableLock({
    lockId: 'current-b', eventId: 'event-1', scheduleItemId: 'item-b', mode: 'current',
    timetableLocks: [], scheduleItems: misplacedItems,
    eventBands: bands, eventDays, stages, sections,
  })
  assert.equal(current.ok, false)
  assert.ok(codes(current).includes('FIXED_PLACEMENT_CONFLICT'))
  assert.deepEqual(misplacedItems, scheduleItems.map((item) => item.id === 'item-b'
    ? { ...item, order: 0 }
    : item.id === 'item-a'
      ? { ...item, order: 2 }
      : item))
})

test('lastと任意indexは静的競合にせず、入力順に依存せず評価する', () => {
  const fixedBand = {
    ...eventBands[0],
    fixedPlacement: {
      stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'last' },
    },
  }
  const bands = [fixedBand, ...eventBands.slice(1)]
  const locks = [lock('lock-c', 'item-c', { kind: 'index', index: 2 })]
  const first = evaluate(locks, scheduleItems, { eventBands: bands })
  const reordered = evaluate(locks, scheduleItems, { eventBands: [...bands].reverse() })
  assert.equal(first.valid, true)
  assert.deepEqual(first, reordered)
  assert.deepEqual(bands[0], fixedBand)

  const indexBand = {
    ...fixedBand,
    fixedPlacement: {
      ...fixedBand.fixedPlacement,
      position: { kind: 'index', index: 2 },
    },
  }
  assert.equal(evaluate([
    lock('lock-c', 'item-c', { kind: 'last' }),
  ], scheduleItems, { eventBands: [indexBand, ...eventBands.slice(1)] }).valid, true)
})

test('参照切れScheduleItem・Stage・SectionとBreak targetをthrowせず返す', () => {
  const locks = [
    lock('missing-item', 'missing-item', { kind: 'first' }),
    lock('missing-stage', 'item-a', { kind: 'first' }, { stageId: 'missing-stage' }),
    lock('missing-section', 'item-b', { kind: 'index', index: 1 }, {
      sectionId: 'missing-section',
    }),
    lock('break-target', 'break-1', { kind: 'first' }),
  ]
  const result = evaluate(locks)
  assert.ok(codes(result).includes('SCHEDULE_ITEM_NOT_FOUND'))
  assert.ok(codes(result).includes('STAGE_NOT_FOUND'))
  assert.ok(codes(result).includes('SECTION_NOT_FOUND'))
  assert.ok(codes(result).includes('TARGET_NOT_PERFORMANCE'))
})

test('missing・foreign EventBandと開催日不一致を安全に検出する', () => {
  const missingBandItem = {
    ...performance('a', 0),
    id: 'item-missing-band',
    eventBandId: 'missing-band',
  }
  assert.ok(codes(evaluate(
    [lock('missing-band-lock', missingBandItem.id, { kind: 'first' })],
    [missingBandItem],
  )).includes('EVENT_BAND_NOT_FOUND'))

  const foreignBandItem = {
    ...performance('a', 0),
    id: 'item-foreign-band',
    eventBandId: 'foreign-band',
  }
  assert.ok(codes(evaluate(
    [lock('foreign-band-lock', foreignBandItem.id, { kind: 'first' })],
    [foreignBandItem],
    { eventBands: [...eventBands, {
      id: 'foreign-band', eventId: 'event-2', eventDayId: 'other-day',
      name: 'Foreign', memberIds: [], durationMinutes: 10,
    }] },
  )).includes('EVENT_MISMATCH'))

  const dayMismatchBands = eventBands.map((band) => band.id === 'band-a'
    ? { ...band, eventDayId: 'day-2' }
    : band)
  assert.ok(codes(evaluate(
    [lock('day-mismatch', 'item-a', { kind: 'first' })],
    scheduleItems,
    { eventBands: dayMismatchBands },
  )).includes('EVENT_DAY_MISMATCH'))
})

test('Sectionを持つStageのLockはSectionを明示する', () => {
  const sectionlessItem = performance('a', 0, null)
  const result = evaluate([
    lock('missing-section-lock', sectionlessItem.id, { kind: 'first' }, {
      sectionId: undefined,
    }),
  ], [sectionlessItem])

  assert.ok(codes(result).includes('SECTION_MISMATCH'))
})

test('開始時刻や出演時間が変わってもlaneとPerformance indexが同じならvalid', () => {
  const locks = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const changedBands = eventBands.map((band) => band.id === 'band-a'
    ? { ...band, durationMinutes: 30 }
    : band)
  assert.equal(evaluate(locks, scheduleItems, { eventBands: changedBands }).valid, true)
})

test('評価はcandidateと参照データを変更しない', () => {
  const locks = [lock('lock-b', 'item-b', { kind: 'index', index: 1 })]
  const inputs = { locks, scheduleItems, eventBands, eventDays, stages, sections }
  const before = structuredClone(inputs)

  evaluate(locks)

  assert.deepEqual(inputs, before)
})

test('別EventのLockは現在Eventの評価へ干渉しない', () => {
  const otherLock = {
    id: 'other-lock', eventId: 'event-2', scheduleItemId: 'missing',
    stageId: 'missing', position: { kind: 'first' },
  }
  assert.deepEqual(evaluate([otherLock]).violations, [])
})

test('TT固定feedbackは選択Eventに一致するときだけ表示し、切替後に復活しない', () => {
  const feedback = { eventId: 'event-1', message: 'TT固定を更新しました。' }

  assert.equal(
    getTimetableLockFeedbackMessage(feedback, 'event-1'),
    'TT固定を更新しました。',
  )
  assert.equal(getTimetableLockFeedbackMessage(feedback, 'event-2'), '')

  const clearedFeedback = clearTimetableLockFeedback()
  assert.equal(getTimetableLockFeedbackMessage(clearedFeedback, 'event-1'), '')
  assert.equal(getTimetableLockFeedbackMessage(clearedFeedback, 'event-2'), '')
})

test('snapshot復元時にTT固定feedbackをclearする', () => {
  const feedbackBeforeRestore = {
    eventId: 'event-1',
    message: 'TT固定が必須条件と競合しています。',
  }
  const feedbackAfterRestore = clearTimetableLockFeedback()

  assert.equal(
    getTimetableLockFeedbackMessage(feedbackBeforeRestore, 'event-1'),
    'TT固定が必須条件と競合しています。',
  )
  assert.equal(getTimetableLockFeedbackMessage(feedbackAfterRestore, 'event-1'), '')
})

test('修復パネル用のTT固定件数はViolation数ではなくunique Lock数を使う', () => {
  const singleLockViolations = [
    { code: 'STAGE_NOT_FOUND', lockIds: ['lock-1'], message: 'Stageなし' },
    { code: 'POSITION_MISMATCH', lockIds: ['lock-1'], message: '位置違反' },
  ]
  assert.deepEqual(getAffectedTimetableLockIds(singleLockViolations), ['lock-1'])
  assert.deepEqual(getTimetableLockRepairSummary(singleLockViolations), {
    visible: true,
    affectedLockIds: ['lock-1'],
  })

  const multipleLockViolations = [
    ...singleLockViolations,
    { code: 'LOCK_CONFLICT', lockIds: ['lock-1', 'lock-2', 'lock-2'], message: '競合' },
  ]
  assert.deepEqual(getAffectedTimetableLockIds(multipleLockViolations), ['lock-1', 'lock-2'])
  assert.deepEqual(getUniqueLockIdsForViolation(multipleLockViolations[2]), ['lock-1', 'lock-2'])
  assert.deepEqual(getTimetableLockRepairSummary([]), {
    visible: false,
    affectedLockIds: [],
  })
})

test('TT固定controlと解除buttonへ対象を識別できるaccessible nameを付ける', () => {
  assert.equal(getTimetableLockControlAccessibleName('Band A'), 'Band AのTT固定')
  assert.equal(getTimetableLockControlAccessibleName('Band B'), 'Band BのTT固定')

  const locks = [
    lock('lock-a', 'item-a', { kind: 'first' }),
    lock('lock-b', 'item-b', { kind: 'index', index: 1 }),
  ]
  const firstName = getTimetableLockUnlockAccessibleName({
    lockId: 'lock-a', timetableLocks: locks, scheduleItems, eventBands,
  })
  const secondName = getTimetableLockUnlockAccessibleName({
    lockId: 'lock-b', timetableLocks: locks, scheduleItems, eventBands,
  })
  assert.match(firstName, /AのTT固定.*トッパー.*lock-a.*解除/)
  assert.match(secondName, /BのTT固定.*2番目固定.*lock-b.*解除/)
  assert.notEqual(firstName, secondName)
  assert.equal(TIMETABLE_LOCK_UNLOCK_VISIBLE_TEXT, '固定を解除')
})
