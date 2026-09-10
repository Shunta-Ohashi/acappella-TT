import type {
  Event,
  EventBand,
  EventDayId,
  ScheduleItem,
  Section,
  Stage,
  StageId,
} from './models'
import {
  getInvalidSectionScheduleItemIds,
  getSectionsForStage,
  getStageScheduleItems,
  getStagesForEventDay,
} from './schedule.ts'
import {
  calculateStageTimeline,
  type CalculatedScheduleItem,
} from './timeline.ts'

export interface InvalidStageTimeline {
  stageId: StageId
  scheduleItemIds: ScheduleItem['id'][]
}

export interface CalculatedEventDayTimelines {
  calculatedItems: CalculatedScheduleItem[]
  invalidStages: InvalidStageTimeline[]
}

export const calculateEventDayTimelines = ({
  event,
  eventDayId,
  stages,
  sections,
  scheduleItems,
  eventBands,
}: {
  event: Event
  eventDayId: EventDayId
  stages: Stage[]
  sections: Section[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
}): CalculatedEventDayTimelines => {
  const calculatedItems: CalculatedScheduleItem[] = []
  const invalidStages: InvalidStageTimeline[] = []

  for (const stage of getStagesForEventDay(stages, eventDayId)) {
    const stageSections = getSectionsForStage(sections, stage.id)
    const stageScheduleItems = getStageScheduleItems(scheduleItems, stage.id)
    const invalidScheduleItemIds = getInvalidSectionScheduleItemIds(
      stage,
      stageSections,
      stageScheduleItems,
    )

    if (invalidScheduleItemIds.length > 0) {
      invalidStages.push({
        stageId: stage.id,
        scheduleItemIds: invalidScheduleItemIds,
      })
      continue
    }

    calculatedItems.push(...calculateStageTimeline({
      event,
      stage,
      sections: stageSections,
      scheduleItems: stageScheduleItems,
      eventBands,
    }))
  }

  return { calculatedItems, invalidStages }
}
