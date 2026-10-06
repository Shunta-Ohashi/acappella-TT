import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEventFinalCheckReport,
  getFinalCheckRepairTarget,
} from '../src/domain/eventFinalCheck.ts'
import { resolveEventFinalCheckRepairNavigation } from '../src/ui/eventFinalCheckPresentation.ts'

const makeInput = () => ({
  event: {
    id: 'event-1', name: 'Final Check', timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 2, minimumRestMinutes: 30 },
    performanceSlotMinutes: [10],
  },
  eventDays: [{ id: 'day-1', eventId: 'event-1', date: '2027-11-01', label: '1日目', order: 0 }],
  stages: [{ id: 'stage-1', eventDayId: 'day-1', name: 'Main Stage', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' }],
  sections: [], members: [], eventMembers: [], eventMemberDays: [], eventBands: [],
  scheduleItems: [], paAssignments: [], dutyTypes: [], dutyAssignments: [],
  timetableLocks: [], timetableOrderConstraints: [],
})

const addMembersAndPerformance = (input) => {
  input.members.push(
    { id: 'member-a', realName: 'Alice', active: true },
    { id: 'member-b', realName: 'Bob', active: true },
  )
  input.eventMembers.push({ id: 'event-member-a', eventId: 'event-1',
    memberId: 'member-a', paCapabilities: { main: true, sub: true } })
  input.eventMemberDays.push({ id: 'event-member-day-a',
    eventMemberId: 'event-member-a', eventDayId: 'day-1', participationStatus: 'undecided' })
  input.eventBands.push({ id: 'band-a', eventId: 'event-1', eventDayId: 'day-1',
    name: 'Alpha', memberIds: ['member-a', 'member-b'], durationMinutes: 10,
    preferredTimeRange: { from: '11:00', until: '12:00' } })
  input.scheduleItems.push({ id: 'performance-a', stageId: 'stage-1', order: 0,
    kind: 'performance', eventBandId: 'band-a' })
  return input
}

test('問題のないEventはfinding 0でseverity countも0になる', () => {
  assert.deepEqual(createEventFinalCheckReport(makeInput()), {
    findings: [], counts: { ERROR: 0, WARNING: 0, INFO: 0 },
  })
})

test('EventDayなしはStep 1、DayのStageなしはStep 2のERRORにする', () => {
  const noDays = makeInput()
  noDays.eventDays = []
  noDays.stages = []
  const eventFinding = createEventFinalCheckReport(noDays).findings[0]
  assert.deepEqual([eventFinding.code, eventFinding.severity, eventFinding.targetStep],
    ['EVENT_DAY_MISSING', 'ERROR', 1])

  const noStages = makeInput()
  noStages.stages = []
  const stageFinding = createEventFinalCheckReport(noStages).findings
    .find(finding => finding.code === 'STAGE_MISSING')
  assert.deepEqual([stageFinding?.severity, stageFinding?.targetStep,
    stageFinding?.eventDayId], ['ERROR', 2, 'day-1'])
})

test('未配置BandをBand名と複数Dayの正しいscope付きでStep 6へ出す', () => {
  const input = makeInput()
  input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02',
    label: '2日目', order: 1 })
  input.stages.push({ id: 'stage-2', eventDayId: 'day-2', name: 'Sub Stage', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })
  input.eventBands.push(
    { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1', name: 'Alpha', memberIds: [], durationMinutes: 10 },
    { id: 'band-b', eventId: 'event-1', eventDayId: 'day-2', name: 'Bravo', memberIds: [], durationMinutes: 10 },
  )
  const findings = createEventFinalCheckReport(input).findings
    .filter(finding => finding.code === 'UNSCHEDULED_EVENT_BAND')
  assert.deepEqual(findings.map(finding => [finding.message, finding.eventDayId,
    finding.targetStep]), [
    ['バンド「Alpha」が未配置です。', 'day-1', 6],
    ['バンド「Bravo」が未配置です。', 'day-2', 6],
  ])
})

