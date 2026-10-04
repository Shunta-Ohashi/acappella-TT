import type {
  DutyAssignment, DutyType, Event, EventBand, EventDay, EventMember,
  EventMemberDay, Member, PaAssignment, ScheduleItem, Section, SectionId,
  Stage, StageId, TimeRange, TimetableLock, TimetableOrderConstraint,
} from './models'
import {
  buildDutyActivities, buildPaActivities, buildPerformanceActivities,
  evaluateMemberActivitySpacing, validateActivitySpacingPolicy,
  type ActivitySpacingPolicy,
  type MemberActivity,
} from './activitySpacing.ts'
import { isValidBreakDurationMinutes, isValidScheduleLane, compareScheduleItemOrder } from './schedule.ts'
import { evaluateScheduleConstraints, type ScheduleConstraintEvaluation } from './schedulingConstraints.ts'
import { getDutyAssignmentsForEvent } from './dutyAssignments.ts'
import { calculateEventDayTimelines } from './timetable.ts'
import { hasSafeStageTimelineArithmetic } from './timetableGenerationArithmetic.ts'
import { hasValidTimetableGenerationDutyTypes, hasValidTimetableGenerationLocks,
  hasValidTimetableGenerationScheduleItems } from './timetableGenerationOptions.ts'
import { evaluateTimetableLocks, isValidFixedPosition } from './timetableLocks.ts'
import {
  evaluateScheduledTimetableOrderConstraints,
  evaluateTimetableOrderConstraints,
  getTargetTimetableOrderConstraints,
  hasValidTimetableOrderConstraintCollection,
} from './timetableOrderConstraints.ts'
import { detectScheduleIssues } from './issues.ts'
import { isValidStageTimeRange, isSectionWithinStageTimeRange } from './eventStageSettings.ts'
import {
  getTimeRangeValidationError, validateAvailabilityWindows, validatePreferredTimeRange,
} from './eventMemberDayDetails.ts'
import { isValidLocalTime, parseLocalTimeToMinute,
  type CalculatedScheduleItem } from './timeline.ts'
import { planPaShifts, type PlannedPaShift, type PlannedPaShiftScope,
  type PlannedScheduleBoundary } from './paShiftPlanning.ts'
import {
  compareExactTimetableGenerationScores, getExactPaWorkloadImbalance,
  getExactSectionBalance, getExactSchedulingSoftPenalty, getCrossSectionTransitions,
  toPublicTimetableGenerationScore,
  type ExactTimetableGenerationScore, type TimetableGenerationScore,
} from './timetableGenerationScore.ts'

