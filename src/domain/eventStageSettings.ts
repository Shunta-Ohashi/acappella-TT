import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  LocalTime,
  ScheduleItem,
  Section,
  SectionId,
  Stage,
  StageId,
} from './models'
import {
  isValidLocalTime,
  parseLocalTimeToMinute,
} from './timeline.ts'

export type StageEndMode = 'automatic' | 'fixed'
export type StageTransitionMode = 'event-default' | 'stage-specific'
export type SectionTimeMode = 'automatic' | 'fixed'

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

export interface SectionSettingsDraft {
  draftId: string
  sectionId?: SectionId
  stageDraftId: string
  name: string
  startMode: SectionTimeMode
  plannedStartTime: LocalTime
  endMode: SectionTimeMode
  plannedEndTime: LocalTime
}

export interface EventStageSettingsDraft {
  defaultTransitionMinutes: string
  performanceSlotMinutes: number[]
  stages: StageSettingsDraft[]
  sections: SectionSettingsDraft[]
}

export interface StageSettingsValidationErrors {
  name?: string
  plannedStartTime?: string
  plannedEndTime?: string
  transitionMinutes?: string
  form?: string
}

export interface SectionSettingsValidationErrors {
  name?: string
  plannedStartTime?: string
  plannedEndTime?: string
  form?: string
}

export interface EventStageSettingsValidationErrors {
  defaultTransitionMinutes?: string
  performanceSlotMinutes?: string
  stages: Record<string, StageSettingsValidationErrors>
  sections: Record<string, SectionSettingsValidationErrors>
  form?: string
}

export interface StageReferences {
  sections: Pick<Section, 'stageId'>[]
  scheduleItems: Pick<ScheduleItem, 'stageId'>[]
  eventBands: Pick<EventBand, 'fixedPlacement'>[]
}

export interface SectionReferences {
  scheduleItems: Pick<ScheduleItem, 'sectionId'>[]
  eventBands: Pick<EventBand, 'fixedPlacement'>[]
}

interface CreateEventStageSettingsUpdateInput {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  draft: EventStageSettingsDraft
  newStageIds: StageId[]
  newSectionIds: SectionId[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
}

export type EventStageSettingsUpdateResult =
  | { ok: true; event: Event; stages: Stage[]; sections: Section[] }
  | { ok: false; errors: EventStageSettingsValidationErrors }

const isNonNegativeInteger = (value: string): boolean =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value))

const isValidPerformanceSlotMinute = (value: number): boolean =>
  Number.isFinite(value) && Number.isSafeInteger(value) && value > 0

export const normalizePerformanceSlotMinutes = (
  values: number[],
): number[] => [...new Set(values)].sort((first, second) => first - second)

export type AddPerformanceSlotMinuteResult =
  | { ok: true; performanceSlotMinutes: number[] }
  | { ok: false; error: string }

export const addPerformanceSlotMinute = (
  performanceSlotMinutes: number[],
  rawValue: string,
): AddPerformanceSlotMinuteResult => {
  const normalizedValue = rawValue.trim()
  const value = Number(normalizedValue)

  if (
    !/^\d+$/.test(normalizedValue) ||
    !isValidPerformanceSlotMinute(value)
  ) {
    return { ok: false, error: '出演枠は1分以上の整数で入力してください。' }
  }
  if (performanceSlotMinutes.includes(value)) {
    return { ok: false, error: `${value}分枠はすでに登録されています。` }
  }

  return {
    ok: true,
    performanceSlotMinutes: normalizePerformanceSlotMinutes([
      ...performanceSlotMinutes,
      value,
    ]),
  }
}

export const validatePerformanceSlotMinutes = (
  values: number[],
): string | undefined => {
  if (values.length === 0) return '出演枠を1件以上設定してください。'
  if (values.some((value) => !isValidPerformanceSlotMinute(value))) {
    return '出演枠は1分以上の整数で設定してください。'
  }
  if (new Set(values).size !== values.length) {
    return '同じ出演枠を重複して設定できません。'
  }
  return undefined
}

