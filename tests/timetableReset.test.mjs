import test from 'node:test'
import assert from 'node:assert/strict'
import { resetEventDayTimetable } from '../src/domain/timetableReset.ts'
import { getUnscheduledEventBandsForEventDay } from '../src/domain/schedule.ts'
import { createGenerationUiInput } from './fixtures/timetableGenerationUi.mjs'
import { createDemoData } from '../src/data/demoData.ts'
import { GENERATION_DEMO_EVENT_ID } from '../src/data/generationDemoData.ts'
import { parsePersistedState, serializePersistedState } from '../src/persistence/localPersistence.ts'
import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { createScheduleItemsForTimetableGeneration } from '../src/domain/timetableGenerationOptions.ts'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'

const fixture = () => {
  const input = createGenerationUiInput()
  input.scheduleItems.push({ id: 'stale-p2', kind: 'performance', eventBandId: 'band-2', stageId: 'missing-stage', order: 0 },
    { id: 'inside', kind: 'break', stageId: 'stage-a1', sectionId: 'section-2', title: '部内', durationMinutes: 5, order: 1 },
    { id: 'plain', kind: 'break', stageId: 'stage-sub', title: '通常', durationMinutes: 5, order: 0 })
  input.dutyTypes.push({ id: 'foreign-type', eventId: 'event-b', name: '他Eventの仕事', order: 0 })
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'other-day-duty', eventDayId: 'day-a2', stageId: 'stage-a2',
    from: { kind: "schedule-item", scheduleItemId: 'p-a2', edge: 'start' }, until: { kind: "schedule-item", scheduleItemId: 'p-a2', edge: 'end' } },
    { ...input.dutyAssignments[0], id: 'foreign-duty', dutyTypeId: 'foreign-type', eventDayId: 'day-b', stageId: 'stage-b',
      from: { kind: "schedule-item", scheduleItemId: 'p-b', edge: 'start' }, until: { kind: "schedule-item", scheduleItemId: 'p-b', edge: 'end' } })
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'stale-item-lock', scheduleItemId: 'stale-p2', stageId: 'stage-a1' },
    { ...input.timetableLocks[0], id: 'broken-target-lock', scheduleItemId: 'missing-item' },
    { ...input.timetableLocks[0], id: 'other-day-lock', scheduleItemId: 'p-a2', stageId: 'stage-a2', sectionId: undefined },
    { ...input.timetableLocks[0], id: 'foreign-lock', eventId: 'event-b',
      scheduleItemId: 'p-b', stageId: 'stage-b', sectionId: undefined })
  return input
}

const assertInvalidResetWithoutMutation = (input) => {
  const original = structuredClone(input)
  assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
  assert.deepEqual(input, original)
}

test('resetはtop-level nullを例外なしで拒否する', () => {
  assert.deepEqual(resetEventDayTimetable(null), { ok: false, code: 'INVALID_SCOPE' })
})

for (const [name, edit] of [
  ['target EventBand + foreign EventDay', input => {
    input.eventBands.find(band => band.id === 'band-1').eventDayId = 'day-b'
  }],
  ['foreign EventBand + target EventDay', input => {
    input.eventBands.find(band => band.id === 'band-b').eventDayId = 'day-a1'
  }],
  ['存在しないEventDay', input => {
    input.eventBands.find(band => band.id === 'band-a2').eventDayId = 'missing-day'
  }],
]) {
  test(`resetはEventBand ownership矛盾（${name}）を拒否する`, () => {
    const input = fixture()
    edit(input)
    assertInvalidResetWithoutMutation(input)
  })
}

test('resetは存在しないEventDayを指すStageを拒否する', () => {
  const input = fixture()
  input.stages.find(stage => stage.id === 'stage-b').eventDayId = 'missing-day'
  assertInvalidResetWithoutMutation(input)
})

test('正常な対象日・同一Event他日・別EventのEventBand ownershipは受け入れる', () => {
  const input = fixture()
  const originalBands = structuredClone(input.eventBands)
  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.deepEqual(input.eventBands, originalBands)
})

