import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import { detectScheduleIssues } from '../src/domain/issues.ts'
import { evaluateScheduleConstraints } from '../src/domain/schedulingConstraints.ts'
import { calculateEventDayTimelines } from '../src/domain/timetable.ts'

const day1 = { id: 'day-1', eventId: 'event-1', date: '2027-11-06', order: 0 }
const day2 = { id: 'day-2', eventId: 'event-1', date: '2027-11-07', order: 1 }
const stage = (id, start = '10:00', eventDayId = day1.id, overrides = {}) => ({
  id, eventDayId, name: id, order: 0, plannedStartTime: start, ...overrides,
})
const band = (id, memberIds = ['member-1'], overrides = {}) => ({
  id, eventId: 'event-1', eventDayId: day1.id, name: id,
  memberIds, durationMinutes: 10, ...overrides,
})
const performance = (id, eventBandId, stageId = 'stage-a', order = 0, sectionId) => ({
  id, stageId, order, kind: 'performance', eventBandId,
  ...(sectionId ? { sectionId } : {}),
})
const breakItem = (id, durationMinutes, order, sectionId) => ({
  id, stageId: 'stage-a', order, kind: 'break', title: '休憩', durationMinutes,
  ...(sectionId ? { sectionId } : {}),
})
const section = (id, order, overrides = {}) => ({
  id, stageId: 'stage-a', name: id, order, ...overrides,
})
const input = (overrides = {}) => ({
  event: {
    id: 'event-1', name: 'テスト', timeZone: 'Asia/Tokyo',
    defaultTransitionMinutes: 0,
    validationPolicy: { minimumGapBands: 0, minimumRestMinutes: 0 },
    performanceSlotMinutes: [10],
  },
  eventDays: [day1, day2],
  stages: [stage('stage-a')],
  sections: [],
  members: ['member-1', 'member-2'].map((id) => ({ id, realName: id, active: true })),
  eventMembers: ['member-1', 'member-2'].map((id) => ({
    id: `event-${id}`, eventId: 'event-1', memberId: id,
  })),
  eventMemberDays: ['member-1', 'member-2'].flatMap((id) =>
    [day1, day2].map((day) => ({
      id: `${id}-${day.id}`, eventMemberId: `event-${id}`,
      eventDayId: day.id, participationStatus: 'participating',
    }))),
  eventBands: [band('band-1')],
  scheduleItems: [performance('item-1', 'band-1')],
  ...overrides,
})
const evaluate = (overrides) => evaluateScheduleConstraints(input(overrides))
const codes = (violations) => violations.map((violation) => violation.code)
const find = (violations, code) => violations.find((violation) => violation.code === code)

const issueCodes = (candidate) => {
  const calculatedItems = candidate.eventDays.flatMap((day) =>
    calculateEventDayTimelines({
      event: candidate.event,
      eventDayId: day.id,
      stages: candidate.stages,
      sections: candidate.sections,
      scheduleItems: candidate.scheduleItems,
      eventBands: candidate.eventBands,
    }).calculatedItems)
  return detectScheduleIssues({
    event: candidate.event,
    members: candidate.members,
    eventMembers: candidate.eventMembers,
    eventMemberDays: candidate.eventMemberDays,
    eventBands: candidate.eventBands,
    stages: candidate.stages,
    sections: candidate.sections,
    paAssignments: [], dutyTypes: [], dutyAssignments: [],
    calculatedItems,
  }).map((issue) => issue.code)
}

const invalidSectionCandidate = (overrides = {}) => input({
  sections: [section('section-1', 0)],
  eventBands: [band('band-1'), band('band-2', ['member-2'])],
  scheduleItems: [
    performance('invalid-item', 'band-1', 'stage-a', 0, 'missing-section'),
    performance('valid-item', 'band-2', 'stage-a', 1, 'section-1'),
  ],
  ...overrides,
})

test('clean scheduleはfeasibleでpenalty 0', () => {
  assert.deepEqual(evaluate(), {
    feasible: true, hardViolations: [], softViolations: [], totalPenalty: 0,
  })
})

