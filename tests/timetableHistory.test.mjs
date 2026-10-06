import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TIMETABLE_HISTORY_LIMIT,
  areTimetableEditSnapshotsEqual,
  createTimetableHistoryState,
  recordTimetableHistory,
  redoTimetableHistory,
  undoTimetableHistory,
} from '../src/ui/timetableHistory.ts'

const snapshot = (marker = 0, overrides = {}) => ({
  stages: [{ id: 'stage-1', eventDayId: 'day-1', name: `Stage ${marker}`, order: 0,
    plannedStartTime: '10:00' }],
  eventBands: [{ id: `band-${marker}`, eventId: 'event-1', eventDayId: 'day-1',
    name: `Band ${marker}`, memberIds: [], durationMinutes: 10 }],
  scheduleItems: [{ id: `item-${marker}`, kind: 'performance', stageId: 'stage-1',
    eventBandId: `band-${marker}`, order: marker }],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
  timetableLocks: [],
  timetableOrderConstraints: [],
  ...overrides,
})

const entry = (marker = 0, context = { eventDayId: 'day-1', stageId: 'stage-1' },
  overrides = {}) => ({ snapshot: snapshot(marker, overrides), context })

test('初期historyはUndo / Redo不可で、1変更record後だけUndo可能になる', () => {
  const initial = createTimetableHistoryState(entry())
  assert.equal(initial.past.length, 0)
  assert.equal(initial.future.length, 0)
  assert.equal(undoTimetableHistory(initial).changed, false)
  assert.equal(redoTimetableHistory(initial).changed, false)

  const changed = recordTimetableHistory(initial, entry(1))
  assert.equal(changed.past.length, 1)
  assert.equal(undoTimetableHistory(changed).changed, true)
})

test('Undoでprevious snapshot、Redoでnext snapshotをcontextごと復元する', () => {
  const initial = createTimetableHistoryState(entry(0))
  const changed = recordTimetableHistory(initial, entry(1, {
    eventDayId: 'day-2', stageId: 'stage-2',
  }))
  const undone = undoTimetableHistory(changed)
  assert.deepEqual(undone.entry.snapshot, snapshot(0))
  assert.deepEqual(undone.entry.context, { eventDayId: 'day-2', stageId: 'stage-2' })

  const redone = redoTimetableHistory(undone.state)
  assert.deepEqual(redone.entry.snapshot, snapshot(1))
  assert.deepEqual(redone.entry.context, { eventDayId: 'day-2', stageId: 'stage-2' })
})

test('異なるscopeの連続操作でもUndo / Redo対象のcontextを復元する', () => {
  const dayOneContext = { eventDayId: 'day-1', stageId: 'stage-1' }
  const dayTwoContext = { eventDayId: 'day-2', stageId: 'stage-2' }
  const afterDayOneEdit = recordTimetableHistory(
    createTimetableHistoryState(entry(0, dayOneContext)),
    entry(1, dayOneContext),
  )
  const afterDayTwoEdit = recordTimetableHistory(
    afterDayOneEdit,
    entry(2, dayTwoContext),
  )

  const undoDayTwo = undoTimetableHistory(afterDayTwoEdit)
  assert.deepEqual(undoDayTwo.entry.context, dayTwoContext)
  const undoDayOne = undoTimetableHistory(undoDayTwo.state)
  assert.deepEqual(undoDayOne.entry.context, dayOneContext)

  const redoDayOne = redoTimetableHistory(undoDayOne.state)
  assert.deepEqual(redoDayOne.entry.context, dayOneContext)
  const redoDayTwo = redoTimetableHistory(redoDayOne.state)
  assert.deepEqual(redoDayTwo.entry.context, dayTwoContext)
})

test('Undo後の新規編集はfutureをclearする', () => {
  const afterTwoEdits = recordTimetableHistory(
    recordTimetableHistory(createTimetableHistoryState(entry(0)), entry(1)),
    entry(2),
  )
  const undone = undoTimetableHistory(afterTwoEdits)
  assert.equal(undone.state.future.length, 1)

  const branched = recordTimetableHistory(undone.state, entry(3))
  assert.equal(branched.future.length, 0)
  assert.equal(redoTimetableHistory(branched).changed, false)
})

test('historyは最大50件で古いentryからdropする', () => {
  let history = createTimetableHistoryState(entry(0))
  for (let marker = 1; marker <= TIMETABLE_HISTORY_LIMIT + 5; marker += 1) {
    history = recordTimetableHistory(history, entry(marker))
  }

  assert.equal(history.past.length, TIMETABLE_HISTORY_LIMIT)
  assert.equal(history.past[0].snapshot.stages[0].name, 'Stage 5')
})

test('semantic no-opはarray参照が異なってもrecordしない', () => {
  const initial = createTimetableHistoryState(entry(0))
  const equalEntry = structuredClone(entry(0))

  assert.equal(areTimetableEditSnapshotsEqual(initial.present.snapshot, equalEntry.snapshot), true)
  assert.equal(recordTimetableHistory(initial, equalEntry), initial)
})

