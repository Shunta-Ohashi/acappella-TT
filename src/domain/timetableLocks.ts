import type {
  EventBand,
  EventDay,
  EventId,
  FixedPosition,
  PerformanceScheduleItem,
  ScheduleItem,
  ScheduleItemId,
  Section,
  Stage,
  TimetableLock,
  TimetableLockId,
} from './models'
import {
  compareScheduleItemOrder,
  getScheduleLaneItems,
  reorderScheduleLaneItems,
  type ScheduleLane,
} from './schedule.ts'

export type TimetableLockMode = 'current' | 'first' | 'last'

export type TimetableLockViolationCode =
  | 'DUPLICATE_LOCK_TARGET'
  | 'SCHEDULE_ITEM_NOT_FOUND'
  | 'TARGET_NOT_PERFORMANCE'
  | 'EVENT_BAND_NOT_FOUND'
  | 'EVENT_MISMATCH'
  | 'EVENT_DAY_MISMATCH'
  | 'STAGE_NOT_FOUND'
  | 'SECTION_NOT_FOUND'
  | 'SECTION_STAGE_MISMATCH'
  | 'STAGE_MISMATCH'
  | 'SECTION_MISMATCH'
  | 'POSITION_MISMATCH'
  | 'LOCK_CONFLICT'
  | 'FIXED_PLACEMENT_CONFLICT'
  | 'INVALID_POSITION'

export interface TimetableLockViolation {
  code: TimetableLockViolationCode
  lockIds: TimetableLockId[]
  scheduleItemIds?: ScheduleItemId[]
  message: string
}

export interface TimetableLockEvaluation {
  valid: boolean
  violations: TimetableLockViolation[]
}

