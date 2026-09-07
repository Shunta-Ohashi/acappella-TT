import type {
  Event,
  EventBand,
  EventBandId,
  ScheduleItem,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  StageId,
} from './models'

export interface CalculatedScheduleItem {
  scheduleItemId: ScheduleItemId
  stageId: StageId
  sectionId?: SectionId
  kind: 'performance' | 'break'
  plannedStartMinute: number
  plannedEndMinute: number
  eventBandId?: EventBandId
}

export interface CalculateStageTimelineInput {
  event: Event
  stage: Stage
  sections: Section[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
}

export const parseLocalTimeToMinute = (time: string): number => {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) throw new RangeError(`Invalid local time: ${time}`)

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new RangeError(`Invalid local time: ${time}`)
  }

  return hour * 60 + minute
}

export const formatMinuteAsLocalTime = (totalMinutes: number): string => {
  const minutesPerDay = 24 * 60
  const normalizedMinutes = ((totalMinutes % minutesPerDay) + minutesPerDay) % minutesPerDay
  const hour = Math.floor(normalizedMinutes / 60)
  const minute = normalizedMinutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export const calculateStageTimeline = ({
  event,
  stage,
  sections,
  scheduleItems,
  eventBands,
}: CalculateStageTimelineInput): CalculatedScheduleItem[] => {
  const transitionMinutes = stage.transitionMinutes ?? event.defaultTransitionMinutes
  const eventBandsById = new Map(eventBands.map(eventBand => [eventBand.id, eventBand]))
  const stageScheduleItems = scheduleItems.filter(item => item.stageId === stage.id)
  const stageSections = sections
    .filter(section => section.stageId === stage.id)
    .sort((left, right) => left.order - right.order)
  const calculatedItems: CalculatedScheduleItem[] = []
  let currentMinute = parseLocalTimeToMinute(stage.plannedStartTime)

  const calculateItems = (items: ScheduleItem[]) => {
    const orderedItems = [...items].sort((left, right) => left.order - right.order)

    for (const scheduleItem of orderedItems) {
      let durationMinutes: number
      if (scheduleItem.kind === 'break') {
        durationMinutes = scheduleItem.durationMinutes
      } else {
        const eventBand = eventBandsById.get(scheduleItem.eventBandId)
        if (!eventBand) {
          throw new Error(`EventBand not found: ${scheduleItem.eventBandId}`)
        }
        durationMinutes = eventBand.durationMinutes
      }
      const plannedStartMinute = currentMinute
      const plannedEndMinute = plannedStartMinute + durationMinutes

      calculatedItems.push({
        scheduleItemId: scheduleItem.id,
        stageId: scheduleItem.stageId,
        sectionId: scheduleItem.sectionId,
        kind: scheduleItem.kind,
        plannedStartMinute,
        plannedEndMinute,
        ...(scheduleItem.kind === 'performance'
          ? { eventBandId: scheduleItem.eventBandId }
          : {}),
      })

      currentMinute = scheduleItem.kind === 'performance'
        ? plannedEndMinute + transitionMinutes
        : plannedEndMinute
    }
  }

  if (stageSections.length === 0) {
    calculateItems(stageScheduleItems)
    return calculatedItems
  }

  for (const section of stageSections) {
    if (section.plannedStartTime) {
      currentMinute = parseLocalTimeToMinute(section.plannedStartTime)
    }

    calculateItems(
      stageScheduleItems.filter(scheduleItem => scheduleItem.sectionId === section.id),
    )
  }

  return calculatedItems
}
