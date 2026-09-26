import assert from 'node:assert/strict'
import test from 'node:test'

import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { buildPaActivities, buildPerformanceActivities,
  evaluateMemberActivitySpacing } from '../src/domain/activitySpacing.ts'
import { detectScheduleIssues } from '../src/domain/issues.ts'
import { evaluateScheduleConstraints } from '../src/domain/schedulingConstraints.ts'
import { calculateEventDayTimelines } from '../src/domain/timetable.ts'
import { evaluateTimetableLocks } from '../src/domain/timetableLocks.ts'
import {
  compareTimetableGenerationScores, getPaWorkloadImbalance, getSectionBalance,
  getCrossSectionTransitions,
} from '../src/domain/timetableGenerationScore.ts'
import { planPaShifts } from '../src/domain/paShiftPlanning.ts'
import { resolvePaAssignmentInterval } from '../src/domain/paAssignments.ts'

const createInput = ({ bandCount = 4, sectionCount = 2, paCount = 2 } = {}) => {
  const event = {
    id: 'event-1', name: 'Test', timeZone: 'Asia/Tokyo',
    defaultTransitionMinutes: 0,
    validationPolicy: { minimumGapBands: 0, minimumRestMinutes: 0 },
    performanceSlotMinutes: [10],
  }
  const eventDay = { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 }
  const stages = [{
    id: 'stage-1', eventDayId: eventDay.id, name: 'Stage', order: 0,
    plannedStartTime: '10:00',
  }]
  const sections = Array.from({ length: sectionCount }, (_, index) => ({
    id: `section-${index}`, stageId: stages[0].id, name: `Section ${index}`,
    order: index,
  }))
  const eventBands = Array.from({ length: bandCount }, (_, index) => ({
    id: `band-${String(index).padStart(2, '0')}`, eventId: event.id,
    eventDayId: eventDay.id, name: `Band ${index}`,
    memberIds: [`performer-${index}`], durationMinutes: 10,
  }))
  const performerIds = eventBands.flatMap(band => band.memberIds)
  const mainIds = Array.from({ length: paCount }, (_, index) => `main-${index}`)
  const subIds = Array.from({ length: paCount }, (_, index) => `sub-${index}`)
  const memberIds = [...performerIds, ...mainIds, ...subIds]
  const members = memberIds.map(id => ({ id, realName: id, active: true }))
  const eventMembers = memberIds.map(id => ({
    id: `event-member-${id}`, eventId: event.id, memberId: id,
    paCapabilities: { main: mainIds.includes(id), sub: subIds.includes(id) },
  }))
  const eventMemberDays = eventMembers.map(member => ({
    id: `day-${member.memberId}`, eventMemberId: member.id,
    eventDayId: eventDay.id, participationStatus: 'participating',
  }))
  return {
    event, eventDay, eventDays: [eventDay], stages, sections,
    members, eventMembers, eventMemberDays, eventBands,
    scheduleItems: [], timetableLocks: [], dutyTypes: [], dutyAssignments: [],
  }
}

const materializeSchedule = (input, plan) => [
  ...input.scheduleItems.filter(item => !input.stages.some(stage => stage.id === item.stageId)),
  ...plan.placements.map(placement => ({
    id: placement.scheduleItemId ?? `materialized-${placement.eventBandId}`,
    kind: 'performance', eventBandId: placement.eventBandId,
    stageId: placement.stageId, order: placement.order,
    ...(placement.sectionId ? { sectionId: placement.sectionId } : {}),
  })),
  ...plan.breaks.map(placement => ({
    ...input.scheduleItems.find(item => item.id === placement.scheduleItemId),
    order: placement.order,
  })),
]

const materializePa = (input, plan) => {
  const boundary = value => ({
    scheduleItemId: value.kind === 'existing-item'
      ? value.scheduleItemId
      : plan.placements.find(item => item.eventBandId === value.eventBandId)
        ?.scheduleItemId ?? `materialized-${value.eventBandId}`,
    edge: value.edge,
  })
  return plan.paShifts.map((shift, index) => ({
    id: `pa-${index}`, eventId: input.event.id,
    eventDayId: shift.eventDayId, stageId: shift.stageId,
    role: shift.role, memberId: shift.memberId,
    from: boundary(shift.fromBoundary), until: boundary(shift.untilBoundary),
  }))
}

const verifyGeneratedSchedule = (input, result) => {
  assert.equal(result.ok, true, JSON.stringify(result))
  const scheduleItems = materializeSchedule(input, result.plan)
  const constraints = evaluateScheduleConstraints({ ...input, scheduleItems })
  assert.deepEqual(constraints.hardViolations, [])
  const timeline = calculateEventDayTimelines({ ...input,
    eventDayId: input.eventDay.id, scheduleItems })
  assert.deepEqual(timeline.invalidStages, [])
  const issues = detectScheduleIssues({ ...input,
    calculatedItems: timeline.calculatedItems, paAssignments: materializePa(input, result.plan) })
  assert.deepEqual(issues.filter(issue => issue.severity === 'ERROR'), [])
  return timeline.calculatedItems
}

const addOtherDay = input => {
  input.eventDays.push({ id: 'day-2', eventId: input.event.id, date: '2027-11-07', order: 1 })
  input.stages.push({ id: 'stage-day-2', eventDayId: 'day-2', name: 'Day 2',
    order: 0, plannedStartTime: '10:00', plannedEndTime: '11:00' })
  input.sections.push({ id: 'section-day-2', stageId: 'stage-day-2', name: 'Day 2 Section',
    order: 0 })
  input.eventBands.push({ id: 'band-day-2', eventId: input.event.id,
    eventDayId: 'day-2', name: 'Day 2 Band', memberIds: ['performer-0'], durationMinutes: 10 })
  input.scheduleItems.push({ id: 'day-2-item', kind: 'performance',
    eventBandId: 'band-day-2', stageId: 'stage-day-2', sectionId: 'section-day-2', order: 0 })
  input.eventMemberDays.push(...input.eventMembers.map(member => ({
    id: `day-2-${member.id}`, eventMemberId: member.id,
    eventDayId: 'day-2', participationStatus: 'participating',
  })))
}

test('不正なEvent default transitionはTimeline構築前にINVALID_INPUTとなる', () => {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = createInput({ bandCount: 2, sectionCount: 1 })
    input.event.defaultTransitionMinutes = value
    const original = structuredClone(input)
    assert.deepEqual(generateTimetablePlan(input), {
      ok: false, failure: { code: 'INVALID_INPUT', eventDayId: 'day-1', attemptedSchedules: 0 },
    }, String(value))
    assert.deepEqual(input, original)
  }
})

test('不正な対象Stage transitionはTimeline構築前にINVALID_INPUTとなる', () => {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = createInput({ bandCount: 2, sectionCount: 1 })
    input.stages[0].transitionMinutes = value
    assert.deepEqual(generateTimetablePlan(input), {
      ok: false, failure: { code: 'INVALID_INPUT', eventDayId: 'day-1', attemptedSchedules: 0 },
    }, String(value))
  }
})

test('非負safe integerのtransitionと未指定Stage overrideを許可し既存の時間計算を維持する', () => {
  for (const value of [0, 1, 2, 10]) {
    for (const override of [undefined, value]) {
      const input = createInput({ bandCount: 2, sectionCount: 1 })
      input.event.defaultTransitionMinutes = override === undefined ? value : 3
      input.stages[0].transitionMinutes = override
      const result = generateTimetablePlan(input)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.ok(result.plan.paShifts.every(shift =>
        shift.untilMinute - shift.fromMinute === 20 + value))
    }
  }
})

const malformedTimeRanges = [
  { from: 'abc' }, { from: '25:00' }, { until: 'invalid' },
  { from: '12:00', until: '10:00' }, { from: '10:00', until: '10:00' }, {},
  { from: ' 10:00 ' }, { until: '15:00 ' },
  { from: '', until: '15:00' }, { from: '10:00', until: '' },
  { from: 600 }, null,
]

for (const [field, setRange] of [
  ['EventBand.availableTimeRange', (input, range) => { input.eventBands[0].availableTimeRange = range }],
  ['EventBand.preferredTimeRange', (input, range) => { input.eventBands[0].preferredTimeRange = range }],
  ['EventMemberDay.availabilityWindows', (input, range) => {
    input.eventMemberDays[0].availabilityWindows = [{ from: '10:00', until: '12:00' }, range]
  }],
  ['EventMemberDay.preferredTimeRange', (input, range) => {
    input.eventMemberDays[0].preferredTimeRange = range
  }],
]) {
  test(`対象日の不正な${field}はthrowせず探索前にINVALID_INPUT`, () => {
    for (const range of malformedTimeRanges) {
      const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
      setRange(input, range)
      const original = structuredClone(input)
      let result
      assert.doesNotThrow(() => { result = generateTimetablePlan(input) })
      assert.deepEqual(result, { ok: false, failure: {
        code: 'INVALID_INPUT', eventDayId: input.eventDay.id, attemptedSchedules: 0,
      } }, JSON.stringify(range))
      assert.deepEqual(input, original)
    }
  })
}

for (const field of ['availabilityWindows', 'preferredTimeRange']) {
  test(`対象日のPA候補の不正な${field}もPA探索前にINVALID_INPUT`, () => {
    for (const memberId of ['main-0', 'sub-0']) {
      const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
      const memberDay = input.eventMemberDays.find(day =>
        day.eventMemberId === `event-member-${memberId}`)
      memberDay[field] = field === 'availabilityWindows' ? [{ from: 'abc' }] : { from: 'abc' }
      assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
        code: 'INVALID_INPUT', eventDayId: input.eventDay.id, attemptedSchedules: 0,
      } })
    }
  })
}

