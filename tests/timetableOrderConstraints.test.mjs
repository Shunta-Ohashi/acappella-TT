import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTimetableOrderConstraintUpdate,
  deleteTimetableOrderConstraint,
  evaluateTimetableOrderConstraints,
  evaluateScheduledTimetableOrderConstraints,
  getTargetTimetableOrderConstraints,
  isTimetableOrderConstraint,
  mergeTimetableOrderConstraintBlocks,
  scopeTimetableOrderConstraintsForTarget,
  updateTimetableOrderConstraint,
} from '../src/domain/timetableOrderConstraints.ts'
import { getTimetableOrderConstraintScheduleStatus } from '../src/ui/timetableOrderConstraintPresentation.ts'

const eventDays = [
  { id: 'day-1', eventId: 'event-1', date: '2027-01-01', order: 0 },
  { id: 'day-2', eventId: 'event-1', date: '2027-01-02', order: 1 },
  { id: 'foreign-day', eventId: 'event-2', date: '2027-02-01', order: 0 },
]
const stages = [
  { id: 'stage-1', eventDayId: 'day-1', name: 'Main', order: 0,
    plannedStartTime: '10:00' },
  { id: 'stage-plain', eventDayId: 'day-1', name: 'Sub', order: 1,
    plannedStartTime: '10:00' },
  { id: 'stage-day-2', eventDayId: 'day-2', name: 'Day 2', order: 0,
    plannedStartTime: '10:00' },
  { id: 'foreign-stage', eventDayId: 'foreign-day', name: 'Foreign', order: 0,
    plannedStartTime: '10:00' },
]
const sections = [
  { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
  { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1 },
  { id: 'section-day-2', stageId: 'stage-day-2', name: '別日', order: 0 },
]
const eventBands = [
  { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1', name: 'A',
    memberIds: ['member-a'], durationMinutes: 10 },
  { id: 'band-b', eventId: 'event-1', eventDayId: 'day-1', name: 'B',
    memberIds: ['member-b'], durationMinutes: 10 },
  { id: 'band-c', eventId: 'event-1', eventDayId: 'day-1', name: 'C',
    memberIds: ['member-c'], durationMinutes: 10 },
  { id: 'band-d', eventId: 'event-1', eventDayId: 'day-1', name: 'D',
    memberIds: ['member-d'], durationMinutes: 10 },
  { id: 'band-day-2', eventId: 'event-1', eventDayId: 'day-2', name: 'D2',
    memberIds: ['member-d'], durationMinutes: 10 },
  { id: 'foreign-band', eventId: 'event-2', eventDayId: 'foreign-day', name: 'F',
    memberIds: ['member-f'], durationMinutes: 10 },
]

const constraint = (overrides = {}) => ({
  id: 'order-1', eventId: 'event-1', eventDayId: 'day-1',
  stageId: 'stage-1', sectionId: 'section-1',
  eventBandIds: ['band-a', 'band-c', 'band-b'],
  ...overrides,
})

const evaluate = (timetableOrderConstraints, overrides = {}) =>
  evaluateTimetableOrderConstraints({
    eventId: 'event-1', timetableOrderConstraints,
    eventDays, stages, sections, eventBands, ...overrides,
  })

const codes = (result) => result.violations.map((violation) => violation.code)

test('target出演順制約をDay・Stage・Bandへの直接参照だけで抽出する', () => {
  const target = constraint({ id: 'shared-id' })
  const dayTouchingMismatch = constraint({
    id: 'target-day', eventId: 'event-2', stageId: 'foreign-stage',
    sectionId: undefined, eventBandIds: ['foreign-band', 'foreign-band-2'],
  })
  const stageTouchingMismatch = constraint({
    id: 'target-stage', eventId: 'event-2', eventDayId: 'foreign-day',
    sectionId: undefined, eventBandIds: ['foreign-band', 'foreign-band-2'],
  })
  const bandTouchingMismatch = constraint({
    id: 'target-band', eventId: 'event-2', eventDayId: 'foreign-day',
    stageId: 'foreign-stage', sectionId: undefined,
    eventBandIds: ['foreign-band', 'band-a'],
  })
  const unrelatedWithSameId = constraint({
    id: target.id, eventDayId: 'day-2', stageId: 'stage-day-2',
    sectionId: 'section-day-2', eventBandIds: ['band-day-2', 'other-day-band'],
  })
  const input = [target, dayTouchingMismatch, stageTouchingMismatch,
    bandTouchingMismatch, unrelatedWithSameId]
  const original = structuredClone(input)

  const result = getTargetTimetableOrderConstraints({
    timetableOrderConstraints: input,
    eventDayId: 'day-1',
    stageIds: new Set(['stage-1', 'stage-plain']),
    eventBandIds: new Set(['band-a', 'band-b', 'band-c', 'band-d']),
  })

  assert.deepEqual(result, [target, dayTouchingMismatch, stageTouchingMismatch,
    bandTouchingMismatch])
  assert.deepEqual(input, original)
})

test('同じIDを持つtarget制約は両方抽出しduplicateとして評価する', () => {
  const input = [constraint(), constraint({ eventBandIds: ['band-b', 'band-c'] })]
  const target = getTargetTimetableOrderConstraints({
    timetableOrderConstraints: input,
    eventDayId: 'day-1',
    stageIds: new Set(['stage-1', 'stage-plain']),
    eventBandIds: new Set(['band-a', 'band-b', 'band-c', 'band-d']),
  })
  assert.deepEqual(target, input)
  assert.ok(codes(evaluate(target)).includes('DUPLICATE_CONSTRAINT_ID'))
})

test('runtime constraintをtarget参照でscopeしてからfull validationする', () => {
  const target = {
    eventDayId: 'day-1',
    stageIds: new Set(['stage-1', 'stage-plain']),
    eventBandIds: new Set(['band-a', 'band-b', 'band-c', 'band-d']),
  }
  for (const unrelated of [
    constraint({ id: '', eventDayId: 'day-2', stageId: 'stage-day-2',
      sectionId: 'section-day-2', eventBandIds: ['band-day-2', 'other-day-band'] }),
    constraint({ eventDayId: 'day-2', stageId: 'stage-day-2',
      sectionId: 'section-day-2', eventBandIds: ['band-day-2'] }),
    constraint({ eventDayId: 'day-2', stageId: 'stage-day-2',
      sectionId: 'section-day-2', eventBandIds: ['band-day-2', 'band-day-2'] }),
  ]) {
    assert.deepEqual(scopeTimetableOrderConstraintsForTarget({
      timetableOrderConstraints: [unrelated], ...target,
    }), { ok: true, constraints: [] })
  }

  for (const targetMalformed of [
    constraint({ eventBandIds: ['band-a'] }),
    constraint({ eventDayId: 'day-2', stageId: 'stage-1',
      sectionId: undefined, eventBandIds: ['band-day-2'] }),
    constraint({ eventDayId: 'day-2', stageId: 'stage-day-2',
      sectionId: 'section-day-2', eventBandIds: ['band-a'] }),
  ]) {
    assert.deepEqual(scopeTimetableOrderConstraintsForTarget({
      timetableOrderConstraints: [targetMalformed], ...target,
    }), { ok: false })
  }

  const sparse = new Array(2)
  sparse[1] = constraint()
  assert.deepEqual(scopeTimetableOrderConstraintsForTarget({
    timetableOrderConstraints: sparse, ...target,
  }), { ok: false })
  assert.deepEqual(scopeTimetableOrderConstraintsForTarget({
    timetableOrderConstraints: null, ...target,
  }), { ok: false })
})

test('一致する出演順fragmentを最大の連続Performance blockへ統合する', () => {
  for (const [constraints, expected] of [
    [[constraint({ id: 'ab', eventBandIds: ['band-a', 'band-b'] }),
      constraint({ id: 'bc', eventBandIds: ['band-b', 'band-c'] })],
    ['band-a', 'band-b', 'band-c']],
    [[constraint(), constraint({ id: 'cb', eventBandIds: ['band-c', 'band-b'] })],
      ['band-a', 'band-c', 'band-b']],
    [[constraint(), constraint({ id: 'ac', eventBandIds: ['band-a', 'band-c'] })],
      ['band-a', 'band-c', 'band-b']],
    [[constraint({ id: 'abc', eventBandIds: ['band-a', 'band-b', 'band-c'] }),
      constraint({ id: 'bcd', eventBandIds: ['band-b', 'band-c', 'band-d'] })],
    ['band-a', 'band-b', 'band-c', 'band-d']],
  ]) {
    assert.equal(evaluate(constraints).valid, true)
    assert.deepEqual(mergeTimetableOrderConstraintBlocks(constraints).blocks[0].eventBandIds,
      expected)
  }
})

test('複数fragmentのcycleを決定的に検出する', () => {
  const input = [
    constraint({ id: 'order-b', eventBandIds: ['band-b', 'band-c'] }),
    constraint({ id: 'order-a', eventBandIds: ['band-a', 'band-b'] }),
    constraint({ id: 'order-c', eventBandIds: ['band-c', 'band-a'] }),
  ]
  const first = evaluate(input)
  const second = evaluate(input)
  assert.equal(first.valid, false)
  assert.deepEqual(first, second)
  assert.deepEqual(first.violations.find((item) => item.code === 'ORDER_CYCLE'), {
    code: 'ORDER_CYCLE',
    constraintIds: ['order-a', 'order-b', 'order-c'],
    eventBandIds: ['band-a', 'band-b', 'band-c'],
    message: '出演順制約が循環しています。',
  })
})

test('同じlaneのcompatible overlapを許可し、分岐と異なるlaneを拒否する', () => {
  assert.equal(evaluate([
    constraint({ id: 'same-a', eventBandIds: ['band-a', 'band-b'] }),
    constraint({ id: 'same-b', eventBandIds: ['band-b', 'band-c'] }),
  ]).valid, true)
  for (const constraints of [
    [constraint({ id: 'a', eventBandIds: ['band-a', 'band-b'] }),
      constraint({ id: 'b', eventBandIds: ['band-a', 'band-c'] })],
    [constraint({ id: 'a' }),
      constraint({ id: 'b', eventBandIds: ['band-a', 'band-b'] })],
    [constraint({ id: 'a', eventBandIds: ['band-a', 'band-b'] }),
      constraint({ id: 'b', eventBandIds: ['band-c', 'band-b'] })],
  ]) assert.ok(codes(evaluate(constraints)).includes('ORDER_BLOCK_CONFLICT'))

  const result = evaluate([
    constraint({ id: 'base', eventBandIds: ['band-a', 'band-b'] }),
    constraint({ id: 'other', stageId: 'stage-plain', sectionId: undefined,
      eventBandIds: ['band-a', 'band-c'] }),
  ])
  assert.ok(codes(result).includes('EVENT_BAND_LANE_CONFLICT'))
})

test('SectionありStageでは有効Sectionを必須としSectionなしStageでは指定を禁止する', () => {
  assert.ok(codes(evaluate([constraint({ sectionId: undefined })])).includes('SECTION_REQUIRED'))
  assert.ok(codes(evaluate([constraint({ sectionId: 'missing-section' })])).includes('SECTION_NOT_FOUND'))
  assert.ok(codes(evaluate([constraint({ sectionId: 'section-day-2' })])).includes('SECTION_STAGE_MISMATCH'))

  const sectionless = constraint({ stageId: 'stage-plain', sectionId: undefined })
  assert.equal(evaluate([sectionless]).valid, true)
  assert.ok(codes(evaluate([{ ...sectionless, sectionId: 'section-1' }]))
    .includes('SECTION_NOT_ALLOWED'))
})

test('Event・EventDay・Stage・EventBandのownership不整合を拒否する', () => {
  const cases = [
    [constraint({ eventId: 'event-2' }), 'EVENT_MISMATCH'],
    [constraint({ eventDayId: 'missing-day' }), 'EVENT_DAY_NOT_FOUND'],
    [constraint({ eventDayId: 'foreign-day', stageId: 'foreign-stage',
      sectionId: undefined }), 'EVENT_DAY_EVENT_MISMATCH'],
    [constraint({ stageId: 'missing-stage', sectionId: undefined }), 'STAGE_NOT_FOUND'],
    [constraint({ stageId: 'stage-day-2', sectionId: 'section-day-2' }), 'STAGE_DAY_MISMATCH'],
    [constraint({ eventBandIds: ['band-a', 'missing-band'] }), 'EVENT_BAND_NOT_FOUND'],
    [constraint({ eventBandIds: ['band-a', 'foreign-band'] }), 'EVENT_BAND_EVENT_MISMATCH'],
    [constraint({ eventBandIds: ['band-a', 'band-day-2'] }), 'EVENT_BAND_DAY_MISMATCH'],
  ]
  for (const [value, code] of cases) assert.ok(codes(evaluate([value])).includes(code), code)
})

test('constraint ID・内部Band ID・runtime shapeをfail closedで検証する', () => {
  assert.ok(codes(evaluate([constraint(), constraint()])).includes('DUPLICATE_CONSTRAINT_ID'))
  assert.ok(codes(evaluate([constraint({ eventBandIds: ['band-a', 'band-a'] })]))
    .includes('DUPLICATE_EVENT_BAND'))
  assert.ok(codes(evaluate([constraint({ eventBandIds: ['band-a'] })]))
    .includes('INVALID_CONSTRAINT'))
  assert.ok(codes(evaluate([{ ...constraint(), id: '   ' }]))
    .includes('INVALID_CONSTRAINT'))
  assert.equal(isTimetableOrderConstraint(constraint()), true)
  assert.equal(isTimetableOrderConstraint(constraint({ eventBandIds: ['band-a'] })), false)
})

test('sparseなeventBandIdsを例外なくINVALID_CONSTRAINTとして拒否する', () => {
  const leadingHole = []
  leadingHole.length = 2
  leadingHole[1] = 'band-a'
  const holesOnly = new Array(2)
  const middleHole = ['band-a', 'band-b', 'band-c']
  delete middleHole[1]
  const denseUndefined = ['band-a', undefined, 'band-b']

  assert.equal(isTimetableOrderConstraint(constraint({
    eventBandIds: ['band-a', 'band-b'],
  })), true)

  for (const eventBandIds of [
    leadingHole,
    holesOnly,
    middleHole,
    denseUndefined,
  ]) {
    const input = [constraint({ eventBandIds })]
    const before = structuredClone(input)
    let first
    assert.doesNotThrow(() => {
      first = evaluate(input)
    })
    const second = evaluate(input)
    assert.equal(isTimetableOrderConstraint(input[0]), false)
    assert.equal(first.valid, false)
    assert.deepEqual(codes(first), ['INVALID_CONSTRAINT'])
    assert.deepEqual(first, second)
    assert.deepEqual(input, before)
  }
})

test('Schedule上では指定Band列を連続Performance blockとして要求する', () => {
  const constraints = [constraint()]
  const performance = (eventBandId, order) => ({ id: `${eventBandId}-${order}`, kind: 'performance',
    eventBandId, stageId: 'stage-1', sectionId: 'section-1', order })
  for (const ids of [
    ['band-a', 'band-c', 'band-b'],
    ['band-x', 'band-a', 'band-c', 'band-b', 'band-y'],
    ['band-x', 'band-y', 'band-a', 'band-c', 'band-b'],
    ['band-a', 'band-c', 'band-b', 'band-x', 'band-y'],
  ]) assert.equal(evaluateScheduledTimetableOrderConstraints({
    timetableOrderConstraints: constraints,
    scheduleItems: ids.map(performance),
  }).valid, true)

  for (const ids of [
    ['band-a', 'band-x', 'band-c', 'band-b'],
    ['band-a', 'band-c', 'band-x', 'band-b'],
    ['band-x', 'band-a', 'band-c', 'band-y', 'band-b'],
    ['band-a', 'band-x', 'band-c', 'band-y', 'band-b'],
  ]) assert.equal(evaluateScheduledTimetableOrderConstraints({
    timetableOrderConstraints: constraints,
    scheduleItems: ids.map(performance),
  }).violations.some(violation => violation.code === 'BLOCK_MISMATCH'), true)
})

test('Breakをblock adjacencyへ数えず、他Performanceの挿入は検出する', () => {
  const constraints = [constraint()]
  const item = (id, eventBandId, order, sectionId = 'section-1') => ({
    id, kind: 'performance', eventBandId, stageId: 'stage-1', sectionId, order,
  })
  const withBreaks = [
    item('a', 'band-a', 0),
    { id: 'break-a', kind: 'break', title: '休憩', durationMinutes: 5,
      stageId: 'stage-1', sectionId: 'section-1', order: 1 },
    item('c', 'band-c', 2),
    { id: 'break-c', kind: 'break', title: '休憩', durationMinutes: 5,
      stageId: 'stage-1', sectionId: 'section-1', order: 3 },
    item('b', 'band-b', 4),
  ]
  assert.equal(evaluateScheduledTimetableOrderConstraints({
    timetableOrderConstraints: constraints, scheduleItems: withBreaks,
  }).valid, true)
  assert.equal(evaluateScheduledTimetableOrderConstraints({
    timetableOrderConstraints: constraints,
    scheduleItems: [...withBreaks, item('x', 'band-x', 1.5)],
  }).valid, false)
})

test('Schedule上の反転・lane不一致・欠落・重複を個別に検出する', () => {
  const constraints = [constraint({ eventBandIds: ['band-a', 'band-b'] })]
  const item = (id, eventBandId, order, sectionId = 'section-1') => ({
    id, kind: 'performance', eventBandId, stageId: 'stage-1', sectionId, order,
  })
  const cases = [
    [[item('b', 'band-b', 0), item('a', 'band-a', 1)], 'BLOCK_MISMATCH'],
    [[item('a', 'band-a', 0), item('b', 'band-b', 0, 'section-2')], 'LANE_MISMATCH'],
    [[item('a', 'band-a', 0)], 'MISSING_EVENT_BAND'],
    [[item('a1', 'band-a', 0), item('a2', 'band-a', 1), item('b', 'band-b', 2)], 'DUPLICATE_EVENT_BAND'],
  ]
  for (const [scheduleItems, code] of cases) {
    const result = evaluateScheduledTimetableOrderConstraints({
      timetableOrderConstraints: constraints, scheduleItems,
    })
    assert.equal(result.valid, false)
    assert.ok(result.violations.some(violation => violation.code === code))
  }
})

test('FixedPlacementのStage・明示Section競合を拒否しStage-onlyは許可する', () => {
  const withBand = (fixedPlacement) => eventBands.map((band) =>
    band.id === 'band-a' ? { ...band, fixedPlacement } : band)
  assert.ok(codes(evaluate([constraint()], {
    eventBands: withBand({ stageId: 'stage-plain' }),
  })).includes('FIXED_PLACEMENT_CONFLICT'))
  assert.ok(codes(evaluate([constraint()], {
    eventBands: withBand({ stageId: 'stage-1', sectionId: 'section-2' }),
  })).includes('FIXED_PLACEMENT_CONFLICT'))
  assert.equal(evaluate([constraint()], {
    eventBands: withBand({ stageId: 'stage-1' }),
  }).valid, true)
})

test('評価はinputを変更せず、同じinputでviolation順も安定する', () => {
  const input = [
    constraint({ id: 'z', eventBandIds: ['band-a', 'missing-band'] }),
    constraint({ id: 'a', eventDayId: 'missing-day' }),
  ]
  const before = structuredClone({ input, eventDays, stages, sections, eventBands })
  const first = evaluate(input)
  const second = evaluate(input)
  assert.deepEqual(first, second)
  assert.deepEqual({ input, eventDays, stages, sections, eventBands }, before)
})

const mutationReferences = { eventDays, stages, sections, eventBands }
const createConstraint = (overrides = {}) => createTimetableOrderConstraintUpdate({
  timetableOrderConstraints: [],
  constraintId: 'new-order',
  event: { id: 'event-1' },
  eventDay: { id: 'day-1' },
  stage: { id: 'stage-1' },
  draft: { sectionId: 'section-1', eventBandIds: ['band-a', 'band-b'] },
  ...mutationReferences,
  ...overrides,
})

test('出演順制約をauthoritative scopeから作成しforeign Eventを保持する', () => {
  const foreign = constraint({
    id: 'foreign-order', eventId: 'event-2', eventDayId: 'foreign-day',
    stageId: 'foreign-stage', sectionId: undefined,
    eventBandIds: ['foreign-band', 'foreign-band-2'],
  })
  const input = [foreign]
  const original = structuredClone(input)
  const result = createConstraint({ timetableOrderConstraints: input })

  assert.equal(result.ok, true)
  assert.deepEqual(result.timetableOrderConstraints[0], foreign)
  assert.deepEqual(result.timetableOrderConstraints[1], {
    id: 'new-order', eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
    sectionId: 'section-1', eventBandIds: ['band-a', 'band-b'],
  })
  assert.deepEqual(input, original)
})

test('出演順制約の編集はIDとscopeを維持しeditable fieldsだけを更新する', () => {
  const input = [constraint({ eventBandIds: ['band-a', 'band-b'] })]
  const original = structuredClone(input)
  const result = updateTimetableOrderConstraint({
    timetableOrderConstraints: input,
    constraintId: 'order-1',
    eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
    draft: { sectionId: 'section-2', eventBandIds: ['band-c', 'band-d'] },
    ...mutationReferences,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.timetableOrderConstraints[0], {
    id: 'order-1', eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
    sectionId: 'section-2', eventBandIds: ['band-c', 'band-d'],
  })
  assert.deepEqual(input, original)
})

test('出演順制約の編集もproposed current Event全体を再検証してatomicに失敗する', () => {
  const input = [constraint({ eventBandIds: ['band-a', 'band-b'] })]
  const original = structuredClone(input)
  const result = updateTimetableOrderConstraint({
    timetableOrderConstraints: input,
    constraintId: 'order-1',
    eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
    draft: { sectionId: 'section-1', eventBandIds: ['band-a', 'band-a'] },
    ...mutationReferences,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(input, original)
})

test('出演順制約の削除は対象だけを削除し壊れた制約の修復にも使える', () => {
  const broken = constraint({ id: 'broken', eventBandIds: ['band-a'] })
  const kept = constraint({ id: 'kept', eventBandIds: ['band-b', 'band-c'] })
  const input = [broken, kept]
  const original = structuredClone(input)
  const result = deleteTimetableOrderConstraint({
    timetableOrderConstraints: input,
    constraintId: 'broken',
  })

  assert.deepEqual(result, { ok: true, timetableOrderConstraints: [kept] })
  assert.deepEqual(input, original)
})

test('出演順制約の新規ID collisionと曖昧な編集・削除を拒否する', () => {
  assert.equal(createConstraint({
    timetableOrderConstraints: [constraint({ id: 'new-order' })],
  }).ok, false)
  const duplicateIds = [constraint(), constraint({ eventBandIds: ['band-c', 'band-d'] })]
  assert.equal(updateTimetableOrderConstraint({
    timetableOrderConstraints: duplicateIds,
    constraintId: 'order-1', eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
    draft: { sectionId: 'section-1', eventBandIds: ['band-a', 'band-b'] },
    ...mutationReferences,
  }).ok, false)
  assert.equal(deleteTimetableOrderConstraint({
    timetableOrderConstraints: duplicateIds, constraintId: 'order-1',
  }).ok, false)
})

test('作成helperはBand数・重複・日付ownership違反をevaluatorで拒否する', () => {
  for (const eventBandIds of [
    ['band-a'],
    ['band-a', 'band-a'],
    ['band-a', 'band-day-2'],
  ]) {
    const result = createConstraint({
      draft: { sectionId: 'section-1', eventBandIds },
    })
    assert.equal(result.ok, false, eventBandIds.join(','))
  }
})

test('作成helperはSection必須・禁止・ownershipをevaluatorで拒否する', () => {
  assert.equal(createConstraint({
    draft: { eventBandIds: ['band-a', 'band-b'] },
  }).ok, false)
  assert.equal(createConstraint({
    stage: { id: 'stage-plain' },
    draft: { sectionId: 'section-1', eventBandIds: ['band-a', 'band-b'] },
  }).ok, false)
  assert.equal(createConstraint({
    draft: { sectionId: 'section-day-2', eventBandIds: ['band-a', 'band-b'] },
  }).ok, false)
  assert.equal(createConstraint({
    stage: { id: 'stage-plain' },
    draft: { eventBandIds: ['band-a', 'band-b'] },
  }).ok, true)
  assert.equal(createConstraint({
    stage: { id: 'missing-stage' },
    draft: { eventBandIds: ['band-a', 'band-b'] },
  }).ok, false)
})

test('作成helperはFixedPlacement conflictを拒否する', () => {
  const conflictingBands = eventBands.map(band => band.id === 'band-a'
    ? { ...band, fixedPlacement: { stageId: 'stage-plain' } }
    : band)
  assert.equal(createConstraint({ eventBands: conflictingBands }).ok, false)
})

test('作成helperはlane conflictとblock branch conflictを拒否する', () => {
  const laneConflict = createConstraint({
    timetableOrderConstraints: [constraint({
      id: 'existing', sectionId: 'section-2', eventBandIds: ['band-a', 'band-c'],
    })],
  })
  assert.equal(laneConflict.ok, false)

  const branchConflict = createConstraint({
    timetableOrderConstraints: [constraint({
      id: 'existing', eventBandIds: ['band-a', 'band-c'],
    })],
  })
  assert.equal(branchConflict.ok, false)
})

test('作成helperはcycleを拒否しcompatible fragmentを許可する', () => {
  const existing = [
    constraint({ id: 'ab', eventBandIds: ['band-a', 'band-b'] }),
    constraint({ id: 'bc', eventBandIds: ['band-b', 'band-c'] }),
  ]
  assert.equal(createConstraint({
    timetableOrderConstraints: existing,
    draft: { sectionId: 'section-1', eventBandIds: ['band-c', 'band-a'] },
  }).ok, false)
  assert.equal(createConstraint({
    timetableOrderConstraints: [existing[0]],
    draft: { sectionId: 'section-1', eventBandIds: ['band-b', 'band-c'] },
  }).ok, true)
})

test('current TT statusを条件どおり・未配置あり・条件未達へ表示する', () => {
  const target = constraint({ eventBandIds: ['band-a', 'band-b'] })
  const performance = (id, eventBandId, order) => ({
    id, kind: 'performance', eventBandId,
    stageId: 'stage-1', sectionId: 'section-1', order,
  })
  assert.deepEqual(getTimetableOrderConstraintScheduleStatus({
    constraint: target,
    scheduleItems: [performance('a', 'band-a', 0), performance('b', 'band-b', 1)],
    semanticViolations: [],
  }), { kind: 'satisfied', label: '現在のTT：条件どおり' })
  assert.deepEqual(getTimetableOrderConstraintScheduleStatus({
    constraint: target,
    scheduleItems: [performance('a', 'band-a', 0)],
    semanticViolations: [],
  }), { kind: 'missing', label: '現在のTT：未配置あり' })
  assert.deepEqual(getTimetableOrderConstraintScheduleStatus({
    constraint: target,
    scheduleItems: [performance('a', 'band-a', 0), performance('x', 'band-c', 1),
      performance('b', 'band-b', 2)],
    semanticViolations: [],
  }), { kind: 'unmet', label: '現在のTT：条件未達' })
  assert.deepEqual(getTimetableOrderConstraintScheduleStatus({
    constraint: target,
    scheduleItems: [performance('a', 'band-a', 0), {
      ...performance('b', 'band-b', 1), sectionId: 'section-2',
    }],
    semanticViolations: [],
  }), { kind: 'unmet', label: '現在のTT：条件未達' })
})

test('current TT statusはBreakをPerformance adjacencyへ数えない', () => {
  const target = constraint({ eventBandIds: ['band-a', 'band-b'] })
  const scheduleItems = [
    { id: 'a', kind: 'performance', eventBandId: 'band-a',
      stageId: 'stage-1', sectionId: 'section-1', order: 0 },
    { id: 'break', kind: 'break', title: '休憩', durationMinutes: 5,
      stageId: 'stage-1', sectionId: 'section-1', order: 1 },
    { id: 'b', kind: 'performance', eventBandId: 'band-b',
      stageId: 'stage-1', sectionId: 'section-1', order: 2 },
  ]
  assert.equal(getTimetableOrderConstraintScheduleStatus({
    constraint: target, scheduleItems, semanticViolations: [],
  }).kind, 'satisfied')
})

test('semantic invalidな出演順制約はschedule状態にかかわらず要修正と表示する', () => {
  const fixedPlacementBands = eventBands.map(band => band.id === 'band-a'
    ? { ...band, fixedPlacement: { stageId: 'stage-plain' } }
    : band)
  const fixtures = [
    {
      constraints: [constraint({ id: 'zero', eventBandIds: [] })],
      targetId: 'zero',
    },
    {
      constraints: [constraint({ id: 'one', eventBandIds: ['band-a'] })],
      targetId: 'one',
    },
    {
      constraints: [constraint({ id: 'wrong-day', eventBandIds: ['band-a', 'band-day-2'] })],
      targetId: 'wrong-day',
    },
    {
      constraints: [constraint({ id: 'fixed', eventBandIds: ['band-a', 'band-b'] })],
      targetId: 'fixed',
      eventBands: fixedPlacementBands,
    },
    {
      constraints: [
        constraint({ id: 'duplicate', eventBandIds: ['band-a', 'band-b'] }),
        constraint({ id: 'duplicate', eventBandIds: ['band-c', 'band-d'] }),
      ],
      targetId: 'duplicate',
    },
  ]

  for (const fixture of fixtures) {
    const semanticEvaluation = evaluate(fixture.constraints, {
      ...(fixture.eventBands ? { eventBands: fixture.eventBands } : {}),
    })
    const target = fixture.constraints.find(item => item.id === fixture.targetId)
    const semanticViolations = semanticEvaluation.violations.filter(violation =>
      violation.constraintIds.includes(fixture.targetId))
    assert.ok(semanticViolations.length > 0, fixture.targetId)
    assert.deepEqual(getTimetableOrderConstraintScheduleStatus({
      constraint: target,
      scheduleItems: [],
      semanticViolations,
    }), { kind: 'invalid', label: '出演順制約：要修正' })
  }
})
