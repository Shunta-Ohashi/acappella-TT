import test from 'node:test'
import assert from 'node:assert/strict'

import { createTimetableWorkspaceRows } from '../src/ui/timetableWorkspaceRows.ts'

const members = [
  { id: 'member-1', realName: '山田 太郎', acaName: 'やまだ', active: true },
  { id: 'member-2', realName: '佐藤 花子', active: true },
]

const eventBands = [
  {
    id: 'event-band-1',
    eventId: 'event-1',
    eventDayId: 'day-1',
    bandId: 'band-1',
    name: 'Choir',
    memberIds: ['member-1', 'member-2'],
    durationMinutes: 10,
    availableTimeRange: { from: '10:00' },
    preferredTimeRange: { from: '10:00', until: '11:00' },
    fixedPlacement: {
      stageId: 'stage-1',
      sectionId: 'section-1',
      plannedStartTime: '10:00',
      position: { kind: 'first' },
    },
  },
  {
    id: 'event-band-2',
    eventId: 'event-1',
    eventDayId: 'day-1',
    name: '企画バンド',
    memberIds: ['member-2'],
    durationMinutes: 7,
  },
]

const scheduleItems = [
  {
    id: 'break-1',
    stageId: 'stage-1',
    sectionId: 'section-1',
    order: 2,
    kind: 'break',
    title: '休憩',
    durationMinutes: 10,
  },
  {
    id: 'performance-2',
    stageId: 'stage-1',
    sectionId: 'section-1',
    order: 1,
    kind: 'performance',
    eventBandId: 'event-band-2',
  },
  {
    id: 'performance-1',
    stageId: 'stage-1',
    sectionId: 'section-1',
    order: 0,
    kind: 'performance',
    eventBandId: 'event-band-1',
  },
]

const calculatedItems = [
  {
    scheduleItemId: 'performance-1',
    eventDayId: 'day-1',
    stageId: 'stage-1',
    sectionId: 'section-1',
    kind: 'performance',
    eventBandId: 'event-band-1',
    plannedStartMinute: 600,
    plannedEndMinute: 610,
  },
  {
    scheduleItemId: 'performance-2',
    eventDayId: 'day-1',
    stageId: 'stage-1',
    sectionId: 'section-1',
    kind: 'performance',
    eventBandId: 'event-band-2',
    plannedStartMinute: 612,
    plannedEndMinute: 619,
  },
  {
    scheduleItemId: 'break-1',
    eventDayId: 'day-1',
    stageId: 'stage-1',
    sectionId: 'section-1',
    kind: 'break',
    plannedStartMinute: 619,
    plannedEndMinute: 629,
  },
]

const createRows = (overrides = {}) => createTimetableWorkspaceRows({
  eventDayId: 'day-1',
  stageId: 'stage-1',
  scheduleItems,
  calculatedItems,
  eventBands,
  members,
  paAssignments: [],
  issues: [],
  ...overrides,
})

const assignment = ({ id, role, fromId, fromEdge = 'start', untilId, untilEdge = 'end' }) => ({
  id,
  eventId: 'event-1',
  eventDayId: 'day-1',
  stageId: 'stage-1',
  memberId: role === 'main' ? 'member-1' : 'member-2',
  role,
  from: { scheduleItemId: fromId, edge: fromEdge },
  until: { scheduleItemId: untilId, edge: untilEdge },
})

test('Timeline順にPerformance・Breakのrowを作り、出演枠へ転換時間を混ぜない', () => {
  const result = createRows()

  assert.deepEqual(
    result.rows.map((row) => row.scheduleItem.id),
    ['performance-1', 'performance-2', 'break-1'],
  )
  assert.deepEqual(
    result.rows.map((row) => [
      row.calculatedItem.plannedStartMinute,
      row.calculatedItem.plannedEndMinute,
    ]),
    [[600, 610], [612, 619], [619, 629]],
  )
  assert.equal(result.rows[0].eventBand.durationMinutes, 10)
  assert.equal(result.rows[0].calculatedItem.plannedEndMinute, 610)
  assert.equal(result.rows[2].scheduleItem.kind, 'break')
  assert.equal(result.rows[2].scheduleItem.durationMinutes, 10)
})

