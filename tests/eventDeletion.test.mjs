import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkEventDeletion,
  createEventDeletion,
} from '../src/domain/eventDeletion.ts'
import {
  CURRENT_STORAGE_VERSION,
  parsePersistedState,
  serializePersistedState,
} from '../src/persistence/localPersistence.ts'

const timeBoundary = (time) => ({ kind: 'time', time })
const scheduleItemBoundary = (scheduleItemId, edge = 'start') => ({
  kind: 'schedule-item',
  scheduleItemId,
  edge,
})

const createInput = (overrides = {}) => ({
  eventId: 'event-a',
  events: [
    { id: 'event-a', name: 'Event A', timeZone: 'Asia/Tokyo', validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 }, performanceSlotMinutes: [10] },
    { id: 'event-b', name: 'Event B', timeZone: 'Asia/Tokyo', validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 }, performanceSlotMinutes: [10] },
  ],
  eventDays: [
    { id: 'day-a', eventId: 'event-a', date: '2026-10-01', order: 0 },
    { id: 'day-b', eventId: 'event-b', date: '2026-10-02', order: 0 },
  ],
  stages: [
    { id: 'stage-a', eventDayId: 'day-a', name: 'A', order: 0, plannedStartTime: '10:00' },
    { id: 'stage-b', eventDayId: 'day-b', name: 'B', order: 0, plannedStartTime: '10:00' },
  ],
  sections: [
    { id: 'section-a', stageId: 'stage-a', name: 'A-1', order: 0 },
    { id: 'section-b', stageId: 'stage-b', name: 'B-1', order: 0 },
  ],
  eventMembers: [
    { id: 'event-member-a', eventId: 'event-a', memberId: 'member-a', paCapabilities: { main: true, sub: true } },
    { id: 'event-member-b', eventId: 'event-b', memberId: 'member-b', paCapabilities: { main: true, sub: true } },
  ],
  eventMemberDays: [
    { id: 'member-day-a', eventMemberId: 'event-member-a', eventDayId: 'day-a', participationStatus: 'participating' },
    { id: 'member-day-b', eventMemberId: 'event-member-b', eventDayId: 'day-b', participationStatus: 'participating' },
  ],
  eventBands: [
    { id: 'event-band-a', eventId: 'event-a', eventDayId: 'day-a', name: 'Band A', memberIds: ['member-a'], durationMinutes: 10, fixedPlacement: { stageId: 'stage-a', sectionId: 'section-a' } },
    { id: 'event-band-b', eventId: 'event-b', eventDayId: 'day-b', name: 'Band B', memberIds: ['member-b'], durationMinutes: 10, fixedPlacement: { stageId: 'stage-b', sectionId: 'section-b' } },
  ],
  scheduleItems: [
    { id: 'item-a', kind: 'performance', stageId: 'stage-a', sectionId: 'section-a', eventBandId: 'event-band-a', order: 0 },
    { id: 'item-b', kind: 'performance', stageId: 'stage-b', sectionId: 'section-b', eventBandId: 'event-band-b', order: 0 },
  ],
  paAssignments: [
    { id: 'pa-a', eventId: 'event-a', eventDayId: 'day-a', stageId: 'stage-a', memberId: 'member-a', role: 'main', from: timeBoundary('10:00'), until: timeBoundary('11:00') },
    { id: 'pa-b', eventId: 'event-b', eventDayId: 'day-b', stageId: 'stage-b', memberId: 'member-b', role: 'main', from: timeBoundary('10:00'), until: timeBoundary('11:00') },
  ],
  dutyTypes: [
    { id: 'duty-a', eventId: 'event-a', name: '受付', order: 0 },
    { id: 'duty-b', eventId: 'event-b', name: '受付', order: 0 },
  ],
  dutyAssignments: [
    { id: 'assignment-a', dutyTypeId: 'duty-a', eventDayId: 'day-a', stageId: 'stage-a', memberId: 'member-a', from: timeBoundary('10:00'), until: timeBoundary('11:00') },
    { id: 'assignment-b', dutyTypeId: 'duty-b', eventDayId: 'day-b', stageId: 'stage-b', memberId: 'member-b', from: timeBoundary('10:00'), until: timeBoundary('11:00') },
  ],
  timetableLocks: [
    { id: 'lock-a', eventId: 'event-a', scheduleItemId: 'item-a', stageId: 'stage-a', sectionId: 'section-a', position: { kind: 'first' } },
    { id: 'lock-b', eventId: 'event-b', scheduleItemId: 'item-b', stageId: 'stage-b', sectionId: 'section-b', position: { kind: 'first' } },
  ],
  timetableOrderConstraints: [
    { id: 'constraint-a', eventId: 'event-a', eventDayId: 'day-a', stageId: 'stage-a', sectionId: 'section-a', eventBandIds: ['event-band-a'] },
    { id: 'constraint-b', eventId: 'event-b', eventDayId: 'day-b', stageId: 'stage-b', sectionId: 'section-b', eventBandIds: ['event-band-b'] },
  ],
  ...overrides,
})

