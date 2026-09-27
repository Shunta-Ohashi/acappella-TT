import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { createDemoData } from '../src/data/demoData.ts'
import { detectScheduleIssues } from '../src/domain/issues.ts'
import { calculateEventDayTimelines } from '../src/domain/timetable.ts'
import { GENERATION_DEMO_EVENT_ID } from '../src/data/generationDemoData.ts'
import { generateTimetablePlan } from '../src/domain/timetableGeneration.ts'
import { materializeTimetableGenerationPlan, validateTimetableGenerationCandidate } from '../src/domain/timetableGenerationApply.ts'
import { CURRENT_STORAGE_VERSION, serializePersistedState, parsePersistedState } from '../src/persistence/localPersistence.ts'
import { createBackupJson, parseBackupJson } from '../src/persistence/dataBackup.ts'
import { evaluateTimetableLocks } from '../src/domain/timetableLocks.ts'
import { createTimetableWorkspaceRows } from '../src/ui/timetableWorkspaceRows.ts'

test('demoDataは想定件数と全EventDayのdomain invariantを満たす', () => {
  const data = createDemoData()

  assert.deepEqual({
    events: data.events.length,
    eventDays: data.eventDays.length,
    members: data.members.length,
    bands: data.bands.length,
    eventBands: data.eventBands.length,
    stages: data.stages.length,
    sections: data.sections.length,
    scheduleItems: data.scheduleItems.length,
    paAssignments: data.paAssignments.length,
    dutyTypes: data.dutyTypes.length,
    dutyAssignments: data.dutyAssignments.length,
    timetableLocks: data.timetableLocks.length,
  }, {
    events: 3,
    eventDays: 5,
    members: 17,
    bands: 10,
    eventBands: 18,
    stages: 9,
    sections: 10,
    scheduleItems: 15,
    paAssignments: 4,
    dutyTypes: 4,
    dutyAssignments: 5,
    timetableLocks: 1,
  })

  for (const eventDay of data.eventDays) {
    const event = data.events.find((candidate) =>
      candidate.id === eventDay.eventId,
    )
    assert.ok(event, `Eventが見つかりません: ${eventDay.eventId}`)

    const eventBands = data.eventBands.filter((eventBand) =>
      eventBand.eventId === event.id,
    )
    const stages = data.stages.filter((stage) =>
      stage.eventDayId === eventDay.id,
    )
    const timelines = calculateEventDayTimelines({
      event,
      eventDayId: eventDay.id,
      stages: data.stages,
      sections: data.sections,
      scheduleItems: data.scheduleItems,
      eventBands,
    })

    assert.deepEqual(
      timelines.invalidStages,
      [],
      `${eventDay.id}に不正なStage timelineがあります`,
    )

    const errors = detectScheduleIssues({
      event,
      members: data.members,
      eventMembers: data.eventMembers.filter((eventMember) =>
        eventMember.eventId === event.id,
      ),
      eventMemberDays: data.eventMemberDays,
      eventBands,
      stages,
      sections: data.sections,
      paAssignments: data.paAssignments.filter((assignment) =>
        assignment.eventId === event.id &&
        assignment.eventDayId === eventDay.id,
      ),
      dutyTypes: data.dutyTypes.filter((dutyType) =>
        dutyType.eventId === event.id,
      ),
      dutyAssignments: data.dutyAssignments.filter((assignment) =>
        assignment.eventDayId === eventDay.id,
      ),
      calculatedItems: timelines.calculatedItems,
    }).filter((issue) => issue.severity === 'ERROR')

    assert.deepEqual(
      errors,
      [],
      `${eventDay.id}の初期IssueにERRORがあります`,
    )
    assert.deepEqual(evaluateTimetableLocks({ ...data, eventId: event.id }).violations, [])
  }
})

for (const dayIndex of [0, 1]) {
  test(`自動生成デモ${dayIndex + 1}日目は既定設定で生成・適用でき、他日・既存デモ・Duty・Lockを保つ`, () => {
    const data = createDemoData()
    const event = data.events.find(event => event.id === GENERATION_DEMO_EVENT_ID)
    const eventDay = data.eventDays.filter(day => day.eventId === event.id)[dayIndex]
    const input = { ...data, event, eventDay }
    const original = structuredClone(data)
    const generated = generateTimetablePlan(input)
    assert.equal(generated.ok, true, JSON.stringify(generated))
    const candidate = materializeTimetableGenerationPlan({ ...input, plan: generated.plan,
      newScheduleItemIds: generated.plan.placements.filter(p => !p.scheduleItemId).map((_, i) => `generated-demo-${dayIndex}-performance-${i}`),
      newPaAssignmentIds: generated.plan.paShifts.map((_, i) => `generated-demo-${dayIndex}-pa-${i}`),
    })
    assert.equal(candidate.ok, true, JSON.stringify(candidate))
    const validation = validateTimetableGenerationCandidate(input, candidate)
    assert.equal(validation.ok, true, JSON.stringify(validation))
    assert.equal(validation.issues.filter(issue => issue.severity === 'ERROR').length, 0)
    assert.equal(generated.plan.placements.length, 4)
    assert.ok(generated.plan.paShifts.some(shift => shift.role === 'main'))
    assert.ok(generated.plan.paShifts.some(shift => shift.role === 'sub'))
    const dayStageIds = new Set(data.stages.filter(stage => stage.eventDayId === eventDay.id).map(stage => stage.id))
    assert.deepEqual(candidate.scheduleItems.filter(item => !dayStageIds.has(item.stageId)),
      data.scheduleItems.filter(item => !dayStageIds.has(item.stageId)))
    assert.deepEqual(candidate.paAssignments.filter(pa => pa.eventDayId !== eventDay.id),
      data.paAssignments.filter(pa => pa.eventDayId !== eventDay.id))
    assert.deepEqual(data, original, '生成・プレビューは元データを変更しない')
    const restored = parsePersistedState(serializePersistedState({ ...data,
      scheduleItems: candidate.scheduleItems, paAssignments: candidate.paAssignments }))
    assert.ok(restored, '生成適用後もreloadできるsnapshotである')
    assert.deepEqual(restored.dutyAssignments, data.dutyAssignments)
    assert.deepEqual(restored.timetableLocks, data.timetableLocks)
  })
}

