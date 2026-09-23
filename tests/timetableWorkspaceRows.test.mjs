import test from 'node:test'
import assert from 'node:assert/strict'

import { createTimetableWorkspaceRows } from '../src/ui/timetableWorkspaceRows.ts'
import { createTimetableGridColumns } from '../src/ui/timetableGridColumns.ts'

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
  dutyTypes: [],
  dutyAssignments: [],
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

const dutyTypes = [
  { id: 'duty-photo', eventId: 'event-1', name: '撮影', order: 1 },
  { id: 'duty-tk', eventId: 'event-1', name: 'TK', order: 0 },
]

const dutyAssignment = ({
  id,
  dutyTypeId = 'duty-photo',
  memberId = 'member-1',
  fromId,
  fromEdge = 'start',
  untilId,
  untilEdge = 'end',
}) => ({
  id,
  dutyTypeId,
  eventDayId: 'day-1',
  stageId: 'stage-1',
  memberId,
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

test('Section間Breakの配置参照をStep 6 rowへ維持する', () => {
  const interSectionBreak = {
    id: 'between-break',
    stageId: 'stage-1',
    afterSectionId: 'section-1',
    order: 0,
    kind: 'break',
    title: '部間休憩',
    durationMinutes: 15,
  }
  const result = createRows({
    scheduleItems: [interSectionBreak],
    calculatedItems: [{
      scheduleItemId: interSectionBreak.id,
      eventDayId: 'day-1',
      stageId: 'stage-1',
      afterSectionId: 'section-1',
      kind: 'break',
      plannedStartMinute: 620,
      plannedEndMinute: 635,
    }],
  })

  assert.equal(result.rows[0].scheduleItem.afterSectionId, 'section-1')
  assert.equal(result.rows[0].calculatedItem.afterSectionId, 'section-1')
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

test('通常のPA区間はrowへ表示し、transitionだけの有効区間はGrid外担当として保持する', () => {
  const normal = createRows({
    paAssignments: [assignment({
      id: 'main-performance',
      role: 'main',
      fromId: 'performance-1',
      untilId: 'performance-1',
    })],
  })

  assert.deepEqual(
    normal.rows.map((row) => row.paCoverage.main.length),
    [1, 0, 0],
  )
  assert.deepEqual(normal.offGridPaAssignments, [])

  const transitionOnly = createRows({
    paAssignments: [assignment({
      id: 'main-transition',
      role: 'main',
      fromId: 'performance-1',
      fromEdge: 'end',
      untilId: 'performance-2',
      untilEdge: 'start',
    })],
  })

  assert.deepEqual(
    transitionOnly.rows.map((row) => row.paCoverage.main.length),
    [0, 0, 0],
  )
  assert.deepEqual(transitionOnly.unresolvedPaAssignments, [])
  assert.deepEqual(transitionOnly.offGridPaAssignments, [{
    assignmentId: 'main-transition',
    memberName: 'やまだ',
    role: 'main',
    fromMinute: 610,
    untilMinute: 612,
  }])
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

test('DutyTypeをorder順の動的Grid列へ追加する', () => {
  assert.deepEqual(
    createTimetableGridColumns([]).map((column) => column.label),
    ['時刻', '出演', 'Main PA', 'Sub PA'],
  )
  assert.deepEqual(
    createTimetableGridColumns(dutyTypes).map((column) => column.label),
    ['時刻', '出演', 'Main PA', 'Sub PA', 'TK', '撮影'],
  )
})

test('一般業務の複数担当をDutyType列へ分類しhalf-openでcoverageを作る', () => {
  const { rows } = createRows({
    dutyTypes,
    dutyAssignments: [
      dutyAssignment({
        id: 'photo-first',
        fromId: 'performance-1',
        untilId: 'performance-1',
      }),
      dutyAssignment({
        id: 'photo-second',
        memberId: 'member-2',
        fromId: 'performance-1',
        untilId: 'performance-1',
      }),
      dutyAssignment({
        id: 'tk-break',
        dutyTypeId: 'duty-tk',
        fromId: 'break-1',
        untilId: 'break-1',
      }),
    ],
  })

  assert.deepEqual(
    rows[0].dutyCoverage['duty-photo'].map((item) => item.memberName),
    ['やまだ', '佐藤 花子'],
  )
  assert.equal(rows[1].dutyCoverage['duty-tk'].length, 0)
  assert.equal(rows[2].dutyCoverage['duty-tk'].length, 1)
})

test('transition-only一般業務はGrid外へ保持し、参照切れと区別する', () => {
  const result = createRows({
    dutyTypes,
    dutyAssignments: [
      dutyAssignment({
        id: 'transition-duty',
        fromId: 'performance-1',
        fromEdge: 'end',
        untilId: 'performance-2',
        untilEdge: 'start',
      }),
      dutyAssignment({
        id: 'broken-duty',
        fromId: 'missing',
        untilId: 'performance-1',
      }),
    ],
  })

  assert.deepEqual(result.offGridDutyAssignments, [{
    assignmentId: 'transition-duty',
    dutyTypeName: '撮影',
    memberName: 'やまだ',
    fromMinute: 610,
    untilMinute: 612,
  }])
  assert.equal(result.unresolvedDutyAssignments.length, 1)
  assert.equal(result.unresolvedDutyAssignments[0].assignmentId, 'broken-duty')
})
