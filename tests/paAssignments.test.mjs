import assert from 'node:assert/strict'
import test from 'node:test'

import { detectScheduleIssues } from '../src/domain/issues.ts'
import {
  createPaAssignmentsDraft,
  createPaAssignmentsUpdate,
  getPaAssignmentParticipationWarning,
  getPaMemberCandidates,
  resolvePaAssignmentInterval,
  validatePaAssignmentDraftItem,
} from '../src/domain/paAssignments.ts'

const event = {
  id: 'event-1',
  name: 'PAテスト',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 0,
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 0 },
  performanceSlotMinutes: [10],
}

const eventDays = [
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
  { id: 'day-2', eventId: event.id, date: '2027-11-07', order: 1 },
]

const stages = [
  {
    id: 'stage-a',
    eventDayId: 'day-1',
    name: 'Main Stage',
    order: 0,
    plannedStartTime: '10:00',
  },
  {
    id: 'stage-b',
    eventDayId: 'day-1',
    name: 'Sub Stage',
    order: 1,
    plannedStartTime: '10:00',
  },
  {
    id: 'stage-day-2',
    eventDayId: 'day-2',
    name: '翌日Stage',
    order: 0,
    plannedStartTime: '10:00',
  },
]

const members = [
  { id: 'member-main', realName: 'Main担当', active: true, paCapabilities: { main: true, sub: false } },
  { id: 'member-sub', realName: 'Sub担当', active: true, paCapabilities: { main: false, sub: true } },
  { id: 'member-both', realName: '両方担当', active: true, paCapabilities: { main: true, sub: true } },
  { id: 'member-none', realName: 'PA不可', active: true },
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
    id: 'event-band-a',
    eventId: event.id,
    eventDayId: 'day-1',
    name: 'Choir A',
    memberIds: ['member-none'],
    durationMinutes: 10,
  },
  {
    id: 'event-band-b',
    eventId: event.id,
    eventDayId: 'day-1',
    name: 'Choir B',
    memberIds: ['member-both'],
    durationMinutes: 10,
  },
]

const calculatedItems = [
  {
    scheduleItemId: 'performance-a',
    eventDayId: 'day-1',
    stageId: 'stage-a',
    kind: 'performance',
    eventBandId: 'event-band-a',
    plannedStartMinute: 600,
    plannedEndMinute: 610,
  },
  {
    scheduleItemId: 'break-a',
    eventDayId: 'day-1',
    stageId: 'stage-a',
    kind: 'break',
    plannedStartMinute: 610,
    plannedEndMinute: 620,
  },
  {
    scheduleItemId: 'performance-b',
    eventDayId: 'day-1',
    stageId: 'stage-b',
    kind: 'performance',
    eventBandId: 'event-band-b',
    plannedStartMinute: 605,
    plannedEndMinute: 615,
  },
]

const createItem = (overrides = {}) => ({
  draftId: 'draft-1',
  eventId: event.id,
  eventDayId: 'day-1',
  stageId: 'stage-a',
  memberId: 'member-main',
  role: 'main',
  from: { scheduleItemId: 'performance-a', edge: 'start' },
  until: { scheduleItemId: 'break-a', edge: 'end' },
  ...overrides,
})

const validate = (item, eventMemberDays = createMemberDays()) =>
  validatePaAssignmentDraftItem({
    item,
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays,
    eventBands,
    calculatedItems,
  })

const assignment = (id, overrides = {}) => ({
  id,
  eventId: event.id,
  eventDayId: 'day-1',
  stageId: 'stage-a',
  memberId: 'member-main',
  role: 'main',
  from: { scheduleItemId: 'performance-a', edge: 'start' },
  until: { scheduleItemId: 'break-a', edge: 'end' },
  ...overrides,
})

