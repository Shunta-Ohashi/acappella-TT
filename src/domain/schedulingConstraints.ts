import type {
  Event,
  EventBand,
  EventBandId,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  ScheduleItem,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  StageId,
  TimeRange,
} from './models'
import {
  detectScheduleIssues,
  getPerformanceParticipationIssue,
  getPerformanceSequenceIssues,
  getUntimedPerformancePlacementIssues,
  type PerformanceSequenceItem,
  type ScheduleIssue,
  type ScheduleIssueCode,
} from './issues.ts'
import {
  getInvalidSectionScheduleItemIds,
  getSectionsForStage,
  getStageScheduleItems,
  getStagesForEventDay,
  isValidScheduleItemSectionAssignment,
} from './schedule.ts'
import {
  calculateStageTimeline,
  parseLocalTimeToMinute,
  type CalculatedScheduleItem,
} from './timeline.ts'

const HARD_ISSUE_CODES = [
  'MEMBER_NOT_REGISTERED_FOR_EVENT',
  'MEMBER_DAY_NOT_CONFIGURED',
  'MEMBER_ABSENT',
  'OUTSIDE_MEMBER_AVAILABILITY',
  'OUTSIDE_BAND_AVAILABILITY',
  'EVENT_BAND_DAY_MISMATCH',
  'FIXED_STAGE_MISMATCH',
  'FIXED_SECTION_MISMATCH',
  'FIXED_POSITION_MISMATCH',
  'FIXED_START_TIME_MISMATCH',
  'PERFORMANCE_OVERLAP',
  'STAGE_END_EXCEEDED',
  'SECTION_END_EXCEEDED',
  'SECTION_START_CONFLICT',
] as const satisfies readonly ScheduleIssueCode[]

const SOFT_ISSUE_CODES = [
  'BACK_TO_BACK',
  'SHORT_GAP',
  'SHORT_REST',
  'PREFERENCE_NOT_MET',
  'MEMBER_PARTICIPATION_UNDECIDED',
] as const satisfies readonly ScheduleIssueCode[]

type HardIssueCode = typeof HARD_ISSUE_CODES[number]
type SoftIssueCode = typeof SOFT_ISSUE_CODES[number]
const hardIssueCodeSet: ReadonlySet<ScheduleIssueCode> = new Set(HARD_ISSUE_CODES)
const softIssueCodeSet: ReadonlySet<ScheduleIssueCode> = new Set(SOFT_ISSUE_CODES)
const isHardIssueCode = (code: ScheduleIssueCode): code is HardIssueCode =>
  hardIssueCodeSet.has(code)
const isSoftIssueCode = (code: ScheduleIssueCode): code is SoftIssueCode =>
  softIssueCodeSet.has(code)

const withoutSectionPlacement = (item: ScheduleItem): ScheduleItem => {
  const itemWithoutPlacement = {
    ...item,
  } as ScheduleItem & { afterSectionId?: SectionId }
  delete itemWithoutPlacement.sectionId
  delete itemWithoutPlacement.afterSectionId
  return itemWithoutPlacement as ScheduleItem
}

export type SchedulingConstraintCode =
  | 'DUPLICATE_EVENT_BAND'
  | 'INVALID_STAGE_ASSIGNMENT'
  | 'INVALID_SECTION_ASSIGNMENT'
  | 'EVENT_BAND_NOT_FOUND'
  | 'EVENT_BAND_EVENT_MISMATCH'
  | HardIssueCode
  | SoftIssueCode

interface ConstraintReferences {
  code: SchedulingConstraintCode
  eventDayIds?: EventDayId[]
  stageIds?: StageId[]
  sectionIds?: SectionId[]
  eventBandIds?: EventBandId[]
  memberIds?: MemberId[]
  scheduleItemIds?: ScheduleItemId[]
  amount?: number
  gapBands?: number
  restMinutes?: number
}

export interface HardConstraintViolation extends ConstraintReferences {
  severity: 'hard'
}

export interface SoftConstraintViolation extends ConstraintReferences {
  severity: 'soft'
  penalty: number
}

export interface SchedulingConstraintWeights {
  backToBack: number
  shortGapPerBand: number
  shortRestPerMinute: number
  preferredOutsidePerMinute: number
  undecided: number
}

