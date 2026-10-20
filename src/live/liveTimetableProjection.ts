import {
  getEventDaysForEvent,
  getSectionsForStage,
  getStagesForEventDay,
} from '../domain/schedule.ts'
import { calculateStageTimeline } from '../domain/timeline.ts'
import {
  parseCloudEventSnapshot,
  type CloudEventSnapshotV1,
} from '../cloud/cloudEventSnapshot.ts'

export const LIVE_TIMETABLE_PROJECTION_FORMAT =
  'acappella-tt-live-timetable-projection' as const
export const LIVE_TIMETABLE_PROJECTION_VERSION = 1 as const

export interface LiveTimetableProjectionEventDay {
  sourceEventDayId: string
  date: string
  label: string | null
  position: number
}

export interface LiveTimetableProjectionSection {
  sourceSectionId: string
  name: string
  position: number
  plannedStartTime: string | null
  plannedEndTime: string | null
}

export interface LiveTimetableProjectionEntry {
  sourceScheduleItemId: string
  sourceSectionId: string | null
  afterSectionId: string | null
  kind: 'performance' | 'break'
  position: number
  displayName: string
  plannedStartMinute: number
  plannedEndMinute: number
}

export interface LiveTimetableProjectionStage {
  sourceEventDayId: string
  eventDayPosition: number
  sourceStageId: string
  name: string
  position: number
  plannedStartTime: string
  plannedEndTime: string | null
  sections: LiveTimetableProjectionSection[]
  entries: LiveTimetableProjectionEntry[]
}

export interface LiveTimetableProjection {
  format: typeof LIVE_TIMETABLE_PROJECTION_FORMAT
  version: typeof LIVE_TIMETABLE_PROJECTION_VERSION
  eventId: string
  eventName: string
  timeZone: string
  eventDays: LiveTimetableProjectionEventDay[]
  stages: LiveTimetableProjectionStage[]
}

export type LiveTimetableProjectionResult =
  | { ok: true; projection: LiveTimetableProjection }
  | { ok: false; reason: 'INVALID_SNAPSHOT' | 'INVALID_TIMELINE' }

const buildProjection = (
  snapshot: CloudEventSnapshotV1,
): LiveTimetableProjectionResult => {
  const state = snapshot.appState
  const event = state.events[0]
  if (!event) return { ok: false, reason: 'INVALID_SNAPSHOT' }

  const eventDays = getEventDaysForEvent(state.eventDays, event.id)
  const eventBandsById = new Map(state.eventBands.map(band => [band.id, band]))
  const scheduleItemsById = new Map(
    state.scheduleItems.map(item => [item.id, item]),
  )
  const stages: LiveTimetableProjectionStage[] = []

  try {
    for (const [eventDayPosition, eventDay] of eventDays.entries()) {
      for (const stage of getStagesForEventDay(state.stages, eventDay.id)) {
        const stageSections = getSectionsForStage(state.sections, stage.id)
        const timeline = calculateStageTimeline({
          stage,
          sections: stageSections,
          scheduleItems: state.scheduleItems,
          eventBands: state.eventBands,
        })

        const entries = timeline.map((calculated, position) => {
          const item = scheduleItemsById.get(calculated.scheduleItemId)
          if (!item) throw new Error('ScheduleItem is missing')
          const displayName = item.kind === 'performance'
            ? eventBandsById.get(item.eventBandId)?.name
            : '休憩'
          if (!displayName) throw new Error('EventBand is missing')

          return {
            sourceScheduleItemId: item.id,
            sourceSectionId: item.sectionId ?? null,
            afterSectionId: item.kind === 'break'
              ? item.afterSectionId ?? null
              : null,
            kind: item.kind,
            position,
            displayName,
            plannedStartMinute: calculated.plannedStartMinute,
            plannedEndMinute: calculated.plannedEndMinute,
          } satisfies LiveTimetableProjectionEntry
        })

        const expectedItemCount = state.scheduleItems.filter(
          item => item.stageId === stage.id,
        ).length
        if (entries.length !== expectedItemCount) {
          return { ok: false, reason: 'INVALID_TIMELINE' }
        }

        stages.push({
          sourceEventDayId: eventDay.id,
          eventDayPosition,
          sourceStageId: stage.id,
          name: stage.name,
          position: stages.length,
          plannedStartTime: stage.plannedStartTime,
          plannedEndTime: stage.plannedEndTime ?? null,
          sections: stageSections.map((section, position) => ({
            sourceSectionId: section.id,
            name: section.name,
            position,
            plannedStartTime: section.plannedStartTime ?? null,
            plannedEndTime: section.plannedEndTime ?? null,
          })),
          entries,
        })
      }
    }
  } catch {
    return { ok: false, reason: 'INVALID_TIMELINE' }
  }

  return {
    ok: true,
    projection: {
      format: LIVE_TIMETABLE_PROJECTION_FORMAT,
      version: LIVE_TIMETABLE_PROJECTION_VERSION,
      eventId: event.id,
      eventName: event.name,
      timeZone: event.timeZone,
      eventDays: eventDays.map((eventDay, position) => ({
        sourceEventDayId: eventDay.id,
        date: eventDay.date,
        label: eventDay.label ?? null,
        position,
      })),
      stages,
    },
  }
}

/**
 * Creates the immutable public Live projection from a fully validated V1
 * Cloud Event snapshot. The input is never mutated and no Master, PA, Duty,
 * note, or member fields are copied into the projection.
 */
export const createLiveTimetableProjection = (
  value: unknown,
): LiveTimetableProjectionResult => {
  const snapshot = parseCloudEventSnapshot(value)
  return snapshot
    ? buildProjection(snapshot)
    : { ok: false, reason: 'INVALID_SNAPSHOT' }
}
