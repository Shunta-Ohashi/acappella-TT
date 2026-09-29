import test from 'node:test'
import assert from 'node:assert/strict'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'
import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { resolveDutyAssignmentInterval } from '../src/domain/dutyAssignments.ts'
import { resolvePaAssignmentInterval } from '../src/domain/paAssignments.ts'
import { serializePersistedState, parsePersistedState } from '../src/persistence/localPersistence.ts'
import { createGenerationUiInput, materializationInput } from './fixtures/timetableGenerationUi.mjs'

test('orphan ScheduleItemをmaterializerのsource・baselineと最終validatorのinput・candidateで拒否する', () => {
  const orphan = { id: 'orphan' }
  for (const field of ['sourceScheduleItems', 'scheduleItems']) {
    const input = materializationInput()
    input[field] = [...input[field], orphan]
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input),
      { ok: false, code: 'INVALID_PLAN_REFERENCE' })
    assert.deepEqual(input, original)
  }
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  const original = structuredClone({ input, candidate })
  assert.equal(validateTimetableGenerationCandidate({ ...input,
    scheduleItems: [...input.scheduleItems, orphan] }, candidate).ok, false)
  assert.equal(validateTimetableGenerationCandidate(input, { ...candidate,
    scheduleItems: [...candidate.scheduleItems, orphan] }).ok, false)
  assert.deepEqual({ input, candidate }, original)
})

test('正常な他日・別EventのScheduleItemは形状検証で拒否しない', () => {
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
  for (const id of ['p-a2', 'p-b']) {
    assert.deepEqual(candidate.scheduleItems.find(item => item.id === id),
      input.scheduleItems.find(item => item.id === id))
  }
})

for (const [name, dutyTypes] of [
  ['collection null', null], ['null entry', [null]], ['empty entry', [{}]],
  ['undefined entry', [undefined]],
  ['empty ID', [{ id: '', eventId: 'event-a' }]],
  ['blank ID', [{ id: '   ', eventId: 'event-a' }]],
  ['null ID', [{ id: null, eventId: 'event-a' }]],
  ['numeric ID', [{ id: 123, eventId: 'event-a' }]],
  ['empty eventId', [{ id: 'duty-photo', eventId: '' }]],
  ['blank eventId', [{ id: 'duty-photo', eventId: '   ' }]],
  ['invalid eventId', [{ id: 'duty-photo', eventId: null }]],
  ['numeric eventId', [{ id: 'duty-photo', eventId: 123 }]],
  ['duplicate ID', [{ id: 'duty-photo', eventId: 'event-a' },
    { id: 'duty-photo', eventId: 'event-a' }]],
  ['cross-event duplicate ID', [{ id: 'duty-photo', eventId: 'event-a' },
    { id: 'duty-photo', eventId: 'event-b' }]],
]) {
  test(`materializerはDutyType ${name}をthrowせずINVALID_PLAN_REFERENCEにする`, () => {
    const input = materializationInput()
    input.dutyTypes = dutyTypes
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input),
      { ok: false, code: 'INVALID_PLAN_REFERENCE' })
    assert.deepEqual(input, original)
  })

  test(`final validatorはDutyType ${name}をthrowせず失敗結果にする`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    input.dutyTypes = dutyTypes
    const original = structuredClone({ input, candidate })
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
    assert.deepEqual({ input, candidate }, original)
  })
}

test('materializerと最終validatorは一意な別Event DutyTypeを許可する', () => {
  const input = materializationInput()
  const baseline = materializeTimetableGenerationPlan(input)
  assert.equal(baseline.ok, true)
  input.dutyTypes.push({ id: 'foreign-duty', eventId: 'other-event', name: '撮影', order: 0 })
  const candidate = materializeTimetableGenerationPlan(input)
  assert.deepEqual(candidate, baseline)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})

for (const [name, mutate] of [
    ['scheduleItems null', input => { input.scheduleItems = null }],
    ['sourceScheduleItems null', input => { input.sourceScheduleItems = null }],
    ['paAssignments null', input => { input.paAssignments = null }],
    ['dutyAssignments null', input => { input.dutyAssignments = null }],
    ['timetableLocks null', input => { input.timetableLocks = null }],
    ['plan null', input => { input.plan = null }],
    ['placements null', input => { input.plan.placements = null }],
    ['breaks null', input => { input.plan.breaks = null }],
    ['paShifts null', input => { input.plan.paShifts = null }],
    ['schedule IDs null', input => { input.newScheduleItemIds = null }],
    ['PA IDs null', input => { input.newPaAssignmentIds = null }],
    ['placement null', input => { input.plan.placements = [null] }],
    ['break null', input => { input.plan.breaks = [null] }],
    ['shift null', input => { input.plan.paShifts = [null] }],
    ['fromBoundary null', input => { input.plan.paShifts[0].fromBoundary = null }],
    ['untilBoundary null', input => { input.plan.paShifts[0].untilBoundary = null }],
    ['placement band missing', input => { delete input.plan.placements[0].eventBandId }],
    ['placement stage malformed', input => { input.plan.placements[0].stageId = null }],
    ['break item ID missing', input => { delete input.plan.breaks[0].scheduleItemId }],
    ['fromBoundary empty', input => { input.plan.paShifts[0].fromBoundary = {} }],
]) {
  test(`materializerは${name}を例外でなく失敗結果にする`, () => {
    const input = materializationInput()
    mutate(input)
    const original = structuredClone(input)
    const result = materializeTimetableGenerationPlan(input)
    assert.equal(result.ok, false)
    assert.deepEqual(input, original)
  })
}

test('final validatorは不正なsource・candidate PA collectionを例外でなく失敗結果にする', () => {
  for (const field of ['scheduleItems', 'paAssignments']) {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    const malformed = { ...candidate, [field]: null }
    assert.equal(validateTimetableGenerationCandidate(input, malformed).ok, false)
  }
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  input.paAssignments = null
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
  assert.equal(validateTimetableGenerationCandidate(materializationInput(), null).ok, false)
})

test('生成coreのplanを正式IDへ変換しTimeline・Lock・Issue・Dutyを再検証する', () => {
  const input = createGenerationUiInput()
  const original = structuredClone(input)
  const generated = generateTimetablePlan(input)
  assert.equal(generated.ok, true, JSON.stringify(generated))
  const candidate = materializeTimetableGenerationPlan({ ...input, sourceScheduleItems: input.scheduleItems,
    plan: generated.plan,
    newScheduleItemIds: generated.plan.placements.filter(p => !p.scheduleItemId).map((_, i) => `new-${i}`),
    newPaAssignmentIds: generated.plan.paShifts.map((_, i) => `new-pa-${i}`),
  })
  assert.equal(candidate.ok, true, JSON.stringify(candidate))
  const validation = validateTimetableGenerationCandidate(input, candidate)
  assert.equal(validation.ok, true, JSON.stringify(validation))
  assert.equal(validation.issues.filter(issue => issue.severity === 'ERROR').length, 0)
  assert.equal(candidate.scheduleItems.find(item => item.eventBandId === 'band-1').id, 'old-p1')
  assert.ok(candidate.scheduleItems.find(item => item.eventBandId === 'band-2').id.startsWith('new-'))
  assert.equal(resolveDutyAssignmentInterval(input.dutyAssignments[0], validation.calculatedItems).ok, true)
  assert.ok(candidate.paAssignments.filter(pa => pa.eventDayId === input.eventDay.id)
    .every(pa => resolvePaAssignmentInterval(pa, validation.calculatedItems).ok))
  assert.deepEqual(input, original)
})

