import test from 'node:test'
import assert from 'node:assert/strict'

import {
  countIssuesBySeverity,
  createScheduleIssueDetailPresentation,
  formatScheduleIssueMessage,
  getHighestSeverityByScheduleItem,
  getIssuesForStage,
} from '../src/ui/issuePresentation.ts'

const createIssue = (severity, scheduleItemIds = undefined) => ({
  severity,
  code: 'SHORT_REST',
  message: 'テストIssue',
  scheduleItemIds,
})

test('IssueをERROR / WARNING / INFOごとに集計する', () => {
  const counts = countIssuesBySeverity([
    createIssue('ERROR'),
    createIssue('ERROR'),
    createIssue('WARNING'),
    createIssue('INFO'),
    createIssue('INFO'),
    createIssue('INFO'),
  ])

  assert.deepEqual(counts, { ERROR: 2, WARNING: 1, INFO: 3 })
})

test('同じScheduleItemでは最も重大なseverityを採用する', () => {
  const severityByScheduleItem = getHighestSeverityByScheduleItem([
    createIssue('WARNING', ['item-1', 'item-2']),
    createIssue('INFO', ['item-1']),
    createIssue('ERROR', ['item-1']),
  ])

  assert.equal(severityByScheduleItem.get('item-1'), 'ERROR')
  assert.equal(severityByScheduleItem.get('item-2'), 'WARNING')
})

test('Issueなしの場合は全件数が0でScheduleItem severityも空になる', () => {
  assert.deepEqual(countIssuesBySeverity([]), {
    ERROR: 0,
    WARNING: 0,
    INFO: 0,
  })
  assert.equal(getHighestSeverityByScheduleItem([]).size, 0)
})

test('Issue messageの内部IDを既存表示名へ置き換える', () => {
  const message = formatScheduleIssueMessage({
    severity: 'ERROR',
    code: 'DUTY_MEMBER_PERFORMANCE_OVERLAP',
    message: 'メンバー member-a / EventBand band-a / Stage stage-a / Section section-a / DutyType duty-a',
    memberIds: ['member-a'],
    eventBandIds: ['band-a'],
    stageIds: ['stage-a'],
    sectionIds: ['section-a'],
    dutyTypeIds: ['duty-a'],
  }, {
    members: [{ id: 'member-a', realName: 'Alice', active: true }],
    eventBands: [{ id: 'band-a', eventId: 'event-a', eventDayId: 'day-a',
      name: 'Alpha', memberIds: [], durationMinutes: 10 }],
    dutyTypes: [{ id: 'duty-a', eventId: 'event-a', name: '撮影', order: 0 }],
    stages: [{ id: 'stage-a', eventDayId: 'day-a', name: 'Main', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '18:00' }],
    sections: [{ id: 'section-a', stageId: 'stage-a', name: '第1部', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '12:00' }],
  })

  assert.equal(message,
    'メンバー「Alice」 / バンド「Alpha」 / Stage「Main」 / Section「第1部」 / 仕事「撮影」')
})

test('IssuePanelと行popover用の対象・間隔表示を共通化する', () => {
  const details = createScheduleIssueDetailPresentation({
    severity: 'WARNING',
    code: 'SHORT_REST',
    message: 'メンバー member-a / EventBand band-a',
    memberIds: ['member-a'],
    eventBandIds: ['band-a'],
    scheduleItemIds: ['item-a'],
    sectionIds: ['section-a'],
    restMinutes: 4,
  }, {
    members: [{ id: 'member-a', realName: 'Alice', active: true }],
    eventBands: [{ id: 'band-a', eventId: 'event-a', eventDayId: 'day-a',
      name: 'Alpha', memberIds: [], durationMinutes: 10 }],
    stages: [{ id: 'stage-a', eventDayId: 'day-a', name: 'Main', order: 0 }],
    sections: [{ id: 'section-a', stageId: 'stage-a', name: '第1部', order: 0 }],
  }, [{
    scheduleItemId: 'item-a', eventDayId: 'day-a', stageId: 'stage-a',
    plannedStartMinute: 600, plannedEndMinute: 610,
  }])

  assert.equal(details.message, 'メンバー「Alice」 / バンド「Alpha」')
  assert.deepEqual(details.targets, [
    'メンバー: Alice',
    'バンド: Alpha',
    'Stage: Main',
    'Section: 第1部',
  ])
  assert.deepEqual(details.metrics, ['休憩時間: 4分'])
})

