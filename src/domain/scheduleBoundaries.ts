import type {
  EventDayId,
  ScheduleItemId,
  ScheduleBoundary,
  Section,
  SectionId,
  Stage,
  StageId,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import {
  isValidLocalTime,
  parseLocalTimeToMinute,
} from './timeline.ts'
import {
  isMinuteRangeWithinStageTimeRange,
  isSectionWithinStageTimeRange,
  isValidStageTimeRange,
} from './stageTimeRanges.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isNonEmptyId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const isValidScheduleBoundaryShape = (
  value: unknown,
): value is ScheduleBoundary => isRecord(value) && (
  (value.kind === 'schedule-item' && isNonEmptyId(value.scheduleItemId) &&
    (value.edge === 'start' || value.edge === 'end') &&
    !Object.hasOwn(value, 'sectionId') &&
    !Object.hasOwn(value, 'offsetMinutes') &&
    !Object.hasOwn(value, 'time')) ||
  (value.kind === 'section' && isNonEmptyId(value.sectionId) &&
    (value.edge === 'start' || value.edge === 'end') &&
    !Object.hasOwn(value, 'scheduleItemId') &&
    !Object.hasOwn(value, 'time') &&
    (value.offsetMinutes === undefined ||
      (typeof value.offsetMinutes === 'number' &&
        Number.isSafeInteger(value.offsetMinutes) && value.offsetMinutes >= 0))) ||
  (value.kind === 'time' && typeof value.time === 'string' &&
    isValidLocalTime(value.time) &&
    !Object.hasOwn(value, 'scheduleItemId') &&
    !Object.hasOwn(value, 'sectionId') &&
    !Object.hasOwn(value, 'edge') &&
    !Object.hasOwn(value, 'offsetMinutes'))
)

export interface ResolvedScheduleInterval {
  fromMinute: number
  untilMinute: number
}

export type ResolveScheduleIntervalResult =
  | { ok: true; interval: ResolvedScheduleInterval }
  | { ok: false; reason: string }

interface ScheduleBoundaryScope {
  eventDayId: EventDayId
  stageId: StageId
  from: ScheduleBoundary
  until: ScheduleBoundary
}

export interface ScheduleBoundaryResolutionContext {
  stages: Stage[]
  sections: Section[]
}

export interface EffectiveSectionInterval extends ResolvedScheduleInterval {
  section: Section
}

interface EffectiveSectionEdges {
  fromMinute?: number
  untilMinute?: number
}

export const isScheduleItemBoundary = (
  boundary: ScheduleBoundary,
): boundary is Extract<ScheduleBoundary, { kind: 'schedule-item' }> =>
  boundary.kind === 'schedule-item'

export const isSectionBoundary = (
  boundary: ScheduleBoundary,
): boundary is Extract<ScheduleBoundary, { kind: 'section' }> =>
  boundary.kind === 'section'

export const isTimeBoundary = (
  boundary: ScheduleBoundary,
): boundary is Extract<ScheduleBoundary, { kind: 'time' }> =>
  boundary.kind === 'time'

export const getScheduleItemIdFromBoundary = (
  boundary: ScheduleBoundary,
): ScheduleItemId | undefined => isScheduleItemBoundary(boundary)
  ? boundary.scheduleItemId
  : undefined

export const getReferencedScheduleItemIds = (
  boundaries: readonly ScheduleBoundary[],
): ScheduleItemId[] => [...new Set(boundaries.flatMap((boundary) => {
  const id = getScheduleItemIdFromBoundary(boundary)
  return id ? [id] : []
}))]

export const getSectionIdFromBoundary = (
  boundary: ScheduleBoundary,
): SectionId | undefined => isSectionBoundary(boundary)
  ? boundary.sectionId
  : undefined

export const getReferencedSectionIds = (
  boundaries: readonly ScheduleBoundary[],
): SectionId[] => [...new Set(boundaries.flatMap((boundary) => {
  const id = getSectionIdFromBoundary(boundary)
  return id ? [id] : []
}))]

const getSectionItems = (
  sectionId: SectionId,
  stageId: StageId,
  calculatedItems: CalculatedScheduleItem[],
): CalculatedScheduleItem[] => calculatedItems
  .filter((item) => item.sectionId === sectionId && item.stageId === stageId)

