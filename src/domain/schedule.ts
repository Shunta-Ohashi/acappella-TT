import type {
  BreakScheduleItem,
  EventBand,
  EventBandId,
  EventDay,
  EventDayId,
  EventId,
  PerformanceScheduleItem,
  ScheduleItem,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  StageId,
} from './models'

export interface TimetableSelection {
  eventDayId?: EventDayId
  stageId?: StageId
}

export interface ScheduleLane {
  stageId: StageId
  sectionId?: SectionId
}

const reorder = <T,>(
  items: T[],
  sourceIndex: number,
  destinationIndex: number,
): T[] => {
  if (
    sourceIndex < 0 ||
    sourceIndex >= items.length ||
    destinationIndex < 0 ||
    destinationIndex >= items.length
  ) return items

  const reordered = [...items]
  const [moved] = reordered.splice(sourceIndex, 1)
  reordered.splice(destinationIndex, 0, moved)
  return reordered
}

const getScheduledEventBandIds = (
  scheduleItems: ScheduleItem[],
): Set<EventBandId> =>
  new Set(
    scheduleItems
      .filter(item => item.kind === 'performance')
      .map(item => item.eventBandId),
  )

const isItemInLane = (
  item: ScheduleItem,
  lane: ScheduleLane,
): boolean =>
  item.stageId === lane.stageId && item.sectionId === lane.sectionId

const setItemLane = (
  item: ScheduleItem,
  lane: ScheduleLane,
  order: number,
): ScheduleItem => {
  const section = lane.sectionId ? { sectionId: lane.sectionId } : {}

  return item.kind === 'performance'
    ? {
        id: item.id,
        stageId: lane.stageId,
        order,
        kind: 'performance',
        eventBandId: item.eventBandId,
        ...section,
      }
    : {
        id: item.id,
        stageId: lane.stageId,
        order,
        kind: 'break',
        title: item.title,
        durationMinutes: item.durationMinutes,
        ...section,
      }
}

const replaceScheduleLaneItems = (
  scheduleItems: ScheduleItem[],
  lane: ScheduleLane,
  laneItems: ScheduleItem[],
): ScheduleItem[] => [
  ...scheduleItems.filter(item => !isItemInLane(item, lane)),
  ...laneItems.map((item, order) => setItemLane(item, lane, order)),
]

export const getEventBandById = (
  eventBands: EventBand[],
  eventBandId: EventBandId,
): EventBand | undefined => eventBands.find(
  eventBand => eventBand.id === eventBandId,
)

export const getEventBandsForEventDay = (
  eventBands: EventBand[],
  eventId: EventId,
  eventDayId: EventDayId,
): EventBand[] => eventBands.filter(
  eventBand => eventBand.eventId === eventId &&
    eventBand.eventDayId === eventDayId,
)

export const getEventDaysForEvent = (
  eventDays: EventDay[],
  eventId: EventId,
): EventDay[] => eventDays
  .filter(eventDay => eventDay.eventId === eventId)
  .sort((left, right) =>
    left.order - right.order ||
    left.date.localeCompare(right.date) ||
    left.id.localeCompare(right.id),
  )

export const getStagesForEventDay = (
  stages: Stage[],
  eventDayId: EventDayId,
): Stage[] => stages
  .filter(stage => stage.eventDayId === eventDayId)
  .sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id),
  )

export const getSectionsForStage = (
  sections: Section[],
  stageId: StageId,
): Section[] => sections
  .filter(section => section.stageId === stageId)
  .sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id),
  )

export const resolveTimetableSelection = ({
  eventId,
  eventDays,
  stages,
  selectedEventDayId,
  selectedStageId,
}: {
  eventId: EventId
  eventDays: EventDay[]
  stages: Stage[]
  selectedEventDayId?: EventDayId
  selectedStageId?: StageId
}): TimetableSelection => {
  const selectableEventDays = getEventDaysForEvent(eventDays, eventId)
  const eventDay = selectableEventDays.find(
    candidate => candidate.id === selectedEventDayId,
  ) ?? selectableEventDays[0]

  if (!eventDay) return {}

  const selectableStages = getStagesForEventDay(stages, eventDay.id)
  const stage = selectableStages.find(
    candidate => candidate.id === selectedStageId,
  ) ?? selectableStages[0]

  return {
    eventDayId: eventDay.id,
    stageId: stage?.id,
  }
}

export const getEventDayScheduleItems = (
  scheduleItems: ScheduleItem[],
  stages: Stage[],
  eventDayId: EventDayId,
): ScheduleItem[] => {
  const stageIds = new Set(
    stages
      .filter(stage => stage.eventDayId === eventDayId)
      .map(stage => stage.id),
  )
  return scheduleItems.filter(item => stageIds.has(item.stageId))
}