const detect = ({
  paAssignments,
  configuredMembers = members,
  configuredMemberDays = createMemberDays(),
  configuredBands = eventBands,
  items = calculatedItems,
}) => detectScheduleIssues({
  event,
  members: configuredMembers,
  eventMembers,
  eventMemberDays: configuredMemberDays,
  eventBands: configuredBands,
  stages,
  sections: [],
  paAssignments,
  dutyTypes: [],
  dutyAssignments: [],
  calculatedItems: items,
})

const findIssues = (issues, code) => issues.filter((issue) => issue.code === code)

const evaluatePaAvailability = ({
  startMinute,
  endMinute,
  availabilityWindows,
}) => {
  const item = createItem({
    from: { scheduleItemId: 'availability-range', edge: 'start' },
    until: { scheduleItemId: 'availability-range', edge: 'end' },
  })
  const items = [{
    scheduleItemId: 'availability-range',
    eventDayId: 'day-1',
    stageId: 'stage-a',
    kind: 'break',
    plannedStartMinute: startMinute,
    plannedEndMinute: endMinute,
  }]
  const configuredMemberDays = createMemberDays({
    'member-main': availabilityWindows === undefined
      ? {}
      : { availabilityWindows },
  })
  const step6Errors = validatePaAssignmentDraftItem({
    item,
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: configuredMemberDays,
    eventBands,
    calculatedItems: items,
  })
  const step7Issues = detect({
    paAssignments: [assignment('pa-availability', {
      from: item.from,
      until: item.until,
    })],
    configuredMemberDays,
    items,
  })

  return {
    step6Errors,
    step7AvailabilityIssues: findIssues(
      step7Issues,
      'PA_OUTSIDE_MEMBER_AVAILABILITY',
    ),
  }
}

test('Main/Sub capabilityを持つEventMemberだけをrole候補にする', () => {
  const mainCandidates = getPaMemberCandidates({
    event,
    eventDayId: 'day-1',
    role: 'main',
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
  })
  const subCandidates = getPaMemberCandidates({
    event,
    eventDayId: 'day-1',
    role: 'sub',
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
  })

  assert.deepEqual(mainCandidates.map(({ member }) => member.id), [
    'member-main',
    'member-both',
  ])
  assert.deepEqual(subCandidates.map(({ member }) => member.id), [
    'member-sub',
    'member-both',
  ])
  assert.equal(validate(createItem()).memberId, undefined)
  assert.ok(validate(createItem({ memberId: 'member-sub' })).memberId)
  assert.equal(validate(createItem({ memberId: 'member-sub', role: 'sub' })).memberId, undefined)
  assert.ok(validate(createItem({ memberId: 'member-main', role: 'sub' })).memberId)
})

test('participatingは許可し、absentと日別設定不足は拒否し、undecidedはwarningにする', () => {
  assert.equal(validate(createItem()).memberId, undefined)

  const absentDays = createMemberDays({
    'member-main': { participationStatus: 'absent' },
  })
  assert.ok(validate(createItem(), absentDays).memberId)

  const missingDays = createMemberDays().filter((day) =>
    day.eventMemberId !== 'event-member-member-main',
  )
  assert.ok(validate(createItem(), missingDays).memberId)

  const undecidedDays = createMemberDays({
    'member-main': { participationStatus: 'undecided' },
  })
  assert.equal(validate(createItem(), undecidedDays).memberId, undefined)
  assert.match(getPaAssignmentParticipationWarning({
    item: createItem(),
    eventMembers,
    eventMemberDays: undecidedDays,
  }), /未定/)
})

test('PerformanceとBreakのstart/end境界からfrom < untilを導出する', () => {
  const performance = resolvePaAssignmentInterval(createItem({
    until: { scheduleItemId: 'performance-a', edge: 'end' },
  }), calculatedItems)
  const breakRange = resolvePaAssignmentInterval(createItem({
    from: { scheduleItemId: 'break-a', edge: 'start' },
    until: { scheduleItemId: 'break-a', edge: 'end' },
  }), calculatedItems)

  assert.deepEqual(performance, {
    ok: true,
    interval: { fromMinute: 600, untilMinute: 610 },
  })
  assert.deepEqual(breakRange, {
    ok: true,
    interval: { fromMinute: 610, untilMinute: 620 },
  })
})