const normalizeOptionalText = (value: string): string | undefined => {
  const normalized = value.trim()
  return normalized || undefined
}

const hasStageErrors = (errors: StageSettingsValidationErrors): boolean =>
  Object.values(errors).some(Boolean)

const hasSectionErrors = (errors: SectionSettingsValidationErrors): boolean =>
  Object.values(errors).some(Boolean)

export const isValidStageTimeRange = (
  plannedStartTime: LocalTime,
  plannedEndTime?: LocalTime,
): boolean => {
  if (!isValidLocalTime(plannedStartTime)) return false
  if (plannedEndTime === undefined) return true
  if (!isValidLocalTime(plannedEndTime)) return false

  return parseLocalTimeToMinute(plannedStartTime) <
    parseLocalTimeToMinute(plannedEndTime)
}

export const createEventStageSettingsDraft = (
  event: Event,
  eventDays: EventDay[],
  stages: Stage[],
  sections: Section[],
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
  const stageDrafts = stages
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
      endMode: stage.plannedEndTime ? 'fixed' as const : 'automatic' as const,
      plannedEndTime: stage.plannedEndTime ?? '',
      transitionMode: stage.transitionMinutes === undefined
        ? 'event-default' as const
        : 'stage-specific' as const,
      transitionMinutes: stage.transitionMinutes === undefined
        ? ''
        : String(stage.transitionMinutes),
    }))
  const stageDraftIdByStageId = new Map(
    stageDrafts.flatMap((stage) =>
      stage.stageId ? [[stage.stageId, stage.draftId] as const] : [],
    ),
  )
  const stageOrder = new Map(
    stageDrafts.flatMap((stage, index) =>
      stage.stageId ? [[stage.stageId, index] as const] : [],
    ),
  )

  return {
    defaultTransitionMinutes: String(event.defaultTransitionMinutes),
    performanceSlotMinutes: normalizePerformanceSlotMinutes(
      event.performanceSlotMinutes,
    ),
    stages: stageDrafts,
    sections: sections
      .filter((section) => stageDraftIdByStageId.has(section.stageId))
      .sort((first, second) =>
        (stageOrder.get(first.stageId) ?? 0) -
          (stageOrder.get(second.stageId) ?? 0) ||
        first.order - second.order ||
        first.id.localeCompare(second.id),
      )
      .map((section) => ({
        draftId: `section-${section.id}`,
        sectionId: section.id,
        stageDraftId: stageDraftIdByStageId.get(section.stageId)!,
        name: section.name,
        startMode: section.plannedStartTime ? 'fixed' : 'automatic',
        plannedStartTime: section.plannedStartTime ?? '',
        endMode: section.plannedEndTime ? 'fixed' : 'automatic',
        plannedEndTime: section.plannedEndTime ?? '',
      })),
  }
}