test('availabilityWindowsの不正なcollection shapeをthrowせずINVALID_INPUTにする', () => {
  for (const value of [null, {}, '10:00']) {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    input.eventMemberDays[0].availabilityWindows = value
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_INPUT', eventDayId: input.eventDay.id, attemptedSchedules: 0,
    } })
  }
})

test('undefined availabilityは終日、未指定のBand条件・希望もvalidで入力を変更しない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
  input.eventBands[0].availableTimeRange = undefined
  input.eventBands[0].preferredTimeRange = undefined
  input.eventMemberDays.forEach(day => {
    day.availabilityWindows = undefined
    day.preferredTimeRange = undefined
  })
  const original = structuredClone(input)
  verifyGeneratedSchedule(input, generateTimetablePlan(input))
  assert.deepEqual(input, original)
})

test('片側TimeRangeと正常な両側TimeRangeはBand・Member条件ともそのまま生成可能', () => {
  for (const range of [{ from: '10:00' }, { until: '15:00' }, { from: '10:00', until: '12:00' }]) {
    const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
    input.eventBands[0].availableTimeRange = range
    input.eventBands[0].preferredTimeRange = range
    input.eventMemberDays.forEach(day => {
      day.availabilityWindows = [range]
      day.preferredTimeRange = range
    })
    const original = structuredClone(input)
    verifyGeneratedSchedule(input, generateTimetablePlan(input))
    assert.deepEqual(input, original)
  }
})

test('複数availability windowのoverlap・adjacentを新たに拒否・normalizeしない', () => {
  for (const secondRange of [
    { from: '10:30', until: '12:00' }, { from: '11:00', until: '12:00' },
  ]) {
    const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
    input.eventMemberDays.forEach(day => {
      day.availabilityWindows = [{ from: '10:00', until: '11:00' }, secondRange]
    })
    const original = structuredClone(input)
    verifyGeneratedSchedule(input, generateTimetablePlan(input))
    assert.deepEqual(input, original)
  }
})

test('Memberのavailability []は入力としてvalidだが出演可能時間なしのため配置できない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.eventMemberDays[0].availabilityWindows = []
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_FEASIBLE_SCHEDULE')
  assert.ok(result.failure.attemptedSchedules > 0)
  assert.deepEqual(input, original)
})

test('PAのavailability []は入力としてvalidだがPA候補にはならない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .availabilityWindows = []
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_MAIN_PA_CANDIDATE')
  assert.ok(result.failure.attemptedSchedules > 0)
})

test('希望がavailability外でもTimeRange自体がvalidならSoft違反として生成可能', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
  input.eventBands[0].availableTimeRange = { from: '10:00', until: '11:00' }
  input.eventBands[0].preferredTimeRange = { from: '15:00', until: '16:00' }
  input.eventMemberDays[0].availabilityWindows = [{ from: '10:00', until: '11:00' }]
  input.eventMemberDays[0].preferredTimeRange = { from: '15:00', until: '16:00' }
  const result = generateTimetablePlan(input)
  verifyGeneratedSchedule(input, result)
  assert.ok(result.plan.score.schedulingSoftPenalty > 0)
  assert.ok(result.plan.diagnostics.schedulingSoftViolations.length >= 2)
})

test('別日のmalformed Band・Member TimeRangeは対象日の生成結果へ影響しない', () => {
  for (const field of ['bandAvailability', 'bandPreference', 'memberAvailability', 'memberPreference']) {
    const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
    const baseline = generateTimetablePlan(input)
    assert.equal(baseline.ok, true)
    addOtherDay(input)
    const otherBand = input.eventBands.at(-1)
    const otherMemberDays = input.eventMemberDays.filter(day => day.eventDayId === 'day-2')
    if (field === 'bandAvailability') otherBand.availableTimeRange = { from: 'abc' }
    if (field === 'bandPreference') otherBand.preferredTimeRange = { from: '12:00', until: '10:00' }
    otherMemberDays.forEach(day => {
      if (field === 'memberAvailability') day.availabilityWindows = [{ from: ' 10:00 ' }]
      if (field === 'memberPreference') day.preferredTimeRange = {}
    })
    const original = structuredClone(input)
    assert.deepEqual(generateTimetablePlan(input), baseline)
    assert.deepEqual(input, original)
  }
})

test('別日のHard違反・不正transitionは対象日のplan・score・diagnosticsに混入しない', () => {
  const input = createInput({ bandCount: 2, sectionCount: 1 })
  const baseline = generateTimetablePlan(input)
  assert.equal(baseline.ok, true)
  addOtherDay(input)
  assert.deepEqual(generateTimetablePlan(input), baseline)
  input.stages[1].plannedEndTime = '10:05'
  input.eventMemberDays.find(day => day.eventDayId === 'day-2' &&
    day.eventMemberId === 'event-member-performer-0').participationStatus = 'absent'
  const violations = evaluateScheduleConstraints(input).hardViolations
  assert.ok(violations.some(violation => violation.code === 'STAGE_END_EXCEEDED'))
  assert.ok(violations.some(violation => violation.code === 'MEMBER_ABSENT'))
  const original = structuredClone(input)
  assert.deepEqual(generateTimetablePlan(input), baseline)
  assert.deepEqual(input, original)
  input.stages[1].transitionMinutes = NaN
  assert.deepEqual(generateTimetablePlan(input), baseline)
})

test('別日のSoft違反は対象日のplan・score・diagnosticsに混入しない', () => {
  const input = createInput({ bandCount: 2, sectionCount: 1 })
  const baseline = generateTimetablePlan(input)
  assert.equal(baseline.ok, true)
  addOtherDay(input)
  assert.deepEqual(generateTimetablePlan(input), baseline)
  input.eventBands.at(-1).preferredTimeRange = { from: '11:00', until: '12:00' }
  input.eventMemberDays.find(day => day.eventDayId === 'day-2' &&
    day.eventMemberId === 'event-member-performer-0').preferredTimeRange = { until: '09:00' }
  const evaluation = evaluateScheduleConstraints(input)
  assert.ok(evaluation.softViolations.some(violation => violation.code === 'PREFERENCE_NOT_MET'))
  assert.ok(evaluation.totalPenalty > 0)
  assert.deepEqual(generateTimetablePlan(input), baseline)
})

test('別日の正常・壊れたTT固定とDutyは対象日の生成可否へ混入しない', () => {
  const input = createInput({ bandCount: 2, sectionCount: 1 })
  const baseline = generateTimetablePlan(input)
  assert.equal(baseline.ok, true)
  addOtherDay(input)
  const lock = { id: 'day-2-lock', eventId: input.event.id, scheduleItemId: 'day-2-item',
    stageId: 'stage-day-2', sectionId: 'section-day-2', position: { kind: 'first' } }
  input.timetableLocks.push(lock)
  assert.deepEqual(generateTimetablePlan(input), baseline)
  // A resolvable other-day target with a broken lane must also remain out of scope.
  lock.stageId = 'missing-stage'
  lock.sectionId = 'missing-section'
  assert.deepEqual(generateTimetablePlan(input), baseline)
  lock.stageId = 'stage-day-2'
  lock.sectionId = 'section-day-2'
  lock.scheduleItemId = 'missing-item'
  input.dutyAssignments.push({ id: 'day-2-duty', dutyTypeId: 'missing-type',
    eventDayId: 'day-2', stageId: 'stage-day-2', memberId: 'main-0',
    from: { scheduleItemId: 'missing-item', edge: 'start' },
    until: { scheduleItemId: 'missing-item', edge: 'end' } })
  const original = structuredClone(input)
  assert.deepEqual(generateTimetablePlan(input), baseline)
  assert.deepEqual(input, original)
})

test('対象laneまたは対象Bandを参照する壊れたTT固定は引き続き事前失敗する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.timetableLocks.push({ id: 'lock', eventId: input.event.id, scheduleItemId: 'missing',
    stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'first' } })
  assert.equal(generateTimetablePlan(input).failure.code, 'INVALID_LOCK_CONSTRAINTS')
  input.scheduleItems.push({ id: 'existing', kind: 'performance',
    eventBandId: 'band-00', stageId: 'stage-1', sectionId: 'section-0', order: 0 })
  input.timetableLocks[0].scheduleItemId = 'existing'
  input.timetableLocks[0].stageId = 'missing-stage'
  input.timetableLocks[0].sectionId = 'missing-section'
  assert.equal(generateTimetablePlan(input).failure.code, 'INVALID_LOCK_CONSTRAINTS')
})

test('40 Band・4 Section・Main/Sub各4候補を全配置し、時間・担当負担を均等にする', () => {
  const input = createInput({ bandCount: 40, sectionCount: 4, paCount: 4 })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.length, 40)
  assert.equal(new Set(result.plan.placements.map(item => item.eventBandId)).size, 40)
  assert.equal(result.plan.paShifts.length, 8)
  assert.equal(result.plan.score.lastResortActivityCount, 0)
  assert.equal(result.plan.score.sectionDurationImbalance, 0)
  assert.equal(result.plan.score.sectionBandCountImbalance, 0)
  assert.equal(result.plan.score.paMainWorkloadImbalance, 0)
  assert.equal(result.plan.score.paSubWorkloadImbalance, 0)
  const scheduleItems = materializeSchedule(input, result.plan)
  assert.equal(evaluateScheduleConstraints({ ...input, scheduleItems }).hardViolations.length, 0)
  const calculatedItems = calculateEventDayTimelines({
    ...input, eventDayId: input.eventDay.id, scheduleItems,
  }).calculatedItems
  const paAssignments = materializePa(input, result.plan)
  assert.equal(detectScheduleIssues({
    ...input, calculatedItems, paAssignments,
  }).filter(issue => issue.severity === 'ERROR').length, 0)
  const activities = [
    ...buildPerformanceActivities(calculatedItems, input.eventBands).activities,
    ...buildPaActivities(paAssignments, calculatedItems).activities,
  ]
  for (const memberId of new Set(activities.map(activity => activity.memberId))) {
    assert.equal(evaluateMemberActivitySpacing({
      activities: activities.filter(activity => activity.memberId === memberId),
      stageItems: calculatedItems,
    }).feasible, true)
  }
  assert.deepEqual(generateTimetablePlan(input), result)
})

