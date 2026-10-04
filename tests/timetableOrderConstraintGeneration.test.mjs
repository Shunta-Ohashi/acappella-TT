import assert from 'node:assert/strict'
import test from 'node:test'

import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import {
  materializeTimetableGenerationPlan,
  validateTimetableGenerationCandidate,
} from '../src/domain/timetableGenerationApply.ts'
import { createGenerationUiInput } from './fixtures/timetableGenerationUi.mjs'

const orderConstraint = (overrides = {}) => ({
  id: 'order-1', eventId: 'event-a', eventDayId: 'day-a1',
  stageId: 'stage-a1', sectionId: 'section-1',
  eventBandIds: ['band-1', 'band-2'], ...overrides,
})

const unconstrainedInput = () => {
  const input = createGenerationUiInput()
  input.timetableLocks = []
  input.scheduleItems = input.scheduleItems.filter(item => item.kind === 'break' ||
    !['band-1', 'band-2'].includes(item.eventBandId))
  input.eventBands.filter(band => band.eventDayId === input.eventDay.id)
    .forEach(band => { delete band.fixedPlacement })
  return input
}

const laneOrder = (plan, stageId = 'stage-a1', sectionId = 'section-1') =>
  plan.placements.filter(item => item.stageId === stageId && item.sectionId === sectionId)
    .sort((left, right) => left.order - right.order)
    .map(item => item.eventBandId)

test('generatorは出演順DAGを候補構築へ反映し、同じ入力で決定的に生成する', () => {
  const input = unconstrainedInput()
  input.timetableOrderConstraints = [orderConstraint({ eventBandIds: ['band-2', 'band-1'] })]
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(laneOrder(result.plan), ['band-2', 'band-1'])
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('複数の出演順制約を1つのlane DAGとして統合する', () => {
  const input = unconstrainedInput()
  input.members.push({ id: 'performer-3', realName: 'Band 3', active: true })
  input.eventMembers.push({ id: 'em-performer-3', eventId: 'event-a', memberId: 'performer-3',
    paCapabilities: { main: false, sub: false } })
  input.eventMemberDays.push({ id: 'emd-performer-3', eventMemberId: 'em-performer-3',
    eventDayId: 'day-a1', participationStatus: 'participating' })
  input.eventBands.push({ id: 'band-3', eventId: 'event-a', eventDayId: 'day-a1', name: 'Band 3',
    memberIds: ['performer-3'], durationMinutes: 10 })
  input.timetableOrderConstraints = [
    orderConstraint({ id: 'order-a', eventBandIds: ['band-1', 'band-2'] }),
    orderConstraint({ id: 'order-b', eventBandIds: ['band-2', 'band-3'] }),
  ]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(laneOrder(result.plan), ['band-1', 'band-2', 'band-3'])
})

test('出演順制約は未配置Bandも指定laneへ配置する', () => {
  const input = unconstrainedInput()
  input.timetableOrderConstraints = [orderConstraint({ sectionId: 'section-2' })]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(laneOrder(result.plan, 'stage-a1', 'section-2'), ['band-1', 'band-2'])
})

test('出演順と予約positionを同時に満たし、矛盾するfirstは成功させない', () => {
  const valid = unconstrainedInput()
  valid.eventBands.find(band => band.id === 'band-1').fixedPlacement = {
    stageId: 'stage-a1', sectionId: 'section-1', position: { kind: 'first' },
  }
  valid.timetableOrderConstraints = [orderConstraint()]
  const validResult = generateTimetablePlan(valid)
  assert.equal(validResult.ok, true)
  assert.deepEqual(laneOrder(validResult.plan), ['band-1', 'band-2'])

  const invalid = unconstrainedInput()
  invalid.eventBands.find(band => band.id === 'band-2').fixedPlacement = {
    stageId: 'stage-a1', sectionId: 'section-1', position: { kind: 'first' },
  }
  invalid.timetableOrderConstraints = [orderConstraint()]
  const invalidResult = generateTimetablePlan(invalid)
  assert.equal(invalidResult.ok, false)
  assert.equal(invalidResult.failure.code, 'NO_FEASIBLE_SCHEDULE')
})

test('出演順はfixed last / indexと共存し、矛盾する予約位置を無視しない', () => {
  for (const [bandId, position, expectedOk] of [
    ['band-2', { kind: 'last' }, true],
    ['band-1', { kind: 'last' }, false],
    ['band-1', { kind: 'index', index: 0 }, true],
    ['band-2', { kind: 'index', index: 0 }, false],
  ]) {
    const input = unconstrainedInput()
    input.eventBands.find(band => band.id === bandId).fixedPlacement = {
      stageId: 'stage-a1', sectionId: 'section-1', position,
    }
    input.timetableOrderConstraints = [orderConstraint()]
    assert.equal(generateTimetablePlan(input).ok, expectedOk)
  }
})

test('出演順はTimetableLock positionと共存し、逆順ならproposalを成立させない', () => {
  const valid = createGenerationUiInput()
  valid.eventBands.find(band => band.id === 'band-2').fixedPlacement = {
    stageId: 'stage-a1', sectionId: 'section-1',
  }
  valid.timetableOrderConstraints = [orderConstraint()]
  const validResult = generateTimetablePlan(valid)
  assert.equal(validResult.ok, true)
  assert.deepEqual(laneOrder(validResult.plan), ['band-1', 'band-2'])

  const invalid = structuredClone(valid)
  invalid.timetableOrderConstraints = [orderConstraint({ eventBandIds: ['band-2', 'band-1'] })]
  const invalidResult = generateTimetablePlan(invalid)
  assert.equal(invalidResult.ok, false)
  assert.equal(invalidResult.failure.code, 'NO_FEASIBLE_SCHEDULE')
})

test('TT固定laneと出演順laneのintersectionが空なら探索前に拒否する', () => {
  const input = createGenerationUiInput()
  delete input.eventBands.find(band => band.id === 'band-1').fixedPlacement
  input.timetableOrderConstraints = [orderConstraint({ sectionId: 'section-2' })]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'INVALID_ORDER_CONSTRAINTS')
  assert.equal(result.failure.attemptedSchedules, 0)
})

test('別日の不正制約は隔離し、targetに触れるownership矛盾はfail closedする', () => {
  const isolated = unconstrainedInput()
  isolated.eventBands.push({ id: 'band-a3', eventId: 'event-a', eventDayId: 'day-a2',
    name: '翌日2', memberIds: [], durationMinutes: 10 })
  isolated.timetableOrderConstraints = [
    orderConstraint({ id: 'day2-a', eventDayId: 'day-a2', stageId: 'stage-a2', sectionId: undefined,
      eventBandIds: ['band-a2', 'band-a3'] }),
    orderConstraint({ id: 'day2-b', eventDayId: 'day-a2', stageId: 'stage-a2', sectionId: undefined,
      eventBandIds: ['band-a3', 'band-a2'] }),
  ]
  assert.equal(generateTimetablePlan(isolated).ok, true)

  const targetConflict = unconstrainedInput()
  targetConflict.timetableOrderConstraints = [orderConstraint({ eventId: 'event-b' })]
  const result = generateTimetablePlan(targetConflict)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'INVALID_ORDER_CONSTRAINTS')
  assert.equal(result.failure.attemptedSchedules, 0)
})

