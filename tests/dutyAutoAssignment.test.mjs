import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDutyAutoAssignments,
  planDutyAutoAssignments,
} from '../src/domain/dutyAutoAssignment.ts'

const event = {
  id: 'event-1', name: '自動担当テスト', timeZone: 'Asia/Tokyo',
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
  performanceSlotMinutes: [10],
}
const eventDay = { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 }
const stage = {
  id: 'stage-1', eventDayId: eventDay.id, name: 'Main', order: 0,
  plannedStartTime: '09:00', plannedEndTime: '18:00',
}
const member = (id, realName = id) => ({ id, realName, active: true })
const members = [
  member('member-a', 'Aさん'),
  member('member-b', 'Bさん'),
  member('member-c', 'Cさん'),
  member('member-d', 'Dさん'),
  member('member-e', 'Eさん'),
]
const eventMembers = members.map((item) => ({
  id: `event-member-${item.id}`,
  eventId: event.id,
  memberId: item.id,
  paCapabilities: { main: true, sub: true },
}))
const memberDay = (memberId, overrides = {}) => ({
  id: `member-day-${memberId}`,
  eventMemberId: `event-member-${memberId}`,
  eventDayId: eventDay.id,
  participationStatus: 'participating',
  ...overrides,
})
const eventMemberDays = members.map((item) => memberDay(item.id))
const dutyTypes = [{ id: 'duty-photo', eventId: event.id, name: '撮影', order: 0 }]
const timeBoundary = (time) => ({ kind: 'time', time })
const request = (overrides = {}) => ({
  dutyTypeId: 'duty-photo',
  fromBoundary: timeBoundary('13:00'),
  untilBoundary: timeBoundary('14:00'),
  fromMinute: 780,
  untilMinute: 840,
  additionalCount: 1,
  ...overrides,
})
const context = (overrides = {}) => ({
  event,
  eventDay,
  eventDays: [eventDay],
  stage,
  stages: [stage],
  sections: [],
  members,
  eventMembers,
  eventMemberDays,
  eventBands: [],
  calculatedItems: [],
  paAssignments: [],
  dutyTypes,
  dutyAssignments: [],
  ...overrides,
})
const duty = (id, memberId, from = '09:00', until = '09:30', overrides = {}) => ({
  id,
  dutyTypeId: 'duty-photo',
  eventDayId: eventDay.id,
  stageId: stage.id,
  memberId,
  from: timeBoundary(from),
  until: timeBoundary(until),
  ...overrides,
})
const pa = (id, memberId, from = '09:00', until = '09:30', overrides = {}) => ({
  id,
  eventId: event.id,
  eventDayId: eventDay.id,
  stageId: stage.id,
  memberId,
  role: 'main',
  from: timeBoundary(from),
  until: timeBoundary(until),
  ...overrides,
})

test('Duty範囲へ1名または指定した3名をuniqueかつdeterministicに選出する', () => {
  const one = planDutyAutoAssignments(context(), request())
  const three = planDutyAutoAssignments(context(), request({ additionalCount: 3 }))

  assert.equal(one.ok, true)
  assert.deepEqual(one.plan.selectedMemberIds, ['member-a'])
  assert.equal(three.ok, true)
  assert.deepEqual(three.plan.selectedMemberIds, ['member-a', 'member-b', 'member-c'])
  assert.equal(new Set(three.plan.selectedMemberIds).size, 3)
  assert.deepEqual(planDutyAutoAssignments(context(), request({ additionalCount: 3 })), three)
})

test('重複EventMemberがあっても同じMemberを複数回選出しない', () => {
  const duplicateEventMember = {
    ...eventMembers[0],
    id: 'event-member-member-a-duplicate',
  }
  const result = planDutyAutoAssignments(context({
    eventMembers: [...eventMembers, duplicateEventMember],
    eventMemberDays: [
      ...eventMemberDays,
      { ...memberDay('member-a'), id: 'member-day-a-duplicate',
        eventMemberId: duplicateEventMember.id },
    ],
  }), request({ additionalCount: 5 }))

  assert.equal(result.ok, true)
  assert.equal(new Set(result.plan.selectedMemberIds).size, 5)
})