test('SectionなしStageを1 laneとして生成し、PA shiftも作る', () => {
  const input = createInput({ bandCount: 2, sectionCount: 0 })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.length, 2)
  assert.ok(result.plan.placements.every(item => item.sectionId === undefined))
  assert.equal(result.plan.paShifts.length, 2)
  assert.ok(result.plan.paShifts.every(shift => shift.sectionId === undefined))
})

test('PA候補がない場合は部分的なplanを返さず構造化された失敗になる', () => {
  const input = createInput()
  input.eventMembers.forEach(member => { member.paCapabilities.main = false })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_MAIN_PA_CANDIDATE')
  const withoutSub = createInput()
  withoutSub.eventMembers.forEach(member => { member.paCapabilities.sub = false })
  assert.equal(generateTimetablePlan(withoutSub).failure.code, 'NO_SUB_PA_CANDIDATE')
})

test('生成対象と無関係の入力を変更せず、厳しい探索上限を区別する', () => {
  const input = createInput()
  const original = structuredClone(input)
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
  }
  freeze(input)
  const result = generateTimetablePlan({ ...input, options: { maxScheduleCandidates: 1 } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(input, original)
})

test('PA出演衝突を避け、Bandを固定したSectionのMainを別候補へ割り当てる', () => {
  const input = createInput()
  input.eventBands[0].memberIds = ['main-0']
  input.eventBands[0].fixedPlacement = {
    stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'first' },
  }
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.find(item => item.eventBandId === 'band-00').sectionId,
    'section-0')
  assert.equal(result.plan.paShifts.find(shift =>
    shift.sectionId === 'section-0' && shift.role === 'main').memberId, 'main-1')
})

test('同時刻のMain/Subへ同じ人を割り当てず、候補1人だけなら失敗する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
  input.eventMembers = input.eventMembers.filter(member => member.memberId !== 'sub-0')
  input.eventMemberDays = input.eventMemberDays.filter(day => day.eventMemberId !== 'event-member-sub-0')
  input.eventMembers.find(member => member.memberId === 'main-0').paCapabilities.sub = true
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_FEASIBLE_PA_PLAN')
})

test('Section内・Section間Breakを維持し、PA shiftとSection長から部間休憩を除外する', () => {
  const input = createInput()
  input.scheduleItems = [
    { id: 'inside', kind: 'break', stageId: 'stage-1', sectionId: 'section-0',
      title: '部内休憩', durationMinutes: 5, order: 1 },
    { id: 'between', kind: 'break', stageId: 'stage-1', afterSectionId: 'section-0',
      title: '部間休憩', durationMinutes: 15, order: 0 },
  ]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.plan.breaks.map(item => item.scheduleItemId).sort(), ['between', 'inside'])
  assert.equal(result.plan.breaks.find(item => item.scheduleItemId === 'between').afterSectionId,
    'section-0')
  const firstShifts = result.plan.paShifts.filter(shift => shift.sectionId === 'section-0')
  const secondShifts = result.plan.paShifts.filter(shift => shift.sectionId === 'section-1')
  assert.ok(firstShifts.every(shift => shift.untilMinute - shift.fromMinute === 25))
  assert.ok(firstShifts.every(shift =>
    shift.fromBoundary.kind === 'existing-item' &&
    shift.fromBoundary.scheduleItemId === 'inside'))
  assert.ok(secondShifts.every(shift => shift.untilMinute - shift.fromMinute === 20))
  assert.equal(result.plan.score.sectionDurationImbalance, 5)
  assert.equal(secondShifts[0].fromMinute - firstShifts[0].untilMinute, 15)
})

const createCrossSectionInput = ({ existingItems = false, paCount = 2 } = {}) => {
  const input = createInput({ bandCount: 2, sectionCount: 2, paCount })
  input.stages[0].transitionMinutes = 5
  input.eventBands.forEach((band, index) => {
    band.fixedPlacement = { stageId: 'stage-1', sectionId: `section-${index}` }
    if (existingItems) input.scheduleItems.push({
      id: `existing-${index}`, kind: 'performance', eventBandId: band.id,
      stageId: 'stage-1', sectionId: `section-${index}`, order: 0,
    })
  })
  return input
}

for (const existingItems of [false, true]) {
  test(`Cross-Section転換を前Section PAとBoundaryへ含める (${existingItems ? '既存' : '新規'}Performance)`, () => {
    const input = createCrossSectionInput({ existingItems })
    const original = structuredClone(input)
    const result = generateTimetablePlan(input)
    const calculatedItems = verifyGeneratedSchedule(input, result)
    assert.deepEqual(calculatedItems.map(item => [item.plannedStartMinute, item.plannedEndMinute]),
      [[600, 610], [615, 625]])
    for (const shift of result.plan.paShifts) {
      assert.deepEqual([shift.fromMinute, shift.untilMinute],
        shift.sectionId === 'section-0' ? [600, 615] : [615, 625])
      if (shift.sectionId === 'section-0') {
        assert.deepEqual(shift.untilBoundary, existingItems
          ? { kind: 'existing-item', scheduleItemId: 'existing-1', edge: 'start' }
          : { kind: 'planned-performance', eventBandId: 'band-01', edge: 'start' })
      }
    }
    const assignments = materializePa(input, result.plan)
    assignments.forEach((assignment, index) => {
      assert.deepEqual(resolvePaAssignmentInterval(assignment, calculatedItems), {
        ok: true, interval: {
          fromMinute: result.plan.paShifts[index].fromMinute,
          untilMinute: result.plan.paShifts[index].untilMinute,
        },
      })
    })
    assert.equal(result.plan.score.sectionDurationImbalance, 5)
    assert.deepEqual(generateTimetablePlan(input), result)
    assert.deepEqual(input, original)
  })
}

test('Cross-Section転換は前Section durationへ加算しMain/Sub workloadに二重加算しない', () => {
  const input = createCrossSectionInput()
  const result = generateTimetablePlan(input)
  const calculatedItems = verifyGeneratedSchedule(input, result)
  const transition = getCrossSectionTransitions(input.sections, calculatedItems).get('section-0')
  assert.equal(transition.durationMinutes, 5)
  assert.equal(transition.untilItem.eventBandId, 'band-01')
  assert.deepEqual(getSectionBalance(input.stages, input.sections, calculatedItems), {
    durationImbalance: 5, bandCountImbalance: 0,
  })
  for (const role of ['main', 'sub']) {
    const shifts = result.plan.paShifts.filter(shift => shift.role === role)
    assert.deepEqual(shifts.map(shift => shift.untilMinute - shift.fromMinute), [15, 10])
    assert.equal(shifts.reduce((sum, shift) => sum + shift.untilMinute - shift.fromMinute, 0), 25)
    assert.equal(getPaWorkloadImbalance(role, shifts, [`${role}-0`, `${role}-1`]), 5)
  }
  assert.equal(result.plan.score.paMainWorkloadImbalance, 5)
  assert.equal(result.plan.score.paSubWorkloadImbalance, 5)
})

test('明示的Section間BreakはPA coverageにもSection durationにも含めない', () => {
  const input = createCrossSectionInput()
  input.scheduleItems.push({ id: 'inter-break', kind: 'break', title: '部間休憩',
    stageId: 'stage-1', afterSectionId: 'section-0', order: 0, durationMinutes: 10 })
  const result = generateTimetablePlan(input)
  const calculatedItems = verifyGeneratedSchedule(input, result)
  assert.equal(getCrossSectionTransitions(input.sections, calculatedItems).size, 0)
  for (const shift of result.plan.paShifts) {
    assert.deepEqual([shift.fromMinute, shift.untilMinute],
      shift.sectionId === 'section-0' ? [600, 610] : [620, 630])
  }
  assert.equal(result.plan.score.sectionDurationImbalance, 0)
})

test('Section anchor idleは転換と同じ5分でも20分でもPA/Section durationへ含めない', () => {
  for (const anchor of ['10:15', '10:30']) {
    const input = createCrossSectionInput()
    input.sections[1].plannedStartTime = anchor
    const result = generateTimetablePlan(input)
    const calculatedItems = verifyGeneratedSchedule(input, result)
    assert.equal(getCrossSectionTransitions(input.sections, calculatedItems).size, 0)
    assert.ok(result.plan.paShifts.filter(shift => shift.sectionId === 'section-0')
      .every(shift => shift.untilMinute === 610 && shift.untilBoundary.edge === 'end'))
    assert.ok(result.plan.paShifts.filter(shift => shift.sectionId === 'section-1')
      .every(shift => shift.fromMinute === (anchor === '10:15' ? 615 : 630)))
    assert.equal(result.plan.score.sectionDurationImbalance, 0)
  }
})

