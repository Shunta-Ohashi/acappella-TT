import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createBreakScheduleItemForLane,
  createPerformanceScheduleItemForLane,
  getEventBandsForEventDay,
  getSectionsForStage,
  getStagesForEventDay,
  getUnscheduledEventBandsForEventDay,
  moveScheduleItemWithinStage,
  removeScheduleItem,
  reorderScheduleLaneItems,
  resolveTimetableSelection,
} from '../src/domain/schedule.ts'
import {
  getSectionDroppableId,
  getStageDroppableId,
  parseTimetableDroppableId,
  resolveScheduleLane,
} from '../src/ui/timetableDnd.ts'

test('EventBandを選択中Eventかつ現在のEventDayで絞り込む', () => {
  const sameEventAndDay = {
    id: 'event-band-current-day',
    eventId: 'event-1',
    eventDayId: 'day-1',
    memberIds: [],
    durationMinutes: 10,
  }
  const sameEventButAnotherDay = {
    id: 'event-band-another-day',
    eventId: 'event-1',
    eventDayId: 'day-2',
    memberIds: [],
    durationMinutes: 10,
  }
  const anotherEvent = {
    id: 'event-band-another-event',
    eventId: 'event-2',
    eventDayId: 'day-1',
    memberIds: [],
    durationMinutes: 10,
  }

  assert.deepEqual(
    getEventBandsForEventDay(
      [sameEventAndDay, sameEventButAnotherDay, anotherEvent],
      'event-1',
      'day-1',
    ),
    [sameEventAndDay],
  )
})

const eventDays = [
  { id: 'day-2', eventId: 'event-1', date: '2027-11-07', order: 1 },
  { id: 'day-1', eventId: 'event-1', date: '2027-11-06', order: 0 },
  { id: 'other-day', eventId: 'event-2', date: '2027-11-06', order: 0 },
]

const stages = [
  {
    id: 'stage-day-1-b',
    eventDayId: 'day-1',
    name: 'Sub',
    order: 1,
    plannedStartTime: '10:00',
  },
  {
    id: 'stage-day-1-a',
    eventDayId: 'day-1',
    name: 'Main',
    order: 0,
    plannedStartTime: '10:00',
  },
  {
    id: 'stage-day-2',
    eventDayId: 'day-2',
    name: 'Day 2',
    order: 0,
    plannedStartTime: '10:00',
  },
]

test('EventDayごとにStageをorder順で抽出する', () => {
  assert.deepEqual(
    getStagesForEventDay(stages, 'day-1').map(stage => stage.id),
    ['stage-day-1-a', 'stage-day-1-b'],
  )
})