test('既存Performance ID・新規IDとBreak内容を維持し、他Event/DayのSchedule・PAは順序も内容も保持する', () => {
  const input = materializationInput()
  const result = materializeTimetableGenerationPlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.scheduleItems.filter(item => ['p-a2', 'p-b'].includes(item.id)),
    input.scheduleItems.filter(item => ['p-a2', 'p-b'].includes(item.id)))
  assert.deepEqual(result.paAssignments.filter(pa => !pa.id.startsWith('new-')), input.paAssignments.slice(1))
  assert.equal(result.paAssignments.some(pa => pa.id === 'old-pa'), false)
  assert.equal(result.paAssignments.length, 6)
  assert.equal(result.scheduleItems.find(item => item.eventBandId === 'band-1').id, 'old-p1')
  assert.equal(result.scheduleItems.find(item => item.eventBandId === 'band-2').id, 'new-p2')
  assert.deepEqual(result.scheduleItems.find(item => item.id === 'break-1'), input.scheduleItems.find(item => item.id === 'break-1'))
  assert.deepEqual(result.paAssignments.find(pa => pa.id === 'new-pa-0').from, { scheduleItemId: 'old-p1', edge: 'start' })
  assert.deepEqual(result.paAssignments.find(pa => pa.id === 'new-pa-0').until, { scheduleItemId: 'old-p1', edge: 'end' })
  assert.deepEqual(result.paAssignments.find(pa => pa.id === 'new-pa-2').from, { scheduleItemId: 'new-p2', edge: 'start' })
  assert.equal('sectionId' in result.paAssignments.find(pa => pa.id === 'new-pa-2'), false)
})

test('一意なStageを持つ複数日では対象日だけ更新し、他日のBreakを保持する', () => {
  const input = materializationInput()
  const otherDayBreak = { id: 'break-a2', kind: 'break', title: '翌日の休憩',
    durationMinutes: 5, stageId: 'stage-a2', order: 1 }
  input.scheduleItems.push(otherDayBreak)
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  assert.deepEqual(candidate.scheduleItems.find(item => item.id === otherDayBreak.id), otherDayBreak)
  assert.deepEqual(candidate.scheduleItems.find(item => item.id === 'p-a2'),
    input.scheduleItems.find(item => item.id === 'p-a2'))
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})

for (const [name, edit] of [
  ['対象EventDay ID重複', input => { input.eventDays.push({ ...input.eventDay }) }],
  ['foreign EventDayによる対象ID再利用', input => {
    input.eventDays.push({ ...input.eventDay, eventId: 'event-b' })
  }],
  ['他EventDay同士のID重複', input => { input.eventDays.push({ ...input.eventDays[1] }) }],
  ['対象EventDayがcollectionに存在しない', input => {
    input.eventDays = input.eventDays.filter(day => day.id !== input.eventDay.id)
  }],
  ['異なる開催日のStage ID重複とBreak', input => {
    input.stages.find(stage => stage.eventDayId === 'day-a2').id = 'stage-a1'
    input.scheduleItems = input.scheduleItems.filter(item => item.id !== 'p-a2')
    input.scheduleItems.push({ id: 'break-a2', kind: 'break', title: '翌日の休憩',
      durationMinutes: 5, stageId: 'stage-a1', order: 1 })
    input.plan.breaks.push({ ...input.plan.breaks[0], scheduleItemId: 'break-a2', order: 1 })
  }],
  ['同一開催日のStage ID重複', input => {
    input.stages.find(stage => stage.id === 'stage-sub').id = 'stage-a1'
  }],
  ['targetとforeign EventBandのID重複', input => {
    input.eventBands.find(band => band.id === 'band-b').id = 'band-1'
  }],
  ['target Day内のEventBand ID重複', input => {
    input.eventBands.push({ ...input.eventBands[0], name: '重複バンド' })
  }],
  ['同Event・他DayとのEventBand ID重複', input => {
    input.eventBands.find(band => band.id === 'band-a2').id = 'band-1'
  }],
  ['target外のEventBand ID重複', input => {
    input.eventBands.push({ ...input.eventBands.find(band => band.id === 'band-b') })
  }],
  ['targetと他DayのSection ID重複', input => {
    input.sections.push({ ...input.sections[0], stageId: 'stage-a2' })
    input.timetableLocks.push({ ...input.timetableLocks[0], id: 'other-day-section-lock',
      stageId: 'stage-a2', sectionId: 'section-1', scheduleItemId: 'p-a2' })
  }],
]) {
  test(`materializationは${name}をcandidate構築前に拒否し、入力を変更しない`, () => {
    const input = materializationInput()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'PLAN_SCOPE_MISMATCH' })
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['EventDay ID重複', input => { input.eventDays.push({ ...input.eventDay }) }],
  ['Stage ID重複', input => { input.stages.find(stage => stage.id === 'stage-a2').id = 'stage-a1' }],
  ['EventBand ID重複', input => { input.eventBands.find(band => band.id === 'band-b').id = 'band-1' }],
  ['Section ID重複', input => { input.sections.push({ ...input.sections[0], stageId: 'stage-a2' }) }],
]) {
  test(`最終guard単独呼び出しでも${name}を拒否する`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    edit(input)
    const original = structuredClone(input)
    const originalCandidate = structuredClone(candidate)
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate), {
      ok: false, reason: '開催日・Stage・Section・出演バンドの所属を一意に判定できません。',
    })
    assert.deepEqual(input, original)
    assert.deepEqual(candidate, originalCandidate)
  })
}

test('target Performanceが古いStageに残っていても同一IDを再利用し二重に残さない', () => {
  const input = materializationInput()
  input.scheduleItems[0].stageId = 'missing-old-stage'
  const result = materializeTimetableGenerationPlan(input)
  assert.equal(result.ok, true)
  assert.equal(result.scheduleItems.filter(item => item.eventBandId === 'band-1').length, 1)
  assert.equal(result.scheduleItems.find(item => item.id === 'old-p1').stageId, 'stage-a1')
})