for (const [name, edit] of [
  ['kind欠落', item => { delete item.kind }],
  ['unknown kind', item => { item.kind = 'unknown' }],
  ['Performance afterSectionId', item => { item.afterSectionId = 'section-1' }],
]) {
  test(`resetは${name}のPerformanceを拒否する`, () => {
    const input = fixture()
    edit(input.scheduleItems.find(item => item.kind === 'performance'))
    assertInvalidResetWithoutMutation(input)
  })
}

for (const [name, edit] of [
  ['title欠落', item => { delete item.title }],
  ['duration欠落', item => { delete item.durationMinutes }],
  ['duration小数', item => { item.durationMinutes = 1.5 }],
  ['order負数', item => { item.order = -1 }],
  ['sectionId null', item => { item.sectionId = null }],
  ['afterSectionId空白', item => { item.afterSectionId = '   ' }],
  ['sectionIdとafterSectionId併記', item => { item.sectionId = 'section-1' }],
]) {
  test(`resetは${name}のBreakを拒否する`, () => {
    const input = fixture()
    edit(input.scheduleItems.find(item => item.kind === 'break'))
    assertInvalidResetWithoutMutation(input)
  })
}

for (const [name, edit] of [
  ['target PA + 他日Stage', input => { input.paAssignments[0].stageId = 'stage-a2' }],
  ['他日PA + target Stage', input => { input.paAssignments[1].stageId = 'stage-a1' }],
  ['foreign Event + target Day', input => { input.paAssignments[0].eventId = 'event-b' }],
  ['target Event + foreign Day', input => { input.paAssignments[2].eventId = input.event.id }],
]) {
  test(`resetはPA ownership矛盾（${name}）を拒否する`, () => {
    const input = fixture()
    edit(input)
    assertInvalidResetWithoutMutation(input)
  })
}

for (const [name, field] of [
  ['PA', 'paAssignments'], ['Duty', 'dutyAssignments'], ['Lock', 'timetableLocks'],
]) {
  test(`resetは${name}の重複IDを拒否する`, () => {
    const input = fixture()
    input[field][1].id = input[field][0].id
    assertInvalidResetWithoutMutation(input)
  })
  test(`resetは${name}の空白IDを拒否する`, () => {
    const input = fixture()
    input[field][0].id = '   '
    assertInvalidResetWithoutMutation(input)
  })
}

for (const [name, edit] of [
  ['PA memberId欠落', input => { delete input.paAssignments[0].memberId }],
  ['PA role不正', input => { input.paAssignments[0].role = 'invalid' }],
  ['PA Boundary edge不正', input => { input.paAssignments[0].from.edge = 'invalid' }],
  ['Duty memberId空白', input => { input.dutyAssignments[0].memberId = '' }],
  ['Duty Boundary edge欠落', input => { delete input.dutyAssignments[0].until.edge }],
  ['Lock position欠落', input => { delete input.timetableLocks[0].position }],
  ['Lock position不正', input => { input.timetableLocks[0].position = { kind: 'index', index: -1 } }],
]) {
  test(`resetは${name}を拒否する`, () => {
    const input = fixture()
    edit(input)
    assertInvalidResetWithoutMutation(input)
  })
}

test('対象日・対象Stageの担当がknown foreign DutyTypeを参照したらreset全体を拒否する', () => {
  const input = createGenerationUiInput()
  input.dutyTypes.push({ id: 'foreign-type', eventId: 'event-b', name: '他Event', order: 0 })
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'cross-event-duty', dutyTypeId: 'foreign-type' })
  const original = structuredClone(input)
  assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
  assert.deepEqual(input, original)
})