test('timeline計算失敗でもreportを返し、別Dayのfindingを継続する', () => {
  const input = makeInput()
  input.scheduleItems.push({ id: 'broken-performance', stageId: 'stage-1', order: 0,
    kind: 'performance', eventBandId: 'missing-band' })
  input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02',
    label: '2日目', order: 1 })
  const report = createEventFinalCheckReport(input)
  assert.ok(report.findings.some(finding =>
    finding.code === 'TIMELINE_CALCULATION_FAILED' && finding.eventDayId === 'day-1'))
  assert.ok(report.findings.some(finding =>
    finding.code === 'STAGE_MISSING' && finding.eventDayId === 'day-2'))
})

test('Section所属が不正なStageをStep 2のERRORとして反映する', () => {
  const input = makeInput()
  input.sections.push({ id: 'section-1', stageId: 'stage-1', name: '第1部', order: 0 })
  input.scheduleItems.push({ id: 'ambiguous-break', stageId: 'stage-1', order: 0,
    kind: 'break', title: '休憩', durationMinutes: 10 })
  const finding = createEventFinalCheckReport(input).findings
    .find(candidate => candidate.code === 'INVALID_STAGE_TIMELINE')
  assert.deepEqual([finding?.severity, finding?.targetStep, finding?.stageId],
    ['ERROR', 2, 'stage-1'])
})

test('既存ScheduleIssueのERROR/WARNING/INFOとhuman-facing名・修正先を維持する', () => {
  const report = createEventFinalCheckReport(addMembersAndPerformance(makeInput()))
  const memberError = report.findings.find(finding =>
    finding.code === 'MEMBER_NOT_REGISTERED_FOR_EVENT')
  const undecided = report.findings.find(finding =>
    finding.code === 'MEMBER_PARTICIPATION_UNDECIDED')
  const preference = report.findings.find(finding => finding.code === 'PREFERENCE_NOT_MET')
  assert.deepEqual([memberError?.severity, memberError?.targetStep], ['ERROR', 3])
  assert.match(memberError?.message ?? '', /Bob/)
  assert.equal(memberError?.message.includes('member-b'), false)
  assert.deepEqual([undecided?.severity, undecided?.targetStep], ['INFO', 3])
  assert.deepEqual([preference?.severity, preference?.targetStep], ['INFO', 5])
  assert.match(preference?.message ?? '', /Alpha/)
  assert.deepEqual(report.counts, { ERROR: 1, WARNING: 0, INFO: 2 })
})

test('EventBand day mismatchはStep 4へ案内する', () => {
  const input = addMembersAndPerformance(makeInput())
  input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02', order: 1 })
  input.stages.push({ id: 'stage-2', eventDayId: 'day-2', name: 'Sub', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })
  input.eventBands[0].eventDayId = 'day-2'
  const finding = createEventFinalCheckReport(input).findings
    .find(candidate => candidate.code === 'EVENT_BAND_DAY_MISMATCH')
  assert.equal(finding?.targetStep, 4)
})

test('既存のPerformance間隔WARNINGをseverity変更せずStep 6へ出す', () => {
  const input = makeInput()
  input.members.push({ id: 'member-a', realName: 'Alice', active: true })
  input.eventMembers.push({ id: 'event-member-a', eventId: 'event-1',
    memberId: 'member-a', paCapabilities: { main: true, sub: true } })
  input.eventMemberDays.push({ id: 'event-member-day-a',
    eventMemberId: 'event-member-a', eventDayId: 'day-1',
    participationStatus: 'participating' })
  input.eventBands.push(
    { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1', name: 'Alpha',
      memberIds: ['member-a'], durationMinutes: 10 },
    { id: 'band-b', eventId: 'event-1', eventDayId: 'day-1', name: 'Bravo',
      memberIds: ['member-a'], durationMinutes: 10 },
  )
  input.scheduleItems.push(
    { id: 'performance-a', stageId: 'stage-1', order: 0,
      kind: 'performance', eventBandId: 'band-a' },
    { id: 'performance-b', stageId: 'stage-1', order: 1,
      kind: 'performance', eventBandId: 'band-b' },
  )

  const finding = createEventFinalCheckReport(input).findings
    .find(candidate => candidate.code === 'BACK_TO_BACK')
  assert.deepEqual([finding?.severity, finding?.targetStep, finding?.stageId],
    ['WARNING', 6, 'stage-1'])
})

