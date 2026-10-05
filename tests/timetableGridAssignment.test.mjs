import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTimetableGridAssignment,
  deleteTimetableGridAssignment,
  deleteTimetableGridAssignments,
  getTimetableGridAssignmentCandidates,
  getTimetableGridSelectionAssignmentTargets,
} from '../src/ui/timetableGridAssignment.ts'

const event = {
  id: 'event-1',
  name: 'Grid担当テスト',
  timeZone: 'Asia/Tokyo',
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
  performanceSlotMinutes: [10],
}
const eventDays = [
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
  { id: 'day-2', eventId: event.id, date: '2027-11-07', order: 1 },
]
const stages = [
  { id: 'stage-1', eventDayId: 'day-1', name: 'Main', order: 0, plannedStartTime: '10:00' },
  { id: 'stage-2', eventDayId: 'day-2', name: '翌日', order: 0, plannedStartTime: '10:00' },
]
const members = [
  { id: 'member-main', realName: 'Main担当', active: true },
  { id: 'member-sub', realName: 'Sub担当', active: true },
  { id: 'member-undecided', realName: '参加未定', active: true },
  { id: 'member-absent', realName: '欠席者', active: true },
  { id: 'member-performer', realName: '出演者', active: true },
]
const eventMembers = members.map((member) => ({
  id: `event-member-${member.id}`,
  eventId: event.id,
  memberId: member.id,
  paCapabilities: {
    main: ['member-main', 'member-undecided', 'member-performer'].includes(member.id),
    sub: ['member-sub', 'member-undecided'].includes(member.id),
  },
}))
const eventMemberDays = eventMembers.map((eventMember) => ({
  id: `member-day-${eventMember.memberId}`,
  eventMemberId: eventMember.id,
  eventDayId: 'day-1',
  participationStatus: eventMember.memberId === 'member-absent'
    ? 'absent'
    : eventMember.memberId === 'member-undecided'
      ? 'undecided'
      : 'participating',
}))
const eventBands = [{
  id: 'event-band-1',
  eventId: event.id,
  eventDayId: 'day-1',
  name: '出演バンド',
  memberIds: ['member-performer'],
  durationMinutes: 10,
}]
const calculatedItems = [
  {
    scheduleItemId: 'item-1', eventDayId: 'day-1', stageId: 'stage-1',
    kind: 'performance', eventBandId: 'event-band-1',
    plannedStartMinute: 600, plannedEndMinute: 610,
  },
  {
    scheduleItemId: 'item-2', eventDayId: 'day-1', stageId: 'stage-1',
    kind: 'break', plannedStartMinute: 610, plannedEndMinute: 620,
  },
  {
    scheduleItemId: 'item-3', eventDayId: 'day-1', stageId: 'stage-1',
    kind: 'break', plannedStartMinute: 620, plannedEndMinute: 630,
  },
]
const dutyTypes = [{
  id: 'duty-photo', eventId: event.id, name: '撮影', order: 0,
}]

const selection = (target = { kind: 'pa', role: 'main' }, overrides = {}) => ({
  eventDayId: 'day-1',
  stageId: 'stage-1',
  target,
  firstRow: {},
  lastRow: {},
  scheduleItemIds: ['item-1', 'item-2'],
  rowCount: 2,
  fromMinute: 600,
  untilMinute: 620,
  fromBoundary: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
  untilBoundary: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'end' },
  ...overrides,
})

const context = (overrides = {}) => ({
  event,
  eventDays,
  stages,
  sections: [],
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  calculatedItems,
  paAssignments: [],
  dutyTypes,
  dutyAssignments: [],
  ...overrides,
})

test('PA候補はrole・参加状況で絞り込み、参加未定warningを保持する', () => {
  const main = getTimetableGridAssignmentCandidates(context(), selection())
  assert.equal(main.ok, true)
  assert.deepEqual(main.candidates.map((candidate) => candidate.memberId), [
    'member-main', 'member-undecided', 'member-performer',
  ])
  assert.match(main.candidates.find((candidate) =>
    candidate.memberId === 'member-undecided').warning, /未定/)

  const sub = getTimetableGridAssignmentCandidates(
    context(),
    selection({ kind: 'pa', role: 'sub' }),
  )
  assert.equal(sub.ok, true)
  assert.deepEqual(sub.candidates.map((candidate) => candidate.memberId), [
    'member-sub', 'member-undecided',
  ])
  assert.equal(sub.candidates.some((candidate) =>
    candidate.memberId === 'member-absent'), false)
})

