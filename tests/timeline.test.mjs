import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateStageTimeline, isValidLocalTime } from '../src/domain/timeline.ts'

const eventDays = [
  {
    id: 'event-day-1',
    eventId: 'event-1',
    date: '2027-11-06',
    order: 0,
  },
  {
    id: 'event-day-2',
    eventId: 'event-1',
    date: '2027-11-07',
    order: 1,
  },
]

const event = {
  id: 'event-1',
  name: 'テストイベント',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
}

const createStage = (overrides = {}) => ({
  id: 'stage-1',
  eventDayId: eventDays[0].id,
  name: 'Stage A',
  order: 0,
  plannedStartTime: '13:00',
  ...overrides,
})

const eventBands = [
  {
    id: 'event-band-1',
    eventId: event.id,
    eventDayId: eventDays[0].id,
    bandId: 'band-1',
    memberIds: ['member-1'],
    durationMinutes: 15,
  },
  {
    id: 'event-band-2',
    eventId: event.id,
    eventDayId: eventDays[0].id,
    bandId: 'band-2',
    memberIds: ['member-2'],
    durationMinutes: 10,
  },
]

const performance = (id, eventBandId, order, overrides = {}) => ({
  id,
  stageId: 'stage-1',
  order,
  kind: 'performance',
  eventBandId,
  ...overrides,
})

test('SectionなしではStage開始時刻とEventの転換時間を使ってPerformanceを計算する', () => {
  const result = calculateStageTimeline({
    event,
    stage: createStage(),
    sections: [],
    scheduleItems: [
      performance('item-1', 'event-band-1', 0),
      performance('item-2', 'event-band-2', 1),
    ],
    eventBands,
  })

  assert.deepEqual(
    result.map(item => [item.plannedStartMinute, item.plannedEndMinute]),
    [[780, 795], [797, 807]],
  )
})

test('Stageの転換時間を優先し、Break後には転換時間を加えない', () => {
  const result = calculateStageTimeline({
    event,
    stage: createStage({ plannedStartTime: '10:00', transitionMinutes: 5 }),
    sections: [],
    scheduleItems: [
      performance('item-1', 'event-band-2', 0),
      {
        id: 'break-1',
        stageId: 'stage-1',
        order: 1,
        kind: 'break',
        title: '休憩',
        durationMinutes: 10,
      },
      performance('item-2', 'event-band-2', 2),
    ],
    eventBands,
  })

  assert.deepEqual(
    result.map(item => [item.plannedStartMinute, item.plannedEndMinute]),
    [[600, 610], [615, 625], [625, 635]],
  )
})

test('Sectionをorder順に計算し、plannedStartTimeを開始アンカーとして使う', () => {
  const sections = [
    { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1, plannedStartTime: '14:00' },
    { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0, plannedStartTime: '13:30' },
  ]
  const result = calculateStageTimeline({
    event,
    stage: createStage(),
    sections,
    scheduleItems: [
      performance('item-2', 'event-band-2', 0, { sectionId: 'section-2' }),
      performance('item-1', 'event-band-1', 0, { sectionId: 'section-1' }),
    ],
    eventBands,
  })

  assert.deepEqual(
    result.map(item => [item.scheduleItemId, item.plannedStartMinute, item.plannedEndMinute]),
    [['item-1', 810, 825], ['item-2', 840, 850]],
  )
})

test('Section開始時刻がなければ前Sectionの終了後から続ける', () => {
  const result = calculateStageTimeline({
    event,
    stage: createStage({ plannedStartTime: '11:00', transitionMinutes: 3 }),
    sections: [
      { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
      { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1 },
    ],
    scheduleItems: [
      performance('item-1', 'event-band-2', 0, { sectionId: 'section-1' }),
      {
        id: 'break-1',
        stageId: 'stage-1',
        sectionId: 'section-2',
        order: 0,
        kind: 'break',
        title: '休憩',
        durationMinutes: 5,
      },
    ],
    eventBands,
  })

  assert.deepEqual(
    result.map(item => [item.plannedStartMinute, item.plannedEndMinute]),
    [[660, 670], [673, 678]],
  )
})

test('次Sectionの開始アンカーが前Sectionの終了より前でも、その時刻を優先する', () => {
  const result = calculateStageTimeline({
    event,
    stage: createStage({ plannedStartTime: '10:00' }),
    sections: [
      { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
      { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1, plannedStartTime: '10:10' },
    ],
    scheduleItems: [
      performance('item-1', 'event-band-1', 0, { sectionId: 'section-1' }),
      performance('item-2', 'event-band-2', 0, { sectionId: 'section-2' }),
    ],
    eventBands,
  })

  assert.deepEqual(
    result.map(item => item.plannedStartMinute),
    [600, 610],
  )
})

test('StageごとにScheduleItemを独立して計算する', () => {
  const stageA = createStage({ id: 'stage-a', plannedStartTime: '09:00' })
  const stageB = createStage({
    id: 'stage-b',
    eventDayId: eventDays[1].id,
    plannedStartTime: '12:00',
  })
  const scheduleItems = [
    performance('item-a', 'event-band-1', 0, { stageId: 'stage-a' }),
    performance('item-b', 'event-band-2', 0, { stageId: 'stage-b' }),
  ]
  const eventBandsByDay = [
    eventBands[0],
    { ...eventBands[1], eventDayId: eventDays[1].id },
  ]

  const resultA = calculateStageTimeline({ event, stage: stageA, sections: [], scheduleItems, eventBands: eventBandsByDay })
  const resultB = calculateStageTimeline({ event, stage: stageB, sections: [], scheduleItems, eventBands: eventBandsByDay })

  assert.deepEqual(resultA.map(item => item.scheduleItemId), ['item-a'])
  assert.deepEqual(resultB.map(item => item.scheduleItemId), ['item-b'])
  assert.equal(resultA[0].plannedStartMinute, 540)
  assert.equal(resultB[0].plannedStartMinute, 720)
  assert.equal(resultA[0].eventDayId, eventDays[0].id)
  assert.equal(resultB[0].eventDayId, eventDays[1].id)
})

test('SectionありでsectionId未設定のScheduleItemは明示的なエラーにする', () => {
  assert.throws(
    () => calculateStageTimeline({
      event,
      stage: createStage(),
      sections: [{ id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 }],
      scheduleItems: [performance('item-1', 'event-band-1', 0)],
      eventBands,
    }),
    /ScheduleItem must belong to a Section when Stage has Sections: item-1/,
  )
})

test('Sectionありで存在しないsectionIdを参照するScheduleItemは明示的なエラーにする', () => {
  assert.throws(
    () => calculateStageTimeline({
      event,
      stage: createStage(),
      sections: [{ id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 }],
      scheduleItems: [
        performance('item-1', 'event-band-1', 0, { sectionId: 'unknown-section' }),
      ],
      eventBands,
    }),
    /Section not found for ScheduleItem item-1: unknown-section/,
  )
})

test('Sectionありで有効なSectionに所属するScheduleItemは従来どおり計算する', () => {
  const result = calculateStageTimeline({
    event,
    stage: createStage(),
    sections: [{ id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 }],
    scheduleItems: [
      performance('item-1', 'event-band-1', 0, { sectionId: 'section-1' }),
    ],
    eventBands,
  })

  assert.deepEqual(
    result.map(item => [item.scheduleItemId, item.plannedStartMinute, item.plannedEndMinute]),
    [['item-1', 780, 795]],
  )
})

test('空文字はStage.plannedStartTimeへ保存できる時刻として扱わない', () => {
  assert.equal(isValidLocalTime(''), false)
  assert.equal(isValidLocalTime('13:00'), true)
})