for (const [name, eventDayId, stageId] of [
  ['対象日・他日Stage', 'day-a1', 'stage-a2'],
  ['他日・対象Stage', 'day-a2', 'stage-a1'],
]) {
  test(`Dutyの${name}が食い違う場合はresetを拒否し、入力を変更しない`, () => {
    const input = createGenerationUiInput()
    input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'day-stage-mismatch-duty', eventDayId, stageId })
    const original = structuredClone(input)
    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

test('全target Stageとstale Stage上のtarget Band Performanceを削除し、Break全種を保持する', () => {
  const input = fixture()
  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.equal(result.hasChanges, true)
  assert.deepEqual(result.scheduleItems, input.scheduleItems.filter(item => !['old-p1', 'stale-p2'].includes(item.id)))
  assert.deepEqual(result.scheduleItems.filter(item => item.kind === 'break'), input.scheduleItems.filter(item => item.kind === 'break'))
  assert.equal(getUnscheduledEventBandsForEventDay({ ...input, eventId: input.event.id,
    eventDayId: input.eventDay.id, scheduleItems: result.scheduleItems }).length, 2)
})

test('PAはEvent+Day、Dutyは既存ownership helper+Dayで削除し、他日とforeign Eventを保つ', () => {
  const input = fixture()
  input.paAssignments.push({ ...input.paAssignments.find(pa => pa.id === 'pa-b'), id: 'foreign-pa' })
  const result = resetEventDayTimetable(input)
  assert.deepEqual(result.paAssignments.map(pa => pa.id), ['pa-a2', 'pa-b', 'foreign-pa'])
  assert.deepEqual(result.dutyAssignments.map(duty => duty.id), ['other-day-duty', 'foreign-duty'])
})

test('正常な対象日のDuty担当は複数件とも削除し、他日・他Eventの担当は保持する', () => {
  const input = fixture()
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'target-duty-2' })
  const original = structuredClone(input)
  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.dutyAssignments.map(duty => duty.id), ['other-day-duty', 'foreign-duty'])
  assert.deepEqual(input, original)
})

test('target PerformanceのLockとtarget Stageを明示するbroken Lockを削除し、他日/foreign Lockを保持する', () => {
  const input = fixture()
  const result = resetEventDayTimetable(input)
  assert.deepEqual(result.timetableLocks.map(lock => lock.id), ['other-day-lock', 'foreign-lock'])
  assert.ok(result.scheduleItems.some(item => item.id === 'p-a2'))
  assert.ok(result.scheduleItems.some(item => item.id === 'p-b'))
  assert.equal(result.scheduleItems.some(item => item.id === 'old-p1'), false)
})

test('削除対象Performanceを参照するforeign Lockがあれば初期化全体を拒否する', () => {
  const input = fixture()
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'cross-scope-lock',
    eventId: 'event-b', scheduleItemId: 'old-p1', stageId: 'stage-b' })
  const original = structuredClone(input)

  assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
  assert.deepEqual(input, original)
})

