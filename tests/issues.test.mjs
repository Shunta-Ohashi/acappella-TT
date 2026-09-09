import test from 'node:test'
import assert from 'node:assert/strict'

import { detectScheduleIssues } from '../src/domain/issues.ts'

const eventDays = [
  {
    id: 'event-day-1',
    eventId: 'event-1',
    date: '2027-11-06',
    order: 0,
  },
  {
    id: 'event-day-2',
    eventId: 'event-1',
    date: '2027-11-07',
    order: 1,
  },
]

const createEvent = (policy = {}) => ({
  id: 'event-1',
  name: 'テストイベント',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 0,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 0,
    ...policy,
  },
})

const createEventMember = (memberId, overrides = {}) => ({
  id: `event-member-${memberId}`,
  eventId: 'event-1',
  memberId,
  ...overrides,
})

const createEventMemberDay = (
  eventMemberId,
  eventDayId = eventDays[0].id,
  overrides = {},
) => ({
  id: `event-member-day-${eventMemberId}-${eventDayId}`,
  eventMemberId,
  eventDayId,
  participationStatus: 'participating',
  ...overrides,
})

const createEventBand = (id, memberIds, overrides = {}) => ({
  id,
  eventId: 'event-1',
  eventDayId: eventDays[0].id,
  bandId: `band-${id}`,
  memberIds,
  durationMinutes: 10,
  ...overrides,
})

const performance = (
  id,
  eventBandId,
  start,
  end,
  stageId = 'stage-a',
  eventDayId = eventDays[0].id,
) => ({
  scheduleItemId: id,
  eventDayId,
  stageId,
  kind: 'performance',
  plannedStartMinute: start,
  plannedEndMinute: end,
  eventBandId,
})

const breakItem = (
  id,
  start,
  end,
  stageId = 'stage-a',
  eventDayId = eventDays[0].id,
) => ({
  scheduleItemId: id,
  eventDayId,
  stageId,
  kind: 'break',
  plannedStartMinute: start,
  plannedEndMinute: end,
})

const detect = (options = {}) => {
  const event = options.event ?? createEvent()
  const eventMembers = options.eventMembers ?? [createEventMember('member-1')]
  const eventBands = options.eventBands ?? [
    createEventBand('event-band-1', ['member-1']),
  ]
  const calculatedItems = options.calculatedItems ?? [
    performance('item-1', 'event-band-1', 600, 610),
  ]
  const scheduledEventDayIds = [
    ...new Set(calculatedItems.map((item) => item.eventDayId)),
  ]
  const eventMemberDays = options.eventMemberDays ?? eventMembers.flatMap(
    (eventMember) => scheduledEventDayIds.map((eventDayId) =>
      createEventMemberDay(eventMember.id, eventDayId),
    ),
  )

  return detectScheduleIssues({
    event,
    eventMembers,
    eventMemberDays,
    eventBands,
    calculatedItems,
  })
}

const findIssues = (issues, code) =>
  issues.filter((issue) => issue.code === code)

test('問題のないタイムテーブルではIssueを返さない', () => {
  assert.deepEqual(detect(), [])
})

test('同一Stageの出演時間重複を検出し、SHORT_RESTは重複表示しない', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 30 }),
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance('item-1', 'event-band-1', 600, 615),
      performance('item-2', 'event-band-2', 610, 620),
    ],
  })

  const overlaps = findIssues(issues, 'PERFORMANCE_OVERLAP')
  assert.equal(overlaps.length, 1)
  assert.equal(overlaps[0].severity, 'ERROR')
  assert.deepEqual(overlaps[0].scheduleItemIds, ['item-1', 'item-2'])
  assert.equal(findIssues(issues, 'SHORT_REST').length, 0)
})

test('同じEventDayの別Stage間の出演時間重複を検出する', () => {
  const issues = detect({
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance(
        'item-1',
        'event-band-1',
        600,
        610,
        'stage-a',
        eventDays[0].id,
      ),
      performance(
        'item-2',
        'event-band-2',
        605,
        615,
        'stage-b',
        eventDays[0].id,
      ),
    ],
  })

  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 1)
})

test('異なるEventDayの同時刻出演は重複や短休憩として扱わない', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 30 }),
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-1',
        'event-band-1',
        600,
        610,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'item-2',
        'event-band-2',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 0)
  assert.equal(findIssues(issues, 'SHORT_REST').length, 0)
})

