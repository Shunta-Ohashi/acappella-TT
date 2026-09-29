import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduleItemsForTimetableGeneration, DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS,
  hasValidTimetableGenerationPreprocessingInput, hasValidTimetableGenerationScheduleItems,
  hasValidTimetableGenerationLocks,
  validateTimetableGenerationBaseline,
  validateTimetableGenerationBreakRemoval } from '../src/domain/timetableGenerationOptions.ts'
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
const validateBreakRemoval = (input, options) => validateTimetableGenerationBreakRemoval({
  event: input.event, eventDay: input.eventDay,
  originalScheduleItems: input.scheduleItems, generationScheduleItems: filtered(input, options),
  paAssignments: input.paAssignments, dutyAssignments: input.dutyAssignments,
  timetableLocks: input.timetableLocks,
})
const withoutInterBreak = { keepIntraSectionBreaks: true, keepInterSectionBreaks: false }

const malformedScheduleItems = [
  ['orphan', { id: 'orphan' }],
  ['missing stageId', { id: 'bad-p', kind: 'performance', eventBandId: 'band-1', order: 0 }],
  ['missing order', { id: 'bad-p', kind: 'performance', eventBandId: 'band-1', stageId: 'stage-a1' }],
  ['missing eventBandId', { id: 'bad-p', kind: 'performance', stageId: 'stage-a1', order: 0 }],
  ['unknown kind', { id: 'bad', kind: 'unknown', stageId: 'stage-a1', order: 0 }],
  ['missing Break fields', { id: 'bad-b', kind: 'break', stageId: 'stage-a1', order: 0 }],
  ...[undefined, null, '0', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
    .map(order => [`order ${String(order)}`, { id: 'bad-p', kind: 'performance',
      eventBandId: 'band-1', stageId: 'stage-a1', order }]),
  ...['', '   ', 123].map(sectionId => [`sectionId ${String(sectionId)}`,
    { id: 'bad-p', kind: 'performance', eventBandId: 'band-1', stageId: 'stage-a1', order: 0, sectionId }]),
  ...['', '   ', 123].map(afterSectionId => [`afterSectionId ${String(afterSectionId)}`,
    { id: 'bad-b', kind: 'break', title: '', durationMinutes: 5,
      stageId: 'stage-a1', order: 0, afterSectionId }]),
  ['performance afterSectionId', { id: 'bad-p', kind: 'performance', eventBandId: 'band-1',
    stageId: 'stage-a1', order: 0, afterSectionId: 'section-1' }],
]

for (const [name, malformed] of malformedScheduleItems) {
  test(`ScheduleItem ${name}は前処理とbaselineで拒否し、direct filterでは保持する`, () => {
    const input = fixture()
    const source = [...input.scheduleItems, malformed]
    const original = structuredClone(source)
    assert.equal(hasValidTimetableGenerationScheduleItems(source), false)
    assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input,
      scheduleItems: source, options: withoutInterBreak }), false)
    assert.equal(createScheduleItemsForTimetableGeneration({ ...input,
      scheduleItems: source, options: withoutInterBreak }), source)
    const baseline = { event: input.event, eventDay: input.eventDay, eventDays: input.eventDays,
      stages: input.stages, sections: input.sections }
    assert.equal(validateTimetableGenerationBaseline({ ...baseline, sourceScheduleItems: source,
      generationScheduleItems: source }), false)
    assert.equal(validateTimetableGenerationBaseline({ ...baseline, sourceScheduleItems: input.scheduleItems,
      generationScheduleItems: source }), false)
    assert.deepEqual(source, original)
  })
}