test('absent・日別設定なし・範囲全体がavailability外のMemberを除外する', () => {
  const days = [
    memberDay('member-a', { participationStatus: 'absent' }),
    memberDay('member-c', { availabilityWindows: [{ from: '13:30', until: '15:00' }] }),
    memberDay('member-d'),
    memberDay('member-e'),
  ]
  const result = planDutyAutoAssignments(context({ eventMemberDays: days }), request())

  assert.equal(result.ok, true)
  assert.equal(result.plan.selectedMemberIds.includes('member-a'), false)
  assert.equal(result.plan.selectedMemberIds.includes('member-b'), false)
  assert.equal(result.plan.selectedMemberIds.includes('member-c'), false)
  assert.equal(result.plan.selectedMemberIds[0], 'member-d')
})

test('本人出演・既存PA・既存Duty overlapをcandidateごとに除外する', () => {
  const eventBands = [{
    id: 'band-a', eventId: event.id, eventDayId: eventDay.id, name: 'A出演',
    memberIds: ['member-a'], durationMinutes: 60,
  }]
  const calculatedItems = [{
    scheduleItemId: 'performance-a', eventDayId: eventDay.id, stageId: stage.id,
    kind: 'performance', eventBandId: 'band-a',
    plannedStartMinute: 780, plannedEndMinute: 840,
  }]
  const result = planDutyAutoAssignments(context({
    eventBands,
    calculatedItems,
    paAssignments: [pa('pa-b', 'member-b', '13:00', '14:00')],
    dutyAssignments: [duty('duty-c', 'member-c', '13:00', '14:00')],
  }), request())

  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.selectedMemberIds, ['member-d'])
})

test('activity spacing hard violationを除外しlast-resortとpenaltyをrankingへ反映する', () => {
  const result = planDutyAutoAssignments(context({
    dutyAssignments: [
      duty('duty-a', 'member-a', '12:55', '13:00'),
      duty('duty-b', 'member-b', '12:45', '12:50'),
    ],
  }), request())

  assert.equal(result.ok, true)
  assert.equal(result.plan.selectedMemberIds.includes('member-a'), false)
  assert.equal(result.plan.selectedMemberIds[0], 'member-c')
})

test('participatingをundecidedより優先し、undecidedだけならwarning付きで選出する', () => {
  const mixedDays = eventMemberDays.map((day) =>
    day.eventMemberId === 'event-member-member-a'
      ? { ...day, participationStatus: 'undecided' }
      : day)
  const mixed = planDutyAutoAssignments(context({ eventMemberDays: mixedDays }), request())
  assert.equal(mixed.ok, true)
  assert.equal(mixed.plan.selectedMemberIds[0], 'member-b')

  const undecidedOnlyContext = context({
    eventMembers: [eventMembers[0]],
    eventMemberDays: [memberDay('member-a', { participationStatus: 'undecided' })],
  })
  const undecided = planDutyAutoAssignments(undecidedOnlyContext, request())
  assert.equal(undecided.ok, true)
  assert.deepEqual(undecided.plan.selectedMemberIds, ['member-a'])
  assert.deepEqual(undecided.plan.warnings, [
    'Aさんはこの開催日の参加状況が未定です。',
  ])
  assert.equal(undecided.plan.warnings.join(' ').includes('さんさん'), false)
})

test('別Event由来でcurrent day IDを持つDutyを評価対象へ混入させない', () => {
  const foreignEvent = {
    ...event,
    id: 'event-foreign',
    name: '別イベント',
  }
  const foreignDay = {
    id: 'day-foreign', eventId: foreignEvent.id, date: '2027-11-07', order: 0,
  }
  const foreignStage = {
    ...stage,
    id: 'stage-foreign',
    eventDayId: foreignDay.id,
  }
  const foreignDutyType = {
    id: 'duty-foreign', eventId: foreignEvent.id, name: '別イベント業務', order: 0,
  }
  const foreignAssignment = duty(
    'foreign-stale-duty',
    'member-a',
    '13:00',
    '14:00',
    {
      dutyTypeId: foreignDutyType.id,
      eventDayId: eventDay.id,
      stageId: foreignStage.id,
    },
  )
  const foreignPa = pa('foreign-stale-pa', 'member-a', '13:00', '14:00', {
    eventId: foreignEvent.id,
    eventDayId: eventDay.id,
    stageId: foreignStage.id,
  })
  const input = context({
    eventDays: [eventDay, foreignDay],
    stages: [stage, foreignStage],
    dutyTypes: [...dutyTypes, foreignDutyType],
    dutyAssignments: [foreignAssignment],
    paAssignments: [foreignPa],
  })
  const before = structuredClone(input)
  const planned = planDutyAutoAssignments(input, request())

  assert.equal(planned.ok, true)
  assert.deepEqual(planned.plan.selectedMemberIds, ['member-a'])
  assert.equal(planned.plan.candidateMetrics[0].existingDutyMinutes, 0)
  assert.equal(planned.plan.candidateMetrics[0].existingDutyAssignmentCount, 0)

  const applied = createDutyAutoAssignments({
    context: input,
    plan: planned.plan,
    newDutyAssignmentIds: ['auto-current-event'],
  })
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.dutyAssignments[0], foreignAssignment)
  assert.equal(applied.dutyAssignments.at(-1)?.id, 'auto-current-event')
  assert.deepEqual(input, before)
})