test('同じBandの別日EventBandを独立した出演として扱う', () => {
  const sharedBandId = 'band-choir'
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 30 }),
    eventBands: [
      createEventBand('choir-day-1', ['member-1'], {
        bandId: sharedBandId,
        eventDayId: eventDays[0].id,
      }),
      createEventBand('choir-day-2', ['member-1'], {
        bandId: sharedBandId,
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'choir-item-day-1',
        'choir-day-1',
        600,
        610,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'choir-item-day-2',
        'choir-day-2',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  assert.equal(findIssues(issues, 'EVENT_BAND_DAY_MISMATCH').length, 0)
  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 0)
  assert.equal(findIssues(issues, 'SHORT_REST').length, 0)
})

test('EventBandを同じEventDayのStageへ配置しても日付不一致にしない', () => {
  const issues = detect()

  assert.equal(findIssues(issues, 'EVENT_BAND_DAY_MISMATCH').length, 0)
})

test('EventBandを異なるEventDayのStageへ配置すると日付不一致を検出する', () => {
  const issues = detect({
    eventBands: [
      createEventBand('event-band-day-1', ['member-1'], {
        eventDayId: eventDays[0].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-day-2',
        'event-band-day-1',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  const mismatches = findIssues(issues, 'EVENT_BAND_DAY_MISMATCH')
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].severity, 'ERROR')
  assert.deepEqual(mismatches[0].eventBandIds, ['event-band-day-1'])
  assert.deepEqual(mismatches[0].scheduleItemIds, ['item-day-2'])
})

test('翌日の早い時刻を前日の出演と比較しない', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 600 }),
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-1',
        'event-band-1',
        1020,
        1030,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'item-2',
        'event-band-2',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 0)
  assert.equal(findIssues(issues, 'SHORT_REST').length, 0)
})

test('同一Stageの連続出演を検出し、間のBreakはgapBandsに数えない', () => {
  const issues = detect({
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance('item-1', 'event-band-1', 600, 610),
      breakItem('break-1', 610, 620),
      performance('item-2', 'event-band-2', 620, 630),
    ],
  })

  const backToBack = findIssues(issues, 'BACK_TO_BACK')
  assert.equal(backToBack.length, 1)
  assert.equal(backToBack[0].severity, 'WARNING')
  assert.equal(backToBack[0].gapBands, 0)
  assert.equal(findIssues(issues, 'SHORT_GAP').length, 0)
})

test('gapBands = 1 がminimumGapBands未満ならSHORT_GAPを返す', () => {
  const issues = detect({
    event: createEvent({ minimumGapBands: 2 }),
    eventMembers: [
      createEventMember('member-1'),
      createEventMember('member-2'),
    ],
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-middle', ['member-2']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance('item-1', 'event-band-1', 600, 610),
      performance('item-middle', 'event-band-middle', 610, 620),
      performance('item-2', 'event-band-2', 620, 630),
    ],
  })

  const shortGaps = findIssues(issues, 'SHORT_GAP')
  assert.equal(shortGaps.length, 1)
  assert.equal(shortGaps[0].gapBands, 1)
  assert.equal(findIssues(issues, 'BACK_TO_BACK').length, 0)
})

test('gapBandsがminimumGapBands以上なら間隔Issueを返さない', () => {
  const issues = detect({
    event: createEvent({ minimumGapBands: 2 }),
    eventMembers: [
      createEventMember('member-1'),
      createEventMember('member-2'),
      createEventMember('member-3'),
    ],
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-middle-1', ['member-2']),
      createEventBand('event-band-middle-2', ['member-3']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance('item-1', 'event-band-1', 600, 610),
      performance('item-middle-1', 'event-band-middle-1', 610, 620),
      performance('item-middle-2', 'event-band-middle-2', 620, 630),
      performance('item-2', 'event-band-2', 630, 640),
    ],
  })

  assert.equal(findIssues(issues, 'BACK_TO_BACK').length, 0)
  assert.equal(findIssues(issues, 'SHORT_GAP').length, 0)
})