test('同時刻・逆順・別Stage・missing境界を拒否する', () => {
  assert.equal(resolvePaAssignmentInterval(createItem({
    from: { scheduleItemId: 'performance-a', edge: 'end' },
    until: { scheduleItemId: 'break-a', edge: 'start' },
  }), calculatedItems).ok, false)
  assert.equal(resolvePaAssignmentInterval(createItem({
    from: { scheduleItemId: 'break-a', edge: 'end' },
    until: { scheduleItemId: 'performance-a', edge: 'start' },
  }), calculatedItems).ok, false)
  assert.equal(resolvePaAssignmentInterval(createItem({
    until: { scheduleItemId: 'performance-b', edge: 'end' },
  }), calculatedItems).ok, false)
  assert.equal(resolvePaAssignmentInterval(createItem({
    from: { scheduleItemId: 'missing', edge: 'start' },
  }), calculatedItems).ok, false)

  const withAnotherDay = [...calculatedItems, {
    scheduleItemId: 'performance-day-2',
    eventDayId: 'day-2',
    stageId: 'stage-day-2',
    kind: 'performance',
    eventBandId: 'event-band-a',
    plannedStartMinute: 600,
    plannedEndMinute: 610,
  }]
  assert.equal(resolvePaAssignmentInterval(createItem({
    until: { scheduleItemId: 'performance-day-2', edge: 'end' },
  }), withAnotherDay).ok, false)
})

test('PA区間全体がavailabilityの1つのwindowに含まれる場合だけ許可する', () => {
  const within = createMemberDays({
    'member-main': {
      availabilityWindows: [{ from: '10:00', until: '10:20' }],
    },
  })
  const outside = createMemberDays({
    'member-main': {
      availabilityWindows: [{ from: '10:05', until: '10:30' }],
    },
  })
  const multiple = createMemberDays({
    'member-main': {
      availabilityWindows: [
        { from: '09:00', until: '09:30' },
        { from: '10:00', until: '10:20' },
      ],
    },
  })
  const crossing = createMemberDays({
    'member-main': {
      availabilityWindows: [
        { from: '10:00', until: '10:10' },
        { from: '10:10', until: '10:30' },
      ],
    },
  })

  assert.equal(validate(createItem(), within).availability, undefined)
  assert.ok(validate(createItem(), outside).availability)
  assert.equal(validate(createItem(), multiple).availability, undefined)
  assert.ok(validate(createItem(), crossing).availability)
})

test('終日availabilityでは13:00〜17:00をStep 6・7の両方で許可する', () => {
  const result = evaluatePaAvailability({
    startMinute: 13 * 60,
    endMinute: 17 * 60,
    availabilityWindows: undefined,
  })

  assert.equal(result.step6Errors.availability, undefined)
  assert.equal(result.step7AvailabilityIssues.length, 0)
})

test('終日availabilityでは23:30〜24:00をStep 6・7の両方で許可する', () => {
  const result = evaluatePaAvailability({
    startMinute: 23 * 60 + 30,
    endMinute: 24 * 60,
    availabilityWindows: undefined,
  })

  assert.equal(result.step6Errors.availability, undefined)
  assert.equal(result.step7AvailabilityIssues.length, 0)
})

test('終日availabilityでも24:00を超えるPA区間をStep 6・7の両方で拒否する', () => {
  const result = evaluatePaAvailability({
    startMinute: 23 * 60 + 30,
    endMinute: 24 * 60 + 30,
    availabilityWindows: undefined,
  })

  assert.ok(result.step6Errors.availability)
  assert.equal(result.step7AvailabilityIssues.length, 1)
  assert.equal(result.step7AvailabilityIssues[0].severity, 'ERROR')
})

