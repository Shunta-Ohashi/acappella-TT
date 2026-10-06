import test from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/data/demoData.ts'
import {
  createTimetableDutyColumns,
  createTimetableWorkbookFilename,
  createTimetableWorkbookModel,
  createTimetableWorksheetNames,
} from '../src/export/timetableWorkbook.ts'
import {
  createTimetableWorkbookXlsx,
  TIMETABLE_WORKBOOK_MIME,
} from '../src/export/excelWorkbook.ts'

const makeInput = () => {
  const data = createDemoData()
  const event = data.events.find((item) => item.id === 'event-demo-main')
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
  }
}

const getModel = (input = makeInput()) => {
  const result = createTimetableWorkbookModel(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.ok ? result.model : undefined
}

const hasUnpairedSurrogate = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}

test('Workbook modelはEventDay・Stage順に全StageのSheetを作り空Stageもheader-onlyにする', () => {
  const input = makeInput()
  input.eventDays = [...input.eventDays].reverse()
  input.stages = [...input.stages].reverse()
  const targetStage = input.stages.find((stage) => stage.id === 'stage-demo-sub-day1')
  input.scheduleItems = input.scheduleItems.filter((item) => item.stageId !== targetStage.id)
  const before = structuredClone(input)
  const first = getModel(input)
  const second = getModel(input)
  assert.deepEqual(second, first)
  assert.deepEqual(input, before)
  if (!first) return

  const expectedScopes = input.eventDays
    .filter((day) => day.eventId === input.event.id)
    .sort((left, right) => left.order - right.order ||
      left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
    .flatMap((day) => input.stages
      .filter((stage) => stage.eventDayId === day.id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((stage) => [day.id, stage.id]))
  assert.deepEqual(first.sheets.map((sheet) => [sheet.eventDayId, sheet.stageId]), expectedScopes)
  assert.equal(first.sheets.find((sheet) => sheet.stageId === targetStage.id)?.rows.length, 0)
  assert.equal(first.sheets.every((sheet) => sheet.headers.length > 0), true)
})

test('Sheet名は通常名・31文字以下・31文字超を安全な長さで維持する', () => {
  const exact = 'A'.repeat(31)
  const names = createTimetableWorksheetNames([
    { date: '2027-11-01', stageName: 'Main Stage' },
    { date: '', stageName: exact },
    { date: '', stageName: 'B'.repeat(32) },
    { date: '2027-11-02', stageName: 'Very Long Stage Name '.repeat(3) },
  ])
  assert.deepEqual(names.slice(0, 2), ['2027-11-01 Main Stage', exact])
  assert.equal(names[2], 'B'.repeat(31))
  assert.equal(names[3].length, 31)
})

test('Sheet名はtruncate後・suffix後もapostrophe・禁止文字・control文字を残さない', () => {
  const truncatedAtApostrophe = `${'A'.repeat(30)}'BBB`
  const names = createTimetableWorksheetNames([
    { date: '', stageName: truncatedAtApostrophe },
    { date: '', stageName: `'${truncatedAtApostrophe}` },
    { date: '2027-11-01', stageName: 'Main:/?*[]\\\u0000\u001f Stage' },
  ])
  assert.equal(names[0], 'A'.repeat(30))
  assert.equal(names.every((name) => name.length > 0 && name.length <= 31), true)
  assert.equal(names.every((name) => !/^'|'$/.test(name)), true)
  assert.equal(names.every((name) => !/[:\\/?*[\]\u0000-\u001f]/.test(name)), true)
})

test('Sheet名はcase-insensitive collisionを連番化し長い名前でも31文字以内にする', () => {
  const longName = 'Long Stage Name '.repeat(4)
  const names = createTimetableWorksheetNames([
    { date: '2027-11-01', stageName: 'Main' },
    { date: '2027-11-01', stageName: 'main' },
    { date: '2027-11-02', stageName: longName },
    { date: '2027-11-02', stageName: longName },
  ])
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length)
  assert.match(names[1], /\(2\)$/)
  assert.match(names[3], /\(2\)$/)
  assert.equal(names.every((name) => name.length <= 31), true)
})

test('Sheet名は日本語とemojiをUTF-16の31文字境界で分断せずsuffixも安全に付ける', () => {
  const splitByOldSlice = `${'A'.repeat(30)}😀末尾`
  const longEmojiName = `音楽祭${'🎤'.repeat(20)}終演`
  const names = createTimetableWorksheetNames([
    { date: '', stageName: '日'.repeat(32) },
    { date: '', stageName: splitByOldSlice },
    { date: '', stageName: longEmojiName },
    { date: '', stageName: longEmojiName },
    { date: '', stageName: `${'A'.repeat(28)}😀'末尾` },
    { date: '', stageName: `${'B'.repeat(27)}🎵:/?*[]\\末尾` },
  ])
  assert.equal(names[0], '日'.repeat(31))
  assert.equal(names[1], 'A'.repeat(30))
  assert.equal(names[4], `${'A'.repeat(28)}😀`)
  assert.match(names[3], /\(2\)$/)
  assert.equal(names.every((name) => name.length > 0 && name.length <= 31), true)
  assert.equal(names.every((name) => !hasUnpairedSurrogate(name)), true)
  assert.equal(names.every((name) => !name.includes('\ufffd')), true)
  assert.equal(names.every((name) => !/^'|'$/.test(name)), true)
  assert.equal(names.every((name) => !/[:\\/?*[\]]/.test(name)), true)
})

test('Sheet名の入力とfallbackが空になっても安全な既定名を使う', () => {
  const names = createTimetableWorksheetNames([
    { date: "'''", stageName: "'''" },
    { date: "'''", stageName: "'''" },
  ])
  assert.deepEqual(names, ['Sheet', 'Sheet (2)'])
})

test('Workbook headerは固定列、最低7 Member列、順序付きでuniqueなDuty列を持つ', () => {
  const model = getModel()
  if (!model) return
  const expectedPrefix = [
    'スタート時間', '内容',
    ...Array.from({ length: 7 }, (_, index) => `メンバー${index + 1}`),
    'Main PA', 'Sub PA',
  ]
  assert.deepEqual(model.sheets[0].headers.slice(0, expectedPrefix.length), expectedPrefix)
  assert.equal(model.sheets.every((sheet) =>
    JSON.stringify(sheet.headers) === JSON.stringify(model.sheets[0].headers)), true)

  const columns = createTimetableDutyColumns([
    { id: 'duty-a', name: '撮影' },
    { id: 'duty-b', name: '撮影' },
    { id: 'duty-c', name: 'Main PA' },
    { id: 'duty-d', name: '当日運営:Main PA' },
  ], 7)
  assert.deepEqual(columns.map((column) => column.header), [
    '撮影', '撮影 (2)', '当日運営:Main PA', '当日運営:Main PA (2)',
  ])
})

test('Event全体の最大Band人数に合わせて全SheetのMember列を拡張する', () => {
  const input = makeInput()
  input.eventBands = [...input.eventBands, {
    id: 'event-band-nine-members',
    eventId: input.event.id,
    eventDayId: 'event-day-demo-main-01',
    name: 'Nine',
    memberIds: Array.from({ length: 9 }, (_, index) => `member-${index + 1}`),
    durationMinutes: 10,
  }]
  const model = getModel(input)
  if (!model) return
  assert.equal(model.sheets.every((sheet) => sheet.headers.includes('メンバー9')), true)
})

test('Performance・Breakを開始時刻と内容で出しMember順・ID dedupe・PA/Duty coverageを維持する', () => {
  const input = makeInput()
  const targetBandId = 'event-band-demo-main-01'
  const targetBand = input.eventBands.find((band) => band.id === targetBandId)
  const [firstMemberId, secondMemberId] = targetBand.memberIds
  input.members = input.members.map((member) =>
    member.id === firstMemberId || member.id === secondMemberId
      ? { ...member, acaName: '同名Member' }
      : member)
  input.eventBands = input.eventBands.map((band) => band.id === targetBandId
    ? { ...band, memberIds: [firstMemberId, secondMemberId, firstMemberId] }
    : band)
  const model = getModel(input)
  if (!model) return
  const sheet = model.sheets.find((candidate) => candidate.stageId === 'stage-demo-main-day1')
  const header = sheet.headers
  const performance = sheet.rows.find((row) => row[header.indexOf('内容')] === targetBand.name)
  const rest = sheet.rows.find((row) => row[header.indexOf('内容')] === '昼休憩')
  assert.ok(performance)
  assert.match(performance[header.indexOf('スタート時間')], /^\d{2}:\d{2}$/)
  assert.deepEqual(performance.slice(header.indexOf('メンバー1'), header.indexOf('メンバー4')), [
    '同名Member', '同名Member', '',
  ])
  assert.ok(rest)
  assert.equal(rest.slice(header.indexOf('メンバー1'), header.indexOf('Main PA')).every((cell) => cell === ''), true)
  assert.notEqual(rest[header.indexOf('Main PA')], '')
  assert.equal(sheet.rows.some((row) => row[header.indexOf('撮影')] !== ''), true)
})

test('PA/Dutyは同一rowの別Memberを区切り、同一Member IDをdedupeする', () => {
  const input = makeInput()
  const pa = input.paAssignments.find((item) => item.id === 'pa-assignment-demo-main-day1-main')
  const duty = input.dutyAssignments.find((item) => item.id === 'duty-assignment-demo-photo')
  const otherMemberId = 'member-demo-04'
  input.paAssignments = [
    ...input.paAssignments,
    { ...pa, id: 'pa-same-member' },
    { ...pa, id: 'pa-other-member', memberId: otherMemberId },
  ]
  input.dutyAssignments = [
    ...input.dutyAssignments,
    { ...duty, id: 'duty-same-member' },
    { ...duty, id: 'duty-other-member', memberId: otherMemberId },
  ]
  const model = getModel(input)
  if (!model) return
  const sheet = model.sheets.find((candidate) => candidate.stageId === 'stage-demo-main-day1')
  const breakRow = sheet.rows.find((row) => row[sheet.headers.indexOf('内容')] === '昼休憩')
  const reversed = getModel({
    ...input,
    paAssignments: [...input.paAssignments].reverse(),
    dutyAssignments: [...input.dutyAssignments].reverse(),
  })
  const reversedSheet = reversed.sheets.find((candidate) =>
    candidate.stageId === 'stage-demo-main-day1')
  const reversedBreakRow = reversedSheet.rows.find((row) =>
    row[reversedSheet.headers.indexOf('内容')] === '昼休憩')
  for (const headerName of ['Main PA', '撮影']) {
    const cell = breakRow[sheet.headers.indexOf(headerName)]
    assert.equal(cell.split('|').length, 2)
    assert.equal(reversedBreakRow[reversedSheet.headers.indexOf(headerName)], cell)
  }
})

test('Workbook表示はdomain collectionの入力配列順とlocaleに依存しない', () => {
  const input = makeInput()
  const targetDayIds = input.eventDays.filter((day) => day.eventId === input.event.id)
    .map((day) => day.id)
  input.eventDays = input.eventDays.map((day) => targetDayIds.includes(day.id)
    ? { ...day, order: 0, date: '2027-11-01' }
    : day)
  const firstDayId = targetDayIds[0]
  input.stages = input.stages.map((stage) => stage.eventDayId === firstDayId
    ? { ...stage, order: 0 }
    : stage)
  input.dutyTypes = input.dutyTypes.map((type) => type.eventId === input.event.id
    ? { ...type, order: 0 }
    : type)

  const pa = input.paAssignments.find((assignment) =>
    assignment.eventId === input.event.id && assignment.role === 'main')
  const duty = input.dutyAssignments.find((assignment) =>
    assignment.eventDayId === pa.eventDayId && assignment.stageId === pa.stageId)
  input.paAssignments = [
    ...input.paAssignments,
    { ...pa, id: 'pa-determinism-z', memberId: 'member-demo-04' },
    { ...pa, id: 'pa-determinism-a', memberId: 'member-demo-03' },
  ]
  input.dutyAssignments = [
    ...input.dutyAssignments,
    { ...duty, id: 'duty-determinism-z', memberId: 'member-demo-04' },
    { ...duty, id: 'duty-determinism-a', memberId: 'member-demo-03' },
  ]

  const baseline = getModel(input)
  const reordered = getModel({
    ...input,
    eventDays: [...input.eventDays].reverse(),
    stages: [...input.stages].reverse(),
    dutyTypes: [...input.dutyTypes].reverse(),
    paAssignments: [...input.paAssignments].reverse(),
    dutyAssignments: [...input.dutyAssignments].reverse(),
    scheduleItems: [...input.scheduleItems].reverse(),
    members: [...input.members].reverse(),
    eventBands: [...input.eventBands].reverse(),
  })
  assert.deepEqual(reordered, baseline)
})

test('selected Eventのbroken担当だけwarningにしforeign PA/Dutyをrow・warningから隔離する', () => {
  const input = makeInput()
  const baseline = getModel(input)
  if (!baseline) return
  const foreignDay = input.eventDays.find((day) => day.eventId !== input.event.id)
  const foreignStage = input.stages.find((stage) => stage.eventDayId === foreignDay.id)
  const paTemplate = input.paAssignments.find((item) => item.eventId === input.event.id)
  const dutyTemplate = input.dutyAssignments[0]
  const foreignDutyType = {
    id: 'foreign-duty-type', eventId: foreignDay.eventId, name: 'Foreign', order: 0,
  }
  input.paAssignments.push(
    {
      ...paTemplate, id: 'foreign-pa', eventId: foreignDay.eventId,
      eventDayId: foreignDay.id, stageId: foreignStage.id, memberId: 'missing-member',
    },
    {
      ...paTemplate, id: 'foreign-pa-target-scope', eventId: foreignDay.eventId,
      memberId: 'missing-member',
    },
  )
  input.dutyTypes.push(foreignDutyType)
  input.dutyAssignments.push(
    {
      ...dutyTemplate, id: 'foreign-duty', dutyTypeId: foreignDutyType.id,
      eventDayId: foreignDay.id, stageId: foreignStage.id, memberId: 'missing-member',
    },
    {
      ...dutyTemplate, id: 'foreign-duty-target-scope', dutyTypeId: foreignDutyType.id,
      memberId: 'missing-member',
    },
  )
  assert.deepEqual(getModel(input), baseline)

  input.paAssignments.push({
    ...paTemplate, id: 'selected-broken-pa', stageId: 'missing-stage',
  })
  const broken = getModel(input)
  assert.equal(broken?.warnings.some((warning) => warning.includes('参照切れ')), true)
})

test('Timeline計算不能Stageが1件でもあればWorkbook全体をfailureにする', () => {
  const input = makeInput()
  const target = input.scheduleItems.find((item) => item.kind === 'performance')
  input.scheduleItems = input.scheduleItems.map((item) => item.id === target.id
    ? { ...item, eventBandId: 'missing-event-band' }
    : item)
  const result = createTimetableWorkbookModel(input)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /Excelを書き出せません/)
})