const boundary = itemId => ({ scheduleItemId: itemId, edge: 'start' })
const addPaReference = (input, itemId, eventId, eventDayId, stageId) => {
  input.paAssignments.push({ ...input.paAssignments[0], id: `pa-ref-${eventDayId}`,
    eventId, eventDayId, stageId, from: boundary(itemId) })
}
const addDutyReference = (input, itemId, eventDayId, stageId, dutyTypeId = 'duty-photo') => {
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: `duty-ref-${eventDayId}`,
    dutyTypeId, eventDayId, stageId, from: boundary(itemId) })
}
const addLockReference = (input, itemId, eventId, stageId) => {
  input.timetableLocks.push({ ...input.timetableLocks[0], id: `lock-ref-${eventId}`,
    eventId, stageId, sectionId: undefined, scheduleItemId: itemId })
}
const assertMaterialization = (input, expectedOk) => {
  const original = structuredClone(input)
  const result = materializeTimetableGenerationPlan(input)
  assert.equal(result.ok, expectedOk, JSON.stringify(result))
  if (!expectedOk) assert.equal(result.code, 'INVALID_PLAN_REFERENCE')
  assert.deepEqual(input, original)
  return result
}

for (const [name, addReference] of [
  ['other-day PA', input => addPaReference(input, 'old-p1', 'event-a', 'day-a2', 'stage-a2')],
  ['foreign PA', input => addPaReference(input, 'old-p1', 'event-b', 'day-b', 'stage-b')],
  ['other-day Duty', input => addDutyReference(input, 'old-p1', 'day-a2', 'stage-a2')],
  ['foreign Duty', input => {
    input.dutyTypes.push({ id: 'foreign-type', eventId: 'event-b', name: '他Event', order: 0 })
    addDutyReference(input, 'old-p1', 'day-b', 'stage-b', 'foreign-type')
  }],
  ['foreign Lock', input => addLockReference(input, 'old-p1', 'event-b', 'stage-b')],
]) {
  test(`stale target Performance IDを再配置する前に${name}の保持参照を拒否する`, () => {
    const input = materializationInput()
    input.scheduleItems[0].stageId = 'stage-a2'
    addReference(input)
    assertMaterialization(input, false)
  })
}

test('target Dutyとtarget Lockは再配置後のcandidateに対して最終検証できる', () => {
  const input = materializationInput()
  input.scheduleItems[0].stageId = 'stage-a2'
  addDutyReference(input, 'old-p1', 'day-a1', 'stage-a1')
  input.dutyAssignments.at(-1).until = { scheduleItemId: 'old-p1', edge: 'end' }
  const candidate = assertMaterialization(input, true)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})

for (const [name, addReference] of [
  ['target PA', input => { input.dutyAssignments = []; input.timetableLocks = [] }],
  ['target Duty', input => {
    input.paAssignments = []; input.timetableLocks = []
    addDutyReference(input, 'old-p1', 'day-a1', 'stage-a1')
  }],
  ['target Lock', input => { input.paAssignments = []; input.dutyAssignments = [] }],
  ['参照なし', input => { input.paAssignments = []; input.dutyAssignments = []; input.timetableLocks = [] }],
]) {
  test(`stale target Performance IDは${name}のみなら再利用できる`, () => {
    const input = materializationInput()
    input.scheduleItems[0].stageId = 'stage-a2'
    addReference(input)
    const result = assertMaterialization(input, true)
    assert.equal(result.scheduleItems.find(item => item.id === 'old-p1').stageId, 'stage-a1')
  })
}

for (const [name, addReference] of [
  ['foreign PA', input => addPaReference(input, 'break-1', 'event-b', 'day-b', 'stage-b')],
  ['other-day Duty', input => addDutyReference(input, 'break-1', 'day-a2', 'stage-a2')],
  ['foreign Lock', input => addLockReference(input, 'break-1', 'event-b', 'stage-b')],
]) {
  test(`target Break再配置前に${name}の保持参照を拒否する`, () => {
    const input = materializationInput()
    input.plan.breaks[0] = { ...input.plan.breaks[0], sectionId: 'section-2',
      afterSectionId: undefined, order: 1 }
    addReference(input)
    assertMaterialization(input, false)
  })
}

const removeBreakFromBaseline = input => {
  input.scheduleItems = input.scheduleItems.filter(item => item.id !== 'break-1')
  input.plan.breaks = []
  input.dutyAssignments = []
}

for (const [name, addReference] of [
  ['Lock', input => addLockReference(input, 'break-1', 'event-a', 'stage-a1')],
  ['Duty', input => addDutyReference(input, 'break-1', 'day-a1', 'stage-a1')],
  ['other-day PA', input => addPaReference(input, 'break-1', 'event-a', 'day-a2', 'stage-a2')],
  ['foreign PA', input => addPaReference(input, 'break-1', 'event-b', 'day-b', 'stage-b')],
]) {
  test(`optionで除外したBreakを参照する${name}はmaterializer単体でも拒否する`, () => {
    const input = materializationInput()
    removeBreakFromBaseline(input)
    addReference(input)
    assertMaterialization(input, false)
  })
}

test('optionで除外したBreakの参照がtarget PAだけならmaterializeでき、参照なしでも成功する', () => {
  const input = materializationInput()
  removeBreakFromBaseline(input)
  input.paAssignments[0].from = boundary('break-1')
  const result = assertMaterialization(input, true)
  assert.equal(result.scheduleItems.some(item => item.id === 'break-1'), false)

  input.paAssignments = []
  assertMaterialization(input, true)
})

for (const [name, edit] of [
  ['除外したBreak IDを新Performanceへ転用', input => { input.newScheduleItemIds = ['break-1'] }],
  ['除外したBreak IDを新PAへ転用', input => { input.newPaAssignmentIds[0] = 'break-1' }],
]) {
  test(`${name}できずID_COLLISIONとなる`, () => {
    const input = materializationInput()
    removeBreakFromBaseline(input)
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'ID_COLLISION' })
    assert.deepEqual(input, original)
  })
}

test('source Performanceをbaselineから省略した場合は新ID割当より前に拒否する', () => {
  const input = materializationInput()
  input.scheduleItems = input.scheduleItems.filter(item => item.id !== 'p-b')
  input.newScheduleItemIds = ['p-b']
  const original = structuredClone(input)
  assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'INVALID_PLAN_REFERENCE' })
  assert.deepEqual(input, original)
})

test('source Performance IDを新Performance IDとして渡すと衝突する', () => {
  const input = materializationInput()
  input.newScheduleItemIds = ['old-p1']
  const original = structuredClone(input)
  assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'ID_COLLISION' })
  assert.deepEqual(input, original)
})