export interface TimetableGenerationInput {
  event: Event
  eventDay: EventDay
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  timetableLocks: TimetableLock[]
  timetableOrderConstraints: TimetableOrderConstraint[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  activitySpacingPolicy?: ActivitySpacingPolicy
  options?: Partial<TimetableGenerationOptions>
}

export interface TimetableGenerationOptions {
  /** Maximum number of unique Schedule proposals actually evaluated. */
  maxScheduleCandidates: number
  paBeamWidth: number
  maxPaExpandedStates: number
}

const DEFAULT_OPTIONS: Readonly<TimetableGenerationOptions> = Object.freeze({
  maxScheduleCandidates: 24,
  paBeamWidth: 48,
  maxPaExpandedStates: 4096,
})

export interface PlannedBandPlacement {
  eventBandId: EventBand['id']
  stageId: StageId
  sectionId?: SectionId
  /** ScheduleItem order in the lane, including Breaks. */
  order: number
  /** Performance-only index in the lane. */
  position: number
  /** Present only when an existing ScheduleItem ID can be reused. */
  scheduleItemId?: ScheduleItem['id']
}

export interface PlannedBreakPlacement {
  scheduleItemId: ScheduleItem['id']
  stageId: StageId
  sectionId?: SectionId
  afterSectionId?: SectionId
  order: number
}

export interface TimetableGenerationPlan {
  eventDayId: EventDay['id']
  placements: PlannedBandPlacement[]
  breaks: PlannedBreakPlacement[]
  paShifts: PlannedPaShift[]
  score: TimetableGenerationScore
  diagnostics: {
    scheduleCandidatesEvaluated: number
    paPlansEvaluated: number
    schedulingSoftViolations: ScheduleConstraintEvaluation['softViolations']
  }
}

export type TimetableGenerationFailureCode =
  | 'INVALID_INPUT' | 'INVALID_LOCK_CONSTRAINTS' | 'INVALID_ORDER_CONSTRAINTS'
  | 'BROKEN_DUTY_ASSIGNMENT'
  | 'NO_MAIN_PA_CANDIDATE' | 'NO_SUB_PA_CANDIDATE'
  | 'NO_FEASIBLE_PA_PLAN' | 'NO_FEASIBLE_SCHEDULE' | 'SEARCH_LIMIT_REACHED'

export interface TimetableGenerationFailure {
  code: TimetableGenerationFailureCode
  eventDayId: EventDay['id']
  stageId?: StageId
  sectionId?: SectionId
  eventBandId?: EventBand['id']
  attemptedSchedules: number
}

export type TimetableGenerationResult =
  | { ok: true; plan: TimetableGenerationPlan }
  | { ok: false; failure: TimetableGenerationFailure }

interface GenerationLane {
  key: string
  stage: Stage
  section?: Section
  breaks: Extract<ScheduleItem, { kind: 'break' }>[]
  estimatedMinutes: bigint
  capacityMinutes?: number
}

interface ScheduleProposal {
  items: ScheduleItem[]
  placements: PlannedBandPlacement[]
  breaks: PlannedBreakPlacement[]
  internalItemIdByBand: Map<string, string>
  key: string
}

type OrderEdgesByLane = Map<string, Map<string, Set<string>>>

const laneKey = (stageId: StageId, sectionId?: SectionId): string =>
  `${stageId}\u0000${sectionId ?? ''}`

const positionIndex = (
  position: NonNullable<EventBand['fixedPlacement']>['position'],
  count: number,
): number | undefined => position?.kind === 'first' ? 0
  : position?.kind === 'last' ? count - 1
    : position?.kind === 'index' ? position.index : undefined

const getInternalIds = (
  bands: EventBand[],
  existingItems: ScheduleItem[],
): Map<string, string> => {
  const used = new Set(existingItems.map(item => item.id))
  const ids = new Map<string, string>()
  for (const band of bands) {
    let id = `__generation__:${band.id}`
    while (used.has(id)) id += ':'
    used.add(id)
    ids.set(band.id, id)
  }
  return ids
}

const buildOrderEdgesByLane = (
  constraints: TimetableOrderConstraint[],
): OrderEdgesByLane => {
  const result: OrderEdgesByLane = new Map()
  for (const constraint of constraints) {
    const key = laneKey(constraint.stageId, constraint.sectionId)
    const edges = result.get(key) ?? new Map<string, Set<string>>()
    for (let index = 0; index < constraint.eventBandIds.length - 1; index += 1) {
      const from = constraint.eventBandIds[index]
      const successors = edges.get(from) ?? new Set<string>()
      successors.add(constraint.eventBandIds[index + 1])
      edges.set(from, successors)
    }
    result.set(key, edges)
  }
  return result
}

const applyLanePartialOrder = (
  indexes: number[],
  slots: (EventBand | undefined)[],
  reserved: Set<number>,
  edges: Map<string, Set<string>> | undefined,
): boolean => {
  if (!edges?.size) return true
  const bands = indexes.map(index => slots[index]).filter((band): band is EventBand => band !== undefined)
  if (bands.length !== indexes.length) return false
  const bandById = new Map(bands.map(band => [band.id, band]))
  const rank = new Map(bands.map((band, index) => [band.id, index]))
  const successors = new Map<string, Set<string>>()
  const predecessors = new Map<string, Set<string>>()
  const indegree = new Map(bands.map(band => [band.id, 0]))
  for (const [from, targets] of edges) {
    if (!bandById.has(from)) return false
    for (const to of targets) {
      if (!bandById.has(to)) return false
      const outgoing = successors.get(from) ?? new Set<string>()
      if (outgoing.has(to)) continue
      outgoing.add(to)
      successors.set(from, outgoing)
      const incoming = predecessors.get(to) ?? new Set<string>()
      incoming.add(from)
      predecessors.set(to, incoming)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }
  const fixedPositionByBand = new Map<string, number>()
  indexes.forEach((globalIndex, localIndex) => {
    const band = slots[globalIndex]
    if (band && reserved.has(globalIndex)) fixedPositionByBand.set(band.id, localIndex)
  })
  const deadline = new Map<string, number>()
  const addAncestorDeadlines = (bandId: string, latestPosition: number, visiting: Set<string>): boolean => {
    if (visiting.has(bandId)) return false
    const fixedPosition = fixedPositionByBand.get(bandId)
    if (fixedPosition !== undefined && fixedPosition > latestPosition) return false
    deadline.set(bandId, Math.min(deadline.get(bandId) ?? Number.POSITIVE_INFINITY, latestPosition))
    const nextVisiting = new Set(visiting).add(bandId)
    for (const predecessor of predecessors.get(bandId) ?? []) {
      if (!addAncestorDeadlines(predecessor, latestPosition - 1, nextVisiting)) return false
    }
    return true
  }
  for (const [bandId, position] of fixedPositionByBand) {
    if (!addAncestorDeadlines(bandId, position, new Set())) return false
  }

  const placed = new Set<string>()
  const ordered: EventBand[] = []
  for (let position = 0; position < indexes.length; position += 1) {
    const reservedBand = reserved.has(indexes[position]) ? slots[indexes[position]] : undefined
    let next: EventBand | undefined
    if (reservedBand) {
      if ((indegree.get(reservedBand.id) ?? 0) !== 0 || placed.has(reservedBand.id)) return false
      next = reservedBand
    } else {
      next = bands.filter(band => !placed.has(band.id) && !fixedPositionByBand.has(band.id) &&
        (indegree.get(band.id) ?? 0) === 0)
        .sort((left, right) => (deadline.get(left.id) ?? Number.POSITIVE_INFINITY) -
          (deadline.get(right.id) ?? Number.POSITIVE_INFINITY) ||
          (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0) || left.id.localeCompare(right.id))[0]
      if (!next || (deadline.get(next.id) ?? Number.POSITIVE_INFINITY) < position) return false
    }
    ordered.push(next)
    placed.add(next.id)
    for (const successor of successors.get(next.id) ?? []) {
      indegree.set(successor, (indegree.get(successor) ?? 0) - 1)
    }
  }
  if (placed.size !== bands.length) return false
  indexes.forEach((globalIndex, localIndex) => { slots[globalIndex] = ordered[localIndex] })
  return true
}

const createLanes = (
  stages: Stage[],
  sections: Section[],
  breaks: Extract<ScheduleItem, { kind: 'break' }>[],
): GenerationLane[] => stages.flatMap(stage => {
  const stageSections = sections.filter(section => section.stageId === stage.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const laneSections: (Section | undefined)[] = stageSections.length ? stageSections : [undefined]
  return laneSections.map(section => {
    const laneBreaks = breaks.filter(item => item.stageId === stage.id &&
      item.sectionId === section?.id).sort(compareScheduleItemOrder)
    const from = parseLocalTimeToMinute(section?.plannedStartTime ?? stage.plannedStartTime)
    const until = section?.plannedEndTime ?? stage.plannedEndTime
    return {
      key: laneKey(stage.id, section?.id), stage, section,
      breaks: laneBreaks,
      estimatedMinutes: laneBreaks.reduce((sum, item) => sum + BigInt(item.durationMinutes), 0n),
      ...(until ? { capacityMinutes: parseLocalTimeToMinute(until) - from } : {}),
    }
  })
})

const orderStageBands = (
  lanes: GenerationLane[],
  assigned: Map<string, EventBand[]>,
  allowedLaneKeysByBand: Map<string, Set<string>>,
  locksByBand: Map<string, TimetableLock>,
  orderEdgesByLane: OrderEdgesByLane,
  variant: number,
): Map<string, EventBand[]> | undefined => {
  const ordered = new Map<string, EventBand[]>()
  for (const stageId of new Set(lanes.map(lane => lane.stage.id))) {
    const stageLanes = lanes.filter(lane => lane.stage.id === stageId)
    const preferredLaneByBand = new Map<string, string>()
    const slotLanes: GenerationLane[] = []
    const indexesByLane = new Map<string, number[]>()
    const stageBands = stageLanes.flatMap(lane => {
      const bands = assigned.get(lane.key) ?? []
      const rotation = bands.length ? Math.floor(variant / 2) % bands.length : 0
      const rotated = [...bands.slice(rotation), ...bands.slice(0, rotation)]
      if (variant % 2) rotated.reverse()
      const indexes = bands.map(band => {
        preferredLaneByBand.set(band.id, lane.key)
        slotLanes.push(lane)
        return slotLanes.length - 1
      })
      indexesByLane.set(lane.key, indexes)
      return rotated
    })
    const slots: (EventBand | undefined)[] = Array(stageBands.length).fill(undefined)
    const reserved = new Set<number>()
    const lanePosition = (key: string, position: NonNullable<TimetableLock['position']>) => {
      const indexes = indexesByLane.get(key) ?? []
      const index = positionIndex(position, indexes.length)
      return index === undefined ? undefined : indexes[index]
    }
    for (const band of stageBands) {
      const fixed = band.fixedPlacement
      const lock = locksByBand.get(band.id)
      const fixedIndex = fixed?.position
        ? fixed.sectionId === undefined
          ? positionIndex(fixed.position, stageBands.length)
          : lanePosition(laneKey(fixed.stageId, fixed.sectionId), fixed.position)
        : undefined
      const lockedIndex = lock ? lanePosition(laneKey(lock.stageId, lock.sectionId), lock.position)
        : undefined
      if ((fixed?.position && fixedIndex === undefined) || (lock && lockedIndex === undefined) ||
        (fixedIndex !== undefined && lockedIndex !== undefined && fixedIndex !== lockedIndex)) {
        return undefined
      }
      const index = lockedIndex ?? fixedIndex
      if (index === undefined) continue
      const lane = slotLanes[index]
      if (!lane || reserved.has(index) ||
        (allowedLaneKeysByBand.has(band.id) && !allowedLaneKeysByBand.get(band.id)?.has(lane.key))) {
        return undefined
      }
      slots[index] = band
      reserved.add(index)
    }
    // Match the remaining bands to allowed slots without changing lane sizes or
    // reserved positions. Augmenting paths handle displaced Section-only bands.
    const place = (band: EventBand, visited: Set<number>): boolean => {
      const allowed = allowedLaneKeysByBand.get(band.id)
      const preferred = preferredLaneByBand.get(band.id)
      const choices = slotLanes.map((lane, index) => ({ lane, index }))
        .filter(({ lane, index }) => !reserved.has(index) && !visited.has(index) &&
          (!allowed || allowed.has(lane.key)))
        .sort((left, right) => Number(right.lane.key === preferred) -
          Number(left.lane.key === preferred) || left.index - right.index)
      for (const { index } of choices) {
        if (!slots[index]) { slots[index] = band; return true }
      }
      for (const { index } of choices) {
        visited.add(index)
        const occupant = slots[index]
        if (occupant && place(occupant, visited)) { slots[index] = band; return true }
      }
      return false
    }
    const remaining = stageBands.filter(band => !slots.includes(band))
    for (const band of remaining) {
      if (!place(band, new Set())) return undefined
    }
    for (const lane of stageLanes) {
      if (!applyLanePartialOrder(indexesByLane.get(lane.key) ?? [], slots, reserved,
        orderEdgesByLane.get(lane.key))) return undefined
    }
    for (const lane of stageLanes) {
      ordered.set(lane.key, (indexesByLane.get(lane.key) ?? [])
        .map(index => slots[index]).filter((band): band is EventBand => band !== undefined))
    }
  }
  return ordered
}

const buildProposal = ({
  variant, bands, lanes, originalItems, targetStageIds, existingByBand,
  allowedLaneKeysByBand, locksByBand, internalIds,
  orderEdgesByLane,
}: {
  variant: number
  bands: EventBand[]
  lanes: GenerationLane[]
  originalItems: ScheduleItem[]
  targetStageIds: Set<StageId>
  existingByBand: Map<string, Extract<ScheduleItem, { kind: 'performance' }>>
  allowedLaneKeysByBand: Map<string, Set<string>>
  locksByBand: Map<string, TimetableLock>
  orderEdgesByLane: OrderEdgesByLane
  internalIds: Map<string, string>
}): ScheduleProposal | undefined => {
  const laneByKey = new Map(lanes.map(lane => [lane.key, lane]))
  const assigned = new Map(lanes.map(lane => [lane.key, [] as EventBand[]]))
  const load = new Map(lanes.map(lane => [lane.key, lane.estimatedMinutes]))
  const laneCount = BigInt(Math.max(1, lanes.length))
  const totalLoad = bands.reduce((sum, band) => sum + BigInt(band.durationMinutes), 0n) +
    lanes.reduce((sum, lane) => sum + lane.estimatedMinutes, 0n)
  // The default capacity is max(1, totalLoad / laneCount). Retain its exact
  // rational representation instead of accumulating or rounding large Numbers.
  const defaultCapacityNumerator = totalLoad > laneCount ? totalLoad : laneCount
  const capacity = (lane: GenerationLane) => lane.capacityMinutes !== undefined && lane.capacityMinutes > 0
    ? { numerator: BigInt(lane.capacityMinutes), denominator: 1n }
    : { numerator: defaultCapacityNumerator, denominator: laneCount }
  const forced = bands.filter(band => allowedLaneKeysByBand.get(band.id)?.size === 1)
  const free = bands.filter(band => allowedLaneKeysByBand.get(band.id)?.size !== 1)
    .sort((left, right) => right.durationMinutes - left.durationMinutes ||
      left.id.localeCompare(right.id))
  const rotation = free.length ? Math.floor(variant / 2) % free.length : 0
  const rotated = [...free.slice(rotation), ...free.slice(0, rotation)]
  if (variant % 2) rotated.reverse()
  for (const band of forced) {
    const key = allowedLaneKeysByBand.get(band.id)?.values().next().value
    if (!key || !laneByKey.has(key)) return undefined
    assigned.get(key)?.push(band)
    load.set(key, (load.get(key) ?? 0n) + BigInt(band.durationMinutes))
  }
  for (const band of rotated) {
    const allowed = allowedLaneKeysByBand.get(band.id)
    const choices = lanes.filter(lane => !allowed || allowed.has(lane.key)).sort((left, right) => {
      const leftLoad = (load.get(left.key) ?? 0n) + BigInt(band.durationMinutes)
      const rightLoad = (load.get(right.key) ?? 0n) + BigInt(band.durationMinutes)
      const leftCapacity = capacity(left)
      const rightCapacity = capacity(right)
      const difference = leftLoad * leftCapacity.denominator * rightCapacity.numerator -
        rightLoad * rightCapacity.denominator * leftCapacity.numerator
      return (difference < 0n ? -1 : difference > 0n ? 1 : 0) ||
        ((lanes.indexOf(left) + variant) % lanes.length) -
          ((lanes.indexOf(right) + variant) % lanes.length)
    })
    const chosen = choices[0]
    if (!chosen) return undefined
    assigned.get(chosen.key)?.push(band)
    load.set(chosen.key, (load.get(chosen.key) ?? 0n) + BigInt(band.durationMinutes))
  }
  const orderedByLane = orderStageBands(
    lanes, assigned, allowedLaneKeysByBand, locksByBand, orderEdgesByLane, variant,
  )
  if (!orderedByLane) return undefined

  const items: ScheduleItem[] = originalItems.filter(item =>
    !targetStageIds.has(item.stageId) &&
    !(item.kind === 'performance' && existingByBand.has(item.eventBandId)))
  const placements: PlannedBandPlacement[] = []
  const breakPlacements: PlannedBreakPlacement[] = []
  const keyParts: string[] = []
  for (const lane of lanes) {
    const orderedBands = orderedByLane.get(lane.key) ?? []
    keyParts.push(`${lane.key}:${orderedBands.map(band => band.id).join(',')}`)

    const oldLaneItems = originalItems.filter(item => item.stageId === lane.stage.id &&
      item.sectionId === lane.section?.id).sort(compareScheduleItemOrder)
    const breaksByBeforeCount = new Map<number, typeof lane.breaks>()
    let priorPerformances = 0
    for (const oldItem of oldLaneItems) {
      if (oldItem.kind === 'performance') {
        priorPerformances += 1
      } else if (oldItem.kind === 'break') {
        const before = Math.min(priorPerformances, orderedBands.length)
        const group = breaksByBeforeCount.get(before) ?? []
        group.push(oldItem)
        breaksByBeforeCount.set(before, group)
      }
    }
    let order = 0
    for (let position = 0; position <= orderedBands.length; position += 1) {
      for (const breakItem of breaksByBeforeCount.get(position) ?? []) {
        items.push({ ...breakItem, order })
        breakPlacements.push({
          scheduleItemId: breakItem.id, stageId: breakItem.stageId,
          ...(breakItem.sectionId !== undefined ? { sectionId: breakItem.sectionId } : {}), order,
        })
        order += 1
      }
      const band = orderedBands[position]
      if (!band) continue
      const existing = existingByBand.get(band.id)
      const id = existing?.id ?? internalIds.get(band.id)
      if (!id) return undefined
      items.push({
        id, kind: 'performance', eventBandId: band.id,
        stageId: lane.stage.id,
        ...(lane.section ? { sectionId: lane.section.id } : {}), order,
      })
      placements.push({
        eventBandId: band.id, stageId: lane.stage.id,
        ...(lane.section ? { sectionId: lane.section.id } : {}),
        order, position,
        ...(existing ? { scheduleItemId: existing.id } : {}),
      })
      order += 1
    }
  }
  // Section-between Breaks have their own immutable placement lane.
  for (const item of originalItems) {
    if (item.kind !== 'break' || !targetStageIds.has(item.stageId) ||
      item.afterSectionId === undefined) continue
    items.push(item)
    breakPlacements.push({
      scheduleItemId: item.id, stageId: item.stageId,
      afterSectionId: item.afterSectionId, order: item.order,
    })
  }
  return {
    items, placements, breaks: breakPlacements,
    internalItemIdByBand: internalIds, key: keyParts.join('|'),
  }
}

const evaluateActivities = (
  activities: MemberActivity[],
  calculatedItems: CalculatedScheduleItem[],
  policy?: ActivitySpacingPolicy,
): { feasible: boolean; lastResortCount: number; penalty: number } => {
  const memberIds = [...new Set(activities.map(activity => activity.memberId))].sort()
  let lastResortCount = 0
  let penalty = 0
  for (const memberId of memberIds) {
    const result = evaluateMemberActivitySpacing({
      activities: activities.filter(activity => activity.memberId === memberId),
      policy, stageItems: calculatedItems,
    })
    if (!result.feasible) return { feasible: false, lastResortCount: 0, penalty: 0 }
    lastResortCount += result.pairs.filter(pair => pair.level === 'last-resort').length
    penalty += result.totalPenalty
  }
  return { feasible: true, lastResortCount, penalty }
}

const getShiftScopes = (
  lanes: GenerationLane[],
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
  internalIds: Map<string, string>,
): PlannedPaShiftScope[] => {
  const transitions = getCrossSectionTransitions(sections, calculatedItems)
  const bandByInternalId = new Map([...internalIds].map(([bandId, id]) => [id, bandId]))
  const boundary = (item: CalculatedScheduleItem, edge: 'start' | 'end'):
    PlannedScheduleBoundary => {
    const bandId = bandByInternalId.get(item.scheduleItemId)
    return bandId
      ? { kind: 'planned-performance', eventBandId: bandId, edge }
      : { kind: 'existing-item', scheduleItemId: item.scheduleItemId, edge }
  }
  return lanes.flatMap(lane => {
    const laneItems = calculatedItems.filter(item => item.stageId === lane.stage.id &&
      item.sectionId === lane.section?.id)
    if (!laneItems.some(item => item.kind === 'performance')) return []
    const first = laneItems.reduce((best, item) =>
      item.plannedStartMinute < best.plannedStartMinute ? item : best)
    const last = laneItems.reduce((best, item) =>
      item.plannedEndMinute > best.plannedEndMinute ? item : best)
    const transition = lane.section ? transitions.get(lane.section.id) : undefined
    return [{
      key: lane.key,
      eventDayId: lane.stage.eventDayId,
      stageId: lane.stage.id,
      ...(lane.section ? { sectionId: lane.section.id } : {}),
      fromMinute: first.plannedStartMinute,
      untilMinute: transition?.untilItem.plannedStartMinute ?? last.plannedEndMinute,
      fromBoundary: boundary(first, 'start'),
      untilBoundary: transition ? boundary(transition.untilItem, 'start') : boundary(last, 'end'),
    }]
  })
}

const toInternalBoundary = (
  boundary: PlannedScheduleBoundary,
  internalIds: Map<string, string>,
) => ({
  scheduleItemId: boundary.kind === 'existing-item'
    ? boundary.scheduleItemId
    : internalIds.get(boundary.eventBandId) ?? '',
  edge: boundary.edge,
})

const isPerfectScore = (score: ExactTimetableGenerationScore): boolean =>
  Object.values(score).every(value => value === 0 || value === 0n)

const isValidTransitionMinutes = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

// Input validators trim form values, but downstream parsers consume the original
// persisted boundaries. Check those without normalizing or changing the input.
const hasParseableTimeRangeBoundaries = (range: TimeRange): boolean =>
  typeof range === 'object' && range !== null && !Array.isArray(range) &&
  [range.from, range.until].every(time => time === undefined ||
    (typeof time === 'string' && isValidLocalTime(time)))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isNonEmptyId = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim()

const hasValidEntityCollection = (
  value: unknown, isValidEntry: (entry: Record<string, unknown>) => boolean,
): boolean => Array.isArray(value) && value.every((entry: unknown) =>
  isRecord(entry) && isNonEmptyId(entry.id) && isValidEntry(entry)) &&
  new Set(value.map((entry: { id: string }) => entry.id)).size === value.length

const hasValidDutyBoundary = (value: unknown): boolean =>
  isRecord(value) && isNonEmptyId(value.scheduleItemId) &&
  (value.edge === 'start' || value.edge === 'end')

/** Validate collection shape and fields used by generation before any entity lookup. */
const hasValidTimetableGenerationCollections = (input: TimetableGenerationInput): boolean =>
  hasValidEntityCollection(input.eventDays, day => isNonEmptyId(day.eventId)) &&
  hasValidEntityCollection(input.stages, stage =>
    isNonEmptyId(stage.eventDayId) && Number.isSafeInteger(stage.order)) &&
  hasValidEntityCollection(input.sections, section =>
    isNonEmptyId(section.stageId) && Number.isSafeInteger(section.order)) &&
  hasValidEntityCollection(input.members, member => typeof member.realName === 'string') &&
  hasValidEntityCollection(input.eventMembers, member =>
    isNonEmptyId(member.eventId) && isNonEmptyId(member.memberId) &&
    isRecord(member.paCapabilities) &&
    typeof member.paCapabilities.main === 'boolean' &&
    typeof member.paCapabilities.sub === 'boolean') &&
  hasValidEntityCollection(input.eventMemberDays, day =>
    isNonEmptyId(day.eventMemberId) && isNonEmptyId(day.eventDayId) &&
    (day.participationStatus === 'participating' || day.participationStatus === 'absent' ||
      day.participationStatus === 'undecided')) &&
  hasValidEntityCollection(input.eventBands, band =>
    isNonEmptyId(band.eventId) && isNonEmptyId(band.eventDayId) &&
    Array.isArray(band.memberIds) && band.memberIds.every(isNonEmptyId)) &&
  hasValidEntityCollection(input.dutyAssignments, duty =>
    isNonEmptyId(duty.dutyTypeId) && isNonEmptyId(duty.eventDayId) &&
    isNonEmptyId(duty.stageId) && isNonEmptyId(duty.memberId) &&
    hasValidDutyBoundary(duty.from) && hasValidDutyBoundary(duty.until)) &&
  hasValidTimetableGenerationDutyTypes(input.dutyTypes) &&
  hasValidTimetableGenerationLocks(input.timetableLocks)

export const generateTimetablePlan = (input: TimetableGenerationInput): TimetableGenerationResult => {
  const rawInput: unknown = input
  const rawEventDay = isRecord(rawInput) ? rawInput.eventDay : undefined
  const safeEventDayId = isRecord(rawEventDay) && isNonEmptyId(rawEventDay.id) ? rawEventDay.id : ''
  if (!isRecord(rawInput) || !isRecord(rawInput.event) || !isNonEmptyId(rawInput.event.id) ||
    !isRecord(rawEventDay) || !isNonEmptyId(rawEventDay.id) || !isNonEmptyId(rawEventDay.eventId)) {
    return { ok: false, failure: { code: 'INVALID_INPUT', eventDayId: safeEventDayId, attemptedSchedules: 0 } }
  }
  const {
    event, eventDay, eventDays, stages, sections, members, eventMembers,
    eventMemberDays, eventBands, scheduleItems, timetableLocks, dutyTypes,
    dutyAssignments, timetableOrderConstraints, activitySpacingPolicy,
  } = input
  const failure = (code: TimetableGenerationFailureCode, attemptedSchedules: number,
    references: Partial<Pick<TimetableGenerationFailure,
      'stageId' | 'sectionId' | 'eventBandId'>> = {}): TimetableGenerationResult => ({
    ok: false, failure: { code, eventDayId: eventDay.id, attemptedSchedules, ...references },
  })
  if (!hasValidTimetableGenerationCollections(input)) return failure('INVALID_INPUT', 0)
  if (!hasValidTimetableOrderConstraintCollection(timetableOrderConstraints)) {
    return failure('INVALID_ORDER_CONSTRAINTS', 0)
  }
  if (!isRecord(event.validationPolicy) ||
    !Number.isSafeInteger(event.validationPolicy.minimumGapBands) ||
    event.validationPolicy.minimumGapBands < 0 ||
    !Number.isSafeInteger(event.validationPolicy.minimumRestMinutes) ||
    event.validationPolicy.minimumRestMinutes < 0) return failure('INVALID_INPUT', 0)
  const rawScheduleItems: unknown = scheduleItems
  if (!hasValidTimetableGenerationScheduleItems(rawScheduleItems)) {
    const malformed: unknown = Array.isArray(rawScheduleItems)
      ? rawScheduleItems.find((item: unknown) => !hasValidTimetableGenerationScheduleItems([item]))
      : undefined
    if (malformed !== null && typeof malformed === 'object' && !Array.isArray(malformed)) {
      const item = malformed as Record<string, unknown>
      if (item.kind === 'performance' && typeof item.eventBandId === 'string' &&
        eventBands.some(band => band.id === item.eventBandId && band.eventId === event.id)) {
        return failure('INVALID_INPUT', 0, { eventBandId: item.eventBandId })
      }
      if (item.kind === 'break' && typeof item.stageId === 'string' &&
        stages.some(stage => stage.id === item.stageId && stage.eventDayId === eventDay.id)) {
        return failure('INVALID_INPUT', 0, { stageId: item.stageId })
      }
    }
    return failure('INVALID_INPUT', 0)
  }
  const options = { ...DEFAULT_OPTIONS, ...input.options }
  if (eventDay.eventId !== event.id ||
    !eventDays.some(day => day.id === eventDay.id && day.eventId === event.id) ||
    !isValidTransitionMinutes(event.defaultTransitionMinutes) ||
    Object.values(options).some(value => !Number.isSafeInteger(value) || value < 1)) {
    return failure('INVALID_INPUT', 0)
  }
  if (activitySpacingPolicy !== undefined) {
    try {
      validateActivitySpacingPolicy(activitySpacingPolicy)
    } catch {
      return failure('INVALID_INPUT', 0)
    }
  }
  const eventDayIds = new Set(eventDays.filter(day => day.eventId === event.id)
    .map(day => day.id))
  const eventStageIds = new Set(stages.filter(stage => eventDayIds.has(stage.eventDayId))
    .map(stage => stage.id))
  const eventBandIds = new Set(eventBands.filter(band => band.eventId === event.id)
    .map(band => band.id))
  const eventScheduleItems = scheduleItems.filter(item =>
    eventStageIds.has(item.stageId) ||
    (item.kind === 'performance' && eventBandIds.has(item.eventBandId)))
  const targetStages = stages.filter(stage => stage.eventDayId === eventDay.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const targetStageIds = new Set(targetStages.map(stage => stage.id))
  const targetStageById = new Map(targetStages.map(stage => [stage.id, stage]))
  const targetSections = sections.filter(section => targetStageIds.has(section.stageId))
  const targetEventMemberIds = new Set(eventMembers.filter(member => member.eventId === event.id)
    .map(member => member.id))
  const targetMemberDays = eventMemberDays.filter(day => day.eventDayId === eventDay.id &&
    targetEventMemberIds.has(day.eventMemberId))
  const targetBands = eventBands.filter(band =>
    band.eventId === event.id && band.eventDayId === eventDay.id,
  ).sort((left, right) => left.id.localeCompare(right.id))
  const targetBandIds = new Set(targetBands.map(band => band.id))
  const targetOrderConstraints = getTargetTimetableOrderConstraints({
    timetableOrderConstraints,
    eventDayId: eventDay.id,
    stageIds: targetStageIds,
    eventBandIds: targetBandIds,
  })
  const orderConstraintEvaluation = evaluateTimetableOrderConstraints({
    eventId: event.id,
    timetableOrderConstraints: targetOrderConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
  })
  if (!orderConstraintEvaluation.valid) return failure('INVALID_ORDER_CONSTRAINTS', 0)
  if (targetStages.some(stage => !isValidStageTimeRange(stage.plannedStartTime, stage.plannedEndTime) ||
    (stage.transitionMinutes !== undefined && !isValidTransitionMinutes(stage.transitionMinutes))) ||
    targetSections.some(section => {
      const stage = targetStageById.get(section.stageId)
      return !stage || !isSectionWithinStageTimeRange(stage, section)
    }) ||
    targetBands.some(band => !isValidBreakDurationMinutes(band.durationMinutes) ||
      (band.fixedPlacement?.plannedStartTime !== undefined &&
        !isValidLocalTime(band.fixedPlacement.plannedStartTime)))) {
    return failure('INVALID_INPUT', 0)
  }
  if (targetBands.some(band => [band.availableTimeRange, band.preferredTimeRange]
    .some(range => range !== undefined &&
      (!hasParseableTimeRangeBoundaries(range) || getTimeRangeValidationError(range) !== undefined))) ||
    targetMemberDays.some(day =>
      (day.availabilityWindows !== undefined &&
        (!Array.isArray(day.availabilityWindows) ||
          !day.availabilityWindows.every(hasParseableTimeRangeBoundaries))) ||
      (day.preferredTimeRange !== undefined &&
        !hasParseableTimeRangeBoundaries(day.preferredTimeRange)) ||
      validateAvailabilityWindows(day.availabilityWindows) !== undefined ||
      validatePreferredTimeRange(day.preferredTimeRange) !== undefined)) {
    return failure('INVALID_INPUT', 0)
  }
  const targetSectionById = new Map(targetSections.map(section => [section.id, section]))
  for (const band of targetBands) {
    const fixed = band.fixedPlacement
    if (fixed === undefined) continue
    if (!fixed || typeof fixed !== 'object' || !targetStageById.has(fixed.stageId) ||
      (fixed.sectionId !== undefined &&
        targetSectionById.get(fixed.sectionId)?.stageId !== fixed.stageId) ||
      (fixed.position !== undefined && !isValidFixedPosition(fixed.position))) {
      return failure('INVALID_INPUT', 0, { eventBandId: band.id })
    }
  }
  if (targetBands.length > 0 && targetStages.length === 0) {
    return failure('NO_FEASIBLE_SCHEDULE', 0)
  }
  const targetBreaks = eventScheduleItems.filter((item): item is Extract<ScheduleItem, { kind: 'break' }> =>
    item.kind === 'break' && targetStageIds.has(item.stageId),
  )
  for (const item of targetBreaks) {
    const stage = targetStages.find(candidate => candidate.id === item.stageId)
    if (!stage || !isValidBreakDurationMinutes(item.durationMinutes) ||
      !isValidScheduleLane(stage, targetSections.filter(section => section.stageId === stage.id), {
        stageId: stage.id,
        ...(item.sectionId !== undefined ? { sectionId: item.sectionId } : {}),
        ...(item.afterSectionId !== undefined ? { afterSectionId: item.afterSectionId } : {}),
      })) return failure('INVALID_INPUT', 0, { stageId: item.stageId })
  }
  const existingByBand = new Map<string, Extract<ScheduleItem, { kind: 'performance' }>>()
  for (const item of eventScheduleItems) {
    if (item.kind !== 'performance') continue
    if (targetBandIds.has(item.eventBandId)) {
      // Reassignment may repair stale Stage/Section references, but must not
      // silently normalize malformed runtime fields into absent lane values.
      if ((item.sectionId !== undefined &&
        (typeof item.sectionId !== 'string' || item.sectionId.length === 0)) ||
        ('afterSectionId' in item && item.afterSectionId !== undefined)) {
        return failure('INVALID_INPUT', 0, { eventBandId: item.eventBandId })
      }
      if (existingByBand.has(item.eventBandId)) {
        return failure('INVALID_INPUT', 0, { eventBandId: item.eventBandId })
      }
      existingByBand.set(item.eventBandId, item)
    } else if (targetStageIds.has(item.stageId)) {
      return failure('INVALID_INPUT', 0, { stageId: item.stageId })
    }
  }
  const lanes = createLanes(targetStages, targetSections, targetBreaks)
  const laneByKey = new Map(lanes.map(lane => [lane.key, lane]))
  const locksByBand = new Map<string, TimetableLock>()
  const itemById = new Map(scheduleItems.map(item => [item.id, item]))
  const targetSectionIds = new Set(targetSections.map(section => section.id))
  // Include stale locks tied to a target lane or item, but not unrelated days' locks.
  const targetLocks = timetableLocks.filter(lock => {
    if (lock.eventId !== event.id) return false
    const item = itemById.get(lock.scheduleItemId)
    return targetStageIds.has(lock.stageId) ||
      (lock.sectionId !== undefined && targetSectionIds.has(lock.sectionId)) ||
      (item !== undefined && (targetStageIds.has(item.stageId) ||
        (item.kind === 'performance' && targetBandIds.has(item.eventBandId))))
  })
  for (const lock of targetLocks) {
    const item = itemById.get(lock.scheduleItemId)
    if (!item || item.kind !== 'performance') return failure('INVALID_LOCK_CONSTRAINTS', 0)
    if (!targetBandIds.has(item.eventBandId)) continue
    if (locksByBand.has(item.eventBandId)) return failure('INVALID_LOCK_CONSTRAINTS', 0)
    locksByBand.set(item.eventBandId, lock)
  }
  const allowedLaneKeysByBand = new Map<string, Set<string>>()
  for (const band of targetBands) {
    const fixed = band.fixedPlacement
    const lock = locksByBand.get(band.id)
    const allowed = new Set(lanes.filter(lane => !fixed ||
      (lane.stage.id === fixed.stageId &&
        (fixed.sectionId === undefined || lane.section?.id === fixed.sectionId)))
      .map(lane => lane.key))
    const lockKey = lock ? laneKey(lock.stageId, lock.sectionId) : undefined
    if (allowed.size === 0) return failure('INVALID_INPUT', 0, { eventBandId: band.id })
    if (lockKey && (!laneByKey.has(lockKey) || !allowed.has(lockKey))) {
      return failure('INVALID_LOCK_CONSTRAINTS', 0, { eventBandId: band.id })
    }
    if (lockKey) allowedLaneKeysByBand.set(band.id, new Set([lockKey]))
    else if (fixed) allowedLaneKeysByBand.set(band.id, allowed)
  }
  for (const constraint of targetOrderConstraints) {
    const requiredLaneKey = laneKey(constraint.stageId, constraint.sectionId)
    if (!laneByKey.has(requiredLaneKey)) return failure('INVALID_ORDER_CONSTRAINTS', 0)
    for (const eventBandId of constraint.eventBandIds) {
      const current = allowedLaneKeysByBand.get(eventBandId) ?? new Set(lanes.map(lane => lane.key))
      if (!current.has(requiredLaneKey)) {
        return failure('INVALID_ORDER_CONSTRAINTS', 0, { eventBandId })
      }
      allowedLaneKeysByBand.set(eventBandId, new Set([requiredLaneKey]))
    }
  }
  const orderEdgesByLane = buildOrderEdgesByLane(targetOrderConstraints)
  // Lock positions are lane-local. Stage-wide fixed positions are enforced by
  // proposal construction and the unchanged constraint/Issue evaluators.
  const lockEvaluationBands = targetBands.map(band => {
    if (!band.fixedPlacement?.position || band.fixedPlacement.sectionId !== undefined ||
      !targetSections.some(section => section.stageId === band.fixedPlacement?.stageId)) return band
    const fixedPlacement = { ...band.fixedPlacement }
    delete fixedPlacement.position
    return { ...band, fixedPlacement }
  })
  const structuralLockCodes = new Set([
    'DUPLICATE_LOCK_TARGET', 'SCHEDULE_ITEM_NOT_FOUND', 'TARGET_NOT_PERFORMANCE',
    'EVENT_BAND_NOT_FOUND', 'EVENT_MISMATCH', 'EVENT_DAY_MISMATCH',
    'STAGE_NOT_FOUND', 'SECTION_NOT_FOUND', 'SECTION_STAGE_MISMATCH',
    'LOCK_CONFLICT', 'FIXED_PLACEMENT_CONFLICT', 'INVALID_POSITION',
  ])
  const currentLockResult = evaluateTimetableLocks({
    eventId: event.id, timetableLocks: targetLocks, scheduleItems,
    eventBands: lockEvaluationBands, eventDays: [eventDay],
    stages: targetStages, sections: targetSections,
  })
  if (currentLockResult.violations.some(violation =>
    structuralLockCodes.has(violation.code))) {
    return failure('INVALID_LOCK_CONSTRAINTS', 0)
  }
  const internalIds = getInternalIds(targetBands.filter(band => !existingByBand.has(band.id)), scheduleItems)
  const dutyTypeIds = new Set(dutyTypes.filter(type => type.eventId === event.id)
    .map(type => type.id))
  // Known DutyTypes establish Event ownership. Missing types are retained only
  // for target Stages, so preflight can report broken duties without guessing.
  const targetDuties = getDutyAssignmentsForEvent({
    event, stages: targetStages, dutyTypes, dutyAssignments,
  }).filter(item => item.eventDayId === eventDay.id)
  for (const duty of targetDuties) {
    if (!dutyTypeIds.has(duty.dutyTypeId) ||
      !itemById.has(duty.from.scheduleItemId) ||
      !itemById.has(duty.until.scheduleItemId) ||
      !targetStageIds.has(duty.stageId)) {
      return failure('BROKEN_DUTY_ASSIGNMENT', 0, { stageId: duty.stageId })
    }
  }
  let best: TimetableGenerationPlan | undefined
  let bestExactScore: ExactTimetableGenerationScore | undefined
  let bestKey = ''
  let attemptedSchedules = 0
  let paPlansEvaluated = 0
  let lastFailure: TimetableGenerationFailureCode = 'NO_FEASIBLE_SCHEDULE'
  let lastFailureReferences: Partial<Pick<TimetableGenerationFailure,
    'stageId' | 'sectionId' | 'eventBandId'>> = {}
  const setLastFailure = (code: TimetableGenerationFailureCode,
    references: typeof lastFailureReferences = {}) => {
    lastFailure = code
    lastFailureReferences = references
  }
  let paSearchLimitReached = false
  let paSearchLimitReferences: typeof lastFailureReferences = {}
  const variants = Math.max(1, targetBands.length * 2, lanes.length * 2)
  let scheduleSearchLimitReached = false
  const seen = new Set<string>()
  for (let variant = 0; variant < variants; variant += 1) {
    const proposal = buildProposal({
      variant, bands: targetBands, lanes, originalItems: eventScheduleItems,
      targetStageIds, existingByBand, allowedLaneKeysByBand, locksByBand, internalIds,
      orderEdgesByLane,
    })
    if (!proposal) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    // Duplicate variants are not newly evaluated candidates; retain the last
    // actual rejection rather than overwriting its diagnostics.
    if (seen.has(proposal.key)) continue
    // Scan past duplicate/unbuildable variants even at the cap. Only an
    // unevaluated unique proposal makes the Schedule search incomplete.
    if (attemptedSchedules >= options.maxScheduleCandidates) {
      scheduleSearchLimitReached = true
      break
    }
    seen.add(proposal.key)
    attemptedSchedules += 1
    const targetProposalItems = proposal.items.filter(item => targetStageIds.has(item.stageId))
    if (!evaluateScheduledTimetableOrderConstraints({
      timetableOrderConstraints: targetOrderConstraints,
      scheduleItems: targetProposalItems,
    }).valid) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    if (targetStages.some(stage => !hasSafeStageTimelineArithmetic({
      event, stage, sections: targetSections, scheduleItems: targetProposalItems,
      eventBands: targetBands,
    }))) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    const locks = evaluateTimetableLocks({
      eventId: event.id, timetableLocks: targetLocks, scheduleItems: targetProposalItems,
      eventBands: lockEvaluationBands, eventDays: [eventDay],
      stages: targetStages, sections: targetSections,
    })
    if (!locks.valid) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    const constraints = evaluateScheduleConstraints({
      event, eventDays: [eventDay], stages: targetStages, sections: targetSections,
      members, eventMembers, eventMemberDays: targetMemberDays,
      eventBands: targetBands, scheduleItems: targetProposalItems,
    })
    if (!constraints.feasible) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    let timeline: ReturnType<typeof calculateEventDayTimelines>
    try {
      timeline = calculateEventDayTimelines({
        event, eventDayId: eventDay.id, stages: targetStages, sections: targetSections,
        scheduleItems: targetProposalItems, eventBands: targetBands,
      })
    } catch {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    if (timeline.invalidStages.length > 0) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    const calculatedItems = timeline.calculatedItems
    const issues = detectScheduleIssues({
      event, members, eventMembers, eventMemberDays: targetMemberDays,
      eventBands: targetBands, stages: targetStages, sections: targetSections,
      paAssignments: [], dutyTypes, dutyAssignments: targetDuties,
      calculatedItems,
    })
    if (issues.some(issue => issue.severity === 'ERROR')) {
      const dutyIssue = issues.find(issue => issue.code === 'DUTY_INVALID_BOUNDARY' ||
        issue.code === 'DUTY_TYPE_NOT_FOUND')
      if (dutyIssue) setLastFailure('BROKEN_DUTY_ASSIGNMENT', {
        ...(dutyIssue.stageIds?.[0] ? { stageId: dutyIssue.stageIds[0] } : {}),
        ...(dutyIssue.sectionIds?.[0] ? { sectionId: dutyIssue.sectionIds[0] } : {}),
      })
      else setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    const performance = buildPerformanceActivities(calculatedItems, targetBands)
    const duty = buildDutyActivities(targetDuties, calculatedItems)
    if (duty.unresolved.length > 0) {
      const assignment = targetDuties.find(item => item.id === duty.unresolved[0].id)
      setLastFailure('BROKEN_DUTY_ASSIGNMENT', assignment ? { stageId: assignment.stageId } : {})
      continue
    }
    if (performance.unresolved.length > 0) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    const baseActivities = [...performance.activities, ...duty.activities]
    if (!evaluateActivities(baseActivities, calculatedItems, activitySpacingPolicy).feasible) {
      setLastFailure('NO_FEASIBLE_SCHEDULE')
      continue
    }
    const scopes = getShiftScopes(lanes, targetSections, calculatedItems, internalIds)
    const paResult = planPaShifts({
      event, eventDayId: eventDay.id, scopes, calculatedItems, baseActivities,
      policy: activitySpacingPolicy, members, eventMembers, eventMemberDays: targetMemberDays,
      beamWidth: options.paBeamWidth, maxExpandedStates: options.maxPaExpandedStates,
    })
    if (!paResult.ok) {
      setLastFailure(paResult.code, paResult.scope ? {
        stageId: paResult.scope.stageId,
        ...(paResult.scope.sectionId ? { sectionId: paResult.scope.sectionId } : {}),
      } : {})
      if (paResult.code === 'SEARCH_LIMIT_REACHED' && !paSearchLimitReached) {
        paSearchLimitReached = true
        paSearchLimitReferences = lastFailureReferences
      }
      continue
    }
    for (const paPlan of paResult.plans) {
      paPlansEvaluated += 1
      const plannedAssignments: PaAssignment[] = paPlan.shifts.map((shift, index) => ({
        id: `__generation_pa__:${index}`, eventId: event.id, eventDayId: eventDay.id,
        stageId: shift.stageId, role: shift.role, memberId: shift.memberId,
        from: toInternalBoundary(shift.fromBoundary, internalIds),
        until: toInternalBoundary(shift.untilBoundary, internalIds),
      }))
      const paIssues = detectScheduleIssues({
        event, members, eventMembers, eventMemberDays: targetMemberDays,
        eventBands: targetBands, stages: targetStages, sections: targetSections,
        paAssignments: plannedAssignments, dutyTypes, dutyAssignments: targetDuties,
        calculatedItems,
      })
      if (paIssues.some(issue => issue.severity === 'ERROR')) {
        setLastFailure('NO_FEASIBLE_SCHEDULE')
        continue
      }
      const pa = buildPaActivities(plannedAssignments, calculatedItems)
      if (pa.unresolved.length > 0) {
        setLastFailure('NO_FEASIBLE_SCHEDULE')
        continue
      }
      const activityResult = evaluateActivities(
        [...baseActivities, ...pa.activities], calculatedItems, activitySpacingPolicy,
      )
      if (!activityResult.feasible) {
        setLastFailure('NO_FEASIBLE_SCHEDULE')
        continue
      }
      const balance = getExactSectionBalance(targetStages, targetSections, calculatedItems)
      const score: ExactTimetableGenerationScore = {
        lastResortActivityCount: activityResult.lastResortCount,
        schedulingSoftPenalty: getExactSchedulingSoftPenalty(constraints.softViolations),
        activitySpacingPenalty: activityResult.penalty,
        sectionDurationImbalance: balance.durationImbalance,
        paMainWorkloadImbalance: getExactPaWorkloadImbalance(
          'main', paPlan.shifts, paPlan.eligibleMemberIds.main,
        ),
        paSubWorkloadImbalance: getExactPaWorkloadImbalance(
          'sub', paPlan.shifts, paPlan.eligibleMemberIds.sub,
        ),
        sectionBandCountImbalance: balance.bandCountImbalance,
        undecidedPaShiftCount: paPlan.undecidedCount,
      }
      const candidateKey = `${proposal.key}|${paPlan.shifts.map(shift =>
        `${shift.stageId}:${shift.sectionId ?? ''}:${shift.role}:${shift.memberId}`).join('|')}`
      if (!bestExactScore || compareExactTimetableGenerationScores(score, bestExactScore) < 0 ||
        (compareExactTimetableGenerationScores(score, bestExactScore) === 0 &&
          candidateKey < bestKey)) {
        best = {
          eventDayId: eventDay.id,
          placements: proposal.placements,
          breaks: proposal.breaks,
          paShifts: paPlan.shifts,
          score: toPublicTimetableGenerationScore(score),
          diagnostics: {
            scheduleCandidatesEvaluated: attemptedSchedules,
            paPlansEvaluated,
            schedulingSoftViolations: constraints.softViolations,
          },
        }
        bestKey = candidateKey
        bestExactScore = score
      }
    }
    if (bestExactScore && isPerfectScore(bestExactScore)) break
  }
  if (best) return { ok: true, plan: {
    ...best,
    diagnostics: {
      ...best.diagnostics,
      scheduleCandidatesEvaluated: attemptedSchedules,
      paPlansEvaluated,
    },
  } }
  if (!scheduleSearchLimitReached &&
    attemptedSchedules === 0 && seen.size === 0 && targetBands.length > 0) {
    return failure('NO_FEASIBLE_SCHEDULE', attemptedSchedules)
  }
  return failure(
    paSearchLimitReached || scheduleSearchLimitReached
      ? 'SEARCH_LIMIT_REACHED' : lastFailure,
    attemptedSchedules, paSearchLimitReached ? paSearchLimitReferences : lastFailureReferences,
  )
}