test('ExcelJS生成は複数Sheet・format・freeze・filter・formula-like stringを維持する', async () => {
  const input = makeInput()
  input.eventBands = input.eventBands.map((band, index) => index === 0
    ? { ...band, name: '=LOVE' }
    : band)
  const model = getModel(input)
  if (!model) return
  const content = await createTimetableWorkbookXlsx(model)
  assert.equal(content.byteLength > 0, true)

  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(content)
  assert.equal(workbook.worksheets.length, model.sheets.length)
  const worksheet = workbook.worksheets.find((sheet) =>
    sheet.name === model.sheets.find((item) => item.rows.some((row) => row.includes('=LOVE')))?.name,
  )
  assert.ok(worksheet)
  const contentColumn = model.sheets.find((sheet) => sheet.name === worksheet.name)
    .headers.indexOf('内容') + 1
  const formulaLikeCell = worksheet.getColumn(contentColumn).values
    .find((value) => value === '=LOVE')
  assert.equal(formulaLikeCell, '=LOVE')
  assert.equal(worksheet.views[0].state, 'frozen')
  assert.equal(worksheet.views[0].ySplit, 1)
  assert.ok(worksheet.autoFilter)
  assert.equal(worksheet.getRow(1).font.bold, true)
  assert.equal(worksheet.getColumn(1).width, 12)
})