test('部境界の前後どちらかがSection内BreakならCross-Section転換を追加しない', () => {
  for (const sectionId of ['section-0', 'section-1']) {
    const input = createCrossSectionInput({ existingItems: true })
    if (sectionId === 'section-1') input.scheduleItems[1].order = 1
    input.scheduleItems.push({ id: 'inside-break', kind: 'break', title: '部内休憩',
      stageId: 'stage-1', sectionId, order: sectionId === 'section-0' ? 1 : 0, durationMinutes: 5 })
    const result = generateTimetablePlan(input)
    const calculatedItems = verifyGeneratedSchedule(input, result)
    assert.equal(getCrossSectionTransitions(input.sections, calculatedItems).size, 0)
    for (const shift of result.plan.paShifts) {
      assert.equal(shift.untilMinute - shift.fromMinute, shift.sectionId === sectionId ? 15 : 10)
    }
    assert.equal(result.plan.score.sectionDurationImbalance, 5)
  }
})

test('空の中間SectionのanchorによるidleもCross-Section転換と推測しない', () => {
  const input = createCrossSectionInput()
  input.sections[1].order = 2
  input.sections.push({ id: 'empty-section', stageId: 'stage-1', name: 'Empty', order: 1,
    plannedStartTime: '10:15' })
  const result = generateTimetablePlan(input)
  const calculatedItems = verifyGeneratedSchedule(input, result)
  assert.equal(getCrossSectionTransitions(input.sections, calculatedItems).size, 0)
  assert.ok(result.plan.paShifts.filter(shift => shift.sectionId === 'section-0')
    .every(shift => shift.untilMinute === 610))
  assert.ok(result.plan.paShifts.every(shift => shift.untilMinute - shift.fromMinute === 10))
  assert.equal(result.plan.score.sectionDurationImbalance, 10) // 10 / 0 / 10
})

test('transition 0なら部境界に余計な時間を加えない', () => {
  const input = createCrossSectionInput()
  input.stages[0].transitionMinutes = 0
  const result = generateTimetablePlan(input)
  const calculatedItems = verifyGeneratedSchedule(input, result)
  assert.equal(getCrossSectionTransitions(input.sections, calculatedItems).get('section-0')
    .durationMinutes, 0)
  assert.ok(result.plan.paShifts.every(shift => shift.untilMinute - shift.fromMinute === 10))
  assert.equal(result.plan.score.sectionDurationImbalance, 0)
  assert.equal(result.plan.score.paMainWorkloadImbalance, 0)
})

test('前Section PAのavailabilityをCross-Section転換終了まで確認する', () => {
  const input = createCrossSectionInput({ paCount: 3 })
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .availabilityWindows = [{ until: '10:10' }]
  const result = generateTimetablePlan(input)
  verifyGeneratedSchedule(input, result)
  const firstMain = result.plan.paShifts.find(shift => shift.sectionId === 'section-0' && shift.role === 'main')
  assert.equal(firstMain.untilMinute, 615)
  assert.notEqual(firstMain.memberId, 'main-0')
})

test('first・index・lastのTT固定を既存ScheduleItem IDで満たす', () => {
  const input = createInput({ bandCount: 3, sectionCount: 1 })
  input.scheduleItems = input.eventBands.map((band, index) => ({
    id: `item-${index}`, kind: 'performance', eventBandId: band.id,
    stageId: 'stage-1', sectionId: 'section-0', order: index,
  }))
  input.timetableLocks = [
    { id: 'lock-first', eventId: input.event.id, scheduleItemId: 'item-2',
      stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'first' } },
    { id: 'lock-index', eventId: input.event.id, scheduleItemId: 'item-0',
      stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'index', index: 1 } },
    { id: 'lock-last', eventId: input.event.id, scheduleItemId: 'item-1',
      stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'last' } },
  ]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.plan.placements.map(item => item.scheduleItemId),
    ['item-2', 'item-0', 'item-1'])
  assert.equal(evaluateTimetableLocks({
    eventId: input.event.id, timetableLocks: input.timetableLocks,
    scheduleItems: materializeSchedule(input, result.plan),
    eventBands: input.eventBands, eventDays: input.eventDays,
    stages: input.stages, sections: input.sections,
  }).valid, true)
})

test('現在の配置がLock違反でも、解決可能な対象を正しいStageへ戻してIDを再利用する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.eventDays.push({ id: 'day-2', eventId: input.event.id, date: '2027-11-07', order: 1 })
  input.stages.push({ id: 'stage-day-2', eventDayId: 'day-2',
    name: 'Other day', order: 0, plannedStartTime: '10:00' })
  input.scheduleItems.push({ id: 'existing', kind: 'performance',
    eventBandId: 'band-00', stageId: 'stage-day-2', order: 0 })
  input.timetableLocks.push({ id: 'lock-1', eventId: input.event.id,
    scheduleItemId: 'existing', stageId: 'stage-1', sectionId: 'section-0',
    position: { kind: 'first' } })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements[0].scheduleItemId, 'existing')
  assert.equal(result.plan.placements[0].stageId, 'stage-1')
  assert.equal(result.plan.placements[0].sectionId, 'section-0')
})

test('fixed Stage・Section・position・開始時刻を満たす配置を選ぶ', () => {
  const input = createInput({ bandCount: 2, sectionCount: 1 })
  input.eventBands[1].fixedPlacement = {
    stageId: 'stage-1', sectionId: 'section-0',
    position: { kind: 'last' }, plannedStartTime: '10:10',
  }
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.find(item => item.eventBandId === 'band-01').position, 1)
  assert.equal(evaluateScheduleConstraints({
    ...input, scheduleItems: materializeSchedule(input, result.plan),
  }).hardViolations.length, 0)
})

test('fixedPlacementのfirst・index・last予約を同じlaneで満たす', () => {
  const input = createInput({ bandCount: 3, sectionCount: 1 })
  input.eventBands[0].fixedPlacement = {
    stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'last' },
  }
  input.eventBands[1].fixedPlacement = {
    stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'index', index: 1 },
    plannedStartTime: '10:10',
  }
  input.eventBands[2].fixedPlacement = {
    stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'first' },
  }
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.plan.placements.map(item => item.eventBandId),
    ['band-02', 'band-01', 'band-00'])
  assert.equal(evaluateScheduleConstraints({
    ...input, scheduleItems: materializeSchedule(input, result.plan),
  }).hardViolations.length, 0)
})

test('Section付きStageのみのfixedPlacementはそのStage内のいずれかのSectionへ配置する', () => {
  const input = createInput({ bandCount: 4, sectionCount: 2 })
  input.stages.push({ id: 'stage-2', eventDayId: input.eventDay.id, name: 'Other',
    order: 1, plannedStartTime: '12:00' })
  input.eventBands[3].fixedPlacement = { stageId: 'stage-1' }
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  verifyGeneratedSchedule(input, result)
  const placement = result.plan.placements.find(item => item.eventBandId === 'band-03')
  assert.equal(placement.stageId, 'stage-1')
  assert.ok(['section-0', 'section-1'].includes(placement.sectionId))
  assert.deepEqual(input, original)
})

test('Stage-only first・last・indexはSection内でなくStage全体のPerformance順位を満たす', () => {
  for (const [position, expectedIndex] of [
    [{ kind: 'first' }, 0], [{ kind: 'last' }, 3], [{ kind: 'index', index: 2 }, 2],
  ]) {
    const input = createInput({ bandCount: 4, sectionCount: 2 })
    input.eventBands[3].fixedPlacement = { stageId: 'stage-1', position }
    const result = generateTimetablePlan(input)
    const timeline = verifyGeneratedSchedule(input, result)
    const performances = timeline.filter(item => item.kind === 'performance')
    assert.equal(performances.findIndex(item => item.eventBandId === 'band-03'), expectedIndex)
    assert.ok(result.plan.placements.some(item => item.sectionId === 'section-0'))
    assert.ok(result.plan.placements.some(item => item.sectionId === 'section-1'))
    assert.deepEqual(generateTimetablePlan(input), result)
  }
})

test('複数のStage-wide位置予約とexact Section固定を同時に満たす', () => {
  const input = createInput({ bandCount: 4, sectionCount: 2 })
  input.eventBands[0].fixedPlacement = { stageId: 'stage-1', position: { kind: 'last' } }
  input.eventBands[1].fixedPlacement = { stageId: 'stage-1', position: { kind: 'first' } }
  input.eventBands[2].fixedPlacement = { stageId: 'stage-1', position: { kind: 'index', index: 2 } }
  input.eventBands[3].fixedPlacement = { stageId: 'stage-1', sectionId: 'section-0' }
  const result = generateTimetablePlan(input)
  const timeline = verifyGeneratedSchedule(input, result)
  assert.deepEqual(timeline.filter(item => item.kind === 'performance').map(item => item.eventBandId),
    ['band-01', 'band-03', 'band-02', 'band-00'])
  assert.equal(result.plan.placements.find(item => item.eventBandId === 'band-03').sectionId, 'section-0')
})

test('Stage-only plannedStartTimeを満たすSectionを探索する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 2, paCount: 1 })
  input.sections[1].plannedStartTime = '11:30'
  input.eventBands[0].fixedPlacement = { stageId: 'stage-1', plannedStartTime: '11:30' }
  const result = generateTimetablePlan(input)
  const timeline = verifyGeneratedSchedule(input, result)
  assert.equal(result.plan.placements[0].sectionId, 'section-1')
  assert.equal(timeline.find(item => item.kind === 'performance').plannedStartMinute, 690)
})