test('target日のcycle・重複ID・lane競合・fixedPlacement競合は専用failureになる', () => {
  const cases = [
    [
      orderConstraint({ id: 'cycle-a' }),
      orderConstraint({ id: 'cycle-b', eventBandIds: ['band-2', 'band-1'] }),
    ],
    [orderConstraint(), orderConstraint()],
    [
      orderConstraint({ id: 'lane-a' }),
      orderConstraint({ id: 'lane-b', sectionId: 'section-2' }),
    ],
  ]
  for (const timetableOrderConstraints of cases) {
    const input = unconstrainedInput()
    input.timetableOrderConstraints = timetableOrderConstraints
    const result = generateTimetablePlan(input)
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'INVALID_ORDER_CONSTRAINTS')
    assert.equal(result.failure.attemptedSchedules, 0)
  }

  const fixedConflict = unconstrainedInput()
  fixedConflict.eventBands.find(band => band.id === 'band-1').fixedPlacement = {
    stageId: 'stage-a1', sectionId: 'section-2',
  }
  fixedConflict.timetableOrderConstraints = [orderConstraint()]
  assert.equal(generateTimetablePlan(fixedConflict).failure.code, 'INVALID_ORDER_CONSTRAINTS')
})

test('malformed出演順collectionはthrowせず専用failureで探索前に拒否する', () => {
  for (const timetableOrderConstraints of [null, [null], [orderConstraint({ eventBandIds: ['band-1'] })]]) {
    const input = unconstrainedInput()
    input.timetableOrderConstraints = timetableOrderConstraints
    let result
    assert.doesNotThrow(() => { result = generateTimetablePlan(input) })
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'INVALID_ORDER_CONSTRAINTS')
    assert.equal(result.failure.attemptedSchedules, 0)
  }
})

test('materialization後の最終guardは順序反転・lane移動・欠落・重複を拒否する', () => {
  const input = unconstrainedInput()
  input.timetableOrderConstraints = [orderConstraint()]
  const generated = generateTimetablePlan(input)
  assert.equal(generated.ok, true)
  const materializationInput = {
    ...input,
    sourceScheduleItems: input.scheduleItems,
    paAssignments: input.paAssignments,
    plan: generated.plan,
    newScheduleItemIds: generated.plan.placements.filter(item => item.scheduleItemId === undefined)
      .map((_, index) => `new-performance-${index}`),
    newPaAssignmentIds: generated.plan.paShifts.map((_, index) => `new-pa-${index}`),
  }
  const candidate = materializeTimetableGenerationPlan(materializationInput)
  assert.equal(candidate.ok, true)
  assert.equal(validateTimetableGenerationCandidate(materializationInput, candidate).ok, true)
  const target = candidate.scheduleItems.filter(item => item.kind === 'performance' &&
    ['band-1', 'band-2'].includes(item.eventBandId))

  const reversed = structuredClone(candidate)
  const reversedItems = reversed.scheduleItems.filter(item => target.some(source => source.id === item.id))
  ;[reversedItems[0].order, reversedItems[1].order] = [reversedItems[1].order, reversedItems[0].order]
  assert.equal(validateTimetableGenerationCandidate(materializationInput, reversed).ok, false)

  const moved = structuredClone(candidate)
  moved.scheduleItems.find(item => item.id === target[1].id).sectionId = 'section-2'
  assert.equal(validateTimetableGenerationCandidate(materializationInput, moved).ok, false)

  const missing = structuredClone(candidate)
  missing.scheduleItems = missing.scheduleItems.filter(item => item.id !== target[1].id)
  assert.equal(validateTimetableGenerationCandidate(materializationInput, missing).ok, false)

  const duplicate = structuredClone(candidate)
  duplicate.scheduleItems.push({ ...target[0], id: 'duplicate-performance', order: 99 })
  assert.equal(validateTimetableGenerationCandidate(materializationInput, duplicate).ok, false)
})
