import type {
  Event,
  EventBand,
  EventBandId,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  FixedPlacement,
  FixedPosition,
  Member,
  Section,
  Stage,
  TimeRange,
} from './models'
import {
  getEventBandDayFeasibility,
  hasAvailabilityWindowForDuration,
  intersectAvailabilityWindows,
  type EventBandDayFeasibilityStatus,
} from './eventBandSettings.ts'
import {
  getTimeRangeValidationError,
  type EditableTimeRange,
} from './eventMemberDayDetails.ts'
import { isValidLocalTime } from './timeline.ts'

export type FixedPositionMode = 'none' | FixedPosition['kind']

export interface FixedPlacementDraft {
  stageId: string
  sectionId: string
  positionMode: FixedPositionMode
  positionIndex?: number
  plannedStartTime: string
}

export interface EventBandConditionItemDraft {
  eventBandId: EventBandId
  eventDayId: EventDayId
  availableTimeRange: EditableTimeRange
  preferredTimeRange: EditableTimeRange
  fixedPlacement: FixedPlacementDraft
}

export interface EventBandConditionsDraft {
  items: EventBandConditionItemDraft[]
}

export interface EventBandConditionItemErrors {
  availableTimeRange?: string
  preferredTimeRange?: string
  fixedPlacement?: string
  feasibility?: string
  form?: string
}

export interface EventBandConditionsValidationErrors {
  items: Record<string, EventBandConditionItemErrors>
  form?: string
}

export interface EventBandConditionFeasibility {
  status: EventBandDayFeasibilityStatus
  memberAvailabilityWindows?: TimeRange[]
  effectiveAvailabilityWindows?: TimeRange[]
  blockingReasons: string[]
  warnings: string[]
}

export interface EventBandConditionSummary {
  hard: string
  preference: string
  fixedPlacement: string
}

export type EventBandConditionsUpdateResult =
  | { ok: true; eventBands: EventBand[] }
  | { ok: false; errors: EventBandConditionsValidationErrors }

const emptyEditableTimeRange = (): EditableTimeRange => ({
  from: '',
  until: '',
})

const toEditableTimeRange = (
  range: TimeRange | undefined,
): EditableTimeRange => range
  ? { from: range.from ?? '', until: range.until ?? '' }
  : emptyEditableTimeRange()

const createOptionalTimeRange = (
  range: EditableTimeRange,
): TimeRange | undefined => {
  const from = range.from.trim()
  const until = range.until.trim()

  if (from && until) return { from, until }
  if (from) return { from }
  if (until) return { until }
  return undefined
}

const validateOptionalTimeRange = (
  range: EditableTimeRange,
): string | undefined => {
  if (!range.from.trim() && !range.until.trim()) return undefined
  return getTimeRangeValidationError(range)
}

const createFixedPlacementDraft = (
  fixedPlacement: FixedPlacement | undefined,
): FixedPlacementDraft => ({
  stageId: fixedPlacement?.stageId ?? '',
  sectionId: fixedPlacement?.sectionId ?? '',
  positionMode: fixedPlacement?.position?.kind ?? 'none',
  ...(fixedPlacement?.position?.kind === 'index'
    ? { positionIndex: fixedPlacement.position.index }
    : {}),
  plannedStartTime: fixedPlacement?.plannedStartTime ?? '',
})

const createFixedPosition = (
  draft: FixedPlacementDraft,
): FixedPosition | undefined => {
  if (draft.positionMode === 'first') return { kind: 'first' }
  if (draft.positionMode === 'last') return { kind: 'last' }
  if (draft.positionMode === 'index') {
    return { kind: 'index', index: draft.positionIndex ?? -1 }
  }
  return undefined
}

const createFixedPlacement = (
  draft: FixedPlacementDraft,
): FixedPlacement | undefined => {
  if (!draft.stageId) return undefined

  const position = createFixedPosition(draft)
  return {
    stageId: draft.stageId,
    ...(draft.sectionId ? { sectionId: draft.sectionId } : {}),
    ...(position ? { position } : {}),
    ...(draft.plannedStartTime.trim()
      ? { plannedStartTime: draft.plannedStartTime.trim() }
      : {}),
  }
}