test('Stage-only fixedと同じStageのSection Lockは互換、別Stage Lockは競合となる', () => {
  const input = createInput({ bandCount: 1, sectionCount: 2, paCount: 1 })
  input.eventBands[0].fixedPlacement = { stageId: 'stage-1' }
  input.scheduleItems.push({ id: 'existing', kind: 'performance', eventBandId: 'band-00',
    stageId: 'stage-1', sectionId: 'section-1', order: 0 })
  input.timetableLocks.push({ id: 'lock', eventId: input.event.id, scheduleItemId: 'existing',
    stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'first' } })
  const result = generateTimetablePlan(input)
  verifyGeneratedSchedule(input, result)
  assert.equal(result.plan.placements[0].sectionId, 'section-1')
  input.stages.push({ id: 'stage-2', eventDayId: input.eventDay.id, name: 'Other',
    order: 1, plannedStartTime: '12:00' })
  input.timetableLocks[0].stageId = 'stage-2'
  delete input.timetableLocks[0].sectionId
  assert.equal(generateTimetablePlan(input).failure.code, 'INVALID_LOCK_CONSTRAINTS')
})

test('malformed fixedPlacementのStage/Section参照はLock失敗でなくINVALID_INPUT', () => {
  for (const fixed of [
    { stageId: 'missing-stage' }, { stageId: 'stage-day-2' },
    { stageId: 'stage-1', sectionId: 'missing-section' },
    { stageId: 'stage-1', sectionId: 'section-other-stage' },
    { stageId: 'stage-1', sectionId: 'section-day-2' }, {}, null,
  ]) {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    addOtherDay(input)
    input.stages.push({ id: 'stage-other', eventDayId: 'day-1', name: 'Other',
      order: 1, plannedStartTime: '11:00' })
    input.sections.push({ id: 'section-other-stage', stageId: 'stage-other', name: 'Other', order: 0 })
    input.eventBands[0].fixedPlacement = fixed
    const original = structuredClone(input)
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_INPUT', eventDayId: 'day-1', attemptedSchedules: 0, eventBandId: 'band-00',
    } }, JSON.stringify(fixed))
    assert.deepEqual(input, original)
  }
})

test('fixedPlacementの不正なposition kind/indexは探索前にINVALID_INPUT', () => {
  for (const position of [
    { kind: 'middle' }, {}, null,
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, '0']
      .map(index => ({ kind: 'index', index })),
  ]) {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    input.eventBands[0].fixedPlacement = { stageId: 'stage-1', position }
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_INPUT', eventDayId: 'day-1', attemptedSchedules: 0, eventBandId: 'band-00',
    } })
  }
})

test('不正なfixed plannedStartTimeも引き続きINVALID_INPUT', () => {
  for (const plannedStartTime of ['abc', '25:00']) {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    input.eventBands[0].fixedPlacement = { stageId: 'stage-1', plannedStartTime }
    assert.equal(generateTimetablePlan(input).failure.code, 'INVALID_INPUT')
  }
})

test('別日のmalformed fixedPlacementは対象日の生成に影響しない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
  const baseline = generateTimetablePlan(input)
  assert.equal(baseline.ok, true)
  addOtherDay(input)
  input.eventBands.at(-1).fixedPlacement = { stageId: 'missing-stage', position: { kind: 'index', index: -1 } }
  assert.deepEqual(generateTimetablePlan(input), baseline)
})

test('Stage-wide indexとSection-local Lock positionを混同せず両方満たす', () => {
  const input = createInput({ bandCount: 4, sectionCount: 2 })
  input.eventBands[3].fixedPlacement = { stageId: 'stage-1', position: { kind: 'index', index: 2 } }
  input.scheduleItems.push({ id: 'existing', kind: 'performance', eventBandId: 'band-03',
    stageId: 'stage-1', sectionId: 'section-1', order: 0 })
  input.timetableLocks.push({ id: 'lock', eventId: input.event.id, scheduleItemId: 'existing',
    stageId: 'stage-1', sectionId: 'section-1', position: { kind: 'first' } })
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  const timeline = verifyGeneratedSchedule(input, result)
  assert.equal(timeline.filter(item => item.kind === 'performance')[2].eventBandId, 'band-03')
  const placement = result.plan.placements.find(item => item.eventBandId === 'band-03')
  assert.equal(placement.sectionId, 'section-1')
  assert.equal(placement.position, 0)
  assert.deepEqual(input, original)
})

test('壊れたDuty Boundaryは推測せず失敗し、既存Dutyを変更しない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.dutyTypes = [{ id: 'photo', eventId: input.event.id, name: '撮影', order: 0 }]
  input.dutyAssignments = [{
    id: 'duty-1', dutyTypeId: 'photo', eventDayId: input.eventDay.id,
    stageId: 'stage-1', memberId: 'main-0',
    from: { scheduleItemId: 'missing', edge: 'start' },
    until: { scheduleItemId: 'missing', edge: 'end' },
  }]
  const original = structuredClone(input.dutyAssignments)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'BROKEN_DUTY_ASSIGNMENT')
  assert.deepEqual(input.dutyAssignments, original)
})

test('2 Stageを同時に扱い、同じMemberの同時出演を避ける', () => {
  const input = createInput({ bandCount: 2, sectionCount: 0 })
  input.stages.push({
    id: 'stage-2', eventDayId: input.eventDay.id, name: 'Sub', order: 1,
    plannedStartTime: '10:30',
  })
  input.eventBands[1].memberIds = input.eventBands[0].memberIds
  input.eventBands[0].fixedPlacement = { stageId: 'stage-1' }
  input.eventBands[1].fixedPlacement = { stageId: 'stage-2' }
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(new Set(result.plan.placements.map(item => item.stageId)).size, 2)
})

test('探索上限で未発見の場合はNO_FEASIBLEと区別する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 2, paCount: 1 })
  input.eventBands[0].memberIds = ['main-0']
  const result = generateTimetablePlan({
    ...input, options: { maxScheduleCandidates: 1 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'SEARCH_LIMIT_REACHED')
})

const createPaLimitInput = ({ limitFirst = true, laterSuccess = false } = {}) => {
  const input = createInput({ bandCount: 1, sectionCount: 1, paCount: laterSuccess ? 2 : 1 })
  input.stages[0].plannedStartTime = limitFirst ? '10:00' : '11:00'
  input.stages.push({ id: 'stage-2', eventDayId: input.eventDay.id, name: 'Other',
    order: 1, plannedStartTime: limitFirst ? '11:00' : '10:00' })
  input.sections.push({ id: 'section-1', stageId: 'stage-2', name: 'Other Section', order: 0 })
  input.eventMembers.find(member => member.memberId === 'sub-0').paCapabilities.main = true
  // Try the overlapping shared-role member before the viable Main candidate:
  // the cap must be reached before any complete PA plan is accumulated.
  input.members.find(member => member.id === 'sub-0').realName = 'aa-shared'
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .availabilityWindows = [{ until: '10:10' }]
  if (laterSuccess) {
    input.eventMemberDays.find(day => day.eventMemberId === 'event-member-sub-0')
      .availabilityWindows = [{ until: '10:10' }]
    for (const memberId of ['main-1', 'sub-1']) {
      input.eventMemberDays.find(day => day.eventMemberId === `event-member-${memberId}`)
        .availabilityWindows = [{ from: '11:00' }]
    }
  }
  input.options = { maxPaExpandedStates: 2 }
  return input
}

const generateInFixedLane = (input, stageId, sectionId) => generateTimetablePlan({
  ...input,
  eventBands: input.eventBands.map(band => ({ ...band, fixedPlacement: { stageId, sectionId } })),
})

test('PA探索上限の後にNO_FEASIBLE_PA_PLANが出ても上限と最初のscopeを維持する', () => {
  const input = createPaLimitInput()
  const limited = generateInFixedLane(input, 'stage-1', 'section-0')
  assert.equal(limited.failure.code, 'SEARCH_LIMIT_REACHED')
  const impossible = generateInFixedLane(input, 'stage-2', 'section-1')
  assert.equal(impossible.failure.code, 'NO_FEASIBLE_PA_PLAN')
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.deepEqual(result, { ok: false, failure: {
    code: 'SEARCH_LIMIT_REACHED', eventDayId: input.eventDay.id, attemptedSchedules: 2,
    stageId: 'stage-1', sectionId: 'section-0',
  } })
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('NO_FEASIBLE_PA_PLANの後にPA探索上限が出てもSEARCH_LIMIT_REACHEDとなる', () => {
  const input = createPaLimitInput({ limitFirst: false })
  assert.equal(generateInFixedLane(input, 'stage-1', 'section-0').failure.code, 'NO_FEASIBLE_PA_PLAN')
  assert.equal(generateInFixedLane(input, 'stage-2', 'section-1').failure.code, 'SEARCH_LIMIT_REACHED')
  assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
    code: 'SEARCH_LIMIT_REACHED', eventDayId: input.eventDay.id, attemptedSchedules: 2,
    stageId: 'stage-2', sectionId: 'section-1',
  } })
})

test('PA探索上限の後でもfeasible planが見つかれば成功を優先する', () => {
  const input = createPaLimitInput({ laterSuccess: true })
  assert.equal(generateInFixedLane(input, 'stage-1', 'section-0').failure.code, 'SEARCH_LIMIT_REACHED')
  assert.equal(generateInFixedLane(input, 'stage-2', 'section-1').ok, true)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.diagnostics.scheduleCandidatesEvaluated, 2)
  assert.ok(result.plan.placements.every(item => item.stageId === 'stage-2'))
  assert.deepEqual(result.plan.paShifts.map(shift => shift.memberId).sort(), ['main-1', 'sub-1'])
})

test('複数候補がPA探索上限に達した場合は最初のscopeをdeterministicに維持する', () => {
  const input = createPaLimitInput()
  input.stages[1].plannedStartTime = '10:00'
  const result = generateTimetablePlan(input)
  assert.equal(result.failure.code, 'SEARCH_LIMIT_REACHED')
  assert.equal(result.failure.attemptedSchedules, 2)
  assert.equal(result.failure.stageId, 'stage-1')
  assert.equal(result.failure.sectionId, 'section-0')
  assert.deepEqual(generateTimetablePlan(input), result)
})