test('選択EventDayの全Stageに配置済みのEventBandをPoolから除外する', () => {
  const eventBands = [
    { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1' },
    { id: 'band-b', eventId: 'event-1', eventDayId: 'day-1' },
    { id: 'band-day-2', eventId: 'event-1', eventDayId: 'day-2' },
    { id: 'band-other-event', eventId: 'event-2', eventDayId: 'day-1' },
  ]
  const scheduleItems = [
    {
      id: 'item-b',
      stageId: 'stage-day-1-b',
      order: 0,
      kind: 'performance',
      eventBandId: 'band-b',
    },
    {
      id: 'break-a',
      stageId: 'stage-day-1-a',
      order: 0,
      kind: 'break',
      title: '休憩',
      durationMinutes: 10,
    },
  ]

  assert.deepEqual(
    getUnscheduledEventBandsForEventDay({
      eventBands,
      eventId: 'event-1',
      eventDayId: 'day-1',
      stages,
      scheduleItems,
    }).map(eventBand => eventBand.id),
    ['band-a'],
  )
})

test('無効なEventDay・Stage選択はEvent内の先頭候補へfallbackする', () => {
  assert.deepEqual(resolveTimetableSelection({
    eventId: 'event-1',
    eventDays,
    stages,
    selectedEventDayId: 'deleted-day',
    selectedStageId: 'deleted-stage',
  }), {
    eventDayId: 'day-1',
    stageId: 'stage-day-1-a',
  })

  assert.deepEqual(resolveTimetableSelection({
    eventId: 'event-1',
    eventDays,
    stages: stages.filter(stage => stage.id !== 'stage-day-1-a'),
    selectedEventDayId: 'day-1',
    selectedStageId: 'stage-day-1-a',
  }), {
    eventDayId: 'day-1',
    stageId: 'stage-day-1-b',
  })
})

test('EventDay切替時はその日の先頭Stageへfallbackする', () => {
  assert.deepEqual(resolveTimetableSelection({
    eventId: 'event-1',
    eventDays,
    stages,
    selectedEventDayId: 'day-2',
    selectedStageId: 'stage-day-1-a',
  }), {
    eventDayId: 'day-2',
    stageId: 'stage-day-2',
  })
})

test('SectionなしStageへの項目追加ではsectionIdを持たない', () => {
  const stage = stages[1]
  const item = createPerformanceScheduleItemForLane({
    id: 'performance-1',
    eventBandId: 'band-a',
    stage,
    stageSections: [],
    lane: { stageId: stage.id },
  })

  assert.deepEqual(item, {
    id: 'performance-1',
    stageId: stage.id,
    order: 0,
    kind: 'performance',
    eventBandId: 'band-a',
  })
  assert.deepEqual(createBreakScheduleItemForLane({
    id: 'break-1',
    title: '休憩',
    durationMinutes: 10,
    stage,
    stageSections: [],
    lane: { stageId: stage.id },
  }), {
    id: 'break-1',
    stageId: stage.id,
    order: 0,
    kind: 'break',
    title: '休憩',
    durationMinutes: 10,
  })
})

test('SectionありStageへのPerformanceとBreak追加ではsectionIdを付与する', () => {
  const stage = stages[1]
  const sections = [
    { id: 'section-2', stageId: stage.id, name: '2部', order: 1 },
    { id: 'section-1', stageId: stage.id, name: '1部', order: 0 },
  ]

  assert.deepEqual(
    getSectionsForStage(sections, stage.id).map(section => section.id),
    ['section-1', 'section-2'],
  )
  assert.equal(createPerformanceScheduleItemForLane({
    id: 'performance-1',
    eventBandId: 'band-a',
    stage,
    stageSections: sections,
    lane: { stageId: stage.id, sectionId: 'section-1' },
  })?.sectionId, 'section-1')
  assert.equal(createBreakScheduleItemForLane({
    id: 'break-1',
    title: '休憩',
    durationMinutes: 10,
    stage,
    stageSections: sections,
    lane: { stageId: stage.id, sectionId: 'section-2' },
  })?.sectionId, 'section-2')
})

test('同じStageのSection間移動でPerformanceとBreakのsectionIdを更新する', () => {
  const stage = stages[1]
  const sections = [
    { id: 'section-1', stageId: stage.id, name: '1部', order: 0 },
    { id: 'section-2', stageId: stage.id, name: '2部', order: 1 },
  ]
  const scheduleItems = [
    {
      id: 'performance-1',
      stageId: stage.id,
      sectionId: 'section-1',
      order: 0,
      kind: 'performance',
      eventBandId: 'band-a',
    },
    {
      id: 'break-1',
      stageId: stage.id,
      sectionId: 'section-1',
      order: 1,
      kind: 'break',
      title: '休憩',
      durationMinutes: 10,
    },
  ]

  const movedPerformance = moveScheduleItemWithinStage({
    scheduleItems,
    stage,
    stageSections: sections,
    sourceLane: { stageId: stage.id, sectionId: 'section-1' },
    sourceIndex: 0,
    destinationLane: { stageId: stage.id, sectionId: 'section-2' },
    destinationIndex: 0,
  })
  const movedBreak = moveScheduleItemWithinStage({
    scheduleItems: movedPerformance,
    stage,
    stageSections: sections,
    sourceLane: { stageId: stage.id, sectionId: 'section-1' },
    sourceIndex: 0,
    destinationLane: { stageId: stage.id, sectionId: 'section-2' },
    destinationIndex: 1,
  })

  assert.equal(
    movedBreak.find(item => item.id === 'performance-1').sectionId,
    'section-2',
  )
  assert.equal(
    movedBreak.find(item => item.id === 'break-1').sectionId,
    'section-2',
  )
})

test('Section内の並べ替えは他Sectionの項目とorderへ影響しない', () => {
  const scheduleItems = [
    {
      id: 'section-1-a',
      stageId: 'stage-day-1-a',
      sectionId: 'section-1',
      order: 0,
      kind: 'performance',
      eventBandId: 'band-a',
    },
    {
      id: 'section-1-b',
      stageId: 'stage-day-1-a',
      sectionId: 'section-1',
      order: 1,
      kind: 'performance',
      eventBandId: 'band-b',
    },
    {
      id: 'section-2-a',
      stageId: 'stage-day-1-a',
      sectionId: 'section-2',
      order: 0,
      kind: 'performance',
      eventBandId: 'band-c',
    },
  ]
  const result = reorderScheduleLaneItems(
    scheduleItems,
    { stageId: 'stage-day-1-a', sectionId: 'section-1' },
    1,
    0,
  )

  assert.deepEqual(
    result
      .filter(item => item.sectionId === 'section-1')
      .sort((left, right) => left.order - right.order)
      .map(item => [item.id, item.order]),
    [['section-1-b', 0], ['section-1-a', 1]],
  )
  assert.deepEqual(
    result.find(item => item.id === 'section-2-a'),
    scheduleItems[2],
  )
})

test('SectionのPerformanceを削除するとEventBandが日別Poolへ戻る', () => {
  const eventBands = [
    { id: 'band-a', eventId: 'event-1', eventDayId: 'day-1' },
    { id: 'band-b', eventId: 'event-1', eventDayId: 'day-1' },
  ]
  const scheduleItems = [
    {
      id: 'performance-a',
      stageId: 'stage-day-1-a',
      sectionId: 'section-1',
      order: 0,
      kind: 'performance',
      eventBandId: 'band-a',
    },
    {
      id: 'performance-b',
      stageId: 'stage-day-1-b',
      order: 0,
      kind: 'performance',
      eventBandId: 'band-b',
    },
  ]
  const remaining = removeScheduleItem(scheduleItems, 'performance-a')

  assert.deepEqual(
    getUnscheduledEventBandsForEventDay({
      eventBands,
      eventId: 'event-1',
      eventDayId: 'day-1',
      stages,
      scheduleItems: remaining,
    }).map(eventBand => eventBand.id),
    ['band-a'],
  )
})

test('無効Sectionや別StageのSectionへの移動を拒否する', () => {
  const stage = stages[1]
  const sections = [
    { id: 'section-1', stageId: stage.id, name: '1部', order: 0 },
    { id: 'other-stage-section', stageId: 'stage-day-1-b', name: '別', order: 0 },
  ]
  const scheduleItems = [{
    id: 'performance-1',
    stageId: stage.id,
    sectionId: 'section-1',
    order: 0,
    kind: 'performance',
    eventBandId: 'band-a',
  }]

  for (const sectionId of ['missing-section', 'other-stage-section']) {
    const result = moveScheduleItemWithinStage({
      scheduleItems,
      stage,
      stageSections: sections,
      sourceLane: { stageId: stage.id, sectionId: 'section-1' },
      sourceIndex: 0,
      destinationLane: { stageId: stage.id, sectionId },
      destinationIndex: 0,
    })
    assert.equal(result, scheduleItems)
  }
})

test('D&D IDを一意に生成・解析し、現在Stageの有効なlaneだけ解決する', () => {
  const stageId = 'stage:main/1'
  const sectionId = 'section:1/部'
  const stageDroppableId = getStageDroppableId(stageId)
  const sectionDroppableId = getSectionDroppableId(sectionId)

  assert.deepEqual(parseTimetableDroppableId(stageDroppableId), {
    kind: 'stage',
    stageId,
  })
  assert.deepEqual(parseTimetableDroppableId(sectionDroppableId), {
    kind: 'section',
    sectionId,
  })
  assert.deepEqual(
    resolveScheduleLane(
      { kind: 'section', sectionId },
      stageId,
      new Set([sectionId]),
    ),
    { stageId, sectionId },
  )
  assert.equal(
    resolveScheduleLane(
      { kind: 'section', sectionId: 'other' },
      stageId,
      new Set([sectionId]),
    ),
    undefined,
  )
})