export interface EvaluateTimetableLocksInput {
  eventId: EventId
  timetableLocks: TimetableLock[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
}

export const isValidFixedPosition = (value: unknown): value is FixedPosition => {
  if (!value || typeof value !== 'object') return false
  const position = value as { kind?: unknown; index?: unknown }
  return position.kind === 'first' || position.kind === 'last' || (
    position.kind === 'index' &&
    typeof position.index === 'number' &&
    Number.isSafeInteger(position.index) &&
    position.index >= 0
  )
}

const sortLocks = (locks: TimetableLock[]): TimetableLock[] => [...locks].sort(
  (left, right) => left.id.localeCompare(right.id),
)

const laneKey = (stageId: string, sectionId?: string): string =>
  `${stageId}\u0000${sectionId ?? ''}`

const getLanePerformances = (
  scheduleItems: ScheduleItem[],
  stageId: string,
  sectionId?: string,
): PerformanceScheduleItem[] => scheduleItems
  .filter((item): item is PerformanceScheduleItem =>
    item.kind === 'performance' &&
    item.stageId === stageId &&
    item.sectionId === sectionId,
  )
  .sort(compareScheduleItemOrder)

const getPositionIndex = (
  position: FixedPosition,
  performanceCount: number,
): number => position.kind === 'first'
  ? 0
  : position.kind === 'last'
    ? performanceCount - 1
    : position.index

const reservesSamePosition = (
  fixed: FixedPosition,
  locked: FixedPosition,
): boolean => {
  if (fixed.kind === 'last' || locked.kind === 'last') {
    return fixed.kind === 'last' && locked.kind === 'last'
  }
  const fixedIndex = fixed.kind === 'first' ? 0 : fixed.index
  const lockedIndex = locked.kind === 'first' ? 0 : locked.index
  return fixedIndex === lockedIndex
}

const fixedPositionLabel = (position: FixedPosition): string =>
  position.kind === 'first'
    ? 'トッパー'
    : position.kind === 'last'
      ? 'トリ'
      : `${position.index + 1}番目`

export const getTimetableLockLabel = (lock: TimetableLock): string =>
  lock.position.kind === 'first'
    ? 'トッパー'
    : lock.position.kind === 'last'
      ? 'トリ'
      : `${lock.position.index + 1}番目固定`

export const evaluateTimetableLocks = ({
  eventId,
  timetableLocks,
  scheduleItems,
  eventBands,
  eventDays,
  stages,
  sections,
}: EvaluateTimetableLocksInput): TimetableLockEvaluation => {
  const locks = sortLocks(timetableLocks.filter((lock) => lock.eventId === eventId))
  const itemById = new Map(scheduleItems.map((item) => [item.id, item]))
  const bandById = new Map(eventBands.map((band) => [band.id, band]))
  const dayById = new Map(eventDays.map((day) => [day.id, day]))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const violations: TimetableLockViolation[] = []
  const fixedReservationsByLane = new Map<string, Array<{
    bandId: EventBand['id']
    position: FixedPosition
  }>>()
  for (const band of [...eventBands].sort((left, right) => left.id.localeCompare(right.id))) {
    const placement = band.fixedPlacement
    if (band.eventId !== eventId || !placement?.position ||
      !isValidFixedPosition(placement.position)) continue
    const stage = stageById.get(placement.stageId)
    const day = stage ? dayById.get(stage.eventDayId) : undefined
    if (!stage || day?.eventId !== eventId ||
      stage.eventDayId !== band.eventDayId) continue
    const stageSections = sections.filter((section) => section.stageId === stage.id)
    if (stageSections.length > 0) {
      if (!placement.sectionId ||
        sectionById.get(placement.sectionId)?.stageId !== stage.id) continue
    } else if (placement.sectionId !== undefined) {
      continue
    }
    const key = laneKey(stage.id, placement.sectionId)
    const reservations = fixedReservationsByLane.get(key) ?? []
    reservations.push({ bandId: band.id, position: placement.position })
    fixedReservationsByLane.set(key, reservations)
  }

  const locksByItem = new Map<ScheduleItemId, TimetableLock[]>()
  for (const lock of locks) {
    const targetLocks = locksByItem.get(lock.scheduleItemId) ?? []
    targetLocks.push(lock)
    locksByItem.set(lock.scheduleItemId, targetLocks)
  }
  for (const [scheduleItemId, targetLocks] of locksByItem) {
    if (targetLocks.length < 2) continue
    violations.push({
      code: 'DUPLICATE_LOCK_TARGET',
      lockIds: targetLocks.map((lock) => lock.id),
      scheduleItemIds: [scheduleItemId],
      message: '同じ出演項目に複数のTT固定が設定されています。',
    })
  }

  const conflictCandidates: Array<{
    lock: TimetableLock
    item: PerformanceScheduleItem
    slot: number
  }> = []

  for (const lock of locks) {
    const item = itemById.get(lock.scheduleItemId)
    if (!item) {
      violations.push({
        code: 'SCHEDULE_ITEM_NOT_FOUND', lockIds: [lock.id],
        scheduleItemIds: [lock.scheduleItemId],
        message: 'TT固定の対象項目が見つかりません。固定を解除してください。',
      })
      continue
    }
    if (item.kind !== 'performance') {
      violations.push({
        code: 'TARGET_NOT_PERFORMANCE', lockIds: [lock.id],
        scheduleItemIds: [item.id],
        message: '休憩にはTT固定を設定できません。',
      })
      continue
    }
    if (!isValidFixedPosition(lock.position)) {
      violations.push({
        code: 'INVALID_POSITION', lockIds: [lock.id], scheduleItemIds: [item.id],
        message: 'TT固定の並び順設定が不正です。',
      })
      continue
    }

    let hasResolvableLane = true
    const band = bandById.get(item.eventBandId)
    if (!band) {
      hasResolvableLane = false
      violations.push({
        code: 'EVENT_BAND_NOT_FOUND', lockIds: [lock.id],
        scheduleItemIds: [item.id],
        message: 'TT固定の対象となる出演バンドが見つかりません。',
      })
    } else if (band.eventId !== eventId || lock.eventId !== band.eventId) {
      hasResolvableLane = false
      violations.push({
        code: 'EVENT_MISMATCH', lockIds: [lock.id], scheduleItemIds: [item.id],
        message: 'TT固定と出演バンドのイベントが一致しません。',
      })
    }

    const lockedStage = stageById.get(lock.stageId)
    const lockedStageDay = lockedStage
      ? dayById.get(lockedStage.eventDayId)
      : undefined
    if (!lockedStage || lockedStageDay?.eventId !== eventId) {
      hasResolvableLane = false
      violations.push({
        code: 'STAGE_NOT_FOUND', lockIds: [lock.id], scheduleItemIds: [item.id],
        message: 'TT固定が参照するStageが見つかりません。',
      })
    } else if (band && band.eventId === eventId &&
      band.eventDayId !== lockedStage.eventDayId) {
      hasResolvableLane = false
      violations.push({
        code: 'EVENT_DAY_MISMATCH', lockIds: [lock.id],
        scheduleItemIds: [item.id],
        message: 'TT固定のStageと出演バンドの開催日が一致しません。',
      })
    }

    if (lock.sectionId !== undefined) {
      const lockedSection = sectionById.get(lock.sectionId)
      if (!lockedSection) {
        hasResolvableLane = false
        violations.push({
          code: 'SECTION_NOT_FOUND', lockIds: [lock.id], scheduleItemIds: [item.id],
          message: 'TT固定が参照するSectionが見つかりません。',
        })
      } else if (lockedSection.stageId !== lock.stageId) {
        hasResolvableLane = false
        violations.push({
          code: 'SECTION_STAGE_MISMATCH', lockIds: [lock.id],
          scheduleItemIds: [item.id],
          message: 'TT固定のSectionは別のStageに属しています。',
        })
      }
    } else if (
      lockedStage &&
      sections.some((section) => section.stageId === lockedStage.id)
    ) {
      hasResolvableLane = false
      violations.push({
        code: 'SECTION_MISMATCH', lockIds: [lock.id],
        scheduleItemIds: [item.id],
        message: 'Sectionを持つStageのTT固定にはSectionが必要です。',
      })
    }

    if (item.stageId !== lock.stageId) {
      hasResolvableLane = false
      violations.push({
        code: 'STAGE_MISMATCH', lockIds: [lock.id], scheduleItemIds: [item.id],
        message: 'TT固定された出演のStageが変更されています。',
      })
    }
    if (item.sectionId !== lock.sectionId) {
      hasResolvableLane = false
      violations.push({
        code: 'SECTION_MISMATCH', lockIds: [lock.id], scheduleItemIds: [item.id],
        message: 'TT固定された出演のSectionが変更されています。',
      })
    }

    const lanePerformances = getLanePerformances(
      scheduleItems,
      lock.stageId,
      lock.sectionId,
    )
    const actualIndex = lanePerformances.findIndex(
      (performance) => performance.id === item.id,
    )
    const expectedIndex = getPositionIndex(lock.position, lanePerformances.length)
    if (actualIndex !== expectedIndex) {
      violations.push({
        code: 'POSITION_MISMATCH', lockIds: [lock.id], scheduleItemIds: [item.id],
        message: `TT固定された出演は${fixedPositionLabel(lock.position)}に配置してください。`,
      })
    }
    if (hasResolvableLane && actualIndex >= 0 && expectedIndex >= 0) {
      conflictCandidates.push({ lock, item, slot: expectedIndex })
    }

    const fixedPlacement = band?.eventId === eventId
      ? band.fixedPlacement
      : undefined
    if (fixedPlacement) {
      let conflicts = fixedPlacement.stageId !== lock.stageId
      if (
        fixedPlacement.sectionId !== undefined &&
        fixedPlacement.sectionId !== lock.sectionId
      ) conflicts = true
      if (fixedPlacement.position) {
        const fixedIndex = getPositionIndex(
          fixedPlacement.position,
          lanePerformances.length,
        )
        if (fixedIndex !== expectedIndex) conflicts = true
      }
      if (conflicts) {
        violations.push({
          code: 'FIXED_PLACEMENT_CONFLICT', lockIds: [lock.id],
          scheduleItemIds: [item.id],
          message: 'TT固定がStep 5の必須配置条件と競合しています。',
        })
      }
    }

    if (hasResolvableLane && band?.eventId === eventId) {
      const reservations = fixedReservationsByLane.get(
        laneKey(lock.stageId, lock.sectionId),
      ) ?? []
      if (reservations.some((reservation) =>
        reservation.bandId !== band.id &&
        reservesSamePosition(reservation.position, lock.position)
      )) {
        violations.push({
          code: 'FIXED_PLACEMENT_CONFLICT', lockIds: [lock.id],
          scheduleItemIds: [item.id],
          message: 'TT固定が別バンドのStep 5必須位置と競合しています。',
        })
      }
    }
  }

  const slotGroups = new Map<string, typeof conflictCandidates>()
  for (const candidate of conflictCandidates) {
    const key = `${laneKey(candidate.lock.stageId, candidate.lock.sectionId)}\u0000${candidate.slot}`
    const group = slotGroups.get(key) ?? []
    group.push(candidate)
    slotGroups.set(key, group)
  }
  for (const group of slotGroups.values()) {
    const scheduleItemIds = [...new Set(group.map(({ item }) => item.id))].sort()
    if (scheduleItemIds.length < 2) continue
    violations.push({
      code: 'LOCK_CONFLICT',
      lockIds: group.map(({ lock }) => lock.id).sort(),
      scheduleItemIds,
      message: '同じPerformance位置に複数のTT固定が設定されています。',
    })
  }

  violations.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    left.lockIds.join('\u0000').localeCompare(right.lockIds.join('\u0000')) ||
    (left.scheduleItemIds ?? []).join('\u0000')
      .localeCompare((right.scheduleItemIds ?? []).join('\u0000')),
  )
  return { valid: violations.length === 0, violations }
}

