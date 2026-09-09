import type {
  Event,
  EventDay,
  EventDayId,
  LocalTime,
  ScheduleItem,
  Section,
  Stage,
  StageId,
} from './models'
import {
  isValidLocalTime,
  parseLocalTimeToMinute,
} from './timeline.ts'

export type StageEndMode = 'automatic' | 'fixed'
export type StageTransitionMode = 'event-default' | 'stage-specific'

export interface StageSettingsDraft {
  draftId: string
  stageId?: StageId
  eventDayId: EventDayId
  name: string
  location: string
  plannedStartTime: LocalTime
  endMode: StageEndMode
  plannedEndTime: LocalTime
  transitionMode: StageTransitionMode
  transitionMinutes: string
}

export interface EventStageSettingsDraft {
  defaultTransitionMinutes: string
  stages: StageSettingsDraft[]
}

export interface StageSettingsValidationErrors {
  name?: string
  plannedStartTime?: string
  plannedEndTime?: string
  transitionMinutes?: string
  form?: string
}

export interface EventStageSettingsValidationErrors {
  defaultTransitionMinutes?: string
  stages: Record<string, StageSettingsValidationErrors>
  form?: string
}

export interface StageReferences {
  sections: Pick<Section, 'stageId'>[]
  scheduleItems: Pick<ScheduleItem, 'stageId'>[]
}

interface CreateEventStageSettingsUpdateInput extends StageReferences {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  draft: EventStageSettingsDraft
  newStageIds: StageId[]
}

export type EventStageSettingsUpdateResult =
  | { ok: true; event: Event; stages: Stage[] }
  | { ok: false; errors: EventStageSettingsValidationErrors }

const isNonNegativeInteger = (value: string): boolean =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value))

const normalizeOptionalText = (value: string): string | undefined => {
  const normalized = value.trim()
  return normalized || undefined
}

const hasStageErrors = (errors: StageSettingsValidationErrors): boolean =>
  Object.values(errors).some(Boolean)

export const createEventStageSettingsDraft = (
  event: Event,
  eventDays: EventDay[],
  stages: Stage[],
): EventStageSettingsDraft => {
  const orderedEventDays = eventDays
    .filter((eventDay) => eventDay.eventId === event.id)
    .sort((first, second) =>
      first.order - second.order ||
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
    )
  const eventDayOrder = new Map(
    orderedEventDays.map((eventDay, index) => [eventDay.id, index]),
  )

  return {
    defaultTransitionMinutes: String(event.defaultTransitionMinutes),
    stages: stages
      .filter((stage) => eventDayOrder.has(stage.eventDayId))
      .sort((first, second) =>
        (eventDayOrder.get(first.eventDayId) ?? 0) -
          (eventDayOrder.get(second.eventDayId) ?? 0) ||
        first.order - second.order ||
        first.id.localeCompare(second.id),
      )
      .map((stage) => ({
        draftId: `stage-${stage.id}`,
        stageId: stage.id,
        eventDayId: stage.eventDayId,
        name: stage.name,
        location: stage.location ?? '',
        plannedStartTime: stage.plannedStartTime,
        endMode: stage.plannedEndTime ? 'fixed' : 'automatic',
        plannedEndTime: stage.plannedEndTime ?? '',
        transitionMode: stage.transitionMinutes === undefined
          ? 'event-default'
          : 'stage-specific',
        transitionMinutes: stage.transitionMinutes === undefined
          ? ''
          : String(stage.transitionMinutes),
      })),
  }
}

export const validateEventStageSettingsDraft = (
  draft: EventStageSettingsDraft,
): EventStageSettingsValidationErrors => {
  const errors: EventStageSettingsValidationErrors = { stages: {} }

  if (!isNonNegativeInteger(draft.defaultTransitionMinutes)) {
    errors.defaultTransitionMinutes = '0以上の整数を入力してください。'
  }

  for (const stage of draft.stages) {
    const stageErrors: StageSettingsValidationErrors = {}

    if (!stage.name.trim()) {
      stageErrors.name = 'Stage名を入力してください。'
    }

    const startIsValid = isValidLocalTime(stage.plannedStartTime)
    if (!startIsValid) {
      stageErrors.plannedStartTime = '有効な開始時刻を入力してください。'
    }

    if (stage.endMode === 'fixed') {
      const endIsValid = isValidLocalTime(stage.plannedEndTime)
      if (!endIsValid) {
        stageErrors.plannedEndTime = '有効な終了時刻を入力してください。'
      } else if (
        startIsValid &&
        parseLocalTimeToMinute(stage.plannedEndTime) <=
          parseLocalTimeToMinute(stage.plannedStartTime)
      ) {
        stageErrors.plannedEndTime =
          '終了時刻は開始時刻より後にしてください。'
      }
    }

    if (
      stage.transitionMode === 'stage-specific' &&
      !isNonNegativeInteger(stage.transitionMinutes)
    ) {
      stageErrors.transitionMinutes = '0以上の整数を入力してください。'
    }

    if (hasStageErrors(stageErrors)) {
      errors.stages[stage.draftId] = stageErrors
    }
  }

  return errors
}

