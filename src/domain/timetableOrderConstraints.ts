import type {
  EventBand,
  EventBandId,
  EventDay,
  FixedPlacement,
  ScheduleItem,
  Section,
  Stage,
  TimetableOrderConstraint,
  TimetableOrderConstraintId,
} from './models'
import { compareScheduleItemOrder } from './schedule.ts'

export type TimetableOrderConstraintViolationCode =
  | 'INVALID_CONSTRAINT'
  | 'DUPLICATE_CONSTRAINT_ID'
  | 'EVENT_MISMATCH'
  | 'EVENT_DAY_NOT_FOUND'
  | 'EVENT_DAY_EVENT_MISMATCH'
  | 'STAGE_NOT_FOUND'
  | 'STAGE_DAY_MISMATCH'
  | 'SECTION_REQUIRED'
  | 'SECTION_NOT_ALLOWED'
  | 'SECTION_NOT_FOUND'
  | 'SECTION_STAGE_MISMATCH'
  | 'EVENT_BAND_NOT_FOUND'
  | 'EVENT_BAND_EVENT_MISMATCH'
  | 'EVENT_BAND_DAY_MISMATCH'
  | 'DUPLICATE_EVENT_BAND'
  | 'EVENT_BAND_LANE_CONFLICT'
  | 'FIXED_PLACEMENT_CONFLICT'
  | 'ORDER_BLOCK_CONFLICT'
  | 'ORDER_CYCLE'

export interface TimetableOrderConstraintViolation {
  code: TimetableOrderConstraintViolationCode
  constraintIds: TimetableOrderConstraintId[]
  eventBandIds: EventBandId[]
  message: string
}

export interface TimetableOrderConstraintEvaluation {
  valid: boolean
  violations: TimetableOrderConstraintViolation[]
}

export type ScheduledTimetableOrderConstraintViolationCode =
  | 'MISSING_EVENT_BAND'
  | 'DUPLICATE_EVENT_BAND'
  | 'LANE_MISMATCH'
  | 'BLOCK_MISMATCH'

export interface ScheduledTimetableOrderConstraintViolation {
  code: ScheduledTimetableOrderConstraintViolationCode
  constraintId: TimetableOrderConstraintId
  eventBandIds: EventBandId[]
}

export interface ScheduledTimetableOrderConstraintEvaluation {
  valid: boolean
  violations: ScheduledTimetableOrderConstraintViolation[]
}

