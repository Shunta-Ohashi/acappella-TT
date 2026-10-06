import test from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/data/demoData.ts'
import { parseCsv } from '../src/csv/csv.ts'
import {
  createTimetableCsv,
  createTimetableCsvFilename,
} from '../src/csv/timetableCsv.ts'

const makeInput = () => {
  const data = createDemoData()
  const event = data.events.find((item) => item.id === 'event-demo-main')
  const eventDayIds = new Set(data.eventDays.filter((day) => day.eventId === event.id).map((day) => day.id))
  const stageIds = new Set(data.stages.filter((stage) => eventDayIds.has(stage.eventDayId)).map((stage) => stage.id))
  return {
    event,
    eventDays: data.eventDays,
    stages: data.stages,
    sections: data.sections,
    members: data.members,
    eventMembers: data.eventMembers,
    eventMemberDays: data.eventMemberDays,
    eventBands: data.eventBands,
    scheduleItems: data.scheduleItems,
    paAssignments: data.paAssignments,
    dutyTypes: data.dutyTypes,
    dutyAssignments: data.dutyAssignments,
    _stageIds: stageIds,
  }
}

const parseResult = (input) => {
  const result = createTimetableCsv(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return undefined
  const parsed = parseCsv(result.csv)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return undefined
  return { result, rows: parsed.rows.map((row) => row.cells) }
}

test('Timetable CSVは複数EventDay・Stageをdeterministicにtimeline順でexportする', () => {
  const input = makeInput()
  const before = structuredClone(input)
  const first = createTimetableCsv(input)
  const second = createTimetableCsv(input)
  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
  assert.deepEqual(input, before)
  if (!first.ok) return
  const parsed = parseCsv(first.csv)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const header = parsed.rows[0].cells
  const dayIndex = header.indexOf('開催日')
  const stageIndex = header.indexOf('Stage')
  assert.deepEqual([...new Set(parsed.rows.slice(1).map((row) => row.cells[dayIndex]))], ['2026-11-01', '2026-11-03'])
  assert.equal(new Set(parsed.rows.slice(1).map((row) => row.cells[stageIndex])).size >= 2, true)
})

test('Timetable CSVはPerformance・Break・Section・時刻・メンバーを出力する', () => {
  const parsed = parseResult(makeInput())
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  const cell = (row, name) => row[header.indexOf(name)]
  const performance = rows.find((row) => cell(row, '種別') === '出演')
  const rest = rows.find((row) => cell(row, '種別') === '休憩')
  assert.ok(performance)
  assert.ok(rest)
  assert.notEqual(cell(performance, '名称'), '')
  assert.notEqual(cell(performance, 'メンバー'), '')
  assert.match(cell(performance, '開始'), /^\d{2}:\d{2}$/)
  assert.match(cell(performance, '終了'), /^\d{2}:\d{2}$/)
  assert.notEqual(cell(performance, 'EventBand ID'), '')
  assert.equal(cell(rest, 'EventBand ID'), '')
  assert.notEqual(cell(rest, 'Section'), '')
})

test('Timetable CSVはSectionなしStageを空Sectionで出力する', () => {
  const parsed = parseResult(makeInput())
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  const stageIndex = header.indexOf('Stage')
  const sectionIndex = header.indexOf('Section')
  const row = rows.find((candidate) => candidate[stageIndex] === 'Sub Stage')
  assert.ok(row)
  assert.equal(row[sectionIndex], '')
})

test('Timetable CSVはSection間Breakを前後のSection名で表示する', () => {
  const input = makeInput()
  input.scheduleItems = [...input.scheduleItems, {
    id: 'csv-inter-section-break',
    stageId: 'stage-demo-main-day1',
    afterSectionId: 'section-demo-day1-01',
    order: 0,
    kind: 'break',
    title: '部間休憩',
    durationMinutes: 15,
  }]
  const parsed = parseResult(input)
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  const idIndex = header.indexOf('ScheduleItem ID')
  const sectionIndex = header.indexOf('Section')
  const row = rows.find((candidate) => candidate[idIndex] === 'csv-inter-section-break')
  assert.equal(row?.[sectionIndex], '1部 → 2部')
})

test('Timetable CSVはMain/Sub PA・dynamic Duty列・Issue count列を出力する', () => {
  const parsed = parseResult(makeInput())
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  for (const name of ['Main PA', 'Sub PA', '当日運営:撮影', '当日運営:消毒', 'ERROR', 'WARNING', 'INFO']) {
    assert.notEqual(header.indexOf(name), -1)
  }
  assert.equal(rows.some((row) => row[header.indexOf('Main PA')] !== ''), true)
  assert.equal(rows.some((row) => row[header.indexOf('Sub PA')] !== ''), true)
  assert.equal(rows.some((row) => row[header.indexOf('当日運営:撮影')] !== ''), true)
  assert.equal(rows.every((row) => /^\d+$/.test(row[header.indexOf('ERROR')])), true)
})

test('Timetable CSVはunresolved assignmentをwarningとして通知する', () => {
  const input = makeInput()
  input.paAssignments = [...input.paAssignments, {
    id: 'pa-unresolved',
    eventId: input.event.id,
    eventDayId: 'event-day-demo-main-01',
    stageId: 'stage-demo-main-day1',
    memberId: 'member-demo-03',
    role: 'main',
    from: { kind: 'schedule-item', scheduleItemId: 'missing-item', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'missing-item', edge: 'end' },
  }]
  const result = createTimetableCsv(input)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.warnings.some((warning) => warning.includes('参照切れ')), true)
})

test('Timetable CSVはinvalid Stageをsilent skipせずexport全体を失敗させる', () => {
  const input = makeInput()
  const target = input.scheduleItems.find((item) => item.kind === 'performance')
  input.scheduleItems = input.scheduleItems.map((item) => item.id === target.id
    ? { ...item, eventBandId: 'missing-event-band' }
    : item)
  const result = createTimetableCsv(input)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /書き出せません/)
})

test('空Timetableもheader-only CSVとしてexportできる', () => {
  const input = makeInput()
  input.scheduleItems = []
  input.paAssignments = []
  input.dutyAssignments = []
  const parsed = parseResult(input)
  if (!parsed) return
  assert.equal(parsed.rows.length, 1)
})

test('Timetable filenameは危険文字をsanitizeしtimestampを含める', () => {
  const filename = createTimetableCsvFilename(
    { ...makeInput().event, name: 'Live / A:*?"<>|' },
    new Date(2027, 0, 2, 3, 4, 5),
  )
  assert.equal(filename, 'acappella-tt-Live _ A_______-timetable-20270102-030405.csv')
})
