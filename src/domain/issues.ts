import type {
  Event,
  EventBand,
  EventBandId,
  EventDayId,
  EventMember,
  EventMemberDay,
  EventMemberId,
  MemberId,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  StageId,
  TimeRange,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import { parseLocalTimeToMinute } from './timeline.ts'

export type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO'

export type ScheduleIssueCode =
  | 'MEMBER_NOT_REGISTERED_FOR_EVENT'
  | 'MEMBER_DAY_NOT_CONFIGURED'
  | 'MEMBER_ABSENT'
  | 'MEMBER_PARTICIPATION_UNDECIDED'
  | 'OUTSIDE_MEMBER_AVAILABILITY'
  | 'OUTSIDE_BAND_AVAILABILITY'
  | 'EVENT_BAND_DAY_MISMATCH'
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
  gapBands?: number
  restMinutes?: number
  overrunMinutes?: number
}

export interface DetectScheduleIssuesInput {
  event: Event
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
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
  stagePerformanceIndex: number
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
  (timeRange.from === undefined ||
    plannedStartMinute >= parseLocalTimeToMinute(timeRange.from)) &&
  (timeRange.until === undefined ||
    plannedEndMinute <= parseLocalTimeToMinute(timeRange.until))

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

export const detectScheduleIssues = ({
  event,
  eventMembers,
  eventMemberDays,
  eventBands,
  stages,
  sections,
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
  const nextPerformanceIndexByStage = new Map<StageId, number>()
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

    const stagePerformanceIndex =
      nextPerformanceIndexByStage.get(calculatedItem.stageId) ?? 0
    nextPerformanceIndexByStage.set(
      calculatedItem.stageId,
      stagePerformanceIndex + 1,
    )
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
        stagePerformanceIndex,
      }
      const memberAppearances = appearancesByMember.get(memberId) ?? []
      memberAppearances.push(appearance)
      appearancesByMember.set(memberId, memberAppearances)
    })
  })

  resolvedPerformances.forEach(({ calculatedItem, eventBand }) => {
    if (eventBand.eventDayId !== calculatedItem.eventDayId) {
      addIssue({
        severity: 'ERROR',
        code: 'EVENT_BAND_DAY_MISMATCH',
        message: `EventBand ${eventBand.id} は別の開催日に登録されています`,
        eventBandIds: [eventBand.id],
        scheduleItemIds: [calculatedItem.scheduleItemId],
      })
    }

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
  })

  appearancesByMember.forEach((appearances, memberId) => {
    const eventMember = eventMemberByMemberId.get(memberId)

    appearances.forEach((appearance) => {
      if (!eventMember) {
        addIssue({
          severity: 'ERROR',
          code: 'MEMBER_NOT_REGISTERED_FOR_EVENT',
          message: `メンバー ${memberId} がイベントに登録されていません`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
        return
      }

      const eventMemberDay = eventMemberDayByEventMemberId
        .get(eventMember.id)
        ?.get(appearance.eventDayId)
      if (!eventMemberDay) {
        addIssue({
          severity: 'ERROR',
          code: 'MEMBER_DAY_NOT_CONFIGURED',
          message: `メンバー ${memberId} のこの開催日の参加情報が設定されていません`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
        return
      }

      if (eventMemberDay.participationStatus === 'absent') {
        addIssue({
          severity: 'ERROR',
          code: 'MEMBER_ABSENT',
          message: `不参加のメンバー ${memberId} が出演に含まれています`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
        return
      }

      if (eventMemberDay.participationStatus === 'undecided') {
        addIssue({
          severity: 'INFO',
          code: 'MEMBER_PARTICIPATION_UNDECIDED',
          message: `メンバー ${memberId} の参加状態が未定です`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
      }

      const isOutsideAvailability =
        eventMemberDay.availabilityWindows !== undefined &&
        !eventMemberDay.availabilityWindows.some((availabilityWindow) =>
          isWithinTimeRange(
            appearance.plannedStartMinute,
            appearance.plannedEndMinute,
            availabilityWindow,
          ),
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

    const appearancesByStage = new Map<StageId, PerformanceAppearance[]>()
    appearances.forEach((appearance) => {
      const stageAppearances = appearancesByStage.get(appearance.stageId) ?? []
      stageAppearances.push(appearance)
      appearancesByStage.set(appearance.stageId, stageAppearances)
    })

    appearancesByStage.forEach((stageAppearances) => {
      stageAppearances.sort(
        (first, second) =>
          first.stagePerformanceIndex - second.stagePerformanceIndex,
      )

      for (let index = 1; index < stageAppearances.length; index += 1) {
        const previous = stageAppearances[index - 1]
        const next = stageAppearances[index]
        const gapBands =
          next.stagePerformanceIndex - previous.stagePerformanceIndex - 1

        if (gapBands === 0) {
          addIssue({
            severity: 'WARNING',
            code: 'BACK_TO_BACK',
            message: `メンバー ${memberId} が同じStageで連続出演します`,
            memberIds: [memberId],
            eventBandIds: [previous.eventBandId, next.eventBandId],
            scheduleItemIds: [previous.scheduleItemId, next.scheduleItemId],
            gapBands,
          })
        } else if (gapBands < event.validationPolicy.minimumGapBands) {
          addIssue({
            severity: 'WARNING',
            code: 'SHORT_GAP',
            message: `メンバー ${memberId} の同じStageでの出演間隔が ${gapBands} バンドです`,
            memberIds: [memberId],
            eventBandIds: [previous.eventBandId, next.eventBandId],
            scheduleItemIds: [previous.scheduleItemId, next.scheduleItemId],
            gapBands,
          })
        }
      }
    })
  })

  return issues
}