for (const [name, edit] of [
  ['target Performance', input => { input.scheduleItems = input.scheduleItems.filter(item => item.id !== 'old-p1') }],
  ['other-day Performance', input => { input.scheduleItems = input.scheduleItems.filter(item => item.id !== 'p-a2') }],
  ['other-day Break', input => {
    input.sourceScheduleItems.push({ id: 'break-a2', kind: 'break', title: '翌日休憩',
      durationMinutes: 5, stageId: 'stage-a2', order: 0 })
    input.scheduleItems = input.sourceScheduleItems.filter(item => item.id !== 'break-a2')
  }],
  ['foreign Break', input => {
    input.sourceScheduleItems.push({ id: 'break-b', kind: 'break', title: '別Event休憩',
      durationMinutes: 5, stageId: 'stage-b', order: 0 })
    input.scheduleItems = input.sourceScheduleItems.filter(item => item.id !== 'break-b')
  }],
  ['Sectionless target Break', input => {
    input.sourceScheduleItems.push({ id: 'break-plain', kind: 'break', title: '通常休憩',
      durationMinutes: 5, stageId: 'stage-sub', order: 0 })
    input.scheduleItems = input.sourceScheduleItems.filter(item => item.id !== 'break-plain')
  }],
  ['malformed target Break', input => {
    input.sourceScheduleItems.push({ id: 'break-invalid', kind: 'break', title: '不正休憩',
      durationMinutes: 5, stageId: 'stage-a1', sectionId: 'missing-section', order: 0 })
    input.scheduleItems = input.sourceScheduleItems.filter(item => item.id !== 'break-invalid')
  }],
]) {
  test(`${name}のbaselineからの不正な省略をmaterializer単体で拒否する`, () => {
    const input = materializationInput()
    edit(input)
    assertMaterialization(input, false)
  })
}

test('正常なtarget部内Breakだけを除外したbaselineならmaterializeできる', () => {
  const input = materializationInput()
  input.sourceScheduleItems.push({ id: 'break-inside', kind: 'break', title: '部内休憩',
    durationMinutes: 5, stageId: 'stage-a1', sectionId: 'section-2', order: 1 })
  input.scheduleItems = input.sourceScheduleItems.filter(item => item.id !== 'break-inside')
  const result = assertMaterialization(input, true)
  assert.equal(result.scheduleItems.some(item => item.id === 'break-inside'), false)
})

test('正常なtarget部間Breakだけを除外したbaselineならmaterializeできる', () => {
  const input = materializationInput()
  removeBreakFromBaseline(input)
  const result = assertMaterialization(input, true)
  assert.equal(result.scheduleItems.some(item => item.id === 'break-1'), false)
})

test('baselineにsourceにないItemを追加した場合は拒否する', () => {
  const input = materializationInput()
  input.scheduleItems = [...input.scheduleItems, { id: 'extra-break', kind: 'break',
    title: '追加休憩', durationMinutes: 5, stageId: 'stage-a1', sectionId: 'section-2', order: 1 }]
  assertMaterialization(input, false)
})

for (const [name, edit, itemId] of [
  ['PerformanceのStage', item => { item.stageId = 'stage-a2' }, 'old-p1'],
  ['Breakのduration', item => { item.durationMinutes = 10 }, 'break-1'],
  ['BreakのSection anchor', item => { item.afterSectionId = 'section-2' }, 'break-1'],
]) {
  test(`baselineに残る${name}を同じIDで変更しても拒否する`, () => {
    const input = materializationInput()
    input.scheduleItems = structuredClone(input.sourceScheduleItems)
    edit(input.scheduleItems.find(item => item.id === itemId))
    assertMaterialization(input, false)
  })
}

test('baselineがsourceと同内容の別objectなら許可し、順序変更は拒否する', () => {
  const input = materializationInput()
  input.scheduleItems = structuredClone(input.sourceScheduleItems)
  assertMaterialization(input, true)
  input.scheduleItems.reverse()
  assertMaterialization(input, false)
})

for (const [name, edit] of [
  ['newScheduleItemIds', input => { input.newScheduleItemIds = [undefined] }],
  ['newPaAssignmentIds', input => { input.newPaAssignmentIds[0] = 42 }],
]) {
  test(`runtime不正な${name}はthrowせずID_COLLISIONを返す`, () => {
    const input = materializationInput()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'ID_COLLISION' })
    assert.deepEqual(input, original)
  })
}

test('既存Performanceの正式なID再利用と新規IDの割り当ては引き続き成功する', () => {
  const input = materializationInput()
  const result = assertMaterialization(input, true)
  assert.equal(result.scheduleItems.find(item => item.eventBandId === 'band-1').id, 'old-p1')
  assert.equal(result.scheduleItems.find(item => item.eventBandId === 'band-2').id, 'new-p2')
})

test('Breakの配置情報だけを反映し古いsectionId/afterSectionIdを残さない', () => {
  const input = materializationInput()
  input.plan.breaks[0] = { ...input.plan.breaks[0], afterSectionId: undefined, sectionId: 'section-2', order: 1 }
  const result = materializeTimetableGenerationPlan(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.scheduleItems.find(item => item.id === 'break-1'), {
    id: 'break-1', kind: 'break', title: '部間休憩', durationMinutes: 15,
    stageId: 'stage-a1', sectionId: 'section-2', order: 1,
  })
})

test('既存Break Boundaryも正式IDで解決し、PAへ計算時刻snapshotを追加しない', () => {
  const input = materializationInput()
  input.plan.paShifts[0].untilBoundary = { kind: 'existing-item', scheduleItemId: 'break-1', edge: 'end' }
  const result = materializeTimetableGenerationPlan(input)
  const validation = validateTimetableGenerationCandidate(input, result)
  assert.equal(validation.ok, true)
  const assignment = result.paAssignments.find(pa => pa.id === 'new-pa-0')
  assert.deepEqual(assignment.until, { scheduleItemId: 'break-1', edge: 'end' })
  assert.deepEqual(resolvePaAssignmentInterval(assignment, validation.calculatedItems), {
    ok: true, interval: { fromMinute: 600, untilMinute: 625 },
  })
  assert.equal('fromMinute' in assignment, false)
  assert.equal('untilMinute' in assignment, false)
})

test('正式な生成candidateは既存Persistence schemaで復元できDuty/Lockをそのまま保持する', () => {
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  const domain = {
    events: [input.event, { ...input.event, id: 'event-b' }],
    eventDays: input.eventDays, stages: input.stages, sections: input.sections,
    members: input.members, bands: [], eventBands: input.eventBands,
    eventMembers: input.eventMembers, eventMemberDays: input.eventMemberDays,
    scheduleItems: candidate.scheduleItems, paAssignments: candidate.paAssignments,
    timetableLocks: input.timetableLocks, dutyTypes: input.dutyTypes, dutyAssignments: input.dutyAssignments,
  }
  const restored = parsePersistedState(serializePersistedState(domain))
  assert.ok(restored)
  assert.deepEqual(restored.scheduleItems, candidate.scheduleItems)
  assert.deepEqual(restored.paAssignments, candidate.paAssignments)
  assert.deepEqual(restored.dutyAssignments, input.dutyAssignments)
  assert.deepEqual(restored.timetableLocks, input.timetableLocks)
})