test('同じEventBandの重複配置はHardにする', () => {
  const result = evaluate({ scheduleItems: [
    performance('item-1', 'band-1', 'stage-a', 0),
    performance('item-2', 'band-1', 'stage-a', 1),
  ] })
  assert.equal(result.feasible, false)
  assert.deepEqual(find(result.hardViolations, 'DUPLICATE_EVENT_BAND').scheduleItemIds,
    ['item-1', 'item-2'])
})

test('別日EventBand、存在しないStage、存在しないEventBandはHardにする', () => {
  const mismatch = evaluate({
    stages: [stage('stage-b', '10:00', day2.id)],
    scheduleItems: [performance('item-1', 'band-1', 'stage-b')],
  })
  assert.ok(codes(mismatch.hardViolations).includes('EVENT_BAND_DAY_MISMATCH'))
  assert.ok(issueCodes(input({
    stages: [stage('stage-b', '10:00', day2.id)],
    scheduleItems: [performance('item-1', 'band-1', 'stage-b')],
  })).includes('EVENT_BAND_DAY_MISMATCH'))

  assert.ok(codes(evaluate({ scheduleItems: [performance('x', 'band-1', 'missing')] })
    .hardViolations).includes('INVALID_STAGE_ASSIGNMENT'))
  assert.ok(codes(evaluate({ scheduleItems: [performance('x', 'missing')] })
    .hardViolations).includes('EVENT_BAND_NOT_FOUND'))
  assert.ok(codes(evaluate({
    eventBands: [band('foreign-band', ['member-1'], { eventId: 'other-event' })],
    scheduleItems: [performance('x', 'foreign-band')],
  }).hardViolations).includes('EVENT_BAND_EVENT_MISMATCH'))
})

test('Sectionあり・なしの不正な所属をHardにする', () => {
  const stale = evaluate({ scheduleItems: [performance('item-1', 'band-1', 'stage-a', 0, 'stale')] })
  assert.deepEqual(find(stale.hardViolations, 'INVALID_SECTION_ASSIGNMENT').scheduleItemIds,
    ['item-1'])

  const sections = [section('section-1', 0)]
  const missing = evaluate({ sections })
  assert.ok(codes(missing.hardViolations).includes('INVALID_SECTION_ASSIGNMENT'))
  assert.equal(evaluate({
    sections,
    scheduleItems: [performance('item-1', 'band-1', 'stage-a', 0, 'section-1')],
  }).feasible, true)
})

test('Section不正itemと同じStageの正常itemの不参加を両方検出する', () => {
  const candidate = invalidSectionCandidate()
  candidate.eventMemberDays = candidate.eventMemberDays.map((day) =>
    day.id === 'member-2-day-1'
      ? { ...day, participationStatus: 'absent' }
      : day)

  const result = evaluateScheduleConstraints(candidate)
  assert.equal(result.feasible, false)
  assert.deepEqual(find(result.hardViolations, 'INVALID_SECTION_ASSIGNMENT').scheduleItemIds,
    ['invalid-item'])
  assert.deepEqual(find(result.hardViolations, 'MEMBER_ABSENT').scheduleItemIds,
    ['valid-item'])
})

test('Section不正itemと同じStageの正常itemの日別参加情報不足を検出する', () => {
  const candidate = invalidSectionCandidate()
  candidate.eventMemberDays = candidate.eventMemberDays.filter((day) =>
    day.id !== 'member-2-day-1')

  const result = evaluateScheduleConstraints(candidate)
  assert.ok(codes(result.hardViolations).includes('INVALID_SECTION_ASSIGNMENT'))
  assert.deepEqual(find(result.hardViolations, 'MEMBER_DAY_NOT_CONFIGURED').scheduleItemIds,
    ['valid-item'])
})

