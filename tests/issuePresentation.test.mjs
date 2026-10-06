import test from 'node:test'
import assert from 'node:assert/strict'

import {
  countIssuesBySeverity,
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
    message: 'member-a / band-a / stage-a / section-a / duty-a',
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

  assert.equal(message, 'Alice / Alpha / Main / 第1部 / 撮影')
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
