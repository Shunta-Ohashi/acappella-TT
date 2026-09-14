import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canDeleteDutyType,
  createDutySettingsDraft,
  createDutySettingsUpdate,
  getDutyAssignmentsForEvent,
  getDutyAssignmentParticipationWarning,
  moveDutyTypeDraft,
  resolveDutyAssignmentInterval,
  validateDutyAssignmentDraftItem,
  validateDutySettingsDraft,
  validateDutyTypeDrafts,
} from '../src/domain/dutyAssignments.ts'
import { detectScheduleIssues } from '../src/domain/issues.ts'
import { intervalsOverlap } from '../src/domain/scheduleBoundaries.ts'

const event = {
  id: 'event-1',
  name: 'テストイベント',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
  performanceSlotMinutes: [10],
}
const eventDays = [
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
]
const stages = [
  {
    id: 'stage-a',
    eventDayId: 'day-1',
    name: 'Main',
    order: 0,
    plannedStartTime: '10:00',
  },
]
const members = [
  { id: 'member-1', realName: '出演者', active: true },
  {
    id: 'member-2',
    realName: '担当者',
    active: true,
    paCapabilities: { main: true, sub: true },
  },
  { id: 'member-3', realName: '別担当者', active: true },
]
const eventMembers = members.map((member) => ({
  id: `event-member-${member.id}`,
  eventId: event.id,
  memberId: member.id,
}))
const createMemberDays = (overrides = {}) => eventMembers.map((eventMember) => ({
  id: `member-day-${eventMember.memberId}`,
  eventMemberId: eventMember.id,
  eventDayId: 'day-1',
  participationStatus: 'participating',
  ...(overrides[eventMember.memberId] ?? {}),
}))
const eventBands = [
  {
    id: 'event-band-1',
    eventId: event.id,
    eventDayId: 'day-1',
    name: 'Choir',
    memberIds: ['member-1'],
    durationMinutes: 10,
  },
]
const calculatedItems = [
  {
    scheduleItemId: 'performance-1',
    eventDayId: 'day-1',
    stageId: 'stage-a',
    kind: 'performance',
    eventBandId: 'event-band-1',
    plannedStartMinute: 600,
    plannedEndMinute: 610,
  },
  {
    scheduleItemId: 'break-1',
    eventDayId: 'day-1',
    stageId: 'stage-a',
    kind: 'break',
    plannedStartMinute: 612,
    plannedEndMinute: 622,
  },
]
const typeDrafts = [
  { draftId: 'type-photo', dutyTypeId: 'duty-photo', name: '撮影' },
  { draftId: 'type-tk', dutyTypeId: 'duty-tk', name: 'TK' },
]
const dutyTypes = typeDrafts.map((item, order) => ({
  id: item.dutyTypeId,
  eventId: event.id,
  name: item.name,
  order,
}))
const createItem = (overrides = {}) => ({
  draftId: 'assignment-draft',
  dutyTypeDraftId: 'type-photo',
  eventDayId: 'day-1',
  stageId: 'stage-a',
  memberId: 'member-2',
  from: { scheduleItemId: 'performance-1', edge: 'start' },
  until: { scheduleItemId: 'performance-1', edge: 'end' },
  ...overrides,
})
const assignment = (id, overrides = {}) => ({
  id,
  dutyTypeId: 'duty-photo',
  eventDayId: 'day-1',
  stageId: 'stage-a',
  memberId: 'member-2',
  from: { scheduleItemId: 'performance-1', edge: 'start' },
  until: { scheduleItemId: 'performance-1', edge: 'end' },
  ...overrides,
})
const paAssignment = (overrides = {}) => ({
  id: 'pa-1',
  eventId: event.id,
  eventDayId: 'day-1',
  stageId: 'stage-a',
  memberId: 'member-2',
  role: 'main',
  from: { scheduleItemId: 'performance-1', edge: 'start' },
  until: { scheduleItemId: 'performance-1', edge: 'end' },
  ...overrides,
})

const validateItem = (item, overrides = {}) => validateDutyAssignmentDraftItem({
  item,
  dutyTypes: typeDrafts,
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays: createMemberDays(),
  eventBands,
  paAssignments: [],
  calculatedItems,
  ...overrides,
})