test('Section不正itemと同じStageの正常itemの固定Stage違反も検出する', () => {
  const candidate = invalidSectionCandidate({
    eventBands: [band('band-1'), band('band-2', ['member-2'], {
      fixedPlacement: { stageId: 'another-stage' },
    })],
  })
  const result = evaluateScheduleConstraints(candidate)

  assert.ok(codes(result.hardViolations).includes('INVALID_SECTION_ASSIGNMENT'))
  assert.deepEqual(find(result.hardViolations, 'FIXED_STAGE_MISMATCH').scheduleItemIds,
    ['valid-item'])
})

test('Section不正itemだけでも修復せずfeasible=falseにする', () => {
  const candidate = invalidSectionCandidate({
    eventBands: [band('band-1')],
    scheduleItems: [performance('invalid-item', 'band-1', 'stage-a', 0, 'missing-section')],
  })
  const original = structuredClone(candidate)
  const result = evaluateScheduleConstraints(candidate)

  assert.equal(result.feasible, false)
  assert.deepEqual(codes(result.hardViolations), ['INVALID_SECTION_ASSIGNMENT'])
  assert.deepEqual(candidate, original)
})

test('Section不正Stageは別StageのConstraint評価を抑制しない', () => {
  const candidate = invalidSectionCandidate({
    stages: [stage('stage-a'), stage('stage-b')],
    eventBands: [band('band-1'), band('band-2', ['member-2'])],
    scheduleItems: [
      performance('invalid-item', 'band-1', 'stage-a', 0, 'missing-section'),
      performance('valid-item', 'band-2', 'stage-b'),
    ],
  })
  candidate.eventMemberDays = candidate.eventMemberDays.map((day) =>
    day.id === 'member-2-day-1'
      ? { ...day, participationStatus: 'absent' }
      : day)

  const result = evaluateScheduleConstraints(candidate)
  assert.ok(codes(result.hardViolations).includes('INVALID_SECTION_ASSIGNMENT'))
  assert.deepEqual(find(result.hardViolations, 'MEMBER_ABSENT').scheduleItemIds,
    ['valid-item'])
})

test('Section不正itemが混じっても同一Stageの正常item同士のSoft penaltyを計算する', () => {
  const candidate = invalidSectionCandidate({
    eventBands: [band('band-1'), band('band-2', ['member-2']),
      band('band-3', ['member-2'])],
    scheduleItems: [
      performance('invalid-item', 'band-1', 'stage-a', 0, 'missing-section'),
      performance('valid-item', 'band-2', 'stage-a', 1, 'section-1'),
      performance('valid-next', 'band-3', 'stage-a', 2, 'section-1'),
    ],
  })
  const result = evaluateScheduleConstraints(candidate)
  assert.equal(result.feasible, false)
  assert.deepEqual(codes(result.softViolations), ['BACK_TO_BACK'])
  assert.equal(result.totalPenalty, 10)
  assert.deepEqual(find(result.softViolations, 'BACK_TO_BACK').scheduleItemIds,
    ['valid-item', 'valid-next'])
  assert.deepEqual(result, evaluateScheduleConstraints(candidate))
})

test('SectionなしStageのstale sectionIdは項目を除外して後続時刻を前倒ししない', () => {
  const candidate = input({
    eventBands: [band('band-1', ['member-1'], {
      availableTimeRange: { from: '10:20' },
    })],
    scheduleItems: [breakItem('stale-break', 20, 0, 'missing-section'),
      performance('valid-item', 'band-1', 'stage-a', 1)],
  })
  const result = evaluateScheduleConstraints(candidate)
  assert.ok(codes(result.hardViolations).includes('INVALID_SECTION_ASSIGNMENT'))
  assert.equal(codes(result.hardViolations).includes('OUTSIDE_BAND_AVAILABILITY'), false)
})

