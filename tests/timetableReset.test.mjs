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
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'other-day-duty', eventDayId: 'day-a2', stageId: 'stage-a2' },
    { ...input.dutyAssignments[0], id: 'foreign-duty', dutyTypeId: 'foreign-type' })
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'stale-stage-lock', scheduleItemId: 'stale-p2', stageId: 'missing-stage' },
    { ...input.timetableLocks[0], id: 'broken-target-lock', scheduleItemId: 'missing-item' },
    { ...input.timetableLocks[0], id: 'other-day-lock', scheduleItemId: 'p-a2', stageId: 'stage-a2', sectionId: undefined },
    { ...input.timetableLocks[0], id: 'foreign-lock', eventId: 'event-b',
      scheduleItemId: 'p-b', stageId: 'stage-b', sectionId: undefined })
  return input
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
  input.paAssignments.push({ ...input.paAssignments[0], id: 'foreign-pa-same-day', eventId: 'event-b',
    from: { scheduleItemId: 'p-b', edge: 'start' }, until: { scheduleItemId: 'p-b', edge: 'end' } })
  const result = resetEventDayTimetable(input)
  assert.deepEqual(result.paAssignments.map(pa => pa.id), ['pa-a2', 'pa-b', 'foreign-pa-same-day'])
  assert.deepEqual(result.dutyAssignments.map(duty => duty.id), ['other-day-duty', 'foreign-duty'])
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
      id: 'cross-scope-pa', from: { scheduleItemId: 'old-p1', edge: 'start' } })
  }],
  ['other-day PAの終了Boundary', input => {
    input.paAssignments.push({ ...input.paAssignments.find(pa => pa.id === 'pa-a2'),
      id: 'cross-day-pa', until: { scheduleItemId: 'old-p1', edge: 'end' } })
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

test('missing Bandでもtarget Stageから判定できるPerformanceと対応Lockは初期化できる', () => {
  const input = fixture()
  input.scheduleItems.push({ id: 'missing-band-p', kind: 'performance', eventBandId: 'missing-band', stageId: 'stage-a1', order: 5 })
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'missing-band-lock', scheduleItemId: 'missing-band-p' })
  const result = resetEventDayTimetable(input)
  assert.equal(result.scheduleItems.some(item => item.id === 'missing-band-p'), false)
  assert.equal(result.timetableLocks.some(lock => lock.id === 'missing-band-lock'), false)
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
    const candidate = materializeTimetableGenerationPlan({ ...input, plan: generated.plan,
      newScheduleItemIds: generated.plan.placements.map((_, i) => `reset-demo-p-${i}`),
      newPaAssignmentIds: generated.plan.paShifts.map((_, i) => `reset-demo-pa-${i}`) })
    assert.equal(candidate.ok, true)
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
    assert.equal(candidate.scheduleItems.some(item => item.id === 'break-demo-generation-inside'), false)
    if (removeInter) assert.equal(candidate.scheduleItems.some(item => item.id === 'break-demo-generation-between-1'), false)
    assert.ok(candidate.scheduleItems.some(item => item.id === 'break-demo-generation-sub2'), '別日の通常休憩は保持')
  }
})