export const DEFAULT_SCHEDULING_WEIGHTS: Readonly<SchedulingConstraintWeights> =
  Object.freeze({
    backToBack: 10,
    shortGapPerBand: 5,
    shortRestPerMinute: 1,
    preferredOutsidePerMinute: 1,
    undecided: 1,
  })

export interface EvaluateScheduleConstraintsInput {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  /** The candidate ScheduleItems for this Event, not all Events in the app. */
  scheduleItems: ScheduleItem[]
  weights?: Partial<SchedulingConstraintWeights>
}

export interface ScheduleConstraintEvaluation {
  feasible: boolean
  hardViolations: HardConstraintViolation[]
  softViolations: SoftConstraintViolation[]
  totalPenalty: number
}

const outsideRangeMinutes = (
  item: CalculatedScheduleItem,
  range: TimeRange,
): number => {
  const from = range.from === undefined ? 0 : parseLocalTimeToMinute(range.from)
  const until = range.until === undefined ? 1440 : parseLocalTimeToMinute(range.until)
  const inside = Math.max(0,
    Math.min(item.plannedEndMinute, until) -
    Math.max(item.plannedStartMinute, from),
  )
  return Math.max(0, item.plannedEndMinute - item.plannedStartMinute - inside)
}

const sortViolations = <T extends ConstraintReferences>(
  violations: T[],
  eventDays: EventDay[],
  stages: Stage[],
  calculatedItems: CalculatedScheduleItem[],
  scheduleItems: ScheduleItem[],
): T[] => {
  const dayById = new Map(eventDays.map((day) => [day.id, day]))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const calculatedById = new Map(calculatedItems.map((item) => [item.scheduleItemId, item]))
  const scheduleItemById = new Map(scheduleItems.map((item) => [item.id, item]))
  const key = (violation: T): string => {
    const firstItem = calculatedById.get(violation.scheduleItemIds?.[0] ?? '')
    const sourceItem = scheduleItemById.get(violation.scheduleItemIds?.[0] ?? '')
    const stage = stageById.get(
      violation.stageIds?.[0] ?? firstItem?.stageId ?? sourceItem?.stageId ?? '',
    )
    const day = dayById.get(violation.eventDayIds?.[0] ?? stage?.eventDayId ?? '')
    return [
      String(day?.order ?? Number.MAX_SAFE_INTEGER).padStart(16, '0'),
      day?.id ?? '',
      String(stage?.order ?? Number.MAX_SAFE_INTEGER).padStart(16, '0'),
      stage?.id ?? '',
      String(firstItem?.plannedStartMinute ?? Number.MAX_SAFE_INTEGER).padStart(16, '0'),
      violation.code,
      [...(violation.memberIds ?? [])].sort().join(','),
      [...(violation.eventBandIds ?? [])].sort().join(','),
      [...(violation.scheduleItemIds ?? [])].sort().join(','),
    ].join('|')
  }
  return violations.sort((first, second) => key(first).localeCompare(key(second)))
}

