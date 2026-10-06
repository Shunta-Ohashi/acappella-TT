import { getDutyAssignmentScopeStatus, getDutyAssignmentsForEvent } from '../domain/dutyAssignments.ts'
import { isValidLocalDate } from '../domain/eventCreation.ts'
import { detectScheduleIssues } from '../domain/issues.ts'
import { compareStableText } from '../domain/schedule.ts'
import { isValidStageTimeRange } from '../domain/stageTimeRanges.ts'
import { calculateEventDayTimelines } from '../domain/timetable.ts'
import {
  formatMinuteAsLocalTime,
  isValidLocalTime,
  parseLocalTimeToMinute,
} from '../domain/timeline.ts'
import type { TimetableWorkbookInput } from '../export/timetableWorkbook.ts'
import { createTimetableWorkspaceRows } from '../ui/timetableWorkspaceRows.ts'

export const TIMETABLE_PRE_SHARE_VERSION = 1 as const

export interface TimetablePreShareDuty {
  name: string
  members: string[]
}

export interface TimetablePreShareEntry {
  startTime: string
  endTime: string
  kind: 'performance' | 'break'
  title: string
  members: string[]
  mainPa: string[]
  subPa: string[]
  duties: TimetablePreShareDuty[]
}

export interface TimetablePreShareStage {
  name: string
  plannedStartTime: string
  plannedEndTime?: string
  entries: TimetablePreShareEntry[]
}

export interface TimetablePreShareDay {
  date: string
  label?: string
  stages: TimetablePreShareStage[]
}

export interface TimetablePreShareSnapshotV1 {
  version: typeof TIMETABLE_PRE_SHARE_VERSION
  eventName: string
  createdAt: string
  days: TimetablePreShareDay[]
}

export type TimetablePreShareSnapshotResult =
  | { ok: true; snapshot: TimetablePreShareSnapshotV1; warnings: string[] }
  | { ok: false; message: string }

const compareOrderedIds = (
  left: { order: number; id: string },
  right: { order: number; id: string },
): number => left.order - right.order || compareStableText(left.id, right.id)

const compareAssignments = (
  left: { memberId: string; id: string },
  right: { memberId: string; id: string },
): number => compareStableText(left.memberId, right.memberId) || compareStableText(left.id, right.id)

const uniqueLabelsByIdentity = (
  values: { identity: string; label: string }[],
): string[] => {
  const seen = new Set<string>()
  return values.flatMap(({ identity, label }) => {
    if (seen.has(identity)) return []
    seen.add(identity)
    return [label]
  })
}

const formatShareMinute = (minute: number): string =>
  minute === 24 * 60 ? '24:00' : formatMinuteAsLocalTime(minute)

const INCOMPLETE_ASSIGNMENTS_WARNING =
  'Grid外または参照切れの担当は共有ページの各行に完全には反映されていません。'

