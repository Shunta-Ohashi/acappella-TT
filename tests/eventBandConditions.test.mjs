import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEventBandConditionsDraft,
  createEventBandConditionsUpdate,
  getEventBandConditionDraftSummary,
  getEventBandConditionFeasibility,
  validateEventBandConditionItem,
} from '../src/domain/eventBandConditions.ts'

const event = {
  id: 'event-1',
  name: '学園祭',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
  performanceSlotMinutes: [5, 10, 15],
}

const eventDays = [
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
  { id: 'day-2', eventId: event.id, date: '2027-11-07', order: 1 },
]

const stages = [
  {
    id: 'stage-1',
    eventDayId: 'day-1',
    name: 'メインStage',
    order: 0,
    plannedStartTime: '10:00',
  },
  {
    id: 'stage-2',
    eventDayId: 'day-1',
    name: 'SectionなしStage',
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

const sections = [
  { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
  { id: 'section-day-2', stageId: 'stage-day-2', name: '翌日1部', order: 0 },
]

const members = [
  { id: 'member-1', realName: '佐藤', active: true },
  { id: 'member-2', realName: '鈴木', active: true },
]

const eventMembers = members.map((member, index) => ({
  id: `event-member-${index + 1}`,
  eventId: event.id,
  memberId: member.id,
}))

const participatingDays = [
  {
    id: 'member-day-1',
    eventMemberId: 'event-member-1',
    eventDayId: 'day-1',
    participationStatus: 'participating',
    availabilityWindows: [{ from: '13:00', until: '16:00' }],
  },
  {
    id: 'member-day-2',
    eventMemberId: 'event-member-2',
    eventDayId: 'day-1',
    participationStatus: 'participating',
  },
]

const createEventBand = (overrides = {}) => ({
  id: 'event-band-1',
  eventId: event.id,
  eventDayId: 'day-1',
  name: 'Choir',
  memberIds: ['member-1', 'member-2'],
  durationMinutes: 10,
  notes: '出演情報は維持',
  ...overrides,
})

const createItem = (overrides = {}) => ({
  eventBandId: 'event-band-1',
  eventDayId: 'day-1',
  availableTimeRange: { from: '', until: '' },
  preferredTimeRange: { from: '', until: '' },
  fixedPlacement: {
    stageId: '',
    sectionId: '',
    positionMode: 'none',
    plannedStartTime: '',
  },
  ...overrides,
})

const validate = ({
  item = createItem(),
  eventBand = createEventBand(),
  eventMemberDays = participatingDays,
  configuredStages = stages,
  configuredSections = sections,
} = {}) => validateEventBandConditionItem({
  item,
  event,
  eventDays,
  eventBands: [eventBand],
  stages: configuredStages,
  sections: configuredSections,
  members,
  eventMembers,
  eventMemberDays,
})

const feasibility = ({
  item = createItem(),
  eventBand = createEventBand(),
  eventMemberDays = participatingDays,
} = {}) => getEventBandConditionFeasibility({
  event,
  item,
  eventBand,
  members,
  eventMembers,
  eventMemberDays,
})

const update = ({
  item = createItem(),
  eventBands = [createEventBand()],
  eventMemberDays = participatingDays,
} = {}) => createEventBandConditionsUpdate({
  event,
  eventDays,
  eventBands,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
  draft: { items: [item] },
})

test('出演可能時間は未指定・片側開放・両側指定を保存できる', () => {
  const cases = [
    [{ from: '', until: '' }, undefined],
    [{ from: '13:00', until: '' }, { from: '13:00' }],
    [{ from: '', until: '17:30' }, { until: '17:30' }],
    [{ from: '13:00', until: '17:30' }, { from: '13:00', until: '17:30' }],
  ]

  for (const [availableTimeRange, expected] of cases) {
    const result = update({ item: createItem({ availableTimeRange }) })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.eventBands[0].availableTimeRange, expected)
    }
  }
})

test('出演可能時間の同時刻・逆転・不正時刻を拒否する', () => {
  for (const availableTimeRange of [
    { from: '13:00', until: '13:00' },
    { from: '17:00', until: '13:00' },
    { from: 'invalid', until: '' },
  ]) {
    assert.ok(validate({ item: createItem({ availableTimeRange }) }).availableTimeRange)
  }
})

test('Member共通availabilityとHard条件の積集合へ出演時間を確保できる場合だけ保存できる', () => {
  const withoutBandConstraint = feasibility()
  assert.deepEqual(withoutBandConstraint.memberAvailabilityWindows, [
    { from: '13:00', until: '16:00' },
  ])
  assert.deepEqual(withoutBandConstraint.effectiveAvailabilityWindows, [
    { from: '13:00', until: '16:00' },
  ])

  const narrowed = feasibility({
    item: createItem({
      availableTimeRange: { from: '14:00', until: '16:00' },
    }),
  })
  assert.equal(narrowed.status, 'available')
  assert.deepEqual(narrowed.effectiveAvailabilityWindows, [
    { from: '14:00', until: '16:00' },
  ])

  const noIntersection = feasibility({
    item: createItem({
      availableTimeRange: { from: '16:00', until: '17:00' },
    }),
  })
  assert.equal(noIntersection.status, 'blocked')

  const exact = feasibility({
    item: createItem({
      availableTimeRange: { from: '15:50', until: '16:00' },
    }),
  })
  assert.equal(exact.status, 'available')

  const short = feasibility({
    item: createItem({
      availableTimeRange: { from: '15:51', until: '16:00' },
    }),
  })
  assert.equal(short.status, 'blocked')
})

test('複数のMember共通windowをBand条件で絞ったeffective availabilityを返す', () => {
  const configuredDays = [
    {
      id: 'member-day-multiple-1',
      eventMemberId: 'event-member-1',
      eventDayId: 'day-1',
      participationStatus: 'participating',
      availabilityWindows: [
        { from: '10:00', until: '12:00' },
        { from: '15:00', until: '18:00' },
      ],
    },
    {
      id: 'member-day-multiple-2',
      eventMemberId: 'event-member-2',
      eventDayId: 'day-1',
      participationStatus: 'participating',
      availabilityWindows: [
        { from: '10:00', until: '12:00' },
        { from: '15:00', until: '17:00' },
      ],
    },
  ]
  const result = feasibility({
    item: createItem({
      availableTimeRange: { from: '11:00', until: '16:00' },
    }),
    eventMemberDays: configuredDays,
  })

  assert.deepEqual(result.memberAvailabilityWindows, [
    { from: '10:00', until: '12:00' },
    { from: '15:00', until: '17:00' },
  ])
  assert.deepEqual(result.effectiveAvailabilityWindows, [
    { from: '11:00', until: '12:00' },
    { from: '15:00', until: '16:00' },
  ])
})

test('undecidedはwarningで保存可能、absentと日別設定不足はblockingになる', () => {
  const undecidedDays = participatingDays.map((day, index) => index === 0
    ? { ...day, participationStatus: 'undecided' }
    : day)
  const undecided = feasibility({ eventMemberDays: undecidedDays })
  assert.equal(undecided.status, 'warning')
  assert.match(undecided.warnings[0], /未定/)
  assert.deepEqual(undecided.effectiveAvailabilityWindows, [
    { from: '13:00', until: '16:00' },
  ])
  assert.equal(update({ eventMemberDays: undecidedDays }).ok, true)

  const absentDays = participatingDays.map((day, index) => index === 0
    ? { ...day, participationStatus: 'absent' }
    : day)
  assert.equal(feasibility({ eventMemberDays: absentDays }).status, 'blocked')
  assert.equal(update({ eventMemberDays: absentDays }).ok, false)

  assert.equal(feasibility({
    eventMemberDays: participatingDays.slice(0, 1),
  }).status, 'blocked')
})

test('希望時間は未指定・片側開放・両側指定を保存できる', () => {
  const cases = [
    [{ from: '', until: '' }, undefined],
    [{ from: '13:00', until: '' }, { from: '13:00' }],
    [{ from: '', until: '17:30' }, { until: '17:30' }],
    [{ from: '14:00', until: '15:00' }, { from: '14:00', until: '15:00' }],
  ]

  for (const [preferredTimeRange, expected] of cases) {
    const result = update({ item: createItem({ preferredTimeRange }) })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.eventBands[0].preferredTimeRange, expected)
    }
  }
})