test('proposalが0件でも未探索variantがあればSchedule探索上限、全探索済みならNO_FEASIBLEとなる', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.eventBands[0].fixedPlacement = { stageId: 'stage-1', sectionId: 'section-0',
    position: { kind: 'index', index: 2 } }
  const limited = generateTimetablePlan({ ...input, options: { maxScheduleCandidates: 1 } })
  assert.deepEqual(limited, { ok: false, failure: {
    code: 'SEARCH_LIMIT_REACHED', eventDayId: input.eventDay.id, attemptedSchedules: 0,
  } })
  const exhaustive = generateTimetablePlan({ ...input, options: { maxScheduleCandidates: 10 } })
  assert.deepEqual(exhaustive, { ok: false, failure: {
    code: 'NO_FEASIBLE_SCHEDULE', eventDayId: input.eventDay.id, attemptedSchedules: 0,
  } })
})

test('PAとScheduleの両capでも完成planを優先し、完成前ならPA scope付きSEARCH_LIMITを返す', () => {
  const input = createPaLimitInput()
  input.options.maxScheduleCandidates = 1
  assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
    code: 'SEARCH_LIMIT_REACHED', eventDayId: input.eventDay.id, attemptedSchedules: 1,
    stageId: 'stage-1', sectionId: 'section-0',
  } })
  // A viable final-task candidate is now visited before the expansion cap.
  input.members.find(member => member.id === 'sub-0').realName = 'zz-shared'
  const result = generateTimetablePlan(input)
  verifyGeneratedSchedule(input, result)
  assert.equal(result.plan.diagnostics.scheduleCandidatesEvaluated, 1)
  assert.deepEqual(result.plan.paShifts.map(shift => shift.memberId).sort(), ['main-0', 'sub-0'])
})

test('PAが後付けで不可能な配置を棄却し、BandのSection割当を探索し直す', () => {
  const input = createInput({ bandCount: 2, sectionCount: 2, paCount: 2 })
  input.eventBands[1].memberIds = ['main-0']
  input.scheduleItems.push({
    id: 'inter-break', kind: 'break', title: '休憩', durationMinutes: 15,
    stageId: 'stage-1', afterSectionId: 'section-0', order: 0,
  })
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-1')
    .availabilityWindows = [{ until: '10:10' }]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.find(item => item.eventBandId === 'band-01').sectionId,
    'section-0')
  assert.ok(result.plan.diagnostics.scheduleCandidatesEvaluated >= 2)
  assert.equal(result.plan.paShifts.find(shift =>
    shift.sectionId === 'section-1' && shift.role === 'main').memberId, 'main-0')
})

test('0 band gapを避けられる場合は2 band以上空けてlast-resortを作らない', () => {
  const input = createInput({ bandCount: 4, sectionCount: 0 })
  input.eventBands[3].memberIds = input.eventBands[0].memberIds
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.score.lastResortActivityCount, 0)
  const positions = result.plan.placements.filter(item =>
    ['band-00', 'band-03'].includes(item.eventBandId)).map(item => item.position)
  assert.equal(Math.abs(positions[0] - positions[1]), 3)
})

test('Section間Breakで休めるなら同じPAが複数Sectionを担当できる', () => {
  const input = createInput({ bandCount: 2, sectionCount: 2, paCount: 1 })
  input.scheduleItems.push({
    id: 'inter-break', kind: 'break', title: '休憩', durationMinutes: 10,
    stageId: 'stage-1', afterSectionId: 'section-0', order: 0,
  })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.paShifts.filter(shift => shift.memberId === 'main-0').length, 2)
  assert.equal(result.plan.paShifts.filter(shift => shift.memberId === 'sub-0').length, 2)
})

test('DutyとPAの衝突を避け、担当可能な別Memberを選ぶ', () => {
  const input = createInput({ bandCount: 1, sectionCount: 0 })
  input.scheduleItems.push({
    id: 'break-1', kind: 'break', title: '準備', durationMinutes: 10,
    stageId: 'stage-1', order: 0,
  })
  input.dutyTypes = [{ id: 'photo', eventId: input.event.id, name: '撮影', order: 0 }]
  input.dutyAssignments = [{
    id: 'duty-1', dutyTypeId: 'photo', eventDayId: input.eventDay.id,
    stageId: 'stage-1', memberId: 'main-0',
    from: { scheduleItemId: 'break-1', edge: 'start' },
    until: { scheduleItemId: 'break-1', edge: 'end' },
  }]
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.paShifts.find(shift => shift.role === 'main').memberId, 'main-1')
})

test('既存Dutyと出演の衝突を避け、参照BoundaryとBreakを保つ', () => {
  const input = createInput({ bandCount: 2, sectionCount: 0 })
  input.scheduleItems = [
    { id: 'existing-a', kind: 'performance', eventBandId: 'band-00',
      stageId: 'stage-1', order: 0 },
    { id: 'break-1', kind: 'break', title: '休憩', durationMinutes: 20,
      stageId: 'stage-1', order: 1 },
    { id: 'existing-b', kind: 'performance', eventBandId: 'band-01',
      stageId: 'stage-1', order: 2 },
  ]
  input.dutyTypes = [{ id: 'photo', eventId: input.event.id, name: '撮影', order: 0 }]
  input.dutyAssignments = [{
    id: 'duty-1', dutyTypeId: 'photo', eventDayId: input.eventDay.id,
    stageId: 'stage-1', memberId: 'performer-1',
    from: { scheduleItemId: 'existing-a', edge: 'start' },
    until: { scheduleItemId: 'existing-a', edge: 'end' },
  }]
  const original = structuredClone(input.dutyAssignments)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.find(item => item.eventBandId === 'band-01').order, 2)
  assert.equal(result.plan.breaks[0].scheduleItemId, 'break-1')
  assert.deepEqual(input.dutyAssignments, original)
})

test('Stage plannedEndを超える案を採らず、収まるStageへ配置する', () => {
  const input = createInput({ bandCount: 2, sectionCount: 0 })
  input.stages[0].plannedEndTime = '10:10'
  input.stages.push({
    id: 'stage-2', eventDayId: input.eventDay.id, name: 'Other', order: 1,
    plannedStartTime: '10:00', plannedEndTime: '10:20',
  })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.filter(item => item.stageId === 'stage-1').length, 1)
  assert.equal(result.plan.placements.filter(item => item.stageId === 'stage-2').length, 1)
})

test('Section plannedEndを超える案を採らず、収まるSectionへ配置する', () => {
  const input = createInput({ bandCount: 2, sectionCount: 2 })
  input.sections[0].plannedEndTime = '10:10'
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.filter(item => item.sectionId === 'section-0').length, 1)
  assert.equal(result.plan.placements.filter(item => item.sectionId === 'section-1').length, 1)
})

for (const [start, end] of [
  ['10:00', '10:00'], ['10:00', '09:00'],
  ['25:00', undefined], ['abc', undefined], ['10:00', '25:00'], ['10:00', 'abc'],
]) {
  test(`不正なStage時間範囲 ${start}〜${end ?? '自動'} は探索前にINVALID_INPUT`, () => {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    input.stages[0].plannedStartTime = start
    input.stages[0].plannedEndTime = end
    const original = structuredClone(input)
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_INPUT', eventDayId: input.eventDay.id, attemptedSchedules: 0,
    } })
    assert.deepEqual(input, original)
  })
}

for (const [start, end] of [
  ['09:00', '09:30'], ['11:30', '12:30'], ['11:00', '10:30'], ['10:30', '10:30'],
  ['12:00', undefined], ['12:30', undefined], [undefined, '10:00'], [undefined, '09:30'],
  ['abc', undefined], [undefined, '25:00'],
]) {
  test(`Stage 10:00〜12:00に不正なSection ${start ?? '自動'}〜${end ?? '自動'} は探索前にINVALID_INPUT`, () => {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    input.stages[0].plannedEndTime = '12:00'
    input.sections[0].plannedStartTime = start
    input.sections[0].plannedEndTime = end
    assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
      code: 'INVALID_INPUT', eventDayId: input.eventDay.id, attemptedSchedules: 0,
    } })
  })
}

test('Stage範囲内の隣接Section 10:00〜11:00 / 11:00〜12:00は生成可能', () => {
  const input = createInput({ bandCount: 2, sectionCount: 2 })
  input.stages[0].plannedEndTime = '12:00'
  input.sections[0].plannedStartTime = '10:00'
  input.sections[0].plannedEndTime = '11:00'
  input.sections[1].plannedStartTime = '11:00'
  input.sections[1].plannedEndTime = '12:00'
  input.eventBands.forEach((band, index) => {
    band.fixedPlacement = { stageId: 'stage-1', sectionId: `section-${index}` }
  })
  verifyGeneratedSchedule(input, generateTimetablePlan(input))
})

for (const [stageEnd, sectionStart, sectionEnd] of [
  ['12:00', undefined, undefined], ['12:00', '10:30', undefined],
  ['12:00', undefined, '11:00'], [undefined, '11:00', '12:00'],
  [undefined, undefined, undefined],
]) {
  test(`optional anchorsを維持: Stage終了${stageEnd ?? '自動'} / Section ${sectionStart ?? '自動'}〜${sectionEnd ?? '自動'}`, () => {
    const input = createInput({ bandCount: 1, sectionCount: 1 })
    input.stages[0].plannedEndTime = stageEnd
    input.sections[0].plannedStartTime = sectionStart
    input.sections[0].plannedEndTime = sectionEnd
    verifyGeneratedSchedule(input, generateTimetablePlan(input))
  })
}