test('当日Duty時間、件数、氏名、IDの順で公平かつ安定してrankingする', () => {
  const workload = planDutyAutoAssignments(context({
    dutyAssignments: [
      duty('duty-a', 'member-a', '09:00', '10:00'),
      duty('duty-b', 'member-b', '09:00', '09:30'),
    ],
  }), request())
  assert.equal(workload.ok, true)
  assert.equal(workload.plan.selectedMemberIds[0], 'member-c')

  const countTie = planDutyAutoAssignments(context({
    eventMembers: eventMembers.slice(0, 2),
    eventMemberDays: eventMemberDays.slice(0, 2),
    dutyAssignments: [
      duty('duty-a', 'member-a', '09:00', '09:30'),
      duty('duty-b1', 'member-b', '09:00', '09:15'),
      duty('duty-b2', 'member-b', '10:00', '10:15'),
    ],
  }), request())
  assert.equal(countTie.ok, true)
  assert.equal(countTie.plan.selectedMemberIds[0], 'member-a')
})

test('不足候補と不正additionalCountを部分成功にせずstructured failureにする', () => {
  const limited = context({
    eventMembers: eventMembers.slice(0, 2),
    eventMemberDays: eventMemberDays.slice(0, 2),
  })
  const shortage = planDutyAutoAssignments(limited, request({ additionalCount: 3 }))
  assert.equal(shortage.ok, false)
  assert.equal(shortage.code, 'INSUFFICIENT_ELIGIBLE_CANDIDATES')
  assert.equal(shortage.eligibleCount, 2)
  assert.equal(shortage.requestedCount, 3)

  for (const additionalCount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = planDutyAutoAssignments(context(), request({ additionalCount }))
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'INVALID_COUNT')
  }
})

test('selected DutyType missing・foreign・自身の重複を拒否し無関係な重複は無視する', () => {
  const missing = planDutyAutoAssignments(context(), request({ dutyTypeId: 'missing' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'INVALID_DUTY_TYPE')

  const foreign = planDutyAutoAssignments(context({
    dutyTypes: [{ id: 'foreign', eventId: 'event-2', name: '別', order: 0 }],
  }), request({ dutyTypeId: 'foreign' }))
  assert.equal(foreign.ok, false)
  assert.equal(foreign.code, 'INVALID_DUTY_TYPE')

  const selectedDuplicate = planDutyAutoAssignments(context({
    dutyTypes: [...dutyTypes, {
      id: 'duty-photo-2', eventId: event.id, name: ' 撮影 ', order: 1,
    }],
  }), request())
  assert.equal(selectedDuplicate.ok, false)
  assert.equal(selectedDuplicate.code, 'INVALID_DUTY_TYPE')
  assert.match(selectedDuplicate.message, /同名/)

  const unrelatedDuplicate = planDutyAutoAssignments(context({
    dutyTypes: [...dutyTypes,
      { id: 'reception-a', eventId: event.id, name: '受付', order: 1 },
      { id: 'reception-b', eventId: event.id, name: ' 受付 ', order: 2 },
    ],
  }), request())
  assert.equal(unrelatedDuplicate.ok, true)
})

test('stale PA/Dutyは該当Memberだけ除外し、壊れた出演参照は全体をfail closedにする', () => {
  const stale = context({
    paAssignments: [pa('pa-stale-a', 'member-a', '09:00', '09:30', {
      from: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'start' },
    })],
    dutyAssignments: [duty('duty-stale-b', 'member-b', '09:00', '09:30', {
      until: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'end' },
    })],
  })
  const planned = planDutyAutoAssignments(stale, request())
  assert.equal(planned.ok, true)
  assert.equal(planned.plan.selectedMemberIds.includes('member-a'), false)
  assert.equal(planned.plan.selectedMemberIds.includes('member-b'), false)
  assert.equal(planned.plan.selectedMemberIds[0], 'member-c')

  const broken = planDutyAutoAssignments(context({
    calculatedItems: [{
      scheduleItemId: 'broken-performance', eventDayId: eventDay.id,
      stageId: stage.id, kind: 'performance', eventBandId: 'missing-band',
      plannedStartMinute: 600, plannedEndMinute: 610,
    }],
  }), request())
  assert.equal(broken.ok, false)
  assert.equal(broken.code, 'BROKEN_PERFORMANCE')
})