test('Duty候補は欠席者を除外し、参加未定を許可する', () => {
  const result = getTimetableGridAssignmentCandidates(
    context(),
    selection({ kind: 'duty', dutyTypeId: 'duty-photo' }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.candidates.some((candidate) =>
    candidate.memberId === 'member-absent'), false)
  assert.match(result.candidates.find((candidate) =>
    candidate.memberId === 'member-undecided').warning, /未定/)
})

test('Main PAを選択したScheduleBoundaryで追加し、既存Assignmentを保持する', () => {
  const existing = {
    id: 'pa-existing', eventId: event.id, eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-sub', role: 'sub',
    from: { kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'end' },
  }
  const foreign = { ...existing, id: 'pa-foreign', eventId: 'event-foreign' }
  const result = createTimetableGridAssignment({
    context: context({ paAssignments: [existing, foreign] }),
    selection: selection(),
    memberId: 'member-main',
    newAssignmentId: 'pa-new',
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'pa')
  const created = result.paAssignments.find((assignment) => assignment.id === 'pa-new')
  assert.deepEqual(created, {
    id: 'pa-new', eventId: event.id, eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-main', role: 'main',
    from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'end' },
  })
  assert.equal(result.paAssignments.some((assignment) => assignment.id === 'pa-existing'), true)
  assert.equal(result.paAssignments.some((assignment) => assignment.id === 'pa-foreign'), true)
})

test('Sub PAではGrid列のroleを維持する', () => {
  const result = createTimetableGridAssignment({
    context: context(),
    selection: selection({ kind: 'pa', role: 'sub' }),
    memberId: 'member-sub',
    newAssignmentId: 'pa-sub-new',
  })
  assert.equal(result.ok, true)
  assert.equal(result.paAssignments.at(-1).role, 'sub')
})

test('Dutyを正確なDutyTypeとScheduleBoundaryで追加しDutyTypeを変更しない', () => {
  const result = createTimetableGridAssignment({
    context: context(),
    selection: selection({ kind: 'duty', dutyTypeId: 'duty-photo' }),
    memberId: 'member-main',
    newAssignmentId: 'duty-new',
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'duty')
  assert.deepEqual(result.dutyAssignments.at(-1), {
    id: 'duty-new', dutyTypeId: 'duty-photo', eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-main',
    from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'end' },
  })
  assert.deepEqual(dutyTypes, [{
    id: 'duty-photo', eventId: event.id, name: '撮影', order: 0,
  }])
})

test('missing・foreign DutyTypeと不正なEventDay/Stage ownershipをfail closedにする', () => {
  for (const [target, inputContext, overrides] of [
    [{ kind: 'duty', dutyTypeId: 'missing' }, context(), {}],
    [{ kind: 'duty', dutyTypeId: 'foreign' }, context({
      dutyTypes: [...dutyTypes, { id: 'foreign', eventId: 'event-2', name: '別', order: 0 }],
    }), {}],
    [{ kind: 'pa', role: 'main' }, context(), { eventDayId: 'missing-day' }],
    [{ kind: 'pa', role: 'main' }, context(), { stageId: 'stage-2' }],
  ]) {
    const result = getTimetableGridAssignmentCandidates(
      inputContext,
      selection(target, overrides),
    )
    assert.equal(result.ok, false)
  }
})

test('候補外member・ID衝突・availability外をrejectする', () => {
  const candidateMissing = createTimetableGridAssignment({
    context: context(), selection: selection(), memberId: 'member-sub',
    newAssignmentId: 'pa-new',
  })
  assert.equal(candidateMissing.ok, false)

  const existing = {
    id: 'pa-new', eventId: event.id, eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-sub', role: 'sub',
    from: { kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'end' },
  }
  const collision = createTimetableGridAssignment({
    context: context({ paAssignments: [existing] }), selection: selection(),
    memberId: 'member-main', newAssignmentId: 'pa-new',
  })
  assert.equal(collision.ok, false)
  assert.match(collision.errors.join(' '), /ID/)

  const restrictedDays = eventMemberDays.map((day) => day.eventMemberId === 'event-member-member-main'
    ? { ...day, availabilityWindows: [{ from: '11:00', until: '12:00' }] }
    : day)
  const unavailable = createTimetableGridAssignment({
    context: context({ eventMemberDays: restrictedDays }), selection: selection(),
    memberId: 'member-main', newAssignmentId: 'pa-unavailable',
  })
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.errors.join(' '), /出演可能時間/)
})