export const createEventBandConditionsDraft = (
  event: Event,
  eventBands: EventBand[],
): EventBandConditionsDraft => ({
  items: eventBands
    .filter((eventBand) => eventBand.eventId === event.id)
    .map((eventBand) => ({
      eventBandId: eventBand.id,
      eventDayId: eventBand.eventDayId,
      availableTimeRange: toEditableTimeRange(eventBand.availableTimeRange),
      preferredTimeRange: toEditableTimeRange(eventBand.preferredTimeRange),
      fixedPlacement: createFixedPlacementDraft(eventBand.fixedPlacement),
    })),
})

const getFixedPlacementValidationError = ({
  item,
  stages,
  sections,
}: {
  item: EventBandConditionItemDraft
  stages: Stage[]
  sections: Section[]
}): string | undefined => {
  const placement = item.fixedPlacement
  const hasStage = Boolean(placement.stageId)
  const hasDependentSetting = Boolean(
    placement.sectionId ||
    placement.positionMode !== 'none' ||
    placement.plannedStartTime.trim(),
  )

  if (!hasStage) {
    return hasDependentSetting
      ? 'Section、出演位置、固定開始時刻を設定する場合はStageを選択してください。'
      : undefined
  }

  const stage = stages.find((candidate) => candidate.id === placement.stageId)
  if (!stage) return '選択したStageが見つかりません。'
  if (stage.eventDayId !== item.eventDayId) {
    return '出演日と同じ開催日のStageを選択してください。'
  }

  const stageSections = sections.filter((section) => section.stageId === stage.id)
  if (stageSections.length > 0 && !placement.sectionId) {
    return 'SectionがあるStageでは固定するSectionを選択してください。'
  }
  if (
    placement.sectionId &&
    !stageSections.some((section) => section.id === placement.sectionId)
  ) {
    return '選択したSectionは固定Stageに属していません。'
  }
  if (
    !['none', 'first', 'last', 'index'].includes(placement.positionMode)
  ) {
    return '出演位置が正しくありません。'
  }
  if (
    placement.positionMode === 'index' &&
    (!Number.isSafeInteger(placement.positionIndex) ||
      (placement.positionIndex ?? -1) < 0)
  ) {
    return '既存の出演位置が正しくありません。'
  }
  if (
    placement.plannedStartTime.trim() &&
    !isValidLocalTime(placement.plannedStartTime.trim())
  ) {
    return '固定開始時刻が正しくありません。'
  }

  return undefined
}