test('Unicode Sheet名をExcelJSで生成・再読込して文字列とSheet数を維持する', async () => {
  const names = createTimetableWorksheetNames([
    { date: '', stageName: `${'A'.repeat(29)}😀末尾` },
    { date: '', stageName: `音楽祭${'🎵'.repeat(20)}` },
  ])
  const model = {
    sheets: names.map((name, index) => ({
      name,
      eventDayId: `day-${index}`,
      stageId: `stage-${index}`,
      headers: ['内容'],
      rows: [[`演奏${index + 1}`]],
    })),
    warnings: [],
    rowCount: names.length,
  }
  const content = await createTimetableWorkbookXlsx(model)
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(content)
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), names)
  assert.equal(workbook.worksheets.length, 2)
  assert.equal(workbook.worksheets.every((sheet) => !hasUnpairedSurrogate(sheet.name)), true)
  assert.equal(workbook.worksheets.every((sheet) => !sheet.name.includes('\ufffd')), true)
})

test('Excel filenameとMIMEは安全な.xlsx download用になる', () => {
  const event = makeInput().event
  const now = new Date(2027, 0, 2, 3, 4, 5)
  assert.equal(
    createTimetableWorkbookFilename({ ...event, name: 'Live / A:*?"<>|' }, now),
    'acappella-tt-Live _ A_______-timetable-20270102-030405.xlsx',
  )
  const controlled = createTimetableWorkbookFilename({
    ...event, name: 'Line\nTab\tNul\0Unit\u001f',
  }, now)
  assert.equal(controlled, 'acappella-tt-LineTabNulUnit-timetable-20270102-030405.xlsx')
  assert.equal(TIMETABLE_WORKBOOK_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
})