for (const [name, stageId] of [
  ['同一Eventの他日Stage', 'stage-a2'],
  ['同一Eventの不明Stage', 'missing-stage'],
]) {
  test(`削除対象Performanceを参照する${name}のLockは保持対象として初期化全体を拒否する`, () => {
    const input = fixture()
    input.timetableLocks.push({ ...input.timetableLocks[0], id: 'conflicting-lock',
      eventId: input.event.id, scheduleItemId: 'old-p1', stageId })
    const original = structuredClone(input)

    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

test('foreign Lockが保持対象のtarget Breakを参照してもBreakとLockを維持する', () => {
  const input = fixture()
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'foreign-break-lock',
    eventId: 'event-b', scheduleItemId: 'break-1', stageId: 'stage-b' })

  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.ok(result.scheduleItems.some(item => item.id === 'break-1'))
  assert.ok(result.timetableLocks.some(lock => lock.id === 'foreign-break-lock'))
})

for (const [name, addReference] of [
  ['foreign PAの開始Boundary', input => {
    input.paAssignments.push({ ...input.paAssignments.find(pa => pa.id === 'pa-b'),
      id: 'cross-scope-pa', from: { kind: "schedule-item", scheduleItemId: 'old-p1', edge: 'start' } })
  }],
  ['other-day PAの終了Boundary', input => {
    input.paAssignments.push({ ...input.paAssignments.find(pa => pa.id === 'pa-a2'),
      id: 'cross-day-pa', until: { kind: "schedule-item", scheduleItemId: 'old-p1', edge: 'end' } })
  }],
  ['foreign Dutyの開始Boundary', input => {
    input.dutyAssignments.find(duty => duty.id === 'foreign-duty').from =
      { scheduleItemId: 'old-p1', edge: 'start' }
  }],
  ['other-day Dutyの終了Boundary', input => {
    input.dutyAssignments.find(duty => duty.id === 'other-day-duty').until =
      { scheduleItemId: 'old-p1', edge: 'end' }
  }],
]) {
  test(`削除対象Performanceを参照する${name}があれば初期化全体を拒否する`, () => {
    const input = fixture()
    addReference(input)
    const original = structuredClone(input)

    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

test('Section/time境界は削除Performance参照と誤判定せずscope外担当を保持する', () => {
  const input = fixture()
  const otherDayPa = input.paAssignments.find(pa => pa.id === 'pa-a2')
  otherDayPa.from = { kind: 'time', time: '10:00' }
  otherDayPa.until = { kind: 'time', time: '10:30' }
  const foreignDuty = input.dutyAssignments.find(duty => duty.id === 'foreign-duty')
  foreignDuty.from = { kind: 'section', sectionId: 'section-1', edge: 'start' }
  foreignDuty.until = { kind: 'section', sectionId: 'section-1', edge: 'end' }
  const original = structuredClone(input)

  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.paAssignments.find(pa => pa.id === 'pa-a2'), otherDayPa)
  assert.deepEqual(result.dutyAssignments.find(duty => duty.id === 'foreign-duty'), foreignDuty)
  assert.deepEqual(input, original)
})

test('target StageのBreakを参照するLockはstaleな他日Stageを指していても削除し、Breakを保持する', () => {
  const input = fixture()
  input.scheduleItems = input.scheduleItems.filter(item => item.kind === 'break')
  input.paAssignments = []
  input.dutyAssignments = []
  input.timetableLocks = [{ ...input.timetableLocks[0], id: 'break-target-lock',
    scheduleItemId: 'break-1', stageId: 'stage-a2' }]
  const original = structuredClone(input)

  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.equal(result.hasChanges, true, 'malformed Lockだけが削除対象でも変更あり')
  assert.deepEqual(result.scheduleItems, input.scheduleItems, 'Break自体は残す')
  assert.deepEqual(result.timetableLocks, [])
  assert.deepEqual(input, original, '入力は変更しない')
})

test('他日Stage上のBreakを参照するLockはstaleなtarget Stageを指していても保持する', () => {
  const input = fixture()
  input.scheduleItems.push({ id: 'break-other-day', kind: 'break', stageId: 'stage-a2',
    title: '他日の休憩', durationMinutes: 5, order: 1 })
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'break-other-day-lock',
    scheduleItemId: 'break-other-day', stageId: 'stage-a1' })

  const result = resetEventDayTimetable(input)
  assert.ok(result.scheduleItems.some(item => item.id === 'break-other-day'))
  assert.ok(result.timetableLocks.some(lock => lock.id === 'break-other-day-lock'))
})

test('参照先item不明のLockだけは保存Stageをfallbackにしてtargetを削除・他日を保持する', () => {
  const input = fixture()
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'missing-other-lock',
    scheduleItemId: 'missing-other-item', stageId: 'stage-a2' })

  const result = resetEventDayTimetable(input)
  assert.equal(result.timetableLocks.some(lock => lock.id === 'broken-target-lock'), false)
  assert.ok(result.timetableLocks.some(lock => lock.id === 'missing-other-lock'))
})

test('foreignまたはother-day Band Performanceはtarget Stageへ誤配置されていても削除しない', () => {
  const input = fixture()
  input.scheduleItems.push({ id: 'foreign-on-target', kind: 'performance', eventBandId: 'band-b', stageId: 'stage-a1', order: 8 },
    { id: 'other-day-on-target', kind: 'performance', eventBandId: 'band-a2', stageId: 'stage-a1', order: 9 })
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'foreign-ref', scheduleItemId: 'foreign-on-target' },
    { ...input.timetableLocks[0], id: 'other-day-ref', scheduleItemId: 'other-day-on-target' })
  const result = resetEventDayTimetable(input)
  assert.ok(result.scheduleItems.some(item => item.id === 'foreign-on-target'))
  assert.ok(result.scheduleItems.some(item => item.id === 'other-day-on-target'))
  assert.ok(result.timetableLocks.some(lock => lock.id === 'foreign-ref'))
  assert.ok(result.timetableLocks.some(lock => lock.id === 'other-day-ref'))
})