for (const [name, edit, code] of [
  ['plan Day不一致', i => { i.plan.eventDayId = 'day-a2' }, 'PLAN_SCOPE_MISMATCH'],
  ['Event所有者不一致', i => { i.eventDay.eventId = 'foreign' }, 'PLAN_SCOPE_MISMATCH'],
  ['Performance ID不足', i => { i.newScheduleItemIds = [] }, 'ID_COUNT_MISMATCH'],
  ['PA ID過多', i => { i.newPaAssignmentIds.push('excess') }, 'ID_COUNT_MISMATCH'],
  ['既存ID collision', i => { i.newScheduleItemIds = ['old-p1'] }, 'ID_COLLISION'],
  ['新規ID同士のcollision', i => { i.newPaAssignmentIds[0] = 'new-p2' }, 'ID_COLLISION'],
  ['空ID', i => { i.newScheduleItemIds = [''] }, 'ID_COLLISION'],
  ['既存ScheduleItem ID重複', i => { i.scheduleItems.push({ ...i.scheduleItems[0] }) }, 'INVALID_PLAN_REFERENCE'],
  ['既存参照missing', i => { i.plan.placements[0].scheduleItemId = 'missing' }, 'INVALID_PLAN_REFERENCE'],
  ['既存参照がBreak', i => { i.plan.placements[0].scheduleItemId = 'break-1' }, 'INVALID_PLAN_REFERENCE'],
  ['既存参照が別Band', i => { i.plan.placements[0].scheduleItemId = 'p-a2' }, 'INVALID_PLAN_REFERENCE'],
  ['別Day Performanceがtarget Stageにある', i => {
    i.scheduleItems.find(item => item.id === 'p-a2').stageId = 'stage-a1'
  }, 'INVALID_PLAN_REFERENCE'],
  ['別Event Performanceがtarget Stageにある', i => {
    i.scheduleItems.find(item => item.id === 'p-b').stageId = 'stage-a1'
  }, 'INVALID_PLAN_REFERENCE'],
  ['unknown EventBandのPerformanceがtarget Stageにある', i => {
    i.scheduleItems.push({ id: 'unknown-performance', kind: 'performance',
      eventBandId: 'missing-band', stageId: 'stage-a1', order: 1 })
  }, 'INVALID_PLAN_REFERENCE'],
  ['既存ID再利用の省略', i => { delete i.plan.placements[0].scheduleItemId; i.newScheduleItemIds.push('extra') }, 'INVALID_PLAN_REFERENCE'],
  ['missing Band', i => { i.plan.placements[1].eventBandId = 'missing' }, 'INVALID_PLAN_REFERENCE'],
  ['別Day Band', i => { i.plan.placements[1].eventBandId = 'band-a2' }, 'INVALID_PLAN_REFERENCE'],
  ['別Event Band', i => { i.plan.placements[1].eventBandId = 'band-b' }, 'INVALID_PLAN_REFERENCE'],
  ['別Day Stage', i => { i.plan.placements[1].stageId = 'stage-a2' }, 'INVALID_PLAN_REFERENCE'],
  ['foreign Section', i => { i.plan.placements[1].stageId = 'stage-sub' }, 'INVALID_PLAN_REFERENCE'],
  ['Performance欠落', i => { i.plan.placements.pop(); i.newScheduleItemIds = [] }, 'INVALID_PLAN_REFERENCE'],
  ['Performance重複', i => { i.plan.placements.push({ ...i.plan.placements[0] }) }, 'INVALID_PLAN_REFERENCE'],
  ['Break欠落', i => { i.plan.breaks = [] }, 'INVALID_PLAN_REFERENCE'],
  ['Break重複', i => { i.plan.breaks.push({ ...i.plan.breaks[0] }) }, 'INVALID_PLAN_REFERENCE'],
  ['Break参照missing', i => { i.plan.breaks[0].scheduleItemId = 'missing' }, 'INVALID_PLAN_REFERENCE'],
  ['最終Sectionの部間Break', i => { i.plan.breaks[0].afterSectionId = 'section-2' }, 'INVALID_PLAN_REFERENCE'],
  ['PA別Day', i => { i.plan.paShifts[0].eventDayId = 'day-a2' }, 'INVALID_PLAN_REFERENCE'],
  ['PA別Stage', i => { i.plan.paShifts[0].stageId = 'stage-a2' }, 'INVALID_PLAN_REFERENCE'],
  ['planned Boundary missing', i => { i.plan.paShifts[0].fromBoundary.eventBandId = 'missing' }, 'BOUNDARY_UNRESOLVED'],
  ['existing Boundary missing', i => { i.plan.paShifts[0].untilBoundary.scheduleItemId = 'missing' }, 'BOUNDARY_UNRESOLVED'],
  ['Boundary別Stage', i => { i.plan.paShifts[0].untilBoundary.scheduleItemId = 'p-a2' }, 'BOUNDARY_UNRESOLVED'],
]) {
  test(`materialization: ${name}をstructured failureにし入力を変更しない`, () => {
    const input = materializationInput()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code })
    assert.deepEqual(input, original)
  })
}

test('同一input・ID配列のmaterializationと最終検証はdeterministicかつnon-mutation', () => {
  const input = materializationInput()
  const original = structuredClone(input)
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  assert.deepEqual(materializeTimetableGenerationPlan(input), candidate)
  const first = validateTimetableGenerationCandidate(input, candidate)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(validateTimetableGenerationCandidate(input, candidate), first)
  assert.deepEqual(input, original)
})

for (const placement of ['先頭', '末尾']) {
  test(`元ScheduleItem ID重複は${placement}に追加してもunique candidateを拒否する`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
    assert.equal(new Set(candidate.scheduleItems.map(item => item.id)).size, candidate.scheduleItems.length)
    const duplicate = { id: 'old-p1', kind: 'break', title: '他日の休憩',
      durationMinutes: 5, stageId: 'stage-a2', order: 0 }
    if (placement === '先頭') input.scheduleItems.unshift(duplicate)
    else input.scheduleItems.push(duplicate)
    const originalInput = structuredClone(input)
    const originalCandidate = structuredClone(candidate)
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate),
      { ok: false, reason: '元のScheduleItem IDが重複しています。' })
    assert.deepEqual(input, originalInput)
    assert.deepEqual(candidate, originalCandidate)
  })
}

test('元ScheduleItemのruntime非文字列IDはthrowせず拒否する', () => {
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  input.scheduleItems[0].id = 42
  const originalInput = structuredClone(input)
  const originalCandidate = structuredClone(candidate)
  assert.deepEqual(validateTimetableGenerationCandidate(input, candidate),
    { ok: false, reason: '元のScheduleItem IDが重複しています。' })
  assert.deepEqual(input, originalInput)
  assert.deepEqual(candidate, originalCandidate)
})