test('snapshotとhistory entryは入力を変更せずaliasingしない', () => {
  const source = entry(0)
  const original = structuredClone(source)
  const history = createTimetableHistoryState(source)
  source.snapshot.stages[0].name = 'mutated source'
  source.context.stageId = 'mutated-stage'

  assert.deepEqual(history.present, original)
  const next = entry(1)
  const nextOriginal = structuredClone(next)
  const recorded = recordTimetableHistory(history, next)
  next.snapshot.eventBands[0].name = 'mutated next'
  assert.deepEqual(recorded.present, nextOriginal)
})

test('eventBands orderをUndo / Redoで復元する', () => {
  const firstBands = [snapshot(1).eventBands[0], snapshot(2).eventBands[0]]
  const secondBands = [...firstBands].reverse()
  const initial = createTimetableHistoryState(entry(0, undefined, { eventBands: firstBands }))
  const changed = recordTimetableHistory(initial, entry(0, undefined, {
    eventBands: secondBands,
  }))

  assert.deepEqual(undoTimetableHistory(changed).entry.snapshot.eventBands, firstBands)
  assert.deepEqual(
    redoTimetableHistory(undoTimetableHistory(changed).state).entry.snapshot.eventBands,
    secondBands,
  )
})

test('scheduleItems + timetableLocksを1 entryとしてatomicに復元する', () => {
  const base = entry(0)
  const changedEntry = entry(1, undefined, {
    timetableLocks: [{ id: 'lock-1', eventId: 'event-1', scheduleItemId: 'item-1',
      stageId: 'stage-1', position: { kind: 'first' } }],
  })
  const history = recordTimetableHistory(createTimetableHistoryState(base), changedEntry)

  assert.deepEqual(undoTimetableHistory(history).entry.snapshot, base.snapshot)
  assert.deepEqual(
    redoTimetableHistory(undoTimetableHistory(history).state).entry.snapshot,
    changedEntry.snapshot,
  )
})

test('scheduleItems + PAをgeneration-likeな1 entryとしてatomicに復元する', () => {
  const base = entry(0)
  const changedEntry = entry(1, undefined, {
    paAssignments: [{ id: 'pa-1', eventId: 'event-1', eventDayId: 'day-1',
      stageId: 'stage-1', memberId: 'member-1', role: 'main',
      from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' } }],
  })
  const history = recordTimetableHistory(createTimetableHistoryState(base), changedEntry)

  assert.deepEqual(undoTimetableHistory(history).entry.snapshot, base.snapshot)
  assert.deepEqual(
    redoTimetableHistory(undoTimetableHistory(history).state).entry.snapshot,
    changedEntry.snapshot,
  )
})

test('scheduleItems + PA + Duty + locksをreset-likeな1 entryとしてatomicに復元する', () => {
  const base = entry(0)
  const compound = entry(1, { eventDayId: 'day-1', stageId: 'stage-1' }, {
    paAssignments: [{ id: 'pa-1', eventId: 'event-1', eventDayId: 'day-1',
      stageId: 'stage-1', memberId: 'member-1', role: 'main',
      from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' } }],
    dutyTypes: [{ id: 'duty-type-1', eventId: 'event-1', name: '撮影', order: 0 }],
    dutyAssignments: [{ id: 'duty-1', dutyTypeId: 'duty-type-1', eventDayId: 'day-1',
      stageId: 'stage-1', memberId: 'member-2',
      from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' } }],
    timetableLocks: [{ id: 'lock-1', eventId: 'event-1', scheduleItemId: 'item-1',
      stageId: 'stage-1', position: { kind: 'first' } }],
    timetableOrderConstraints: [{ id: 'order-1', eventId: 'event-1',
      eventDayId: 'day-1', stageId: 'stage-1', eventBandIds: ['band-1', 'band-2'] }],
  })
  const changed = recordTimetableHistory(createTimetableHistoryState(base), compound)
  assert.equal(changed.past.length, 1)
  assert.deepEqual(undoTimetableHistory(changed).entry.snapshot, base.snapshot)
  assert.deepEqual(
    redoTimetableHistory(undoTimetableHistory(changed).state).entry.snapshot,
    compound.snapshot,
  )
})

test('TimetableOrderConstraint変更を1 entryとして復元する', () => {
  const base = entry(0)
  const changedEntry = entry(0, undefined, {
    timetableOrderConstraints: [{ id: 'order-1', eventId: 'event-1',
      eventDayId: 'day-1', stageId: 'stage-1', eventBandIds: ['band-1', 'band-2'] }],
  })
  const history = recordTimetableHistory(createTimetableHistoryState(base), changedEntry)

  assert.deepEqual(undoTimetableHistory(history).entry.snapshot, base.snapshot)
  assert.deepEqual(
    redoTimetableHistory(undoTimetableHistory(history).state)
      .entry.snapshot.timetableOrderConstraints,
    changedEntry.snapshot.timetableOrderConstraints,
  )
})

test('同じ操作列はdeterministicなhistoryを返す', () => {
  const run = () => {
    let history = createTimetableHistoryState(entry(0))
    history = recordTimetableHistory(history, entry(1))
    history = recordTimetableHistory(history, entry(2))
    return redoTimetableHistory(undoTimetableHistory(history).state).state
  }
  assert.deepEqual(run(), run())
})
