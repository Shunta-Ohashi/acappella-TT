import type {
  Event,
  EventBand,
  EventDay,
  EventId,
  LocalDate,
  Stage,
} from '../domain/models'

export interface EventListItem {
  eventId: EventId
  name: string
  dateLabel: string
  dayCount: number
  stageCount: number
  eventBandCount: number
}

interface CreateEventListItemsInput {
  events: Event[]
  eventDays: EventDay[]
  stages: Stage[]
  eventBands: EventBand[]
}

const formatLocalDate = (date: LocalDate): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date

  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
}

export const createEventListItems = ({
  events,
  eventDays,
  stages,
  eventBands,
}: CreateEventListItemsInput): EventListItem[] =>
  events.map((event) => {
    const orderedEventDays = eventDays
      .filter((eventDay) => eventDay.eventId === event.id)
      .sort((first, second) =>
        first.order - second.order ||
        first.date.localeCompare(second.date) ||
        first.id.localeCompare(second.id),
      )
    const eventDayIds = new Set(orderedEventDays.map((eventDay) => eventDay.id))

    return {
      eventId: event.id,
      name: event.name,
      dateLabel: orderedEventDays.length > 0
        ? orderedEventDays.map((eventDay) => formatLocalDate(eventDay.date)).join('・')
        : '開催日未設定',
      dayCount: orderedEventDays.length,
      stageCount: stages.filter((stage) => eventDayIds.has(stage.eventDayId)).length,
      eventBandCount: eventBands.filter(
        (eventBand) => eventBand.eventId === event.id,
      ).length,
    }
  })
