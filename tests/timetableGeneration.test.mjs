import assert from 'node:assert/strict'
import test from 'node:test'

import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { buildPaActivities, buildPerformanceActivities,
  evaluateMemberActivitySpacing } from '../src/domain/activitySpacing.ts'
import { detectScheduleIssues } from '../src/domain/issues.ts'
import { evaluateScheduleConstraints } from '../src/domain/schedulingConstraints.ts'
import { calculateEventDayTimelines } from '../src/domain/timetable.ts'
import { evaluateTimetableLocks } from '../src/domain/timetableLocks.ts'

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