test('明示availability内のPA区間をStep 6・7の両方で許可する', () => {
  const result = evaluatePaAvailability({
    startMinute: 14 * 60,
    endMinute: 16 * 60,
    availabilityWindows: [{ from: '13:00', until: '17:00' }],
  })

  assert.equal(result.step6Errors.availability, undefined)
  assert.equal(result.step7AvailabilityIssues.length, 0)
})

test('明示availability外のPA区間をStep 6・7の両方で拒否する', () => {
  const result = evaluatePaAvailability({
    startMinute: 12 * 60,
    endMinute: 14 * 60,
    availabilityWindows: [{ from: '13:00', until: '17:00' }],
  })

  assert.ok(result.step6Errors.availability)
  assert.equal(result.step7AvailabilityIssues.length, 1)
  assert.equal(result.step7AvailabilityIssues[0].severity, 'ERROR')
})

test('Timeline更新により同じScheduleBoundaryから導出するPA実時間が変わる', () => {
  const before = resolvePaAssignmentInterval(createItem(), calculatedItems)
  const movedItems = calculatedItems.map((item) => ({
    ...item,
    plannedStartMinute: item.plannedStartMinute + 30,
    plannedEndMinute: item.plannedEndMinute + 30,
  }))
  const after = resolvePaAssignmentInterval(createItem(), movedItems)

  assert.deepEqual(before, {
    ok: true,
    interval: { fromMinute: 600, untilMinute: 620 },
  })
  assert.deepEqual(after, {
    ok: true,
    interval: { fromMinute: 630, untilMinute: 650 },
  })
})

test('PA担当中の本人出演を同一EventDayの別StageでもERRORにする', () => {
  const issues = detect({
    paAssignments: [assignment('pa-1', { memberId: 'member-both' })],
  })

  const overlaps = findIssues(issues, 'PA_MEMBER_PERFORMANCE_OVERLAP')
  assert.equal(overlaps.length, 1)
  assert.equal(overlaps[0].severity, 'ERROR')
  assert.deepEqual(overlaps[0].scheduleItemIds, ['performance-b'])
})

test('PA終了境界ちょうどから始まる本人出演はoverlapにしない', () => {
  const items = calculatedItems.map((item) => item.scheduleItemId === 'performance-b'
    ? { ...item, plannedStartMinute: 620, plannedEndMinute: 630 }
    : item)
  const issues = detect({
    paAssignments: [assignment('pa-1', { memberId: 'member-both' })],
    items,
  })

  assert.equal(findIssues(issues, 'PA_MEMBER_PERFORMANCE_OVERLAP').length, 0)
})

test('同じMemberのPA AssignmentはroleやStageが違っても重複時だけERRORにする', () => {
  const overlapping = detect({
    paAssignments: [
      assignment('pa-main'),
      assignment('pa-sub', {
        stageId: 'stage-b',
        role: 'sub',
        from: { scheduleItemId: 'performance-b', edge: 'start' },
        until: { scheduleItemId: 'performance-b', edge: 'end' },
      }),
    ],
  })
  const touchingItems = calculatedItems.map((item) =>
    item.scheduleItemId === 'performance-b'
      ? { ...item, plannedStartMinute: 620, plannedEndMinute: 630 }
      : item,
  )
  const touching = detect({
    paAssignments: [
      assignment('pa-main'),
      assignment('pa-sub', {
        stageId: 'stage-b',
        role: 'sub',
        from: { scheduleItemId: 'performance-b', edge: 'start' },
        until: { scheduleItemId: 'performance-b', edge: 'end' },
      }),
    ],
    items: touchingItems,
  })

  assert.equal(findIssues(overlapping, 'PA_ASSIGNMENT_OVERLAP').length, 1)
  assert.equal(findIssues(touching, 'PA_ASSIGNMENT_OVERLAP').length, 0)
})

