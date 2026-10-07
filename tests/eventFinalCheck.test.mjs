import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEventFinalCheckReport,
  getFinalCheckRepairTarget,
  getFinalCheckRepairTargetForIssue,
} from '../src/ui/eventFinalCheckReport.ts'
import {
  getEventFinalCheckStatusMessage,
  groupEventFinalCheckFindingsForDisplay,
  resolveEventFinalCheckRepairNavigation,
} from '../src/ui/eventFinalCheckPresentation.ts'

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

const addOperationsMember = (input) => {
  input.members.push({ id: 'member-a', realName: 'Alice', active: true })
  input.eventMembers.push({ id: 'event-member-a', eventId: 'event-1',
    memberId: 'member-a', paCapabilities: { main: true, sub: true } })
  input.eventMemberDays.push({ id: 'event-member-day-a',
    eventMemberId: 'event-member-a', eventDayId: 'day-1',
    participationStatus: 'participating' })
  input.dutyTypes.push({ id: 'duty-a', eventId: 'event-1', name: '撮影', order: 0 })
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

test('Stage単位のTimeline failureを隔離し前後Stageの評価を継続する', () => {
  const input = addOperationsMember(makeInput())
  input.stages = [
    { id: 'stage-a', eventDayId: 'day-1', name: 'Stage A', order: 0,
      plannedStartTime: '10:00', plannedEndTime: '18:00' },
    { id: 'stage-b', eventDayId: 'day-1', name: 'Stage B', order: 1,
      plannedStartTime: '10:00', plannedEndTime: '18:00' },
    { id: 'stage-c', eventDayId: 'day-1', name: 'Stage C', order: 2,
      plannedStartTime: '10:00', plannedEndTime: '10:05' },
  ]
  input.sections.push({ id: 'section-a', stageId: 'stage-a', name: '第1部', order: 0 })
  input.eventBands.push({ id: 'band-c', eventId: 'event-1', eventDayId: 'day-1',
    name: 'Charlie', memberIds: [], durationMinutes: 10 })
  input.scheduleItems.push(
    { id: 'invalid-break-a', stageId: 'stage-a', order: 0,
      kind: 'break', title: '所属不正', durationMinutes: 5 },
    { id: 'missing-performance-b', stageId: 'stage-b', order: 0,
      kind: 'performance', eventBandId: 'missing-band' },
    { id: 'performance-c', stageId: 'stage-c', order: 0,
      kind: 'performance', eventBandId: 'band-c' },
  )
  input.paAssignments.push(
    { id: 'pa-invalid-stage', eventId: 'event-1', eventDayId: 'day-1',
      stageId: 'stage-a', memberId: 'member-a', role: 'main',
      from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' } },
    { id: 'pa-failed-stage', eventId: 'event-1', eventDayId: 'day-1',
      stageId: 'stage-b', memberId: 'member-a', role: 'sub',
      from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' } },
  )
  input.dutyAssignments.push(
    { id: 'duty-invalid-stage', dutyTypeId: 'duty-a', eventDayId: 'day-1',
      stageId: 'stage-a', memberId: 'member-a',
      from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' } },
    { id: 'duty-failed-stage', dutyTypeId: 'duty-a', eventDayId: 'day-1',
      stageId: 'stage-b', memberId: 'member-a',
      from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' } },
  )

  const report = createEventFinalCheckReport(input)
  assert.ok(report.findings.some(finding =>
    finding.code === 'INVALID_STAGE_TIMELINE' && finding.stageId === 'stage-a'))
  assert.ok(report.findings.some(finding =>
    finding.code === 'TIMELINE_CALCULATION_FAILED' && finding.stageId === 'stage-b'))
  assert.ok(report.findings.some(finding =>
    finding.code === 'STAGE_END_EXCEEDED' && finding.stageId === 'stage-c'))
  assert.equal(report.findings.some(finding =>
    finding.code === 'WORKSPACE_EVALUATION_FAILED' &&
    (finding.stageId === 'stage-a' || finding.stageId === 'stage-b')), false)
  assert.equal(report.findings.some(finding =>
    finding.code === 'PA_INVALID_BOUNDARY'), false)
  assert.equal(report.findings.some(finding =>
    finding.code === 'DUTY_INVALID_BOUNDARY'), false)
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

test('selected EventのEventBand・PA・Dutyがmissing/foreign EventDayを参照したらERRORにする', () => {
  const cases = [
    { kind: 'band', dayId: 'missing-day', expectedCode: 'EVENT_BAND_EVENT_DAY_NOT_FOUND',
      expectedStep: 4 },
    { kind: 'band', dayId: 'foreign-day', expectedCode: 'EVENT_BAND_EVENT_DAY_MISMATCH',
      expectedStep: 4 },
    { kind: 'pa', dayId: 'missing-day', expectedCode: 'PA_EVENT_DAY_NOT_FOUND',
      expectedStep: 6 },
    { kind: 'pa', dayId: 'foreign-day', expectedCode: 'PA_EVENT_DAY_MISMATCH',
      expectedStep: 6 },
    { kind: 'duty', dayId: 'missing-day', expectedCode: 'DUTY_EVENT_DAY_NOT_FOUND',
      expectedStep: 6 },
    { kind: 'duty', dayId: 'foreign-day', expectedCode: 'DUTY_EVENT_DAY_MISMATCH',
      expectedStep: 6 },
  ]

  for (const { kind, dayId, expectedCode, expectedStep } of cases) {
    const input = makeInput()
    input.eventDays.push({ id: 'foreign-day', eventId: 'event-2',
      date: '2027-11-02', label: '別イベント', order: 0 })
    if (kind === 'band') input.eventBands.push({
      id: `band-${dayId}`, eventId: 'event-1', eventDayId: dayId,
      name: 'Alpha', memberIds: [], durationMinutes: 10,
    })
    if (kind === 'pa') input.paAssignments.push({
      id: `pa-${dayId}`, eventId: 'event-1', eventDayId: dayId,
      stageId: 'stage-1', memberId: 'member-a', role: 'main',
      from: { kind: 'time', time: '10:00' },
      until: { kind: 'time', time: '11:00' },
    })
    if (kind === 'duty') {
      input.dutyTypes.push({ id: 'duty-a', eventId: 'event-1', name: '撮影', order: 0 })
      input.dutyAssignments.push({
        id: `duty-${dayId}`, dutyTypeId: 'duty-a', eventDayId: dayId,
        stageId: 'stage-1', memberId: 'member-a',
        from: { kind: 'time', time: '10:00' },
        until: { kind: 'time', time: '11:00' },
      })
    }

    const report = createEventFinalCheckReport(input)
    const finding = report.findings.find(candidate => candidate.code === expectedCode)
    assert.deepEqual([finding?.severity, finding?.targetStep],
      ['ERROR', expectedStep], `${kind}:${dayId}`)
    assert.ok(report.findings.length > 0, `${kind}:${dayId}`)
    if (kind === 'pa') {
      assert.equal(report.findings.some(candidate =>
        candidate.code === 'PA_INVALID_BOUNDARY'), false, `${kind}:${dayId}: canonical`)
    }
    if (kind === 'duty') {
      assert.equal(report.findings.some(candidate =>
        candidate.code === 'DUTY_INVALID_BOUNDARY'), false, `${kind}:${dayId}: canonical`)
    }
  }
})

test('valid EventDayのmissing・別Day Stage参照をPA/Duty boundary ERRORとして残す', () => {
  for (const { kind, stageId } of [
    { kind: 'pa', stageId: 'missing-stage' },
    { kind: 'pa', stageId: 'stage-2' },
    { kind: 'pa', stageId: 'foreign-stage' },
    { kind: 'duty', stageId: 'missing-stage' },
    { kind: 'duty', stageId: 'stage-2' },
    { kind: 'duty', stageId: 'foreign-stage' },
  ]) {
    const input = addOperationsMember(makeInput())
    input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02',
      label: '2日目', order: 1 })
    input.eventDays.push({ id: 'foreign-day', eventId: 'event-2', date: '2027-11-03',
      label: '別イベント', order: 0 })
    input.stages.push(
      { id: 'stage-2', eventDayId: 'day-2', name: 'Day 2 Stage', order: 0,
        plannedStartTime: '10:00', plannedEndTime: '18:00' },
      { id: 'foreign-stage', eventDayId: 'foreign-day', name: 'Foreign Stage', order: 0,
        plannedStartTime: '10:00', plannedEndTime: '18:00' },
    )
    if (kind === 'pa') input.paAssignments.push({
      id: `pa-${stageId}`, eventId: 'event-1', eventDayId: 'day-1', stageId,
      memberId: 'member-a', role: 'main',
      from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' },
    })
    if (kind === 'duty') input.dutyAssignments.push({
      id: `duty-${stageId}`, dutyTypeId: 'duty-a', eventDayId: 'day-1', stageId,
      memberId: 'member-a',
      from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' },
    })

    const report = createEventFinalCheckReport(input)
    const code = kind === 'pa' ? 'PA_INVALID_BOUNDARY' : 'DUTY_INVALID_BOUNDARY'
    const findings = report.findings.filter(finding => finding.code === code)
    assert.equal(findings.length, 1, `${kind}:${stageId}`)
    assert.deepEqual({
      severity: findings[0].severity,
      targetStep: findings[0].targetStep,
      eventDayId: findings[0].eventDayId,
      stageId: findings[0].stageId,
    }, {
      severity: 'ERROR', targetStep: 6, eventDayId: 'day-1', stageId: undefined,
    }, `${kind}:${stageId}: safe repair scope`)
    if (stageId === 'missing-stage') {
      assert.match(findings[0].message, /不明なStage/, `${kind}:${stageId}: safe label`)
    }
  }
})

test('正常Stageの正常PA/Dutyはinvalid boundaryにならない', () => {
  const input = addOperationsMember(makeInput())
  input.paAssignments.push({
    id: 'pa-valid', eventId: 'event-1', eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-a', role: 'main',
    from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' },
  })
  input.dutyAssignments.push({
    id: 'duty-valid', dutyTypeId: 'duty-a', eventDayId: 'day-1', stageId: 'stage-1',
    memberId: 'member-a',
    from: { kind: 'time', time: '10:00' }, until: { kind: 'time', time: '11:00' },
  })

  const report = createEventFinalCheckReport(input)
  assert.equal(report.findings.some(finding =>
    finding.code === 'PA_INVALID_BOUNDARY' || finding.code === 'DUTY_INVALID_BOUNDARY'), false)
})

test('invalid EventDayのEventBandはstructural findingだけをcanonicalにする', () => {
  for (const { dayId, expectedCode } of [
    { dayId: 'missing-day', expectedCode: 'EVENT_BAND_EVENT_DAY_NOT_FOUND' },
    { dayId: 'foreign-day', expectedCode: 'EVENT_BAND_EVENT_DAY_MISMATCH' },
  ]) {
    const input = makeInput()
    input.eventDays.push({ id: 'foreign-day', eventId: 'event-2',
      date: '2027-11-02', label: '別イベント', order: 0 })
    input.eventBands.push({
      id: `band-${dayId}`, eventId: 'event-1', eventDayId: dayId,
      name: 'Alpha', memberIds: [], durationMinutes: 10,
    })
    input.scheduleItems.push({
      id: `performance-${dayId}`, stageId: 'stage-1', order: 0,
      kind: 'performance', eventBandId: `band-${dayId}`,
    })

    const report = createEventFinalCheckReport(input)
    assert.equal(report.findings.filter(finding => finding.code === expectedCode).length, 1,
      `${dayId}: structural finding`)
    assert.equal(report.findings.some(finding =>
      finding.code === 'EVENT_BAND_DAY_MISMATCH'), false,
    `${dayId}: secondary mismatch`)
  }
})

test('Final Check status本文はfindingのseverity構成を区別する', () => {
  assert.equal(getEventFinalCheckStatusMessage({ ERROR: 0, WARNING: 0, INFO: 0 }),
    '問題は見つかりませんでした。')
  assert.equal(getEventFinalCheckStatusMessage({ ERROR: 1, WARNING: 1, INFO: 1 }),
    'ERRORの項目を確認し、各Stepで修正してください。')
  assert.equal(getEventFinalCheckStatusMessage({ ERROR: 0, WARNING: 1, INFO: 0 }),
    '致命的な問題はありません。警告を確認してください。')
  assert.equal(getEventFinalCheckStatusMessage({ ERROR: 0, WARNING: 0, INFO: 1 }),
    '致命的な問題はありません。情報を確認してください。')
  assert.equal(getEventFinalCheckStatusMessage({ ERROR: 0, WARNING: 1, INFO: 1 }),
    '致命的な問題はありません。警告・情報を確認してください。')
})

test('PREFERENCE_NOT_METはMember由来をStep 3、Band由来をStep 5へ案内する', () => {
  const memberPreference = {
    severity: 'INFO', code: 'PREFERENCE_NOT_MET',
    message: 'メンバー member-a の出演希望時間外です',
    memberIds: ['member-a'], eventBandIds: ['band-a'], scheduleItemIds: ['item-a'],
  }
  const bandPreference = {
    severity: 'INFO', code: 'PREFERENCE_NOT_MET',
    message: 'EventBand band-a の出演希望時間外です',
    eventBandIds: ['band-a'], scheduleItemIds: ['item-a'],
  }

  assert.equal(getFinalCheckRepairTargetForIssue(memberPreference), 3)
  assert.equal(getFinalCheckRepairTargetForIssue(bandPreference), 5)

  const input = makeInput()
  input.members.push({ id: 'member-a', realName: 'Alice', active: true })
  input.eventMembers.push({ id: 'event-member-a', eventId: 'event-1',
    memberId: 'member-a', paCapabilities: { main: true, sub: true } })
  input.eventMemberDays.push({ id: 'event-member-day-a',
    eventMemberId: 'event-member-a', eventDayId: 'day-1',
    participationStatus: 'participating',
    preferredTimeRange: { from: '11:00', until: '12:00' } })
  input.eventBands.push({ id: 'band-a', eventId: 'event-1', eventDayId: 'day-1',
    name: 'Alpha', memberIds: ['member-a'], durationMinutes: 10,
    preferredTimeRange: { from: '11:00', until: '12:00' } })
  input.scheduleItems.push({ id: 'performance-a', stageId: 'stage-1', order: 0,
    kind: 'performance', eventBandId: 'band-a' })

  const preferenceFindings = createEventFinalCheckReport(input).findings
    .filter(finding => finding.code === 'PREFERENCE_NOT_MET')
  const memberFinding = preferenceFindings.find(finding => finding.message.includes('Alice'))
  const bandFinding = preferenceFindings.find(finding => finding.message.includes('Alpha'))
  assert.deepEqual([memberFinding?.severity, memberFinding?.targetStep], ['INFO', 3])
  assert.deepEqual([bandFinding?.severity, bandFinding?.targetStep], ['INFO', 5])
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
  input.stages.push({ id: 'stage-1-b', eventDayId: 'day-1', name: 'Stage B', order: 1,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })
  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6, eventDayId: 'deleted-day', stageId: 'deleted-stage' },
    eventId: input.event.id,
    eventDays: input.eventDays,
    stages: input.stages,
    currentEventDayId: 'day-1',
    currentStageId: 'stage-1-b',
  }), { step: 6, eventDayId: 'day-1', stageId: 'stage-1-b' })
})

test('Step 6修復先scopeなしでは現在Day・Stageを維持する', () => {
  const input = makeInput()
  input.stages.push({ id: 'stage-1-b', eventDayId: 'day-1', name: 'Stage B', order: 1,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })
  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6 }, eventId: input.event.id,
    eventDays: input.eventDays, stages: input.stages,
    currentEventDayId: 'day-1', currentStageId: 'stage-1-b',
  }), { step: 6, eventDayId: 'day-1', stageId: 'stage-1-b' })
  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6, eventDayId: 'day-1', stageId: 'deleted-stage' },
    eventId: input.event.id,
    eventDays: input.eventDays,
    stages: input.stages,
    currentEventDayId: 'day-1',
    currentStageId: 'stage-1-b',
  }), { step: 6, eventDayId: 'day-1', stageId: 'stage-1-b' })
})