test('同じEventDayの全Stage横断でminimumRestMinutes未満を検出する', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 5 }),
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance(
        'item-1',
        'event-band-1',
        600,
        610,
        'stage-a',
        eventDays[0].id,
      ),
      performance(
        'item-2',
        'event-band-2',
        613,
        623,
        'stage-b',
        eventDays[0].id,
      ),
    ],
  })

  const shortRests = findIssues(issues, 'SHORT_REST')
  assert.equal(shortRests.length, 1)
  assert.equal(shortRests[0].restMinutes, 3)
  assert.deepEqual(shortRests[0].eventBandIds, [
    'event-band-1',
    'event-band-2',
  ])
  assert.deepEqual(shortRests[0].scheduleItemIds, ['item-1', 'item-2'])
  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 0)
})

test('入れ子状の重複後は最も遅く終了する出演からrestMinutesを計算する', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 10 }),
    eventBands: [
      createEventBand('event-band-a', ['member-1']),
      createEventBand('event-band-b', ['member-1']),
      createEventBand('event-band-c', ['member-1']),
    ],
    calculatedItems: [
      performance('item-a', 'event-band-a', 600, 630, 'stage-a'),
      performance('item-b', 'event-band-b', 605, 610, 'stage-b'),
      performance('item-c', 'event-band-c', 635, 645, 'stage-c'),
    ],
  })

  const overlaps = findIssues(issues, 'PERFORMANCE_OVERLAP')
  assert.equal(overlaps.length, 1)
  assert.deepEqual(overlaps[0].scheduleItemIds, ['item-a', 'item-b'])

  const shortRests = findIssues(issues, 'SHORT_REST')
  assert.equal(shortRests.length, 1)
  assert.equal(shortRests[0].restMinutes, 5)
  assert.deepEqual(shortRests[0].eventBandIds, [
    'event-band-a',
    'event-band-c',
  ])
  assert.deepEqual(shortRests[0].scheduleItemIds, ['item-a', 'item-c'])
})

test('入れ子状の重複後でも次の出演まで十分な時間があればSHORT_RESTにしない', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 10 }),
    eventBands: [
      createEventBand('event-band-a', ['member-1']),
      createEventBand('event-band-b', ['member-1']),
      createEventBand('event-band-c', ['member-1']),
    ],
    calculatedItems: [
      performance('item-a', 'event-band-a', 600, 630, 'stage-a'),
      performance('item-b', 'event-band-b', 605, 610, 'stage-b'),
      performance('item-c', 'event-band-c', 640, 650, 'stage-c'),
    ],
  })

  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 1)
  assert.equal(findIssues(issues, 'SHORT_REST').length, 0)
})

test('EventMember未登録を検出し、重複memberIdから同じIssueを重複生成しない', () => {
  const issues = detect({
    eventMembers: [],
    eventBands: [
      createEventBand('event-band-1', ['member-1', 'member-1']),
    ],
  })

  const missingMembers = findIssues(
    issues,
    'MEMBER_NOT_REGISTERED_FOR_EVENT',
  )
  assert.equal(missingMembers.length, 1)
  assert.equal(missingMembers[0].severity, 'ERROR')
})

test('EventMemberは存在するが該当EventDayの設定がなければERRORにする', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [],
  })

  const missingMemberDays = findIssues(issues, 'MEMBER_DAY_NOT_CONFIGURED')
  assert.equal(missingMemberDays.length, 1)
  assert.equal(missingMemberDays[0].severity, 'ERROR')
  assert.deepEqual(missingMemberDays[0].scheduleItemIds, ['item-1'])
})

test('absentメンバーの出演を検出する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        participationStatus: 'absent',
      }),
    ],
  })

  assert.equal(findIssues(issues, 'MEMBER_ABSENT').length, 1)
})

test('参加状態は出演するEventDayのEventMemberDayだけを参照する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id),
      createEventMemberDay(eventMember.id, eventDays[1].id, {
        participationStatus: 'absent',
      }),
    ],
    eventBands: [
      createEventBand('event-band-day-1', ['member-1']),
      createEventBand('event-band-day-2', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-day-1',
        'event-band-day-1',
        600,
        610,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'item-day-2',
        'event-band-day-2',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  const absentIssues = findIssues(issues, 'MEMBER_ABSENT')
  assert.equal(absentIssues.length, 1)
  assert.deepEqual(absentIssues[0].scheduleItemIds, ['item-day-2'])
})

