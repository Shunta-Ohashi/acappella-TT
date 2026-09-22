import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import { getUnscheduledEventBandsForEventDay } from '../src/domain/schedule.ts'
import {
  CURRENT_STORAGE_VERSION,
  STORAGE_KEY,
  clearPersistedState,
  createPersistedAppState,
  isPersistedAppStateV1,
  loadPersistedState,
  loadPersistedStateOrFallback,
  parsePersistedState,
  savePersistedState,
  serializePersistedState,
} from '../src/persistence/localPersistence.ts'

class MemoryStorage {
  values = new Map()

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.values.set(key, value)
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

const createEmptyState = () => ({
  members: [],
  bands: [],
  events: [],
  eventDays: [],
  stages: [],
  sections: [],
  eventMembers: [],
  eventMemberDays: [],
  eventBands: [],
  scheduleItems: [],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
})

test('主要domain collectionをversion付き単一snapshotでround-tripする', () => {
  const demo = createDemoData()
  const serialized = serializePersistedState(demo)
  const parsed = parsePersistedState(serialized)

  assert.ok(parsed)
  assert.equal(parsed.version, CURRENT_STORAGE_VERSION)
  assert.deepEqual(parsed, createPersistedAppState(demo))
})

test('ScheduleBoundaryを含む全IDをround-trip後も維持する', () => {
  const demo = createDemoData()
  const parsed = parsePersistedState(serializePersistedState(demo))

  assert.ok(parsed)
  assert.deepEqual(
    parsed.scheduleItems.map((item) => item.id),
    demo.scheduleItems.map((item) => item.id),
  )
  assert.deepEqual(parsed.paAssignments, demo.paAssignments)
  assert.deepEqual(parsed.dutyAssignments, demo.dutyAssignments)
})

test('version 1だけを受理し未知versionを拒否する', () => {
  const valid = createPersistedAppState(createEmptyState())

  assert.equal(isPersistedAppStateV1(valid), true)
  assert.equal(parsePersistedState(JSON.stringify(valid))?.version, 1)
  assert.equal(parsePersistedState(JSON.stringify({ ...valid, version: 2 })), undefined)
})

test('壊れたJSONを例外なく拒否しstorage entryを削除する', () => {
  const storage = new MemoryStorage()
  storage.setItem(STORAGE_KEY, '{broken json')

  assert.doesNotThrow(() => loadPersistedState(storage))
  assert.equal(loadPersistedState(storage), undefined)
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('必須collection不足とtop-level不正を拒否する', () => {
  assert.equal(parsePersistedState(JSON.stringify({ version: 1 })), undefined)
  assert.equal(parsePersistedState(JSON.stringify([])), undefined)
  assert.equal(parsePersistedState(JSON.stringify(null)), undefined)
  assert.equal(parsePersistedState(JSON.stringify({
    ...createPersistedAppState(createEmptyState()),
    members: {},
  })), undefined)
})

test('全collectionが空でも有効な保存状態として復元する', () => {
  const storage = new MemoryStorage()
  const emptyState = createEmptyState()

  assert.equal(savePersistedState(emptyState, storage), true)
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, storage),
    createPersistedAppState(emptyState),
  )
})

test('EventDay.dateは実在するLocalDateだけを復元する', () => {
  const empty = createPersistedAppState(createEmptyState())
  const eventDay = createDemoData().eventDays[0]

  for (const date of ['2026-09-22', '2024-02-29']) {
    assert.ok(parsePersistedState(JSON.stringify({
      ...empty,
      eventDays: [{ ...eventDay, date }],
    })), `${date}は有効な開催日`)
  }

  for (const date of [
    '2026-02-29',
    '2026-02-31',
    '2026-13-01',
    '2026-00-10',
    'bad',
  ]) {
    assert.equal(parsePersistedState(JSON.stringify({
      ...empty,
      eventDays: [{ ...eventDay, date }],
    })), undefined, `${date}は無効な開催日`)
  }
})

test('不正なEventDay.dateを含むsnapshotは一括拒否し、storageを削除してdemoDataへ戻す', () => {
  const demo = createDemoData()
  const storage = new MemoryStorage()
  storage.setItem(STORAGE_KEY, JSON.stringify({
    ...createPersistedAppState(demo),
    eventDays: demo.eventDays.map((day, index) =>
      index === 0 ? { ...day, date: '2026-02-31' } : day),
  }))

  let recovered
  assert.doesNotThrow(() => {
    recovered = loadPersistedStateOrFallback(createDemoData, storage)
  })
  assert.deepEqual(recovered, createPersistedAppState(demo))
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('broken referenceをcleanupせずそのまま保存・復元する', () => {
  const state = {
    ...createEmptyState(),
    paAssignments: [{
      id: 'pa-broken',
      eventId: 'missing-event',
      eventDayId: 'missing-day',
      stageId: 'missing-stage',
      memberId: 'missing-member',
      role: 'main',
      from: { scheduleItemId: 'missing-from', edge: 'start' },
      until: { scheduleItemId: 'missing-until', edge: 'end' },
    }],
    dutyAssignments: [{
      id: 'duty-broken',
      dutyTypeId: 'missing-duty-type',
      eventDayId: 'missing-day',
      stageId: 'missing-stage',
      memberId: 'missing-member',
      from: { scheduleItemId: 'missing-from', edge: 'start' },
      until: { scheduleItemId: 'missing-until', edge: 'end' },
    }],
  }
  const parsed = parsePersistedState(serializePersistedState(state))

  assert.ok(parsed)
  assert.deepEqual(parsed.paAssignments, state.paAssignments)
  assert.deepEqual(parsed.dutyAssignments, state.dutyAssignments)
})

test('storageなし・invalidならdemoData、validなら保存値を初期値にする', () => {
  const missingStorage = new MemoryStorage()
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, missingStorage),
    createPersistedAppState(createDemoData()),
  )

  const invalidStorage = new MemoryStorage()
  invalidStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 999 }))
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, invalidStorage),
    createPersistedAppState(createDemoData()),
  )
  assert.equal(invalidStorage.getItem(STORAGE_KEY), null)

  const validStorage = new MemoryStorage()
  const persisted = {
    ...createEmptyState(),
    members: [{ id: 'saved-member', realName: '保存済み', active: true }],
  }
  savePersistedState(persisted, validStorage)
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, validStorage),
    createPersistedAppState(persisted),
  )
})

