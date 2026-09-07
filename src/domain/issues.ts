import type {
  Event,
  EventBand,
  EventBandId,
  EventMember,
  MemberId,
  ScheduleItemId,
  StageId,
  TimeRange,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import { parseLocalTimeToMinute } from './timeline.ts'

export type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO'

export type ScheduleIssueCode =
  | 'MEMBER_NOT_REGISTERED_FOR_EVENT'
  | 'MEMBER_ABSENT'
  | 'MEMBER_PARTICIPATION_UNDECIDED'
  | 'OUTSIDE_MEMBER_AVAILABILITY'
  | 'OUTSIDE_BAND_AVAILABILITY'
  | 'PERFORMANCE_OVERLAP'
  | 'BACK_TO_BACK'
  | 'SHORT_GAP'
  | 'SHORT_REST'
  | 'PREFERENCE_NOT_MET'

export interface ScheduleIssue {
  severity: IssueSeverity
  code: ScheduleIssueCode
  message: string
  memberIds?: MemberId[]
  eventBandIds?: EventBandId[]
  scheduleItemIds?: ScheduleItemId[]
  gapBands?: number
  restMinutes?: number
}

export interface DetectScheduleIssuesInput {
  event: Event
  eventMembers: EventMember[]
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
}

interface PerformanceAppearance {
  memberId: MemberId
  eventBandId: EventBandId
  scheduleItemId: ScheduleItemId
  stageId: StageId
  plannedStartMinute: number
  plannedEndMinute: number
  stagePerformanceIndex: number
}

interface ResolvedPerformance {
  calculatedItem: CalculatedScheduleItem
  eventBand: EventBand
}

const isOutsideTimeRange = (
  plannedStartMinute: number,
  plannedEndMinute: number,
  timeRange: TimeRange,
): boolean =>
  plannedStartMinute < parseLocalTimeToMinute(timeRange.from) ||
  plannedEndMinute > parseLocalTimeToMinute(timeRange.until)

const createIssueKey = (issue: ScheduleIssue): string =>
  [
    issue.code,
    [...(issue.memberIds ?? [])].sort().join(','),
    [...(issue.eventBandIds ?? [])].sort().join(','),
    [...(issue.scheduleItemIds ?? [])].sort().join(','),
  ].join('|')

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
  eventBands,
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

      if (eventMember.participationStatus === 'absent') {
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

      if (eventMember.participationStatus === 'undecided') {
        addIssue({
          severity: 'INFO',
          code: 'MEMBER_PARTICIPATION_UNDECIDED',
          message: `メンバー ${memberId} の参加状態が未定です`,
          memberIds: [memberId],
          eventBandIds: [appearance.eventBandId],
          scheduleItemIds: [appearance.scheduleItemId],
        })
      }

      const outsideAvailableFrom =
        eventMember.availableFrom !== undefined &&
        appearance.plannedStartMinute <
          parseLocalTimeToMinute(eventMember.availableFrom)
      const outsideAvailableUntil =
        eventMember.availableUntil !== undefined &&
        appearance.plannedEndMinute >
          parseLocalTimeToMinute(eventMember.availableUntil)

      if (outsideAvailableFrom || outsideAvailableUntil) {
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
        eventMember.preferredTimeRange &&
        isOutsideTimeRange(
          appearance.plannedStartMinute,
          appearance.plannedEndMinute,
          eventMember.preferredTimeRange,
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

    const chronologicalAppearances = [...appearances].sort(compareAppearances)

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

    for (let index = 1; index < chronologicalAppearances.length; index += 1) {
      const previous = chronologicalAppearances[index - 1]
      const next = chronologicalAppearances[index]
      const restMinutes =
        next.plannedStartMinute - previous.plannedEndMinute

      if (
        restMinutes >= 0 &&
        restMinutes < event.validationPolicy.minimumRestMinutes
      ) {
        addIssue({
          severity: 'WARNING',
          code: 'SHORT_REST',
          message: `メンバー ${memberId} の出演間隔が ${restMinutes} 分です`,
          memberIds: [memberId],
          eventBandIds: [previous.eventBandId, next.eventBandId],
          scheduleItemIds: [previous.scheduleItemId, next.scheduleItemId],
          restMinutes,
        })
      }
    }

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
