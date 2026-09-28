import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduleItemsForTimetableGeneration, DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS } from '../src/domain/timetableGenerationOptions.ts'
import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'
import { createGenerationUiInput } from './fixtures/timetableGenerationUi.mjs'

const fixture = () => {
  const input = createGenerationUiInput()
  input.scheduleItems.push(
    { id: 'inside', kind: 'break', title: '部内休憩', durationMinutes: 5, stageId: 'stage-a1', sectionId: 'section-2', order: 1 },
    { id: 'plain', kind: 'break', title: '通常休憩', durationMinutes: 5, stageId: 'stage-sub', order: 0 },
    { id: 'other-day', kind: 'break', title: '翌日休憩', durationMinutes: 5, stageId: 'stage-a2', order: 0 },
    { id: 'foreign', kind: 'break', title: '他Event休憩', durationMinutes: 5, stageId: 'stage-b', order: 0 },
  )
  return input
}
const filtered = (input, options) => createScheduleItemsForTimetableGeneration({ ...input, options })

test('生成UI optionは初回両方ONで、同値の新配列を返す', () => {
  assert.deepEqual(DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS, { keepIntraSectionBreaks: true, keepInterSectionBreaks: true })
  const input = fixture()
  const result = filtered(input, DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS)
  assert.deepEqual(result, input.scheduleItems)
  assert.notEqual(result, input.scheduleItems)
})

for (const [name, options, removed] of [
  ['部内OFF', { keepIntraSectionBreaks: false, keepInterSectionBreaks: true }, ['inside']],
  ['部間OFF', { keepIntraSectionBreaks: true, keepInterSectionBreaks: false }, ['break-1']],
  ['両方OFF', { keepIntraSectionBreaks: false, keepInterSectionBreaks: false }, ['inside', 'break-1']],
]) {
  test(`${name}は対象日だけに作用し、Sectionなし・他日・他EventのBreakとPerformanceを保つ`, () => {
    const input = fixture()
    const original = structuredClone(input)
    assert.deepEqual(filtered(input, options), input.scheduleItems.filter(item => !removed.includes(item.id)))
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['両配置指定', item => { item.sectionId = 'section-1' }],
  ['存在しないSection', item => { item.afterSectionId = 'missing' }],
  ['最終Section', item => { item.afterSectionId = 'section-2' }],
  ['両配置未指定', item => { delete item.afterSectionId }],
  ['duration不正', item => { item.durationMinutes = 0 }],
]) {
  test(`malformed Break（${name}）をOFFでも隠さず、core validationで拒否する`, () => {
    const input = createGenerationUiInput()
    edit(input.scheduleItems.find(item => item.id === 'break-1'))
    input.scheduleItems = filtered(input, { keepIntraSectionBreaks: false, keepInterSectionBreaks: false })
    assert.ok(input.scheduleItems.some(item => item.id === 'break-1'))
    const result = generateTimetablePlan(input)
    assert.equal(result.ok, false)
    assert.equal(result.failure.code, 'INVALID_INPUT')
  })
}

test('非canonicalなorderを持つBreakもOFF filteringで隠さず、既存coreへ渡す', () => {
  const input = fixture()
  input.scheduleItems.find(item => item.id === 'inside').order = NaN
  assert.ok(filtered(input, { keepIntraSectionBreaks: false, keepInterSectionBreaks: false }).some(item => item.id === 'inside'))
})

test('重複ScheduleItem IDを持つBreakをOFF filteringで消して修復しない', () => {
  const input = fixture()
  input.scheduleItems.push({ ...input.scheduleItems.find(item => item.id === 'inside'), stageId: 'stage-b' })
  const original = structuredClone(input)
  const result = filtered(input, { keepIntraSectionBreaks: false, keepInterSectionBreaks: false })
  assert.equal(result.filter(item => item.id === 'inside').length, 2)
  assert.deepEqual(input, original)
})

test('別StageのSectionを参照するBreakも削除optionで修復しない', () => {
  const input = fixture()
  input.sections.push({ id: 'foreign-section', stageId: 'stage-b', name: '他Eventの部', order: 0 })
  input.scheduleItems.find(item => item.id === 'inside').sectionId = 'foreign-section'
  assert.ok(filtered(input, { keepIntraSectionBreaks: false, keepInterSectionBreaks: false }).some(item => item.id === 'inside'))
})

test('所属が曖昧なreused Stage IDやforeign EventDayではoptionを適用しない', () => {
  const input = fixture()
  input.stages.push({ ...input.stages.find(stage => stage.id === 'stage-a1'), eventDayId: 'day-b' })
  assert.deepEqual(filtered(input, { keepIntraSectionBreaks: false, keepInterSectionBreaks: false }), input.scheduleItems)
  input.eventDay = { ...input.eventDay, eventId: 'event-b' }
  assert.deepEqual(filtered(input, { keepIntraSectionBreaks: false, keepInterSectionBreaks: false }), input.scheduleItems)
})

test('Dutyが除外Breakを参照する場合は生成を止め、Duty/元TTを変更しない', () => {
  const input = createGenerationUiInput()
  const original = structuredClone(input)
  const generationItems = filtered(input, { keepIntraSectionBreaks: true, keepInterSectionBreaks: false })
  const result = generateTimetablePlan({ ...input, scheduleItems: generationItems })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'BROKEN_DUTY_ASSIGNMENT')
  assert.deepEqual(input, original)
})

test('同じbaselineを生成・materialization・最終検証へ渡し、除外Breakを復活させない', () => {
  const original = fixture()
  const input = { ...original, scheduleItems: filtered(original, { keepIntraSectionBreaks: false, keepInterSectionBreaks: true }) }
  const result = generateTimetablePlan(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  const candidate = materializeTimetableGenerationPlan({ ...input, plan: result.plan,
    newScheduleItemIds: result.plan.placements.filter(p => !p.scheduleItemId).map((_, i) => `option-p-${i}`),
    newPaAssignmentIds: result.plan.paShifts.map((_, i) => `option-pa-${i}`) })
  assert.equal(candidate.ok, true)
  assert.equal(candidate.scheduleItems.some(item => item.id === 'inside'), false)
  assert.ok(candidate.scheduleItems.some(item => item.id === 'break-1'))
  assert.ok(candidate.scheduleItems.some(item => item.id === 'plain'))
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
  assert.ok(original.scheduleItems.some(item => item.id === 'inside'), '適用前の元TTは変更されない')
})