export const hasEventStageSettingsErrors = (
  errors: EventStageSettingsValidationErrors,
): boolean => Boolean(
  errors.defaultTransitionMinutes ||
  errors.form ||
  Object.values(errors.stages).some(hasStageErrors),
)

export const canDeleteStage = (
  stageId: StageId,
  { sections, scheduleItems }: StageReferences,
): boolean =>
  !sections.some((section) => section.stageId === stageId) &&
  !scheduleItems.some((scheduleItem) => scheduleItem.stageId === stageId)

export const createEventStageSettingsUpdate = ({
  event,
  eventDays,
  stages,
  draft,
  newStageIds,
  sections,
  scheduleItems,
}: CreateEventStageSettingsUpdateInput): EventStageSettingsUpdateResult => {
  const errors = validateEventStageSettingsDraft(draft)
  if (hasEventStageSettingsErrors(errors)) return { ok: false, errors }

  const orderedEventDays = eventDays
    .filter((eventDay) => eventDay.eventId === event.id)
    .sort((first, second) =>
      first.order - second.order ||
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
    )
  const eventDayOrder = new Map(
    orderedEventDays.map((eventDay, index) => [eventDay.id, index]),
  )
  const currentStages = stages.filter((stage) =>
    eventDayOrder.has(stage.eventDayId),
  )
  const currentStagesById = new Map(
    currentStages.map((stage) => [stage.id, stage]),
  )
  const retainedStageIds = new Set(
    draft.stages.flatMap((stage) => stage.stageId ? [stage.stageId] : []),
  )
  const blockedDeletion = currentStages.find((stage) =>
    !retainedStageIds.has(stage.id) &&
    !canDeleteStage(stage.id, { sections, scheduleItems }),
  )

  if (blockedDeletion) {
    return {
      ok: false,
      errors: {
        stages: {},
        form: 'このStageにはタイムテーブルまたはSectionが設定されているため削除できません。関連する設定を先に削除してください。',
      },
    }
  }

  if (draft.stages.some((stage) => !eventDayOrder.has(stage.eventDayId))) {
    return {
      ok: false,
      errors: {
        stages: {},
        form: '選択中のイベントに属さない開催日のStageは保存できません。',
      },
    }
  }

  const newStageCount = draft.stages.filter((stage) => !stage.stageId).length
  if (newStageIds.length !== newStageCount) {
    throw new Error('A Stage ID is required for every new Stage')
  }

  let newStageIndex = 0
  const orderByEventDay = new Map<EventDayId, number>()
  const updatedStages: Stage[] = []

  for (const stageDraft of draft.stages) {
    const order = orderByEventDay.get(stageDraft.eventDayId) ?? 0
    orderByEventDay.set(stageDraft.eventDayId, order + 1)

    const values = {
      eventDayId: stageDraft.eventDayId,
      name: stageDraft.name.trim(),
      location: normalizeOptionalText(stageDraft.location),
      order,
      plannedStartTime: stageDraft.plannedStartTime,
      plannedEndTime: stageDraft.endMode === 'fixed'
        ? stageDraft.plannedEndTime
        : undefined,
      transitionMinutes: stageDraft.transitionMode === 'stage-specific'
        ? Number(stageDraft.transitionMinutes)
        : undefined,
    }

    if (stageDraft.stageId) {
      const existingStage = currentStagesById.get(stageDraft.stageId)
      if (!existingStage || existingStage.eventDayId !== stageDraft.eventDayId) {
        return {
          ok: false,
          errors: {
            stages: {},
            form: 'Stageの情報が更新されたため保存できません。画面を開き直してください。',
          },
        }
      }
      updatedStages.push({ ...existingStage, ...values })
    } else {
      updatedStages.push({
        id: newStageIds[newStageIndex++],
        ...values,
      })
    }
  }

  updatedStages.sort((first, second) =>
    (eventDayOrder.get(first.eventDayId) ?? 0) -
      (eventDayOrder.get(second.eventDayId) ?? 0) ||
    first.order - second.order ||
    first.id.localeCompare(second.id),
  )

  return {
    ok: true,
    event: {
      ...event,
      defaultTransitionMinutes: Number(draft.defaultTransitionMinutes),
    },
    stages: updatedStages,
  }
}
