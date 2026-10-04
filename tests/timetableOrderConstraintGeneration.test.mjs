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

const addTargetBand = (input, id, fixedPlacement) => {
  input.eventBands.push({
    id, eventId: 'event-a', eventDayId: 'day-a1', name: id,
    memberIds: [], durationMinutes: 10,
    ...(fixedPlacement ? { fixedPlacement } : {}),
  })
}

const unconstrainedInput = () => {
  const input = createGenerationUiInput()
  input.timetableLocks = []
  input.scheduleItems = input.scheduleItems.filter(item => item.kind === 'break' ||
    !['band-1', 'band-2'].includes(item.eventBandId))
  input.eventBands.filter(band => band.eventDayId === input.eventDay.id)
    .forEach(band => { delete band.fixedPlacement })
  return input
}

const blockInput = ({ unrelated = 0 } = {}) => {
  const input = unconstrainedInput()
  addTargetBand(input, 'band-3')
  for (let index = 0; index < unrelated; index += 1) {
    addTargetBand(input, `band-free-${index + 1}`, {
      stageId: 'stage-a1', sectionId: 'section-1',
    })
  }
  input.timetableOrderConstraints = [orderConstraint({
    eventBandIds: ['band-1', 'band-3', 'band-2'],
  })]
  return input
}

const laneOrder = (plan, stageId = 'stage-a1', sectionId = 'section-1') =>
  plan.placements.filter(item => item.stageId === stageId && item.sectionId === sectionId)
    .sort((left, right) => left.order - right.order)
    .map(item => item.eventBandId)

const assertContiguous = (actual, expected) => {
  const start = actual.indexOf(expected[0])
  assert.notEqual(start, -1)
  assert.deepEqual(actual.slice(start, start + expected.length), expected)
}

test('generatorは出演順を連続Performance blockとして配置し、同じ入力で決定的に生成する', () => {
  const input = blockInput({ unrelated: 1 })
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assertContiguous(laneOrder(result.plan), ['band-1', 'band-3', 'band-2'])
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('compatibleな複数fragmentを1つの連続blockへ統合する', () => {
  const input = unconstrainedInput()
  addTargetBand(input, 'band-3')
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

test('3組blockはfirst / last予約と共存し、中間Bandの端予約を拒否する', () => {
  for (const [bandId, position, expectedOk] of [
    ['band-1', { kind: 'first' }, true],
    ['band-2', { kind: 'last' }, true],
    ['band-3', { kind: 'first' }, false],
    ['band-3', { kind: 'last' }, false],
  ]) {
    const input = blockInput({ unrelated: 1 })
    input.eventBands.find(band => band.id === bandId).fixedPlacement = {
      stageId: 'stage-a1', position,
    }
    const result = generateTimetablePlan(input)
    assert.equal(result.ok, expectedOk)
    if (!expectedOk) assert.equal(result.failure.code, 'NO_FEASIBLE_SCHEDULE')
  }
})

test('3組blockのcompatible indexから開始位置を導き、矛盾するindexを拒否する', () => {
  for (const [bandId, index, expectedOk] of [
    ['band-1', 1, true],
    ['band-3', 2, true],
    ['band-2', 3, true],
    ['band-3', 0, false],
    ['band-2', 1, false],
  ]) {
    const input = blockInput({ unrelated: 1 })
    input.eventBands.find(band => band.id === bandId).fixedPlacement = {
      stageId: 'stage-a1', position: { kind: 'index', index },
    }
    const result = generateTimetablePlan(input)
    assert.equal(result.ok, expectedOk)
    if (expectedOk) {
      const order = laneOrder(result.plan)
      assert.equal(order.indexOf(bandId), index)
      assertContiguous(order, ['band-1', 'band-3', 'band-2'])
    } else {
      assert.equal(result.failure.code, 'NO_FEASIBLE_SCHEDULE')
    }
  }
})

test('同じblockの複数予約位置は同じ開始位置を導く場合だけ成立する', () => {
  const compatible = blockInput({ unrelated: 1 })
  compatible.eventBands.find(band => band.id === 'band-1').fixedPlacement = {
    stageId: 'stage-a1', position: { kind: 'index', index: 1 },
  }
  compatible.eventBands.find(band => band.id === 'band-2').fixedPlacement = {
    stageId: 'stage-a1', position: { kind: 'index', index: 3 },
  }
  assert.equal(generateTimetablePlan(compatible).ok, true)

  const conflicting = structuredClone(compatible)
  conflicting.eventBands.find(band => band.id === 'band-2').fixedPlacement.position.index = 2
  const result = generateTimetablePlan(conflicting)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_FEASIBLE_SCHEDULE')
})

test('出演順はTimetableLock positionと共存し、block内位置が矛盾すれば成立しない', () => {
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

test('target日のcycle・block競合・重複ID・lane競合は専用failureになる', () => {
  const cases = [
    [
      orderConstraint({ id: 'cycle-a' }),
      orderConstraint({ id: 'cycle-b', eventBandIds: ['band-2', 'band-1'] }),
    ],
    [
      orderConstraint({ id: 'branch-a', eventBandIds: ['band-1', 'band-2'] }),
      orderConstraint({ id: 'branch-b', eventBandIds: ['band-1', 'band-3'] }),
    ],
    [orderConstraint(), orderConstraint()],
    [
      orderConstraint({ id: 'lane-a' }),
      orderConstraint({ id: 'lane-b', sectionId: 'section-2' }),
    ],
  ]
  for (const timetableOrderConstraints of cases) {
    const input = unconstrainedInput()
    addTargetBand(input, 'band-3')
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

test('materialization後の最終guardはblock内挿入・反転・lane移動・欠落・重複を拒否する', () => {
  const input = blockInput({ unrelated: 1 })
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
  const byBand = new Map(candidate.scheduleItems.filter(item => item.kind === 'performance')
    .map(item => [item.eventBandId, item]))

  const inserted = structuredClone(candidate)
  const insertedByBand = new Map(inserted.scheduleItems.filter(item => item.kind === 'performance')
    .map(item => [item.eventBandId, item]))
  ;['band-1', 'band-free-1', 'band-3', 'band-2'].forEach((bandId, order) => {
    insertedByBand.get(bandId).order = order
  })
  assert.equal(validateTimetableGenerationCandidate(materializationInput, inserted).ok, false)

  const reversed = structuredClone(candidate)
  const reversedByBand = new Map(reversed.scheduleItems.filter(item => item.kind === 'performance')
    .map(item => [item.eventBandId, item]))
  ;[reversedByBand.get('band-1').order, reversedByBand.get('band-3').order] =
    [reversedByBand.get('band-3').order, reversedByBand.get('band-1').order]
  assert.equal(validateTimetableGenerationCandidate(materializationInput, reversed).ok, false)

  const moved = structuredClone(candidate)
  moved.scheduleItems.find(item => item.id === byBand.get('band-2').id).sectionId = 'section-2'
  assert.equal(validateTimetableGenerationCandidate(materializationInput, moved).ok, false)

  const missing = structuredClone(candidate)
  missing.scheduleItems = missing.scheduleItems.filter(item => item.id !== byBand.get('band-2').id)
  assert.equal(validateTimetableGenerationCandidate(materializationInput, missing).ok, false)

  const duplicate = structuredClone(candidate)
  duplicate.scheduleItems.push({ ...byBand.get('band-1'), id: 'duplicate-performance', order: 99 })
  assert.equal(validateTimetableGenerationCandidate(materializationInput, duplicate).ok, false)
})