test('参照切れで時刻不明なら後続を前倒しせず、時刻不要の不参加だけを評価する', () => {
  const candidate = input({
    eventBands: [band('band-2', ['member-2'], {
      availableTimeRange: { from: '10:30' },
    })],
    scheduleItems: [performance('missing-item', 'missing-band'),
      performance('valid-item', 'band-2', 'stage-a', 1)],
  })
  candidate.eventMemberDays = candidate.eventMemberDays.map((day) =>
    day.id === 'member-2-day-1'
      ? { ...day, participationStatus: 'absent' }
      : day)
  const result = evaluateScheduleConstraints(candidate)

  assert.ok(codes(result.hardViolations).includes('EVENT_BAND_NOT_FOUND'))
  assert.deepEqual(find(result.hardViolations, 'MEMBER_ABSENT').scheduleItemIds,
    ['valid-item'])
  assert.equal(codes(result.hardViolations).includes('OUTSIDE_BAND_AVAILABILITY'), false)
  assert.deepEqual(result.softViolations, [])
})

test('EventBand参照切れがあってもraw順序から固定位置違反を検出する', () => {
  const candidate = input({
    eventBands: [band('band-a', ['member-1']), band('band-b', ['member-2'], {
      fixedPlacement: { stageId: 'stage-a', position: { kind: 'first' } },
    })],
    scheduleItems: [performance('broken', 'missing-band', 'stage-a', 0),
      performance('valid-a', 'band-a', 'stage-a', 1),
      performance('valid-b', 'band-b', 'stage-a', 2)],
  })
  const result = evaluateScheduleConstraints(candidate)

  assert.ok(codes(result.hardViolations).includes('EVENT_BAND_NOT_FOUND'))
  assert.deepEqual(find(result.hardViolations, 'FIXED_POSITION_MISMATCH').scheduleItemIds,
    ['valid-b'])
  assert.equal(result.feasible, false)
})

test('EventBand参照切れがあっても正常Performanceの連続出演を検出する', () => {
  const candidate = input({
    eventBands: [band('band-a'), band('band-b')],
    scheduleItems: [performance('broken', 'missing-band', 'stage-a', 0),
      performance('valid-a', 'band-a', 'stage-a', 1),
      performance('valid-b', 'band-b', 'stage-a', 2)],
  })
  const result = evaluateScheduleConstraints(candidate)

  assert.ok(codes(result.hardViolations).includes('EVENT_BAND_NOT_FOUND'))
  assert.deepEqual(find(result.softViolations, 'BACK_TO_BACK').scheduleItemIds,
    ['valid-a', 'valid-b'])
  assert.equal(result.totalPenalty, 10)
})

test('参照切れPerformanceもgapBandsへ数え、SHORT_GAPを検出する', () => {
  const candidate = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 2, minimumRestMinutes: 0,
    } },
    eventBands: [band('band-a'), band('band-b')],
    scheduleItems: [performance('valid-a', 'band-a', 'stage-a', 0),
      performance('broken', 'missing-band', 'stage-a', 1),
      performance('valid-b', 'band-b', 'stage-a', 2)],
  })
  const result = evaluateScheduleConstraints(candidate)
  const shortGap = find(result.softViolations, 'SHORT_GAP')

  assert.equal(shortGap.gapBands, 1)
  assert.deepEqual(shortGap.scheduleItemIds, ['valid-a', 'valid-b'])
  assert.equal(shortGap.penalty, 5)
  assert.equal(codes(result.softViolations).includes('BACK_TO_BACK'), false)
})

test('参照切れStageでもBreakをgapBandsへ数えず連続出演にする', () => {
  const candidate = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 2, minimumRestMinutes: 0,
    } },
    eventBands: [band('band-a'), band('band-b')],
    scheduleItems: [performance('valid-a', 'band-a', 'stage-a', 0),
      breakItem('break-1', 5, 1),
      performance('valid-b', 'band-b', 'stage-a', 2),
      performance('broken', 'missing-band', 'stage-a', 3)],
  })
  const result = evaluateScheduleConstraints(candidate)

  assert.deepEqual(find(result.softViolations, 'BACK_TO_BACK').scheduleItemIds,
    ['valid-a', 'valid-b'])
  assert.equal(codes(result.softViolations).includes('SHORT_GAP'), false)
})