export const getUnscheduledEventBands = (
  eventBands: EventBand[],
  scheduleItems: ScheduleItem[],
): EventBand[] => {
  const scheduledEventBandIds = getScheduledEventBandIds(scheduleItems)
  return eventBands.filter(eventBand => !scheduledEventBandIds.has(eventBand.id))
}

export const getUnscheduledEventBandsForEventDay = ({
  eventBands,
  eventId,
  eventDayId,
  stages,
  scheduleItems,
}: {
  eventBands: EventBand[]
  eventId: EventId
  eventDayId: EventDayId
  stages: Stage[]
  scheduleItems: ScheduleItem[]
}): EventBand[] => getUnscheduledEventBands(
  getEventBandsForEventDay(eventBands, eventId, eventDayId),
  getEventDayScheduleItems(scheduleItems, stages, eventDayId),
)

export const getStageScheduleItems = (
  scheduleItems: ScheduleItem[],
  stageId: StageId,
): ScheduleItem[] =>
  scheduleItems
    .filter(item => item.stageId === stageId)
    .sort((left, right) => left.order - right.order)

export const getScheduleLaneItems = (
  scheduleItems: ScheduleItem[],
  lane: ScheduleLane,
): ScheduleItem[] => scheduleItems
  .filter(item => isItemInLane(item, lane))
  .sort((left, right) => left.order - right.order)

export const isValidScheduleLane = (
  stage: Stage,
  stageSections: Section[],
  lane: ScheduleLane,
): boolean => {
  if (lane.stageId !== stage.id) return false
  if (stageSections.length === 0) return lane.sectionId === undefined
  if (!lane.sectionId) return false
  return stageSections.some(
    section => section.stageId === stage.id && section.id === lane.sectionId,
  )
}

export const getInvalidSectionScheduleItemIds = (
  stage: Stage,
  stageSections: Section[],
  scheduleItems: ScheduleItem[],
): ScheduleItemId[] => {
  const sectionIds = new Set(
    stageSections
      .filter(section => section.stageId === stage.id)
      .map(section => section.id),
  )
  const stageUsesSections = sectionIds.size > 0

  return scheduleItems
    .filter(item =>
      item.stageId === stage.id &&
      (stageUsesSections
        ? !item.sectionId || !sectionIds.has(item.sectionId)
        : item.sectionId !== undefined),
    )
    .map(item => item.id)
}

const replaceStageScheduleItems = (
  scheduleItems: ScheduleItem[],
  stageId: StageId,
  stageItems: ScheduleItem[],
): ScheduleItem[] => [
  ...scheduleItems.filter(item => item.stageId !== stageId),
  ...stageItems.map((item, order) => setItemLane(item, { stageId }, order)),
]

export const reorderStageScheduleItems = (
  scheduleItems: ScheduleItem[],
  stageId: StageId,
  sourceIndex: number,
  destinationIndex: number,
): ScheduleItem[] => {
  const stageItems = getStageScheduleItems(scheduleItems, stageId)
  return replaceStageScheduleItems(
    scheduleItems,
    stageId,
    reorder(stageItems, sourceIndex, destinationIndex),
  )
}

export const insertStageScheduleItem = (
  scheduleItems: ScheduleItem[],
  stageId: StageId,
  scheduleItem: ScheduleItem,
  destinationIndex: number,
): ScheduleItem[] => {
  const stageItems = getStageScheduleItems(scheduleItems, stageId)
  if (destinationIndex < 0 || destinationIndex > stageItems.length) {
    return scheduleItems
  }
  stageItems.splice(destinationIndex, 0, scheduleItem)
  return replaceStageScheduleItems(scheduleItems, stageId, stageItems)
}

export const createPerformanceScheduleItemForLane = ({
  id,
  eventBandId,
  stage,
  stageSections,
  lane,
}: {
  id: ScheduleItemId
  eventBandId: EventBandId
  stage: Stage
  stageSections: Section[]
  lane: ScheduleLane
}): PerformanceScheduleItem | undefined => {
  if (!isValidScheduleLane(stage, stageSections, lane)) return undefined

  return setItemLane({
    id,
    stageId: stage.id,
    order: 0,
    kind: 'performance',
    eventBandId,
  }, lane, 0) as PerformanceScheduleItem
}