const createDutyFailureInput = ({ dutyFirst = false } = {}) => {
  const input = createInput({ bandCount: 2, sectionCount: 1, paCount: 1 })
  input.stages[0].order = dutyFirst ? 1 : 0
  input.stages.push({ id: 'stage-2', eventDayId: input.eventDay.id, name: 'PA failure Stage',
    order: dutyFirst ? 0 : 1, plannedStartTime: '11:00' })
  input.sections.push({ id: 'section-1', stageId: 'stage-2', name: 'PA failure Section', order: 0 })
  input.eventBands[1].fixedPlacement = {
    stageId: 'stage-2', sectionId: 'section-1', position: { kind: 'first' },
  }
  // Equal lane loads let successive variants move band-00 between the Stages.
  input.scheduleItems = [
    { id: 'break-1', kind: 'break', title: '休憩', durationMinutes: 10,
      stageId: 'stage-1', sectionId: 'section-0', order: 0 },
    { id: 'existing-0', kind: 'performance', eventBandId: 'band-00',
      stageId: 'stage-1', sectionId: 'section-0', order: 1 },
  ]
  input.dutyTypes = [{ id: 'photo', eventId: input.event.id, name: '撮影', order: 0 }]
  input.dutyAssignments = [{ id: 'duty-1', dutyTypeId: 'photo', eventDayId: input.eventDay.id,
    stageId: 'stage-1', memberId: 'performer-1',
    from: { scheduleItemId: 'existing-0', edge: 'start' },
    until: { scheduleItemId: 'existing-0', edge: 'end' },
  }]
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .availabilityWindows = [{ until: '10:30' }]
  return input
}

const fixDutyBoundaryBandToStage = (input, stageId, sectionId) => ({
  ...input,
  eventBands: input.eventBands.map((band, index) => index === 0
    ? { ...band, fixedPlacement: { stageId, sectionId } } : band),
})

test('PA失敗の後のDuty境界失敗はDutyのStageを返し、以前のPA Stage/Sectionを残さない', () => {
  const input = createDutyFailureInput()
  const paFailure = generateTimetablePlan(fixDutyBoundaryBandToStage(input, 'stage-1', 'section-0'))
  assert.equal(paFailure.failure.code, 'NO_MAIN_PA_CANDIDATE')
  assert.equal(paFailure.failure.stageId, 'stage-2')
  assert.equal(paFailure.failure.sectionId, 'section-1')
  const dutyFailure = generateTimetablePlan(fixDutyBoundaryBandToStage(input, 'stage-2', 'section-1'))
  assert.equal(dutyFailure.failure.code, 'BROKEN_DUTY_ASSIGNMENT')
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.deepEqual(result, { ok: false, failure: {
    code: 'BROKEN_DUTY_ASSIGNMENT', eventDayId: input.eventDay.id,
    attemptedSchedules: 2, stageId: 'stage-1',
  } })
  assert.deepEqual(generateTimetablePlan(input), result)
  assert.deepEqual(input, original)
})

test('Duty境界失敗の後のPA失敗は最新のPA Stage/Sectionを返す', () => {
  const input = createDutyFailureInput({ dutyFirst: true })
  assert.deepEqual(generateTimetablePlan(input), { ok: false, failure: {
    code: 'NO_MAIN_PA_CANDIDATE', eventDayId: input.eventDay.id,
    attemptedSchedules: 2, stageId: 'stage-2', sectionId: 'section-1',
  } })
})

test('後続Duty失敗はstickyなPA探索上限のStage/Sectionを上書きしない', () => {
  const input = createDutyFailureInput()
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .availabilityWindows = undefined
  input.options = { maxPaExpandedStates: 1 }
  const limited = generateTimetablePlan(fixDutyBoundaryBandToStage(input, 'stage-1', 'section-0'))
  assert.equal(limited.failure.code, 'SEARCH_LIMIT_REACHED')
  const dutyFailure = generateTimetablePlan(fixDutyBoundaryBandToStage(input, 'stage-2', 'section-1'))
  assert.equal(dutyFailure.failure.code, 'BROKEN_DUTY_ASSIGNMENT')
  const result = generateTimetablePlan(input)
  assert.deepEqual(result, { ok: false, failure: {
    code: 'SEARCH_LIMIT_REACHED', eventDayId: input.eventDay.id,
    attemptedSchedules: 2, stageId: limited.failure.stageId,
    sectionId: limited.failure.sectionId,
  } })
  assert.deepEqual(generateTimetablePlan(input), result)
})

test('PA shiftはPerformance間transitionも含むSection全体の実時間で作る', () => {
  const input = createInput({ bandCount: 2, sectionCount: 1 })
  input.event.defaultTransitionMinutes = 5
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.plan.paShifts.every(shift => shift.untilMinute - shift.fromMinute === 25))
})

test('全App配列を受け取っても他EventのScheduleItemを評価対象に混ぜない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 0 })
  input.eventDays.push({ id: 'foreign-day', eventId: 'foreign-event', date: '2027-11-07', order: 0 })
  input.stages.push({ id: 'foreign-stage', eventDayId: 'foreign-day', name: 'Foreign',
    order: 0, plannedStartTime: '10:00' })
  input.eventBands.push({ id: 'foreign-band', eventId: 'foreign-event',
    eventDayId: 'foreign-day', name: 'Foreign', memberIds: [], durationMinutes: 10 })
  input.scheduleItems.push({ id: 'foreign-item', kind: 'performance',
    eventBandId: 'foreign-band', stageId: 'foreign-stage', order: 0 })
  const original = structuredClone(input)
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.plan.placements.map(item => item.eventBandId), ['band-00'])
  assert.deepEqual(input, original)
})

test('別EventDayの配置・Breakを変更対象に含めない', () => {
  const input = createInput({ bandCount: 1, sectionCount: 0 })
  input.eventDays.push({ id: 'day-2', eventId: input.event.id, date: '2027-11-07', order: 1 })
  input.stages.push({ id: 'stage-day-2', eventDayId: 'day-2', name: 'Day 2',
    order: 0, plannedStartTime: '10:00' })
  input.eventBands.push({ id: 'band-day-2', eventId: input.event.id,
    eventDayId: 'day-2', name: 'Day 2 Band', memberIds: [], durationMinutes: 10 })
  input.scheduleItems.push({ id: 'day-2-item', kind: 'performance',
    eventBandId: 'band-day-2', stageId: 'stage-day-2', order: 0 })
  input.scheduleItems.push({ id: 'day-2-break', kind: 'break', title: '休憩',
    durationMinutes: 5, stageId: 'stage-day-2', order: 1 })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.plan.placements.map(item => item.eventBandId), ['band-00'])
  assert.deepEqual(result.plan.breaks, [])
  assert.ok(result.plan.paShifts.every(shift => shift.eventDayId === input.eventDay.id))
})

test('preferredTimeRangeをHard化せず、条件が同等なら希望を満たすSectionを選ぶ', () => {
  const input = createInput({ bandCount: 2, sectionCount: 2 })
  input.sections[1].plannedStartTime = '11:00'
  input.eventBands[0].preferredTimeRange = { from: '11:00', until: '12:00' }
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.placements.find(item => item.eventBandId === 'band-00').sectionId,
    'section-1')
  assert.equal(result.plan.score.schedulingSoftPenalty, 0)
})

test('PA availabilityと未定statusを考慮して参加確定者を優先する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .participationStatus = 'undecided'
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.paShifts.find(shift => shift.role === 'main').memberId, 'main-1')
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-0')
    .availabilityWindows = [{ until: '10:05' }]
  const unavailable = generateTimetablePlan(input)
  assert.equal(unavailable.ok, true, JSON.stringify(unavailable))
  assert.equal(unavailable.plan.paShifts.find(shift => shift.role === 'main').memberId, 'main-1')
})

test('未定PAは専用件数のみへ計上しScheduling Soft penaltyとdiagnosticsはConstraint評価に一致する', () => {
  for (const hasPreferenceViolation of [false, true]) {
    let confirmedScore
    for (const undecidedCount of [0, 1, 2]) {
      const input = createInput({ bandCount: 1, sectionCount: 1, paCount: 1 })
      input.scheduleItems.push({ id: 'existing', kind: 'performance',
        eventBandId: 'band-00', stageId: 'stage-1', sectionId: 'section-0', order: 0 })
      if (hasPreferenceViolation) {
        input.eventBands[0].preferredTimeRange = { until: '09:00' }
      }
      for (const memberId of ['main-0', 'sub-0'].slice(0, undecidedCount)) {
        input.eventMemberDays.find(day => day.eventMemberId === `event-member-${memberId}`)
          .participationStatus = 'undecided'
      }
      const original = structuredClone(input)
      const result = generateTimetablePlan(input)
      assert.equal(result.ok, true, JSON.stringify(result))
      const constraints = evaluateScheduleConstraints({
        ...input, scheduleItems: materializeSchedule(input, result.plan),
      })
      assert.equal(constraints.feasible, true)
      assert.equal(result.plan.score.schedulingSoftPenalty, constraints.totalPenalty)
      assert.deepEqual(result.plan.diagnostics.schedulingSoftViolations, constraints.softViolations)
      assert.equal(constraints.totalPenalty > 0, hasPreferenceViolation)
      assert.equal(result.plan.score.undecidedPaShiftCount, undecidedCount)
      assert.equal(result.plan.paShifts.filter(shift =>
        input.eventMemberDays.find(day => day.eventMemberId === `event-member-${shift.memberId}`)
          .participationStatus === 'undecided').length, undecidedCount)
      if (undecidedCount === 0) confirmedScore = result.plan.score
      assert.deepEqual(result.plan.score, { ...confirmedScore, undecidedPaShiftCount: undecidedCount })
      assert.deepEqual(input, original)
    }
  }
})