for (const [name, duplicate] of [
  ['Performance同士', items => ({ ...items.find(item => item.id === 'old-p1'), eventBandId: 'band-2' })],
  ['PerformanceとBreak', items => ({ ...items.find(item => item.id === 'break-1'), id: 'old-p1' })],
  ['同内容clone', items => ({ ...items.find(item => item.id === 'old-p1') })],
  ['他日Performance', items => ({ ...items.find(item => item.id === 'p-a2'), id: 'old-p1' })],
  ['別Event Break', items => ({ ...items.find(item => item.id === 'foreign'), id: 'old-p1' })],
]) {
  test(`ScheduleItem ID重複（${name}）はpreflight・baselineで拒否し、直接前処理では消さない`, () => {
    const input = fixture()
    const scheduleItems = [...input.scheduleItems, duplicate(input.scheduleItems)]
    const original = structuredClone(scheduleItems)
    const options = { keepIntraSectionBreaks: false, keepInterSectionBreaks: false }
    assert.equal(hasValidTimetableGenerationScheduleItems(scheduleItems), false)
    assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input, scheduleItems, options }), false)
    assert.equal(createScheduleItemsForTimetableGeneration({ ...input, scheduleItems, options }), scheduleItems)
    assert.equal(scheduleItems.filter(item => item.id === 'old-p1').length, 2)
    const scope = { event: input.event, eventDay: input.eventDay, eventDays: input.eventDays,
      stages: input.stages, sections: input.sections }
    assert.equal(validateTimetableGenerationBaseline({ ...scope, sourceScheduleItems: scheduleItems,
      generationScheduleItems: input.scheduleItems }), false)
    assert.equal(validateTimetableGenerationBaseline({ ...scope, sourceScheduleItems: input.scheduleItems,
      generationScheduleItems: scheduleItems }), false)
    assert.deepEqual(scheduleItems, original)
  })
}

test('IDが一意な対象日・他日・別EventのScheduleItemは前処理を通過する', () => {
  const input = fixture()
  assert.equal(hasValidTimetableGenerationScheduleItems(input.scheduleItems), true)
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input,
    options: DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS }), true)
})

for (const [name, edit] of [
  ['ID欠落', lock => { delete lock.id }],
  ['ID null', lock => { lock.id = null }],
  ['ID空白', lock => { lock.id = '   ' }],
  ['eventId欠落', lock => { delete lock.eventId }],
  ['eventId null', lock => { lock.eventId = null }],
  ['stageId欠落', lock => { delete lock.stageId }],
  ['stageId空白', lock => { lock.stageId = ' ' }],
  ['scheduleItemId欠落', lock => { delete lock.scheduleItemId }],
  ['scheduleItemId空白', lock => { lock.scheduleItemId = ' ' }],
  ['sectionId不正', lock => { lock.sectionId = null }],
  ['position欠落', lock => { delete lock.position }],
  ['position不正', lock => { lock.position = { kind: 'index', index: -1 } }],
]) {
  test(`Lock ${name}はpreflightで拒否する`, () => {
    const input = fixture()
    edit(input.timetableLocks[0])
    const original = structuredClone(input)
    assert.equal(hasValidTimetableGenerationLocks(input.timetableLocks), false)
    assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input,
      options: DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS }), false)
    assert.deepEqual(input, original)
  })
}

test('Lock ID重複は拒否し、一意な他日・別Event Lockは許可する', () => {
  const input = fixture()
  const otherDay = { ...input.timetableLocks[0], id: 'lock-a2', scheduleItemId: 'p-a2',
    stageId: 'stage-a2', sectionId: undefined }
  const foreign = { ...otherDay, id: 'lock-b', eventId: 'event-b',
    stageId: 'stage-b', scheduleItemId: 'p-b' }
  input.timetableLocks.push(otherDay, foreign)
  assert.equal(hasValidTimetableGenerationLocks(input.timetableLocks), true)
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input,
    options: DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS }), true)
  input.timetableLocks.push({ ...foreign, id: otherDay.id })
  assert.equal(hasValidTimetableGenerationLocks(input.timetableLocks), false)
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input,
    options: DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS }), false)
})

test('生成UI optionは初回両方ONで、同値の新配列を返す', () => {
  assert.deepEqual(DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS, { keepIntraSectionBreaks: true, keepInterSectionBreaks: true })
  const input = fixture()
  const result = filtered(input, DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS)
  assert.deepEqual(result, input.scheduleItems)
  assert.notEqual(result, input.scheduleItems)
  assert.deepEqual(validateBreakRemoval(input, DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS), { ok: true })
})

for (const [name, eventId] of [['target Lock', 'event-a'], ['foreign Lock', 'event-b']]) {
  test(`除外する部間Breakを参照する${name}は生成前に拒否し、入力を変更しない`, () => {
    const input = createGenerationUiInput()
    input.dutyAssignments = []
    input.timetableLocks.push({ ...input.timetableLocks[0], id: 'break-lock',
      eventId, scheduleItemId: 'break-1' })
    const original = structuredClone(input)
    assert.deepEqual(validateBreakRemoval(input, withoutInterBreak),
      { ok: false, code: 'CROSS_SCOPE_BREAK_REFERENCE' })
    assert.deepEqual(input, original)
  })
}