export const createBreakScheduleItemForLane = ({
  id,
  title,
  durationMinutes,
  stage,
  stageSections,
  lane,
}: {
  id: ScheduleItemId
  title: string
  durationMinutes: number
  stage: Stage
  stageSections: Section[]
  lane: ScheduleLane
}): BreakScheduleItem | undefined => {
  if (
    durationMinutes <= 0 ||
    !isValidScheduleLane(stage, stageSections, lane)
  ) return undefined

  return setItemLane({
    id,
    stageId: stage.id,
    order: 0,
    kind: 'break',
    title,
    durationMinutes,
  }, lane, 0) as BreakScheduleItem
}

export const insertScheduleItemInLane = (
  scheduleItems: ScheduleItem[],
  lane: ScheduleLane,
  scheduleItem: ScheduleItem,
  destinationIndex: number,
): ScheduleItem[] => {
  const laneItems = getScheduleLaneItems(scheduleItems, lane)
  if (destinationIndex < 0 || destinationIndex > laneItems.length) {
    return scheduleItems
  }
  laneItems.splice(destinationIndex, 0, scheduleItem)
  return replaceScheduleLaneItems(scheduleItems, lane, laneItems)
}

export const reorderScheduleLaneItems = (
  scheduleItems: ScheduleItem[],
  lane: ScheduleLane,
  sourceIndex: number,
  destinationIndex: number,
): ScheduleItem[] => {
  const laneItems = getScheduleLaneItems(scheduleItems, lane)
  const reordered = reorder(laneItems, sourceIndex, destinationIndex)
  if (reordered === laneItems) return scheduleItems
  return replaceScheduleLaneItems(scheduleItems, lane, reordered)
}

export const moveScheduleItemWithinStage = ({
  scheduleItems,
  stage,
  stageSections,
  sourceLane,
  sourceIndex,
  destinationLane,
  destinationIndex,
}: {
  scheduleItems: ScheduleItem[]
  stage: Stage
  stageSections: Section[]
  sourceLane: ScheduleLane
  sourceIndex: number
  destinationLane: ScheduleLane
  destinationIndex: number
}): ScheduleItem[] => {
  if (
    !isValidScheduleLane(stage, stageSections, sourceLane) ||
    !isValidScheduleLane(stage, stageSections, destinationLane)
  ) return scheduleItems

  if (
    sourceLane.stageId === destinationLane.stageId &&
    sourceLane.sectionId === destinationLane.sectionId
  ) {
    return reorderScheduleLaneItems(
      scheduleItems,
      sourceLane,
      sourceIndex,
      destinationIndex,
    )
  }

  const sourceItems = getScheduleLaneItems(scheduleItems, sourceLane)
  const movedItem = sourceItems[sourceIndex]
  if (!movedItem) return scheduleItems
  const destinationItems = getScheduleLaneItems(
    scheduleItems,
    destinationLane,
  )
  if (
    destinationIndex < 0 ||
    destinationIndex > destinationItems.length
  ) return scheduleItems

  const remaining = replaceScheduleLaneItems(
    scheduleItems,
    sourceLane,
    sourceItems.filter((_, index) => index !== sourceIndex),
  )
  return insertScheduleItemInLane(
    remaining,
    destinationLane,
    movedItem,
    destinationIndex,
  )
}

export const removeScheduleItem = (
  scheduleItems: ScheduleItem[],
  scheduleItemId: ScheduleItemId,
): ScheduleItem[] => {
  const targetItem = scheduleItems.find(item => item.id === scheduleItemId)
  if (!targetItem) return scheduleItems

  const lane = {
    stageId: targetItem.stageId,
    sectionId: targetItem.sectionId,
  }
  return replaceScheduleLaneItems(
    scheduleItems,
    lane,
    getScheduleLaneItems(scheduleItems, lane).filter(
      item => item.id !== scheduleItemId,
    ),
  )
}

export const reorderUnscheduledEventBands = (
  eventBands: EventBand[],
  scheduleItems: ScheduleItem[],
  sourceIndex: number,
  destinationIndex: number,
): EventBand[] => {
  const scheduledEventBandIds = getScheduledEventBandIds(scheduleItems)
  const unscheduledEventBands = eventBands.filter(
    eventBand => !scheduledEventBandIds.has(eventBand.id),
  )
  const reorderedEventBands = reorder(
    unscheduledEventBands,
    sourceIndex,
    destinationIndex,
  )
  if (reorderedEventBands === unscheduledEventBands) return eventBands

  let unscheduledIndex = 0
  return eventBands.map(eventBand => {
    if (scheduledEventBandIds.has(eventBand.id)) return eventBand
    return reorderedEventBands[unscheduledIndex++]
  })
}