export const validateEventStageSettingsDraft = (
  draft: EventStageSettingsDraft,
): EventStageSettingsValidationErrors => {
  const errors: EventStageSettingsValidationErrors = {
    stages: {},
    sections: {},
  }

  if (!isNonNegativeInteger(draft.defaultTransitionMinutes)) {
    errors.defaultTransitionMinutes = '0以上の整数を入力してください。'
  }

  errors.performanceSlotMinutes = validatePerformanceSlotMinutes(
    draft.performanceSlotMinutes,
  )

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
        !isValidStageTimeRange(stage.plannedStartTime, stage.plannedEndTime)
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

  const stagesByDraftId = new Map(
    draft.stages.map((stage) => [stage.draftId, stage]),
  )

  for (const section of draft.sections) {
    const sectionErrors: SectionSettingsValidationErrors = {}
    const stage = stagesByDraftId.get(section.stageDraftId)

    if (!stage) {
      sectionErrors.form =
        '対象Stageが見つかりません。画面を開き直してください。'
    }

    if (!section.name.trim()) {
      sectionErrors.name = 'Section名を入力してください。'
    }

    const stageStartIsValid = Boolean(
      stage && isValidLocalTime(stage.plannedStartTime),
    )
    const stageStartMinute = stageStartIsValid
      ? parseLocalTimeToMinute(stage!.plannedStartTime)
      : undefined
    const stageEndIsValid = Boolean(
      stage &&
      stage.endMode === 'fixed' &&
      isValidLocalTime(stage.plannedEndTime),
    )
    const stageEndMinute = stageEndIsValid
      ? parseLocalTimeToMinute(stage!.plannedEndTime)
      : undefined

    let sectionStartMinute: number | undefined
    if (section.startMode === 'fixed') {
      if (!isValidLocalTime(section.plannedStartTime)) {
        sectionErrors.plannedStartTime =
          '有効な固定開始時刻を入力してください。'
      } else {
        sectionStartMinute = parseLocalTimeToMinute(section.plannedStartTime)
        if (
          stageStartMinute !== undefined &&
          sectionStartMinute < stageStartMinute
        ) {
          sectionErrors.plannedStartTime =
            '固定開始時刻はStage開始時刻以降にしてください。'
        } else if (
          stageEndMinute !== undefined &&
          sectionStartMinute >= stageEndMinute
        ) {
          sectionErrors.plannedStartTime =
            '固定開始時刻はStage終了時刻より前にしてください。'
        }
      }
    }

    let sectionEndMinute: number | undefined
    if (section.endMode === 'fixed') {
      if (!isValidLocalTime(section.plannedEndTime)) {
        sectionErrors.plannedEndTime =
          '有効な固定終了時刻を入力してください。'
      } else {
        sectionEndMinute = parseLocalTimeToMinute(section.plannedEndTime)
        if (
          stageStartMinute !== undefined &&
          sectionEndMinute <= stageStartMinute
        ) {
          sectionErrors.plannedEndTime =
            '固定終了時刻はStage開始時刻より後にしてください。'
        } else if (
          stageEndMinute !== undefined &&
          sectionEndMinute > stageEndMinute
        ) {
          sectionErrors.plannedEndTime =
            '固定終了時刻はStage終了時刻以前にしてください。'
        }
      }
    }

    if (
      sectionStartMinute !== undefined &&
      sectionEndMinute !== undefined &&
      sectionStartMinute >= sectionEndMinute &&
      !sectionErrors.plannedEndTime
    ) {
      sectionErrors.plannedEndTime =
        '固定終了時刻は固定開始時刻より後にしてください。'
    }

    if (hasSectionErrors(sectionErrors)) {
      errors.sections[section.draftId] = sectionErrors
    }
  }

  return errors
}

export const hasEventStageSettingsErrors = (
  errors: EventStageSettingsValidationErrors,
): boolean => Boolean(
  errors.defaultTransitionMinutes ||
  errors.performanceSlotMinutes ||
  errors.form ||
  Object.values(errors.stages).some(hasStageErrors) ||
  Object.values(errors.sections).some(hasSectionErrors),
)

export const getEventStageSettingsErrorEventDayIds = (
  draft: EventStageSettingsDraft,
  errors: EventStageSettingsValidationErrors,
): EventDayId[] => {
  const eventDayIds: EventDayId[] = []
  const seenEventDayIds = new Set<EventDayId>()

  for (const stage of draft.stages) {
    const stageErrors = errors.stages[stage.draftId]
    const hasRelatedSectionError = draft.sections.some((section) =>
      section.stageDraftId === stage.draftId &&
      hasSectionErrors(errors.sections[section.draftId] ?? {}),
    )

    if (
      ((stageErrors && hasStageErrors(stageErrors)) ||
        hasRelatedSectionError) &&
      !seenEventDayIds.has(stage.eventDayId)
    ) {
      eventDayIds.push(stage.eventDayId)
      seenEventDayIds.add(stage.eventDayId)
    }
  }

  return eventDayIds
}

