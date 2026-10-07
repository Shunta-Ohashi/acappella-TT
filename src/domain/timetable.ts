import type {
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

export interface FailedStageTimeline {
  stageId: StageId
}

export interface SafelyEvaluatedEventDayTimelines extends CalculatedEventDayTimelines {
  failedStages: FailedStageTimeline[]
}

export const calculateEventDayTimelines = ({
  eventDayId,
  stages,
  sections,
  scheduleItems,
  eventBands,
}: {
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
      stage,
      sections: stageSections,
      scheduleItems: stageScheduleItems,
      eventBands,
    }))
  }

  return { calculatedItems, invalidStages }
}

export const evaluateEventDayTimelinesSafely = ({
  eventDayId,
  stages,
  sections,
  scheduleItems,
  eventBands,
}: {
  eventDayId: EventDayId
  stages: Stage[]
  sections: Section[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
}): SafelyEvaluatedEventDayTimelines => {
  const calculatedItems: CalculatedScheduleItem[] = []
  const invalidStages: InvalidStageTimeline[] = []
  const failedStages: FailedStageTimeline[] = []

  for (const stage of getStagesForEventDay(stages, eventDayId)) {
    try {
      const result = calculateEventDayTimelines({
        eventDayId,
        stages: [stage],
        sections,
        scheduleItems,
        eventBands,
      })
      calculatedItems.push(...result.calculatedItems)
      invalidStages.push(...result.invalidStages)
    } catch {
      failedStages.push({ stageId: stage.id })
    }
  }

  return { calculatedItems, invalidStages, failedStages }
}
