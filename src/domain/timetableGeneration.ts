import type {
  DutyAssignment, DutyType, Event, EventBand, EventDay, EventMember,
  EventMemberDay, Member, PaAssignment, ScheduleItem, Section, SectionId,
  Stage, StageId, TimetableLock,
} from './models'
import {
  buildDutyActivities, buildPaActivities, buildPerformanceActivities,
  evaluateMemberActivitySpacing, validateActivitySpacingPolicy,
  type ActivitySpacingPolicy,
  type MemberActivity,
} from './activitySpacing.ts'
import { isValidBreakDurationMinutes, isValidScheduleLane, compareScheduleItemOrder } from './schedule.ts'
import { evaluateScheduleConstraints, type ScheduleConstraintEvaluation } from './schedulingConstraints.ts'
import { calculateEventDayTimelines } from './timetable.ts'
import { evaluateTimetableLocks } from './timetableLocks.ts'
import { detectScheduleIssues } from './issues.ts'
import { isValidStageTimeRange, isSectionWithinStageTimeRange } from './eventStageSettings.ts'
import { isValidLocalTime, parseLocalTimeToMinute,
  type CalculatedScheduleItem } from './timeline.ts'
import { planPaShifts, type PlannedPaShift, type PlannedPaShiftScope,
  type PlannedScheduleBoundary } from './paShiftPlanning.ts'
import {
  compareTimetableGenerationScores, getPaWorkloadImbalance,
  getSectionBalance, type TimetableGenerationScore,
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
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  activitySpacingPolicy?: ActivitySpacingPolicy
  options?: Partial<TimetableGenerationOptions>
}

export interface TimetableGenerationOptions {
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
  | 'INVALID_INPUT' | 'INVALID_LOCK_CONSTRAINTS' | 'BROKEN_DUTY_ASSIGNMENT'
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
  estimatedMinutes: number
  capacityMinutes?: number
}

interface ScheduleProposal {
  items: ScheduleItem[]
  placements: PlannedBandPlacement[]
  breaks: PlannedBreakPlacement[]
  internalItemIdByBand: Map<string, string>
  key: string
}

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
      estimatedMinutes: laneBreaks.reduce((sum, item) => sum + item.durationMinutes, 0),
      ...(until ? { capacityMinutes: parseLocalTimeToMinute(until) - from } : {}),
    }
  })
})

const orderStageBands = (
  lanes: GenerationLane[],
  assigned: Map<string, EventBand[]>,
  allowedLaneKeysByBand: Map<string, Set<string>>,
  locksByBand: Map<string, TimetableLock>,
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
      ordered.set(lane.key, (indexesByLane.get(lane.key) ?? [])
        .map(index => slots[index]).filter((band): band is EventBand => band !== undefined))
    }
  }
  return ordered
}