const createInputWithAmbiguousForeignScheduleItem = (overrides = {}) => {
  const base = createInput()
  return createInput({
    events: [
      ...base.events,
      { id: 'event-c', name: 'Event C', timeZone: 'Asia/Tokyo', validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 }, performanceSlotMinutes: [10] },
    ],
    eventDays: [
      ...base.eventDays,
      { id: 'day-c', eventId: 'event-c', date: '2026-10-03', order: 0 },
    ],
    eventBands: [
      ...base.eventBands,
      { id: 'event-band-c', eventId: 'event-c', eventDayId: 'day-c', name: 'Band C', memberIds: [], durationMinutes: 10 },
    ],
    scheduleItems: [
      ...base.scheduleItems,
      { id: 'item-bc', kind: 'performance', stageId: 'stage-b', eventBandId: 'event-band-c', order: 1 },
    ],
    ...overrides,
  })
}

test('Eventと所有する全イベントデータをcascade削除し、他Eventを完全に維持する', () => {
  const input = createInput()
  const before = structuredClone(input)
  assert.deepEqual(checkEventDeletion(input), { ok: true })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  for (const key of ['events', 'eventDays', 'stages', 'sections', 'eventMembers', 'eventMemberDays', 'eventBands', 'scheduleItems', 'paAssignments', 'dutyTypes', 'dutyAssignments', 'timetableLocks', 'timetableOrderConstraints']) {
    assert.equal(result[key].length, 1, key)
    assert.match(result[key][0].id, /-b$/, key)
  }
  assert.equal(result.events[0], input.events[1])
  assert.equal(result.scheduleItems[0], input.scheduleItems[1])
  assert.deepEqual(input, before)
})

test('存在しないEventは削除せずEVENT_NOT_FOUNDを返す', () => {
  const input = createInput({ eventId: 'missing-event' })
  const expected = { ok: false, reason: 'EVENT_NOT_FOUND' }
  assert.deepEqual(checkEventDeletion(input), expected)
  assert.deepEqual(createEventDeletion(input), expected)
})

test('配下データがないEventはEvent本体だけを削除する', () => {
  const input = createInput({
    eventDays: [], stages: [], sections: [], eventMembers: [],
    eventMemberDays: [], eventBands: [], scheduleItems: [], paAssignments: [],
    dutyTypes: [], dutyAssignments: [], timetableLocks: [],
    timetableOrderConstraints: [],
  })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.events.map((event) => event.id), ['event-b'])
})

test('最後のEventも自動生成や代替選択をせず空のeventsへ削除できる', () => {
  const input = createInput({
    events: [createInput().events[0]],
    eventDays: [], stages: [], sections: [], eventMembers: [],
    eventMemberDays: [], eventBands: [], scheduleItems: [], paAssignments: [],
    dutyTypes: [], dutyAssignments: [], timetableLocks: [],
    timetableOrderConstraints: [],
  })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.events, [])
})

test('対象StageのPerformanceとBreakを削除し他Eventの両kindを維持する', () => {
  const input = createInput({
    scheduleItems: [
      { id: 'performance-a', kind: 'performance', stageId: 'stage-a', sectionId: 'section-a', eventBandId: 'event-band-a', order: 0 },
      { id: 'break-a', kind: 'break', stageId: 'stage-a', sectionId: 'section-a', title: '休憩', durationMinutes: 5, order: 1 },
      { id: 'performance-b', kind: 'performance', stageId: 'stage-b', sectionId: 'section-b', eventBandId: 'event-band-b', order: 0 },
      { id: 'break-b', kind: 'break', stageId: 'stage-b', sectionId: 'section-b', title: '休憩', durationMinutes: 5, order: 1 },
    ],
    timetableLocks: [],
  })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.scheduleItems.map((item) => item.id), [
    'performance-b',
    'break-b',
  ])
})

test('target Event所有データの参照先が欠落していても自動修復せずcascade削除する', () => {
  const input = createInput({
    eventBands: [{ id: 'event-band-a', eventId: 'event-a', eventDayId: 'missing-day', name: 'broken', memberIds: [], durationMinutes: 10, fixedPlacement: { stageId: 'missing-stage' } }],
    timetableLocks: [{ id: 'lock-a', eventId: 'event-a', scheduleItemId: 'missing-item', stageId: 'missing-stage', position: { kind: 'first' } }],
    timetableOrderConstraints: [{ id: 'constraint-a', eventId: 'event-a', eventDayId: 'missing-day', stageId: 'missing-stage', eventBandIds: ['missing-band'] }],
  })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventBands, [])
  assert.deepEqual(result.timetableLocks, [])
  assert.deepEqual(result.timetableOrderConstraints, [])
})