export const createTimetablePreShareSnapshot = (
  input: TimetableWorkbookInput,
  now = new Date(),
): TimetablePreShareSnapshotResult => {
  if (!Number.isFinite(now.getTime())) {
    return { ok: false, message: '共有タイムテーブルの作成日時が正しくありません。' }
  }
  const eventDays = input.eventDays.filter(day => day.eventId === input.event.id)
    .sort((left, right) => left.order - right.order ||
      compareStableText(left.date, right.date) || compareStableText(left.id, right.id))
  const eventDayIds = new Set(eventDays.map(day => day.id))
  const stages = input.stages.filter(stage => eventDayIds.has(stage.eventDayId))
  const eventBands = input.eventBands.filter(band => band.eventId === input.event.id)
  const dutyTypes = input.dutyTypes.filter(type => type.eventId === input.event.id)
    .sort(compareOrderedIds)
  const eventPaAssignments = input.paAssignments.filter(assignment =>
    assignment.eventId === input.event.id,
  ).sort(compareAssignments)
  const eventDutyAssignments = getDutyAssignmentsForEvent({
    event: input.event,
    stages,
    dutyTypes: input.dutyTypes,
    dutyAssignments: input.dutyAssignments,
  }).sort(compareAssignments)
  const memberById = new Map(input.members.map(member => [member.id, member]))
  const paById = new Map(eventPaAssignments.map(assignment => [assignment.id, assignment]))
  const dutyById = new Map(eventDutyAssignments.map(assignment => [assignment.id, assignment]))
  const eventDayById = new Map(input.eventDays.map(day => [day.id, day]))
  const stageById = new Map(input.stages.map(stage => [stage.id, stage]))
  const warnings = new Set<string>()

  if (eventPaAssignments.some((assignment) => {
    const eventDay = eventDayById.get(assignment.eventDayId)
    const stage = stageById.get(assignment.stageId)
    return !eventDay || eventDay.eventId !== input.event.id || !stage ||
      stage.eventDayId !== assignment.eventDayId || !memberById.has(assignment.memberId)
  }) || eventDutyAssignments.some(assignment =>
    !getDutyAssignmentScopeStatus({
      assignment,
      event: input.event,
      eventDays: input.eventDays,
      stages: input.stages,
    }).valid || !memberById.has(assignment.memberId),
  )) warnings.add(INCOMPLETE_ASSIGNMENTS_WARNING)

  const days: TimetablePreShareDay[] = []
  for (const eventDay of eventDays) {
    let timelines
    try {
      timelines = calculateEventDayTimelines({
        eventDayId: eventDay.id,
        stages,
        sections: input.sections,
        scheduleItems: input.scheduleItems,
        eventBands,
      })
    } catch {
      return {
        ok: false,
        message: `${eventDay.label || eventDay.date}のタイムテーブルを計算できないため共有リンクを作成できません。`,
      }
    }
    if (timelines.invalidStages.length > 0) {
      const invalidStage = stages.find(stage => stage.id === timelines.invalidStages[0].stageId)
      return {
        ok: false,
        message: `${invalidStage?.name ?? '対象'} Stageのタイムテーブルを計算できないため共有リンクを作成できません。`,
      }
    }
    const dayStages = stages.filter(stage => stage.eventDayId === eventDay.id)
      .sort(compareOrderedIds)
    const issues = detectScheduleIssues({
      event: input.event,
      members: input.members,
      eventMembers: input.eventMembers.filter(member => member.eventId === input.event.id),
      eventMemberDays: input.eventMemberDays,
      eventBands,
      stages: dayStages,
      sections: input.sections,
      paAssignments: eventPaAssignments.filter(assignment => assignment.eventDayId === eventDay.id),
      dutyTypes,
      dutyAssignments: eventDutyAssignments.filter(assignment =>
        assignment.eventDayId === eventDay.id,
      ),
      calculatedItems: timelines.calculatedItems,
    })
    const shareStages: TimetablePreShareStage[] = []
    for (const stage of dayStages) {
      const workspace = createTimetableWorkspaceRows({
        eventDayId: eventDay.id,
        stageId: stage.id,
        scheduleItems: input.scheduleItems,
        calculatedItems: timelines.calculatedItems.filter(item => item.stageId === stage.id),
        eventBands,
        members: input.members,
        paAssignments: eventPaAssignments,
        dutyTypes,
        dutyAssignments: eventDutyAssignments,
        issues,
        stages,
        sections: input.sections,
      })
      if (
        workspace.unresolvedPaAssignments.length > 0 ||
        workspace.offGridPaAssignments.length > 0 ||
        workspace.unresolvedDutyAssignments.length > 0 ||
        workspace.offGridDutyAssignments.length > 0
      ) warnings.add(INCOMPLETE_ASSIGNMENTS_WARNING)

      const entries = workspace.rows.map((row): TimetablePreShareEntry => ({
        startTime: formatShareMinute(row.calculatedItem.plannedStartMinute),
        endTime: formatShareMinute(row.calculatedItem.plannedEndMinute),
        kind: row.scheduleItem.kind,
        title: row.scheduleItem.kind === 'performance'
          ? row.eventBand?.name ?? '不明な出演バンド'
          : row.scheduleItem.title,
        members: row.scheduleItem.kind === 'performance'
          ? uniqueLabelsByIdentity(row.eventBand?.memberIds.map((memberId, index) => ({
              identity: memberId,
              label: row.memberNames[index] ?? '不明なメンバー',
            })) ?? [])
          : [],
        mainPa: uniqueLabelsByIdentity(row.paCoverage.main.map(coverage => ({
          identity: paById.get(coverage.assignmentId)?.memberId ?? `missing:${coverage.assignmentId}`,
          label: coverage.memberName,
        }))),
        subPa: uniqueLabelsByIdentity(row.paCoverage.sub.map(coverage => ({
          identity: paById.get(coverage.assignmentId)?.memberId ?? `missing:${coverage.assignmentId}`,
          label: coverage.memberName,
        }))),
        duties: dutyTypes.flatMap(dutyType => {
          const members = uniqueLabelsByIdentity(
            (row.dutyCoverage[dutyType.id] ?? []).map(coverage => ({
              identity: dutyById.get(coverage.assignmentId)?.memberId ??
                `missing:${coverage.assignmentId}`,
              label: coverage.memberName,
            })),
          )
          return members.length > 0 ? [{ name: dutyType.name, members }] : []
        }),
      }))
      shareStages.push({
        name: stage.name,
        plannedStartTime: stage.plannedStartTime,
        ...(stage.plannedEndTime ? { plannedEndTime: stage.plannedEndTime } : {}),
        entries,
      })
    }
    days.push({
      date: eventDay.date,
      ...(eventDay.label ? { label: eventDay.label } : {}),
      stages: shareStages,
    })
  }
  return {
    ok: true,
    snapshot: {
      version: TIMETABLE_PRE_SHARE_VERSION,
      eventName: input.event.name,
      createdAt: now.toISOString(),
      days,
    },
    warnings: [...warnings],
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const parseStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const values = Array.from(value)
  return values.every(item => typeof item === 'string') ? values : undefined
}

const isDisplayTime = (value: string): boolean => value === '24:00' || isValidLocalTime(value)

const parseDisplayTimeToMinute = (value: string): number | undefined => {
  if (value === '24:00') return 24 * 60
  return isValidLocalTime(value) ? parseLocalTimeToMinute(value) : undefined
}

const isValidDisplayTimeRange = (startTime: string, endTime: string): boolean => {
  const startMinute = parseDisplayTimeToMinute(startTime)
  const endMinute = parseDisplayTimeToMinute(endTime)
  return startMinute !== undefined && endMinute !== undefined && startMinute < endMinute
}

const parseDuty = (value: unknown): TimetablePreShareDuty | undefined => {
  if (!isRecord(value)) return undefined
  const name = parseString(value.name)
  const members = parseStringArray(value.members)
  return name !== undefined && members !== undefined ? { name, members } : undefined
}

const parseEntry = (value: unknown): TimetablePreShareEntry | undefined => {
  if (!isRecord(value)) return undefined
  const startTime = parseString(value.startTime)
  const endTime = parseString(value.endTime)
  const title = parseString(value.title)
  const members = parseStringArray(value.members)
  const mainPa = parseStringArray(value.mainPa)
  const subPa = parseStringArray(value.subPa)
  if (
    !startTime || !endTime || !isDisplayTime(startTime) || !isDisplayTime(endTime) ||
    !isValidDisplayTimeRange(startTime, endTime) ||
    (value.kind !== 'performance' && value.kind !== 'break') || title === undefined ||
    members === undefined || mainPa === undefined || subPa === undefined ||
    !Array.isArray(value.duties)
  ) return undefined
  const duties = Array.from(value.duties).map(parseDuty)
  if (duties.some(duty => duty === undefined)) return undefined
  return {
    startTime,
    endTime,
    kind: value.kind,
    title,
    members,
    mainPa,
    subPa,
    duties: duties as TimetablePreShareDuty[],
  }
}

const parseStage = (value: unknown): TimetablePreShareStage | undefined => {
  if (!isRecord(value)) return undefined
  const name = parseString(value.name)
  const plannedStartTime = parseString(value.plannedStartTime)
  const plannedEndTime = value.plannedEndTime === undefined
    ? undefined
    : parseString(value.plannedEndTime)
  if (
    name === undefined || !plannedStartTime ||
    (plannedEndTime === undefined && value.plannedEndTime !== undefined) ||
    !isValidStageTimeRange(plannedStartTime, plannedEndTime) ||
    !Array.isArray(value.entries)
  ) return undefined
  const entries = Array.from(value.entries).map(parseEntry)
  if (entries.some(entry => entry === undefined)) return undefined
  return {
    name,
    plannedStartTime,
    ...(plannedEndTime ? { plannedEndTime } : {}),
    entries: entries as TimetablePreShareEntry[],
  }
}

const parseDay = (value: unknown): TimetablePreShareDay | undefined => {
  if (!isRecord(value)) return undefined
  const date = parseString(value.date)
  const label = value.label === undefined ? undefined : parseString(value.label)
  if (!date || !isValidLocalDate(date) ||
    (label === undefined && value.label !== undefined) ||
    !Array.isArray(value.stages)) return undefined
  const stages = Array.from(value.stages).map(parseStage)
  if (stages.some(stage => stage === undefined)) return undefined
  return { date, ...(label ? { label } : {}), stages: stages as TimetablePreShareStage[] }
}

export const parseTimetablePreShareSnapshot = (
  value: unknown,
): TimetablePreShareSnapshotV1 | undefined => {
  if (!isRecord(value) || value.version !== TIMETABLE_PRE_SHARE_VERSION) return undefined
  const eventName = parseString(value.eventName)
  const createdAt = parseString(value.createdAt)
  const createdAtDate = createdAt ? new Date(createdAt) : undefined
  if (!eventName || !createdAt || !createdAtDate ||
    !Number.isFinite(createdAtDate.getTime()) || createdAtDate.toISOString() !== createdAt ||
    !Array.isArray(value.days)) return undefined
  const days = Array.from(value.days).map(parseDay)
  return days.some(day => day === undefined)
    ? undefined
    : { version: TIMETABLE_PRE_SHARE_VERSION, eventName, createdAt, days: days as TimetablePreShareDay[] }
}

const normalizeSearch = (value: string): string =>
  value.normalize('NFKC').trim().toLocaleLowerCase()

export const filterTimetablePreShareEntries = (
  entries: TimetablePreShareEntry[],
  query: string,
): TimetablePreShareEntry[] => {
  const normalizedQuery = normalizeSearch(query)
  if (!normalizedQuery) return [...entries]
  return entries.filter(entry => {
    const values = [
      ...(entry.kind === 'performance' ? [entry.title] : []),
      ...entry.members,
      ...entry.mainPa,
      ...entry.subPa,
      ...entry.duties.flatMap(duty => [duty.name, ...duty.members]),
    ]
    return values.some(value => normalizeSearch(value).includes(normalizedQuery))
  })
}

export interface TimetablePreShareSummary {
  startTime?: string
  endTime?: string
  performanceCount: number
  breakCount: number
}

const summarizeEntries = (
  entries: TimetablePreShareEntry[],
  fallbackStart?: string,
  fallbackEnd?: string,
): TimetablePreShareSummary => {
  const startTime = entries.length > 0
    ? entries.reduce((minimum, entry) =>
        entry.startTime < minimum ? entry.startTime : minimum, entries[0].startTime)
    : fallbackStart
  const endTime = entries.length > 0
    ? entries.reduce((maximum, entry) =>
        entry.endTime > maximum ? entry.endTime : maximum, entries[0].endTime)
    : fallbackEnd
  return {
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    performanceCount: entries.filter(entry => entry.kind === 'performance').length,
    breakCount: entries.filter(entry => entry.kind === 'break').length,
  }
}

export const getTimetablePreShareStageSummary = (
  stage: TimetablePreShareStage,
): TimetablePreShareSummary =>
  summarizeEntries(stage.entries, stage.plannedStartTime, stage.plannedEndTime)

export const getTimetablePreShareDaySummary = (
  day: TimetablePreShareDay,
): TimetablePreShareSummary =>
  summarizeEntries(day.stages.flatMap(stage => stage.entries))