export const STAGE_DELETE_BLOCKED_MESSAGE =
  'このStageにはSection、タイムテーブル、または固定配置の設定があるため削除できません。関連する設定を先に解除してください。'

export const SECTION_DELETE_BLOCKED_MESSAGE =
  'このSectionにはタイムテーブルまたは固定配置の設定があるため削除できません。関連する設定を先に解除してください。'

export const FIRST_SECTION_ADD_BLOCKED_MESSAGE =
  'このStageにはすでにタイムテーブルが設定されています。Sectionを追加するには、先にタイムテーブルの配置を削除してください。'

export const canDeleteStage = (
  stageId: StageId,
  { sections, scheduleItems, eventBands }: StageReferences,
): boolean =>
  !sections.some((section) => section.stageId === stageId) &&
  !scheduleItems.some((scheduleItem) => scheduleItem.stageId === stageId) &&
  !eventBands.some((eventBand) =>
    eventBand.fixedPlacement?.stageId === stageId,
  )

export const canDeleteSection = (
  sectionId: SectionId,
  { scheduleItems, eventBands }: SectionReferences,
): boolean =>
  !scheduleItems.some((scheduleItem) =>
    scheduleItem.sectionId === sectionId,
  ) &&
  !eventBands.some((eventBand) =>
    eventBand.fixedPlacement?.sectionId === sectionId,
  )

export const canAddFirstSection = (
  stageId: StageId,
  sections: Pick<Section, 'stageId'>[],
  scheduleItems: Pick<ScheduleItem, 'stageId'>[],
): boolean =>
  sections.some((section) => section.stageId === stageId) ||
  !scheduleItems.some((scheduleItem) => scheduleItem.stageId === stageId)