test('除外する部内Breakを参照するLockも生成前に拒否する', () => {
  const input = fixture()
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'inside-break-lock',
    scheduleItemId: 'inside' })
  const original = structuredClone(input)
  assert.deepEqual(validateBreakRemoval(input,
    { keepIntraSectionBreaks: false, keepInterSectionBreaks: true }),
    { ok: false, code: 'CROSS_SCOPE_BREAK_REFERENCE' })
  assert.deepEqual(input, original)
})

test('除外するBreakを参照するtarget Dutyは生成前に拒否する', () => {
  const input = createGenerationUiInput()
  const original = structuredClone(input)
  assert.deepEqual(validateBreakRemoval(input, withoutInterBreak),
    { ok: false, code: 'CROSS_SCOPE_BREAK_REFERENCE' })
  assert.deepEqual(input, original)
})

for (const [name, edit] of [
  ['other-day Duty', input => {
    input.dutyAssignments[0] = { ...input.dutyAssignments[0], eventDayId: 'day-a2', stageId: 'stage-a2' }
  }],
  ['foreign Duty', input => {
    input.dutyAssignments[0] = { ...input.dutyAssignments[0], eventDayId: 'day-b', stageId: 'stage-b' }
  }],
]) {
  test(`除外するBreakを参照する${name}は生成前に拒否する`, () => {
    const input = createGenerationUiInput()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(validateBreakRemoval(input, withoutInterBreak),
      { ok: false, code: 'CROSS_SCOPE_BREAK_REFERENCE' })
    assert.deepEqual(input, original)
  })
}

test('除外するBreakを参照するtarget-day PAは全置換されるため許可する', () => {
  const input = createGenerationUiInput()
  input.dutyAssignments = []
  input.paAssignments.push({ ...input.paAssignments[0], id: 'target-break-pa',
    from: { scheduleItemId: 'break-1', edge: 'start' } })
  const original = structuredClone(input)
  assert.deepEqual(validateBreakRemoval(input, withoutInterBreak), { ok: true })
  assert.deepEqual(input, original)
})

for (const [name, createPa] of [
  ['other-day PA', input => ({ ...input.paAssignments.find(pa => pa.id === 'pa-a2'),
    id: 'other-day-break-pa', from: { scheduleItemId: 'break-1', edge: 'start' } })],
  ['foreign PA', input => ({ ...input.paAssignments.find(pa => pa.id === 'pa-b'),
    id: 'foreign-break-pa', until: { scheduleItemId: 'break-1', edge: 'end' } })],
]) {
  test(`除外するBreakを参照する保持対象${name}は生成前に拒否する`, () => {
    const input = createGenerationUiInput()
    input.dutyAssignments = []
    input.paAssignments.push(createPa(input))
    const original = structuredClone(input)
    assert.deepEqual(validateBreakRemoval(input, withoutInterBreak),
      { ok: false, code: 'CROSS_SCOPE_BREAK_REFERENCE' })
    assert.deepEqual(input, original)
  })
}

test('除外対象以外のBreakやPerformanceだけを参照する保持データは許可する', () => {
  const input = fixture()
  input.dutyAssignments[0] = { ...input.dutyAssignments[0],
    from: { scheduleItemId: 'plain', edge: 'start' }, until: { scheduleItemId: 'plain', edge: 'end' } }
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'other-break-lock',
    eventId: 'event-b', scheduleItemId: 'other-day' })
  const original = structuredClone(input)
  assert.deepEqual(validateBreakRemoval(input, withoutInterBreak), { ok: true })
  assert.deepEqual(input, original)
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
  const candidate = materializeTimetableGenerationPlan({ ...input, sourceScheduleItems: original.scheduleItems,
    plan: result.plan,
    newScheduleItemIds: result.plan.placements.filter(p => !p.scheduleItemId).map((_, i) => `option-p-${i}`),
    newPaAssignmentIds: result.plan.paShifts.map((_, i) => `option-pa-${i}`) })
  assert.equal(candidate.ok, true)
  assert.equal(candidate.scheduleItems.some(item => item.id === 'inside'), false)
  assert.ok(candidate.scheduleItems.some(item => item.id === 'break-1'))
  assert.ok(candidate.scheduleItems.some(item => item.id === 'plain'))
  assert.equal(validateTimetableGenerationCandidate({ ...input, plan: result.plan }, candidate).ok, true)
  assert.ok(original.scheduleItems.some(item => item.id === 'inside'), '適用前の元TTは変更されない')
})