test('Section境界・部間Breakを含むScheduleItem境界を保持しinputを変更しない', () => {
  const section = {
    id: 'section-1', stageId: stage.id, name: '第1部', order: 0,
    plannedStartTime: '13:00', plannedEndTime: '14:00',
  }
  const sectionContext = context({ sections: [section] })
  const sectionRequest = request({
    fromBoundary: { kind: 'section', sectionId: section.id, edge: 'start' },
    untilBoundary: { kind: 'section', sectionId: section.id, edge: 'end' },
  })
  const before = structuredClone({ sectionContext, sectionRequest })
  const result = planDutyAutoAssignments(sectionContext, sectionRequest)
  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.fromBoundary, sectionRequest.fromBoundary)
  assert.deepEqual(result.plan.untilBoundary, sectionRequest.untilBoundary)
  assert.deepEqual({ sectionContext, sectionRequest }, before)

  const breakItem = {
    scheduleItemId: 'inter-break', eventDayId: eventDay.id, stageId: stage.id,
    kind: 'break', afterSectionId: section.id,
    plannedStartMinute: 780, plannedEndMinute: 840,
  }
  const breakResult = planDutyAutoAssignments(context({
    sections: [section], calculatedItems: [breakItem],
  }), request({
    fromBoundary: { kind: 'schedule-item', scheduleItemId: 'inter-break', edge: 'start' },
    untilBoundary: { kind: 'schedule-item', scheduleItemId: 'inter-break', edge: 'end' },
  }))
  assert.equal(breakResult.ok, true)
})

test('stable planKeyは同じinputで一致しcount・Boundary・selected Memberで変わる', () => {
  const base = planDutyAutoAssignments(context(), request())
  const same = planDutyAutoAssignments(context(), request())
  const count = planDutyAutoAssignments(context(), request({ additionalCount: 2 }))
  const range = planDutyAutoAssignments(context(), request({
    fromBoundary: timeBoundary('14:00'), untilBoundary: timeBoundary('15:00'),
    fromMinute: 840, untilMinute: 900,
  }))
  assert.equal(base.ok && same.ok && count.ok && range.ok, true)
  assert.equal(base.plan.planKey, same.plan.planKey)
  assert.notEqual(base.plan.planKey, count.plan.planKey)
  assert.notEqual(base.plan.planKey, range.plan.planKey)
})

