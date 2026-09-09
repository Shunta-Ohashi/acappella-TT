import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMemberDay,
  LocalDate,
  Stage,
} from './models'
import {
  validateNewEventDraft,
  type NewEventValidationErrors,
} from './eventCreation.ts'

export interface EventBasicInfoDayDraft {
  eventDayId?: EventDayId
  date: LocalDate
}

export interface EventBasicInfoDraft {
  name: string
  eventDays: EventBasicInfoDayDraft[]
  description: string
  notes: string
}

export interface EventBasicInfoValidationErrors
  extends NewEventValidationErrors {
  form?: string
}

export interface EventDayReferences {
  stages: Pick<Stage, 'eventDayId'>[]
  eventMemberDays: Pick<EventMemberDay, 'eventDayId'>[]
  eventBands: Pick<EventBand, 'eventDayId'>[]
}

interface CreateEventBasicInfoUpdateInput extends EventDayReferences {
  event: Event
  eventDays: EventDay[]
  draft: EventBasicInfoDraft
  newEventDayIds: EventDayId[]
}

export type EventBasicInfoUpdateResult =
  | { ok: true; event: Event; eventDays: EventDay[] }
  | { ok: false; errors: EventBasicInfoValidationErrors }

const normalizeOptionalText = (value: string): string | undefined => {
  return value.trim() ? value : undefined
}

export const createEventBasicInfoDraft = (
  event: Event,
  eventDays: EventDay[],
): EventBasicInfoDraft => ({
  name: event.name,
  description: event.description ?? '',
  notes: event.notes ?? '',
  eventDays: eventDays
    .filter((eventDay) => eventDay.eventId === event.id)
    .sort((first, second) =>
      first.order - second.order ||
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
    )
    .map((eventDay) => ({
      eventDayId: eventDay.id,
      date: eventDay.date,
    })),
})

export const validateEventBasicInfoDraft = (
  draft: EventBasicInfoDraft,
): EventBasicInfoValidationErrors => validateNewEventDraft({
  name: draft.name,
  dates: draft.eventDays.map((eventDay) => eventDay.date),
})

export const canDeleteEventDay = (
  eventDayId: EventDayId,
  { stages, eventMemberDays, eventBands }: EventDayReferences,
): boolean =>
  !stages.some((stage) => stage.eventDayId === eventDayId) &&
  !eventMemberDays.some((eventMemberDay) =>
    eventMemberDay.eventDayId === eventDayId) &&
  !eventBands.some((eventBand) => eventBand.eventDayId === eventDayId)

export const createEventBasicInfoUpdate = ({
  event,
  eventDays,
  draft,
  newEventDayIds,
  stages,
  eventMemberDays,
  eventBands,
}: CreateEventBasicInfoUpdateInput): EventBasicInfoUpdateResult => {
  const errors = validateEventBasicInfoDraft(draft)
  if (errors.name || errors.dates) return { ok: false, errors }

  const currentEventDays = eventDays.filter(
    (eventDay) => eventDay.eventId === event.id,
  )
  const currentEventDaysById = new Map(
    currentEventDays.map((eventDay) => [eventDay.id, eventDay]),
  )
  const retainedEventDayIds = new Set(
    draft.eventDays.flatMap((eventDay) =>
      eventDay.eventDayId ? [eventDay.eventDayId] : []),
  )
  const blockedDeletion = currentEventDays.find((eventDay) =>
    !retainedEventDayIds.has(eventDay.id) &&
    !canDeleteEventDay(eventDay.id, { stages, eventMemberDays, eventBands }),
  )

  if (blockedDeletion) {
    return {
      ok: false,
      errors: {
        form: 'この開催日にはStage・出演バンドなどの設定があるため削除できません。関連する設定を先に削除してください。',
      },
    }
  }

  const newEventDayCount = draft.eventDays.filter(
    (eventDay) => !eventDay.eventDayId,
  ).length
  if (newEventDayIds.length !== newEventDayCount) {
    throw new Error('An EventDay ID is required for every new event date')
  }

  let newEventDayIndex = 0
  const updatedEventDays: EventDay[] = []

  for (const eventDayDraft of draft.eventDays) {
    if (eventDayDraft.eventDayId) {
      const existingEventDay = currentEventDaysById.get(
        eventDayDraft.eventDayId,
      )
      if (!existingEventDay) {
        return {
          ok: false,
          errors: {
            form: '開催日の情報が更新されたため保存できません。画面を開き直してください。',
          },
        }
      }
      updatedEventDays.push({
        ...existingEventDay,
        date: eventDayDraft.date,
      })
      continue
    }

    updatedEventDays.push({
      id: newEventDayIds[newEventDayIndex++],
      eventId: event.id,
      date: eventDayDraft.date,
      order: 0,
    })
  }

  updatedEventDays.sort((first, second) =>
    first.date.localeCompare(second.date) || first.id.localeCompare(second.id),
  )

  return {
    ok: true,
    event: {
      ...event,
      name: draft.name.trim(),
      description: normalizeOptionalText(draft.description),
      notes: normalizeOptionalText(draft.notes),
    },
    eventDays: updatedEventDays.map((eventDay, order) => ({
      ...eventDay,
      order,
    })),
  }
}