export const createEventStageSettingsUpdate = ({
  event,
  eventDays,
  stages,
  sections,
  draft,
  newStageIds,
  newSectionIds,
  scheduleItems,
  eventBands,
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
  const currentStageIds = new Set(currentStages.map((stage) => stage.id))
  const currentSections = sections.filter((section) =>
    currentStageIds.has(section.stageId),
  )

  const retainedStageIds = new Set(
    draft.stages.flatMap((stage) => stage.stageId ? [stage.stageId] : []),
  )
  const blockedStageDeletion = currentStages.find((stage) =>
    !retainedStageIds.has(stage.id) &&
    !canDeleteStage(stage.id, { sections, scheduleItems, eventBands }),
  )

  if (blockedStageDeletion) {
    return {
      ok: false,
      errors: {
        stages: {},
        sections: {},
        form: STAGE_DELETE_BLOCKED_MESSAGE,
      },
    }
  }

  if (draft.stages.some((stage) => !eventDayOrder.has(stage.eventDayId))) {
    return {
      ok: false,
      errors: {
        stages: {},
        sections: {},
        form: '選択中のイベントに属さない開催日のStageは保存できません。',
      },
    }
  }

  const newStageCount = draft.stages.filter((stage) => !stage.stageId).length
  if (newStageIds.length !== newStageCount) {
    throw new Error('A Stage ID is required for every new Stage')
  }

  for (const stageDraft of draft.stages) {
    if (!stageDraft.stageId) continue

    const existingSectionCount = currentSections.filter(
      (section) => section.stageId === stageDraft.stageId,
    ).length
    const stageSectionDrafts = draft.sections.filter(
      (section) => section.stageDraftId === stageDraft.draftId,
    )

    if (
      existingSectionCount === 0 &&
      stageSectionDrafts.length > 0 &&
      !canAddFirstSection(stageDraft.stageId, currentSections, scheduleItems)
    ) {
      return {
        ok: false,
        errors: {
          stages: {},
          sections: {
            [stageSectionDrafts[0].draftId]: {
              form: FIRST_SECTION_ADD_BLOCKED_MESSAGE,
            },
          },
        },
      }
    }
  }

  const retainedSectionIds = new Set(
    draft.sections.flatMap((section) =>
      section.sectionId ? [section.sectionId] : [],
    ),
  )
  const blockedSectionDeletion = currentSections.find((section) =>
    !retainedSectionIds.has(section.id) &&
    !canDeleteSection(section.id, { scheduleItems, eventBands }),
  )

  if (blockedSectionDeletion) {
    return {
      ok: false,
      errors: {
        stages: {},
        sections: {},
        form: SECTION_DELETE_BLOCKED_MESSAGE,
      },
    }
  }

  const newSectionCount = draft.sections.filter(
    (section) => !section.sectionId,
  ).length
  if (newSectionIds.length !== newSectionCount) {
    throw new Error('A Section ID is required for every new Section')
  }

  let newStageIndex = 0
  const orderByEventDay = new Map<EventDayId, number>()
  const updatedStages: Stage[] = []
  const stageIdByDraftId = new Map<string, StageId>()

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
            sections: {},
            form: 'Stageの情報が更新されたため保存できません。画面を開き直してください。',
          },
        }
      }
      updatedStages.push({ ...existingStage, ...values })
      stageIdByDraftId.set(stageDraft.draftId, existingStage.id)
    } else {
      const stageId = newStageIds[newStageIndex++]
      updatedStages.push({ id: stageId, ...values })
      stageIdByDraftId.set(stageDraft.draftId, stageId)
    }
  }

  updatedStages.sort((first, second) =>
    (eventDayOrder.get(first.eventDayId) ?? 0) -
      (eventDayOrder.get(second.eventDayId) ?? 0) ||
    first.order - second.order ||
    first.id.localeCompare(second.id),
  )

  const currentSectionsById = new Map(
    currentSections.map((section) => [section.id, section]),
  )
  const orderByStage = new Map<StageId, number>()
  const updatedSections: Section[] = []
  let newSectionIndex = 0

  for (const sectionDraft of draft.sections) {
    const stageId = stageIdByDraftId.get(sectionDraft.stageDraftId)
    if (!stageId) {
      return {
        ok: false,
        errors: {
          stages: {},
          sections: {
            [sectionDraft.draftId]: {
              form: '対象Stageが見つかりません。画面を開き直してください。',
            },
          },
        },
      }
    }

    const order = orderByStage.get(stageId) ?? 0
    orderByStage.set(stageId, order + 1)
    const values = {
      stageId,
      name: sectionDraft.name.trim(),
      order,
      plannedStartTime: sectionDraft.startMode === 'fixed'
        ? sectionDraft.plannedStartTime
        : undefined,
      plannedEndTime: sectionDraft.endMode === 'fixed'
        ? sectionDraft.plannedEndTime
        : undefined,
    }

    if (sectionDraft.sectionId) {
      const existingSection = currentSectionsById.get(sectionDraft.sectionId)
      if (!existingSection || existingSection.stageId !== stageId) {
        return {
          ok: false,
          errors: {
            stages: {},
            sections: {
              [sectionDraft.draftId]: {
                form: 'Sectionの情報が更新されたため保存できません。画面を開き直してください。',
              },
            },
          },
        }
      }
      updatedSections.push({ ...existingSection, ...values })
    } else {
      updatedSections.push({
        id: newSectionIds[newSectionIndex++],
        ...values,
      })
    }
  }

  const updatedStageOrder = new Map(
    updatedStages.map((stage, index) => [stage.id, index]),
  )
  updatedSections.sort((first, second) =>
    (updatedStageOrder.get(first.stageId) ?? 0) -
      (updatedStageOrder.get(second.stageId) ?? 0) ||
    first.order - second.order ||
    first.id.localeCompare(second.id),
  )

  return {
    ok: true,
    event: {
      ...event,
      defaultTransitionMinutes: Number(draft.defaultTransitionMinutes),
      performanceSlotMinutes: normalizePerformanceSlotMinutes(
        draft.performanceSlotMinutes,
      ),
    },
    stages: updatedStages,
    sections: updatedSections,
  }
}
