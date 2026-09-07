import test from 'node:test'
import assert from 'node:assert/strict'

import { detectScheduleIssues } from '../src/domain/issues.ts'

const createEvent = (policy = {}) => ({
  id: 'event-1',
  name: 'テストイベント',
  date: '2026-09-08',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 0,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 0,
    ...policy,
  },
})

const createEventMember = (memberId, overrides = {}) => ({
  eventId: 'event-1',
  memberId,
  participationStatus: 'participating',
  ...overrides,
})

const createEventBand = (id, memberIds, overrides = {}) => ({
  id,
  eventId: 'event-1',
  bandId: `band-${id}`,
  memberIds,
  durationMinutes: 10,
  ...overrides,
})

const performance = (id, eventBandId, start, end, stageId = 'stage-a') => ({
  scheduleItemId: id,
  stageId,
  kind: 'performance',
  plannedStartMinute: start,
  plannedEndMinute: end,
  eventBandId,
})

const breakItem = (id, start, end, stageId = 'stage-a') => ({
  scheduleItemId: id,
  stageId,
  kind: 'break',
  plannedStartMinute: start,
  plannedEndMinute: end,
})

const detect = ({
  event = createEvent(),
  eventMembers = [createEventMember('member-1')],
  eventBands = [createEventBand('event-band-1', ['member-1'])],
  calculatedItems = [performance('item-1', 'event-band-1', 600, 610)],
} = {}) =>
  detectScheduleIssues({ event, eventMembers, eventBands, calculatedItems })

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

test('別Stage間の出演時間重複を検出する', () => {
  const issues = detect({
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance('item-1', 'event-band-1', 600, 610, 'stage-a'),
      performance('item-2', 'event-band-2', 605, 615, 'stage-b'),
    ],
  })

  assert.equal(findIssues(issues, 'PERFORMANCE_OVERLAP').length, 1)
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

test('全Stage横断でrestMinutesを計算してminimumRestMinutes未満を検出する', () => {
  const issues = detect({
    event: createEvent({ minimumRestMinutes: 5 }),
    eventBands: [
      createEventBand('event-band-1', ['member-1']),
      createEventBand('event-band-2', ['member-1']),
    ],
    calculatedItems: [
      performance('item-1', 'event-band-1', 600, 610, 'stage-a'),
      performance('item-2', 'event-band-2', 612, 622, 'stage-b'),
    ],
  })

  const shortRests = findIssues(issues, 'SHORT_REST')
  assert.equal(shortRests.length, 1)
  assert.equal(shortRests[0].restMinutes, 2)
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

test('absentメンバーの出演を検出する', () => {
  const issues = detect({
    eventMembers: [
      createEventMember('member-1', { participationStatus: 'absent' }),
    ],
  })

  assert.equal(findIssues(issues, 'MEMBER_ABSENT').length, 1)
})

test('EventMember.availableFromより前の出演を検出する', () => {
  const issues = detect({
    eventMembers: [createEventMember('member-1', { availableFrom: '10:05' })],
  })

  assert.equal(findIssues(issues, 'OUTSIDE_MEMBER_AVAILABILITY').length, 1)
})

test('EventMember.availableUntilを終了時刻が超える出演を検出する', () => {
  const issues = detect({
    eventMembers: [
      createEventMember('member-1', { availableUntil: '10:05' }),
    ],
  })

  assert.equal(findIssues(issues, 'OUTSIDE_MEMBER_AVAILABILITY').length, 1)
})

test('EventBand.availableTimeRange外の出演を検出する', () => {
  const issues = detect({
    eventBands: [
      createEventBand('event-band-1', ['member-1'], {
        availableTimeRange: { from: '10:05', until: '11:00' },
      }),
    ],
  })

  const outsideBandAvailability = findIssues(
    issues,
    'OUTSIDE_BAND_AVAILABILITY',
  )
  assert.equal(outsideBandAvailability.length, 1)
  assert.equal(outsideBandAvailability[0].severity, 'ERROR')
})

test('undecidedはINFOとして扱い、希望時間外もINFOとして検出する', () => {
  const issues = detect({
    eventMembers: [
      createEventMember('member-1', {
        participationStatus: 'undecided',
        preferredTimeRange: { from: '11:00', until: '12:00' },
      }),
    ],
    eventBands: [
      createEventBand('event-band-1', ['member-1'], {
        preferredTimeRange: { from: '11:00', until: '12:00' },
      }),
    ],
  })

  assert.equal(
    findIssues(issues, 'MEMBER_PARTICIPATION_UNDECIDED')[0].severity,
    'INFO',
  )
  const preferenceIssues = findIssues(issues, 'PREFERENCE_NOT_MET')
  assert.equal(preferenceIssues.length, 2)
  assert.ok(preferenceIssues.every((issue) => issue.severity === 'INFO'))
})
