import type {
  Event,
  EventBand,
  EventBandId,
  EventDayId,
  ScheduleItem,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  StageId,
} from './models'
import {
  compareScheduleItemOrder,
  isValidScheduleItemSectionAssignment,
} from './schedule.ts'

export interface CalculatedScheduleItem {
  scheduleItemId: ScheduleItemId
  eventDayId: EventDayId
  stageId: StageId
  sectionId?: SectionId
  afterSectionId?: SectionId
  kind: 'performance' | 'break'
  plannedStartMinute: number
  plannedEndMinute: number
  eventBandId?: EventBandId
}

export interface CalculateStageTimelineInput {
  event: Event
  stage: Stage
  sections: Section[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
}

/** Cross-Section transitions belong to the preceding Section, not idle time. */
export const getCrossSectionTransitions = (
  sections: Section[],
  calculatedItems: CalculatedScheduleItem[],
): Map<SectionId, { durationMinutes: number; untilItem: CalculatedScheduleItem }> => {
  const transitions = new Map<SectionId, {
    durationMinutes: number; untilItem: CalculatedScheduleItem
  }>()
  for (const stageId of new Set(calculatedItems.map((item) => item.stageId))) {
    const stageSections = sections.filter((section) => section.stageId === stageId)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    // Preserve Timeline traversal order, including explicit Break items.
    const stageItems = calculatedItems.filter((item) => item.stageId === stageId)
    for (let index = 1; index < stageItems.length; index += 1) {
      const previous = stageItems[index - 1]
      const next = stageItems[index]
      if (previous.kind !== 'performance' || next.kind !== 'performance' ||
        previous.sectionId === undefined || next.sectionId === undefined ||
        previous.sectionId === next.sectionId) continue
      const previousIndex = stageSections.findIndex((section) => section.id === previous.sectionId)
      const nextIndex = stageSections.findIndex((section) => section.id === next.sectionId)
      if (previousIndex < 0 || nextIndex <= previousIndex ||
        stageSections.slice(previousIndex + 1, nextIndex + 1)
          .some((section) => section.plannedStartTime !== undefined)) continue
      const durationMinutes = next.plannedStartMinute - previous.plannedEndMinute
      if (durationMinutes < 0) continue
      transitions.set(previous.sectionId, { durationMinutes, untilItem: next })
    }
  }
  return transitions
}

const getLocalTimeParts = (time: string): { hour: number; minute: number } | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return undefined

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined

  return { hour, minute }
}

export const isValidLocalTime = (time: string): boolean => getLocalTimeParts(time) !== undefined

export const parseLocalTimeToMinute = (time: string): number => {
  const parts = getLocalTimeParts(time)
  if (!parts) throw new RangeError(`Invalid local time: ${time}`)

  return parts.hour * 60 + parts.minute
}

export const formatMinuteAsLocalTime = (totalMinutes: number): string => {
  const minutesPerDay = 24 * 60
  const normalizedMinutes = ((totalMinutes % minutesPerDay) + minutesPerDay) % minutesPerDay
  const hour = Math.floor(normalizedMinutes / 60)
  const minute = normalizedMinutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export const calculateStageTimeline = ({
  event,
  stage,
  sections,
  scheduleItems,
  eventBands,
}: CalculateStageTimelineInput): CalculatedScheduleItem[] => {
  const transitionMinutes = stage.transitionMinutes ?? event.defaultTransitionMinutes
  const eventBandsById = new Map(eventBands.map(eventBand => [eventBand.id, eventBand]))
  const stageScheduleItems = scheduleItems.filter(item => item.stageId === stage.id)
  const stageSections = sections
    .filter(section => section.stageId === stage.id)
    .sort((left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
    )
  const calculatedItems: CalculatedScheduleItem[] = []
  let currentMinute = parseLocalTimeToMinute(stage.plannedStartTime)
  let previousItemKind: ScheduleItem['kind'] | undefined
  let hasExplicitAnchorSincePreviousItem = false

  const calculateItems = (items: ScheduleItem[]) => {
    const orderedItems = [...items].sort(compareScheduleItemOrder)

    for (const scheduleItem of orderedItems) {
      if (
        previousItemKind === 'performance' &&
        scheduleItem.kind === 'performance' &&
        !hasExplicitAnchorSincePreviousItem
      ) {
        currentMinute += transitionMinutes
      }

      let durationMinutes: number
      if (scheduleItem.kind === 'break') {
        durationMinutes = scheduleItem.durationMinutes
      } else {
        const eventBand = eventBandsById.get(scheduleItem.eventBandId)
        if (!eventBand) {
          throw new Error(`EventBand not found: ${scheduleItem.eventBandId}`)
        }
        durationMinutes = eventBand.durationMinutes
      }
      const plannedStartMinute = currentMinute
      const plannedEndMinute = plannedStartMinute + durationMinutes

      calculatedItems.push({
        scheduleItemId: scheduleItem.id,
        eventDayId: stage.eventDayId,
        stageId: scheduleItem.stageId,
        sectionId: scheduleItem.sectionId,
        ...(scheduleItem.kind === 'break' && scheduleItem.afterSectionId
          ? { afterSectionId: scheduleItem.afterSectionId }
          : {}),
        kind: scheduleItem.kind,
        plannedStartMinute,
        plannedEndMinute,
        ...(scheduleItem.kind === 'performance'
          ? { eventBandId: scheduleItem.eventBandId }
          : {}),
      })

      currentMinute = plannedEndMinute
      previousItemKind = scheduleItem.kind
      hasExplicitAnchorSincePreviousItem = false
    }
  }

  for (const scheduleItem of stageScheduleItems) {
    if (isValidScheduleItemSectionAssignment(
      stage.id,
      stageSections,
      scheduleItem,
    )) continue

    if (scheduleItem.kind === 'performance') {
      if (
        'afterSectionId' in scheduleItem &&
        scheduleItem.afterSectionId !== undefined
      ) {
        throw new Error(
          `Invalid Section placement for Performance: ${scheduleItem.id}`,
        )
      }
      if (stageSections.length > 0 && !scheduleItem.sectionId) {
        throw new Error(
          `ScheduleItem must belong to a Section when Stage has Sections: ${scheduleItem.id}`,
        )
      }
      if (scheduleItem.sectionId) {
        throw new Error(
          `Section not found for ScheduleItem ${scheduleItem.id}: ${scheduleItem.sectionId}`,
        )
      }
      throw new Error(`Invalid Section placement for Performance: ${scheduleItem.id}`)
    }

    throw new Error(`Invalid Section placement for Break: ${scheduleItem.id}`)
  }

  if (stageSections.length === 0) {
    calculateItems(stageScheduleItems)
    return calculatedItems
  }

  for (const [sectionIndex, section] of stageSections.entries()) {
    if (section.plannedStartTime) {
      currentMinute = parseLocalTimeToMinute(section.plannedStartTime)
      hasExplicitAnchorSincePreviousItem = true
    }

    calculateItems(
      stageScheduleItems.filter(scheduleItem => scheduleItem.sectionId === section.id),
    )

    if (sectionIndex < stageSections.length - 1) {
      calculateItems(
        stageScheduleItems.filter(scheduleItem =>
          scheduleItem.kind === 'break' &&
          scheduleItem.afterSectionId === section.id,
        ),
      )
    }
  }

  return calculatedItems
}