test('本人出演・同種重複・PAとDutyのcross-domain重複をrejectする', () => {
  const performanceOverlap = createTimetableGridAssignment({
    context: context(), selection: selection(), memberId: 'member-performer',
    newAssignmentId: 'pa-performance-overlap',
  })
  assert.equal(performanceOverlap.ok, false)
  assert.match(performanceOverlap.errors.join(' '), /出演/)

  const dutyPerformanceOverlap = createTimetableGridAssignment({
    context: context(),
    selection: selection({ kind: 'duty', dutyTypeId: 'duty-photo' }),
    memberId: 'member-performer',
    newAssignmentId: 'duty-performance-overlap',
  })
  assert.equal(dutyPerformanceOverlap.ok, false)
  assert.match(dutyPerformanceOverlap.errors.join(' '), /出演/)

  const overlappingPa = {
    id: 'pa-existing', eventId: event.id, eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-main', role: 'main',
    from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' },
  }
  const paOverlap = createTimetableGridAssignment({
    context: context({ paAssignments: [overlappingPa] }), selection: selection(),
    memberId: 'member-main', newAssignmentId: 'pa-overlap',
  })
  assert.equal(paOverlap.ok, false)
  assert.match(paOverlap.errors.join(' '), /重複/)

  const overlappingDuty = {
    id: 'duty-existing', dutyTypeId: 'duty-photo', eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-main',
    from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' },
  }
  const crossDomain = createTimetableGridAssignment({
    context: context({ dutyAssignments: [overlappingDuty] }), selection: selection(),
    memberId: 'member-main', newAssignmentId: 'pa-duty-overlap',
  })
  assert.equal(crossDomain.ok, false)
  assert.match(crossDomain.errors.join(' '), /重複/)
})

test('参加未定warningだけなら追加でき、無関係な既存Issueでもblockしない', () => {
  const unrelatedBrokenDuty = {
    id: 'duty-broken', dutyTypeId: 'missing-type', eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-sub',
    from: { kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'end' },
  }
  const result = createTimetableGridAssignment({
    context: context({ dutyAssignments: [unrelatedBrokenDuty] }),
    selection: selection(), memberId: 'member-undecided',
    newAssignmentId: 'pa-undecided',
  })
  assert.equal(result.ok, true)
  assert.match(result.warnings.join(' '), /未定/)
  assert.equal(result.paAssignments.some((assignment) =>
    assignment.id === 'pa-undecided'), true)
})

test('失敗・成功のどちらでもselectionと入力collectionをmutationしない', () => {
  const input = context()
  const selectedRange = selection()
  const beforeContext = structuredClone(input)
  const beforeSelection = structuredClone(selectedRange)
  createTimetableGridAssignment({
    context: input, selection: selectedRange, memberId: 'member-sub',
    newAssignmentId: 'pa-invalid',
  })
  createTimetableGridAssignment({
    context: input, selection: selectedRange, memberId: 'member-main',
    newAssignmentId: 'pa-valid',
  })
  assert.deepEqual(input, beforeContext)
  assert.deepEqual(selectedRange, beforeSelection)
})