test('targetと他Eventをまたぐ解決可能な参照矛盾はfail closedしinputを変更しない', () => {
  const conflicts = [
    ['EventMemberDay', { eventMemberDays: [{ id: 'conflict', eventMemberId: 'event-member-a', eventDayId: 'day-b', participationStatus: 'participating' }] }],
    ['EventBand day', { eventBands: [{ id: 'conflict', eventId: 'event-a', eventDayId: 'day-b', name: 'conflict', memberIds: [], durationMinutes: 10 }] }],
    ['EventBand fixed placement', { eventBands: [{ id: 'conflict', eventId: 'event-a', eventDayId: 'day-a', name: 'conflict', memberIds: [], durationMinutes: 10, fixedPlacement: { stageId: 'stage-b' } }] }],
    ['ScheduleItem', { scheduleItems: [{ id: 'conflict', kind: 'performance', stageId: 'stage-a', eventBandId: 'event-band-b', order: 0 }] }],
    ['PA', { paAssignments: [{ id: 'conflict', eventId: 'event-a', eventDayId: 'day-a', stageId: 'stage-b', memberId: 'member-a', role: 'main', from: timeBoundary('10:00'), until: timeBoundary('11:00') }] }],
    ['Duty', { dutyAssignments: [{ id: 'conflict', dutyTypeId: 'duty-a', eventDayId: 'day-b', stageId: 'stage-b', memberId: 'member-a', from: timeBoundary('10:00'), until: timeBoundary('11:00') }] }],
    ['Lock', { timetableLocks: [{ id: 'conflict', eventId: 'event-b', scheduleItemId: 'item-a', stageId: 'stage-a', position: { kind: 'first' } }] }],
    ['OrderConstraint', { timetableOrderConstraints: [{ id: 'conflict', eventId: 'event-b', eventDayId: 'day-b', stageId: 'stage-b', eventBandIds: ['event-band-a'] }] }],
  ]
  for (const [label, override] of conflicts) {
    const input = createInput(override)
    const before = structuredClone(input)
    const expected = { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    assert.deepEqual(checkEventDeletion(input), expected, label)
    assert.deepEqual(createEventDeletion(input), expected, label)
    assert.deepEqual(input, before, label)
  }
})

test('欠落参照を含む子要素も解決可能なtarget所有関係から削除する', () => {
  const input = createInput({
    scheduleItems: [{ id: 'item-a', kind: 'performance', stageId: 'missing-stage', eventBandId: 'event-band-a', order: 0 }],
    dutyAssignments: [{ id: 'assignment-a', dutyTypeId: 'missing-duty', eventDayId: 'day-a', stageId: 'missing-stage', memberId: 'member-a', from: timeBoundary('10:00'), until: timeBoundary('11:00') }],
    timetableLocks: [],
  })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.scheduleItems, [])
  assert.deepEqual(result.dutyAssignments, [])
})

test('foreign owners {B,C}の既存ScheduleItemをtarget Lockが参照したらconflictにする', () => {
  const input = createInputWithAmbiguousForeignScheduleItem({
    timetableLocks: [{
      id: 'lock-a', eventId: 'event-a', scheduleItemId: 'item-bc',
      stageId: 'missing-stage', position: { kind: 'first' },
    }],
  })
  assert.deepEqual(createEventDeletion(input), {
    ok: false,
    reason: 'EVENT_RELATIONSHIP_CONFLICT',
  })
})

test('foreign owners {B,C}の既存ScheduleItemをtarget PA Boundaryが参照したらconflictにする', () => {
  const input = createInputWithAmbiguousForeignScheduleItem({
    paAssignments: [{
      id: 'pa-a', eventId: 'event-a', eventDayId: 'day-a', stageId: 'stage-a',
      memberId: 'member-a', role: 'main',
      from: scheduleItemBoundary('item-bc'), until: timeBoundary('11:00'),
    }],
  })
  assert.deepEqual(createEventDeletion(input), {
    ok: false,
    reason: 'EVENT_RELATIONSHIP_CONFLICT',
  })
})

