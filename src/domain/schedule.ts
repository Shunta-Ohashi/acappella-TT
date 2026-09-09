import type {
  EventBand,
  EventBandId,
  EventDayId,
  EventId,
  ScheduleItem,
  ScheduleItemId,
  StageId,
} from './models'

const reorder = <T,>(items: T[], sourceIndex: number, destinationIndex: number): T[] => {
  const reordered = [...items]
  const [moved] = reordered.splice(sourceIndex, 1)
  reordered.splice(destinationIndex, 0, moved)
  return reordered
}

const getScheduledEventBandIds = (scheduleItems: ScheduleItem[]): Set<EventBandId> =>
  new Set(
    scheduleItems
      .filter(item => item.kind === 'performance')
      .map(item => item.eventBandId),
  )

export const getEventBandById = (
  eventBands: EventBand[],
  eventBandId: EventBandId,
): EventBand | undefined => eventBands.find(eventBand => eventBand.id === eventBandId)

export const getEventBandsForEventDay = (
  eventBands: EventBand[],
  eventId: EventId,
  eventDayId: EventDayId,
): EventBand[] => eventBands.filter(
  eventBand => eventBand.eventId === eventId &&
    eventBand.eventDayId === eventDayId,
)

export const getUnscheduledEventBands = (
  eventBands: EventBand[],
  scheduleItems: ScheduleItem[],
): EventBand[] => {
  const scheduledEventBandIds = getScheduledEventBandIds(scheduleItems)
  return eventBands.filter(eventBand => !scheduledEventBandIds.has(eventBand.id))
}

export const getStageScheduleItems = (
  scheduleItems: ScheduleItem[],
  stageId: StageId,
): ScheduleItem[] =>
  scheduleItems
    .filter(item => item.stageId === stageId)
    .sort((left, right) => left.order - right.order)

const replaceStageScheduleItems = (
  scheduleItems: ScheduleItem[],
  stageId: StageId,
  stageItems: ScheduleItem[],
): ScheduleItem[] => [
  ...scheduleItems.filter(item => item.stageId !== stageId),
  ...stageItems.map((item, order) => ({ ...item, stageId, order })),
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
  stageItems.splice(destinationIndex, 0, scheduleItem)
  return replaceStageScheduleItems(scheduleItems, stageId, stageItems)
}

export const removeScheduleItem = (
  scheduleItems: ScheduleItem[],
  scheduleItemId: ScheduleItemId,
): ScheduleItem[] => {
  const targetItem = scheduleItems.find(item => item.id === scheduleItemId)
  if (!targetItem) return scheduleItems

  const stageItems = getStageScheduleItems(scheduleItems, targetItem.stageId)
    .filter(item => item.id !== scheduleItemId)

  return replaceStageScheduleItems(scheduleItems, targetItem.stageId, stageItems)
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
  let unscheduledIndex = 0

  return eventBands.map(eventBand => {
    if (scheduledEventBandIds.has(eventBand.id)) return eventBand
    return reorderedEventBands[unscheduledIndex++]
  })
}