test('既存PA・Duty競合IssueをStep 6へ出す', () => {
  const input = makeInput()
  input.members.push({ id: 'member-a', realName: 'Alice', active: true })
  input.eventMembers.push({ id: 'event-member-a', eventId: 'event-1',
    memberId: 'member-a', paCapabilities: { main: true, sub: true } })
  input.eventMemberDays.push({ id: 'event-member-day-a',
    eventMemberId: 'event-member-a', eventDayId: 'day-1',
    participationStatus: 'participating' })
  input.eventBands.push({ id: 'band-a', eventId: 'event-1', eventDayId: 'day-1',
    name: 'Alpha', memberIds: ['member-a'], durationMinutes: 10 })
  input.scheduleItems.push({ id: 'performance-a', stageId: 'stage-1', order: 0,
    kind: 'performance', eventBandId: 'band-a' })
  input.dutyTypes.push({ id: 'duty-a', eventId: 'event-1', name: '撮影', order: 0 })
  input.paAssignments.push({ id: 'pa-a', eventId: 'event-1', eventDayId: 'day-1',
    stageId: 'stage-1', memberId: 'member-a', role: 'main',
    from: { kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'end' } })
  input.dutyAssignments.push({ id: 'duty-assignment-a', dutyTypeId: 'duty-a',
    eventDayId: 'day-1', stageId: 'stage-1', memberId: 'member-a',
    from: { kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'start' },
    until: { kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'end' } })

  const findings = createEventFinalCheckReport(input).findings
  for (const code of ['PA_MEMBER_PERFORMANCE_OVERLAP',
    'DUTY_MEMBER_PERFORMANCE_OVERLAP', 'DUTY_PA_OVERLAP']) {
    const finding = findings.find(candidate => candidate.code === code)
    assert.deepEqual([finding?.severity, finding?.targetStep], ['ERROR', 6], code)
  }
})

test('既存Stage終了超過IssueをStep 6へ出す', () => {
  const input = makeInput()
  input.stages[0].plannedEndTime = '10:05'
  input.eventBands.push({ id: 'band-a', eventId: 'event-1', eventDayId: 'day-1',
    name: 'Alpha', memberIds: [], durationMinutes: 10 })
  input.scheduleItems.push({ id: 'performance-a', stageId: 'stage-1', order: 0,
    kind: 'performance', eventBandId: 'band-a' })

  const finding = createEventFinalCheckReport(input).findings
    .find(candidate => candidate.code === 'STAGE_END_EXCEEDED')
  assert.deepEqual([finding?.severity, finding?.targetStep, finding?.stageId],
    ['ERROR', 6, 'stage-1'])
})

test('ScheduleIssue修正先mappingはStep 3〜6の既存責務へ対応する', () => {
  assert.equal(getFinalCheckRepairTarget('PA_MEMBER_ABSENT'), 3)
  assert.equal(getFinalCheckRepairTarget('DUTY_OUTSIDE_MEMBER_AVAILABILITY'), 3)
  assert.equal(getFinalCheckRepairTarget('EVENT_BAND_DAY_MISMATCH'), 4)
  assert.equal(getFinalCheckRepairTarget('OUTSIDE_BAND_AVAILABILITY'), 5)
  assert.equal(getFinalCheckRepairTarget('PREFERENCE_NOT_MET'), 5)
  for (const code of ['FIXED_POSITION_MISMATCH', 'PA_ASSIGNMENT_OVERLAP',
    'DUTY_ASSIGNMENT_OVERLAP', 'BACK_TO_BACK', 'SHORT_GAP', 'SHORT_REST',
    'STAGE_END_EXCEEDED', 'SECTION_END_EXCEEDED', 'SECTION_START_CONFLICT']) {
    assert.equal(getFinalCheckRepairTarget(code), 6, code)
  }
})