const buildProposal = ({
  variant, bands, lanes, originalItems, targetStageIds, existingByBand,
  allowedLaneKeysByBand, locksByBand, internalIds,
}: {
  variant: number
  bands: EventBand[]
  lanes: GenerationLane[]
  originalItems: ScheduleItem[]
  targetStageIds: Set<StageId>
  existingByBand: Map<string, Extract<ScheduleItem, { kind: 'performance' }>>
  allowedLaneKeysByBand: Map<string, Set<string>>
  locksByBand: Map<string, TimetableLock>
  internalIds: Map<string, string>
}): ScheduleProposal | undefined => {
  const laneByKey = new Map(lanes.map(lane => [lane.key, lane]))
  const assigned = new Map(lanes.map(lane => [lane.key, [] as EventBand[]]))
  const load = new Map(lanes.map(lane => [lane.key, lane.estimatedMinutes]))
  const defaultCapacity = Math.max(1,
    (bands.reduce((sum, band) => sum + band.durationMinutes, 0) +
      lanes.reduce((sum, lane) => sum + lane.estimatedMinutes, 0)) / Math.max(1, lanes.length))
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
    load.set(key, (load.get(key) ?? 0) + band.durationMinutes)
  }
  for (const band of rotated) {
    const allowed = allowedLaneKeysByBand.get(band.id)
    const choices = lanes.filter(lane => !allowed || allowed.has(lane.key)).sort((left, right) => {
      const leftLoad = (load.get(left.key) ?? 0) + band.durationMinutes
      const rightLoad = (load.get(right.key) ?? 0) + band.durationMinutes
      const leftRatio = leftLoad / (left.capacityMinutes && left.capacityMinutes > 0
        ? left.capacityMinutes : defaultCapacity)
      const rightRatio = rightLoad / (right.capacityMinutes && right.capacityMinutes > 0
        ? right.capacityMinutes : defaultCapacity)
      return leftRatio - rightRatio ||
        ((lanes.indexOf(left) + variant) % lanes.length) -
          ((lanes.indexOf(right) + variant) % lanes.length)
    })
    const chosen = choices[0]
    if (!chosen) return undefined
    assigned.get(chosen.key)?.push(band)
    load.set(chosen.key, (load.get(chosen.key) ?? 0) + band.durationMinutes)
  }
  const orderedByLane = orderStageBands(lanes, assigned, allowedLaneKeysByBand, locksByBand, variant)
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
          ...(breakItem.sectionId ? { sectionId: breakItem.sectionId } : {}), order,
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
  calculatedItems: CalculatedScheduleItem[],
  internalIds: Map<string, string>,
): PlannedPaShiftScope[] => {
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
    return [{
      key: lane.key,
      eventDayId: lane.stage.eventDayId,
      stageId: lane.stage.id,
      ...(lane.section ? { sectionId: lane.section.id } : {}),
      fromMinute: first.plannedStartMinute,
      untilMinute: last.plannedEndMinute,
      fromBoundary: boundary(first, 'start'),
      untilBoundary: boundary(last, 'end'),
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

const isPerfectScore = (score: TimetableGenerationScore): boolean =>
  Object.values(score).every(value => value === 0)

const isValidTransitionMinutes = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

export const generateTimetablePlan = (input: TimetableGenerationInput): TimetableGenerationResult => {
  const {
    event, eventDay, eventDays, stages, sections, members, eventMembers,
    eventMemberDays, eventBands, scheduleItems, timetableLocks, dutyTypes,
    dutyAssignments, activitySpacingPolicy,
  } = input
  const options = { ...DEFAULT_OPTIONS, ...input.options }
  const failure = (code: TimetableGenerationFailureCode, attemptedSchedules: number,
    references: Partial<Pick<TimetableGenerationFailure,
      'stageId' | 'sectionId' | 'eventBandId'>> = {}): TimetableGenerationResult => ({
    ok: false, failure: { code, eventDayId: eventDay.id, attemptedSchedules, ...references },
  })
  if (eventDay.eventId !== event.id ||
    !eventDays.some(day => day.id === eventDay.id && day.eventId === event.id) ||
    !isValidTransitionMinutes(event.defaultTransitionMinutes) ||
    Object.values(options).some(value => !Number.isSafeInteger(value) || value < 1)) {
    return failure('INVALID_INPUT', 0)
  }
  if (activitySpacingPolicy) {
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
  const targetMemberDays = eventMemberDays.filter(day => day.eventDayId === eventDay.id)
  const targetBands = eventBands.filter(band =>
    band.eventId === event.id && band.eventDayId === eventDay.id,
  ).sort((left, right) => left.id.localeCompare(right.id))
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
        ...(item.sectionId ? { sectionId: item.sectionId } : {}),
        ...(item.afterSectionId ? { afterSectionId: item.afterSectionId } : {}),
      })) return failure('INVALID_INPUT', 0, { stageId: item.stageId })
  }
  const targetBandIds = new Set(targetBands.map(band => band.id))
  const existingByBand = new Map<string, Extract<ScheduleItem, { kind: 'performance' }>>()
  for (const item of eventScheduleItems) {
    if (item.kind !== 'performance') continue
    if (targetBandIds.has(item.eventBandId)) {
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
    if (allowed.size === 0 || (lockKey && (!laneByKey.has(lockKey) || !allowed.has(lockKey)))) {
      return failure('INVALID_LOCK_CONSTRAINTS', 0, { eventBandId: band.id })
    }
    if (lockKey) allowedLaneKeysByBand.set(band.id, new Set([lockKey]))
    else if (fixed) allowedLaneKeysByBand.set(band.id, allowed)
  }
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
  const targetDuties = dutyAssignments.filter(item => item.eventDayId === eventDay.id)
  const dutyTypeIds = new Set(dutyTypes.filter(type => type.eventId === event.id)
    .map(type => type.id))
  for (const duty of targetDuties) {
    if (!dutyTypeIds.has(duty.dutyTypeId) ||
      !itemById.has(duty.from.scheduleItemId) ||
      !itemById.has(duty.until.scheduleItemId) ||
      !targetStageIds.has(duty.stageId)) {
      return failure('BROKEN_DUTY_ASSIGNMENT', 0, { stageId: duty.stageId })
    }
  }
  let best: TimetableGenerationPlan | undefined
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
  const scheduleSearchLimitReached = variants > options.maxScheduleCandidates
  const seen = new Set<string>()
  for (let variant = 0; variant < Math.min(variants, options.maxScheduleCandidates); variant += 1) {
    const proposal = buildProposal({
      variant, bands: targetBands, lanes, originalItems: eventScheduleItems,
      targetStageIds, existingByBand, allowedLaneKeysByBand, locksByBand, internalIds,
    })
    if (!proposal || seen.has(proposal.key)) continue
    seen.add(proposal.key)
    attemptedSchedules += 1
    const targetProposalItems = proposal.items.filter(item => targetStageIds.has(item.stageId))
    const locks = evaluateTimetableLocks({
      eventId: event.id, timetableLocks: targetLocks, scheduleItems: targetProposalItems,
      eventBands: lockEvaluationBands, eventDays: [eventDay],
      stages: targetStages, sections: targetSections,
    })
    if (!locks.valid) continue
    const constraints = evaluateScheduleConstraints({
      event, eventDays: [eventDay], stages: targetStages, sections: targetSections,
      members, eventMembers, eventMemberDays: targetMemberDays,
      eventBands: targetBands, scheduleItems: targetProposalItems,
    })
    if (!constraints.feasible) continue
    let timeline: ReturnType<typeof calculateEventDayTimelines>
    try {
      timeline = calculateEventDayTimelines({
        event, eventDayId: eventDay.id, stages: targetStages, sections: targetSections,
        scheduleItems: targetProposalItems, eventBands: targetBands,
      })
    } catch {
      continue
    }
    if (timeline.invalidStages.length > 0) continue
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
      continue
    }
    const performance = buildPerformanceActivities(calculatedItems, targetBands)
    const duty = buildDutyActivities(targetDuties, calculatedItems)
    if (duty.unresolved.length > 0) {
      const assignment = targetDuties.find(item => item.id === duty.unresolved[0].id)
      setLastFailure('BROKEN_DUTY_ASSIGNMENT', assignment ? { stageId: assignment.stageId } : {})
      continue
    }
    if (performance.unresolved.length > 0) continue
    const baseActivities = [...performance.activities, ...duty.activities]
    if (!evaluateActivities(baseActivities, calculatedItems, activitySpacingPolicy).feasible) continue
    const scopes = getShiftScopes(lanes, calculatedItems, internalIds)
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
      if (paIssues.some(issue => issue.severity === 'ERROR')) continue
      const pa = buildPaActivities(plannedAssignments, calculatedItems)
      if (pa.unresolved.length > 0) continue
      const activityResult = evaluateActivities(
        [...baseActivities, ...pa.activities], calculatedItems, activitySpacingPolicy,
      )
      if (!activityResult.feasible) continue
      const balance = getSectionBalance(targetStages, targetSections, calculatedItems)
      const score: TimetableGenerationScore = {
        lastResortActivityCount: activityResult.lastResortCount,
        schedulingSoftPenalty: constraints.totalPenalty,
        activitySpacingPenalty: activityResult.penalty,
        sectionDurationImbalance: balance.durationImbalance,
        paMainWorkloadImbalance: getPaWorkloadImbalance(
          'main', paPlan.shifts, paPlan.eligibleMemberIds.main,
        ),
        paSubWorkloadImbalance: getPaWorkloadImbalance(
          'sub', paPlan.shifts, paPlan.eligibleMemberIds.sub,
        ),
        sectionBandCountImbalance: balance.bandCountImbalance,
        undecidedPaShiftCount: paPlan.undecidedCount,
      }
      const candidateKey = `${proposal.key}|${paPlan.shifts.map(shift =>
        `${shift.stageId}:${shift.sectionId ?? ''}:${shift.role}:${shift.memberId}`).join('|')}`
      if (!best || compareTimetableGenerationScores(score, best.score) < 0 ||
        (compareTimetableGenerationScores(score, best.score) === 0 &&
          candidateKey < bestKey)) {
        best = {
          eventDayId: eventDay.id,
          placements: proposal.placements,
          breaks: proposal.breaks,
          paShifts: paPlan.shifts,
          score,
          diagnostics: {
            scheduleCandidatesEvaluated: attemptedSchedules,
            paPlansEvaluated,
            schedulingSoftViolations: constraints.softViolations,
          },
        }
        bestKey = candidateKey
      }
    }
    if (best && isPerfectScore(best.score)) break
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