test('参照切れStageでは時刻依存違反を推測せず、別Stageは通常評価する', () => {
  const base = input()
  const candidate = input({
    event: { ...base.event, validationPolicy: {
      minimumGapBands: 0, minimumRestMinutes: 30,
    } },
    stages: [stage('stage-a'), stage('stage-b')],
    eventMemberDays: base.eventMemberDays.map((day) =>
      day.id === 'member-1-day-1'
        ? { ...day, availabilityWindows: [{ from: '10:30' }],
          preferredTimeRange: { from: '11:00' } }
        : day),
    eventBands: [band('band-a', ['member-1'], {
      availableTimeRange: { from: '10:30' },
      preferredTimeRange: { from: '11:00' },
      fixedPlacement: { stageId: 'stage-a', plannedStartTime: '12:00' },
    }), band('band-b', ['member-2'], {
      availableTimeRange: { from: '10:05' },
    })],
    scheduleItems: [performance('broken', 'missing-band', 'stage-a', 0),
      performance('untimed', 'band-a', 'stage-a', 1),
      performance('stage-b-item', 'band-b', 'stage-b', 0)],
  })
  const result = evaluateScheduleConstraints(candidate)
  const violationCodes = [...codes(result.hardViolations), ...codes(result.softViolations)]

  assert.ok(violationCodes.includes('EVENT_BAND_NOT_FOUND'))
  assert.ok(violationCodes.includes('OUTSIDE_BAND_AVAILABILITY'))
  assert.equal(violationCodes.includes('OUTSIDE_MEMBER_AVAILABILITY'), false)
  assert.equal(violationCodes.includes('FIXED_START_TIME_MISMATCH'), false)
  assert.equal(violationCodes.includes('PREFERENCE_NOT_MET'), false)
  assert.equal(violationCodes.includes('SHORT_REST'), false)
  assert.equal(violationCodes.includes('PERFORMANCE_OVERLAP'), false)
})

test('参照切れを含む評価はdeterministicかつcandidateを変更しない', () => {
  const candidate = input({
    eventBands: [band('band-a'), band('band-b')],
    scheduleItems: [performance('broken', 'missing-band', 'stage-a', 0),
      performance('valid-a', 'band-a', 'stage-a', 1),
      performance('valid-b', 'band-b', 'stage-a', 2)],
  })
  const before = structuredClone(candidate)

  assert.deepEqual(evaluateScheduleConstraints(candidate),
    evaluateScheduleConstraints(candidate))
  assert.deepEqual(candidate, before)
})

test('同一Stageと別Stageの出演重複をIssueと同じHardにし、接する区間は重複しない', () => {
  const sameStage = input({
    sections: [section('s1', 0, { plannedStartTime: '10:00' }),
      section('s2', 1, { plannedStartTime: '10:05' })],
    eventBands: [band('band-1'), band('band-2')],
    scheduleItems: [performance('item-1', 'band-1', 'stage-a', 0, 's1'),
      performance('item-2', 'band-2', 'stage-a', 0, 's2')],
  })
  assert.ok(codes(evaluateScheduleConstraints(sameStage).hardViolations)
    .includes('PERFORMANCE_OVERLAP'))
  assert.ok(issueCodes(sameStage).includes('PERFORMANCE_OVERLAP'))

  const crossStage = input({
    stages: [stage('stage-a'), stage('stage-b', '10:05')],
    eventBands: [band('band-1'), band('band-2')],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-b')],
  })
  assert.ok(codes(evaluateScheduleConstraints(crossStage).hardViolations)
    .includes('PERFORMANCE_OVERLAP'))
  assert.ok(issueCodes(crossStage).includes('PERFORMANCE_OVERLAP'))

  crossStage.stages[1].plannedStartTime = '10:10'
  assert.equal(codes(evaluateScheduleConstraints(crossStage).hardViolations)
    .includes('PERFORMANCE_OVERLAP'), false)
})