test('デモ初期データ全体をsnapshotで復元でき、各生成日にはPool候補と独立した同一固定バンドの出演がある', () => {
  const data = createDemoData()
  const restored = parsePersistedState(serializePersistedState(data))
  assert.ok(restored)
  const { initialEventId, initialEventDayId, initialStageId, ...domain } = data
  assert.deepEqual(restored, { version: CURRENT_STORAGE_VERSION, ...domain })
  assert.equal(initialEventId, 'event-demo-main', '既存デモの初期選択を変えない')
  assert.equal(initialEventDayId, 'event-day-demo-main-01')
  assert.equal(initialStageId, 'stage-demo-main-day1')
  const scheduled = new Set(data.scheduleItems.filter(item => item.kind === 'performance').map(item => item.eventBandId))
  const days = data.eventDays.filter(day => day.eventId === GENERATION_DEMO_EVENT_ID)
  for (const day of days) {
    assert.ok(data.eventBands.some(band => band.eventDayId === day.id && !scheduled.has(band.id)))
  }
  for (const band of data.bands.filter(band => band.id.startsWith('band-demo-generation-'))) {
    const appearances = data.eventBands.filter(appearance => appearance.bandId === band.id)
    assert.equal(appearances.length, 2)
    assert.notEqual(appearances[0].id, appearances[1].id)
    assert.notEqual(appearances[0].eventDayId, appearances[1].eventDayId)
  }
  const original = structuredClone(data)
  const another = createDemoData()
  data.eventBands.at(-1).memberIds.pop()
  data.eventMemberDays.at(-1).participationStatus = 'absent'
  assert.deepEqual(another, original)
})

test('自動生成デモの部内休憩に撮影3名とPAを欠落なく表示するデータがある', () => {
  const data = createDemoData()
  const event = data.events.find(event => event.id === GENERATION_DEMO_EVENT_ID)
  const eventDay = data.eventDays.find(day => day.eventId === event.id)
  const stage = data.stages.find(stage => stage.eventDayId === eventDay.id)
  const timelines = calculateEventDayTimelines({ ...data, event, eventDayId: eventDay.id })
  const rows = createTimetableWorkspaceRows({ ...data, eventDayId: eventDay.id,
    stageId: stage.id, calculatedItems: timelines.calculatedItems, issues: [] }).rows
  const photo = rows.find(row => row.scheduleItem.id === 'break-demo-generation-inside')
    .dutyCoverage['duty-demo-generation-photo']
  assert.deepEqual(photo.map(coverage => coverage.memberName), ['こう', 'りお', 'すい'])
  const opening = rows.find(row => row.scheduleItem.id === 'schedule-demo-generation-opening')
  assert.deepEqual(opening.paCoverage.main.map(coverage => coverage.memberName), ['はる'])
  assert.deepEqual(opening.paCoverage.sub.map(coverage => coverage.memberName), ['さき'])
})

test('ブラウザ確認用JSONは現在のdemoDataと同じ有効なバックアップである', () => {
  const json = readFileSync(new URL('../public/demo-browser-backup.json', import.meta.url), 'utf8')
  assert.deepEqual(parseBackupJson(json), parseBackupJson(createBackupJson(createDemoData())))
  assert.ok(parseBackupJson(json))
})

test('確認手順どおりMain PA担当可否を全員無効にすると生成失敗になり、元TTを変更しない', () => {
  const data = createDemoData()
  const event = data.events.find(event => event.id === GENERATION_DEMO_EVENT_ID)
  const eventDay = data.eventDays.find(day => day.eventId === event.id)
  data.eventMembers = data.eventMembers.map(member => member.eventId === event.id
    ? { ...member, paCapabilities: { ...member.paCapabilities, main: false } } : member)
  const original = structuredClone(data)
  const result = generateTimetablePlan({ ...data, event, eventDay })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'NO_MAIN_PA_CANDIDATE')
  assert.deepEqual(data, original)
})