export interface EvaluateTimetableOrderConstraintsInput {
  eventId: string
  timetableOrderConstraints: TimetableOrderConstraint[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const hasTimetableOrderConstraintShape = (
  value: unknown,
): value is TimetableOrderConstraint =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.eventId) &&
  isNonEmptyString(value.eventDayId) &&
  isNonEmptyString(value.stageId) &&
  (value.sectionId === undefined || isNonEmptyString(value.sectionId)) &&
  Array.isArray(value.eventBandIds) &&
  Array.from(value.eventBandIds).every(isNonEmptyString)

/** Runtime guard for a self-contained constraint; ownership is evaluated separately. */
export const isTimetableOrderConstraint = (
  value: unknown,
): value is TimetableOrderConstraint =>
  hasTimetableOrderConstraintShape(value) &&
  value.eventBandIds.length >= 2 &&
  new Set(value.eventBandIds).size === value.eventBandIds.length

export const hasValidTimetableOrderConstraintCollection = (
  value: unknown,
): value is TimetableOrderConstraint[] =>
  Array.isArray(value) && Array.from(value).every(isTimetableOrderConstraint)

interface TimetableOrderConstraintTarget {
  eventDayId: string
  stageIds: ReadonlySet<string>
  eventBandIds: ReadonlySet<string>
}

interface TimetableOrderConstraintScopeReferences {
  eventDayId?: unknown
  stageId?: unknown
  eventBandIds?: unknown
}

const touchesTimetableOrderConstraintTarget = (
  value: TimetableOrderConstraintScopeReferences,
  target: TimetableOrderConstraintTarget,
): boolean =>
  value.eventDayId === target.eventDayId ||
  (typeof value.stageId === 'string' && target.stageIds.has(value.stageId)) ||
  (Array.isArray(value.eventBandIds) && Array.from(value.eventBandIds)
    .some(eventBandId => typeof eventBandId === 'string' && target.eventBandIds.has(eventBandId)))

export type ScopedTimetableOrderConstraints =
  | { ok: true; constraints: TimetableOrderConstraint[] }
  | { ok: false }

/**
 * Scope unknown runtime input before full validation. Entries whose ownership
 * references cannot be inspected safely remain fail-closed; only clearly
 * unrelated entries may be ignored by a single-day operation.
 */
export const scopeTimetableOrderConstraintsForTarget = ({
  timetableOrderConstraints,
  eventDayId,
  stageIds,
  eventBandIds,
}: {
  timetableOrderConstraints: unknown
  eventDayId: string
  stageIds: ReadonlySet<string>
  eventBandIds: ReadonlySet<string>
}): ScopedTimetableOrderConstraints => {
  if (!Array.isArray(timetableOrderConstraints)) return { ok: false }
  const constraints: TimetableOrderConstraint[] = []
  const target = { eventDayId, stageIds, eventBandIds }
  for (const value of Array.from(timetableOrderConstraints)) {
    if (!isRecord(value) || !isNonEmptyString(value.eventDayId) ||
      !isNonEmptyString(value.stageId) || !Array.isArray(value.eventBandIds) ||
      !Array.from(value.eventBandIds).every(isNonEmptyString)) return { ok: false }
    if (!touchesTimetableOrderConstraintTarget(value, target)) continue
    if (!isTimetableOrderConstraint(value)) return { ok: false }
    constraints.push(value)
  }
  return { ok: true, constraints }
}

/** Include constraints that touch the generated day, lane, or any target band. */
export const getTargetTimetableOrderConstraints = ({
  timetableOrderConstraints,
  eventDayId,
  stageIds,
  eventBandIds,
}: {
  timetableOrderConstraints: TimetableOrderConstraint[]
  eventDayId: string
  stageIds: ReadonlySet<string>
  eventBandIds: ReadonlySet<string>
}): TimetableOrderConstraint[] => {
  const target = { eventDayId, stageIds, eventBandIds }
  return timetableOrderConstraints.filter(constraint => touchesTimetableOrderConstraintTarget(
    constraint, target,
  ))
}

export const doesFixedPlacementConflictWithOrderConstraint = (
  fixedPlacement: Pick<FixedPlacement, 'stageId' | 'sectionId'> | undefined,
  constraint: Pick<TimetableOrderConstraint, 'stageId' | 'sectionId'>,
): boolean => Boolean(
  fixedPlacement && (
    fixedPlacement.stageId !== constraint.stageId ||
    (fixedPlacement.sectionId !== undefined &&
      fixedPlacement.sectionId !== constraint.sectionId)
  ),
)

const uniqueSorted = <T extends string>(values: T[]): T[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right))

const sortViolations = (
  violations: TimetableOrderConstraintViolation[],
): TimetableOrderConstraintViolation[] => violations.sort((left, right) =>
  left.code.localeCompare(right.code) ||
  left.constraintIds.join('\u0000').localeCompare(right.constraintIds.join('\u0000')) ||
  left.eventBandIds.join('\u0000').localeCompare(right.eventBandIds.join('\u0000')) ||
  left.message.localeCompare(right.message))

const laneKey = (constraint: TimetableOrderConstraint): string =>
  `${constraint.eventDayId}\u0000${constraint.stageId}\u0000${constraint.sectionId ?? ''}`

interface ValidConstraint {
  constraint: TimetableOrderConstraint
}

export interface MergedTimetableOrderConstraintBlock {
  eventDayId: string
  stageId: string
  sectionId?: string
  eventBandIds: EventBandId[]
}