test('saveは1つのkeyへatomic snapshotを書きclearで削除する', () => {
  const storage = new MemoryStorage()
  const state = createEmptyState()

  assert.equal(savePersistedState(state, storage), true)
  assert.deepEqual([...storage.values.keys()], [STORAGE_KEY])
  assert.equal(clearPersistedState(storage), true)
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('localStorageへの保存失敗を外へ投げずstate更新を継続できる', () => {
  const storage = new MemoryStorage()
  storage.setItem = () => {
    throw new Error('quota exceeded')
  }
  const originalWarn = console.warn
  console.warn = () => {}

  try {
    assert.doesNotThrow(() => savePersistedState(createEmptyState(), storage))
    assert.equal(savePersistedState(createEmptyState(), storage), false)
  } finally {
    console.warn = originalWarn
  }
})

test('demoDataの全13 collectionで実際の要素がstructural validatorを通る', () => {
  const demo = createDemoData()
  const empty = createEmptyState()

  for (const collection of Object.keys(empty)) {
    assert.ok(demo[collection].length > 0, `${collection}に検証対象がありません`)
    assert.ok(parsePersistedState(JSON.stringify({
      ...createPersistedAppState(empty),
      ...(collection === 'scheduleItems' ? { eventBands: demo.eventBands } : {}),
      [collection]: [demo[collection][0]],
    })), `${collection}の正常要素が拒否されました`)
  }
})

test('events内のnullはsnapshot全体を拒否してdemoDataへfallbackする', () => {
  const storage = new MemoryStorage()
  storage.setItem(STORAGE_KEY, JSON.stringify({
    ...createPersistedAppState(createEmptyState()),
    events: [null],
  }))

  assert.doesNotThrow(() => loadPersistedStateOrFallback(createDemoData, storage))
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, storage),
    createPersistedAppState(createDemoData()),
  )
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('primitive、必須field欠落、誤ったprimitive型を拒否する', () => {
  const empty = createPersistedAppState(createEmptyState())
  const validEvent = createDemoData().events[0]
  const { name: _missingName, ...eventWithoutName } = validEvent
  const malformed = [
    { members: ['invalid'] },
    { events: [eventWithoutName] },
    { events: [{ ...validEvent, id: 123 }] },
  ]

  for (const collection of malformed) {
    assert.equal(parsePersistedState(JSON.stringify({
      ...empty,
      ...collection,
    })), undefined)
  }
})

test('ScheduleItemのdiscriminatorとkind別必須fieldを検証する', () => {
  const base = {
    id: 'item-1',
    stageId: 'stage-1',
    order: 0,
  }
  const empty = createPersistedAppState(createEmptyState())

  for (const item of [
    { ...base, kind: 'performance' },
    { ...base, kind: 'break', title: '休憩' },
    { ...base, kind: 'unknown', eventBandId: 'band-1' },
  ]) {
    assert.equal(parsePersistedState(JSON.stringify({
      ...empty,
      scheduleItems: [item],
    })), undefined)
  }
  assert.equal(parsePersistedState(JSON.stringify({
    ...empty,
    scheduleItems: [{ ...base, kind: 'performance', eventBandId: 'missing-band' }],
  })), undefined)
})

test('PerformanceのEventBand参照切れはsnapshot全体を拒否し、Breakと修復可能な参照切れは保持する', () => {
  const storage = new MemoryStorage()
  const demo = createDemoData()
  const valid = createPersistedAppState(demo)
  const performance = demo.scheduleItems.find((item) => item.kind === 'performance')
  assert.ok(performance)
  assert.ok(parsePersistedState(JSON.stringify(valid)))

  const broken = {
    ...valid,
    scheduleItems: valid.scheduleItems.map((item) =>
      item.id === performance.id ? { ...item, eventBandId: 'missing-band' } : item),
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(broken))
  let recovered
  assert.doesNotThrow(() => {
    recovered = loadPersistedStateOrFallback(createDemoData, storage)
  })
  assert.deepEqual(recovered, valid)
  assert.equal(storage.getItem(STORAGE_KEY), null)

  const breakOnly = {
    ...createPersistedAppState(createEmptyState()),
    scheduleItems: [{ id: 'break-1', stageId: 'missing-stage', order: 0,
      kind: 'break', title: '休憩', durationMinutes: 10 }],
  }
  assert.ok(parsePersistedState(JSON.stringify(breakOnly)))
})

test('出演項目が別EventのEventBandを参照すると起動時Timelineへ渡せないため拒否する', () => {
  const demo = createDemoData()
  const performance = demo.scheduleItems.find((item) => item.kind === 'performance')
  assert.ok(performance)
  const stage = demo.stages.find((candidate) => candidate.id === performance.stageId)
  const day = demo.eventDays.find((candidate) => candidate.id === stage?.eventDayId)
  assert.ok(day)
  const otherEventBand = demo.eventBands.find((band) => band.eventId !== day.eventId)
  assert.ok(otherEventBand)
  assert.equal(parsePersistedState(JSON.stringify({
    ...createPersistedAppState(demo),
    scheduleItems: demo.scheduleItems.map((item) =>
      item.id === performance.id ? { ...item, eventBandId: otherEventBand.id } : item),
  })), undefined)
})

test('同じ固定Bandの別日出演は別EventBand IDで保存でき、Poolも日別IDで判定する', () => {
  const demo = createDemoData()
  const day1Band = demo.eventBands.find((band) =>
    band.bandId && demo.eventBands.some((other) =>
      other.id !== band.id && other.eventId === band.eventId &&
      other.bandId === band.bandId && other.eventDayId !== band.eventDayId))
  assert.ok(day1Band)
  const day2Band = demo.eventBands.find((band) =>
    band.id !== day1Band.id && band.eventId === day1Band.eventId &&
    band.bandId === day1Band.bandId && band.eventDayId !== day1Band.eventDayId)
  assert.ok(day2Band)
  const day1Stage = demo.stages.find((stage) => stage.eventDayId === day1Band.eventDayId)
  const day2Stage = demo.stages.find((stage) => stage.eventDayId === day2Band.eventDayId)
  assert.ok(day1Stage)
  assert.ok(day2Stage)
  const day1Item = { id: 'day1-item', stageId: day1Stage.id, order: 0,
    kind: 'performance', eventBandId: day1Band.id }
  const day2Item = { id: 'day2-item', stageId: day2Stage.id, order: 0,
    kind: 'performance', eventBandId: day2Band.id }
  const snapshot = createPersistedAppState(demo)

  assert.ok(parsePersistedState(JSON.stringify({ ...snapshot, scheduleItems: [day1Item] })))
  assert.ok(parsePersistedState(JSON.stringify({
    ...snapshot,
    scheduleItems: [day1Item, day2Item],
  })))

  const day2Pool = getUnscheduledEventBandsForEventDay({
    eventBands: demo.eventBands,
    eventId: day2Band.eventId,
    eventDayId: day2Band.eventDayId,
    stages: demo.stages,
    scheduleItems: [day1Item],
  })
  assert.ok(day2Pool.some((band) => band.id === day2Band.id))
  assert.ok(!day2Pool.some((band) => band.id === day1Band.id))

  const scheduledDay2Pool = getUnscheduledEventBandsForEventDay({
    eventBands: demo.eventBands,
    eventId: day2Band.eventId,
    eventDayId: day2Band.eventDayId,
    stages: demo.stages,
    scheduleItems: [day1Item, day2Item],
  })
  assert.ok(!scheduledDay2Pool.some((band) => band.id === day2Band.id))
})

test('同一Eventでも別EventDayのEventBandを参照するPerformanceは一括拒否する', () => {
  const demo = createDemoData()
  const day1Band = demo.eventBands.find((band) => band.eventDayId === 'event-day-demo-main-01')
  const day2Band = demo.eventBands.find((band) =>
    band.eventId === day1Band?.eventId && band.eventDayId !== day1Band.eventDayId)
  const day1Stage = demo.stages.find((stage) => stage.eventDayId === day1Band?.eventDayId)
  assert.ok(day1Band)
  assert.ok(day2Band)
  assert.ok(day1Stage)
  const storage = new MemoryStorage()
  storage.setItem(STORAGE_KEY, JSON.stringify({
    ...createPersistedAppState(demo),
    scheduleItems: [{ id: 'cross-day-item', stageId: day1Stage.id, order: 0,
      kind: 'performance', eventBandId: day2Band.id }],
  }))

  let recovered
  assert.doesNotThrow(() => {
    recovered = loadPersistedStateOrFallback(createDemoData, storage)
  })
  assert.deepEqual(recovered, createPersistedAppState(demo))
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('保存済みLocalTimeはStage・Section・TimeRange・固定開始時刻まで同じ形式で検証する', () => {
  const demo = createDemoData()
  const empty = createPersistedAppState(createEmptyState())
  const stage = demo.stages[0]
  const section = demo.sections[0]
  const memberDay = demo.eventMemberDays[0]
  const eventBand = demo.eventBands[0]
  const valid = [
    { stages: [{ ...stage, plannedStartTime: '09:30', plannedEndTime: undefined }] },
    { sections: [{ ...section, plannedStartTime: '09:30', plannedEndTime: undefined }] },
    { eventMemberDays: [{ ...memberDay, availabilityWindows: [{ from: '09:30' }],
      preferredTimeRange: { until: '17:30' } }] },
    { eventBands: [{ ...eventBand, availableTimeRange: { from: '09:30' },
      preferredTimeRange: { until: '17:30' },
      fixedPlacement: { stageId: stage.id, plannedStartTime: '09:30' } }] },
  ]
  for (const collection of valid) {
    assert.ok(parsePersistedState(JSON.stringify({ ...empty, ...collection })))
  }

  const invalid = [
    { stages: [{ ...stage, plannedStartTime: 'bad' }] },
    { stages: [{ ...stage, plannedStartTime: '24:00' }] },
    { stages: [{ ...stage, plannedEndTime: '10:60' }] },
    { sections: [{ ...section, plannedStartTime: '9:30' }] },
    { sections: [{ ...section, plannedEndTime: '24:00' }] },
    { eventMemberDays: [{ ...memberDay, availabilityWindows: [{ until: '99:00' }] }] },
    { eventMemberDays: [{ ...memberDay, preferredTimeRange: { from: '10:60' } }] },
    { eventBands: [{ ...eventBand, availableTimeRange: { from: 'bad' } }] },
    { eventBands: [{ ...eventBand, preferredTimeRange: { until: '24:00' } }] },
    { eventBands: [{ ...eventBand, fixedPlacement: { stageId: stage.id,
      plannedStartTime: '10:60' } }] },
  ]
  for (const collection of invalid) {
    assert.equal(parsePersistedState(JSON.stringify({ ...empty, ...collection })), undefined)
  }
})

test('保存済みTimeRangeは片側開放を許可し、両端指定なら開始 < 終了を要求する', () => {
  const demo = createDemoData()
  const empty = createPersistedAppState(createEmptyState())
  const memberDay = demo.eventMemberDays[0]
  const eventBand = demo.eventBands[0]
  const validRanges = [
    { from: '09:00', until: '17:00' },
    { from: '09:00' },
    { until: '17:00' },
  ]
  const invalidRanges = [
    { from: '17:00', until: '09:00' },
    { from: '09:00', until: '09:00' },
  ]

  for (const range of validRanges) {
    for (const collection of [
      { eventMemberDays: [{ ...memberDay, availabilityWindows: [range] }] },
      { eventMemberDays: [{ ...memberDay, preferredTimeRange: range }] },
      { eventBands: [{ ...eventBand, availableTimeRange: range }] },
      { eventBands: [{ ...eventBand, preferredTimeRange: range }] },
    ]) {
      assert.ok(parsePersistedState(JSON.stringify({ ...empty, ...collection })))
    }
  }

  for (const range of invalidRanges) {
    for (const collection of [
      { eventMemberDays: [{ ...memberDay, availabilityWindows: [range] }] },
      { eventMemberDays: [{ ...memberDay, preferredTimeRange: range }] },
      { eventBands: [{ ...eventBand, availableTimeRange: range }] },
      { eventBands: [{ ...eventBand, preferredTimeRange: range }] },
    ]) {
      assert.equal(parsePersistedState(JSON.stringify({ ...empty, ...collection })), undefined)
    }
  }
})

test('保存済みStageの固定終了は開始より後だけを許可する', () => {
  const empty = createPersistedAppState(createEmptyState())
  const stage = createDemoData().stages[0]
  for (const [plannedStartTime, plannedEndTime, expected] of [
    ['09:00', '18:00', true],
    ['09:00', undefined, true],
    ['18:00', '09:00', false],
    ['09:00', '09:00', false],
  ]) {
    assert.equal(Boolean(parsePersistedState(JSON.stringify({
      ...empty,
      stages: [{ ...stage, plannedStartTime, plannedEndTime }],
    }))), expected)
  }
})

test('保存済みSectionは固定時刻の順序とStage時間内への収まりを要求する', () => {
  const empty = createPersistedAppState(createEmptyState())
  const demo = createDemoData()
  const stage = { ...demo.stages[0], plannedStartTime: '09:00', plannedEndTime: '18:00' }
  const section = { ...demo.sections[0], stageId: stage.id }
  for (const [plannedStartTime, plannedEndTime, expected] of [
    ['10:00', '17:00', true],
    ['09:00', '18:00', true],
    [undefined, '17:00', true],
    ['10:00', undefined, true],
    ['17:00', '10:00', false],
    ['10:00', '10:00', false],
    ['08:59', '17:00', false],
    ['18:00', undefined, false],
    [undefined, '09:00', false],
    [undefined, '18:01', false],
  ]) {
    assert.equal(Boolean(parsePersistedState(JSON.stringify({
      ...empty,
      stages: [stage],
      sections: [{ ...section, plannedStartTime, plannedEndTime }],
    }))), expected)
  }
})

test('不正な時間区間を含むsnapshotは補正せず一括破棄してdemoDataへ戻す', () => {
  const demo = createDemoData()
  const storage = new MemoryStorage()
  storage.setItem(STORAGE_KEY, JSON.stringify({
    ...createPersistedAppState(demo),
    eventMemberDays: demo.eventMemberDays.map((day, index) =>
      index === 0
        ? { ...day, availabilityWindows: [{ from: '17:00', until: '09:00' }] }
        : day),
  }))

  let recovered
  assert.doesNotThrow(() => {
    recovered = loadPersistedStateOrFallback(createDemoData, storage)
  })
  assert.deepEqual(recovered, createPersistedAppState(demo))
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('保存済み数値を各fieldの整数・符号制約で検証し、許可される0は維持する', () => {
  const demo = createDemoData()
  const empty = createPersistedAppState(createEmptyState())
  const event = demo.events[0]
  const stage = demo.stages[0]
  const section = demo.sections[0]
  const eventDay = demo.eventDays[0]
  const member = demo.members[0]
  const eventBand = demo.eventBands[0]
  const breakItem = { id: 'break-1', stageId: stage.id, order: 0,
    kind: 'break', title: '休憩', durationMinutes: 10 }
  const dutyType = demo.dutyTypes[0]
  const allowedZero = {
    ...empty,
    events: [{ ...event, defaultTransitionMinutes: 0,
      validationPolicy: { minimumGapBands: 0, minimumRestMinutes: 0 } }],
    eventDays: [{ ...eventDay, order: 0 }],
    stages: [{ ...stage, order: 0, transitionMinutes: 0 }],
    sections: [{ ...section, order: 0 }],
    scheduleItems: [breakItem],
    dutyTypes: [{ ...dutyType, order: 0 }],
    eventBands: [{ ...eventBand, fixedPlacement: {
      stageId: stage.id, position: { kind: 'index', index: 0 },
    } }],
  }
  assert.ok(parsePersistedState(JSON.stringify(allowedZero)))

  const invalid = [
    { members: [{ ...member, entryAcademicYear: 0 }] },
    { events: [{ ...event, defaultTransitionMinutes: -1 }] },
    { events: [{ ...event, defaultTransitionMinutes: 1.5 }] },
    { events: [{ ...event, validationPolicy: { ...event.validationPolicy, minimumGapBands: -1 } }] },
    { events: [{ ...event, validationPolicy: { ...event.validationPolicy, minimumRestMinutes: 1.5 } }] },
    { events: [{ ...event, performanceSlotMinutes: [0] }] },
    { events: [{ ...event, performanceSlotMinutes: [1.5] }] },
    { eventDays: [{ ...eventDay, order: -1 }] },
    { stages: [{ ...stage, order: 1.5 }] },
    { stages: [{ ...stage, transitionMinutes: -1 }] },
    { sections: [{ ...section, order: -1 }] },
    { eventBands: [{ ...eventBand, durationMinutes: 0 }] },
    { eventBands: [{ ...eventBand, durationMinutes: 1.5 }] },
    { eventBands: [{ ...eventBand, fixedPlacement: {
      stageId: stage.id, position: { kind: 'index', index: -1 },
    } }] },
    { scheduleItems: [{ ...breakItem, durationMinutes: -1 }] },
    { scheduleItems: [{ ...breakItem, order: 1.5 }] },
    { dutyTypes: [{ ...dutyType, order: -1 }] },
  ]
  for (const collection of invalid) {
    assert.equal(parsePersistedState(JSON.stringify({ ...empty, ...collection })), undefined)
  }
})

test('PA・DutyのScheduleBoundaryをnested validationし参照先の有無は見ない', () => {
  const empty = createPersistedAppState(createEmptyState())
  const broken = {
    id: 'assignment-1',
    eventDayId: 'missing-day',
    stageId: 'missing-stage',
    memberId: 'missing-member',
    from: { scheduleItemId: 'missing-item', edge: 'start' },
    until: { scheduleItemId: 'missing-item', edge: 'end' },
  }
  const pa = { ...broken, eventId: 'missing-event', role: 'sub' }
  const duty = { ...broken, dutyTypeId: 'missing-duty-type' }

  assert.ok(parsePersistedState(JSON.stringify({
    ...empty,
    paAssignments: [pa],
    dutyAssignments: [duty],
  })))
  for (const collection of [
    { paAssignments: [{ ...pa, from: { scheduleItemId: 'x', edge: 'middle' } }] },
    { dutyAssignments: [{ ...duty, until: { scheduleItemId: 123, edge: 'end' } }] },
  ]) {
    assert.equal(parsePersistedState(JSON.stringify({
      ...empty,
      ...collection,
    })), undefined)
  }
})

test('optional・nested・literal fieldを構造検証し未知の追加fieldは許容する', () => {
  const demo = createDemoData()
  const empty = createPersistedAppState(createEmptyState())
  const malformed = [
    { members: [{ ...demo.members[0], paCapabilities: { main: true } }] },
    { eventMemberDays: [{ ...demo.eventMemberDays[0], participationStatus: 'unknown' }] },
    { eventMemberDays: [{ ...demo.eventMemberDays[0], availabilityWindows: [{}] }] },
    { eventBands: [{ ...demo.eventBands[0], fixedPlacement: { stageId: 'stage-1', position: { kind: 'index' } } }] },
    { eventBands: [{ ...demo.eventBands[0], preferredTimeRange: {} }] },
    { paAssignments: [{ ...demo.paAssignments[0], role: 'operator' }] },
    { stages: [{ ...demo.stages[0], plannedEndTime: null }] },
  ]

  for (const collection of malformed) {
    assert.equal(parsePersistedState(JSON.stringify({
      ...empty,
      ...collection,
    })), undefined)
  }
  assert.ok(parsePersistedState(JSON.stringify({
    ...empty,
    events: [{ ...demo.events[0], futureField: 'allowed' }],
  })))
})
