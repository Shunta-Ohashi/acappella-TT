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

test('Timetable CSVはPerformance MemberをIDでdedupeし同名の別Memberを保持する', () => {
  const input = makeInput()
  const targetBandId = 'event-band-demo-main-01'
  const targetBand = input.eventBands.find((band) => band.id === targetBandId)
  const [firstId, secondId] = targetBand.memberIds
  input.members = input.members.map((member) =>
    member.id === firstId || member.id === secondId
      ? { ...member, acaName: '同名Performance' }
      : member,
  )
  input.eventBands = input.eventBands.map((band) => band.id === targetBandId
    ? { ...band, memberIds: [...band.memberIds, firstId] }
    : band)
  const parsed = parseResult(input)
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  const row = rows.find((candidate) => candidate[header.indexOf('EventBand ID')] === targetBandId)
  assert.equal(row[header.indexOf('メンバー')].split('|').filter((name) => name === '同名Performance').length, 2)
})

test('Timetable CSVはMain PAをMember IDでdedupeし同名の別Memberを保持する', () => {
  const input = makeInput()
  const assignment = input.paAssignments.find((item) => item.id === 'pa-assignment-demo-main-day1-main')
  const otherMemberId = 'member-demo-04'
  input.members = input.members.map((member) =>
    member.id === assignment.memberId || member.id === otherMemberId
      ? { ...member, acaName: '同名PA' }
      : member,
  )
  input.paAssignments = [
    ...input.paAssignments,
    { ...assignment, id: 'pa-same-name-other-member', memberId: otherMemberId },
    { ...assignment, id: 'pa-duplicate-same-member' },
  ]
  const parsed = parseResult(input)
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  const row = rows.find((candidate) => candidate[header.indexOf('ScheduleItem ID')] === 'schedule-demo-main-day1-break')
  assert.equal(row[header.indexOf('Main PA')], '同名PA|同名PA')
})

test('Timetable CSVはDutyをMember IDでdedupeし同名の別Memberを保持する', () => {
  const input = makeInput()
  const assignment = input.dutyAssignments.find((item) => item.id === 'duty-assignment-demo-photo')
  const otherMemberId = 'member-demo-02'
  input.members = input.members.map((member) =>
    member.id === assignment.memberId || member.id === otherMemberId
      ? { ...member, acaName: '同名Duty' }
      : member,
  )
  input.dutyAssignments = [
    ...input.dutyAssignments,
    { ...assignment, id: 'duty-same-name-other-member', memberId: otherMemberId },
    { ...assignment, id: 'duty-duplicate-same-member' },
  ]
  const parsed = parseResult(input)
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  const row = rows.find((candidate) => candidate[header.indexOf('ScheduleItem ID')] === 'schedule-demo-main-day1-break')
  assert.equal(row[header.indexOf('当日運営:撮影')], '同名Duty|同名Duty')
})

test('Timetable CSVもformula-likeな表示値をSpreadsheet-safeに書き出す', () => {
  const input = makeInput()
  input.stages = input.stages.map((stage) => stage.id === 'stage-demo-main-day1'
    ? { ...stage, name: '=Main Stage' }
    : stage)
  const parsed = parseResult(input)
  if (!parsed) return
  const [header, ...rows] = parsed.rows
  assert.equal(rows.some((row) => row[header.indexOf('Stage')] === "'=Main Stage"), true)
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

test('Timetable CSVはselected Eventの不正なPA scopeをwarningにする', () => {
  const variants = [
    (assignment) => ({ ...assignment, id: 'pa-missing-day', eventDayId: 'missing-day' }),
    (assignment) => ({ ...assignment, id: 'pa-missing-stage', stageId: 'missing-stage' }),
    (assignment, input) => ({
      ...assignment,
      id: 'pa-day-stage-mismatch',
      eventDayId: input.eventDays.find((day) =>
        day.eventId === input.event.id && day.id !== assignment.eventDayId,
      ).id,
    }),
  ]
  for (const createInvalid of variants) {
    const input = makeInput()
    const assignment = input.paAssignments.find((item) => item.eventId === input.event.id)
    input.paAssignments = [...input.paAssignments, createInvalid(assignment, input)]
    const result = createTimetableCsv(input)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) assert.equal(result.warnings.some((warning) => warning.includes('参照切れ')), true)
  }
})

test('Timetable CSVはselected Eventに関係する不正なDuty scopeをwarningにする', () => {
  const variants = [
    (assignment) => ({ ...assignment, id: 'duty-missing-stage', stageId: 'missing-stage' }),
    (assignment, input) => ({
      ...assignment,
      id: 'duty-day-stage-mismatch',
      eventDayId: input.eventDays.find((day) =>
        day.eventId === input.event.id && day.id !== assignment.eventDayId,
      ).id,
    }),
  ]
  for (const createInvalid of variants) {
    const input = makeInput()
    const eventDutyTypeIds = new Set(input.dutyTypes
      .filter((type) => type.eventId === input.event.id)
      .map((type) => type.id))
    const assignment = input.dutyAssignments.find((item) => eventDutyTypeIds.has(item.dutyTypeId))
    input.dutyAssignments = [...input.dutyAssignments, createInvalid(assignment, input)]
    const result = createTimetableCsv(input)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) assert.equal(result.warnings.some((warning) => warning.includes('参照切れ')), true)
  }
})

