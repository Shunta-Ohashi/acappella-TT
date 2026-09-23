import type {
  Event,
  EventBand,
  EventBandId,
  DutyAssignment,
  DutyAssignmentId,
  DutyType,
  DutyTypeId,
  EventDayId,
  EventMember,
  EventMemberDay,
  EventMemberId,
  Member,
  MemberId,
  PaAssignment,
  PaAssignmentId,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  StageId,
  TimeRange,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import { parseLocalTimeToMinute } from './timeline.ts'
import { isIntervalWithinAvailabilityWindows } from './eventBandSettings.ts'
import {
  getOverlappingMemberPerformances,
  intervalsOverlap,
  resolvePaAssignmentInterval,
  type ResolvedPaAssignmentInterval,
} from './paAssignments.ts'
import {
  resolveDutyAssignmentInterval,
  type ResolvedDutyAssignmentInterval,
} from './dutyAssignments.ts'

export type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO'

export type ScheduleIssueCode =
  | 'MEMBER_NOT_REGISTERED_FOR_EVENT'
  | 'MEMBER_DAY_NOT_CONFIGURED'
  | 'MEMBER_ABSENT'
  | 'MEMBER_PARTICIPATION_UNDECIDED'
  | 'OUTSIDE_MEMBER_AVAILABILITY'
  | 'OUTSIDE_BAND_AVAILABILITY'
  | 'EVENT_BAND_DAY_MISMATCH'
  | 'FIXED_STAGE_MISMATCH'
  | 'FIXED_SECTION_MISMATCH'
  | 'FIXED_POSITION_MISMATCH'
  | 'FIXED_START_TIME_MISMATCH'
  | 'PA_CAPABILITY_MISMATCH'
  | 'PA_MEMBER_NOT_CONFIGURED'
  | 'PA_MEMBER_ABSENT'
  | 'PA_MEMBER_UNDECIDED'
  | 'PA_INVALID_BOUNDARY'
  | 'PA_OUTSIDE_MEMBER_AVAILABILITY'
  | 'PA_MEMBER_PERFORMANCE_OVERLAP'
  | 'PA_ASSIGNMENT_OVERLAP'
  | 'DUTY_TYPE_NOT_FOUND'
  | 'DUTY_MEMBER_NOT_CONFIGURED'
  | 'DUTY_MEMBER_ABSENT'
  | 'DUTY_MEMBER_UNDECIDED'
  | 'DUTY_INVALID_BOUNDARY'
  | 'DUTY_OUTSIDE_MEMBER_AVAILABILITY'
  | 'DUTY_MEMBER_PERFORMANCE_OVERLAP'
  | 'DUTY_ASSIGNMENT_OVERLAP'
  | 'DUTY_PA_OVERLAP'
  | 'PERFORMANCE_OVERLAP'
  | 'BACK_TO_BACK'
  | 'SHORT_GAP'
  | 'SHORT_REST'
  | 'STAGE_END_EXCEEDED'
  | 'SECTION_END_EXCEEDED'
  | 'SECTION_START_CONFLICT'
  | 'PREFERENCE_NOT_MET'

export interface ScheduleIssue {
  severity: IssueSeverity
  code: ScheduleIssueCode
  message: string
  memberIds?: MemberId[]
  eventBandIds?: EventBandId[]
  scheduleItemIds?: ScheduleItemId[]
  stageIds?: StageId[]
  sectionIds?: SectionId[]
  paAssignmentIds?: PaAssignmentId[]
  dutyTypeIds?: DutyTypeId[]
  dutyAssignmentIds?: DutyAssignmentId[]
  eventDayIds?: EventDayId[]
  gapBands?: number
  restMinutes?: number
  overrunMinutes?: number
}

export interface DetectScheduleIssuesInput {
  event: Event
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  calculatedItems: CalculatedScheduleItem[]
}

interface PerformanceAppearance {
  memberId: MemberId
  eventBandId: EventBandId
  scheduleItemId: ScheduleItemId
  eventDayId: EventDayId
  stageId: StageId
  plannedStartMinute: number
  plannedEndMinute: number
}

interface ResolvedPerformance {
  calculatedItem: CalculatedScheduleItem
  eventBand: EventBand
}

const isWithinTimeRange = (
  plannedStartMinute: number,
  plannedEndMinute: number,
  timeRange: TimeRange,
): boolean =>
  isIntervalWithinAvailabilityWindows(
    [timeRange], plannedStartMinute, plannedEndMinute,
  )

const isOutsideTimeRange = (
  plannedStartMinute: number,
  plannedEndMinute: number,
  timeRange: TimeRange,
): boolean =>
  !isWithinTimeRange(plannedStartMinute, plannedEndMinute, timeRange)

const createIssueKey = (issue: ScheduleIssue): string =>
  [
    issue.code,
    [...(issue.memberIds ?? [])].sort().join(','),
    [...(issue.eventBandIds ?? [])].sort().join(','),
    [...(issue.scheduleItemIds ?? [])].sort().join(','),
    [...(issue.stageIds ?? [])].sort().join(','),
    [...(issue.sectionIds ?? [])].sort().join(','),
    [...(issue.paAssignmentIds ?? [])].sort().join(','),
    [...(issue.dutyTypeIds ?? [])].sort().join(','),
    [...(issue.dutyAssignmentIds ?? [])].sort().join(','),
    [...(issue.eventDayIds ?? [])].sort().join(','),
  ].join('|')

const getLatestEndMinute = (
  calculatedItems: CalculatedScheduleItem[],
): number | undefined => calculatedItems.reduce<number | undefined>(
  (latestEndMinute, item) =>
    latestEndMinute === undefined || item.plannedEndMinute > latestEndMinute
      ? item.plannedEndMinute
      : latestEndMinute,
  undefined,
)

const detectTimelineConstraintIssues = ({
  stages,
  sections,
  calculatedItems,
}: Pick<
  DetectScheduleIssuesInput,
  'stages' | 'sections' | 'calculatedItems'
>): ScheduleIssue[] => {
  const issues: ScheduleIssue[] = []
  const calculatedItemsByStage = new Map<StageId, CalculatedScheduleItem[]>()

  calculatedItems.forEach((item) => {
    const stageItems = calculatedItemsByStage.get(item.stageId) ?? []
    stageItems.push(item)
    calculatedItemsByStage.set(item.stageId, stageItems)
  })

  stages.forEach((stage) => {
    const stageItems = (calculatedItemsByStage.get(stage.id) ?? []).filter(
      item => item.eventDayId === stage.eventDayId,
    )

    if (stage.plannedEndTime) {
      const fixedEndMinute = parseLocalTimeToMinute(stage.plannedEndTime)
      const actualEndMinute = getLatestEndMinute(stageItems)

      if (actualEndMinute !== undefined && actualEndMinute > fixedEndMinute) {
        issues.push({
          severity: 'ERROR',
          code: 'STAGE_END_EXCEEDED',
          message: `Stage ${stage.id} が固定終了 ${stage.plannedEndTime} を ${actualEndMinute - fixedEndMinute} 分超過しています`,
          stageIds: [stage.id],
          scheduleItemIds: stageItems
            .filter(item => item.plannedEndMinute > fixedEndMinute)
            .map(item => item.scheduleItemId),
          overrunMinutes: actualEndMinute - fixedEndMinute,
        })
      }
    }

    const stageSections = sections
      .filter(section => section.stageId === stage.id)
      .sort((first, second) =>
        first.order - second.order || first.id.localeCompare(second.id),
      )

    stageSections.forEach((section) => {
      if (!section.plannedEndTime) return

      const sectionItems = stageItems.filter(
        item => item.sectionId === section.id,
      )
      const actualEndMinute = getLatestEndMinute(sectionItems)
      if (actualEndMinute === undefined) return

      const fixedEndMinute = parseLocalTimeToMinute(section.plannedEndTime)
      if (actualEndMinute <= fixedEndMinute) return

      issues.push({
        severity: 'ERROR',
        code: 'SECTION_END_EXCEEDED',
        message: `Section ${section.id} が固定終了 ${section.plannedEndTime} を ${actualEndMinute - fixedEndMinute} 分超過しています`,
        stageIds: [stage.id],
        sectionIds: [section.id],
        scheduleItemIds: sectionItems
          .filter(item => item.plannedEndMinute > fixedEndMinute)
          .map(item => item.scheduleItemId),
        overrunMinutes: actualEndMinute - fixedEndMinute,
      })
    })

    for (let index = 1; index < stageSections.length; index += 1) {
      const previousSection = stageSections[index - 1]
      const nextSection = stageSections[index]
      if (!nextSection.plannedStartTime) continue

      const previousSectionItems = stageItems.filter(
        item => item.sectionId === previousSection.id,
      )
      const previousEndMinute = getLatestEndMinute(previousSectionItems)
      if (previousEndMinute === undefined) continue

      const fixedStartMinute = parseLocalTimeToMinute(
        nextSection.plannedStartTime,
      )
      if (previousEndMinute <= fixedStartMinute) continue

      issues.push({
        severity: 'ERROR',
        code: 'SECTION_START_CONFLICT',
        message: `前のSection ${previousSection.id} のタイムテーブルが Section ${nextSection.id} の固定開始 ${nextSection.plannedStartTime} を ${previousEndMinute - fixedStartMinute} 分超過しています`,
        stageIds: [stage.id],
        sectionIds: [previousSection.id, nextSection.id],
        scheduleItemIds: previousSectionItems
          .filter(item => item.plannedEndMinute > fixedStartMinute)
          .map(item => item.scheduleItemId),
        overrunMinutes: previousEndMinute - fixedStartMinute,
      })
    }
  })

  return issues
}

const compareAppearances = (
  first: PerformanceAppearance,
  second: PerformanceAppearance,
): number =>
  first.plannedStartMinute - second.plannedStartMinute ||
  first.plannedEndMinute - second.plannedEndMinute ||
  first.stageId.localeCompare(second.stageId) ||
  first.scheduleItemId.localeCompare(second.scheduleItemId)

// These checks do not depend on a calculated start/end time. The constraint
// evaluator also uses them when a malformed item prevents timeline calculation.
export const getUntimedPerformancePlacementIssues = (
  eventBand: EventBand,
  item: Pick<CalculatedScheduleItem,
    'scheduleItemId' | 'stageId' | 'sectionId'> & {
      eventDayId?: EventDayId
    },
): ScheduleIssue[] => {
  const issues: ScheduleIssue[] = []
  if (
    item.eventDayId !== undefined &&
    eventBand.eventDayId !== item.eventDayId
  ) {
    issues.push({
      severity: 'ERROR',
      code: 'EVENT_BAND_DAY_MISMATCH',
      message: `EventBand ${eventBand.id} は別の開催日に登録されています`,
      eventBandIds: [eventBand.id],
      scheduleItemIds: [item.scheduleItemId],
    })
  }

  const fixedPlacement = eventBand.fixedPlacement
  if (!fixedPlacement) return issues

  const stageMatches = fixedPlacement.stageId === item.stageId
  if (!stageMatches) {
    issues.push({
      severity: 'ERROR',
      code: 'FIXED_STAGE_MISMATCH',
      message: `EventBand ${eventBand.id} は Stage ${fixedPlacement.stageId} に固定されています`,
      eventBandIds: [eventBand.id],
      scheduleItemIds: [item.scheduleItemId],
      stageIds: [fixedPlacement.stageId, item.stageId],
    })
  }

  const fixedSectionId = fixedPlacement.sectionId
  if (
    stageMatches && fixedSectionId !== undefined &&
    fixedSectionId !== item.sectionId
  ) {
    issues.push({
      severity: 'ERROR',
      code: 'FIXED_SECTION_MISMATCH',
      message: `EventBand ${eventBand.id} は Section ${fixedSectionId} に固定されています`,
      eventBandIds: [eventBand.id],
      scheduleItemIds: [item.scheduleItemId],
      stageIds: [item.stageId],
      sectionIds: [
        fixedSectionId,
        ...(item.sectionId ? [item.sectionId] : []),
      ],
    })
  }
  return issues
}

export const getPerformanceParticipationIssue = ({
  memberId,
  eventBandId,
  scheduleItemId,
  eventMember,
  eventMemberDay,
}: {
  memberId: MemberId
  eventBandId: EventBandId
  scheduleItemId: ScheduleItemId
  eventMember?: EventMember
  eventMemberDay?: EventMemberDay
}): ScheduleIssue | undefined => {
  const references = {
    memberIds: [memberId],
    eventBandIds: [eventBandId],
    scheduleItemIds: [scheduleItemId],
  }
  if (!eventMember) return {
    severity: 'ERROR',
    code: 'MEMBER_NOT_REGISTERED_FOR_EVENT',
    message: `メンバー ${memberId} がイベントに登録されていません`,
    ...references,
  }
  if (!eventMemberDay) return {
    severity: 'ERROR',
    code: 'MEMBER_DAY_NOT_CONFIGURED',
    message: `メンバー ${memberId} のこの開催日の参加情報が設定されていません`,
    ...references,
  }
  if (eventMemberDay.participationStatus === 'absent') return {
    severity: 'ERROR',
    code: 'MEMBER_ABSENT',
    message: `不参加のメンバー ${memberId} が出演に含まれています`,
    ...references,
  }
  if (eventMemberDay.participationStatus === 'undecided') return {
    severity: 'INFO',
    code: 'MEMBER_PARTICIPATION_UNDECIDED',
    message: `メンバー ${memberId} の参加状態が未定です`,
    ...references,
  }
  return undefined
}

export interface PerformanceSequenceItem {
  scheduleItemId: ScheduleItemId
  eventDayId: EventDayId
  stageId: StageId
  sectionId?: SectionId
  eventBandId: EventBandId
}

export const getPerformanceSequenceIssues = ({
  performances,
  eventBands,
  minimumGapBands,
}: {
  performances: PerformanceSequenceItem[]
  eventBands: EventBand[]
  minimumGapBands: number
}): ScheduleIssue[] => {
  const issues: ScheduleIssue[] = []
  const eventBandById = new Map(eventBands.map((band) => [band.id, band]))
  const nextIndexBySequence = new Map<string, number>()
  const sequencedPerformances = performances.map((performance) => {
    const sequenceKey = JSON.stringify([
      performance.eventDayId,
      performance.stageId,
    ])
    const stagePerformanceIndex = nextIndexBySequence.get(sequenceKey) ?? 0
    nextIndexBySequence.set(sequenceKey, stagePerformanceIndex + 1)
    return {
      ...performance,
      stagePerformanceIndex,
      eventBand: eventBandById.get(performance.eventBandId),
    }
  })

  sequencedPerformances.forEach((performance) => {
    const eventBand = performance.eventBand
    const fixedPlacement = eventBand?.fixedPlacement
    if (!eventBand || !fixedPlacement?.position) return
    if (fixedPlacement.stageId !== performance.stageId) return
    if (
      fixedPlacement.sectionId !== undefined &&
      fixedPlacement.sectionId !== performance.sectionId
    ) return

    const lanePerformances = sequencedPerformances.filter((candidate) =>
      candidate.eventDayId === performance.eventDayId &&
      candidate.stageId === fixedPlacement.stageId &&
      (fixedPlacement.sectionId === undefined ||
        candidate.sectionId === fixedPlacement.sectionId),
    )
    const actualIndex = lanePerformances.findIndex((candidate) =>
      candidate.scheduleItemId === performance.scheduleItemId)
    const positionMatches = fixedPlacement.position.kind === 'first'
      ? actualIndex === 0
      : fixedPlacement.position.kind === 'last'
        ? actualIndex === lanePerformances.length - 1
        : actualIndex === fixedPlacement.position.index
    if (positionMatches) return

    const positionLabel = fixedPlacement.position.kind === 'first'
      ? '最初'
      : fixedPlacement.position.kind === 'last'
        ? '最後'
        : `${fixedPlacement.position.index + 1}番目`
    issues.push({
      severity: 'ERROR',
      code: 'FIXED_POSITION_MISMATCH',
      message: `EventBand ${eventBand.id} は対象レーンの${positionLabel}に固定されています`,
      eventBandIds: [eventBand.id],
      scheduleItemIds: [performance.scheduleItemId],
      eventDayIds: [performance.eventDayId],
      stageIds: [performance.stageId],
      ...(performance.sectionId
        ? { sectionIds: [performance.sectionId] }
        : {}),
    })
  })

  const appearancesByMember = new Map<MemberId, Array<{
    memberId: MemberId
    eventBandId: EventBandId
    scheduleItemId: ScheduleItemId
    eventDayId: EventDayId
    stageId: StageId
    stagePerformanceIndex: number
  }>>()
  sequencedPerformances.forEach((performance) => {
    if (!performance.eventBand) return
    new Set(performance.eventBand.memberIds).forEach((memberId) => {
      const appearances = appearancesByMember.get(memberId) ?? []
      appearances.push({
        memberId,
        eventBandId: performance.eventBand!.id,
        scheduleItemId: performance.scheduleItemId,
        eventDayId: performance.eventDayId,
        stageId: performance.stageId,
        stagePerformanceIndex: performance.stagePerformanceIndex,
      })
      appearancesByMember.set(memberId, appearances)
    })
  })

  appearancesByMember.forEach((appearances, memberId) => {
    const appearancesBySequence = new Map<string, typeof appearances>()
    appearances.forEach((appearance) => {
      const sequenceKey = JSON.stringify([
        appearance.eventDayId,
        appearance.stageId,
      ])
      const sequenceAppearances = appearancesBySequence.get(sequenceKey) ?? []
      sequenceAppearances.push(appearance)
      appearancesBySequence.set(sequenceKey, sequenceAppearances)
    })

    appearancesBySequence.forEach((sequenceAppearances) => {
      sequenceAppearances.sort((first, second) =>
        first.stagePerformanceIndex - second.stagePerformanceIndex)
      for (let index = 1; index < sequenceAppearances.length; index += 1) {
        const previous = sequenceAppearances[index - 1]
        const next = sequenceAppearances[index]
        const gapBands =
          next.stagePerformanceIndex - previous.stagePerformanceIndex - 1
        if (gapBands === 0) {
          issues.push({
            severity: 'WARNING',
            code: 'BACK_TO_BACK',
            message: `メンバー ${memberId} が同じStageで連続出演します`,
            memberIds: [memberId],
            eventBandIds: [previous.eventBandId, next.eventBandId],
            scheduleItemIds: [previous.scheduleItemId, next.scheduleItemId],
            eventDayIds: [next.eventDayId],
            gapBands,
          })
        } else if (gapBands < minimumGapBands) {
          issues.push({
            severity: 'WARNING',
            code: 'SHORT_GAP',
            message: `メンバー ${memberId} の同じStageでの出演間隔が ${gapBands} バンドです`,
            memberIds: [memberId],
            eventBandIds: [previous.eventBandId, next.eventBandId],
            scheduleItemIds: [previous.scheduleItemId, next.scheduleItemId],
            eventDayIds: [next.eventDayId],
            gapBands,
          })
        }
      }
    })
  })

  return issues
}

export const detectScheduleIssues = ({
  event,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  stages,
  sections,
  paAssignments,
  dutyTypes,
  dutyAssignments,
  calculatedItems,
}: DetectScheduleIssuesInput): ScheduleIssue[] => {
  const issues: ScheduleIssue[] = []
  const issueKeys = new Set<string>()
  const addIssue = (issue: ScheduleIssue) => {
    const key = createIssueKey(issue)
    if (issueKeys.has(key)) return

    issueKeys.add(key)
    issues.push(issue)
  }

  detectTimelineConstraintIssues({
    stages,
    sections,
    calculatedItems,
  }).forEach(addIssue)

  const eventBandById = new Map(
    eventBands
      .filter((eventBand) => eventBand.eventId === event.id)
      .map((eventBand) => [eventBand.id, eventBand]),
  )
  const eventDutyTypeById = new Map(
    dutyTypes
      .filter((dutyType) => dutyType.eventId === event.id)
      .map((dutyType) => [dutyType.id, dutyType]),
  )
  const memberById = new Map(members.map((member) => [member.id, member]))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const eventMemberByMemberId = new Map(
    eventMembers
      .filter((eventMember) => eventMember.eventId === event.id)
      .map((eventMember) => [eventMember.memberId, eventMember]),
  )
  const eventMemberDayByEventMemberId = new Map<
    EventMemberId,
    Map<EventDayId, EventMemberDay>
  >()
  eventMemberDays.forEach((eventMemberDay) => {
    const daysByEventDayId =
      eventMemberDayByEventMemberId.get(eventMemberDay.eventMemberId) ??
      new Map<EventDayId, EventMemberDay>()
    daysByEventDayId.set(eventMemberDay.eventDayId, eventMemberDay)
    eventMemberDayByEventMemberId.set(
      eventMemberDay.eventMemberId,
      daysByEventDayId,
    )
  })
  const resolvedPerformances: ResolvedPerformance[] = []
  const appearancesByMember = new Map<MemberId, PerformanceAppearance[]>()

  calculatedItems.forEach((calculatedItem) => {
    if (calculatedItem.kind !== 'performance') return
    if (!calculatedItem.eventBandId) {
      throw new Error(
        `EventBand reference missing for ScheduleItem: ${calculatedItem.scheduleItemId}`,
      )
    }

    const eventBand = eventBandById.get(calculatedItem.eventBandId)
    if (!eventBand) {
      throw new Error(`EventBand not found: ${calculatedItem.eventBandId}`)
    }

    resolvedPerformances.push({ calculatedItem, eventBand })

    new Set(eventBand.memberIds).forEach((memberId) => {
      const appearance: PerformanceAppearance = {
        memberId,
        eventBandId: eventBand.id,
        scheduleItemId: calculatedItem.scheduleItemId,
        eventDayId: calculatedItem.eventDayId,
        stageId: calculatedItem.stageId,
        plannedStartMinute: calculatedItem.plannedStartMinute,
        plannedEndMinute: calculatedItem.plannedEndMinute,
      }
      const memberAppearances = appearancesByMember.get(memberId) ?? []
      memberAppearances.push(appearance)
      appearancesByMember.set(memberId, memberAppearances)
    })
  })

  resolvedPerformances.forEach(({ calculatedItem, eventBand }) => {
    getUntimedPerformancePlacementIssues(eventBand, calculatedItem)
      .forEach(addIssue)

    if (
      eventBand.availableTimeRange &&
      isOutsideTimeRange(
        calculatedItem.plannedStartMinute,
        calculatedItem.plannedEndMinute,
        eventBand.availableTimeRange,
      )
    ) {
      addIssue({
        severity: 'ERROR',
        code: 'OUTSIDE_BAND_AVAILABILITY',
        message: `EventBand ${eventBand.id} の出演可能時間外です`,
        eventBandIds: [eventBand.id],
        scheduleItemIds: [calculatedItem.scheduleItemId],
      })
    }

    if (
      eventBand.preferredTimeRange &&
      isOutsideTimeRange(
        calculatedItem.plannedStartMinute,
        calculatedItem.plannedEndMinute,
        eventBand.preferredTimeRange,
      )
    ) {
      addIssue({
        severity: 'INFO',
        code: 'PREFERENCE_NOT_MET',
        message: `EventBand ${eventBand.id} の出演希望時間外です`,
        eventBandIds: [eventBand.id],
        scheduleItemIds: [calculatedItem.scheduleItemId],
      })
    }

    const fixedPlacement = eventBand.fixedPlacement
    if (!fixedPlacement) return

    if (
      fixedPlacement.plannedStartTime &&
      parseLocalTimeToMinute(fixedPlacement.plannedStartTime) !==
        calculatedItem.plannedStartMinute
    ) {
      addIssue({
        severity: 'ERROR',
        code: 'FIXED_START_TIME_MISMATCH',
        message: `EventBand ${eventBand.id} の固定開始時刻は${fixedPlacement.plannedStartTime}です`,
        eventBandIds: [eventBand.id],
        scheduleItemIds: [calculatedItem.scheduleItemId],
        stageIds: [calculatedItem.stageId],
        ...(calculatedItem.sectionId
          ? { sectionIds: [calculatedItem.sectionId] }
          : {}),
      })
    }
  })

  getPerformanceSequenceIssues({
    performances: resolvedPerformances.map(({ calculatedItem, eventBand }) => ({
      scheduleItemId: calculatedItem.scheduleItemId,
      eventDayId: calculatedItem.eventDayId,
      stageId: calculatedItem.stageId,
      sectionId: calculatedItem.sectionId,
      eventBandId: eventBand.id,
    })),
    eventBands,
    minimumGapBands: event.validationPolicy.minimumGapBands,
  }).forEach(addIssue)

  const resolvedPaAssignments: Array<{
    assignment: PaAssignment
    interval: ResolvedPaAssignmentInterval
  }> = []

  paAssignments
    .filter((assignment) => assignment.eventId === event.id)
    .forEach((assignment) => {
      const stage = stageById.get(assignment.stageId)
      const resolution = stage?.eventDayId === assignment.eventDayId
        ? resolvePaAssignmentInterval(assignment, calculatedItems)
        : { ok: false as const, reason: 'PA担当のStageまたは開催日が正しくありません。' }

      if (!resolution.ok) {
        addIssue({
          severity: 'ERROR',
          code: 'PA_INVALID_BOUNDARY',
          message: `Stage ${assignment.stageId} のPA担当範囲が無効です。${resolution.reason}`,
          memberIds: [assignment.memberId],
          stageIds: [assignment.stageId],
          paAssignmentIds: [assignment.id],
        })
      } else {
        resolvedPaAssignments.push({
          assignment,
          interval: resolution.interval,
        })
      }

      const member = memberById.get(assignment.memberId)
      if (!member?.paCapabilities?.[assignment.role]) {
        addIssue({
          severity: 'ERROR',
          code: 'PA_CAPABILITY_MISMATCH',
          message: `メンバー ${assignment.memberId} は${assignment.role === 'main' ? 'Main' : 'Sub'} PAを担当できません`,
          memberIds: [assignment.memberId],
          stageIds: [assignment.stageId],
          paAssignmentIds: [assignment.id],
        })
      }

      const eventMember = eventMemberByMemberId.get(assignment.memberId)
      const memberDay = eventMember
        ? eventMemberDayByEventMemberId
            .get(eventMember.id)
            ?.get(assignment.eventDayId)
        : undefined
      if (!memberDay) {
        addIssue({
          severity: 'ERROR',
          code: 'PA_MEMBER_NOT_CONFIGURED',
          message: `メンバー ${assignment.memberId} のこの開催日のPA参加情報が設定されていません`,
          memberIds: [assignment.memberId],
          stageIds: [assignment.stageId],
          paAssignmentIds: [assignment.id],
        })
      } else if (memberDay.participationStatus === 'absent') {
        addIssue({
          severity: 'ERROR',
          code: 'PA_MEMBER_ABSENT',
          message: `不参加のメンバー ${assignment.memberId} がPA担当に設定されています`,
          memberIds: [assignment.memberId],
          stageIds: [assignment.stageId],
          paAssignmentIds: [assignment.id],
        })
      } else {
        if (memberDay.participationStatus === 'undecided') {
          addIssue({
            severity: 'INFO',
            code: 'PA_MEMBER_UNDECIDED',
            message: `メンバー ${assignment.memberId} の参加状態が未定のままPA担当に設定されています`,
            memberIds: [assignment.memberId],
            stageIds: [assignment.stageId],
            paAssignmentIds: [assignment.id],
          })
        }
        if (
          resolution.ok &&
          !isIntervalWithinAvailabilityWindows(
            memberDay.availabilityWindows,
            resolution.interval.fromMinute,
            resolution.interval.untilMinute,
          )
        ) {
          addIssue({
            severity: 'ERROR',
            code: 'PA_OUTSIDE_MEMBER_AVAILABILITY',
            message: `メンバー ${assignment.memberId} のPA担当時間が出演可能時間外です`,
            memberIds: [assignment.memberId],
            stageIds: [assignment.stageId],
            paAssignmentIds: [assignment.id],
          })
        }
      }

      if (resolution.ok) {
        getOverlappingMemberPerformances({
          memberId: assignment.memberId,
          eventDayId: assignment.eventDayId,
          interval: resolution.interval,
          eventBands,
          calculatedItems,
        }).forEach((performance) => {
          if (!performance.eventBandId) return
          addIssue({
            severity: 'ERROR',
            code: 'PA_MEMBER_PERFORMANCE_OVERLAP',
            message: `メンバー ${assignment.memberId} は Stage ${assignment.stageId} の${assignment.role === 'main' ? 'Main' : 'Sub'} PA担当中に EventBand ${performance.eventBandId} へ出演しています`,
            memberIds: [assignment.memberId],
            eventBandIds: [performance.eventBandId],
            scheduleItemIds: [performance.scheduleItemId],
            stageIds: [assignment.stageId, performance.stageId],
            paAssignmentIds: [assignment.id],
          })
        })
      }
    })

  for (
    let firstIndex = 0;
    firstIndex < resolvedPaAssignments.length;
    firstIndex += 1
  ) {
    const first = resolvedPaAssignments[firstIndex]
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < resolvedPaAssignments.length;
      secondIndex += 1
    ) {
      const second = resolvedPaAssignments[secondIndex]
      if (
        first.assignment.memberId !== second.assignment.memberId ||
        first.assignment.eventDayId !== second.assignment.eventDayId ||
        !intervalsOverlap(first.interval, second.interval)
      ) {
        continue
      }
      addIssue({
        severity: 'ERROR',
        code: 'PA_ASSIGNMENT_OVERLAP',
        message: `メンバー ${first.assignment.memberId} のPA担当時間が重複しています`,
        memberIds: [first.assignment.memberId],
        stageIds: [first.assignment.stageId, second.assignment.stageId],
        paAssignmentIds: [first.assignment.id, second.assignment.id],
      })
    }
  }

  const resolvedDutyAssignments: Array<{
    assignment: DutyAssignment
    interval: ResolvedDutyAssignmentInterval
  }> = []

  dutyAssignments
    .filter((assignment) =>
      eventDutyTypeById.has(assignment.dutyTypeId) ||
      stageById.has(assignment.stageId),
    )
    .forEach((assignment) => {
      const dutyType = eventDutyTypeById.get(assignment.dutyTypeId)
      if (!dutyType) {
        addIssue({
          severity: 'ERROR',
          code: 'DUTY_TYPE_NOT_FOUND',
          message: `一般業務担当の DutyType ${assignment.dutyTypeId} が見つかりません`,
          memberIds: [assignment.memberId],
          dutyTypeIds: [assignment.dutyTypeId],
          dutyAssignmentIds: [assignment.id],
          eventDayIds: [assignment.eventDayId],
          stageIds: [assignment.stageId],
        })
      }

      const stage = stageById.get(assignment.stageId)
      const resolution = stage?.eventDayId === assignment.eventDayId
        ? resolveDutyAssignmentInterval(assignment, calculatedItems)
        : {
            ok: false as const,
            reason: '一般業務担当のStageまたは開催日が正しくありません。',
          }

      if (!resolution.ok) {
        addIssue({
          severity: 'ERROR',
          code: 'DUTY_INVALID_BOUNDARY',
          message: `Stage ${assignment.stageId} の一般業務担当範囲が無効です。${resolution.reason}`,
          memberIds: [assignment.memberId],
          dutyTypeIds: [assignment.dutyTypeId],
          dutyAssignmentIds: [assignment.id],
          eventDayIds: [assignment.eventDayId],
          stageIds: [assignment.stageId],
        })
      } else {
        resolvedDutyAssignments.push({
          assignment,
          interval: resolution.interval,
        })
      }

      const member = memberById.get(assignment.memberId)
      const eventMember = eventMemberByMemberId.get(assignment.memberId)
      const memberDay = eventMember
        ? eventMemberDayByEventMemberId
            .get(eventMember.id)
            ?.get(assignment.eventDayId)
        : undefined

      if (!member || !memberDay) {
        addIssue({
          severity: 'ERROR',
          code: 'DUTY_MEMBER_NOT_CONFIGURED',
          message: `メンバー ${assignment.memberId} のこの開催日の一般業務参加情報が設定されていません`,
          memberIds: [assignment.memberId],
          dutyTypeIds: [assignment.dutyTypeId],
          dutyAssignmentIds: [assignment.id],
          eventDayIds: [assignment.eventDayId],
          stageIds: [assignment.stageId],
        })
      } else if (memberDay.participationStatus === 'absent') {
        addIssue({
          severity: 'ERROR',
          code: 'DUTY_MEMBER_ABSENT',
          message: `不参加のメンバー ${assignment.memberId} が一般業務担当に設定されています`,
          memberIds: [assignment.memberId],
          dutyTypeIds: [assignment.dutyTypeId],
          dutyAssignmentIds: [assignment.id],
          eventDayIds: [assignment.eventDayId],
          stageIds: [assignment.stageId],
        })
      } else {
        if (memberDay.participationStatus === 'undecided') {
          addIssue({
            severity: 'INFO',
            code: 'DUTY_MEMBER_UNDECIDED',
            message: `メンバー ${assignment.memberId} の参加状態が未定のまま一般業務担当に設定されています`,
            memberIds: [assignment.memberId],
            dutyTypeIds: [assignment.dutyTypeId],
            dutyAssignmentIds: [assignment.id],
            eventDayIds: [assignment.eventDayId],
            stageIds: [assignment.stageId],
          })
        }
        if (
          resolution.ok &&
          !isIntervalWithinAvailabilityWindows(
            memberDay.availabilityWindows,
            resolution.interval.fromMinute,
            resolution.interval.untilMinute,
          )
        ) {
          addIssue({
            severity: 'ERROR',
            code: 'DUTY_OUTSIDE_MEMBER_AVAILABILITY',
            message: `メンバー ${assignment.memberId} の一般業務担当時間が出演可能時間外です`,
            memberIds: [assignment.memberId],
            dutyTypeIds: [assignment.dutyTypeId],
            dutyAssignmentIds: [assignment.id],
            eventDayIds: [assignment.eventDayId],
            stageIds: [assignment.stageId],
          })
        }
      }

      if (resolution.ok) {
        getOverlappingMemberPerformances({
          memberId: assignment.memberId,
          eventDayId: assignment.eventDayId,
          interval: resolution.interval,
          eventBands,
          calculatedItems,
        }).forEach((performance) => {
          if (!performance.eventBandId) return
          addIssue({
            severity: 'ERROR',
            code: 'DUTY_MEMBER_PERFORMANCE_OVERLAP',
            message: `メンバー ${assignment.memberId} は一般業務担当中に EventBand ${performance.eventBandId} へ出演しています`,
            memberIds: [assignment.memberId],
            eventBandIds: [performance.eventBandId],
            scheduleItemIds: [performance.scheduleItemId],
            eventDayIds: [assignment.eventDayId],
            stageIds: [assignment.stageId, performance.stageId],
            dutyTypeIds: [assignment.dutyTypeId],
            dutyAssignmentIds: [assignment.id],
          })
        })
      }
    })

  for (
    let firstIndex = 0;
    firstIndex < resolvedDutyAssignments.length;
    firstIndex += 1
  ) {
    const first = resolvedDutyAssignments[firstIndex]
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < resolvedDutyAssignments.length;
      secondIndex += 1
    ) {
      const second = resolvedDutyAssignments[secondIndex]
      if (
        first.assignment.memberId !== second.assignment.memberId ||
        first.assignment.eventDayId !== second.assignment.eventDayId ||
        !intervalsOverlap(first.interval, second.interval)
      ) continue

      addIssue({
        severity: 'ERROR',
        code: 'DUTY_ASSIGNMENT_OVERLAP',
        message: `メンバー ${first.assignment.memberId} の一般業務担当時間が重複しています`,
        memberIds: [first.assignment.memberId],
        eventDayIds: [first.assignment.eventDayId],
        stageIds: [first.assignment.stageId, second.assignment.stageId],
        dutyTypeIds: [first.assignment.dutyTypeId, second.assignment.dutyTypeId],
        dutyAssignmentIds: [first.assignment.id, second.assignment.id],
      })
    }
  }

  resolvedDutyAssignments.forEach((duty) => {
    resolvedPaAssignments.forEach((pa) => {
      if (
        duty.assignment.memberId !== pa.assignment.memberId ||
        duty.assignment.eventDayId !== pa.assignment.eventDayId ||
        !intervalsOverlap(duty.interval, pa.interval)
      ) return

      addIssue({
        severity: 'ERROR',
        code: 'DUTY_PA_OVERLAP',
        message: `メンバー ${duty.assignment.memberId} の一般業務とPA担当時間が重複しています`,
        memberIds: [duty.assignment.memberId],
        eventDayIds: [duty.assignment.eventDayId],
        stageIds: [duty.assignment.stageId, pa.assignment.stageId],
        dutyTypeIds: [duty.assignment.dutyTypeId],
        dutyAssignmentIds: [duty.assignment.id],
        paAssignmentIds: [pa.assignment.id],
      })
    })
  })

  appearancesByMember.forEach((appearances, memberId) => {
    const eventMember = eventMemberByMemberId.get(memberId)

    appearances.forEach((appearance) => {
      const eventMemberDay = eventMember
        ? eventMemberDayByEventMemberId.get(eventMember.id)
          ?.get(appearance.eventDayId)
        : undefined
      const participationIssue = getPerformanceParticipationIssue({
        memberId,
        eventBandId: appearance.eventBandId,
        scheduleItemId: appearance.scheduleItemId,
        eventMember,
        eventMemberDay,
      })
      if (participationIssue) addIssue(participationIssue)
      if (!eventMemberDay || participationIssue?.severity === 'ERROR') return

      const isOutsideAvailability = !isIntervalWithinAvailabilityWindows(
        eventMemberDay.availabilityWindows,
        appearance.plannedStartMinute,
        appearance.plannedEndMinute,
      )

      if (isOutsideAvailability) {
        addIssue({
          severity: 'ERROR',
          code: 'OUTSIDE_MEMBER_AVAILABILITY',
          message: `メンバー ${memberId} の出演可能時間外です`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
      }

      if (
        eventMemberDay.preferredTimeRange &&
        isOutsideTimeRange(
          appearance.plannedStartMinute,
          appearance.plannedEndMinute,
          eventMemberDay.preferredTimeRange,
        )
      ) {
        addIssue({
          severity: 'INFO',
          code: 'PREFERENCE_NOT_MET',
          message: `メンバー ${memberId} の出演希望時間外です`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
      }
    })

    const appearancesByEventDay = new Map<
      EventDayId,
      PerformanceAppearance[]
    >()
    appearances.forEach((appearance) => {
      const dayAppearances =
        appearancesByEventDay.get(appearance.eventDayId) ?? []
      dayAppearances.push(appearance)
      appearancesByEventDay.set(appearance.eventDayId, dayAppearances)
    })

    appearancesByEventDay.forEach((dayAppearances) => {
      const chronologicalAppearances = [...dayAppearances].sort(
        compareAppearances,
      )

      for (let firstIndex = 0; firstIndex < chronologicalAppearances.length; firstIndex += 1) {
        const first = chronologicalAppearances[firstIndex]

        for (
          let secondIndex = firstIndex + 1;
          secondIndex < chronologicalAppearances.length;
          secondIndex += 1
        ) {
          const second = chronologicalAppearances[secondIndex]
          if (second.plannedStartMinute >= first.plannedEndMinute) break

          if (
            first.plannedStartMinute < second.plannedEndMinute &&
            second.plannedStartMinute < first.plannedEndMinute
          ) {
            addIssue({
              severity: 'ERROR',
              code: 'PERFORMANCE_OVERLAP',
              message: `メンバー ${memberId} の出演時間が重複しています`,
              memberIds: [memberId],
              eventBandIds: [first.eventBandId, second.eventBandId],
              scheduleItemIds: [first.scheduleItemId, second.scheduleItemId],
            })
          }
        }
      }

      let previousWithLatestEnd = chronologicalAppearances[0]

      for (let index = 1; index < chronologicalAppearances.length; index += 1) {
        const next = chronologicalAppearances[index]
        const restMinutes =
          next.plannedStartMinute - previousWithLatestEnd.plannedEndMinute

        if (
          restMinutes >= 0 &&
          restMinutes < event.validationPolicy.minimumRestMinutes
        ) {
          addIssue({
            severity: 'WARNING',
            code: 'SHORT_REST',
            message: `メンバー ${memberId} の出演間隔が ${restMinutes} 分です`,
            memberIds: [memberId],
            eventBandIds: [previousWithLatestEnd.eventBandId, next.eventBandId],
            scheduleItemIds: [
              previousWithLatestEnd.scheduleItemId,
              next.scheduleItemId,
            ],
            restMinutes,
          })
        }

        if (
          next.plannedEndMinute > previousWithLatestEnd.plannedEndMinute
        ) {
          previousWithLatestEnd = next
        }
      }
    })

  })

  return issues
}