for (const [name, edit] of [
  ['target Stage内', candidate => {
    candidate.scheduleItems.push({ ...candidate.scheduleItems.find(item => item.id === 'old-p1') })
  }],
  ['targetとother-day Stage間', candidate => {
    candidate.scheduleItems = candidate.scheduleItems.map(item => item.id === 'p-a2'
      ? { ...item, id: 'old-p1' } : item)
  }],
  ['BreakとPerformance間', candidate => {
    candidate.scheduleItems.find(item => item.id === 'break-1').id = 'old-p1'
  }],
]) {
  test(`最終guardはTimeline計算前に${name}のScheduleItem ID重複を拒否する`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true, '一意なIDは従来どおり有効')
    edit(candidate)
    const originalInput = structuredClone(input)
    const originalCandidate = structuredClone(candidate)
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate),
      { ok: false, reason: '生成結果のScheduleItem IDが重複しています。' })
    assert.deepEqual(input, originalInput)
    assert.deepEqual(candidate, originalCandidate)
  })
}

for (const [name, edit, reason] of [
  ['target PA同士', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'new-pa-1').id = 'new-pa-0'
  }, '生成結果のPA Assignment IDが重複しています。'],
  ['other-day PAとtarget PA', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-a2').id = 'new-pa-0'
  }, '生成結果のPA Assignment IDが重複しています。'],
  ['foreign PAとtarget PA', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-b').id = 'new-pa-0'
  }, '生成結果のPA Assignment IDが重複しています。'],
  ['ScheduleItemとPA', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'new-pa-0').id = 'old-p1'
  }, '生成結果のScheduleItemとPA AssignmentのIDが重複しています。'],
]) {
  test(`最終guardは${name}のID重複をTimeline計算前に拒否する`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true, '一意なIDは有効')
    edit(candidate)
    const originalInput = structuredClone(input)
    const originalCandidate = structuredClone(candidate)
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate), { ok: false, reason })
    assert.deepEqual(input, originalInput)
    assert.deepEqual(candidate, originalCandidate)
  })
}

for (const [name, edit, reason] of [
  ['target Performance欠落', candidate => {
    candidate.scheduleItems = candidate.scheduleItems.filter(item => item.id !== 'new-p2')
  }, '生成結果に出演バンドの不足・重複、または開催日の不一致があります。'],
  ['target Performance重複', candidate => {
    candidate.scheduleItems.push({ ...candidate.scheduleItems.find(item => item.id === 'old-p1'), id: 'duplicate-p1' })
  }, '生成結果に出演バンドの不足・重複、または開催日の不一致があります。'],
  ['target Performanceが別Day Stageにある', candidate => {
    candidate.scheduleItems.find(item => item.id === 'new-p2').stageId = 'stage-a2'
  }, '生成結果に出演バンドの不足・重複、または開催日の不一致があります。'],
  ['別Day Performanceがtarget Stageにある', candidate => {
    candidate.scheduleItems.find(item => item.id === 'p-a2').stageId = 'stage-a1'
  }, '生成結果で元のScheduleItemが欠落・変更されたか、対象外の項目が追加されています。'],
  ['別Event Performanceがtarget Stageにある', candidate => {
    candidate.scheduleItems.find(item => item.id === 'p-b').stageId = 'stage-a1'
  }, '生成結果で元のScheduleItemが欠落・変更されたか、対象外の項目が追加されています。'],
  ['unknown EventBandのPerformanceがtarget Stageにある', candidate => {
    candidate.scheduleItems.push({ id: 'unknown-performance', kind: 'performance',
      eventBandId: 'missing-band', stageId: 'stage-a1', order: 1 })
  }, '生成結果で元のScheduleItemが欠落・変更されたか、対象外の項目が追加されています。'],
]) {
  test(`最終guardはTimeline計算前に${name}を拒否し、入力を変更しない`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    assert.equal(candidate.ok, true)
    edit(candidate)
    const originalInput = structuredClone(input)
    const originalCandidate = structuredClone(candidate)
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate), { ok: false, reason })
    assert.deepEqual(input, originalInput)
    assert.deepEqual(candidate, originalCandidate)
  })
}

const createIsolatedCandidate = input => {
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true, JSON.stringify(candidate))
  return structuredClone(candidate)
}

const assertCandidateRejectedWithoutMutation = (input, candidate) => {
  const originalInput = structuredClone(input)
  const originalCandidate = structuredClone(candidate)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
  assert.deepEqual(input, originalInput)
  assert.deepEqual(candidate, originalCandidate)
}

for (const [name, edit] of [
  ['別Event PAの開始Boundary', (input, id) => {
    input.paAssignments.find(pa => pa.id === 'pa-b').from.scheduleItemId = id
  }],
  ['他日PAの終了Boundary', (input, id) => {
    input.paAssignments.find(pa => pa.id === 'pa-a2').until.scheduleItemId = id
  }],
  ['Dutyの開始Boundary', (input, id) => { input.dutyAssignments[0].from.scheduleItemId = id }],
  ['Dutyの終了Boundary', (input, id) => { input.dutyAssignments[0].until.scheduleItemId = id }],
  ['TT固定の参照', (input, id) => { input.timetableLocks[0].scheduleItemId = id }],
]) {
  test(`保持される${name}のdangling IDを新ScheduleItem IDに再利用しない`, () => {
    const input = materializationInput()
    const danglingId = `dangling-${name}`
    edit(input, danglingId)
    input.newScheduleItemIds = [danglingId]
    const original = structuredClone(input)

    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'ID_COLLISION' })
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['別Event PA', (input, id) => { input.paAssignments.find(pa => pa.id === 'pa-b').from.scheduleItemId = id }],
  ['他日PA', (input, id) => { input.paAssignments.find(pa => pa.id === 'pa-a2').until.scheduleItemId = id }],
  ['Duty', (input, id) => { input.dutyAssignments[0].from.scheduleItemId = id }],
  ['TT固定', (input, id) => { input.timetableLocks[0].scheduleItemId = id }],
]) {
  test(`最終guard単独でも${name}のdangling参照への新ScheduleItem ID付け替えを拒否する`, () => {
    const input = materializationInput()
    const danglingId = `dangling-direct-${name}`
    edit(input, danglingId)
    const candidate = createIsolatedCandidate(input)
    candidate.scheduleItems.find(item => item.id === 'new-p2').id = danglingId
    for (const pa of candidate.paAssignments) {
      if (pa.from.scheduleItemId === 'new-p2') pa.from.scheduleItemId = danglingId
      if (pa.until.scheduleItemId === 'new-p2') pa.until.scheduleItemId = danglingId
    }
    const originalInput = structuredClone(input)
    const originalCandidate = structuredClone(candidate)

    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate),
      { ok: false, reason: '生成結果の新規ScheduleItem IDが保持対象の参照と衝突しています。' })
    assert.deepEqual(input, originalInput)
    assert.deepEqual(candidate, originalCandidate)
  })
}

