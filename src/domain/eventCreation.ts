import type {
  Event,
  EventDay,
  EventDayId,
  EventId,
  LocalDate,
} from './models'

export interface NewEventDraft {
  name: string
  dates: LocalDate[]
}

export interface NewEventValidationErrors {
  name?: string
  dates?: string
}

interface CreateEventDataInput {
  eventId: EventId
  eventDayIds: EventDayId[]
  draft: NewEventDraft
  defaults: Pick<
    Event,
    'timeZone' | 'defaultTransitionMinutes' | 'validationPolicy'
  >
}

export const DEFAULT_PERFORMANCE_SLOT_MINUTES = [5, 10, 15]

const isValidLocalDate = (value: LocalDate): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate()

  return year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= maximumDay
}

export const validateNewEventDraft = (
  draft: NewEventDraft,
): NewEventValidationErrors => {
  const errors: NewEventValidationErrors = {}

  if (!draft.name.trim()) {
    errors.name = 'イベント名を入力してください。'
  }

  if (draft.dates.length === 0 || draft.dates.some((date) => !date)) {
    errors.dates = '開催日を1件以上、すべて入力してください。'
  } else if (draft.dates.some((date) => !isValidLocalDate(date))) {
    errors.dates = '有効な開催日を入力してください。'
  } else if (new Set(draft.dates).size !== draft.dates.length) {
    errors.dates = '同じ開催日を重複して登録できません。'
  }

  return errors
}

export const createEventData = ({
  eventId,
  eventDayIds,
  draft,
  defaults,
}: CreateEventDataInput): { event: Event; eventDays: EventDay[] } => {
  const errors = validateNewEventDraft(draft)
  if (errors.name || errors.dates) {
    throw new Error('Invalid new event draft')
  }
  if (eventDayIds.length !== draft.dates.length) {
    throw new Error('An EventDay ID is required for every event date')
  }

  const orderedDates = [...draft.dates].sort((first, second) =>
    first.localeCompare(second),
  )

  return {
    event: {
      id: eventId,
      name: draft.name.trim(),
      timeZone: defaults.timeZone,
      defaultTransitionMinutes: defaults.defaultTransitionMinutes,
      validationPolicy: { ...defaults.validationPolicy },
      performanceSlotMinutes: [...DEFAULT_PERFORMANCE_SLOT_MINUTES],
    },
    eventDays: orderedDates.map((date, order) => ({
      id: eventDayIds[order],
      eventId,
      date,
      order,
    })),
  }
}