const sectionContext = {
  members: [],
  eventBands: [],
  stages: [
    { id: 'stage-main', eventDayId: 'day-a', name: 'Main', order: 0 },
    { id: 'stage-sub', eventDayId: 'day-a', name: 'Sub', order: 1 },
  ],
  sections: [
    { id: 'section-main-a', stageId: 'stage-main', name: '第1部', order: 0 },
    { id: 'section-main-b', stageId: 'stage-main', name: '第2部', order: 1 },
    { id: 'section-sub-a', stageId: 'stage-sub', name: '第1部', order: 0 },
  ],
}

const getSectionTarget = (issue, calculatedItems = []) =>
  createScheduleIssueDetailPresentation(
    issue,
    sectionContext,
    calculatedItems,
  ).targets.find(target => target.startsWith('Section:'))

test('Issue詳細は明示SectionとScheduleItem所属Sectionを重複なく統合する', () => {
  const issue = {
    severity: 'WARNING',
    code: 'PREFERENCE_NOT_MET',
    message: '希望時間外です。',
    sectionIds: ['section-main-a', 'section-main-a'],
    scheduleItemIds: ['item-a', 'item-b'],
  }
  const calculatedItems = [
    { scheduleItemId: 'item-a', eventDayId: 'day-a', stageId: 'stage-main',
      sectionId: 'section-main-a', plannedStartMinute: 600, plannedEndMinute: 610 },
    { scheduleItemId: 'item-b', eventDayId: 'day-a', stageId: 'stage-main',
      sectionId: 'section-main-b', plannedStartMinute: 610, plannedEndMinute: 620 },
  ]

  assert.equal(
    getSectionTarget(issue, calculatedItems),
    'Section: Main / 第1部（Section ID: section-main-a）、第2部',
  )
  assert.equal(
    getSectionTarget({ ...issue, sectionIds: undefined }, calculatedItems),
    'Section: Main / 第1部（Section ID: section-main-a）、第2部',
    'sectionIdsなしでもScheduleItemの所属から解決する',
  )
  assert.equal(
    getSectionTarget({ ...issue, scheduleItemIds: undefined }),
    'Section: Main / 第1部（Section ID: section-main-a）',
    '明示sectionIdsだけのIssueも維持する',
  )
})

test('部間休憩・Section未設定・不明参照を推測せず表現する', () => {
  const calculatedItems = [
    { scheduleItemId: 'break-a', eventDayId: 'day-a', stageId: 'stage-main',
      afterSectionId: 'section-main-a', plannedStartMinute: 620, plannedEndMinute: 625 },
    { scheduleItemId: 'stage-break', eventDayId: 'day-a', stageId: 'stage-main',
      plannedStartMinute: 625, plannedEndMinute: 630 },
  ]

  assert.equal(getSectionTarget({
    severity: 'INFO', code: 'BREAK', message: '部間休憩',
    scheduleItemIds: ['break-a'],
  }, calculatedItems), 'Section: Main / 第1部（Section ID: section-main-a）の後')
  assert.equal(getSectionTarget({
    severity: 'INFO', code: 'BREAK', message: '明示参照付き部間休憩',
    sectionIds: ['section-main-a'], scheduleItemIds: ['break-a'],
  }, calculatedItems),
  'Section: Main / 第1部（Section ID: section-main-a）（Section内・直後）')
  assert.equal(getSectionTarget({
    severity: 'INFO', code: 'BREAK', message: 'Stage休憩',
    scheduleItemIds: ['stage-break'],
  }, calculatedItems), undefined)
  assert.equal(getSectionTarget({
    severity: 'INFO', code: 'UNKNOWN', message: '不明Item',
    scheduleItemIds: ['missing-item'],
  }, calculatedItems), undefined)
  assert.equal(getSectionTarget({
    severity: 'INFO', code: 'UNKNOWN', message: '不明Section',
    sectionIds: ['missing-section'],
  }), 'Section: 不明なSection（Section ID: missing-section）')
})