test('planのexisting-item Boundaryは新規生成ScheduleItem IDへ解決しない', () => {
  const input = materializationInput()
  input.plan.paShifts[0].fromBoundary = { kind: 'existing-item', scheduleItemId: 'new-p2', edge: 'start' }
  const original = structuredClone(input)

  assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'BOUNDARY_UNRESOLVED' })
  assert.deepEqual(input, original)
})

for (const [name, edit] of [
  ['PA開始Boundaryがnull', input => { input.paAssignments[1].from = null }],
  ['Duty終了Boundaryがundefined', input => { input.dutyAssignments[0].until = undefined }],
  ['LockのsectionIdが空白', input => { input.timetableLocks[0].sectionId = '   ' }],
]) {
  test(`不正な${name}はmaterializer・最終guardともthrowせず拒否する`, () => {
    const input = materializationInput()
    const candidate = createIsolatedCandidate(input)
    edit(input)
    const original = structuredClone(input)
    const originalCandidate = structuredClone(candidate)

    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'INVALID_PLAN_REFERENCE' })
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate),
      { ok: false, reason: '既存の担当またはTT固定参照が不正です。' })
    assert.deepEqual(input, original)
    assert.deepEqual(candidate, originalCandidate)
  })
}

test('置換されるtarget PAの旧Boundary IDは予約せず、保持PAの参照IDは新PA IDに使える', () => {
  const input = materializationInput()
  input.paAssignments.find(pa => pa.id === 'old-pa').from.scheduleItemId = 'old-target-dangling'
  input.paAssignments.find(pa => pa.id === 'pa-b').from.scheduleItemId = 'retained-dangling'
  input.newScheduleItemIds = ['old-target-dangling']
  input.newPaAssignmentIds[0] = 'retained-dangling'
  const original = structuredClone(input)

  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true, JSON.stringify(candidate))
  assert.equal(candidate.scheduleItems.some(item => item.id === 'old-target-dangling'), true)
  assert.equal(candidate.paAssignments.some(pa => pa.id === 'old-pa'), false)
  assert.equal(candidate.paAssignments.find(pa => pa.id === 'pa-b').from.scheduleItemId, 'retained-dangling')
  assert.deepEqual(input, original)
})

for (const [name, edit] of [
  ['他日PAの欠落', candidate => {
    candidate.paAssignments = candidate.paAssignments.filter(pa => pa.id !== 'pa-a2')
  }],
  ['別Event PAの欠落', candidate => {
    candidate.paAssignments = candidate.paAssignments.filter(pa => pa.id !== 'pa-b')
  }],
  ['他日PAのmember変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-a2').memberId = 'other-member'
  }],
  ['別Event PAのstage変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-b').stageId = 'stage-a2'
  }],
  ['他日PAのrole変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-a2').role = 'sub'
  }],
  ['別Event PAの開始Boundary変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-b').from.scheduleItemId = 'missing'
  }],
  ['他日PAの終了Boundary変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-a2').until.edge = 'start'
  }],
  ['別Event PAのeventId変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-b').eventId = 'event-c'
  }],
  ['他日PAのeventDayId変更', candidate => {
    candidate.paAssignments.find(pa => pa.id === 'pa-a2').eventDayId = 'day-b'
  }],
  ['余分な別Event PAの追加', candidate => {
    candidate.paAssignments.push({ ...candidate.paAssignments.find(pa => pa.id === 'pa-b'), id: 'extra-pa-b' })
  }],
]) {
  test(`最終guard単独で${name}を拒否し、入力を変更しない`, () => {
    const input = materializationInput()
    const candidate = createIsolatedCandidate(input)
    edit(candidate)
    assertCandidateRejectedWithoutMutation(input, candidate)
  })
}

test('保持PAは同内容の別object・別Boundaryでも許可し、target PAの置換を維持する', () => {
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  for (const id of ['pa-a2', 'pa-b']) {
    const source = input.paAssignments.find(pa => pa.id === id)
    const retained = candidate.paAssignments.find(pa => pa.id === id)
    assert.notEqual(retained, source)
    assert.notEqual(retained.from, source.from)
    assert.notEqual(retained.until, source.until)
    assert.deepEqual(retained, source)
  }
  assert.equal(candidate.paAssignments.some(pa => pa.id === 'old-pa'), false)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})

test('materializerの保持項目を変更しても元のScheduleItem・PA・Boundaryに波及しない', () => {
  const input = materializationInput()
  const original = structuredClone(input)
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(candidate.ok, true)
  candidate.scheduleItems.find(item => item.id === 'p-a2').order = 99
  candidate.paAssignments.find(pa => pa.id === 'pa-b').from.scheduleItemId = 'altered'
  assert.deepEqual(input, original)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
})

for (const [name, edit] of [
  ['空白ID', input => { input.paAssignments[0].id = '   ' }],
  ['重複ID', input => { input.paAssignments[1].id = input.paAssignments[0].id }],
]) {
  test(`最終guardはsource PAの${name}を比較前に拒否する`, () => {
    const input = materializationInput()
    const candidate = createIsolatedCandidate(input)
    edit(input)
    const original = structuredClone(input)

    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate),
      { ok: false, reason: '元のPA Assignment IDが重複しています。' })
    assert.deepEqual(input, original)
  })
}

for (const [name, prepare, edit] of [
  ['他日Performanceの欠落', () => {}, candidate => {
    candidate.scheduleItems = candidate.scheduleItems.filter(item => item.id !== 'p-a2')
  }],
  ['他日Breakの欠落', input => {
    input.scheduleItems.push({ id: 'break-a2', kind: 'break', title: '翌日の休憩',
      durationMinutes: 5, stageId: 'stage-a2', order: 1 })
  }, candidate => { candidate.scheduleItems = candidate.scheduleItems.filter(item => item.id !== 'break-a2') }],
  ['別Event Performanceの欠落', () => {}, candidate => {
    candidate.scheduleItems = candidate.scheduleItems.filter(item => item.id !== 'p-b')
  }],
  ['別Event Breakの欠落', input => {
    input.scheduleItems.push({ id: 'break-b', kind: 'break', title: '別Eventの休憩',
      durationMinutes: 5, stageId: 'stage-b', order: 1 })
  }, candidate => { candidate.scheduleItems = candidate.scheduleItems.filter(item => item.id !== 'break-b') }],
  ['他日Performanceの内容変更', () => {}, candidate => {
    candidate.scheduleItems.find(item => item.id === 'p-a2').stageId = 'stage-b'
  }],
  ['target Breakの欠落', () => {}, candidate => {
    candidate.scheduleItems = candidate.scheduleItems.filter(item => item.id !== 'break-1')
  }],
  ['target Breakのduration変更', () => {}, candidate => {
    candidate.scheduleItems.find(item => item.id === 'break-1').durationMinutes = 20
  }],
  ['target Breakのtitle変更', () => {}, candidate => {
    candidate.scheduleItems.find(item => item.id === 'break-1').title = '別の休憩'
  }],
  ['target Breakの他日Stageへの移動', () => {}, candidate => {
    candidate.scheduleItems.find(item => item.id === 'break-1').stageId = 'stage-a2'
  }],
  ['existing target PerformanceのID差し替え', () => {}, candidate => {
    candidate.scheduleItems.find(item => item.id === 'old-p1').id = 'replacement-p1'
  }],
  ['existing target PerformanceのBand差し替え', () => {}, candidate => {
    candidate.scheduleItems.find(item => item.id === 'old-p1').eventBandId = 'band-2'
  }],
  ['他日StageへのBreak追加', () => {}, candidate => {
    candidate.scheduleItems.push({ id: 'extra-break-a2', kind: 'break', title: '追加休憩',
      durationMinutes: 5, stageId: 'stage-a2', order: 1 })
  }],
  ['別Event Performance追加', () => {}, candidate => {
    candidate.scheduleItems.push({ id: 'extra-p-b', kind: 'performance', eventBandId: 'band-b',
      stageId: 'stage-b', order: 8 })
  }],
]) {
  test(`最終guard単独で${name}を拒否し、入力を変更しない`, () => {
    const input = materializationInput()
    prepare(input)
    const candidate = createIsolatedCandidate(input)
    edit(candidate)
    assertCandidateRejectedWithoutMutation(input, candidate)
  })
}