test('structural findingはStep 1・2、ScheduleIssueはStep 3〜6へ案内する', () => {
  const noDays = makeInput()
  noDays.eventDays = []
  noDays.stages = []
  assert.equal(createEventFinalCheckReport(noDays).findings[0]?.targetStep, 1)

  const noStages = makeInput()
  noStages.stages = []
  assert.equal(createEventFinalCheckReport(noStages).findings[0]?.targetStep, 2)
  assert.equal(getFinalCheckRepairTarget('MEMBER_ABSENT'), 3)
  assert.equal(getFinalCheckRepairTarget('EVENT_BAND_DAY_MISMATCH'), 4)
  assert.equal(getFinalCheckRepairTarget('OUTSIDE_BAND_AVAILABILITY'), 5)
  assert.equal(getFinalCheckRepairTarget('PERFORMANCE_OVERLAP'), 6)
})

test('Step 6修復先のvalidなEventDay・Stage scopeを保持する', () => {
  const input = makeInput()
  input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02',
    label: '2日目', order: 1 })
  input.stages.push({ id: 'stage-2', eventDayId: 'day-2', name: 'Sub Stage', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })

  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6, eventDayId: 'day-2', stageId: 'stage-2' },
    eventId: input.event.id,
    eventDays: input.eventDays,
    stages: input.stages,
    currentEventDayId: 'day-1',
    currentStageId: 'stage-1',
  }), { step: 6, eventDayId: 'day-2', stageId: 'stage-2' })
})

test('Step 6修復先のstale scopeをstateへ渡さず現在のvalid selectionへ戻す', () => {
  const input = makeInput()
  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6, eventDayId: 'deleted-day', stageId: 'deleted-stage' },
    eventId: input.event.id,
    eventDays: input.eventDays,
    stages: input.stages,
    currentEventDayId: 'day-1',
    currentStageId: 'stage-1',
  }), { step: 6, eventDayId: 'day-1', stageId: 'stage-1' })
})

test('Step 2〜5への修復移動ではTimetable scopeを変更対象に含めない', () => {
  const input = makeInput()
  for (const step of [2, 3, 4, 5]) {
    assert.deepEqual(resolveEventFinalCheckRepairNavigation({
      target: { step, eventDayId: 'day-1', stageId: 'stage-1' },
      eventId: input.event.id,
      eventDays: input.eventDays,
      stages: input.stages,
      currentEventDayId: 'day-1',
      currentStageId: 'stage-1',
    }), { step })
  }
})