test('希望時間とHard・Member availabilityが合わなくてもwarningのみで保存できる', () => {
  const item = createItem({
    availableTimeRange: { from: '13:00', until: '14:00' },
    preferredTimeRange: { from: '15:00', until: '16:00' },
  })
  const result = feasibility({ item })
  assert.equal(result.status, 'warning')
  assert.match(result.warnings.at(-1), /希望時間/)
  assert.equal(update({ item }).ok, true)
})

test('同日Stageと正しいSectionへの固定配置を許可する', () => {
  const item = createItem({
    fixedPlacement: {
      stageId: 'stage-1',
      sectionId: 'section-1',
      positionMode: 'last',
      plannedStartTime: '15:30',
    },
  })
  assert.equal(validate({ item }).fixedPlacement, undefined)
  const result = update({ item })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.eventBands[0].fixedPlacement, {
      stageId: 'stage-1',
      sectionId: 'section-1',
      position: { kind: 'last' },
      plannedStartTime: '15:30',
    })
  }
})

test('存在しないStage・別日Stage・別Stage Sectionを固定できない', () => {
  const placements = [
    { stageId: 'missing-stage', sectionId: '', positionMode: 'none', plannedStartTime: '' },
    { stageId: 'stage-day-2', sectionId: 'section-day-2', positionMode: 'none', plannedStartTime: '' },
    { stageId: 'stage-2', sectionId: 'section-1', positionMode: 'none', plannedStartTime: '' },
  ]
  for (const fixedPlacement of placements) {
    assert.ok(validate({ item: createItem({ fixedPlacement }) }).fixedPlacement)
  }
})