export const getEventBandConditionFeasibility = ({
  event,
  item,
  eventBand,
  members,
  eventMembers,
  eventMemberDays,
}: {
  event: Event
  item: EventBandConditionItemDraft
  eventBand: EventBand
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventBandConditionFeasibility => {
  const memberFeasibility = getEventBandDayFeasibility({
    event,
    eventDayId: eventBand.eventDayId,
    memberIds: eventBand.memberIds,
    durationMinutes: eventBand.durationMinutes,
    members,
    eventMembers,
    eventMemberDays,
  })
  const availableTimeRange = createOptionalTimeRange(item.availableTimeRange)
  const preferredTimeRange = createOptionalTimeRange(item.preferredTimeRange)
  const effectiveAvailabilityWindows = intersectAvailabilityWindows(
    memberFeasibility.commonAvailabilityWindows,
    availableTimeRange ? [availableTimeRange] : undefined,
  )
  const blockingReasons = [...memberFeasibility.blockingReasons]
  const warnings = [...memberFeasibility.warnings]

  if (
    blockingReasons.length === 0 &&
    !hasAvailabilityWindowForDuration(
      effectiveAvailabilityWindows,
      eventBand.durationMinutes,
    )
  ) {
    blockingReasons.push(
      `実際に配置可能な時間内に出演枠${eventBand.durationMinutes}分を確保できる時間帯がありません。`,
    )
  }

  if (preferredTimeRange) {
    const preferredWindows = intersectAvailabilityWindows(
      effectiveAvailabilityWindows,
      [preferredTimeRange],
    )
    if (
      !hasAvailabilityWindowForDuration(
        preferredWindows,
        eventBand.durationMinutes,
      )
    ) {
      warnings.push(
        `希望時間内に出演時間${eventBand.durationMinutes}分を確保できません。`,
      )
    }
  }

  return {
    status: blockingReasons.length > 0
      ? 'blocked'
      : warnings.length > 0
        ? 'warning'
        : 'available',
    ...(memberFeasibility.commonAvailabilityWindows !== undefined
      ? { memberAvailabilityWindows: memberFeasibility.commonAvailabilityWindows }
      : {}),
    ...(effectiveAvailabilityWindows !== undefined
      ? { effectiveAvailabilityWindows }
      : {}),
    blockingReasons,
    warnings,
  }
}

export const validateEventBandConditionItem = ({
  item,
  event,
  eventDays,
  eventBands,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
}: {
  item: EventBandConditionItemDraft
  event: Event
  eventDays: EventDay[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventBandConditionItemErrors => {
  const errors: EventBandConditionItemErrors = {}
  const eventBand = eventBands.find((candidate) =>
    candidate.id === item.eventBandId && candidate.eventId === event.id,
  )

  if (!eventBand) {
    errors.form = '編集する出演バンドが見つかりません。'
    return errors
  }
  if (
    eventBand.eventDayId !== item.eventDayId ||
    !eventDays.some((day) =>
      day.id === item.eventDayId && day.eventId === event.id,
    )
  ) {
    errors.form = '出演バンドの開催日が正しくありません。'
  }

  errors.availableTimeRange = validateOptionalTimeRange(
    item.availableTimeRange,
  )
  errors.preferredTimeRange = validateOptionalTimeRange(
    item.preferredTimeRange,
  )
  errors.fixedPlacement = getFixedPlacementValidationError({
    item,
    stages,
    sections,
  })

  if (!errors.availableTimeRange && !errors.preferredTimeRange) {
    const feasibility = getEventBandConditionFeasibility({
      event,
      item,
      eventBand,
      members,
      eventMembers,
      eventMemberDays,
    })
    if (feasibility.blockingReasons.length > 0) {
      errors.feasibility = feasibility.blockingReasons.join(' ')
    }
  }

  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => Boolean(message)),
  ) as EventBandConditionItemErrors
}

export const hasEventBandConditionItemErrors = (
  errors: EventBandConditionItemErrors,
): boolean => Object.values(errors).some(Boolean)

export const validateEventBandConditionsDraft = ({
  draft,
  event,
  eventDays,
  eventBands,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
}: {
  draft: EventBandConditionsDraft
  event: Event
  eventDays: EventDay[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): EventBandConditionsValidationErrors => {
  const errors: EventBandConditionsValidationErrors = { items: {} }
  const expectedIds = eventBands
    .filter((eventBand) => eventBand.eventId === event.id)
    .map((eventBand) => eventBand.id)
  const draftIds = draft.items.map((item) => item.eventBandId)

  if (
    new Set(draftIds).size !== draftIds.length ||
    expectedIds.length !== draftIds.length ||
    expectedIds.some((id) => !draftIds.includes(id))
  ) {
    errors.form = '出演条件の対象バンドが現在のイベントと一致しません。'
  }

  for (const item of draft.items) {
    const itemErrors = validateEventBandConditionItem({
      item,
      event,
      eventDays,
      eventBands,
      stages,
      sections,
      members,
      eventMembers,
      eventMemberDays,
    })
    if (hasEventBandConditionItemErrors(itemErrors)) {
      errors.items[item.eventBandId] = itemErrors
    }
  }

  return errors
}

export const hasEventBandConditionsErrors = (
  errors: EventBandConditionsValidationErrors,
): boolean => Boolean(errors.form) || Object.keys(errors.items).length > 0

export const createEventBandConditionsUpdate = ({
  event,
  eventDays,
  eventBands,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
  draft,
}: {
  event: Event
  eventDays: EventDay[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  draft: EventBandConditionsDraft
}): EventBandConditionsUpdateResult => {
  const errors = validateEventBandConditionsDraft({
    draft,
    event,
    eventDays,
    eventBands,
    stages,
    sections,
    members,
    eventMembers,
    eventMemberDays,
  })
  if (hasEventBandConditionsErrors(errors)) return { ok: false, errors }

  const draftById = new Map(
    draft.items.map((item) => [item.eventBandId, item]),
  )
  const updatedEventBands = eventBands.map((eventBand) => {
    if (eventBand.eventId !== event.id) return eventBand
    const item = draftById.get(eventBand.id)
    if (!item) return eventBand

    const availableTimeRange = createOptionalTimeRange(item.availableTimeRange)
    const preferredTimeRange = createOptionalTimeRange(item.preferredTimeRange)
    const fixedPlacement = createFixedPlacement(item.fixedPlacement)
    const updated: EventBand = { ...eventBand }

    if (availableTimeRange) updated.availableTimeRange = availableTimeRange
    else delete updated.availableTimeRange
    if (preferredTimeRange) updated.preferredTimeRange = preferredTimeRange
    else delete updated.preferredTimeRange
    if (fixedPlacement) updated.fixedPlacement = fixedPlacement
    else delete updated.fixedPlacement

    return updated
  })

  return { ok: true, eventBands: updatedEventBands }
}

export const formatConditionTimeRange = (
  range: TimeRange | undefined,
): string => {
  if (!range) return 'なし'
  if (range.from && range.until) return `${range.from}〜${range.until}`
  if (range.from) return `${range.from}以降`
  return `${range.until}まで`
}

export const getEventBandConditionSummary = (
  eventBand: EventBand,
  stages: Stage[],
  sections: Section[],
): EventBandConditionSummary => {
  const placement = eventBand.fixedPlacement
  if (!placement) {
    return {
      hard: formatConditionTimeRange(eventBand.availableTimeRange),
      preference: formatConditionTimeRange(eventBand.preferredTimeRange),
      fixedPlacement: 'なし',
    }
  }

  const stage = stages.find((candidate) => candidate.id === placement.stageId)
  const section = placement.sectionId
    ? sections.find((candidate) => candidate.id === placement.sectionId)
    : undefined
  const position = placement.position?.kind === 'first'
    ? '最初'
    : placement.position?.kind === 'last'
      ? '最後'
      : placement.position?.kind === 'index'
        ? `${placement.position.index + 1}番目`
        : undefined
  const fixedParts = [
    stage?.name ?? '不明なStage',
    section?.name,
    position,
    placement.plannedStartTime
      ? `${placement.plannedStartTime}開始`
      : undefined,
  ].filter(Boolean)

  return {
    hard: formatConditionTimeRange(eventBand.availableTimeRange),
    preference: formatConditionTimeRange(eventBand.preferredTimeRange),
    fixedPlacement: fixedParts.join(' / '),
  }
}

export const getEventBandConditionDraftSummary = (
  item: EventBandConditionItemDraft,
  eventBand: EventBand,
  stages: Stage[],
  sections: Section[],
): EventBandConditionSummary => {
  const updated: EventBand = { ...eventBand }
  const availableTimeRange = createOptionalTimeRange(item.availableTimeRange)
  const preferredTimeRange = createOptionalTimeRange(item.preferredTimeRange)
  const fixedPlacement = createFixedPlacement(item.fixedPlacement)

  if (availableTimeRange) updated.availableTimeRange = availableTimeRange
  else delete updated.availableTimeRange
  if (preferredTimeRange) updated.preferredTimeRange = preferredTimeRange
  else delete updated.preferredTimeRange
  if (fixedPlacement) updated.fixedPlacement = fixedPlacement
  else delete updated.fixedPlacement

  return getEventBandConditionSummary(updated, stages, sections)
}