test('Stageが異なる同名SectionをID付きで別対象として表示する', () => {
  const target = getSectionTarget({
    severity: 'WARNING', code: 'CROSS_STAGE', message: '複数Stage',
    scheduleItemIds: ['item-main', 'item-sub'],
  }, [
    { scheduleItemId: 'item-main', eventDayId: 'day-a', stageId: 'stage-main',
      sectionId: 'section-main-a', plannedStartMinute: 600, plannedEndMinute: 610 },
    { scheduleItemId: 'item-sub', eventDayId: 'day-a', stageId: 'stage-sub',
      sectionId: 'section-sub-a', plannedStartMinute: 600, plannedEndMinute: 610 },
  ])

  assert.equal(
    target,
    'Section: Main / 第1部（Section ID: section-main-a）、Sub / 第1部（Section ID: section-sub-a）',
  )
})

test('置換済みの表示名に含まれる別entity IDを後続置換で壊さない', () => {
  const message = formatScheduleIssueMessage({
    severity: 'ERROR',
    code: 'FIXED_PLACEMENT_STAGE_MISMATCH',
    message: 'EventBand band-a は Stage stage-a に配置されています',
    eventBandIds: ['band-a'],
    stageIds: ['stage-a'],
  }, {
    members: [],
    eventBands: [{ id: 'band-a', eventId: 'event-a', eventDayId: 'day-a',
      name: 'Choir stage-a', memberIds: [], durationMinutes: 10 }],
    stages: [{ id: 'stage-a', eventDayId: 'day-a', name: 'Main', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '18:00' }],
    sections: [],
  })

  assert.equal(message,
    'バンド「Choir stage-a」 は Stage「Main」 に配置されています')
})

test('Issue一覧を選択中Stageとの関連で絞り込む', () => {
  const mainOnly = {
    ...createIssue('ERROR'),
    message: 'Main StageだけのIssue',
    stageIds: ['stage-main'],
  }
  const subOnly = {
    ...createIssue('WARNING'),
    message: 'Sub StageだけのIssue',
    stageIds: ['stage-sub'],
  }
  const crossStage = {
    ...createIssue('ERROR'),
    message: 'MainとSubにまたがるIssue',
    stageIds: ['stage-main', 'stage-sub'],
  }
  const scheduleItemOnly = {
    ...createIssue('INFO', ['item-main']),
    message: 'ScheduleItemからMainとの関連が分かるIssue',
  }
  const scheduleItems = [
    { id: 'item-main', stageId: 'stage-main' },
    { id: 'item-sub', stageId: 'stage-sub' },
  ]

  assert.deepEqual(
    getIssuesForStage(
      [mainOnly, subOnly, crossStage, scheduleItemOnly],
      'stage-main',
      scheduleItems,
    ).map((issue) => issue.message),
    [
      'Main StageだけのIssue',
      'MainとSubにまたがるIssue',
      'ScheduleItemからMainとの関連が分かるIssue',
    ],
  )
  assert.deepEqual(
    getIssuesForStage(
      [mainOnly, subOnly, crossStage, scheduleItemOnly],
      'stage-sub',
      scheduleItems,
    ).map((issue) => issue.message),
    ['Sub StageだけのIssue', 'MainとSubにまたがるIssue'],
  )
})
