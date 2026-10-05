import test from 'node:test'
import assert from 'node:assert/strict'
import { presentTimetableGenerationFailure, createTimetableGenerationPreview, GENERATION_SCORE_LABELS } from '../src/ui/timetableGenerationPresentation.ts'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'
import { materializationInput } from './fixtures/timetableGenerationUi.mjs'

for (const [code, wording] of [
  ['INVALID_INPUT', /設定/], ['INVALID_LOCK_CONSTRAINTS', /TT固定/],
  ['INVALID_ORDER_CONSTRAINTS', /出演順制約/],
  ['BROKEN_DUTY_ASSIGNMENT', /当日運営担当/], ['NO_MAIN_PA_CANDIDATE', /Main PA/],
  ['NO_SUB_PA_CANDIDATE', /Sub PA/], ['NO_FEASIBLE_PA_PLAN', /PA担当/],
  ['NO_FEASIBLE_SCHEDULE', /タイムテーブル/], ['SEARCH_LIMIT_REACHED', /探索上限/],
]) {
  test(`${code}を構造化して表示し探索件数を含める`, () => {
    const presentation = presentTimetableGenerationFailure(
      { code, eventDayId: 'day-a1', attemptedSchedules: 3 },
      materializationInput(),
    )
    assert.equal(presentation.code, code)
    assert.match(presentation.title, wording)
    assert.ok(presentation.summary.length > 0)
    assert.ok(presentation.checks.length > 0)
    assert.ok(presentation.details.includes('評価したタイムテーブル候補: 3件'))
    assert.ok(presentation.details.includes(`エラーコード: ${code}`))
  })
}

test('failure referenceをStage・Section・バンド名へ階層的に解決する', () => {
  const failure = { code: 'INVALID_INPUT', eventDayId: 'day-a1', attemptedSchedules: 0,
    stageId: 'stage-a1', sectionId: 'section-1', eventBandId: 'band-2' }
  const details = presentTimetableGenerationFailure(failure, materializationInput()).details
  assert.deepEqual(details.slice(0, 3), [
    'Stage: Main Stage', 'Section: 第1部', 'バンド: Blend Note',
  ])

  const sectionOnly = presentTimetableGenerationFailure({
    code: 'BROKEN_DUTY_ASSIGNMENT', eventDayId: 'day-a1', attemptedSchedules: 0,
    sectionId: 'section-1',
  }, materializationInput())
  assert.deepEqual(sectionOnly.details.slice(0, 2), ['Stage: Main Stage', 'Section: 第1部'])
})

test('missing referenceはthrowせずIDへfallbackする', () => {
  const presentation = presentTimetableGenerationFailure({
    code: 'INVALID_INPUT', eventDayId: 'day-a1', attemptedSchedules: 0,
    stageId: 'missing-stage', sectionId: 'missing-section', eventBandId: 'missing-band',
  }, materializationInput())
  assert.deepEqual(presentation.details.slice(0, 3), [
    'Stage: missing-stage', 'Section: missing-section', 'バンド: missing-band',
  ])
})

test('failure codeごとに実際に変更できる確認先を案内する', () => {
  const references = materializationInput()
  const checks = (code) => presentTimetableGenerationFailure({
    code, eventDayId: 'day-a1', attemptedSchedules: 1,
  }, references).checks.join(' ')

  assert.match(checks('INVALID_INPUT'), /Step 2.*Step 3.*Step 4.*Step 6/)
  assert.match(checks('INVALID_LOCK_CONSTRAINTS'), /TT固定.*解除/)
  assert.match(checks('INVALID_ORDER_CONSTRAINTS'), /出演順制約.*固定配置.*TT固定/)
  assert.match(checks('BROKEN_DUTY_ASSIGNMENT'), /当日運営.*担当開始・終了/)
  assert.match(checks('NO_MAIN_PA_CANDIDATE'), /Main PA担当可.*参加状況.*参加可能時間/)
  assert.match(checks('NO_SUB_PA_CANDIDATE'), /Sub PA担当可.*参加状況.*参加可能時間/)
  assert.match(
    presentTimetableGenerationFailure({
      code: 'NO_FEASIBLE_PA_PLAN', eventDayId: 'day-a1', attemptedSchedules: 1,
    }, references).summary,
    /PA担当可能者はいますが.*組み合わせ/,
  )
})

test('INVALID_INPUTは対象Bandを最初の確認先として案内する', () => {
  const presentation = presentTimetableGenerationFailure({
    code: 'INVALID_INPUT', eventDayId: 'day-a1', attemptedSchedules: 0,
    eventBandId: 'band-2',
  }, materializationInput())
  assert.match(presentation.checks[0], /Step 4.*Blend Note.*出演枠.*固定配置/)
})

test('NO_FEASIBLE_SCHEDULEは複数条件を順番に案内し原因を断定しない', () => {
  const presentation = presentTimetableGenerationFailure({
    code: 'NO_FEASIBLE_SCHEDULE', eventDayId: 'day-a1', attemptedSchedules: 4,
  }, materializationInput())
  assert.match(presentation.summary, /複数の必須条件の組み合わせ/)
  assert.equal(presentation.checks.length, 6)
  assert.match(presentation.checks.join(' '), /Stage・Section.*固定配置.*TT固定.*出演順制約.*掛け持ち.*当日運営担当・PA担当/)
  assert.doesNotMatch(`${presentation.summary} ${presentation.checks.join(' ')}`, /が原因です/)
})

test('候補0件は探索前段階の可能性として表示し原因を断定しない', () => {
  const presentation = presentTimetableGenerationFailure({
    code: 'NO_FEASIBLE_SCHEDULE', eventDayId: 'day-a1', attemptedSchedules: 0,
  }, materializationInput())
  assert.match(presentation.summary, /候補を評価できる段階まで到達していない可能性/)
  assert.ok(presentation.details.includes('評価したタイムテーブル候補: 0件'))
  assert.doesNotMatch(presentation.summary, /固定配置が原因/)
})

test('SEARCH_LIMIT_REACHEDは変更可能な条件だけを案内する', () => {
  const presentation = presentTimetableGenerationFailure({
    code: 'SEARCH_LIMIT_REACHED', eventDayId: 'day-a1', attemptedSchedules: 24,
  }, materializationInput())
  const checks = presentation.checks.join(' ')
  assert.match(checks, /固定配置.*TT固定.*出演順制約.*出演可能時間.*条件を少し緩め/)
  assert.doesNotMatch(checks, /探索上限を増や/)
})

test('同じfailureとreferenceからdeterministicなpresentationを返し入力を変更しない', () => {
  const references = materializationInput()
  const failure = {
    code: 'INVALID_INPUT', eventDayId: 'day-a1', attemptedSchedules: 0,
    stageId: 'stage-a1', sectionId: 'section-1', eventBandId: 'band-2',
  }
  const originalReferences = structuredClone(references)
  const originalFailure = structuredClone(failure)
  const first = presentTimetableGenerationFailure(failure, references)
  assert.deepEqual(presentTimetableGenerationFailure(failure, references), first)
  assert.deepEqual(references, originalReferences)
  assert.deepEqual(failure, originalFailure)
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
