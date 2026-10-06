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

const setBandAvailabilityFrom = (input, bandIds, from) => {
  const memberIds = new Set(input.eventBands
    .filter(band => bandIds.includes(band.id))
    .flatMap(band => band.memberIds))
  const eventMemberIds = new Set(input.eventMembers
    .filter(member => memberIds.has(member.memberId))
    .map(member => member.id))
  input.eventMemberDays.filter(day => eventMemberIds.has(day.eventMemberId))
    .forEach(day => { day.availabilityWindows = [{ from }] })
}

const blockPlacementInput = ({ unrelated = 0, availableFrom } = {}) => {
  const input = unconstrainedInput()
  input.sections.find(section => section.id === 'section-2').plannedStartTime = '12:00'
  for (let index = 0; index < unrelated; index += 1) {
    addTargetBand(input, `band-free-${index + 1}`, {
      stageId: 'stage-a1', sectionId: 'section-1',
    })
  }
  input.timetableOrderConstraints = [orderConstraint()]
  if (availableFrom) setBandAvailabilityFrom(input, ['band-1', 'band-2'], availableFrom)
  return input
}

const memberAwareBlockFallbackInput = () => {
  const input = blockPlacementInput({ unrelated: 3 })
  const firstFree = input.eventBands.find(band => band.id === 'band-free-1')
  const secondFree = input.eventBands.find(band => band.id === 'band-free-2')
  const thirdFree = input.eventBands.find(band => band.id === 'band-free-3')
  input.members.push({ id: 'shared-member', realName: '掛け持ち', active: true })
  input.eventMembers.push({
    id: 'em-shared-member', eventId: input.event.id, memberId: 'shared-member',
    paCapabilities: { main: false, sub: false },
  })
  input.eventMemberDays.push({
    id: 'emd-shared-member', eventMemberId: 'em-shared-member',
    eventDayId: input.eventDay.id, participationStatus: 'participating',
  })
  firstFree.memberIds = ['performer-2', 'shared-member']
  firstFree.availableTimeRange = { from: '10:00', until: '10:10' }
  secondFree.availableTimeRange = { from: '10:30', until: '10:40' }
  thirdFree.memberIds = ['shared-member']
  thirdFree.availableTimeRange = { from: '10:40', until: '10:50' }
  input.activitySpacingPolicy = Object.fromEntries([
    'performance-to-performance',
    'work-to-performance',
    'performance-to-work',
    'work-to-work',
  ].map(category => [category, {
    minimumMinutes: 0, preferredMinutes: 0, sufficientMinutes: 0,
  }]))
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

test('block start 0がfeasibleなら先頭の合法配置で成功する', () => {
  const input = blockPlacementInput({ unrelated: 2 })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.equal(laneOrder(result.plan).indexOf('band-1'), 0)
})

test('先頭配置がrejectされてもstart 1の合法配置を評価して成功する', () => {
  const input = blockPlacementInput({ unrelated: 1, availableFrom: '10:10' })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.equal(laneOrder(result.plan).indexOf('band-1'), 1)
})

test('start 0と1がrejectされてもstart 2の合法配置を評価して成功する', () => {
  const input = blockPlacementInput({ unrelated: 2, availableFrom: '10:20' })
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.equal(laneOrder(result.plan).indexOf('band-1'), 2)
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('掛け持ち分離候補があっても後続の元順free block配置を小さい上限内で評価する', () => {
  const input = memberAwareBlockFallbackInput()
  input.options = { maxScheduleCandidates: 3 }
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(laneOrder(result.plan), [
    'band-free-1', 'band-1', 'band-2', 'band-free-2', 'band-free-3',
  ])
  assert.equal(result.plan.diagnostics.scheduleCandidatesEvaluated, 3)
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('最後尾のblock配置だけがfeasibleでも探索して成功する', () => {
  const input = blockPlacementInput({ unrelated: 3, availableFrom: '10:30' })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.equal(laneOrder(result.plan).indexOf('band-1'), 3)
})

test('複数blockの最初の配置組み合わせがrejectされても別の組み合わせで成功する', () => {
  const input = unconstrainedInput()
  input.sections.find(section => section.id === 'section-2').plannedStartTime = '12:00'
  addTargetBand(input, 'band-3')
  addTargetBand(input, 'band-4')
  input.timetableOrderConstraints = [
    orderConstraint({ id: 'order-a', eventBandIds: ['band-1', 'band-2'] }),
    orderConstraint({ id: 'order-b', eventBandIds: ['band-3', 'band-4'] }),
  ]
  setBandAvailabilityFrom(input, ['band-1', 'band-2'], '10:20')
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(laneOrder(result.plan), ['band-3', 'band-4', 'band-1', 'band-2'])
})

test('variantのrotationとreverseに現れない複数block配置も探索する', () => {
  const input = unconstrainedInput()
  input.sections.find(section => section.id === 'section-2').plannedStartTime = '12:00'
  for (let index = 3; index <= 8; index += 1) addTargetBand(input, `band-${index}`)
  input.timetableOrderConstraints = [
    orderConstraint({ id: 'block-a', eventBandIds: ['band-1', 'band-2'] }),
    orderConstraint({ id: 'block-b', eventBandIds: ['band-3', 'band-4'] }),
    orderConstraint({ id: 'block-c', eventBandIds: ['band-5', 'band-6'] }),
    orderConstraint({ id: 'block-d', eventBandIds: ['band-7', 'band-8'] }),
  ]
  for (const [bandIds, range] of [
    [['band-3', 'band-4'], { from: '10:00', until: '10:20' }],
    [['band-7', 'band-8'], { from: '10:20', until: '10:40' }],
    [['band-1', 'band-2'], { from: '10:40', until: '11:00' }],
    [['band-5', 'band-6'], { from: '11:00', until: '11:20' }],
  ]) input.eventBands.filter(band => bandIds.includes(band.id))
    .forEach(band => { band.availableTimeRange = range })

  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(laneOrder(result.plan), [
    'band-3', 'band-4', 'band-7', 'band-8',
    'band-1', 'band-2', 'band-5', 'band-6',
  ])
})

test('duplicate block proposalはattemptedSchedulesへ重複計上しない', () => {
  const input = blockPlacementInput({ availableFrom: '11:00' })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_FEASIBLE_SCHEDULE')
  assert.equal(result.failure.attemptedSchedules, 1)
})

test('candidate上限後に未評価unique block配置が残る場合だけSEARCH_LIMIT_REACHEDにする', () => {
  const limited = blockPlacementInput({ unrelated: 2, availableFrom: '10:20' })
  limited.options = { maxScheduleCandidates: 1 }
  const limitedResult = generateTimetablePlan(limited)
  assert.equal(limitedResult.ok, false)
  assert.equal(limitedResult.failure.code, 'SEARCH_LIMIT_REACHED')
  assert.equal(limitedResult.failure.attemptedSchedules, 1)

  const exhaustive = blockPlacementInput({ unrelated: 2, availableFrom: '11:00' })
  exhaustive.options = { maxScheduleCandidates: 24 }
  const exhaustiveResult = generateTimetablePlan(exhaustive)
  assert.equal(exhaustiveResult.ok, false)
  assert.notEqual(exhaustiveResult.failure.code, 'SEARCH_LIMIT_REACHED')
  assert.ok(exhaustiveResult.failure.attemptedSchedules > 1)
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

test('同じconstraint IDの無関係な別日制約をtarget generationへ混入させない', () => {
  const baseline = unconstrainedInput()
  baseline.timetableOrderConstraints = [orderConstraint({ id: 'shared-id' })]
  const expected = generateTimetablePlan(baseline)
  assert.equal(expected.ok, true)

  const input = structuredClone(baseline)
  input.eventBands.push({ id: 'band-a3', eventId: 'event-a', eventDayId: 'day-a2',
    name: '翌日2', memberIds: [], durationMinutes: 10 })
  input.timetableOrderConstraints.push(orderConstraint({
    id: 'shared-id', eventDayId: 'day-a2', stageId: 'stage-a2', sectionId: undefined,
    eventBandIds: ['band-a2', 'band-a3'],
  }))
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.deepEqual(result, expected)
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('同じIDの別日constraintがcycle・duplicateでもtargetへ直接触れなければ隔離する', () => {
  const baseline = unconstrainedInput()
  baseline.timetableOrderConstraints = [orderConstraint({ id: 'shared-id' })]
  const expected = generateTimetablePlan(baseline)
  assert.equal(expected.ok, true)

  const input = structuredClone(baseline)
  input.eventBands.push({ id: 'band-a3', eventId: 'event-a', eventDayId: 'day-a2',
    name: '翌日2', memberIds: [], durationMinutes: 10 })
  input.timetableOrderConstraints.push(
    orderConstraint({ id: 'shared-id', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2', 'band-a3'] }),
    orderConstraint({ id: 'shared-id', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a3', 'band-a2'] }),
  )
  const original = structuredClone(input)
  assert.deepEqual(generateTimetablePlan(input), expected)
  assert.deepEqual(input, original)
})

test('無関係な別日のruntime不正constraintをtarget generationから隔離する', () => {
  const baseline = unconstrainedInput()
  baseline.timetableOrderConstraints = [orderConstraint({ id: 'target-order' })]
  const expected = generateTimetablePlan(baseline)
  assert.equal(expected.ok, true)

  for (const unrelated of [
    orderConstraint({ id: 'length-one', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2'] }),
    orderConstraint({ id: 'duplicate-band', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2', 'band-a2'] }),
    orderConstraint({ id: '   ', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2', 'other-day-band'] }),
  ]) {
    const input = structuredClone(baseline)
    input.timetableOrderConstraints.push(unrelated)
    const original = structuredClone(input)
    const result = generateTimetablePlan(input)
    assert.deepEqual(result, expected)
    assert.deepEqual(generateTimetablePlan(input), result)
    assert.deepEqual(input, original)
  }
})

test('target Day・Stage・Bandへ触れるruntime不正constraintを探索前に拒否する', () => {
  const cases = [
    orderConstraint({ id: 'touch-day', stageId: 'stage-a2', sectionId: undefined,
      eventBandIds: ['band-a2'] }),
    orderConstraint({ id: 'touch-stage', eventDayId: 'day-a2', stageId: 'stage-a1',
      sectionId: undefined, eventBandIds: ['band-a2'] }),
    orderConstraint({ id: 'touch-band', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-1'] }),
  ]
  for (const timetableOrderConstraint of cases) {
    const input = unconstrainedInput()
    input.timetableOrderConstraints = [timetableOrderConstraint]
    const original = structuredClone(input)
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_ORDER_CONSTRAINTS', eventDayId: input.eventDay.id, attemptedSchedules: 0,
    } })
    assert.deepEqual(input, original)
  }
})

test('target scope内の同じconstraint IDは引き続きINVALID_ORDER_CONSTRAINTSにする', () => {
  const input = unconstrainedInput()
  input.timetableOrderConstraints = [
    orderConstraint({ id: 'shared-id' }),
    orderConstraint({ id: 'shared-id', eventBandIds: ['band-2', 'band-1'] }),
  ]
  const original = structuredClone(input)
  assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
    code: 'INVALID_ORDER_CONSTRAINTS', eventDayId: input.eventDay.id, attemptedSchedules: 0,
  } })
  assert.deepEqual(input, original)
})

test('target Day・Stage・Bandへ触れるforeign ownership制約は引き続きfail closedする', () => {
  const cases = [
    orderConstraint({ id: 'touch-day', eventId: 'event-b', stageId: 'stage-b',
      sectionId: undefined, eventBandIds: ['band-b', 'band-b2'] }),
    orderConstraint({ id: 'touch-stage', eventId: 'event-b', eventDayId: 'day-b',
      stageId: 'stage-a1', sectionId: undefined, eventBandIds: ['band-b', 'band-b2'] }),
    orderConstraint({ id: 'touch-band', eventId: 'event-b', eventDayId: 'day-b',
      stageId: 'stage-b', sectionId: undefined, eventBandIds: ['band-b', 'band-1'] }),
  ]
  for (const timetableOrderConstraint of cases) {
    const input = unconstrainedInput()
    input.eventBands.push({ id: 'band-b2', eventId: 'event-b', eventDayId: 'day-b',
      name: '別Event 2', memberIds: [], durationMinutes: 10 })
    input.timetableOrderConstraints = [timetableOrderConstraint]
    const original = structuredClone(input)
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_ORDER_CONSTRAINTS', eventDayId: input.eventDay.id, attemptedSchedules: 0,
    } })
    assert.deepEqual(input, original)
  }
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

test('最終guardも無関係な別日のruntime不正constraintだけを隔離する', () => {
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

  for (const unrelated of [
    orderConstraint({ id: 'length-one', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2'] }),
    orderConstraint({ id: 'duplicate-band', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2', 'band-a2'] }),
    orderConstraint({ id: '', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-a2', 'other-day-band'] }),
  ]) {
    const validationInput = structuredClone(materializationInput)
    validationInput.timetableOrderConstraints.push(unrelated)
    const original = structuredClone({ validationInput, candidate })
    assert.equal(validateTimetableGenerationCandidate(validationInput, candidate).ok, true)
    assert.deepEqual({ validationInput, candidate }, original)
  }
})

test('最終guardはtarget Day・Stage・Bandへ触れるruntime不正constraintを拒否する', () => {
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

  for (const targetMalformed of [
    orderConstraint({ id: 'touch-day', stageId: 'stage-a2', sectionId: undefined,
      eventBandIds: ['band-a2'] }),
    orderConstraint({ id: 'touch-stage', eventDayId: 'day-a2', stageId: 'stage-a1',
      sectionId: undefined, eventBandIds: ['band-a2'] }),
    orderConstraint({ id: 'touch-band', eventDayId: 'day-a2', stageId: 'stage-a2',
      sectionId: undefined, eventBandIds: ['band-1'] }),
  ]) {
    const validationInput = structuredClone(materializationInput)
    validationInput.timetableOrderConstraints = [targetMalformed]
    const original = structuredClone({ validationInput, candidate })
    assert.equal(validateTimetableGenerationCandidate(validationInput, candidate).ok, false)
    assert.deepEqual({ validationInput, candidate }, original)
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