test('Section所属と実出演メンバー順、条件indicatorをrowへ引き継ぐ', () => {
  const { rows } = createRows()

  assert.equal(rows[0].scheduleItem.sectionId, 'section-1')
  assert.deepEqual(rows[0].memberNames, ['やまだ', '佐藤 花子'])
  assert.equal(rows[0].hasHardTimeCondition, true)
  assert.equal(rows[0].hasPreferredTimeCondition, true)
  assert.deepEqual(rows[0].fixedPlacementLabels, [
    'Stage固定',
    'Section固定',
    '開始 10:00',
    '先頭固定',
  ])
})

test('Main PAの単一row担当と複数row・Breakをまたぐ担当を表示する', () => {
  const { rows } = createRows({
    paAssignments: [
      assignment({
        id: 'main-single',
        role: 'main',
        fromId: 'performance-1',
        untilId: 'performance-1',
      }),
      assignment({
        id: 'main-span',
        role: 'main',
        fromId: 'performance-1',
        untilId: 'break-1',
      }),
    ],
  })

  assert.deepEqual(
    rows.map((row) => row.paCoverage.main.map((coverage) => coverage.assignmentId)),
    [
      ['main-single', 'main-span'],
      ['main-span'],
      ['main-span'],
    ],
  )
  assert.equal(rows[0].paCoverage.main[1].startsHere, true)
  assert.equal(rows[2].paCoverage.main[0].endsHere, true)
})

test('Assignment終了と次row開始が同時刻ならhalf-open区間として次rowをcoverしない', () => {
  const touchingCalculatedItems = calculatedItems.map((item) =>
    item.scheduleItemId === 'performance-2'
      ? { ...item, plannedStartMinute: 610 }
      : item,
  )
  const { rows } = createRows({
    calculatedItems: touchingCalculatedItems,
    paAssignments: [assignment({
      id: 'main-until-610',
      role: 'main',
      fromId: 'performance-1',
      untilId: 'performance-1',
    })],
  })

  assert.deepEqual(
    rows.map((row) => row.paCoverage.main.length),
    [1, 0, 0],
  )
})

test('Main / Sub PAを別列へ分類する', () => {
  const { rows } = createRows({
    paAssignments: [assignment({
      id: 'sub-single',
      role: 'sub',
      fromId: 'performance-2',
      untilId: 'performance-2',
    })],
  })

  assert.equal(rows[1].paCoverage.main.length, 0)
  assert.deepEqual(
    rows[1].paCoverage.sub.map((coverage) => coverage.memberName),
    ['佐藤 花子'],
  )
})

test('参照切れPA Assignmentがあってもrow生成を継続してfallbackを返す', () => {
  const result = createRows({
    paAssignments: [assignment({
      id: 'broken-assignment',
      role: 'main',
      fromId: 'missing-item',
      untilId: 'performance-1',
    })],
  })

  assert.equal(result.rows.length, 3)
  assert.equal(result.unresolvedPaAssignments.length, 1)
  assert.equal(result.unresolvedPaAssignments[0].assignmentId, 'broken-assignment')
  assert.match(result.unresolvedPaAssignments[0].reason, /開始参照先/)
})

test('ScheduleItemに直接関連するIssueだけをrowへ対応付ける', () => {
  const createIssue = (severity, scheduleItemIds) => ({
    severity,
    code: 'SHORT_REST',
    message: 'テストIssue',
    scheduleItemIds,
  })
  const { rows } = createRows({
    issues: [
      createIssue('ERROR', ['performance-1']),
      createIssue('WARNING', ['performance-1', 'other-stage-item']),
      createIssue('INFO', ['other-stage-item']),
    ],
  })

  assert.deepEqual(rows[0].issueCounts, { ERROR: 1, WARNING: 1, INFO: 0 })
  assert.deepEqual(rows[1].issueCounts, { ERROR: 0, WARNING: 0, INFO: 0 })
})