test('target PerformanceとBreakの配置だけの変更と、未配置Bandの新規Performanceは有効', () => {
  const input = materializationInput()
  const candidate = createIsolatedCandidate(input)
  candidate.scheduleItems.find(item => item.id === 'old-p1').order = 1
  candidate.scheduleItems.find(item => item.id === 'break-1').order = 1
  const originalInput = structuredClone(input)
  const originalCandidate = structuredClone(candidate)

  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
  assert.ok(candidate.scheduleItems.some(item => item.id === 'new-p2' && item.eventBandId === 'band-2'))
  assert.deepEqual(input, originalInput)
  assert.deepEqual(candidate, originalCandidate)
})

for (const [name, edit] of [
  ['source ScheduleItem空ID', input => { input.sourceScheduleItems[0].id = '' }],
  ['source ScheduleItem空白ID', input => { input.sourceScheduleItems[0].id = '   ' }],
]) {
  test(`materializerは${name}をthrowせず拒否する`, () => {
    const input = materializationInput()
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'INVALID_PLAN_REFERENCE' })
    assert.deepEqual(input, original)
  })
}

for (const [name, edit] of [
  ['Event ID', input => { input.event.id = '   '; input.eventDay.eventId = '   ' }],
  ['EventDay ID', input => { input.eventDay.id = '   ' }],
  ['EventDay eventId', input => { input.eventDay.eventId = '   ' }],
  ['collection EventDay ID', input => { input.eventDays[1].id = '   ' }],
  ['Stage ID', input => { input.stages[0].id = '' }],
  ['Section ID', input => { input.sections[0].id = '   ' }],
  ['EventBand ID', input => { input.eventBands[0].id = '' }],
]) {
  test(`materializerと最終guardは${name}の空白をscope validationで拒否する`, () => {
    const input = materializationInput()
    const candidate = createIsolatedCandidate(input)
    edit(input)
    const original = structuredClone(input)
    assert.deepEqual(materializeTimetableGenerationPlan(input), { ok: false, code: 'PLAN_SCOPE_MISMATCH' })
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
    assert.deepEqual(input, original)
  })
}

for (const [name, edit, reason] of [
  ['input ScheduleItem空白ID', (input) => { input.scheduleItems[0].id = '   ' },
    '元のScheduleItem IDが重複しています。'],
  ['candidate ScheduleItem空白ID', (_input, candidate) => { candidate.scheduleItems[0].id = '   ' },
    '生成結果のScheduleItem IDが重複しています。'],
  ['candidate PA空ID', (_input, candidate) => { candidate.paAssignments[0].id = '' },
    '生成結果のPA Assignment IDが重複しています。'],
]) {
  test(`最終guardは${name}をthrowせず拒否する`, () => {
    const input = materializationInput()
    const candidate = createIsolatedCandidate(input)
    edit(input, candidate)
    const originalInput = structuredClone(input)
    const originalCandidate = structuredClone(candidate)
    assert.deepEqual(validateTimetableGenerationCandidate(input, candidate), { ok: false, reason })
    assert.deepEqual(input, originalInput)
    assert.deepEqual(candidate, originalCandidate)
  })
}

for (const [name, edit] of [
  ['invalid Section', c => { c.scheduleItems.find(item => item.id === 'new-p2').sectionId = 'missing' }],
  ['Lock違反', c => { c.scheduleItems.find(item => item.id === 'old-p1').sectionId = 'section-2' }],
  ['PA境界破損', c => { c.paAssignments.find(item => item.id === 'new-pa-0').from.scheduleItemId = 'missing' }],
  ['PA本人出演ERROR', c => { c.paAssignments.find(item => item.id === 'new-pa-0').memberId = 'performer-1' }],
]) {
  test(`最終guardは${name}のcandidateを適用可能にしない`, () => {
    const input = materializationInput()
    const candidate = materializeTimetableGenerationPlan(input)
    edit(candidate)
    assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
  })
}

test('最終guardは保持したDutyのbroken Boundaryを検出する', () => {
  const input = materializationInput()
  input.dutyAssignments[0].from.scheduleItemId = 'missing'
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, false)
})

test('別Dayの壊れたLock/Duty/PAをtarget Dayの最終guardへ混入させない', () => {
  const input = materializationInput()
  input.timetableLocks.push({ ...input.timetableLocks[0], id: 'other-lock', stageId: 'stage-a2', scheduleItemId: 'p-a2', sectionId: undefined })
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'other-duty', eventDayId: 'day-a2',
    stageId: 'stage-a2', from: { scheduleItemId: 'missing', edge: 'start' },
    until: { scheduleItemId: 'p-a2', edge: 'end' } })
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})

test('Stage-wide first/last固定とSection lane-local Lockを同時に再検証できる', () => {
  const input = materializationInput()
  input.scheduleItems.push({ id: 'old-p2', kind: 'performance', eventBandId: 'band-2',
    stageId: 'stage-a1', sectionId: 'section-2', order: 0 })
  input.plan.placements[1].scheduleItemId = 'old-p2'
  input.newScheduleItemIds = []
  input.eventBands[0].fixedPlacement = { stageId: 'stage-a1', position: { kind: 'first' } }
  input.eventBands[1].fixedPlacement = { stageId: 'stage-a1', position: { kind: 'last' } }
  input.timetableLocks.push({ id: 'lock-last', eventId: input.event.id, scheduleItemId: 'old-p2',
    stageId: 'stage-a1', sectionId: 'section-2', position: { kind: 'first' } })
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})