const getEffectiveSectionEdges = ({
  section,
  stage,
  calculatedItems,
}: {
  section: Section
  stage: Stage
  calculatedItems: CalculatedScheduleItem[]
}): EffectiveSectionEdges | { reason: string } => {
  if (section.stageId !== stage.id) {
    return { reason: 'Sectionは担当Stageに属していません。' }
  }
  if (!isSectionWithinStageTimeRange(stage, section)) {
    return { reason: 'Section時間は担当Stageの時間内にしてください。' }
  }

  const sectionItems = getSectionItems(section.id, stage.id, calculatedItems)
  const firstItem = sectionItems[0]
  const lastItem = sectionItems.at(-1)
  if (section.plannedStartTime && !isValidLocalTime(section.plannedStartTime)) {
    return { reason: 'Section開始時刻が正しくありません。' }
  }
  if (section.plannedEndTime && !isValidLocalTime(section.plannedEndTime)) {
    return { reason: 'Section終了時刻が正しくありません。' }
  }
  const fromMinute = section.plannedStartTime
    ? parseLocalTimeToMinute(section.plannedStartTime)
    : firstItem?.plannedStartMinute
  const untilMinute = section.plannedEndTime
    ? parseLocalTimeToMinute(section.plannedEndTime)
    : lastItem?.plannedEndMinute

  if (!isMinuteRangeWithinStageTimeRange(stage, fromMinute, untilMinute)) {
    return { reason: 'Sectionの有効時間は担当Stageの時間内にしてください。' }
  }

  return { fromMinute, untilMinute }
}

export const resolveEffectiveSectionInterval = (input: {
  section: Section
  stage: Stage
  sections: Section[]
  calculatedItems: CalculatedScheduleItem[]
}): ResolveScheduleIntervalResult => {
  const edges = getEffectiveSectionEdges({
    section: input.section,
    stage: input.stage,
    calculatedItems: input.calculatedItems,
  })
  if ('reason' in edges) return { ok: false, reason: edges.reason }
  if (edges.fromMinute === undefined) {
    return { ok: false, reason: 'Section開始時刻を解決できません。' }
  }
  if (edges.untilMinute === undefined) {
    return { ok: false, reason: 'Section終了時刻を解決できません。' }
  }
  if (edges.fromMinute >= edges.untilMinute) {
    return { ok: false, reason: 'Sectionの終了は開始より後である必要があります。' }
  }
  return {
    ok: true,
    interval: { fromMinute: edges.fromMinute, untilMinute: edges.untilMinute },
  }
}

const resolveBoundaryMinute = ({
  boundary,
  assignment,
  calculatedItems,
  context,
  edgeLabel,
  subjectLabel,
}: {
  boundary: ScheduleBoundary
  assignment: ScheduleBoundaryScope
  calculatedItems: CalculatedScheduleItem[]
  context?: ScheduleBoundaryResolutionContext
  edgeLabel: '開始' | '終了'
  subjectLabel: string
}): { ok: true; minute: number } | { ok: false; reason: string } => {
  if (!isValidScheduleBoundaryShape(boundary)) {
    return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}指定が正しくありません。` }
  }
  if (isScheduleItemBoundary(boundary)) {
    const item = calculatedItems.find((candidate) =>
      candidate.scheduleItemId === boundary.scheduleItemId,
    )
    if (!item) {
      return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}参照先が存在しません。` }
    }
    if (item.stageId !== assignment.stageId || item.eventDayId !== assignment.eventDayId) {
      return {
        ok: false,
        reason: `${subjectLabel}範囲の${edgeLabel}は同じ開催日・Stageから選択してください。`,
      }
    }
    return {
      ok: true,
      minute: boundary.edge === 'start'
        ? item.plannedStartMinute
        : item.plannedEndMinute,
    }
  }

  if (!context) {
    return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}を解決できません。` }
  }
  const stage = context.stages.find((candidate) => candidate.id === assignment.stageId)
  if (!stage || stage.eventDayId !== assignment.eventDayId) {
    return { ok: false, reason: `${subjectLabel}のStageまたは開催日が正しくありません。` }
  }
  if (!isValidStageTimeRange(stage.plannedStartTime, stage.plannedEndTime)) {
    return { ok: false, reason: `${subjectLabel}のStage時間が正しくありません。` }
  }

  if (isTimeBoundary(boundary)) {
    if (!isValidLocalTime(boundary.time)) {
      return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}時刻が正しくありません。` }
    }
    const minute = parseLocalTimeToMinute(boundary.time)
    const stageStartMinute = parseLocalTimeToMinute(stage.plannedStartTime)
    const stageEndMinute = stage.plannedEndTime
      ? parseLocalTimeToMinute(stage.plannedEndTime)
      : undefined
    if (minute < stageStartMinute || (stageEndMinute !== undefined && minute > stageEndMinute)) {
      return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}時刻はStage時間内にしてください。` }
    }
    return { ok: true, minute }
  }

  const section = context.sections.find((candidate) => candidate.id === boundary.sectionId)
  if (!section) {
    return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}Sectionが存在しません。` }
  }
  if (section.stageId !== stage.id) {
    return { ok: false, reason: `${subjectLabel}範囲の${edgeLabel}Sectionは同じStageから選択してください。` }
  }
  const offsetMinutes = boundary.offsetMinutes ?? 0
  if (!Number.isSafeInteger(offsetMinutes) || offsetMinutes < 0) {
    return { ok: false, reason: 'Sectionからの差分は0以上の整数で指定してください。' }
  }
  const sectionEdges = getEffectiveSectionEdges({
    section,
    stage,
    calculatedItems,
  })
  if ('reason' in sectionEdges) return { ok: false, reason: sectionEdges.reason }
  if (
    sectionEdges.fromMinute !== undefined &&
    sectionEdges.untilMinute !== undefined &&
    sectionEdges.fromMinute >= sectionEdges.untilMinute
  ) {
    return { ok: false, reason: 'Sectionの終了は開始より後である必要があります。' }
  }
  const effectiveEdge = boundary.edge === 'start'
    ? sectionEdges.fromMinute
    : sectionEdges.untilMinute
  if (effectiveEdge === undefined) {
    return {
      ok: false,
      reason: `Section${boundary.edge === 'start' ? '開始' : '終了'}時刻を解決できません。`,
    }
  }
  const oppositeEdge = boundary.edge === 'start'
    ? sectionEdges.untilMinute
    : sectionEdges.fromMinute
  const minute = boundary.edge === 'start'
    ? effectiveEdge + offsetMinutes
    : effectiveEdge - offsetMinutes
  if (
    oppositeEdge !== undefined && (
      boundary.edge === 'start' ? minute > oppositeEdge : minute < oppositeEdge
    )
  ) {
    return { ok: false, reason: 'Sectionからの差分がSection時間を超えています。' }
  }
  if (!isMinuteRangeWithinStageTimeRange(
    stage,
    boundary.edge === 'start' ? minute : undefined,
    boundary.edge === 'end' ? minute : undefined,
  )) {
    return { ok: false, reason: 'Sectionからの差分はStage時間内にしてください。' }
  }
  return { ok: true, minute }
}