interface BlockLink {
  bandId: EventBandId
  constraintIds: Set<TimetableOrderConstraintId>
}

const analyzeConstraintBlocks = (
  constraints: TimetableOrderConstraint[],
): {
  blocks: MergedTimetableOrderConstraintBlock[]
  violations: TimetableOrderConstraintViolation[]
} => {
  const blocks: MergedTimetableOrderConstraintBlock[] = []
  const violations: TimetableOrderConstraintViolation[] = []
  const byLane = new Map<string, TimetableOrderConstraint[]>()
  for (const constraint of constraints) {
    const key = laneKey(constraint)
    byLane.set(key, [...(byLane.get(key) ?? []), constraint])
  }

  for (const laneConstraints of [...byLane.values()].sort((left, right) =>
    laneKey(left[0]).localeCompare(laneKey(right[0])))) {
    const successor = new Map<EventBandId, BlockLink>()
    const predecessor = new Map<EventBandId, BlockLink>()
    const nodes = new Set<EventBandId>()
    for (const constraint of laneConstraints) {
      constraint.eventBandIds.forEach(id => nodes.add(id))
      for (let index = 0; index < constraint.eventBandIds.length - 1; index += 1) {
        const from = constraint.eventBandIds[index]
        const to = constraint.eventBandIds[index + 1]
        const existingSuccessor = successor.get(from)
        const existingPredecessor = predecessor.get(to)
        if (existingSuccessor && existingSuccessor.bandId !== to) {
          violations.push({
            code: 'ORDER_BLOCK_CONFLICT',
            constraintIds: uniqueSorted([...existingSuccessor.constraintIds, constraint.id]),
            eventBandIds: uniqueSorted([from, existingSuccessor.bandId, to]),
            message: '同じ出演バンドの直後に異なるバンドを指定できません。',
          })
        }
        if (existingPredecessor && existingPredecessor.bandId !== from) {
          violations.push({
            code: 'ORDER_BLOCK_CONFLICT',
            constraintIds: uniqueSorted([...existingPredecessor.constraintIds, constraint.id]),
            eventBandIds: uniqueSorted([existingPredecessor.bandId, from, to]),
            message: '同じ出演バンドの直前に異なるバンドを指定できません。',
          })
        }
        if (!existingSuccessor || existingSuccessor.bandId === to) {
          const constraintIds = existingSuccessor?.constraintIds ?? new Set()
          constraintIds.add(constraint.id)
          successor.set(from, { bandId: to, constraintIds })
        }
        if (!existingPredecessor || existingPredecessor.bandId === from) {
          const constraintIds = existingPredecessor?.constraintIds ?? new Set()
          constraintIds.add(constraint.id)
          predecessor.set(to, { bandId: from, constraintIds })
        }
      }
    }

    const cycleKeys = new Set<string>()
    for (const start of uniqueSorted([...nodes])) {
      const path: EventBandId[] = []
      const indexByBand = new Map<EventBandId, number>()
      let current: EventBandId | undefined = start
      while (current !== undefined && !indexByBand.has(current)) {
        indexByBand.set(current, path.length)
        path.push(current)
        current = successor.get(current)?.bandId
      }
      if (current === undefined || !indexByBand.has(current)) continue
      const cycle = path.slice(indexByBand.get(current)).sort()
      const key = cycle.join('\u0000')
      if (cycleKeys.has(key)) continue
      cycleKeys.add(key)
      const cycleSet = new Set(cycle)
      violations.push({
        code: 'ORDER_CYCLE',
        constraintIds: uniqueSorted(cycle.flatMap(from => {
          const link = successor.get(from)
          return link && cycleSet.has(link.bandId) ? [...link.constraintIds] : []
        })),
        eventBandIds: cycle,
        message: '出演順制約が循環しています。',
      })
    }

    if (violations.some(violation => violation.constraintIds.some(id =>
      laneConstraints.some(constraint => constraint.id === id)))) continue
    const first = laneConstraints[0]
    for (const start of uniqueSorted([...nodes].filter(id => !predecessor.has(id)))) {
      const eventBandIds: EventBandId[] = []
      let current: EventBandId | undefined = start
      while (current !== undefined) {
        eventBandIds.push(current)
        current = successor.get(current)?.bandId
      }
      blocks.push({
        eventDayId: first.eventDayId,
        stageId: first.stageId,
        ...(first.sectionId !== undefined ? { sectionId: first.sectionId } : {}),
        eventBandIds,
      })
    }
  }
  return { blocks, violations: sortViolations(violations) }
}