test('cross-Section・部間Break・fixed Section gapを含む解決済み範囲をそのまま割り当てる', () => {
  const crossSectionSelection = selection(
    { kind: 'pa', role: 'main' },
    {
      scheduleItemIds: ['item-1', 'item-2', 'item-3'],
      rowCount: 3,
      untilMinute: 630,
      untilBoundary: {
        kind: 'schedule-item', scheduleItemId: 'item-3', edge: 'end',
      },
    },
  )
  const result = createTimetableGridAssignment({
    context: context(), selection: crossSectionSelection,
    memberId: 'member-main', newAssignmentId: 'pa-cross-section',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.paAssignments.at(-1).from,
    crossSectionSelection.fromBoundary)
  assert.deepEqual(result.paAssignments.at(-1).until,
    crossSectionSelection.untilBoundary)
})

test('capability・参加登録に不備があるmemberをfail closedにする', () => {
  const cases = [
    { label: 'capabilityなし', input: context(), memberId: 'member-sub' },
    { label: '欠席', input: context(), memberId: 'member-absent' },
    {
      label: 'EventMemberなし',
      input: context({
        eventMembers: eventMembers.filter((item) => item.memberId !== 'member-main'),
      }),
      memberId: 'member-main',
    },
    {
      label: 'EventMemberDayなし',
      input: context({
        eventMemberDays: eventMemberDays.filter((item) =>
          item.eventMemberId !== 'event-member-member-main'),
      }),
      memberId: 'member-main',
    },
    {
      label: 'Memberなし',
      input: context({
        members: members.filter((item) => item.id !== 'member-main'),
      }),
      memberId: 'member-main',
    },
  ]
  for (const testCase of cases) {
    const result = createTimetableGridAssignment({
      context: testCase.input,
      selection: selection(),
      memberId: testCase.memberId,
      newAssignmentId: `pa-${testCase.label}`,
    })
    assert.equal(result.ok, false, testCase.label)
  }

  const mainOnlyAsSub = createTimetableGridAssignment({
    context: context(), selection: selection({ kind: 'pa', role: 'sub' }),
    memberId: 'member-main', newAssignmentId: 'pa-main-only-as-sub',
  })
  assert.equal(mainOnlyAsSub.ok, false)
})

test('同じmemberの既存Duty overlapをrejectする', () => {
  const existingDuty = {
    id: 'duty-existing', dutyTypeId: 'duty-photo', eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-main',
    from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' },
  }
  const result = createTimetableGridAssignment({
    context: context({ dutyAssignments: [existingDuty] }),
    selection: selection({ kind: 'duty', dutyTypeId: 'duty-photo' }),
    memberId: 'member-main', newAssignmentId: 'duty-overlap',
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /重複/)
})

test('同一Eventの他Day Assignmentを保持する', () => {
  const otherDayAssignment = {
    id: 'pa-other-day', eventId: event.id, eventDayId: 'day-2', stageId: 'stage-2',
    memberId: 'member-sub', role: 'sub',
    from: { kind: 'schedule-item', scheduleItemId: 'day-2-item', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'day-2-item', edge: 'end' },
  }
  const otherDayMemberDay = {
    id: 'member-day-sub-day-2',
    eventMemberId: 'event-member-member-sub',
    eventDayId: 'day-2',
    participationStatus: 'participating',
  }
  const otherDayCalculatedItem = {
    scheduleItemId: 'day-2-item', eventDayId: 'day-2', stageId: 'stage-2',
    kind: 'break', plannedStartMinute: 600, plannedEndMinute: 610,
  }
  const result = createTimetableGridAssignment({
    context: context({
      paAssignments: [otherDayAssignment],
      eventMemberDays: [...eventMemberDays, otherDayMemberDay],
      calculatedItems: [...calculatedItems, otherDayCalculatedItem],
    }),
    selection: selection(), memberId: 'member-main',
    newAssignmentId: 'pa-with-other-day',
  })
  assert.equal(result.ok, true)
  assert.equal(result.paAssignments.some((assignment) =>
    assignment.id === 'pa-other-day'), true)
})

test('foreign EventDayをrejectし、同じinputにはdeterministicな結果を返す', () => {
  const foreignDayContext = context({
    eventDays: [
      ...eventDays,
      { id: 'foreign-day', eventId: 'event-foreign', date: '2027-12-01', order: 0 },
    ],
  })
  const foreignDayResult = getTimetableGridAssignmentCandidates(
    foreignDayContext,
    selection({ kind: 'pa', role: 'main' }, { eventDayId: 'foreign-day' }),
  )
  assert.equal(foreignDayResult.ok, false)

  const input = {
    context: context(), selection: selection(), memberId: 'member-main',
    newAssignmentId: 'pa-deterministic',
  }
  assert.deepEqual(
    createTimetableGridAssignment(input),
    createTimetableGridAssignment(input),
  )
})

const paAssignment = (overrides = {}) => ({
  id: 'pa-delete',
  eventId: event.id,
  eventDayId: 'day-1',
  stageId: 'stage-1',
  memberId: 'member-main',
  role: 'main',
  from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
  until: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'end' },
  ...overrides,
})

const dutyAssignment = (overrides = {}) => ({
  id: 'duty-delete',
  dutyTypeId: 'duty-photo',
  eventDayId: 'day-1',
  stageId: 'stage-1',
  memberId: 'member-main',
  from: { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
  until: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'end' },
  ...overrides,
})

test('PA AssignmentをIDで1件だけ削除し他Event・他Day・他Stageを保持する', () => {
  const assignments = [
    paAssignment(),
    paAssignment({ id: 'pa-other-current' }),
    paAssignment({ id: 'pa-foreign', eventId: 'event-foreign' }),
    paAssignment({
      id: 'pa-other-day', eventDayId: 'day-2', stageId: 'stage-2',
      from: { kind: 'schedule-item', scheduleItemId: 'other-day', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'other-day', edge: 'end' },
    }),
    paAssignment({ id: 'pa-other-stage', stageId: 'stage-1b' }),
  ]
  const result = deleteTimetableGridAssignment({
    context: context({
      stages: [...stages, {
        id: 'stage-1b', eventDayId: 'day-1', name: 'Sub', order: 1,
        plannedStartTime: '10:00',
      }],
      paAssignments: assignments,
    }),
    target: { kind: 'pa', assignmentId: 'pa-delete' },
    eventDayId: 'day-1',
    stageId: 'stage-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'pa')
  assert.deepEqual(result.paAssignments.map((item) => item.id), [
    'pa-other-current', 'pa-foreign', 'pa-other-day', 'pa-other-stage',
  ])
  assert.equal(result.targetLabel, 'Main PA')
  assert.equal(result.memberName, 'Main担当')
  assert.deepEqual([result.fromMinute, result.untilMinute], [600, 620])
})

test('Duty AssignmentをIDで1件だけ削除し他Duty・他Eventを保持する', () => {
  const foreignType = {
    id: 'duty-foreign-type', eventId: 'event-foreign', name: '他Event業務', order: 0,
  }
  const assignments = [
    dutyAssignment(),
    dutyAssignment({ id: 'duty-other-current' }),
    dutyAssignment({ id: 'duty-foreign', dutyTypeId: foreignType.id }),
    dutyAssignment({ id: 'duty-other-day', eventDayId: 'day-2', stageId: 'stage-2' }),
    dutyAssignment({ id: 'duty-other-stage', stageId: 'stage-1b' }),
  ]
  const result = deleteTimetableGridAssignment({
    context: context({
      stages: [...stages, {
        id: 'stage-1b', eventDayId: 'day-1', name: 'Sub', order: 1,
        plannedStartTime: '10:00',
      }],
      dutyTypes: [...dutyTypes, foreignType],
      dutyAssignments: assignments,
    }),
    target: { kind: 'duty', assignmentId: 'duty-delete' },
    eventDayId: 'day-1',
    stageId: 'stage-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'duty')
  assert.deepEqual(result.dutyAssignments.map((item) => item.id), [
    'duty-other-current', 'duty-foreign', 'duty-other-day', 'duty-other-stage',
  ])
  assert.equal(result.targetLabel, '撮影')
})

test('missing・foreign・EventDay/Stage不一致のPA削除をfail closedにする', () => {
  const cases = [
    {
      label: 'missing ID',
      assignments: [paAssignment()],
      targetId: 'missing-pa',
    },
    {
      label: 'foreign Event',
      assignments: [paAssignment({ eventId: 'event-foreign' })],
      targetId: 'pa-delete',
    },
    {
      label: 'other EventDay',
      assignments: [paAssignment({ eventDayId: 'day-2', stageId: 'stage-2' })],
      targetId: 'pa-delete',
    },
    {
      label: 'other Stage',
      assignments: [paAssignment({ stageId: 'stage-1b' })],
      targetId: 'pa-delete',
    },
  ]
  for (const testCase of cases) {
    const result = deleteTimetableGridAssignment({
      context: context({
        stages: [...stages, {
          id: 'stage-1b', eventDayId: 'day-1', name: 'Sub', order: 1,
          plannedStartTime: '10:00',
        }],
        paAssignments: testCase.assignments,
      }),
      target: { kind: 'pa', assignmentId: testCase.targetId },
      eventDayId: 'day-1',
      stageId: 'stage-1',
    })
    assert.equal(result.ok, false, testCase.label)
  }
})

test('missing ID・DutyType missing/foreign・EventDay/Stage不一致のDuty削除をfail closedにする', () => {
  const cases = [
    {
      label: 'missing ID',
      assignments: [dutyAssignment()],
      targetId: 'missing-duty',
      types: dutyTypes,
    },
    {
      label: 'missing DutyType',
      assignments: [dutyAssignment({ dutyTypeId: 'missing-type' })],
      targetId: 'duty-delete',
      types: dutyTypes,
    },
    {
      label: 'foreign DutyType',
      assignments: [dutyAssignment({ dutyTypeId: 'foreign-type' })],
      targetId: 'duty-delete',
      types: [...dutyTypes, {
        id: 'foreign-type', eventId: 'event-foreign', name: '別Event', order: 0,
      }],
    },
    {
      label: 'other EventDay',
      assignments: [dutyAssignment({ eventDayId: 'day-2', stageId: 'stage-2' })],
      targetId: 'duty-delete',
      types: dutyTypes,
    },
    {
      label: 'other Stage',
      assignments: [dutyAssignment({ stageId: 'stage-1b' })],
      targetId: 'duty-delete',
      types: dutyTypes,
    },
  ]
  for (const testCase of cases) {
    const result = deleteTimetableGridAssignment({
      context: context({
        stages: [...stages, {
          id: 'stage-1b', eventDayId: 'day-1', name: 'Sub', order: 1,
          plannedStartTime: '10:00',
        }],
        dutyTypes: testCase.types,
        dutyAssignments: testCase.assignments,
      }),
      target: { kind: 'duty', assignmentId: testCase.targetId },
      eventDayId: 'day-1',
      stageId: 'stage-1',
    })
    assert.equal(result.ok, false, testCase.label)
  }
})

test('Assignment削除はdeterministicかつinput non-mutationである', () => {
  const inputContext = context({
    paAssignments: [paAssignment(), paAssignment({ id: 'pa-retained' })],
    dutyAssignments: [dutyAssignment()],
  })
  const before = structuredClone(inputContext)
  const input = {
    context: inputContext,
    target: { kind: 'pa', assignmentId: 'pa-delete' },
    eventDayId: 'day-1',
    stageId: 'stage-1',
  }
  assert.deepEqual(
    deleteTimetableGridAssignment(input),
    deleteTimetableGridAssignment(input),
  )
  assert.deepEqual(inputContext, before)
})

const coverageRow = ({
  id,
  main = [],
  sub = [],
  duties = {},
  kind = 'performance',
  sectionId,
  afterSectionId,
}) => ({
  scheduleItem: {
    id,
    kind,
    ...(sectionId ? { sectionId } : {}),
    ...(afterSectionId ? { afterSectionId } : {}),
  },
  paCoverage: {
    main: main.map((assignmentId) => ({ assignmentId })),
    sub: sub.map((assignmentId) => ({ assignmentId })),
  },
  dutyCoverage: Object.fromEntries(
    Object.entries(duties).map(([dutyTypeId, assignmentIds]) => [
      dutyTypeId,
      assignmentIds.map((assignmentId) => ({ assignmentId })),
    ]),
  ),
})

const selectedCoverage = (target, scheduleItemIds) => selection(target, {
  scheduleItemIds,
  rowCount: scheduleItemIds.length,
})

test('selection列だけからMain/Sub PAとDutyのAssignment IDを収集する', () => {
  const rows = [coverageRow({
    id: 'item-1',
    main: ['pa-main'],
    sub: ['pa-sub'],
    duties: { 'duty-photo': ['duty-photo-a'], 'duty-reception': ['duty-reception-a'] },
  })]
  assert.deepEqual(getTimetableGridSelectionAssignmentTargets(
    selectedCoverage({ kind: 'pa', role: 'main' }, ['item-1']), rows,
  ), [{ kind: 'pa', assignmentId: 'pa-main' }])
  assert.deepEqual(getTimetableGridSelectionAssignmentTargets(
    selectedCoverage({ kind: 'pa', role: 'sub' }, ['item-1']), rows,
  ), [{ kind: 'pa', assignmentId: 'pa-sub' }])
  assert.deepEqual(getTimetableGridSelectionAssignmentTargets(
    selectedCoverage({ kind: 'duty', dutyTypeId: 'duty-photo' }, ['item-1']), rows,
  ), [{ kind: 'duty', assignmentId: 'duty-photo-a' }])
})

test('複数rowの同一Assignmentを重複除去し異なるAssignmentは安定順で収集する', () => {
  const rows = [
    coverageRow({ id: 'item-1', main: ['pa-a'] }),
    coverageRow({
      id: 'inter-section-break', main: ['pa-a'], kind: 'break',
      afterSectionId: 'section-1',
    }),
    coverageRow({ id: 'item-3', main: ['pa-a', 'pa-b'], sectionId: 'section-2' }),
  ]
  const resolved = selectedCoverage(
    { kind: 'pa', role: 'main' },
    ['item-1', 'inter-section-break', 'item-3'],
  )
  assert.deepEqual(getTimetableGridSelectionAssignmentTargets(resolved, rows), [
    { kind: 'pa', assignmentId: 'pa-a' },
    { kind: 'pa', assignmentId: 'pa-b' },
  ])
})

test('Duty複数件を収集し担当なしselectionは空にする', () => {
  const rows = [
    coverageRow({ id: 'item-1', duties: { 'duty-photo': ['duty-a'] } }),
    coverageRow({ id: 'item-2', duties: { 'duty-photo': ['duty-a', 'duty-b'] } }),
    coverageRow({ id: 'item-3' }),
  ]
  assert.deepEqual(getTimetableGridSelectionAssignmentTargets(
    selectedCoverage({ kind: 'duty', dutyTypeId: 'duty-photo' }, ['item-1', 'item-2']),
    rows,
  ), [
    { kind: 'duty', assignmentId: 'duty-a' },
    { kind: 'duty', assignmentId: 'duty-b' },
  ])
  assert.deepEqual(getTimetableGridSelectionAssignmentTargets(
    selectedCoverage({ kind: 'duty', dutyTypeId: 'duty-photo' }, ['item-3']),
    rows,
  ), [])
})

test('selection target収集はdeterministicかつinput non-mutationである', () => {
  const rows = [coverageRow({ id: 'item-1', main: ['pa-a', 'pa-b'] })]
  const resolved = selectedCoverage({ kind: 'pa', role: 'main' }, ['item-1'])
  const before = structuredClone({ rows, resolved })
  assert.deepEqual(
    getTimetableGridSelectionAssignmentTargets(resolved, rows),
    getTimetableGridSelectionAssignmentTargets(resolved, rows),
  )
  assert.deepEqual({ rows, resolved }, before)
})

test('複数PA Assignmentを1回のatomic結果として削除する', () => {
  const inputContext = context({
    paAssignments: [
      paAssignment({ id: 'pa-a' }),
      paAssignment({ id: 'pa-b', memberId: 'member-sub' }),
      paAssignment({ id: 'pa-retained' }),
    ],
  })
  const result = deleteTimetableGridAssignments({
    context: inputContext,
    targets: [
      { kind: 'pa', assignmentId: 'pa-a' },
      { kind: 'pa', assignmentId: 'pa-b' },
    ],
    eventDayId: 'day-1',
    stageId: 'stage-1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'pa')
  assert.deepEqual(result.paAssignments.map((item) => item.id), ['pa-retained'])
  assert.deepEqual(result.deleted.map((item) => item.target.assignmentId), ['pa-a', 'pa-b'])
})

test('複数Duty Assignmentをatomicに削除し1件でも不正なら全体を失敗させる', () => {
  const assignments = [
    dutyAssignment({ id: 'duty-a' }),
    dutyAssignment({ id: 'duty-b', memberId: 'member-sub' }),
    dutyAssignment({ id: 'duty-retained' }),
  ]
  const inputContext = context({ dutyAssignments: assignments })
  const success = deleteTimetableGridAssignments({
    context: inputContext,
    targets: [
      { kind: 'duty', assignmentId: 'duty-a' },
      { kind: 'duty', assignmentId: 'duty-b' },
    ],
    eventDayId: 'day-1',
    stageId: 'stage-1',
  })
  assert.equal(success.ok, true)
  assert.equal(success.kind, 'duty')
  assert.deepEqual(success.dutyAssignments.map((item) => item.id), ['duty-retained'])

  const before = structuredClone(inputContext)
  const failure = deleteTimetableGridAssignments({
    context: inputContext,
    targets: [
      { kind: 'duty', assignmentId: 'duty-a' },
      { kind: 'duty', assignmentId: 'missing-duty' },
    ],
    eventDayId: 'day-1',
    stageId: 'stage-1',
  })
  assert.equal(failure.ok, false)
  assert.deepEqual(inputContext, before)
})