export const evaluateScheduleConstraints = ({
  event,
  eventDays,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  scheduleItems,
  weights: weightOverrides,
}: EvaluateScheduleConstraintsInput): ScheduleConstraintEvaluation => {
  const weights = { ...DEFAULT_SCHEDULING_WEIGHTS, ...weightOverrides }
  if (Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new RangeError('Constraint weights must be finite and non-negative')
  }

  const selectedDays = eventDays
    .filter((day) => day.eventId === event.id)
    .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id))
  const selectedDayIds = new Set(selectedDays.map((day) => day.id))
  const selectedStages = stages.filter((stage) => selectedDayIds.has(stage.eventDayId))
  const stageById = new Map(selectedStages.map((stage) => [stage.id, stage]))
  const selectedEventBands = eventBands.filter((band) => band.eventId === event.id)
  const eventBandById = new Map(eventBands.map((band) => [band.id, band]))
  const calculatedItems: CalculatedScheduleItem[] = []
  const untimedSequenceGroups: PerformanceSequenceItem[][] = []
  const hardViolations: HardConstraintViolation[] = []
  const softViolations: SoftConstraintViolation[] = []

  const scheduledByBand = new Map<EventBandId, ScheduleItemId[]>()
  const calculableItems: ScheduleItem[] = []
  const placementCheckableItems: ScheduleItem[] = []
  for (const item of scheduleItems) {
    let hasValidEventBand = item.kind === 'break'
    const stage = stageById.get(item.stageId)
    if (!stage) {
      hardViolations.push({
        severity: 'hard', code: 'INVALID_STAGE_ASSIGNMENT',
        stageIds: [item.stageId], scheduleItemIds: [item.id],
      })
      const stageSections = sections.filter(
        (section) => section.stageId === item.stageId,
      )
      if (!isValidScheduleItemSectionAssignment(item.stageId, stageSections, item)) {
        hardViolations.push({
          severity: 'hard', code: 'INVALID_SECTION_ASSIGNMENT',
          stageIds: [item.stageId],
          ...(item.sectionId !== undefined ? { sectionIds: [item.sectionId] } : {}),
          scheduleItemIds: [item.id],
        })
      }
    }
    if (item.kind === 'performance') {
      const band = eventBandById.get(item.eventBandId)
      if (!band || band.eventId !== event.id) {
        hardViolations.push({
          severity: 'hard',
          code: band ? 'EVENT_BAND_EVENT_MISMATCH' : 'EVENT_BAND_NOT_FOUND',
          ...(stage ? { eventDayIds: [stage.eventDayId] } : {}),
          stageIds: [item.stageId],
          eventBandIds: [item.eventBandId], scheduleItemIds: [item.id],
        })
      } else {
        hasValidEventBand = true
        const scheduled = scheduledByBand.get(item.eventBandId) ?? []
        scheduled.push(item.id)
        scheduledByBand.set(item.eventBandId, scheduled)
        placementCheckableItems.push(item)
        if (!stage && !selectedDayIds.has(band.eventDayId)) {
          hardViolations.push({
            severity: 'hard', code: 'EVENT_BAND_DAY_MISMATCH',
            eventBandIds: [band.id], scheduleItemIds: [item.id],
          })
        }
      }
    }
    if (stage && hasValidEventBand) calculableItems.push(item)
  }

  for (const [eventBandId, itemIds] of scheduledByBand) {
    if (itemIds.length > 1) {
      const eventDayId = eventBandById.get(eventBandId)?.eventDayId
      hardViolations.push({
        severity: 'hard', code: 'DUPLICATE_EVENT_BAND',
        ...(eventDayId ? { eventDayIds: [eventDayId] } : {}),
        eventBandIds: [eventBandId], scheduleItemIds: [...itemIds].sort(),
        amount: itemIds.length - 1,
      })
    }
  }

  const resolvableItemIds = new Set(calculableItems.map((item) => item.id))
  const invalidStageIds = new Set(
    scheduleItems
      .filter((item) => !stageById.has(item.stageId))
      .map((item) => item.stageId),
  )
  const getTrustedMissingStageSequence = (
    performanceItems: Extract<ScheduleItem, { kind: 'performance' }>[],
    requireSingleEventDay: boolean,
  ): PerformanceSequenceItem[] | undefined => {
    const sequenceItems = performanceItems.map((item) => {
      const band = eventBandById.get(item.eventBandId)
      return band?.eventId === event.id && selectedDayIds.has(band.eventDayId)
        ? {
            scheduleItemId: item.id,
            eventDayId: band.eventDayId,
            stageId: item.stageId,
            sectionId: item.sectionId,
            eventBandId: item.eventBandId,
          }
        : undefined
    })
    if (sequenceItems.some((item) => item === undefined)) return undefined
    const trustedItems = sequenceItems.filter((item) => item !== undefined)
    if (
      requireSingleEventDay &&
      new Set(trustedItems.map((item) => item.eventDayId)).size > 1
    ) return undefined
    return trustedItems
  }
  invalidStageIds.forEach((stageId) => {
    const stageItems = getStageScheduleItems(scheduleItems, stageId)
    const stageSections = sections
      .filter((section) => section.stageId === stageId)
      .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id))
    const stageUsesSections = stageSections.length > 0
    // Section records are the source of truth even when the Stage reference is
    // missing. Exclude ambiguous assignments instead of treating them as one
    // sectionless Stage lane; valid Section lanes remain independently usable.
    if (stageUsesSections) {
      stageSections.forEach((section) => {
        const lanePerformances = stageItems.filter(
          (item): item is Extract<ScheduleItem, { kind: 'performance' }> =>
          item.kind === 'performance' &&
          item.sectionId === section.id &&
          isValidScheduleItemSectionAssignment(stageId, stageSections, item),
        )
        const sequence = getTrustedMissingStageSequence(lanePerformances, true)
        if (sequence?.length) untimedSequenceGroups.push(sequence)
      })
      return
    }
    if (stageItems.some((item) => item.sectionId !== undefined)) return
    const performanceItems = stageItems.filter(
      (item) => item.kind === 'performance',
    )
    // A sectionless missing Stage is one lane. An unknown EventDay can affect
    // any position in it, so keep the conservative Stage-level skip here.
    const sequence = getTrustedMissingStageSequence(performanceItems, false)
    if (sequence?.length) untimedSequenceGroups.push(sequence)
  })
  for (const day of selectedDays) {
    for (const stage of getStagesForEventDay(selectedStages, day.id)) {
      const stageSections = getSectionsForStage(sections, stage.id)
      const stageItems = getStageScheduleItems(scheduleItems, stage.id)
      const invalidIds = getInvalidSectionScheduleItemIds(
        stage, stageSections, stageItems,
      )
      if (invalidIds.length > 0) {
        hardViolations.push({
          severity: 'hard', code: 'INVALID_SECTION_ASSIGNMENT',
          eventDayIds: [day.id], stageIds: [stage.id],
          scheduleItemIds: [...invalidIds].sort(),
        })
      }

      // A Sectioned Stage never places an invalid item in a valid lane, so
      // excluding it cannot shift the remaining lane's timeline. Without
      // Sections, every item affects the one sequence: retain its duration,
      // but strip the already-reported invalid placement before Timeline
      // performs its own placement validation.
      const invalidIdSet = new Set(invalidIds)
      const timedItems = stageSections.length === 0
        ? stageItems.map((item) => invalidIdSet.has(item.id)
            ? withoutSectionPlacement(item)
            : item)
        : stageItems.filter((item) => !invalidIdSet.has(item.id))
      // An unresolved EventBand has no reliable duration. Do not invent
      // start times for the rest of this Stage by dropping that item.
      if (timedItems.some((item) => !resolvableItemIds.has(item.id))) {
        // Invalid Section assignments are excluded from timedItems, so the
        // remaining valid lanes still have an unambiguous raw order.
        const orderedItems = stageSections.length === 0
          ? timedItems
          : stageSections.flatMap((section) =>
              timedItems.filter((item) => item.sectionId === section.id))
        const sequence = orderedItems
          .filter((item) => item.kind === 'performance')
          .map((item) => ({
            scheduleItemId: item.id,
            eventDayId: stage.eventDayId,
            stageId: item.stageId,
            sectionId: item.sectionId,
            eventBandId: item.eventBandId,
          }))
        if (sequence.length) untimedSequenceGroups.push(sequence)
        continue
      }

      calculatedItems.push(...calculateStageTimeline({
        event,
        stage,
        sections: stageSections,
        scheduleItems: timedItems,
        eventBands: selectedEventBands,
      }))
    }
  }

  const calculatedById = new Map(calculatedItems.map((item) => [item.scheduleItemId, item]))
  const scheduleItemById = new Map(scheduleItems.map((item) => [item.id, item]))
  const eventMemberByMemberId = new Map(
    eventMembers
      .filter((member) => member.eventId === event.id)
      .map((member) => [member.memberId, member]),
  )
  const eventMemberDayByKey = new Map(eventMemberDays.map((day) => [
    `${day.eventMemberId}:${day.eventDayId}`, day,
  ]))

  const untimedIssues: ScheduleIssue[] = []
  untimedSequenceGroups.forEach((performances) => {
    untimedIssues.push(...getPerformanceSequenceIssues({
      performances,
      eventBands: selectedEventBands,
      minimumGapBands: event.validationPolicy.minimumGapBands,
    }))
  })
  for (const item of placementCheckableItems) {
    if (item.kind !== 'performance' || calculatedById.has(item.id)) continue
    const stage = stageById.get(item.stageId)
    const band = eventBandById.get(item.eventBandId)
    if (!band) continue
    untimedIssues.push(...getUntimedPerformancePlacementIssues(band, {
      scheduleItemId: item.id,
      eventDayId: stage?.eventDayId,
      stageId: item.stageId,
      sectionId: item.sectionId,
    }))
    const participationEventDayId = stage?.eventDayId ?? band.eventDayId
    for (const memberId of new Set(band.memberIds)) {
      const eventMember = eventMemberByMemberId.get(memberId)
      const participationIssue = getPerformanceParticipationIssue({
        memberId,
        eventBandId: band.id,
        scheduleItemId: item.id,
        eventMember,
        eventMemberDay: eventMember
          ? eventMemberDayByKey.get(`${eventMember.id}:${participationEventDayId}`)
          : undefined,
      })
      if (participationIssue) untimedIssues.push(participationIssue)
    }
  }

  const preferenceOutsideMinutes = (issue: ScheduleIssue): number => {
    const item = calculatedById.get(issue.scheduleItemIds?.[0] ?? '')
    if (!item) return 1
    const memberId = issue.memberIds?.[0]
    const eventMember = memberId && eventMemberByMemberId.get(memberId)
    const range = eventMember
      ? eventMemberDayByKey.get(`${eventMember.id}:${item.eventDayId}`)?.preferredTimeRange
      : eventBandById.get(issue.eventBandIds?.[0] ?? '')?.preferredTimeRange
    return range ? outsideRangeMinutes(item, range) : 1
  }

  const issues = detectScheduleIssues({
    event,
    members,
    eventMembers,
    eventMemberDays,
    eventBands: selectedEventBands,
    stages: selectedStages,
    sections,
    paAssignments: [],
    dutyTypes: [],
    dutyAssignments: [],
    calculatedItems,
  }).concat(untimedIssues)

  const referencesForIssue = (issue: ScheduleIssue): Omit<ConstraintReferences, 'code'> => {
    const days = new Set(issue.eventDayIds ?? [])
    issue.stageIds?.forEach((id) => {
      const dayId = stageById.get(id)?.eventDayId
      if (dayId) days.add(dayId)
    })
    issue.scheduleItemIds?.forEach((id) => {
      const dayId = calculatedById.get(id)?.eventDayId ??
        stageById.get(scheduleItemById.get(id)?.stageId ?? '')
          ?.eventDayId
      if (dayId) days.add(dayId)
    })
    return {
      ...(days.size ? { eventDayIds: [...days].sort() } : {}),
      ...(issue.stageIds ? { stageIds: issue.stageIds } : {}),
      ...(issue.sectionIds ? { sectionIds: issue.sectionIds } : {}),
      ...(issue.eventBandIds ? { eventBandIds: issue.eventBandIds } : {}),
      ...(issue.memberIds ? { memberIds: issue.memberIds } : {}),
      ...(issue.scheduleItemIds ? { scheduleItemIds: issue.scheduleItemIds } : {}),
      ...(issue.gapBands !== undefined ? { gapBands: issue.gapBands } : {}),
      ...(issue.restMinutes !== undefined ? { restMinutes: issue.restMinutes } : {}),
      ...(issue.overrunMinutes !== undefined ? { amount: issue.overrunMinutes } : {}),
    }
  }

  for (const issue of issues) {
    if (isHardIssueCode(issue.code)) {
      hardViolations.push({
        severity: 'hard', code: issue.code,
        ...referencesForIssue(issue),
      })
      continue
    }
    if (!isSoftIssueCode(issue.code)) continue

    const amount = issue.code === 'BACK_TO_BACK' ? 1
      : issue.code === 'SHORT_GAP'
        ? event.validationPolicy.minimumGapBands - (issue.gapBands ?? 0)
        : issue.code === 'SHORT_REST'
          ? event.validationPolicy.minimumRestMinutes - (issue.restMinutes ?? 0)
          : issue.code === 'PREFERENCE_NOT_MET'
            ? preferenceOutsideMinutes(issue)
            : 1
    const weight = issue.code === 'BACK_TO_BACK' ? weights.backToBack
      : issue.code === 'SHORT_GAP' ? weights.shortGapPerBand
        : issue.code === 'SHORT_REST' ? weights.shortRestPerMinute
          : issue.code === 'PREFERENCE_NOT_MET' ? weights.preferredOutsidePerMinute
            : weights.undecided
    softViolations.push({
      severity: 'soft', code: issue.code,
      ...referencesForIssue(issue), amount, penalty: amount * weight,
    })
  }

  sortViolations(hardViolations, selectedDays, selectedStages, calculatedItems, scheduleItems)
  sortViolations(softViolations, selectedDays, selectedStages, calculatedItems, scheduleItems)
  return {
    feasible: hardViolations.length === 0,
    hardViolations,
    softViolations,
    totalPenalty: softViolations.reduce((total, violation) => total + violation.penalty, 0),
  }
}