test('TT固定と出演順制約のsemantic/scheduled violationをStep 6へ出す', () => {
  const input = makeInput()
  input.timetableLocks.push({ id: 'lock-missing', eventId: 'event-1',
    scheduleItemId: 'missing-item', stageId: 'stage-1', position: { kind: 'first' } })
  input.eventBands.push(
    { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1', name: 'Alpha', memberIds: [], durationMinutes: 10 },
    { id: 'band-b', eventId: 'event-1', eventDayId: 'day-1', name: 'Bravo', memberIds: [], durationMinutes: 10 },
  )
  input.timetableOrderConstraints.push(
    { id: 'constraint-invalid', eventId: 'event-1', eventDayId: 'day-1',
      stageId: 'stage-1', eventBandIds: ['band-a'] },
    { id: 'constraint-valid', eventId: 'event-1', eventDayId: 'day-1',
      stageId: 'stage-1', eventBandIds: ['band-a', 'band-b'] },
  )
  const report = createEventFinalCheckReport(input)
  assert.ok(report.findings.some(finding =>
    finding.category === 'timetable-lock' && finding.targetStep === 6))
  assert.ok(report.findings.some(finding =>
    finding.key.includes('order-semantic') && finding.targetStep === 6))
  assert.ok(report.findings.some(finding => finding.key.includes('order-scheduled') &&
    finding.code === 'MISSING_EVENT_BAND' && finding.targetStep === 6))
})

test('Grid外PA/DutyをWARNINGにし、参照切れは既存ERRORと重複表示しない', () => {
  const input = makeInput()
  input.members.push({ id: 'member-a', realName: 'Alice', active: true })
  input.eventMembers.push({ id: 'event-member-a', eventId: 'event-1',
    memberId: 'member-a', paCapabilities: { main: true, sub: true } })
  input.eventMemberDays.push({ id: 'event-member-day-a', eventMemberId: 'event-member-a',
    eventDayId: 'day-1', participationStatus: 'participating' })
  input.sections.push(
    { id: 'section-1', stageId: 'stage-1', name: '第1部', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '10:10' },
    { id: 'section-2', stageId: 'stage-1', name: '第2部', order: 1,
      plannedStartTime: '10:30', plannedEndTime: '10:40' },
  )
  input.eventBands.push(
    { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1', name: 'Alpha',
      memberIds: [], durationMinutes: 10 },
    { id: 'band-b', eventId: 'event-1', eventDayId: 'day-1', name: 'Bravo',
      memberIds: [], durationMinutes: 10 },
  )
  input.scheduleItems.push(
    { id: 'performance-a', stageId: 'stage-1', sectionId: 'section-1', order: 0,
      kind: 'performance', eventBandId: 'band-a' },
    { id: 'performance-b', stageId: 'stage-1', sectionId: 'section-2', order: 0,
      kind: 'performance', eventBandId: 'band-b' },
  )
  input.dutyTypes.push({ id: 'duty-1', eventId: 'event-1', name: '撮影', order: 0 })
  input.paAssignments.push(
    { id: 'pa-off-grid', eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
      memberId: 'member-a', role: 'main',
      from: { kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'end' },
      until: { kind: 'schedule-item', scheduleItemId: 'performance-b', edge: 'start' } },
    { id: 'pa-broken', eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
      memberId: 'member-a', role: 'sub',
      from: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'end' } },
  )
  input.dutyAssignments.push(
    { id: 'duty-off-grid', dutyTypeId: 'duty-1', eventDayId: 'day-1',
      stageId: 'stage-1', memberId: 'member-a',
      from: { kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'end' },
      until: { kind: 'schedule-item', scheduleItemId: 'performance-b', edge: 'start' } },
    { id: 'duty-broken', dutyTypeId: 'duty-1', eventDayId: 'day-1',
      stageId: 'stage-1', memberId: 'member-a',
      from: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'missing', edge: 'end' } },
  )
  const report = createEventFinalCheckReport(input)
  assert.ok(report.findings.some(finding =>
    finding.code === 'OFF_GRID_PA_ASSIGNMENT' && finding.severity === 'WARNING'))
  assert.ok(report.findings.some(finding =>
    finding.code === 'OFF_GRID_DUTY_ASSIGNMENT' && finding.severity === 'WARNING'))
  assert.ok(report.findings.some(finding => finding.code === 'PA_INVALID_BOUNDARY'))
  assert.ok(report.findings.some(finding => finding.code === 'DUTY_INVALID_BOUNDARY'))
  assert.equal(report.findings.some(finding =>
    finding.key === 'operations|unresolved-pa|pa-broken'), false)
  assert.equal(report.findings.some(finding =>
    finding.key === 'operations|unresolved-duty|duty-broken'), false)
})

test('reportはdeterministic・stable key uniqueで入力を変更しない', () => {
  const input = addMembersAndPerformance(makeInput())
  const before = structuredClone(input)
  const first = createEventFinalCheckReport(input)
  const second = createEventFinalCheckReport(input)
  assert.deepEqual(second, first)
  assert.equal(new Set(first.findings.map(finding => finding.key)).size,
    first.findings.length)
  assert.deepEqual(input, before)
  assert.deepEqual(first.findings.map(finding => finding.severity),
    ['ERROR', 'INFO', 'INFO'])
})