test('foreign owners {B,C}の既存ScheduleItemをtarget Duty Boundaryが参照したらconflictにする', () => {
  const input = createInputWithAmbiguousForeignScheduleItem({
    dutyAssignments: [{
      id: 'assignment-a', dutyTypeId: 'duty-a', eventDayId: 'day-a',
      stageId: 'stage-a', memberId: 'member-a',
      from: scheduleItemBoundary('item-bc'), until: timeBoundary('11:00'),
    }],
  })
  assert.deepEqual(createEventDeletion(input), {
    ok: false,
    reason: 'EVENT_RELATIONSHIP_CONFLICT',
  })
})

test('targetから参照されないforeign owners {B,C}のScheduleItemは保持して削除を妨げない', () => {
  const input = createInputWithAmbiguousForeignScheduleItem()
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.scheduleItems.some((item) => item.id === 'item-bc'))
})

test('owners {A,B}のScheduleItemはtarget削除をconflictにする', () => {
  const input = createInput({
    scheduleItems: [{
      id: 'item-ab', kind: 'performance', stageId: 'stage-a',
      eventBandId: 'event-band-b', order: 0,
    }],
    timetableLocks: [],
  })
  assert.deepEqual(createEventDeletion(input), {
    ok: false,
    reason: 'EVENT_RELATIONSHIP_CONFLICT',
  })
})

test('single foreign owner {B}のScheduleItemをtarget Lockが参照したらconflictにする', () => {
  const input = createInput({
    timetableLocks: [{
      id: 'lock-a', eventId: 'event-a', scheduleItemId: 'item-b',
      stageId: 'missing-stage', position: { kind: 'first' },
    }],
  })
  assert.deepEqual(createEventDeletion(input), {
    ok: false,
    reason: 'EVENT_RELATIONSHIP_CONFLICT',
  })
})

test('missing ScheduleItemを参照するtarget Lockはbroken referenceとしてLockごと削除する', () => {
  const input = createInput({
    timetableLocks: [{
      id: 'lock-a', eventId: 'event-a', scheduleItemId: 'missing-item',
      stageId: 'missing-stage', position: { kind: 'first' },
    }],
  })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.timetableLocks, [])
})

test('全Event固有collectionのduplicate IDをownership解決前にfail closedにする', () => {
  const duplicateCases = [
    ['Event', 'events'],
    ['EventDay', 'eventDays'],
    ['Stage', 'stages'],
    ['Section', 'sections'],
    ['EventMember', 'eventMembers'],
    ['EventMemberDay', 'eventMemberDays'],
    ['EventBand', 'eventBands'],
    ['ScheduleItem', 'scheduleItems'],
    ['PA', 'paAssignments'],
    ['DutyType', 'dutyTypes'],
    ['DutyAssignment', 'dutyAssignments'],
    ['TimetableLock', 'timetableLocks'],
    ['TimetableOrderConstraint', 'timetableOrderConstraints'],
  ]

  for (const [label, key] of duplicateCases) {
    const base = createInput()
    const targetRecord = base[key][0]
    const foreignRecord = base[key][1]
    const input = createInput({
      [key]: [
        ...base[key],
        { ...foreignRecord, id: targetRecord.id },
      ],
    })
    const before = structuredClone(input)
    const expected = {
      ok: false,
      reason: 'EVENT_RELATIONSHIP_CONFLICT',
    }

    assert.deepEqual(checkEventDeletion(input), expected, label)
    assert.deepEqual(createEventDeletion(input), expected, label)
    assert.deepEqual(input, before, label)
  }
})

test('targetと無関係なduplicate IDも削除scopeを曖昧にするためfail closedにする', () => {
  const base = createInput()
  const input = createInput({
    eventDays: [...base.eventDays, { ...base.eventDays[1] }],
  })
  assert.deepEqual(createEventDeletion(input), {
    ok: false,
    reason: 'EVENT_RELATIONSHIP_CONFLICT',
  })
})

test('共通Member・Bandを保持した削除後snapshotをPersistence V5でround-tripする', () => {
  const input = createInput({ timetableOrderConstraints: [] })
  const result = createEventDeletion(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const members = [
    { id: 'member-a', realName: 'Member A', active: true },
    { id: 'member-b', realName: 'Member B', active: true },
  ]
  const bands = [
    { id: 'band-a', name: 'Band A', defaultMemberIds: ['member-a'], active: true },
    { id: 'band-b', name: 'Band B', defaultMemberIds: ['member-b'], active: true },
  ]
  const snapshot = {
    version: CURRENT_STORAGE_VERSION,
    members,
    bands,
    ...result,
  }
  delete snapshot.ok

  const parsed = parsePersistedState(serializePersistedState(snapshot))
  assert.deepEqual(parsed, snapshot)
  assert.deepEqual(parsed.members, members)
  assert.deepEqual(parsed.bands, bands)
  assert.deepEqual(parsed.events.map((event) => event.id), ['event-b'])
})