const zeroGenerationScore = {
  lastResortActivityCount: 0,
  schedulingSoftPenalty: 0,
  activitySpacingPenalty: 0,
  sectionDurationImbalance: 0,
  paMainWorkloadImbalance: 0,
  paSubWorkloadImbalance: 0,
  sectionBandCountImbalance: 0,
  undecidedPaShiftCount: 0,
}

test('他のscoreが同じなら未定PA shift数が少ない候補を優先する', () => {
  const undecided = { ...zeroGenerationScore, undecidedPaShiftCount: 1 }
  assert.ok(compareTimetableGenerationScores(zeroGenerationScore, undecided) < 0)
  assert.ok(compareTimetableGenerationScores(undecided, zeroGenerationScore) > 0)
  assert.equal(compareTimetableGenerationScores(undecided, { ...undecided }), 0)
})

test('未定PA shift数は既存の全earlier priorityを追い越さない', () => {
  for (const key of Object.keys(zeroGenerationScore).filter(key => key !== 'undecidedPaShiftCount')) {
    const confirmedButWorse = { ...zeroGenerationScore, [key]: 1 }
    const undecidedButBetter = { ...zeroGenerationScore, undecidedPaShiftCount: 1 }
    assert.ok(compareTimetableGenerationScores(confirmedButWorse, undecidedButBetter) > 0, key)
    assert.ok(compareTimetableGenerationScores(undecidedButBetter, confirmedButWorse) < 0, key)
  }
})

const createPaBeamInput = () => {
  const input = createInput({ bandCount: 0, sectionCount: 0, paCount: 2 })
  input.eventMembers.find(member => member.memberId === 'sub-1').paCapabilities.sub = false
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-1')
    .participationStatus = 'undecided'
  return {
    ...input, eventDayId: input.eventDay.id,
    calculatedItems: [], baseActivities: [], scopes: [], beamWidth: 1, maxExpandedStates: 100,
  }
}

const paScope = (index, fromMinute) => ({
  key: `scope-${index}`, eventDayId: 'day-1', stageId: 'stage-1',
  fromMinute, untilMinute: fromMinute + 10,
  fromBoundary: { kind: 'existing-item', scheduleItemId: `row-${index}`, edge: 'start' },
  untilBoundary: { kind: 'existing-item', scheduleItemId: `row-${index}`, edge: 'end' },
})

test('最終PA taskでcap到達前に見つけたcomplete planを通常rankingで保持する', () => {
  const input = createPaBeamInput()
  input.scopes = [paScope(0, 600)]
  input.maxExpandedStates = 2
  const original = structuredClone(input)
  const result = planPaShifts(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plans.length, 1)
  assert.deepEqual(result.plans[0].shifts.map(shift => shift.role).sort(), ['main', 'sub'])
  assert.deepEqual(result.plans[0].shifts.map(shift => shift.memberId).sort(), ['main-0', 'sub-0'])
  assert.deepEqual(planPaShifts(input), result)
  assert.deepEqual(input, original)
})

test('最終PA taskでもcomplete stateを作る前にcapへ達したらSEARCH_LIMIT_REACHEDとなる', () => {
  const input = createPaBeamInput()
  input.scopes = [paScope(0, 600)]
  input.baseActivities = [{ id: 'overlapping-duty', memberId: 'main-0', eventDayId: 'day-1',
    stageId: 'stage-1', kind: 'duty', fromMinute: 600, untilMinute: 610 }]
  input.maxExpandedStates = 2
  const result = planPaShifts(input)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SEARCH_LIMIT_REACHED')
  assert.equal(result.scope.key, 'scope-0')
  assert.equal(planPaShifts({ ...input, maxExpandedStates: 3 }).ok, true)
})

test('非最終PA taskでcapに達した場合はpartial stateを成功planとして返さない', () => {
  const input = createPaBeamInput()
  input.eventMembers.find(member => member.memberId === 'sub-1').paCapabilities.sub = true
  input.scopes = [paScope(0, 600), paScope(1, 660)]
  input.maxExpandedStates = 1
  const result = planPaShifts(input)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SEARCH_LIMIT_REACHED')
  assert.equal(result.scope.key, 'scope-0')
  assert.equal(planPaShifts({ ...input, maxExpandedStates: 100 }).ok, true)
})

test('beamWidth 1でも未定数よりspacing penaltyの小さいPA候補を残す', () => {
  const input = createPaBeamInput()
  input.scopes = [paScope(0, 600)]
  input.baseActivities = [{ id: 'prior-duty', memberId: 'main-0', eventDayId: 'day-1',
    stageId: 'stage-1', kind: 'duty', fromMinute: 570, untilMinute: 590 }]
  const confirmedActivity = { id: 'hypothetical-pa', memberId: 'main-0', eventDayId: 'day-1',
    stageId: 'stage-1', kind: 'pa', fromMinute: 600, untilMinute: 610 }
  const confirmedSpacing = evaluateMemberActivitySpacing({
    activities: [...input.baseActivities, confirmedActivity], stageItems: [],
  })
  assert.equal(confirmedSpacing.feasible, true)
  assert.equal(confirmedSpacing.pairs[0].level, 'preferred')
  assert.ok(confirmedSpacing.totalPenalty > 0)
  const original = structuredClone(input)
  const result = planPaShifts(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plans.length, 1)
  assert.equal(result.plans[0].shifts.find(shift => shift.role === 'main').memberId, 'main-1')
  assert.equal(result.plans[0].undecidedCount, 1)
  assert.deepEqual(planPaShifts(input), result)
  assert.deepEqual(input, original)
})

test('beamWidth 1でもspacing同値なら未定数よりMain PAの負担バランスを優先する', () => {
  const input = createPaBeamInput()
  input.scopes = [paScope(0, 600), paScope(1, 660)]
  input.eventMemberDays.find(day => day.eventMemberId === 'event-member-main-1')
    .availabilityWindows = [{ from: '11:00' }]
  const result = planPaShifts(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  const plan = result.plans[0]
  assert.deepEqual(plan.shifts.filter(shift => shift.role === 'main')
    .map(shift => shift.memberId), ['main-0', 'main-1'])
  assert.equal(plan.undecidedCount, 1)
  assert.equal(getPaWorkloadImbalance('main', plan.shifts, plan.eligibleMemberIds.main), 0)
  const allConfirmed = plan.shifts.map(shift => shift.role === 'main'
    ? { ...shift, memberId: 'main-0' } : shift)
  assert.equal(getPaWorkloadImbalance('main', allConfirmed, plan.eligibleMemberIds.main), 20)
})

test('PA workloadはSection件数ではなく担当分数をMain/Sub別に均等化する', () => {
  const input = createInput({ bandCount: 4, sectionCount: 4, paCount: 4 })
  const durations = [78, 80, 82, 79]
  input.eventBands.forEach((band, index) => {
    band.durationMinutes = durations[index]
    band.fixedPlacement = { stageId: 'stage-1', sectionId: `section-${index}` }
  })
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(new Set(result.plan.paShifts.filter(shift => shift.role === 'main')
    .map(shift => shift.memberId)).size, 4)
  assert.equal(new Set(result.plan.paShifts.filter(shift => shift.role === 'sub')
    .map(shift => shift.memberId)).size, 4)
  assert.equal(result.plan.score.paMainWorkloadImbalance, 4)
  assert.equal(result.plan.score.paSubWorkloadImbalance, 4)
})

test('別Stageの同一Member出演は5分なら最終手段、4分ならHard NG', () => {
  const input = createInput({ bandCount: 2, sectionCount: 0 })
  input.stages.push({ id: 'stage-2', eventDayId: input.eventDay.id,
    name: 'Other', order: 1, plannedStartTime: '10:15' })
  input.eventBands[1].memberIds = input.eventBands[0].memberIds
  input.eventBands[0].fixedPlacement = { stageId: 'stage-1' }
  input.eventBands[1].fixedPlacement = { stageId: 'stage-2' }
  const lastResort = generateTimetablePlan(input)
  assert.equal(lastResort.ok, true, JSON.stringify(lastResort))
  assert.ok(lastResort.plan.score.lastResortActivityCount >= 1)
  input.stages[1].plannedStartTime = '10:14'
  const hard = generateTimetablePlan(input)
  assert.equal(hard.ok, false)
  assert.equal(hard.failure.code, 'NO_FEASIBLE_SCHEDULE')
})

test('重複Lockや不正Activity policyは部分適用せず事前失敗する', () => {
  const input = createInput({ bandCount: 1, sectionCount: 1 })
  input.scheduleItems.push({ id: 'existing', kind: 'performance',
    eventBandId: 'band-00', stageId: 'stage-1', sectionId: 'section-0', order: 0 })
  input.timetableLocks = ['a', 'b'].map(id => ({
    id, eventId: input.event.id, scheduleItemId: 'existing',
    stageId: 'stage-1', sectionId: 'section-0', position: { kind: 'first' },
  }))
  assert.equal(generateTimetablePlan(input).failure.code, 'INVALID_LOCK_CONSTRAINTS')
  input.timetableLocks = []
  const invalidPolicy = {
    'performance-to-performance': { minimumMinutes: 10, preferredMinutes: 5,
      sufficientMinutes: 30 },
  }
  assert.equal(generateTimetablePlan({ ...input, activitySpacingPolicy: invalidPolicy })
    .failure.code, 'INVALID_INPUT')
})
