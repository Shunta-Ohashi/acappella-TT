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
  type ScheduleIssue,
  type ScheduleIssueCode,
} from './issues.ts'
import { calculateEventDayTimelines } from './timetable.ts'
import { parseLocalTimeToMinute, type CalculatedScheduleItem } from './timeline.ts'

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
): T[] => {
  const dayById = new Map(eventDays.map((day) => [day.id, day]))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const calculatedById = new Map(calculatedItems.map((item) => [item.scheduleItemId, item]))
  const key = (violation: T): string => {
    const firstItem = calculatedById.get(violation.scheduleItemIds?.[0] ?? '')
    const stage = stageById.get(violation.stageIds?.[0] ?? firstItem?.stageId ?? '')
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
  const hardViolations: HardConstraintViolation[] = []
  const softViolations: SoftConstraintViolation[] = []

  const scheduledByBand = new Map<EventBandId, ScheduleItemId[]>()
  const calculableItems: ScheduleItem[] = []
  for (const item of scheduleItems) {
    if (item.kind === 'performance') {
      const scheduled = scheduledByBand.get(item.eventBandId) ?? []
      scheduled.push(item.id)
      scheduledByBand.set(item.eventBandId, scheduled)
    }
    const stage = stageById.get(item.stageId)
    if (!stage) {
      hardViolations.push({
        severity: 'hard', code: 'INVALID_STAGE_ASSIGNMENT',
        stageIds: [item.stageId], scheduleItemIds: [item.id],
      })
      continue
    }
    if (item.kind === 'performance') {
      const band = eventBandById.get(item.eventBandId)
      if (!band || band.eventId !== event.id) {
        hardViolations.push({
          severity: 'hard',
          code: band ? 'EVENT_BAND_EVENT_MISMATCH' : 'EVENT_BAND_NOT_FOUND',
          eventDayIds: [stage.eventDayId], stageIds: [stage.id],
          eventBandIds: [item.eventBandId], scheduleItemIds: [item.id],
        })
        continue
      }
    }
    calculableItems.push(item)
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

  for (const day of selectedDays) {
    const timeline = calculateEventDayTimelines({
      event,
      eventDayId: day.id,
      stages: selectedStages,
      sections,
      scheduleItems: calculableItems,
      eventBands: selectedEventBands,
    })
    calculatedItems.push(...timeline.calculatedItems)
    for (const invalid of timeline.invalidStages) {
      hardViolations.push({
        severity: 'hard', code: 'INVALID_SECTION_ASSIGNMENT',
        eventDayIds: [day.id], stageIds: [invalid.stageId],
        scheduleItemIds: [...invalid.scheduleItemIds].sort(),
      })
    }
  }

  const calculatedById = new Map(calculatedItems.map((item) => [item.scheduleItemId, item]))
  const eventMemberByMemberId = new Map(
    eventMembers
      .filter((member) => member.eventId === event.id)
      .map((member) => [member.memberId, member]),
  )
  const eventMemberDayByKey = new Map(eventMemberDays.map((day) => [
    `${day.eventMemberId}:${day.eventDayId}`, day,
  ]))

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
  })

  const referencesForIssue = (issue: ScheduleIssue): Omit<ConstraintReferences, 'code'> => {
    const days = new Set(issue.eventDayIds ?? [])
    issue.stageIds?.forEach((id) => {
      const dayId = stageById.get(id)?.eventDayId
      if (dayId) days.add(dayId)
    })
    issue.scheduleItemIds?.forEach((id) => {
      const dayId = calculatedById.get(id)?.eventDayId
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

  sortViolations(hardViolations, selectedDays, selectedStages, calculatedItems)
  sortViolations(softViolations, selectedDays, selectedStages, calculatedItems)
  return {
    feasible: hardViolations.length === 0,
    hardViolations,
    softViolations,
    totalPenalty: softViolations.reduce((total, violation) => total + violation.penalty, 0),
  }
}