test('undecidedは該当EventDayの出演だけINFOにする', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id),
      createEventMemberDay(eventMember.id, eventDays[1].id, {
        participationStatus: 'undecided',
      }),
    ],
    eventBands: [
      createEventBand('event-band-day-1', ['member-1']),
      createEventBand('event-band-day-2', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-day-1',
        'event-band-day-1',
        600,
        610,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'item-day-2',
        'event-band-day-2',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  const undecidedIssues = findIssues(
    issues,
    'MEMBER_PARTICIPATION_UNDECIDED',
  )
  assert.equal(undecidedIssues.length, 1)
  assert.equal(undecidedIssues[0].severity, 'INFO')
  assert.deepEqual(undecidedIssues[0].scheduleItemIds, ['item-day-2'])
})

test('EventMemberDayの開始時刻より前の出演を検出する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        availabilityWindows: [{ from: '10:05' }],
      }),
    ],
  })

  assert.equal(findIssues(issues, 'OUTSIDE_MEMBER_AVAILABILITY').length, 1)
})

test('EventMemberDayの終了時刻を超える出演を検出する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        availabilityWindows: [{ until: '10:05' }],
      }),
    ],
  })

  assert.equal(findIssues(issues, 'OUTSIDE_MEMBER_AVAILABILITY').length, 1)
})

test('EventDayごとに異なるavailabilityWindowsを参照する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id),
      createEventMemberDay(eventMember.id, eventDays[1].id, {
        availabilityWindows: [
          { until: '15:00' },
          { from: '16:00' },
        ],
      }),
    ],
    eventBands: [
      createEventBand('event-band-day-1', ['member-1']),
      createEventBand('event-band-before-15', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
      createEventBand('event-band-unavailable', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
      createEventBand('event-band-after-16', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-day-1',
        'event-band-day-1',
        930,
        940,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'item-before-15',
        'event-band-before-15',
        890,
        900,
        'stage-day-2-a',
        eventDays[1].id,
      ),
      performance(
        'item-unavailable',
        'event-band-unavailable',
        900,
        910,
        'stage-day-2-b',
        eventDays[1].id,
      ),
      performance(
        'item-after-16',
        'event-band-after-16',
        960,
        970,
        'stage-day-2-c',
        eventDays[1].id,
      ),
    ],
  })

  const availabilityIssues = findIssues(
    issues,
    'OUTSIDE_MEMBER_AVAILABILITY',
  )
  assert.equal(availabilityIssues.length, 1)
  assert.deepEqual(availabilityIssues[0].scheduleItemIds, ['item-unavailable'])
})

test('複数availabilityWindowのいずれかに全体が含まれれば出演可能にする', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        availabilityWindows: [
          { from: '10:00', until: '12:00' },
          { from: '15:00', until: '17:00' },
        ],
      }),
    ],
    eventBands: [
      createEventBand('event-band-morning', ['member-1']),
      createEventBand('event-band-outside', ['member-1']),
      createEventBand('event-band-afternoon', ['member-1']),
    ],
    calculatedItems: [
      performance('item-morning', 'event-band-morning', 630, 640, 'stage-a'),
      performance('item-outside', 'event-band-outside', 780, 790, 'stage-b'),
      performance(
        'item-afternoon',
        'event-band-afternoon',
        930,
        940,
        'stage-c',
      ),
    ],
  })

  const availabilityIssues = findIssues(
    issues,
    'OUTSIDE_MEMBER_AVAILABILITY',
  )
  assert.equal(availabilityIssues.length, 1)
  assert.deepEqual(availabilityIssues[0].scheduleItemIds, ['item-outside'])
})

test('出演が複数availabilityWindowをまたぐ場合はERRORにする', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        availabilityWindows: [
          { until: '15:00' },
          { from: '16:00' },
        ],
      }),
    ],
    calculatedItems: [
      performance('item-spanning', 'event-band-1', 890, 970),
    ],
  })

  assert.deepEqual(
    findIssues(issues, 'OUTSIDE_MEMBER_AVAILABILITY')[0].scheduleItemIds,
    ['item-spanning'],
  )
})