test('EventMemberDay未設定、不参加、個人・Band availability外はHard', () => {
  const base = input()
  assert.ok(codes(evaluate({ eventMembers: [] }).hardViolations)
    .includes('MEMBER_NOT_REGISTERED_FOR_EVENT'))
  const withoutMemberDay = evaluate({
    eventMemberDays: base.eventMemberDays.filter((day) =>
      !(day.eventMemberId === 'event-member-1' && day.eventDayId === day1.id)),
  })
  assert.ok(codes(withoutMemberDay.hardViolations).includes('MEMBER_DAY_NOT_CONFIGURED'))

  const absent = evaluate({
    eventMemberDays: base.eventMemberDays.map((day) =>
      day.id === 'member-1-day-1' ? { ...day, participationStatus: 'absent' } : day),
  })
  assert.ok(codes(absent.hardViolations).includes('MEMBER_ABSENT'))

  const unavailable = evaluate({
    eventMemberDays: base.eventMemberDays.map((day) =>
      day.id === 'member-1-day-1'
        ? { ...day, availabilityWindows: [{ from: '10:05', until: '11:00' }] }
        : day),
  })
  assert.ok(codes(unavailable.hardViolations).includes('OUTSIDE_MEMBER_AVAILABILITY'))
  assert.ok(codes(evaluate({
    eventBands: [band('band-1', ['member-1'], {
      availableTimeRange: { from: '10:05', until: '11:00' },
    })],
  }).hardViolations).includes('OUTSIDE_BAND_AVAILABILITY'))
  assert.ok(codes(evaluate({
    eventMemberDays: base.eventMemberDays.map((day) =>
      day.id === 'member-1-day-1' ? { ...day, availabilityWindows: [] } : day),
  }).hardViolations).includes('OUTSIDE_MEMBER_AVAILABILITY'))
})

test('終日availabilityも24:00までで、翌日への出演はHard', () => {
  const result = evaluate({ stages: [stage('stage-a', '23:55')] })
  assert.ok(codes(result.hardViolations).includes('OUTSIDE_MEMBER_AVAILABILITY'))
})

test('固定Stage・Section・位置・開始時刻の違反はIssueと同じHard', () => {
  const fixedStage = input({
    stages: [stage('stage-a'), stage('stage-b')],
    eventBands: [band('band-1', ['member-1'], {
      fixedPlacement: { stageId: 'stage-b' },
    })],
  })
  assert.ok(codes(evaluateScheduleConstraints(fixedStage).hardViolations)
    .includes('FIXED_STAGE_MISMATCH'))
  assert.ok(issueCodes(fixedStage).includes('FIXED_STAGE_MISMATCH'))

  const fixedSection = input({
    sections: [section('s1', 0), section('s2', 1)],
    eventBands: [band('band-1', ['member-1'], {
      fixedPlacement: { stageId: 'stage-a', sectionId: 's2' },
    })],
    scheduleItems: [performance('item-1', 'band-1', 'stage-a', 0, 's1')],
  })
  assert.ok(codes(evaluateScheduleConstraints(fixedSection).hardViolations)
    .includes('FIXED_SECTION_MISMATCH'))

  const fixedPosition = input({
    eventBands: [band('band-1', ['member-1'], {
      fixedPlacement: { stageId: 'stage-a', position: { kind: 'first' } },
    }), band('band-2', ['member-2'])],
    scheduleItems: [performance('item-2', 'band-2', 'stage-a', 0),
      performance('item-1', 'band-1', 'stage-a', 1)],
  })
  assert.ok(codes(evaluateScheduleConstraints(fixedPosition).hardViolations)
    .includes('FIXED_POSITION_MISMATCH'))

  const fixedStart = input({
    eventBands: [band('band-1', ['member-1'], {
      fixedPlacement: { stageId: 'stage-a', plannedStartTime: '10:05' },
    })],
  })
  assert.ok(codes(evaluateScheduleConstraints(fixedStart).hardViolations)
    .includes('FIXED_START_TIME_MISMATCH'))
})