const detect = ({
  assignments,
  types = dutyTypes,
  paAssignments = [],
  memberDays = createMemberDays(),
  items = calculatedItems,
}) => detectScheduleIssues({
  event,
  members,
  eventMembers,
  eventMemberDays: memberDays,
  eventBands,
  stages,
  sections: [],
  paAssignments,
  dutyTypes: types,
  dutyAssignments: assignments,
  calculatedItems: items,
})

const findIssues = (issues, code) => issues.filter((issue) => issue.code === code)

test('仕事名の空文字と大小文字を無視した重複を拒否する', () => {
  const errors = validateDutyTypeDrafts([
    { draftId: 'empty', name: '  ' },
    { draftId: 'first', name: ' TK ' },
    { draftId: 'second', name: 'tk' },
  ])

  assert.match(errors.empty.name, /入力/)
  assert.match(errors.first.name, /重複/)
  assert.match(errors.second.name, /重複/)
})

test('仕事を安定して並べ替え、renameとorderを保存する', () => {
  const reordered = moveDutyTypeDraft(typeDrafts, 'type-tk', -1)
  reordered[0] = { ...reordered[0], name: 'タイムキーパー' }
  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes,
    dutyAssignments: [],
    draft: { dutyTypes: reordered, assignments: [] },
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.dutyTypes.map(({ id, name, order }) => ({ id, name, order })), [
    { id: 'duty-tk', name: 'タイムキーパー', order: 0 },
    { id: 'duty-photo', name: '撮影', order: 1 },
  ])
})

test('担当から参照される仕事は削除不可で、未参照なら削除できる', () => {
  assert.equal(canDeleteDutyType('type-photo', [createItem()]), false)
  assert.equal(canDeleteDutyType('type-tk', [createItem()]), true)
})

test('Event別DutyAssignment選択は未知DutyTypeのみStage所属で補完する', () => {
  const otherEvent = { ...event, id: 'event-2', name: '別Event' }
  const otherStage = { ...stages[0], id: 'stage-b', eventDayId: 'day-2' }
  const otherType = {
    id: 'duty-other',
    eventId: otherEvent.id,
    name: '消毒',
    order: 0,
  }
  const selectedAssignment = assignment('selected')
  const brokenAssignment = assignment('broken', {
    dutyTypeId: 'missing-duty-type',
  })
  const otherAssignment = assignment('other', {
    dutyTypeId: otherType.id,
    eventDayId: 'day-2',
    stageId: otherStage.id,
  })
  const allTypes = [...dutyTypes, otherType]
  const allAssignments = [selectedAssignment, brokenAssignment, otherAssignment]

  const selected = getDutyAssignmentsForEvent({
    event,
    stages,
    dutyTypes: allTypes,
    dutyAssignments: allAssignments,
  })
  assert.deepEqual(selected.map((item) => item.id), ['selected', 'broken'])

  const selectedDraft = createDutySettingsDraft(
    event,
    eventDays,
    allTypes,
    selected,
  )
  assert.equal(
    selectedDraft.assignments.find((item) => item.dutyAssignmentId === 'broken')
      ?.missingDutyTypeId,
    'missing-duty-type',
  )
  assert.equal(
    selectedDraft.assignments.some((item) => item.dutyAssignmentId === 'other'),
    false,
  )

  assert.deepEqual(getDutyAssignmentsForEvent({
    event: otherEvent,
    stages: [otherStage],
    dutyTypes: allTypes,
    dutyAssignments: allAssignments,
  }).map((item) => item.id), ['other'])
})

test('DutyType参照切れ担当をdraftとround-trip保存で失わない', () => {
  const broken = assignment('broken-type', { dutyTypeId: 'deleted-duty-type' })
  const draft = createDutySettingsDraft(
    event,
    eventDays,
    dutyTypes,
    [broken],
  )

  assert.equal(draft.assignments.length, 1)
  assert.equal(draft.assignments[0].dutyTypeDraftId, undefined)
  assert.equal(draft.assignments[0].missingDutyTypeId, 'deleted-duty-type')

  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes,
    dutyAssignments: [broken],
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.dutyAssignments, [broken])
})