const getItemLane = (item: PerformanceScheduleItem): ScheduleLane => ({
  stageId: item.stageId,
  ...(item.sectionId ? { sectionId: item.sectionId } : {}),
})

const movePerformanceToEdge = (
  scheduleItems: ScheduleItem[],
  item: PerformanceScheduleItem,
  edge: 'first' | 'last',
): ScheduleItem[] => {
  const lane = getItemLane(item)
  const laneItems = getScheduleLaneItems(scheduleItems, lane)
  const sourceIndex = laneItems.findIndex((candidate) => candidate.id === item.id)
  if (sourceIndex < 0) return scheduleItems

  const withoutTarget = laneItems.filter((candidate) => candidate.id !== item.id)
  const performanceIndexes = withoutTarget.flatMap((candidate, index) =>
    candidate.kind === 'performance' ? [index] : [],
  )
  const destinationIndex = edge === 'first'
    ? performanceIndexes[0] ?? withoutTarget.length
    : performanceIndexes.length > 0
      ? performanceIndexes[performanceIndexes.length - 1] + 1
      : withoutTarget.length
  return reorderScheduleLaneItems(
    scheduleItems,
    lane,
    sourceIndex,
    destinationIndex,
  )
}

export type ApplyTimetableLockResult =
  | {
      ok: true
      scheduleItems: ScheduleItem[]
      timetableLocks: TimetableLock[]
    }
  | { ok: false; violations: TimetableLockViolation[] }