test('PA availability外とundecidedをそれぞれERROR・INFOで返す', () => {
  const outside = detect({
    paAssignments: [assignment('pa-1')],
    configuredMemberDays: createMemberDays({
      'member-main': {
        availabilityWindows: [{ from: '11:00' }],
      },
    }),
  })
  const undecided = detect({
    paAssignments: [assignment('pa-1')],
    configuredMemberDays: createMemberDays({
      'member-main': { participationStatus: 'undecided' },
    }),
  })

  assert.equal(findIssues(outside, 'PA_OUTSIDE_MEMBER_AVAILABILITY')[0].severity, 'ERROR')
  assert.equal(findIssues(undecided, 'PA_MEMBER_UNDECIDED')[0].severity, 'INFO')
})

test('PA担当のcapability不足・absent・日別設定不足をIssueとして検出する', () => {
  const capability = detect({
    paAssignments: [assignment('pa-capability', { memberId: 'member-none' })],
  })
  const absent = detect({
    paAssignments: [assignment('pa-absent')],
    configuredMemberDays: createMemberDays({
      'member-main': { participationStatus: 'absent' },
    }),
  })
  const missing = detect({
    paAssignments: [assignment('pa-missing')],
    configuredMemberDays: createMemberDays().filter((day) =>
      day.eventMemberId !== 'event-member-member-main',
    ),
  })

  assert.equal(findIssues(capability, 'PA_CAPABILITY_MISMATCH')[0].severity, 'ERROR')
  assert.equal(findIssues(absent, 'PA_MEMBER_ABSENT')[0].severity, 'ERROR')
  assert.equal(findIssues(missing, 'PA_MEMBER_NOT_CONFIGURED')[0].severity, 'ERROR')
})

test('Boundary参照先がなくなってもAssignmentを消さずPA_INVALID_BOUNDARYを返す', () => {
  const issues = detect({
    paAssignments: [assignment('pa-broken', {
      from: { scheduleItemId: 'removed-item', edge: 'start' },
    })],
  })

  const invalid = findIssues(issues, 'PA_INVALID_BOUNDARY')
  assert.equal(invalid.length, 1)
  assert.deepEqual(invalid[0].paAssignmentIds, ['pa-broken'])
})

test('PA draftの追加・編集・削除を保存し、別EventのAssignmentを維持する', () => {
  const existing = assignment('pa-existing')
  const removed = assignment('pa-removed', {
    memberId: 'member-sub',
    role: 'sub',
    from: { scheduleItemId: 'break-a', edge: 'start' },
    until: { scheduleItemId: 'break-a', edge: 'end' },
  })
  const otherEvent = assignment('pa-other', { eventId: 'event-other' })
  const draft = createPaAssignmentsDraft(event, [existing, removed, otherEvent])
  draft.items = draft.items.filter((item) =>
    item.paAssignmentId !== removed.id,
  )
  const existingDraft = draft.items.find((item) =>
    item.paAssignmentId === existing.id,
  )
  assert.ok(existingDraft)
  existingDraft.until = { scheduleItemId: 'performance-a', edge: 'end' }
  draft.items.push({
    ...createItem({ draftId: 'draft-new', memberId: 'member-sub', role: 'sub' }),
    from: { scheduleItemId: 'break-a', edge: 'start' },
    until: { scheduleItemId: 'break-a', edge: 'end' },
  })
  const result = createPaAssignmentsUpdate({
    event,
    eventDays,
    stages,
    members,
    eventMembers,
    eventMemberDays: createMemberDays(),
    eventBands,
    calculatedItems,
    paAssignments: [existing, removed, otherEvent],
    draft,
    newPaAssignmentIds: ['pa-new'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  const updatedExisting = result.paAssignments.find((item) =>
    item.id === existing.id,
  )
  assert.deepEqual(updatedExisting?.until, {
    scheduleItemId: 'performance-a',
    edge: 'end',
  })
  assert.ok(result.paAssignments.some((item) => item.id === 'pa-new'))
  assert.equal(result.paAssignments.some((item) => item.id === removed.id), false)
  assert.deepEqual(
    result.paAssignments.find((item) => item.id === otherEvent.id),
    otherEvent,
  )
})