test('applyは1名・複数名を追加し既存のEvent・Day・Stage・DutyType担当を保持する', () => {
  const otherEvent = { ...event, id: 'event-2', name: '別イベント' }
  const otherDay = { id: 'day-2', eventId: event.id, date: '2027-11-07', order: 1 }
  const otherEventDay = {
    id: 'day-event-2', eventId: otherEvent.id, date: '2027-12-01', order: 0,
  }
  const otherStage = { ...stage, id: 'stage-2' }
  const otherDayStage = { ...stage, id: 'stage-day-2', eventDayId: otherDay.id }
  const otherEventStage = {
    ...stage, id: 'stage-event-2', eventDayId: otherEventDay.id,
  }
  const otherDutyType = {
    id: 'duty-reception', eventId: event.id, name: '受付', order: 1,
  }
  const otherEventDutyType = {
    id: 'duty-event-2', eventId: otherEvent.id, name: '別イベント業務', order: 0,
  }
  const existingAssignments = [
    duty('existing-same', 'member-e', '09:00', '09:30'),
    duty('existing-other-event', 'member-e', '09:00', '09:30', {
      dutyTypeId: otherEventDutyType.id,
      eventDayId: otherEventDay.id,
      stageId: otherEventStage.id,
    }),
    duty('existing-other-day', 'member-e', '09:30', '10:00', {
      eventDayId: otherDay.id,
      stageId: otherDayStage.id,
    }),
    duty('existing-other-stage', 'member-e', '10:00', '10:30', {
      stageId: otherStage.id,
    }),
    duty('existing-other-type', 'member-e', '10:30', '11:00', {
      dutyTypeId: otherDutyType.id,
    }),
  ]
  const input = context({
    eventDays: [eventDay, otherDay, otherEventDay],
    stages: [stage, otherStage, otherDayStage, otherEventStage],
    dutyTypes: [...dutyTypes, otherDutyType, otherEventDutyType],
    dutyAssignments: existingAssignments,
  })
  const before = structuredClone(input)
  const planned = planDutyAutoAssignments(input, request({ additionalCount: 2 }))
  assert.equal(planned.ok, true)

  const applied = createDutyAutoAssignments({
    context: input,
    plan: planned.plan,
    newDutyAssignmentIds: ['auto-a', 'auto-b'],
  })
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.dutyAssignments.slice(0, existingAssignments.length),
    existingAssignments)
  assert.deepEqual(applied.dutyAssignments.slice(-2).map((item) => item.id), [
    'auto-a', 'auto-b',
  ])
  assert.deepEqual(applied.dutyAssignments.slice(-2).map((item) => item.memberId),
    planned.plan.selectedMemberIds)
  assert.deepEqual(input, before)
})

test('applyはID不足・空・重複・既存collisionを全件atomicに拒否する', () => {
  const existing = duty('existing', 'member-e')
  const input = context({ dutyAssignments: [existing] })
  const planned = planDutyAutoAssignments(input, request({ additionalCount: 2 }))
  assert.equal(planned.ok, true)

  for (const ids of [
    ['only-one'],
    ['valid', ''],
    ['same', 'same'],
    ['existing', 'new'],
  ]) {
    const result = createDutyAutoAssignments({
      context: input, plan: planned.plan, newDutyAssignmentIds: ids,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVALID_IDS')
  }
  assert.deepEqual(input.dutyAssignments, [existing])
})

test('apply途中の2人目validation失敗でも部分適用せず、unrelated ERRORはblockしない', () => {
  const plannedContext = context({
    eventMembers: eventMembers.slice(0, 2),
    eventMemberDays: eventMemberDays.slice(0, 2),
  })
  const planned = planDutyAutoAssignments(plannedContext, request({ additionalCount: 2 }))
  assert.equal(planned.ok, true)
  const changedDays = plannedContext.eventMemberDays.map((day) =>
    day.eventMemberId === 'event-member-member-b'
      ? { ...day, participationStatus: 'absent' }
      : day)
  const applyContext = { ...plannedContext, eventMemberDays: changedDays }
  const before = structuredClone(applyContext)
  const rejected = createDutyAutoAssignments({
    context: applyContext,
    plan: planned.plan,
    newDutyAssignmentIds: ['auto-first', 'auto-second'],
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'ASSIGNMENT_INVALID')
  assert.deepEqual(applyContext, before)

  const unrelatedStale = duty('stale-other', 'member-e', '09:00', '09:30', {
    from: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'start' },
  })
  const cleanPlanContext = context({ dutyAssignments: [unrelatedStale] })
  const cleanPlan = planDutyAutoAssignments(cleanPlanContext, request())
  assert.equal(cleanPlan.ok, true)
  const applied = createDutyAutoAssignments({
    context: cleanPlanContext,
    plan: cleanPlan.plan,
    newDutyAssignmentIds: ['auto-with-unrelated-error'],
  })
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.dutyAssignments[0], unrelatedStale)
})

test('applyはdeterministicかつplan/contextをmutationしない', () => {
  const input = context()
  const planned = planDutyAutoAssignments(input, request({ additionalCount: 2 }))
  assert.equal(planned.ok, true)
  const before = structuredClone({ input, plan: planned.plan })
  const applyInput = {
    context: input,
    plan: planned.plan,
    newDutyAssignmentIds: ['auto-a', 'auto-b'],
  }
  assert.deepEqual(
    createDutyAutoAssignments(applyInput),
    createDutyAutoAssignments(applyInput),
  )
  assert.deepEqual({ input, plan: planned.plan }, before)
})