test('missing BandのPerformanceがtarget Stage上にある場合は所有者を推測せず初期化を拒否する', () => {
  const input = fixture()
  input.scheduleItems.push({ id: 'missing-band-p', kind: 'performance', eventBandId: 'missing-band', stageId: 'stage-a1', order: 5 })
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'missing-band-lock', scheduleItemId: 'missing-band-p' })
  const original = structuredClone(input)
  const result = resetEventDayTimetable(input)
  assert.deepEqual(result, { ok: false, code: 'INVALID_SCOPE' })
  assert.deepEqual(input, original)
})

test('missing BandのPerformanceが非対象Stage上にある場合は保持する', () => {
  const input = fixture()
  const missing = { id: 'missing-band-p', kind: 'performance', eventBandId: 'missing-band',
    stageId: 'stage-a2', order: 5 }
  input.scheduleItems.push(missing)
  const result = resetEventDayTimetable(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.scheduleItems.find(item => item.id === missing.id), missing)
})

test('missing DutyTypeでも既存helperがtarget Eventへ帰属させる担当は初期化する', () => {
  const input = fixture()
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'missing-type-duty', dutyTypeId: 'missing-type' })
  assert.equal(resetEventDayTimetable(input).dutyAssignments.some(duty => duty.id === 'missing-type-duty'), false)
})

test('Breakしかない対象日では初期化対象なし、PA/Duty/Lockのみでも対象あり', () => {
  const input = fixture()
  input.scheduleItems = input.scheduleItems.filter(item => item.kind === 'break')
  input.paAssignments = []
  input.dutyAssignments = []
  input.timetableLocks = []
  assert.equal(resetEventDayTimetable(input).hasChanges, false)
  for (const field of ['paAssignments', 'dutyAssignments', 'timetableLocks']) {
    const withOne = { ...input, [field]: fixture()[field].slice(0, 1) }
    assert.equal(resetEventDayTimetable(withOne).hasChanges, true, field)
  }
})