test('SectionありStageではSection指定を必須とし、SectionなしStageでは不要にする', () => {
  const missingSection = createItem({
    fixedPlacement: {
      stageId: 'stage-1',
      sectionId: '',
      positionMode: 'first',
      plannedStartTime: '',
    },
  })
  assert.ok(validate({ item: missingSection }).fixedPlacement)

  const withoutSections = createItem({
    fixedPlacement: {
      stageId: 'stage-2',
      sectionId: '',
      positionMode: 'first',
      plannedStartTime: '',
    },
  })
  assert.equal(validate({ item: withoutSections }).fixedPlacement, undefined)
})

test('Stage変更後に古いSectionを残すdraftを拒否し、固定開始時刻だけの設定も拒否する', () => {
  const staleSection = createItem({
    fixedPlacement: {
      stageId: 'stage-2',
      sectionId: 'section-1',
      positionMode: 'none',
      plannedStartTime: '',
    },
  })
  assert.ok(validate({ item: staleSection }).fixedPlacement)

  const startWithoutStage = createItem({
    fixedPlacement: {
      stageId: '',
      sectionId: '',
      positionMode: 'none',
      plannedStartTime: '15:30',
    },
  })
  assert.ok(validate({ item: startWithoutStage }).fixedPlacement)
})

test('固定配置を解除するとundefinedになり、既存index固定は編集で維持する', () => {
  const existing = createEventBand({
    fixedPlacement: {
      stageId: 'stage-2',
      position: { kind: 'index', index: 2 },
    },
  })
  const draft = createEventBandConditionsDraft(event, [existing])
  assert.equal(draft.items[0].fixedPlacement.positionMode, 'index')
  assert.equal(draft.items[0].fixedPlacement.positionIndex, 2)

  const preserved = update({ item: draft.items[0], eventBands: [existing] })
  assert.equal(preserved.ok, true)
  if (preserved.ok) {
    assert.deepEqual(preserved.eventBands[0].fixedPlacement, existing.fixedPlacement)
  }

  draft.items[0].fixedPlacement = {
    stageId: '',
    sectionId: '',
    positionMode: 'none',
    plannedStartTime: '',
  }
  const removed = update({ item: draft.items[0], eventBands: [existing] })
  assert.equal(removed.ok, true)
  if (removed.ok) assert.equal(removed.eventBands[0].fixedPlacement, undefined)
})

test('条件保存ではEventBandの出演情報を維持し、複数Bandを別々に更新する', () => {
  const first = createEventBand({ bandId: 'band-master-1' })
  const second = createEventBand({
    id: 'event-band-2',
    name: 'Quartet',
    memberIds: ['member-2'],
    durationMinutes: 5,
  })
  const draft = createEventBandConditionsDraft(event, [first, second])
  draft.items[0].availableTimeRange = { from: '14:00', until: '' }
  draft.items[1].preferredTimeRange = { from: '', until: '15:00' }
  const result = createEventBandConditionsUpdate({
    event,
    eventDays,
    eventBands: [first, second],
    stages,
    sections,
    members,
    eventMembers,
    eventMemberDays: participatingDays,
    draft,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(
    {
      id: result.eventBands[0].id,
      eventId: result.eventBands[0].eventId,
      eventDayId: result.eventBands[0].eventDayId,
      bandId: result.eventBands[0].bandId,
      name: result.eventBands[0].name,
      memberIds: result.eventBands[0].memberIds,
      durationMinutes: result.eventBands[0].durationMinutes,
      notes: result.eventBands[0].notes,
    },
    {
      id: first.id,
      eventId: first.eventId,
      eventDayId: first.eventDayId,
      bandId: first.bandId,
      name: first.name,
      memberIds: first.memberIds,
      durationMinutes: first.durationMinutes,
      notes: first.notes,
    },
  )
  assert.deepEqual(result.eventBands[0].availableTimeRange, { from: '14:00' })
  assert.deepEqual(result.eventBands[1].preferredTimeRange, { until: '15:00' })
})

test('条件要約は必須・希望・Stage・Section・位置・開始時刻を簡潔に表示する', () => {
  const eventBand = createEventBand()
  const item = createItem({
    availableTimeRange: { from: '13:00', until: '17:30' },
    preferredTimeRange: { from: '15:00', until: '' },
    fixedPlacement: {
      stageId: 'stage-1',
      sectionId: 'section-1',
      positionMode: 'last',
      plannedStartTime: '15:30',
    },
  })
  assert.deepEqual(getEventBandConditionDraftSummary(
    item,
    eventBand,
    stages,
    sections,
  ), {
    hard: '13:00〜17:30',
    preference: '15:00以降',
    fixedPlacement: 'メインStage / 1部 / 最後 / 15:30開始',
  })
})
