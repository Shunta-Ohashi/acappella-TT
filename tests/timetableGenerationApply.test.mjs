import test from 'node:test'
import assert from 'node:assert/strict'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'
import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { resolveDutyAssignmentInterval } from '../src/domain/dutyAssignments.ts'
import { resolvePaAssignmentInterval } from '../src/domain/paAssignments.ts'
import { serializePersistedState, parsePersistedState } from '../src/persistence/localPersistence.ts'
import { createGenerationUiInput, materializationInput } from './fixtures/timetableGenerationUi.mjs'

test('生成coreのplanを正式IDへ変換しTimeline・Lock・Issue・Dutyを再検証する', () => {
  const input = createGenerationUiInput()
  const original = structuredClone(input)
  const generated = generateTimetablePlan(input)
  assert.equal(generated.ok, true, JSON.stringify(generated))
  const candidate = materializeTimetableGenerationPlan({ ...input, plan: generated.plan,
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

test('target Performanceが古いStageに残っていても同一IDを再利用し二重に残さない', () => {
  const input = materializationInput()
  input.scheduleItems[0].stageId = 'missing-old-stage'
  const result = materializeTimetableGenerationPlan(input)
  assert.equal(result.ok, true)
  assert.equal(result.scheduleItems.filter(item => item.eventBandId === 'band-1').length, 1)
  assert.equal(result.scheduleItems.find(item => item.id === 'old-p1').stageId, 'stage-a1')
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
  ['既存参照missing', i => { i.plan.placements[0].scheduleItemId = 'missing' }, 'INVALID_PLAN_REFERENCE'],
  ['既存参照がBreak', i => { i.plan.placements[0].scheduleItemId = 'break-1' }, 'INVALID_PLAN_REFERENCE'],
  ['既存参照が別Band', i => { i.plan.placements[0].scheduleItemId = 'p-a2' }, 'INVALID_PLAN_REFERENCE'],
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
  input.dutyAssignments.push({ ...input.dutyAssignments[0], id: 'other-duty', eventDayId: 'day-a2', stageId: 'stage-a2', from: { scheduleItemId: 'missing', edge: 'start' } })
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})

test('Stage-wide first/last固定とSection lane-local Lockを同時に再検証できる', () => {
  const input = materializationInput()
  input.eventBands[0].fixedPlacement = { stageId: 'stage-a1', position: { kind: 'first' } }
  input.eventBands[1].fixedPlacement = { stageId: 'stage-a1', position: { kind: 'last' } }
  input.timetableLocks.push({ id: 'lock-last', eventId: input.event.id, scheduleItemId: 'new-p2',
    stageId: 'stage-a1', sectionId: 'section-2', position: { kind: 'first' } })
  const candidate = materializeTimetableGenerationPlan(input)
  assert.equal(validateTimetableGenerationCandidate(input, candidate).ok, true)
})
