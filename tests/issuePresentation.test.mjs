import test from 'node:test'
import assert from 'node:assert/strict'

import {
  countIssuesBySeverity,
  getHighestSeverityByScheduleItem,
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