test('DutyType参照切れ担当は有効な仕事へ修復できる', () => {
  const broken = assignment('repair-type', { dutyTypeId: 'deleted-duty-type' })
  const draft = createDutySettingsDraft(
    event,
    eventDays,
    dutyTypes,
    [broken],
  )
  draft.assignments[0] = {
    ...draft.assignments[0],
    dutyTypeDraftId: draft.dutyTypes[0].draftId,
    missingDutyTypeId: undefined,
  }

  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes,
    dutyAssignments: [broken],
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.dutyAssignments[0].dutyTypeId, 'duty-photo')
})

test('DutyType参照切れ担当はdraftから削除したときだけ削除する', () => {
  const broken = assignment('remove-broken-type', {
    dutyTypeId: 'deleted-duty-type',
  })
  const draft = createDutySettingsDraft(
    event,
    eventDays,
    dutyTypes,
    [broken],
  )
  draft.assignments = []

  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes,
    dutyAssignments: [broken],
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.dutyAssignments, [])
})

test('PerformanceとBreakを含むBoundaryから区間を解決しTimeline変更へ追従する', () => {
  const range = createItem({
    from: { scheduleItemId: 'performance-1', edge: 'start' },
    until: { scheduleItemId: 'break-1', edge: 'end' },
  })
  assert.deepEqual(resolveDutyAssignmentInterval(range, calculatedItems), {
    ok: true,
    interval: { fromMinute: 600, untilMinute: 622 },
  })

  const moved = calculatedItems.map((item) => ({
    ...item,
    plannedStartMinute: item.plannedStartMinute + 30,
    plannedEndMinute: item.plannedEndMinute + 30,
  }))
  assert.deepEqual(resolveDutyAssignmentInterval(range, moved), {
    ok: true,
    interval: { fromMinute: 630, untilMinute: 652 },
  })
})

test('参照切れ・同時刻Boundaryを拒否し、接するhalf-open区間は重複しない', () => {
  assert.equal(resolveDutyAssignmentInterval(createItem({
    from: { scheduleItemId: 'missing', edge: 'start' },
  }), calculatedItems).ok, false)
  assert.equal(resolveDutyAssignmentInterval(createItem({
    from: { scheduleItemId: 'performance-1', edge: 'end' },
    until: { scheduleItemId: 'break-1', edge: 'start' },
  }), calculatedItems).ok, true)
  assert.equal(intervalsOverlap(
    { fromMinute: 600, untilMinute: 610 },
    { fromMinute: 610, untilMinute: 620 },
  ), false)
})

test('EventMemberDay不足・absent・availability外をblockingしundecidedはwarningにする', () => {
  const missing = validateItem(createItem(), {
    eventMemberDays: createMemberDays().filter((day) =>
      day.eventMemberId !== 'event-member-member-2'),
  })
  const absentDays = createMemberDays({
    'member-2': { participationStatus: 'absent' },
  })
  const absent = validateItem(createItem(), { eventMemberDays: absentDays })
  const outside = validateItem(createItem(), {
    eventMemberDays: createMemberDays({
      'member-2': { availabilityWindows: [{ from: '11:00' }] },
    }),
  })
  const undecidedDays = createMemberDays({
    'member-2': { participationStatus: 'undecided' },
  })

  assert.match(missing.memberId, /参加情報/)
  assert.match(absent.memberId, /不参加/)
  assert.match(outside.availability, /出演可能時間外/)
  assert.equal(validateItem(createItem(), { eventMemberDays: undecidedDays }).memberId, undefined)
  assert.match(getDutyAssignmentParticipationWarning({
    item: createItem(),
    event,
    eventMembers,
    eventMemberDays: undecidedDays,
  }), /未定/)
})

test('一般業務中の本人出演とPA重複を保存前に拒否する', () => {
  assert.match(validateItem(createItem({ memberId: 'member-1' })).conflict, /出演/)
  assert.match(validateItem(createItem(), {
    paAssignments: [paAssignment()],
  }).conflict, /PA/)
})