for (const [field, value] of [
    ['scheduleItems', null], ['scheduleItems', [null]], ['scheduleItems', [undefined]],
    ['scheduleItems', [{}]], ['eventDays', [null]], ['stages', [null]], ['sections', [null]],
    ['eventDays', null], ['stages', null], ['sections', null], ['event', null],
    ['eventDay', null], ['options', null],
]) {
  test(`option前処理は${field}=${value === undefined ? 'undefined' : JSON.stringify(value)}でthrowせずScheduleItemを削除しない`, () => {
    const input = fixture()
    const scope = { ...input, options: withoutInterBreak, [field]: value }
    assert.doesNotThrow(() => createScheduleItemsForTimetableGeneration(scope), field)
    if (field === 'scheduleItems') {
      assert.deepEqual(createScheduleItemsForTimetableGeneration(scope), value, '不正なitemを削除しない')
    }
  })
}

test('生成前preflightは正常な参照のみ通し、不正なitem・Boundary・optionを拒否する', () => {
  const input = fixture()
  const options = withoutInterBreak
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input, options }), true)
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input, scheduleItems: [null], options }), false)
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input, options: null }), false)
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input,
    dutyAssignments: [{ ...input.dutyAssignments[0], from: null }], options }), false)
})

test('生成前preflightはDutyType不正形を拒否し、別Eventの正常DutyTypeは許可する', () => {
  const input = fixture()
  const options = DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS
  for (const dutyTypes of [null, [null], [{}], [{ id: '', eventId: input.event.id }],
    [{ id: 'duty-x', eventId: '  ' }]]) {
    assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input, dutyTypes, options }), false)
  }
  assert.equal(hasValidTimetableGenerationPreprocessingInput({ ...input, options,
    dutyTypes: [...input.dutyTypes, { id: 'foreign-type', eventId: 'other-event' }] }), true)
})

for (const [name, mutate] of [
    ['PA from null', input => { input.paAssignments[0].from = null }],
    ['PA until null', input => { input.paAssignments[0].until = null }],
    ['PA from undefined', input => { input.paAssignments[0].from = undefined }],
    ['PA until empty', input => { input.paAssignments[0].until = {} }],
    ['Duty from null', input => { input.dutyAssignments[0].from = null }],
    ['Duty until undefined', input => { input.dutyAssignments[0].until = undefined }],
    ['Lock null', input => { input.timetableLocks = [null] }],
    ['Lock itemId null', input => { input.timetableLocks[0].scheduleItemId = null }],
    ['original item null', input => { input.scheduleItems = [null] }],
]) {
  test(`Break除外判定は${name}をstructured failureにする`, () => {
    const input = createGenerationUiInput()
    mutate(input)
    const original = structuredClone(input)
    const result = validateTimetableGenerationBreakRemoval({
      event: input.event, eventDay: input.eventDay,
      originalScheduleItems: input.scheduleItems,
      generationScheduleItems: input.scheduleItems,
      paAssignments: input.paAssignments, dutyAssignments: input.dutyAssignments,
      timetableLocks: input.timetableLocks,
    })
    assert.deepEqual(result, { ok: false, code: 'INVALID_REFERENCE_SHAPE' })
    assert.deepEqual(input, original)
  })
}
test('Break除外判定はgeneration item nullをstructured failureにする', () => {
  const input = createGenerationUiInput()
  assert.deepEqual(validateTimetableGenerationBreakRemoval({
    event: input.event, eventDay: input.eventDay, originalScheduleItems: input.scheduleItems,
    generationScheduleItems: [null], paAssignments: input.paAssignments,
    dutyAssignments: input.dutyAssignments, timetableLocks: input.timetableLocks,
  }), { ok: false, code: 'INVALID_REFERENCE_SHAPE' })
})

for (const field of ['originalScheduleItems', 'generationScheduleItems',
  'paAssignments', 'dutyAssignments', 'timetableLocks']) {
  test(`Break除外判定は${field}=nullをstructured failureにする`, () => {
    const input = createGenerationUiInput()
    const scope = { event: input.event, eventDay: input.eventDay,
      originalScheduleItems: input.scheduleItems, generationScheduleItems: input.scheduleItems,
      paAssignments: input.paAssignments, dutyAssignments: input.dutyAssignments,
      timetableLocks: input.timetableLocks, [field]: null }
    assert.deepEqual(validateTimetableGenerationBreakRemoval(scope),
      { ok: false, code: 'INVALID_REFERENCE_SHAPE' })
  })
}