test('別のvalid target DayでStageがinvalidならtarget Dayの先頭Stageへ移動する', () => {
  const input = makeInput()
  input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02',
    label: '2日目', order: 1 })
  input.stages.push({ id: 'stage-2', eventDayId: 'day-2', name: 'Day 2 Stage', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })
  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6, eventDayId: 'day-2', stageId: 'deleted-stage' },
    eventId: input.event.id, eventDays: input.eventDays, stages: input.stages,
    currentEventDayId: 'day-1', currentStageId: 'stage-1',
  }), { step: 6, eventDayId: 'day-2', stageId: 'stage-2' })
})

test('現在Stage自体がstaleなら現在Dayの先頭valid Stageへfallbackする', () => {
  const input = makeInput()
  assert.deepEqual(resolveEventFinalCheckRepairNavigation({
    target: { step: 6, eventDayId: 'deleted-day', stageId: 'deleted-stage' },
    eventId: input.event.id, eventDays: input.eventDays, stages: input.stages,
    currentEventDayId: 'day-1', currentStageId: 'deleted-stage',
  }), { step: 6, eventDayId: 'day-1', stageId: 'stage-1' })
})

test('DayとStageが不一致のfindingもfallback groupへ残す', () => {
  const input = makeInput()
  input.eventDays.push({ id: 'day-2', eventId: 'event-1', date: '2027-11-02',
    label: '2日目', order: 1 })
  input.stages.push({ id: 'stage-2', eventDayId: 'day-2', name: 'Day 2 Stage', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' })
  const finding = {
    key: 'mismatched-stage-day', severity: 'ERROR', category: 'schedule',
    code: 'TEST', message: 'Stage参照が開催日と一致しません。', targetStep: 6,
    eventDayId: 'day-1', stageId: 'stage-2',
  }

  const groups = groupEventFinalCheckFindingsForDisplay({
    findings: [finding], eventDays: input.eventDays, stages: input.stages,
  })
  assert.deepEqual(groups.dayGroups[0].stageGroups, [])
  assert.deepEqual(groups.dayGroups[0].unresolvedStageFindings, [finding])
  assert.equal(groups.dayGroups.flatMap(group => [
    ...group.dayOnly,
    ...group.stageGroups.flatMap(stageGroup => stageGroup.findings),
    ...group.unresolvedStageFindings,
  ]).length, 1)
})

test('Final CheckのStage groupは入力順に依存せずorder・ID順になる', () => {
  const eventDays = [{ id: 'day-1', eventId: 'event-1', date: '2027-11-01',
    label: '1日目', order: 0 }]
  const stageA = { id: 'stage-a', eventDayId: 'day-1', name: 'Stage A', order: 1,
    plannedStartTime: '10:00', plannedEndTime: '18:00' }
  const stageB = { id: 'stage-b', eventDayId: 'day-1', name: 'Stage B', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' }
  const stageC = { id: 'stage-c', eventDayId: 'day-1', name: 'Stage C', order: 1,
    plannedStartTime: '10:00', plannedEndTime: '18:00' }
  const findings = [stageA, stageB, stageC].map(stage => ({
    key: `finding-${stage.id}`, severity: 'ERROR', category: 'schedule',
    code: 'TEST', message: `${stage.name}の問題`, targetStep: 6,
    eventDayId: 'day-1', stageId: stage.id,
  }))
  const firstStages = [stageA, stageC, stageB]
  const secondStages = [stageC, stageB, stageA]
  const firstBefore = structuredClone(firstStages)
  const secondBefore = structuredClone(secondStages)

  const stageIds = stages => groupEventFinalCheckFindingsForDisplay({
    findings, eventDays, stages,
  }).dayGroups[0].stageGroups.map(group => group.stage.id)

  assert.deepEqual(stageIds(firstStages), ['stage-b', 'stage-a', 'stage-c'])
  assert.deepEqual(stageIds(secondStages), ['stage-b', 'stage-a', 'stage-c'])
  assert.deepEqual(firstStages, firstBefore)
  assert.deepEqual(secondStages, secondBefore)
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
