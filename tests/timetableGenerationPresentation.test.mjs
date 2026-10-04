import test from 'node:test'
import assert from 'node:assert/strict'
import { presentTimetableGenerationFailure, createTimetableGenerationPreview, GENERATION_SCORE_LABELS } from '../src/ui/timetableGenerationPresentation.ts'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'
import { materializationInput } from './fixtures/timetableGenerationUi.mjs'

for (const [code, wording] of [
  ['INVALID_INPUT', /設定に不整合/], ['INVALID_LOCK_CONSTRAINTS', /固定.*競合/],
  ['INVALID_ORDER_CONSTRAINTS', /出演順制約.*競合/],
  ['BROKEN_DUTY_ASSIGNMENT', /当日運営.*壊れた参照/], ['NO_MAIN_PA_CANDIDATE', /Main PA/],
  ['NO_SUB_PA_CANDIDATE', /Sub PA/], ['NO_FEASIBLE_PA_PLAN', /PA配置/],
  ['NO_FEASIBLE_SCHEDULE', /タイムテーブル/], ['SEARCH_LIMIT_REACHED', /探索上限/],
]) {
  test(`${code}を日本語で表示し探索件数を含める`, () => {
    const text = presentTimetableGenerationFailure({ code, eventDayId: 'day-a1', attemptedSchedules: 3 }, materializationInput())
    assert.match(text, wording)
    assert.match(text, /Schedule候補評価数: 3/)
  })
}

test('failure referenceをStage・Section・バンド名へ解決しmissing referenceはIDを表示する', () => {
  const failure = { code: 'INVALID_INPUT', eventDayId: 'day-a1', attemptedSchedules: 0,
    stageId: 'stage-a1', sectionId: 'section-1', eventBandId: 'band-2' }
  assert.match(presentTimetableGenerationFailure(failure, materializationInput()), /Main Stage.*第1部.*Blend Note/)
  assert.match(presentTimetableGenerationFailure({ ...failure, stageId: 'missing-stage' }, materializationInput()), /missing-stage/)
})

test('INVALID_INPUTではStep 6の休憩配置も確認対象と案内する', () => {
  const text = presentTimetableGenerationFailure({
    code: 'INVALID_INPUT', eventDayId: 'day-a1', attemptedSchedules: 0,
  }, materializationInput())
  assert.match(text, /Step 1〜6/)
  assert.match(text, /休憩配置/)
})

test('read-only previewはStage/Section/実Timeline順と部間Break・PA role/member/正式境界時刻を表示する', () => {
  const input = materializationInput()
  // Presentation must use canonical Stage order, not the collection order.
  input.stages.reverse()
  input.sections.reverse()
  const original = structuredClone(input)
  const candidate = materializeTimetableGenerationPlan(input)
  const validation = validateTimetableGenerationCandidate(input, candidate)
  assert.equal(validation.ok, true)
  const preview = createTimetableGenerationPreview({ ...input, ...candidate, ...validation })
  assert.equal(preview.dayLabel, '2027年11月6日')
  assert.deepEqual(preview.stageRows.map(row => row.name), ['Main Stage', 'Sub Stage'])
  assert.deepEqual(preview.stageRows[0].rows.map(row => row.name), ['Choir', '部間休憩', 'Blend Note'])
  assert.deepEqual(preview.stageRows[0].rows.map(row => row.time), ['10:00〜10:10', '10:10〜10:25', '11:00〜11:10'])
  assert.deepEqual(preview.stageRows[0].rows.map(row => row.sectionLabel), ['第1部', '第1部 → 第2部（部間休憩）', '第2部'])
  assert.equal(preview.stageRows[1].rows.length, 0)
  assert.deepEqual(preview.paRows.map(row => row.role), ['Main PA', 'Sub PA', 'Main PA', 'Sub PA'])
  assert.deepEqual(preview.paRows.map(row => row.member), ['表示 main', '表示 sub', '表示 main', '表示 sub'])
  assert.deepEqual(preview.paRows.map(row => row.time), ['10:00〜10:10', '10:00〜10:10', '11:00〜11:10', '11:00〜11:10'])
  assert.equal(preview.summary.bands, 2)
  assert.equal(preview.summary.breaks, 1)
  assert.equal(preview.summary.paShifts, 4)
  assert.equal(preview.summary.schedulesEvaluated, 2)
  assert.equal(preview.summary.paPlansEvaluated, 4)
  assert.deepEqual(preview.summary.issues, { ERROR: 0, WARNING: 0, INFO: 0 })
  assert.equal(preview.scores.length, 8)
  assert.equal(Object.keys(GENERATION_SCORE_LABELS).length, 8)
  assert.deepEqual(input, original)
  assert.deepEqual(createTimetableGenerationPreview({ ...input, ...candidate, ...validation }), preview)
})

test('WARNING/INFOは最終guardをblockingせずpreviewへ残す', () => {
  const input = materializationInput()
  input.eventBands[0].preferredTimeRange = { from: '15:00', until: '16:00' }
  input.eventMemberDays.find(day => day.eventMemberId === 'em-main').participationStatus = 'undecided'
  const candidate = materializeTimetableGenerationPlan(input)
  const validation = validateTimetableGenerationCandidate(input, candidate)
  assert.equal(validation.ok, true)
  const preview = createTimetableGenerationPreview({ ...input, ...candidate, ...validation })
  assert.equal(preview.summary.issues.ERROR, 0)
  assert.ok(preview.summary.issues.INFO > 0)
  assert.deepEqual(preview.issues, validation.issues)
})

test('PA previewへ別Eventの同じDay IDに属するPAを混入させない', () => {
  const input = materializationInput()
  const candidate = materializeTimetableGenerationPlan(input)
  const validation = validateTimetableGenerationCandidate(input, candidate)
  assert.equal(candidate.ok, true)
  assert.equal(validation.ok, true)
  const foreignSameDay = { ...input.paAssignments[2], id: 'foreign-same-day', eventDayId: 'day-a1' }
  const preview = createTimetableGenerationPreview({ ...input, ...candidate, ...validation,
    paAssignments: [...candidate.paAssignments, foreignSameDay] })
  assert.deepEqual(preview.paRows.map(row => row.id), input.newPaAssignmentIds)
})