/** Merge compatible ordered fragments into maximal contiguous Performance blocks. */
export const mergeTimetableOrderConstraintBlocks = (
  constraints: TimetableOrderConstraint[],
): { valid: boolean; blocks: MergedTimetableOrderConstraintBlock[] } => {
  const result = analyzeConstraintBlocks(constraints)
  return { valid: result.violations.length === 0, blocks: result.blocks }
}

export const evaluateTimetableOrderConstraints = ({
  eventId,
  timetableOrderConstraints,
  eventDays,
  stages,
  sections,
  eventBands,
}: EvaluateTimetableOrderConstraintsInput): TimetableOrderConstraintEvaluation => {
  const violations: TimetableOrderConstraintViolation[] = []
  if (!Array.isArray(timetableOrderConstraints)) {
    return {
      valid: false,
      violations: [{
        code: 'INVALID_CONSTRAINT',
        constraintIds: [],
        eventBandIds: [],
        message: '出演順制約の形式が不正です。',
      }],
    }
  }

  const dayById = new Map(eventDays.map((day) => [day.id, day]))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const bandById = new Map(eventBands.map((band) => [band.id, band]))
  const sectionCountByStage = new Map<string, number>()
  for (const section of sections) {
    sectionCountByStage.set(
      section.stageId,
      (sectionCountByStage.get(section.stageId) ?? 0) + 1,
    )
  }

  const constraintIdCounts = new Map<string, number>()
  for (const candidate of timetableOrderConstraints as unknown[]) {
    if (isRecord(candidate) && isNonEmptyString(candidate.id)) {
      constraintIdCounts.set(candidate.id, (constraintIdCounts.get(candidate.id) ?? 0) + 1)
    }
  }
  for (const [constraintId, count] of [...constraintIdCounts].sort()) {
    if (count > 1) violations.push({
      code: 'DUPLICATE_CONSTRAINT_ID',
      constraintIds: [constraintId],
      eventBandIds: [],
      message: '同じ出演順制約IDが重複しています。',
    })
  }

  const validConstraints: ValidConstraint[] = []
  const orderedCandidates = [...(timetableOrderConstraints as unknown[])]
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftId = isRecord(left.candidate) && typeof left.candidate.id === 'string'
        ? left.candidate.id : ''
      const rightId = isRecord(right.candidate) && typeof right.candidate.id === 'string'
        ? right.candidate.id : ''
      return leftId.localeCompare(rightId) || left.index - right.index
    })

  for (const { candidate } of orderedCandidates) {
    if (!hasTimetableOrderConstraintShape(candidate)) {
      violations.push({
        code: 'INVALID_CONSTRAINT',
        constraintIds: isRecord(candidate) && isNonEmptyString(candidate.id)
          ? [candidate.id] : [],
        eventBandIds: [],
        message: '出演順制約の形式が不正です。',
      })
      continue
    }
    const constraint = candidate
    const constraintIds = [constraint.id]
    let valid = true
    const add = (
      code: TimetableOrderConstraintViolationCode,
      message: string,
      relatedBandIds: EventBandId[] = [],
    ) => {
      valid = false
      violations.push({
        code,
        constraintIds,
        eventBandIds: uniqueSorted(relatedBandIds),
        message,
      })
    }

    if ((constraintIdCounts.get(constraint.id) ?? 0) > 1) valid = false
    if (constraint.eventBandIds.length < 2) {
      add('INVALID_CONSTRAINT', '出演順制約には2組以上の出演バンドが必要です。')
    }
    if (new Set(constraint.eventBandIds).size !== constraint.eventBandIds.length) {
      add('DUPLICATE_EVENT_BAND', '同じ出演バンドを1つの出演順制約へ重複して指定できません。',
        constraint.eventBandIds)
    }
    if (constraint.eventId !== eventId) {
      add('EVENT_MISMATCH', '評価対象と異なるイベントの出演順制約です。')
    }
    const day = dayById.get(constraint.eventDayId)
    if (!day) add('EVENT_DAY_NOT_FOUND', '出演順制約の開催日が見つかりません。')
    else if (day.eventId !== constraint.eventId) {
      add('EVENT_DAY_EVENT_MISMATCH', '出演順制約の開催日がイベントに属していません。')
    }
    const stage = stageById.get(constraint.stageId)
    if (!stage) add('STAGE_NOT_FOUND', '出演順制約のStageが見つかりません。')
    else if (stage.eventDayId !== constraint.eventDayId) {
      add('STAGE_DAY_MISMATCH', '出演順制約のStageが開催日に属していません。')
    }

    const stageHasSections = (sectionCountByStage.get(constraint.stageId) ?? 0) > 0
    if (stageHasSections && constraint.sectionId === undefined) {
      add('SECTION_REQUIRED', 'Sectionを持つStageでは出演順制約のSection指定が必要です。')
    } else if (!stageHasSections && constraint.sectionId !== undefined) {
      add('SECTION_NOT_ALLOWED', 'SectionのないStageにはSectionを指定できません。')
    }
    if (constraint.sectionId !== undefined) {
      const section = sectionById.get(constraint.sectionId)
      if (!section) add('SECTION_NOT_FOUND', '出演順制約のSectionが見つかりません。')
      else if (section.stageId !== constraint.stageId) {
        add('SECTION_STAGE_MISMATCH', '出演順制約のSectionがStageに属していません。')
      }
    }

    for (const bandId of uniqueSorted(constraint.eventBandIds)) {
      const band = bandById.get(bandId)
      if (!band) {
        add('EVENT_BAND_NOT_FOUND', '出演順制約の出演バンドが見つかりません。', [bandId])
        continue
      }
      if (band.eventId !== constraint.eventId) {
        add('EVENT_BAND_EVENT_MISMATCH', '出演バンドが出演順制約のイベントに属していません。', [band.id])
      }
      if (band.eventDayId !== constraint.eventDayId) {
        add('EVENT_BAND_DAY_MISMATCH', '出演バンドが出演順制約の開催日に属していません。', [band.id])
      }
      if (doesFixedPlacementConflictWithOrderConstraint(
        band.fixedPlacement,
        constraint,
      )) {
        add('FIXED_PLACEMENT_CONFLICT', '出演バンドの固定配置と出演順制約のlaneが一致しません。', [band.id])
      }
    }
    if (valid) validConstraints.push({ constraint })
  }

  const laneByBand = new Map<EventBandId, { lane: string; constraintIds: string[] }>()
  const laneConflictConstraintIds = new Set<string>()
  for (const { constraint } of validConstraints) {
    const lane = laneKey(constraint)
    for (const bandId of constraint.eventBandIds) {
      const previous = laneByBand.get(bandId)
      if (!previous) {
        laneByBand.set(bandId, { lane, constraintIds: [constraint.id] })
      } else if (previous.lane === lane) {
        previous.constraintIds.push(constraint.id)
      } else {
        const constraintIds = uniqueSorted([...previous.constraintIds, constraint.id])
        constraintIds.forEach((id) => laneConflictConstraintIds.add(id))
        violations.push({
          code: 'EVENT_BAND_LANE_CONFLICT',
          constraintIds,
          eventBandIds: [bandId],
          message: '同じ出演バンドを異なるlaneの出演順制約へ指定できません。',
        })
      }
    }
  }

  violations.push(...analyzeConstraintBlocks(validConstraints
    .filter(({ constraint }) => !laneConflictConstraintIds.has(constraint.id))
    .map(({ constraint }) => constraint)).violations)
  const sorted = sortViolations(violations)
  return { valid: sorted.length === 0, violations: sorted }
}