test('Stage・Section固定終了超過とSection開始衝突はHard', () => {
  assert.equal(find(evaluate({
    stages: [stage('stage-a', '10:00', day1.id, { plannedEndTime: '10:05' })],
  }).hardViolations, 'STAGE_END_EXCEEDED').amount, 5)

  const end = evaluate({
    sections: [section('s1', 0, {
      plannedStartTime: '10:00', plannedEndTime: '10:05',
    })],
    scheduleItems: [performance('item-1', 'band-1', 'stage-a', 0, 's1')],
  })
  assert.equal(find(end.hardViolations, 'SECTION_END_EXCEEDED').amount, 5)

  const conflict = evaluate({
    sections: [section('s1', 0, { plannedStartTime: '10:00' }),
      section('s2', 1, { plannedStartTime: '10:05' })],
    scheduleItems: [performance('item-1', 'band-1', 'stage-a', 0, 's1')],
  })
  assert.equal(find(conflict.hardViolations, 'SECTION_START_CONFLICT').amount, 5)
})

test('連続出演はBACK_TO_BACKのみ、gap 1はSHORT_GAP不足1組として採点する', () => {
  const backToBack = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 2, minimumRestMinutes: 0,
    } },
    eventBands: [band('band-1'), band('band-2')],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-a', 1)],
  })
  const back = evaluateScheduleConstraints(backToBack)
  assert.deepEqual(codes(back.softViolations), ['BACK_TO_BACK'])
  assert.equal(back.totalPenalty, 10)
  assert.ok(issueCodes(backToBack).includes('BACK_TO_BACK'))

  const shortGap = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 2, minimumRestMinutes: 0,
    } },
    eventBands: [band('band-1'), band('band-2', ['member-2']), band('band-3')],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-a', 1),
      performance('item-3', 'band-3', 'stage-a', 2)],
  })
  const gap = find(evaluateScheduleConstraints(shortGap).softViolations, 'SHORT_GAP')
  assert.equal(gap.gapBands, 1)
  assert.equal(gap.amount, 1)
  assert.equal(gap.penalty, 5)
  assert.ok(issueCodes(shortGap).includes('SHORT_GAP'))
  shortGap.event.validationPolicy.minimumGapBands = 1
  assert.equal(codes(evaluateScheduleConstraints(shortGap).softViolations)
    .includes('SHORT_GAP'), false)
})

test('別Stageの短休憩をSoftにし、overlap pairにはSHORT_RESTを重複させない', () => {
  const candidate = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 0, minimumRestMinutes: 5,
    } },
    stages: [stage('stage-a'), stage('stage-b', '10:12')],
    eventBands: [band('band-1'), band('band-2')],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-b')],
  })
  const rest = find(evaluateScheduleConstraints(candidate).softViolations, 'SHORT_REST')
  assert.equal(rest.restMinutes, 2)
  assert.equal(rest.amount, 3)
  assert.ok(issueCodes(candidate).includes('SHORT_REST'))

  candidate.stages[1].plannedStartTime = '10:05'
  const overlap = evaluateScheduleConstraints(candidate)
  assert.ok(codes(overlap.hardViolations).includes('PERFORMANCE_OVERLAP'))
  assert.equal(codes(overlap.softViolations).includes('SHORT_REST'), false)
})

test('nested overlap後はlatest endを基準にrest 5分を採点する', () => {
  const candidate = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 0, minimumRestMinutes: 10,
    } },
    stages: [stage('stage-a'), stage('stage-b', '10:05'),
      stage('stage-c', '10:35')],
    eventBands: [band('band-1', ['member-1'], { durationMinutes: 30 }),
      band('band-2', ['member-1'], { durationMinutes: 5 }), band('band-3')],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-b'),
      performance('item-3', 'band-3', 'stage-c')],
  })
  const result = evaluateScheduleConstraints(candidate)
  assert.ok(codes(result.hardViolations).includes('PERFORMANCE_OVERLAP'))
  const rest = find(result.softViolations, 'SHORT_REST')
  assert.equal(rest.restMinutes, 5)
  assert.deepEqual(rest.scheduleItemIds, ['item-1', 'item-3'])
})