test('Timetable CSVはselected EventのPAがmissing Memberを参照するとwarningにする', () => {
  const input = makeInput()
  const assignment = input.paAssignments.find((item) => item.eventId === input.event.id)
  input.paAssignments = [...input.paAssignments, {
    ...assignment, id: 'pa-missing-member', memberId: 'missing-member',
  }]
  const result = createTimetableCsv(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  if (result.ok) assert.equal(result.warnings.some((warning) => warning.includes('参照切れ')), true)
})

test('Timetable CSVはselected EventのDutyがmissing Memberを参照するとwarningにする', () => {
  const input = makeInput()
  const eventDutyTypeIds = new Set(input.dutyTypes
    .filter((type) => type.eventId === input.event.id)
    .map((type) => type.id))
  const assignment = input.dutyAssignments.find((item) => eventDutyTypeIds.has(item.dutyTypeId))
  input.dutyAssignments = [...input.dutyAssignments, {
    ...assignment, id: 'duty-missing-member', memberId: 'missing-member',
  }]
  const result = createTimetableCsv(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  if (result.ok) assert.equal(result.warnings.some((warning) => warning.includes('参照切れ')), true)
})

test('Timetable CSVはforeign assignmentをselected EventのCSV・warningから隔離する', () => {
  const input = makeInput()
  const baseline = createTimetableCsv(input)
  assert.equal(baseline.ok, true, JSON.stringify(baseline))
  const foreignDay = input.eventDays.find((day) => day.eventId !== input.event.id)
  const foreignStage = input.stages.find((stage) => stage.eventDayId === foreignDay.id)
  const paTemplate = input.paAssignments.find((item) => item.eventId === input.event.id)
  const dutyTemplate = input.dutyAssignments[0]
  const foreignDutyType = {
    id: 'foreign-duty-type', eventId: foreignDay.eventId, name: 'Foreign', order: 0,
  }
  input.paAssignments = [...input.paAssignments, {
    ...paTemplate,
    id: 'foreign-pa',
    eventId: foreignDay.eventId,
    eventDayId: foreignDay.id,
    stageId: foreignStage.id,
    memberId: 'foreign-missing-member',
  }, {
    ...paTemplate,
    id: 'foreign-pa-with-target-scope',
    eventId: foreignDay.eventId,
    memberId: 'foreign-missing-member',
  }]
  input.dutyTypes = [...input.dutyTypes, foreignDutyType]
  input.dutyAssignments = [...input.dutyAssignments, {
    ...dutyTemplate,
    id: 'foreign-duty',
    dutyTypeId: foreignDutyType.id,
    eventDayId: foreignDay.id,
    stageId: foreignStage.id,
    memberId: 'foreign-missing-member',
  }, {
    ...dutyTemplate,
    id: 'foreign-duty-with-target-scope',
    dutyTypeId: foreignDutyType.id,
    memberId: 'foreign-missing-member',
  }]
  const result = createTimetableCsv(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result, baseline)
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

test('Timetable filenameは通常名・禁止文字・control character・fallbackを安全に扱う', () => {
  const event = makeInput().event
  const now = new Date(2027, 0, 2, 3, 4, 5)
  assert.equal(
    createTimetableCsvFilename({ ...event, name: 'Normal Event' }, now),
    'acappella-tt-Normal Event-timetable-20270102-030405.csv',
  )
  assert.equal(
    createTimetableCsvFilename({ ...event, name: 'Live / A:*?"<>|' }, now),
    'acappella-tt-Live _ A_______-timetable-20270102-030405.csv',
  )
  const controlled = createTimetableCsvFilename({
    ...event, name: 'Line\nTab\tNul\0Unit\u001f',
  }, now)
  assert.equal(controlled, 'acappella-tt-LineTabNulUnit-timetable-20270102-030405.csv')
  assert.equal([...controlled].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f), false)
  assert.equal(
    createTimetableCsvFilename({ ...event, id: 'safe-event-id', name: '\n\t\0\u001f' }, now),
    'acappella-tt-safe-event-id-timetable-20270102-030405.csv',
  )
  assert.equal(
    createTimetableCsvFilename({ ...event, id: '\n\t\0', name: '\n\t\0\u001f' }, now),
    'acappella-tt-event-timetable-20270102-030405.csv',
  )
})