/**
 * Validate the concrete Performance placements for already-semantic-checked
 * order constraints. Breaks are intentionally excluded from Performance adjacency.
 */
export const evaluateScheduledTimetableOrderConstraints = ({
  timetableOrderConstraints,
  scheduleItems,
}: {
  timetableOrderConstraints: TimetableOrderConstraint[]
  scheduleItems: ScheduleItem[]
}): ScheduledTimetableOrderConstraintEvaluation => {
  const performances = scheduleItems.filter((item): item is Extract<ScheduleItem, { kind: 'performance' }> =>
    item.kind === 'performance')
  const performancesByBand = new Map<EventBandId, typeof performances>()
  for (const item of performances) {
    performancesByBand.set(item.eventBandId, [
      ...(performancesByBand.get(item.eventBandId) ?? []), item,
    ])
  }
  const lanePositions = new Map<string, Map<EventBandId, number>>()
  for (const item of performances) {
    const key = `${item.stageId}\u0000${item.sectionId ?? ''}`
    if (lanePositions.has(key)) continue
    const positions = new Map<EventBandId, number>()
    performances.filter(candidate => candidate.stageId === item.stageId &&
      candidate.sectionId === item.sectionId)
      .sort(compareScheduleItemOrder)
      .forEach((candidate, index) => positions.set(candidate.eventBandId, index))
    lanePositions.set(key, positions)
  }

  const violations: ScheduledTimetableOrderConstraintViolation[] = []
  const orderedConstraints = [...timetableOrderConstraints]
    .sort((left, right) => left.id.localeCompare(right.id))
  for (const constraint of orderedConstraints) {
    const constraintItems = constraint.eventBandIds.map(eventBandId =>
      performancesByBand.get(eventBandId) ?? [])
    const missing = constraint.eventBandIds.filter((_, index) => constraintItems[index].length === 0)
    if (missing.length) violations.push({
      code: 'MISSING_EVENT_BAND', constraintId: constraint.id, eventBandIds: missing,
    })
    const duplicate = constraint.eventBandIds.filter((_, index) => constraintItems[index].length > 1)
    if (duplicate.length) violations.push({
      code: 'DUPLICATE_EVENT_BAND', constraintId: constraint.id, eventBandIds: duplicate,
    })
    if (missing.length || duplicate.length) continue

    const wrongLane = constraint.eventBandIds.filter((_, index) => {
      const item = constraintItems[index][0]
      return item.stageId !== constraint.stageId || item.sectionId !== constraint.sectionId
    })
    if (wrongLane.length) {
      violations.push({
        code: 'LANE_MISMATCH', constraintId: constraint.id, eventBandIds: wrongLane,
      })
      continue
    }
    const positions = lanePositions.get(`${constraint.stageId}\u0000${constraint.sectionId ?? ''}`)
    const nonContiguous: EventBandId[] = []
    for (let index = 1; index < constraint.eventBandIds.length; index += 1) {
      const previous = constraint.eventBandIds[index - 1]
      const current = constraint.eventBandIds[index]
      if ((positions?.get(current) ?? Number.NEGATIVE_INFINITY) !==
        (positions?.get(previous) ?? Number.POSITIVE_INFINITY) + 1) {
        nonContiguous.push(previous, current)
      }
    }
    if (nonContiguous.length) violations.push({
      code: 'BLOCK_MISMATCH', constraintId: constraint.id,
      eventBandIds: uniqueSorted(nonContiguous),
    })
  }
  violations.sort((left, right) => left.code.localeCompare(right.code) ||
    left.constraintId.localeCompare(right.constraintId) ||
    left.eventBandIds.join('\u0000').localeCompare(right.eventBandIds.join('\u0000')))
  return { valid: violations.length === 0, violations }
}