test('Duty validationは保存予定の最新PA一覧を使って競合を判定する', () => {
  const dutyItem = createItem()
  const currentPa = paAssignment()
  const movedItems = [
    ...calculatedItems,
    {
      scheduleItemId: 'performance-later',
      eventDayId: 'day-1',
      stageId: 'stage-a',
      kind: 'performance',
      eventBandId: 'event-band-1',
      plannedStartMinute: 660,
      plannedEndMinute: 670,
    },
  ]
  const movedPa = paAssignment({
    from: { scheduleItemId: 'performance-later', edge: 'start' },
    until: { scheduleItemId: 'performance-later', edge: 'end' },
  })

  assert.match(validateItem(dutyItem, {
    paAssignments: [currentPa],
  }).conflict, /PA/)
  assert.equal(validateItem(dutyItem, {
    paAssignments: [],
  }).conflict, undefined)
  assert.equal(validateItem(dutyItem, {
    paAssignments: [movedPa],
    calculatedItems: movedItems,
  }).conflict, undefined)
  assert.equal(validateItem(dutyItem, {
    paAssignments: [paAssignment({ memberId: 'member-3' })],
  }).conflict, undefined)
})

test('同じMemberのDuty重複は仕事やStageを問わず拒否する', () => {
  const errors = validateDutySettingsDraft({
    draft: {
      dutyTypes: typeDrafts,
      assignments: [
        createItem({ draftId: 'first' }),
        createItem({ draftId: 'second', dutyTypeDraftId: 'type-tk' }),
      ],
    },
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
  })

  assert.match(errors.assignments.first.conflict, /重複/)
  assert.match(errors.assignments.second.conflict, /重複/)
})

test('同じDutyType・同時間でも別Memberの複数担当は許可する', () => {
  const errors = validateDutySettingsDraft({
    draft: {
      dutyTypes: typeDrafts,
      assignments: [
        createItem({ draftId: 'first', memberId: 'member-2' }),
        createItem({ draftId: 'second', memberId: 'member-3' }),
      ],
    },
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
  })

  assert.deepEqual(errors.assignments, {})
})

test('Issue detectorが出演・Duty・PAとの競合をそれぞれERRORにする', () => {
  const performanceIssues = detect({
    assignments: [assignment('duty-performance', { memberId: 'member-1' })],
  })
  const overlapIssues = detect({
    assignments: [
      assignment('duty-first'),
      assignment('duty-second', { dutyTypeId: 'duty-tk' }),
    ],
  })
  const paIssues = detect({
    assignments: [assignment('duty-pa')],
    paAssignments: [paAssignment()],
  })

  assert.equal(findIssues(performanceIssues, 'DUTY_MEMBER_PERFORMANCE_OVERLAP')[0].severity, 'ERROR')
  assert.equal(findIssues(overlapIssues, 'DUTY_ASSIGNMENT_OVERLAP')[0].severity, 'ERROR')
  assert.equal(findIssues(paIssues, 'DUTY_PA_OVERLAP')[0].severity, 'ERROR')
})

test('Issue detectorが参加状態・availability・仕事参照・broken boundaryを検出する', () => {
  const memberIssues = detect({
    assignments: [assignment('duty-member')],
    memberDays: createMemberDays({
      'member-2': {
        participationStatus: 'undecided',
        availabilityWindows: [{ from: '11:00' }],
      },
    }),
  })
  const absentIssues = detect({
    assignments: [assignment('duty-absent')],
    memberDays: createMemberDays({
      'member-2': { participationStatus: 'absent' },
    }),
  })
  const structuralIssues = detect({
    assignments: [assignment('duty-broken', {
      dutyTypeId: 'missing-type',
      from: { scheduleItemId: 'missing', edge: 'start' },
    })],
  })

  assert.equal(findIssues(memberIssues, 'DUTY_MEMBER_UNDECIDED').length, 1)
  assert.equal(findIssues(memberIssues, 'DUTY_OUTSIDE_MEMBER_AVAILABILITY').length, 1)
  assert.equal(findIssues(absentIssues, 'DUTY_MEMBER_ABSENT').length, 1)
  assert.equal(findIssues(structuralIssues, 'DUTY_TYPE_NOT_FOUND').length, 1)
  assert.match(
    findIssues(structuralIssues, 'DUTY_TYPE_NOT_FOUND')[0].message,
    /DutyType missing-type/,
  )
  assert.doesNotMatch(
    findIssues(structuralIssues, 'DUTY_TYPE_NOT_FOUND')[0].message,
    /duty-broken/,
  )
  assert.equal(findIssues(structuralIssues, 'DUTY_INVALID_BOUNDARY').length, 1)
})