export const applyTimetableLock = ({
  lockId,
  eventId,
  scheduleItemId,
  mode,
  timetableLocks,
  scheduleItems,
  eventBands,
  eventDays,
  stages,
  sections,
}: EvaluateTimetableLocksInput & {
  lockId: TimetableLockId
  scheduleItemId: ScheduleItemId
  mode: TimetableLockMode
}): ApplyTimetableLockResult => {
  const item = scheduleItems.find((candidate) => candidate.id === scheduleItemId)
  if (!item || item.kind !== 'performance') {
    return {
      ok: false,
      violations: [{
        code: item ? 'TARGET_NOT_PERFORMANCE' : 'SCHEDULE_ITEM_NOT_FOUND',
        lockIds: [lockId], scheduleItemIds: [scheduleItemId],
        message: item ? '休憩にはTT固定を設定できません。' : '固定対象が見つかりません。',
      }],
    }
  }
  const existingLocks = timetableLocks.filter(
    (lock) => lock.eventId === eventId && lock.scheduleItemId === scheduleItemId,
  )
  if (existingLocks.length > 1) {
    return {
      ok: false,
      violations: [{
        code: 'DUPLICATE_LOCK_TARGET',
        lockIds: existingLocks.map((lock) => lock.id).sort(),
        scheduleItemIds: [scheduleItemId],
        message: '重複したTT固定を先に解除してください。',
      }],
    }
  }

  const candidateItems = mode === 'current'
    ? scheduleItems
    : movePerformanceToEdge(scheduleItems, item, mode)
  const movedItem = candidateItems.find(
    (candidate): candidate is PerformanceScheduleItem =>
      candidate.id === scheduleItemId && candidate.kind === 'performance',
  )
  if (!movedItem) {
    return { ok: false, violations: [] }
  }
  const lanePerformances = getLanePerformances(
    candidateItems,
    movedItem.stageId,
    movedItem.sectionId,
  )
  const index = lanePerformances.findIndex((candidate) => candidate.id === movedItem.id)
  const position: FixedPosition = mode === 'first'
    ? { kind: 'first' }
    : mode === 'last'
      ? { kind: 'last' }
      : { kind: 'index', index }
  const lock: TimetableLock = {
    id: existingLocks[0]?.id ?? lockId,
    eventId,
    scheduleItemId,
    stageId: movedItem.stageId,
    ...(movedItem.sectionId ? { sectionId: movedItem.sectionId } : {}),
    position,
  }
  const candidateLocks = [
    ...timetableLocks.filter((candidate) =>
      candidate.eventId !== eventId || candidate.scheduleItemId !== scheduleItemId),
    lock,
  ]
  const evaluation = evaluateTimetableLocks({
    eventId,
    timetableLocks: candidateLocks,
    scheduleItems: candidateItems,
    eventBands,
    eventDays,
    stages,
    sections,
  })
  return evaluation.valid
    ? { ok: true, scheduleItems: candidateItems, timetableLocks: candidateLocks }
    : { ok: false, violations: evaluation.violations }
}

export const removeTimetableLock = (
  timetableLocks: TimetableLock[],
  lockId: TimetableLockId,
): TimetableLock[] => timetableLocks.filter((lock) => lock.id !== lockId)

export const removeTimetableLocksForEvent = (
  timetableLocks: TimetableLock[],
  eventId: EventId,
): TimetableLock[] => timetableLocks.filter((lock) => lock.eventId !== eventId)
