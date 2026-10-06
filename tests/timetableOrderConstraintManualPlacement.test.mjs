import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateTimetableOrderConstraintManualTransition,
} from '../src/domain/timetableOrderConstraintManualPlacement.ts'

const eventDays = [
  { id: 'day-1', eventId: 'event-1', date: '2027-01-01', order: 0 },
  { id: 'day-2', eventId: 'event-1', date: '2027-01-02', order: 1 },
]
const stages = [
  { id: 'stage-1', eventDayId: 'day-1', name: 'Main', order: 0, plannedStartTime: '10:00' },
  { id: 'stage-2', eventDayId: 'day-1', name: 'Sub', order: 1, plannedStartTime: '10:00' },
  { id: 'stage-day-2', eventDayId: 'day-2', name: 'Day 2', order: 0, plannedStartTime: '10:00' },
]
const sections = [
  { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
  { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1 },
  { id: 'section-day-2', stageId: 'stage-day-2', name: '別日', order: 0 },
]
const eventBands = [
  ...['a', 'b', 'c', 'x', 'y'].map(id => ({
    id: `band-${id}`, eventId: 'event-1', eventDayId: 'day-1', name: id.toUpperCase(),
    memberIds: [`member-${id}`], durationMinutes: 10,
  })),
  ...['a', 'b'].map(id => ({
    id: `day-2-band-${id}`, eventId: 'event-1', eventDayId: 'day-2', name: `D2${id}`,
    memberIds: [`day-2-member-${id}`], durationMinutes: 10,
  })),
]

const constraint = (overrides = {}) => ({
  id: 'order-1', eventId: 'event-1', eventDayId: 'day-1',
  stageId: 'stage-1', sectionId: 'section-1',
  eventBandIds: ['band-a', 'band-b', 'band-c'],
  ...overrides,
})

const performance = (eventBandId, order, overrides = {}) => ({
  id: `item-${eventBandId}`, kind: 'performance', eventBandId,
  stageId: 'stage-1', sectionId: 'section-1', order,
  ...overrides,
})

const breakItem = (order, overrides = {}) => ({
  id: `break-${order}`, kind: 'break', title: '休憩', durationMinutes: 5,
  stageId: 'stage-1', sectionId: 'section-1', order,
  ...overrides,
})

const schedule = (...bandIds) => bandIds.map((eventBandId, order) =>
  performance(eventBandId, order))

const evaluate = ({
  constraints = [constraint()],
  current = [],
  candidate = current,
  eventDayId = 'day-1',
} = {}) => evaluateTimetableOrderConstraintManualTransition({
  eventId: 'event-1',
  eventDayId,
  timetableOrderConstraints: constraints,
  currentScheduleItems: current,
  candidateScheduleItems: candidate,
  eventDays,
  stages,
  sections,
  eventBands,
})

test('constraintがなければcandidateを許可する', () => {
  assert.equal(evaluate({ constraints: [], candidate: schedule('band-c', 'band-a') }).allowed, true)
})

test('Aだけを正しいlaneへ配置するpartial scheduleを許可する', () => {
  assert.equal(evaluate({ candidate: schedule('band-a') }).allowed, true)
})

test('Bだけを正しいlaneへ配置するpartial scheduleを許可する', () => {
  assert.equal(evaluate({ candidate: schedule('band-b') }).allowed, true)
})

test('constrained Bandをwrong Sectionへ配置するとrejectする', () => {
  const result = evaluate({
    candidate: [performance('band-a', 0, { sectionId: 'section-2' })],
  })
  assert.equal(result.allowed, false)
  assert.deepEqual(result.introducedIssues.map(issue => issue.code), ['LANE_MISMATCH'])
})

test('B missingでもAからCの順序と連続性を満たせば許可する', () => {
  assert.equal(evaluate({ candidate: schedule('band-a', 'band-c') }).allowed, true)
})

test('B missingでCからAへ逆転するとrejectする', () => {
  const result = evaluate({ candidate: schedule('band-c', 'band-a') })
  assert.equal(result.allowed, false)
  assert.ok(result.introducedIssues.some(issue => issue.code === 'ORDER_MISMATCH'))
})

test('partial blockのAとCの間へXを配置するとrejectする', () => {
  const result = evaluate({ candidate: schedule('band-a', 'band-x', 'band-c') })
  assert.equal(result.allowed, false)
  assert.ok(result.introducedIssues.some(issue => issue.code === 'BLOCK_INTRUSION'))
})

test('AとCの間のBreakはPerformance adjacencyを壊さない', () => {
  const result = evaluate({
    candidate: [performance('band-a', 0), breakItem(1), performance('band-c', 2)],
  })
  assert.equal(result.allowed, true)
})

test('complete block内へunconstrained Xを挿入するとrejectする', () => {
  const result = evaluate({ candidate: schedule('band-a', 'band-b', 'band-x', 'band-c') })
  assert.equal(result.allowed, false)
  assert.ok(result.introducedIssues.some(issue => issue.code === 'BLOCK_INTRUSION'))
})

test('block外のunconstrained Band reorderを許可する', () => {
  const current = schedule('band-a', 'band-b', 'band-c', 'band-x', 'band-y')
  const candidate = schedule('band-a', 'band-b', 'band-c', 'band-y', 'band-x')
  assert.equal(evaluate({ current, candidate }).allowed, true)
})

test('constraint Bandをpoolへ戻す操作をmissing扱いで許可する', () => {
  const current = schedule('band-a', 'band-b', 'band-c')
  const candidate = schedule('band-a', 'band-c')
  assert.equal(evaluate({ current, candidate }).allowed, true)
})

test('既存intrusionを1件ずつ減らすincremental repairを許可する', () => {
  const current = schedule('band-a', 'band-x', 'band-b', 'band-y', 'band-c')
  const candidate = schedule('band-a', 'band-b', 'band-y', 'band-c', 'band-x')
  const result = evaluate({ current, candidate })
  assert.equal(result.allowed, true)
  assert.equal(result.currentIssues.filter(issue => issue.code === 'BLOCK_INTRUSION').length, 2)
  assert.equal(result.candidateIssues.filter(issue => issue.code === 'BLOCK_INTRUSION').length, 1)
})

test('issue件数が同じでも新しいviolationを追加すればrejectする', () => {
  const current = schedule('band-a', 'band-x', 'band-b')
  const candidate = schedule('band-a', 'band-y', 'band-b')
  const result = evaluate({ current, candidate })
  assert.equal(result.currentIssues.length, result.candidateIssues.length)
  assert.equal(result.allowed, false)
  assert.equal(result.introducedIssues[0].eventBandIds[0], 'band-y')
})

test('compatible fragmentをmerged A→B→C blockとしてenforceする', () => {
  const constraints = [
    constraint({ id: 'a-b', eventBandIds: ['band-a', 'band-b'] }),
    constraint({ id: 'b-c', eventBandIds: ['band-b', 'band-c'] }),
  ]
  const result = evaluate({ constraints, candidate: schedule('band-a', 'band-x', 'band-c') })
  assert.equal(result.allowed, false)
  assert.ok(result.introducedIssues.some(issue => issue.code === 'BLOCK_INTRUSION'))
})

test('Breakを移動してもPerformance adjacencyが同じなら許可する', () => {
  const current = [performance('band-a', 0), breakItem(1), performance('band-b', 2)]
  const candidate = [breakItem(0), performance('band-a', 1), performance('band-b', 2)]
  assert.equal(evaluate({ current, candidate }).allowed, true)
})

test('semantic invalid constraintをmanual enforcementから除外する', () => {
  const invalid = constraint({ eventBandIds: ['band-a'] })
  assert.equal(evaluate({
    constraints: [invalid],
    candidate: schedule('band-a', 'band-x'),
  }).allowed, true)
})

test('invalid siblingがあってもsemantic-valid constraintをenforceする', () => {
  const constraints = [
    constraint({ id: 'invalid', eventBandIds: ['band-c'] }),
    constraint({ id: 'valid', eventBandIds: ['band-a', 'band-b'] }),
  ]
  const result = evaluate({ constraints, candidate: schedule('band-a', 'band-x', 'band-b') })
  assert.equal(result.allowed, false)
  assert.ok(result.introducedIssues.some(issue => issue.code === 'BLOCK_INTRUSION'))
})

test('既存lane mismatchがあっても正しいlane内の新規intrusionを見逃さない', () => {
  const wrongLaneA = performance('band-a', 0, {
    stageId: 'stage-2', sectionId: undefined,
  })
  const current = [wrongLaneA, ...schedule('band-b', 'band-c')]
  const candidate = [wrongLaneA, ...schedule('band-b', 'band-x', 'band-c')]
  const result = evaluate({ current, candidate })

  assert.equal(result.allowed, false)
  assert.ok(result.currentIssues.some(issue => issue.code === 'LANE_MISMATCH'))
  assert.ok(result.introducedIssues.some(issue => issue.code === 'BLOCK_INTRUSION'))
})

test('完全に別EventDayのconstraintはcurrent dayをblockしない', () => {
  const otherDay = constraint({
    id: 'day-2-order', eventDayId: 'day-2', stageId: 'stage-day-2',
    sectionId: 'section-day-2', eventBandIds: ['day-2-band-a', 'day-2-band-b'],
  })
  assert.equal(evaluate({
    constraints: [otherDay],
    candidate: schedule('band-a', 'band-x', 'band-b'),
  }).allowed, true)
})

test('duplicate constraint IDをsemantic invalidとしてenforcementから除外する', () => {
  const constraints = [
    constraint({ id: 'duplicate', eventBandIds: ['band-a', 'band-b'] }),
    constraint({ id: 'duplicate', eventBandIds: ['band-b', 'band-c'] }),
  ]
  assert.equal(evaluate({
    constraints,
    candidate: schedule('band-a', 'band-x', 'band-b', 'band-c'),
  }).allowed, true)
})

test('manual issue fingerprintと評価結果はdeterministicでinputを変更しない', () => {
  const constraints = [constraint()]
  const current = schedule('band-a', 'band-b')
  const candidate = [
    ...schedule('band-a', 'band-x', 'band-b'),
    performance('band-c', 0, { id: 'wrong-lane-c', stageId: 'stage-2', sectionId: undefined }),
  ]
  const input = { constraints, current, candidate }
  const original = structuredClone(input)
  const first = evaluate(input)
  const second = evaluate(input)

  assert.deepEqual(first, second)
  assert.deepEqual(input, original)
  assert.deepEqual(first.introducedIssues.map(issue => issue.key),
    [...first.introducedIssues.map(issue => issue.key)].sort())
})

test('constrained Bandのduplicate schedule placementをrejectする', () => {
  const candidate = [
    performance('band-a', 0, { id: 'item-a-1' }),
    performance('band-a', 1, { id: 'item-a-2' }),
  ]
  const result = evaluate({ candidate })
  assert.equal(result.allowed, false)
  assert.deepEqual(result.introducedIssues.map(issue => issue.code), ['DUPLICATE_EVENT_BAND'])
})