test('draft保存で追加・編集・削除し別Eventの仕事と担当を維持する', () => {
  const otherType = { id: 'other-type', eventId: 'other-event', name: '受付', order: 0 }
  const existingAssignments = [assignment('keep'), assignment('remove')]
  const otherAssignment = assignment('other-assignment', {
    dutyTypeId: otherType.id,
  })
  const draft = createDutySettingsDraft(
    event,
    eventDays,
    [...dutyTypes, otherType],
    [...existingAssignments, otherAssignment],
  )
  draft.dutyTypes[0].name = '記録撮影'
  draft.assignments = draft.assignments.filter((item) =>
    item.dutyAssignmentId !== 'remove',
  )
  draft.assignments.push(createItem({
    draftId: 'new',
    dutyTypeDraftId: draft.dutyTypes[0].draftId,
    memberId: 'member-3',
  }))

  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes: [...dutyTypes, otherType],
    dutyAssignments: [...existingAssignments, otherAssignment],
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: ['new-assignment'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.dutyTypes.find((item) => item.id === 'duty-photo').name, '記録撮影')
  assert.equal(result.dutyAssignments.some((item) => item.id === 'remove'), false)
  assert.ok(result.dutyAssignments.some((item) => item.id === 'new-assignment'))
  assert.deepEqual(result.dutyTypes.find((item) => item.id === otherType.id), otherType)
  assert.deepEqual(
    result.dutyAssignments.find((item) => item.id === otherAssignment.id),
    otherAssignment,
  )
})

test('参照中DutyTypeとAssignmentを同じdraftから除外しても暗黙削除しない', () => {
  const existingAssignment = assignment('assignment-photo')
  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes: [dutyTypes[0]],
    dutyAssignments: [existingAssignment],
    draft: { dutyTypes: [], assignments: [] },
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.form, /先に担当を削除して保存/)
})

test('参照中DutyTypeだけをdraftから除外しても削除しない', () => {
  const existingAssignment = assignment('assignment-photo')
  const draft = createDutySettingsDraft(
    event,
    eventDays,
    [dutyTypes[0]],
    [existingAssignment],
  )
  draft.dutyTypes = []

  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes: [dutyTypes[0]],
    dutyAssignments: [existingAssignment],
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, false)
})

test('persisted Assignmentがなければ未参照DutyTypeを削除できる', () => {
  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes: [dutyTypes[0]],
    dutyAssignments: [],
    draft: { dutyTypes: [], assignments: [] },
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.dutyTypes.some((item) => item.id === dutyTypes[0].id), false)
})

test('他DutyTypeと他EventのAssignmentは未参照DutyTypeの削除を妨げない', () => {
  const otherEventType = {
    id: 'other-event-type',
    eventId: 'other-event',
    name: '他イベント受付',
    order: 0,
  }
  const assignmentForTk = assignment('assignment-tk', {
    dutyTypeId: dutyTypes[1].id,
  })
  const otherEventAssignment = assignment('other-event-assignment', {
    dutyTypeId: otherEventType.id,
  })
  const draft = createDutySettingsDraft(
    event,
    eventDays,
    [...dutyTypes, otherEventType],
    [assignmentForTk, otherEventAssignment],
  )
  draft.dutyTypes = draft.dutyTypes.filter(
    (item) => item.dutyTypeId !== dutyTypes[0].id,
  )

  const result = createDutySettingsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    paAssignments: [],
    calculatedItems,
    dutyTypes: [...dutyTypes, otherEventType],
    dutyAssignments: [assignmentForTk, otherEventAssignment],
    draft,
    newDutyTypeIds: [],
    newDutyAssignmentIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.dutyTypes.some((item) => item.id === dutyTypes[0].id), false)
  assert.ok(result.dutyAssignments.some((item) => item.id === assignmentForTk.id))
  assert.deepEqual(
    result.dutyAssignments.find((item) => item.id === otherEventAssignment.id),
    otherEventAssignment,
  )
})