test('片側だけ指定したavailabilityWindowと半開区間の境界を判定する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        availabilityWindows: [{ from: '13:00' }],
      }),
      createEventMemberDay(eventMember.id, eventDays[1].id, {
        availabilityWindows: [{ until: '17:30' }],
      }),
    ],
    eventBands: [
      createEventBand('event-band-before-from', ['member-1']),
      createEventBand('event-band-at-from', ['member-1']),
      createEventBand('event-band-until', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
      createEventBand('event-band-at-until', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-before-from',
        'event-band-before-from',
        770,
        780,
        'stage-day-1-a',
        eventDays[0].id,
      ),
      performance(
        'item-at-from',
        'event-band-at-from',
        780,
        790,
        'stage-day-1-b',
        eventDays[0].id,
      ),
      performance(
        'item-until',
        'event-band-until',
        1040,
        1050,
        'stage-day-2-a',
        eventDays[1].id,
      ),
      performance(
        'item-at-until',
        'event-band-at-until',
        1050,
        1060,
        'stage-day-2-b',
        eventDays[1].id,
      ),
    ],
  })

  const availabilityIssueItemIds = findIssues(
    issues,
    'OUTSIDE_MEMBER_AVAILABILITY',
  ).flatMap((issue) => issue.scheduleItemIds ?? [])
  assert.deepEqual(availabilityIssueItemIds, [
    'item-before-from',
    'item-at-until',
  ])
})

test('空のavailabilityWindowsは出演可能時間なしとして扱う', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        availabilityWindows: [],
      }),
    ],
  })

  assert.equal(findIssues(issues, 'OUTSIDE_MEMBER_AVAILABILITY').length, 1)
})

test('EventBand.availableTimeRangeを所属EventDay内の予定時刻で判定する', () => {
  const issues = detect({
    eventBands: [
      createEventBand('event-band-1', ['member-1'], {
        eventDayId: eventDays[1].id,
        availableTimeRange: { from: '10:05', until: '11:00' },
      }),
    ],
    calculatedItems: [
      performance(
        'item-day-2',
        'event-band-1',
        600,
        610,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  const outsideBandAvailability = findIssues(
    issues,
    'OUTSIDE_BAND_AVAILABILITY',
  )
  assert.equal(outsideBandAvailability.length, 1)
  assert.equal(outsideBandAvailability[0].severity, 'ERROR')
  assert.equal(findIssues(issues, 'EVENT_BAND_DAY_MISMATCH').length, 0)
})

test('個人のpreferredTimeRangeは出演するEventDayの設定だけを参照する', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        preferredTimeRange: { from: '10:00', until: '11:00' },
      }),
      createEventMemberDay(eventMember.id, eventDays[1].id, {
        preferredTimeRange: { from: '12:00', until: '13:00' },
      }),
    ],
    eventBands: [
      createEventBand('event-band-day-1', ['member-1']),
      createEventBand('event-band-day-2', ['member-1'], {
        eventDayId: eventDays[1].id,
      }),
    ],
    calculatedItems: [
      performance(
        'item-day-1',
        'event-band-day-1',
        630,
        640,
        'stage-day-1',
        eventDays[0].id,
      ),
      performance(
        'item-day-2',
        'event-band-day-2',
        630,
        640,
        'stage-day-2',
        eventDays[1].id,
      ),
    ],
  })

  const preferenceIssues = findIssues(issues, 'PREFERENCE_NOT_MET')
  assert.equal(preferenceIssues.length, 1)
  assert.deepEqual(preferenceIssues[0].scheduleItemIds, ['item-day-2'])
})

test('EventMemberDayの個人希望とEventBandの希望時間外をINFOにする', () => {
  const eventMember = createEventMember('member-1')
  const issues = detect({
    eventMembers: [eventMember],
    eventMemberDays: [
      createEventMemberDay(eventMember.id, eventDays[0].id, {
        preferredTimeRange: { from: '11:00', until: '12:00' },
      }),
    ],
    eventBands: [
      createEventBand('event-band-1', ['member-1'], {
        preferredTimeRange: { from: '11:00', until: '12:00' },
      }),
    ],
  })

  const preferenceIssues = findIssues(issues, 'PREFERENCE_NOT_MET')
  assert.equal(preferenceIssues.length, 2)
  assert.ok(preferenceIssues.every((issue) => issue.severity === 'INFO'))
})