export const intervalsOverlap = (
  first: ResolvedScheduleInterval,
  second: ResolvedScheduleInterval,
): boolean => first.fromMinute < second.untilMinute &&
  second.fromMinute < first.untilMinute

export const resolveScheduleBoundaryInterval = (
  assignment: ScheduleBoundaryScope,
  calculatedItems: CalculatedScheduleItem[],
  subjectLabel: string,
  context?: ScheduleBoundaryResolutionContext,
): ResolveScheduleIntervalResult => {
  if (!isRecord(assignment) || !isNonEmptyId(assignment.eventDayId) ||
    !isNonEmptyId(assignment.stageId) ||
    !isValidScheduleBoundaryShape(assignment.from) ||
    !isValidScheduleBoundaryShape(assignment.until)) {
    return { ok: false, reason: `${subjectLabel}範囲の指定が正しくありません。` }
  }
  const fromResolution = resolveBoundaryMinute({
    boundary: assignment.from,
    assignment,
    calculatedItems,
    context,
    edgeLabel: '開始',
    subjectLabel,
  })
  if (!fromResolution.ok) return fromResolution
  const untilResolution = resolveBoundaryMinute({
    boundary: assignment.until,
    assignment,
    calculatedItems,
    context,
    edgeLabel: '終了',
    subjectLabel,
  })
  if (!untilResolution.ok) return untilResolution

  const fromMinute = fromResolution.minute
  const untilMinute = untilResolution.minute
  if (fromMinute >= untilMinute) {
    return {
      ok: false,
      reason: fromMinute === untilMinute
        ? `${subjectLabel}範囲の開始と終了を同じ時刻にできません。`
        : `${subjectLabel}範囲の終了は開始より後にしてください。`,
    }
  }

  return { ok: true, interval: { fromMinute, untilMinute } }
}

export const describeScheduleBoundary = (
  boundary: unknown,
  {
    scheduleItemLabel,
    sectionLabel,
  }: {
    scheduleItemLabel: (scheduleItemId: ScheduleItemId) => string | undefined
    sectionLabel: (sectionId: SectionId) => string | undefined
  },
): string => {
  if (!isValidScheduleBoundaryShape(boundary)) return '範囲指定が正しくありません'
  if (isScheduleItemBoundary(boundary)) {
    return `${scheduleItemLabel(boundary.scheduleItemId) ?? '参照先なし'} ${boundary.edge === 'start' ? '開始' : '終了'}`
  }
  if (isTimeBoundary(boundary)) return boundary.time
  const offset = boundary.offsetMinutes ?? 0
  const edge = boundary.edge === 'start' ? '開始' : '終了'
  const suffix = offset === 0
    ? ''
    : boundary.edge === 'start' ? `後${offset}分` : `${offset}分前`
  return `${sectionLabel(boundary.sectionId) ?? '参照先なし'} ${edge}${suffix}`
}