for (const [name, edit] of [
  ['Event所有者不一致', input => { input.eventDay = { ...input.eventDay, eventId: 'event-b' } }],
  ['開催日なし', input => { input.eventDays = [] }],
  ['EventDay ID reuse', input => { input.eventDays.push({ ...input.eventDay, eventId: 'event-b' }) }],
  ['Stage ID reuse', input => { input.stages.push({ ...input.stages[0], eventDayId: 'day-b' }) }],
  ['Band ID reuse', input => { input.eventBands.push({ ...input.eventBands[0], eventId: 'event-b' }) }],
  ['DutyType ID reuse', input => { input.dutyTypes.push({ ...input.dutyTypes[0], eventId: 'event-b' }) }],
  ['ScheduleItem ID reuse', input => { input.scheduleItems.push({ ...input.scheduleItems[0], stageId: 'stage-b', eventBandId: 'band-b' }) }],
]) {
  test(`曖昧なreset scope（${name}）は失敗し、foreign entityを含め何も変更しない`, () => {
    const input = fixture()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['EventDayの数値ID', input => { input.eventDays[0].id = 123 }],
  ['Stageのnull ID', input => { input.stages[0].id = null }],
  ['EventBandの空白ID', input => { input.eventBands[0].id = '   ' }],
  ['ScheduleItemの空ID', input => { input.scheduleItems[0].id = '' }],
  ['DutyTypeのobject ID', input => { input.dutyTypes[0].id = {} }],
  ['Stage collectionのnull要素', input => { input.stages.push(null) }],
  ['Stage collection自体がnull', input => { input.stages = null }],
  ['EventDay collectionのundefined要素', input => { input.eventDays.unshift(undefined) }],
  ['tabのみのID', input => { input.eventBands[0].id = '\t' }],
  ['改行のみのID', input => { input.eventBands[0].id = '\n' }],
  ['boolean ID', input => { input.stages[0].id = true }],
  ['array ID', input => { input.stages[0].id = [] }],
  ['IDなし要素', input => { input.stages.push({ name: '不正Stage' }) }],
]) {
  test(`runtime不正な${name}はthrowせずINVALID_SCOPEで初期化を止める`, () => {
    const input = fixture()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['Event ID', input => { input.event.id = 123 }],
  ['EventDay ID', input => { input.eventDay.id = null }],
  ['EventDay eventId', input => { input.eventDay.eventId = '   ' }],
  ['Event自体', input => { input.event = null }],
  ['EventDay自体', input => { input.eventDay = null }],
]) {
  test(`runtime不正な単体${name}もthrowせずINVALID_SCOPEにする`, () => {
    const input = fixture()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['other EventDay.eventIdの空白', input => { input.eventDays.find(day => day.id === 'day-a2').eventId = '   ' }],
  ['Stage.eventDayIdの空白', input => { input.stages[0].eventDayId = '   ' }],
  ['EventBand.eventIdの空白', input => { input.eventBands[0].eventId = '   ' }],
  ['EventBand.eventDayIdの空文字', input => { input.eventBands[0].eventDayId = '' }],
  ['Performance.stageIdの空白', input => { input.scheduleItems.find(item => item.kind === 'performance').stageId = '   ' }],
  ['Break.stageIdのnull', input => { input.scheduleItems.find(item => item.kind === 'break').stageId = null }],
  ['Performance.eventBandIdの空白', input => { input.scheduleItems.find(item => item.kind === 'performance').eventBandId = '   ' }],
  ['DutyType.eventIdの空白', input => { input.dutyTypes[0].eventId = '   ' }],
  ['PA.eventIdの空白', input => { input.paAssignments[0].eventId = '   ' }],
  ['PA.eventDayIdの空白', input => { input.paAssignments[0].eventDayId = '   ' }],
  ['PA.from.scheduleItemIdの空文字', input => { input.paAssignments[0].from.scheduleItemId = '' }],
  ['PA.until.scheduleItemIdの数値', input => { input.paAssignments[0].until.scheduleItemId = 123 }],
  ['PA.fromのnull', input => { input.paAssignments[0].from = null }],
  ['PA.untilのundefined', input => { input.paAssignments[0].until = undefined }],
  ['Duty.dutyTypeIdの空白', input => { input.dutyAssignments[0].dutyTypeId = '   ' }],
  ['Duty.eventDayIdの空文字', input => { input.dutyAssignments[0].eventDayId = '' }],
  ['Duty.stageIdのnull', input => { input.dutyAssignments[0].stageId = null }],
  ['Duty.from.scheduleItemIdの空白', input => { input.dutyAssignments[0].from.scheduleItemId = '   ' }],
  ['Duty.until.scheduleItemIdのobject', input => { input.dutyAssignments[0].until.scheduleItemId = {} }],
  ['Duty.fromのnull', input => { input.dutyAssignments[0].from = null }],
  ['Duty.untilのundefined', input => { input.dutyAssignments[0].until = undefined }],
  ['Lock.eventIdの空白', input => { input.timetableLocks[0].eventId = '   ' }],
  ['Lock.scheduleItemIdの空白', input => { input.timetableLocks[0].scheduleItemId = '   ' }],
  ['Lock.stageIdの空文字', input => { input.timetableLocks[0].stageId = '' }],
  ['Lock.sectionIdの空白', input => { input.timetableLocks[0].sectionId = '   ' }],
  ['PA collectionのnull要素', input => { input.paAssignments.push(null) }],
  ['Duty collection自体がnull', input => { input.dutyAssignments = null }],
  ['Lock collectionのnull要素', input => { input.timetableLocks.push(null) }],
]) {
  test(`runtime不正な参照（${name}）はthrowせずINVALID_SCOPEで初期化を止める`, () => {
    const input = fixture()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(resetEventDayTimetable(input), { ok: false, code: 'INVALID_SCOPE' })
    assert.deepEqual(input, original)
  })
}

test('resetはdeterministic・non-mutationで、EventBandの条件とDutyTypeもそのまま保持する', () => {
  const input = fixture()
  input.eventBands[0].availableTimeRange = { from: '09:00' }
  input.eventBands[0].preferredTimeRange = { until: '17:00' }
  const original = structuredClone(input)
  const first = resetEventDayTimetable(input)
  assert.deepEqual(first, resetEventDayTimetable(input))
  assert.deepEqual(input, original)
  for (const field of ['scheduleItems', 'paAssignments', 'dutyAssignments', 'timetableLocks']) {
    assert.notEqual(first[field], input[field])
  }
})

test('2日開催デモreset後は全BandがPoolへ戻り、他日・Break・master・出演条件を保持してreloadできる', () => {
  const data = createDemoData()
  const event = data.events.find(event => event.id === GENERATION_DEMO_EVENT_ID)
  const eventDay = data.eventDays.find(day => day.eventId === event.id)
  const original = structuredClone(data)
  const result = resetEventDayTimetable({ ...data, event, eventDay })
  assert.equal(result.ok, true)
  const targetStageIds = new Set(data.stages.filter(stage => stage.eventDayId === eventDay.id).map(stage => stage.id))
  assert.deepEqual(result.scheduleItems.filter(item => !targetStageIds.has(item.stageId)), data.scheduleItems.filter(item => !targetStageIds.has(item.stageId)))
  assert.deepEqual(result.paAssignments.filter(pa => pa.eventDayId !== eventDay.id), data.paAssignments.filter(pa => pa.eventDayId !== eventDay.id))
  assert.deepEqual(result.dutyAssignments.filter(duty => duty.eventDayId !== eventDay.id), data.dutyAssignments.filter(duty => duty.eventDayId !== eventDay.id))
  assert.equal(getUnscheduledEventBandsForEventDay({ ...data, ...result, eventId: event.id, eventDayId: eventDay.id }).length, 4)
  const restored = parsePersistedState(serializePersistedState({ ...data, ...result }))
  assert.ok(restored)
  assert.deepEqual(restored.eventBands, data.eventBands)
  assert.deepEqual(restored.dutyTypes, data.dutyTypes)
  assert.deepEqual(data, original)
})

test('デモの撮影担当削除後なら部内OFFで生成・適用でき、手順どおり掛け持ち解消後は部間OFFも適用できる', () => {
  for (const removeInter of [false, true]) {
    const data = createDemoData()
    const event = data.events.find(event => event.id === GENERATION_DEMO_EVENT_ID)
    const eventDay = data.eventDays.find(day => day.eventId === event.id)
    const reset = resetEventDayTimetable({ ...data, event, eventDay })
    if (removeInter) {
      data.eventBands = data.eventBands.map(band => band.id === 'eb-demo-generation-1-2'
        ? { ...band, memberIds: ['member-demo-09', 'member-demo-10'] } : band)
    }
    const input = { ...data, ...reset, event, eventDay }
    input.scheduleItems = createScheduleItemsForTimetableGeneration({ ...input,
      options: { keepIntraSectionBreaks: false, keepInterSectionBreaks: !removeInter } })
    const generated = generateTimetablePlan(input)
    assert.equal(generated.ok, true, JSON.stringify(generated))
    const candidate = materializeTimetableGenerationPlan({ ...input, sourceScheduleItems: reset.scheduleItems,
      plan: generated.plan,
      newScheduleItemIds: generated.plan.placements.map((_, i) => `reset-demo-p-${i}`),
      newPaAssignmentIds: generated.plan.paShifts.map((_, i) => `reset-demo-pa-${i}`) })
    assert.equal(candidate.ok, true)
    assert.equal(validateTimetableGenerationCandidate({ ...input, plan: generated.plan }, candidate).ok, true)
    assert.equal(candidate.scheduleItems.some(item => item.id === 'break-demo-generation-inside'), false)
    if (removeInter) assert.equal(candidate.scheduleItems.some(item => item.id === 'break-demo-generation-between-1'), false)
    assert.ok(candidate.scheduleItems.some(item => item.id === 'break-demo-generation-sub2'), '別日の通常休憩は保持')
  }
})