test('個人・Bandの希望時間外分とundecidedをSoft penaltyへ加算する', () => {
  const base = input()
  const candidate = input({
    eventMemberDays: base.eventMemberDays.map((day) =>
      day.id === 'member-1-day-1'
        ? { ...day, participationStatus: 'undecided',
          preferredTimeRange: { from: '10:05', until: '10:20' } }
        : day),
    eventBands: [band('band-1', ['member-1'], {
      preferredTimeRange: { from: '10:05', until: '10:20' },
    })],
  })
  const result = evaluateScheduleConstraints(candidate)
  assert.equal(result.feasible, true)
  assert.deepEqual(result.softViolations
    .filter((violation) => violation.code === 'PREFERENCE_NOT_MET')
    .map((violation) => violation.amount), [5, 5])
  assert.equal(find(result.softViolations, 'MEMBER_PARTICIPATION_UNDECIDED').penalty, 1)
  assert.equal(result.totalPenalty, 11)
  assert.equal(issueCodes(candidate).filter((code) => code === 'PREFERENCE_NOT_MET').length, 2)
})

test('別EventDayは出演重複・短休憩・gapを比較しない', () => {
  const candidate = input({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 2, minimumRestMinutes: 30,
    } },
    stages: [stage('stage-a'), stage('stage-b', '10:00', day2.id)],
    eventBands: [band('band-1', ['member-1'], { bandId: 'fixed-choir' }),
      band('band-2', ['member-1'], {
        bandId: 'fixed-choir', eventDayId: day2.id,
      })],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-b')],
  })
  const result = evaluateScheduleConstraints(candidate)
  assert.equal(result.feasible, true)
  assert.deepEqual(result.softViolations, [])

  candidate.stages[0].plannedStartTime = '17:00'
  const nextDayEarlier = evaluateScheduleConstraints(candidate)
  assert.equal(nextDayEarlier.feasible, true)
  assert.deepEqual(nextDayEarlier.softViolations, [])
})

test('Breakはgapに数えず、実時間としてrestに反映する', () => {
  const result = evaluate({
    event: { ...input().event, validationPolicy: {
      minimumGapBands: 2, minimumRestMinutes: 6,
    } },
    eventBands: [band('band-1'), band('band-2')],
    scheduleItems: [performance('item-1', 'band-1'),
      breakItem('break-1', 5, 1),
      performance('item-2', 'band-2', 'stage-a', 2)],
  })
  assert.equal(find(result.softViolations, 'BACK_TO_BACK').gapBands, 0)
  assert.equal(find(result.softViolations, 'SHORT_REST').restMinutes, 5)
  assert.equal(codes(result.softViolations).includes('SHORT_GAP'), false)
})

test('同じ候補は同じ順序とpenaltyを返し、重みは非負有限だけ許可する', () => {
  const candidate = input({
    eventBands: [band('band-1'), band('band-2')],
    scheduleItems: [performance('item-1', 'band-1'),
      performance('item-2', 'band-2', 'stage-a', 1)],
    weights: { backToBack: 3 },
  })
  const before = structuredClone(candidate)
  assert.deepEqual(evaluateScheduleConstraints(candidate), evaluateScheduleConstraints(candidate))
  assert.deepEqual(candidate, before)
  assert.equal(evaluateScheduleConstraints(candidate).totalPenalty, 3)
  assert.throws(() => evaluateScheduleConstraints({ ...candidate,
    weights: { backToBack: -1 },
  }), RangeError)
})

test('demoDataの正常なTTに予期しないHard violationを出さない', () => {
  const demo = createDemoData()
  for (const event of demo.events) {
    const dayIds = new Set(demo.eventDays
      .filter((day) => day.eventId === event.id).map((day) => day.id))
    const stageIds = new Set(demo.stages
      .filter((candidate) => dayIds.has(candidate.eventDayId)).map((candidate) => candidate.id))
    const result = evaluateScheduleConstraints({
      event, eventDays: demo.eventDays, stages: demo.stages,
      sections: demo.sections, members: demo.members,
      eventMembers: demo.eventMembers, eventMemberDays: demo.eventMemberDays,
      eventBands: demo.eventBands,
      scheduleItems: demo.scheduleItems.filter((item) => stageIds.has(item.stageId)),
    })
    assert.deepEqual(result.hardViolations, [], event.id)
  }
})
