import type {
  DutyAssignment, DutyType, Event, EventBand, EventDay, EventMember, EventMemberDay,
  Member, PaAssignment, ScheduleItem, Section, Stage,
} from '../domain/models.ts'
import { detectScheduleIssues } from '../domain/issues.ts'
import {
  getDutyAssignmentScopeStatus,
  getDutyAssignmentsForEvent,
} from '../domain/dutyAssignments.ts'
import { calculateEventDayTimelines } from '../domain/timetable.ts'
import { formatMinuteAsLocalTime } from '../domain/timeline.ts'
import { getInterSectionBreakPresentation } from '../ui/interSectionBreakPresentation.ts'
import { getMemberDisplayName } from '../ui/eventBandPresentation.ts'
import { createTimetableWorkspaceRows } from '../ui/timetableWorkspaceRows.ts'
import { serializeSpreadsheetCsv } from './spreadsheetCsv.ts'
import { getOrderedEventDays } from './eventCsvShared.ts'

export interface TimetableCsvInput {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
}

export type TimetableCsvResult =
  | { ok: true; csv: string; rowCount: number; warnings: string[] }
  | { ok: false; message: string }

const BASE_HEADERS = [
  '開催日', '開催日ラベル', 'Stage', 'Section', '開始', '終了', '種別', '名称',
  'メンバー', '所要時間', 'Main PA', 'Sub PA',
] as const
const LAST_HEADERS = ['ERROR', 'WARNING', 'INFO', 'ScheduleItem ID', 'EventBand ID'] as const

const joinUniqueIdentityLabels = (
  values: { identity: string; label: string }[],
): string => {
  const seen = new Set<string>()
  return values.flatMap(({ identity, label }) => {
    if (seen.has(identity)) return []
    seen.add(identity)
    return [label]
  }).join('|')
}

export const createTimetableCsv = (input: TimetableCsvInput): TimetableCsvResult => {
  const eventDays = getOrderedEventDays(input.event, input.eventDays)
  const eventDayIds = new Set(eventDays.map((day) => day.id))
  const stages = input.stages.filter((stage) => eventDayIds.has(stage.eventDayId))
  const eventBands = input.eventBands.filter((band) => band.eventId === input.event.id)
  const dutyTypes = input.dutyTypes.filter((type) => type.eventId === input.event.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const eventPaAssignments = input.paAssignments.filter((assignment) =>
    assignment.eventId === input.event.id,
  )
  const eventDutyAssignments = getDutyAssignmentsForEvent({
    event: input.event,
    stages,
    dutyTypes: input.dutyTypes,
    dutyAssignments: input.dutyAssignments,
  })
  const memberById = new Map(input.members.map((member) => [member.id, member]))
  const paById = new Map(eventPaAssignments.map((assignment) => [assignment.id, assignment]))
  const dutyById = new Map(eventDutyAssignments.map((assignment) => [assignment.id, assignment]))
  const rows: string[][] = [[
    ...BASE_HEADERS,
    ...dutyTypes.map((type) => `当日運営:${type.name}`),
    ...LAST_HEADERS,
  ]]
  const warnings = new Set<string>()
  const assignmentWarning = 'Grid外または参照切れの担当はCSVの各行に完全には反映されていません。'
  const eventDayById = new Map(input.eventDays.map((day) => [day.id, day]))
  const stageById = new Map(input.stages.map((stage) => [stage.id, stage]))
  const hasInvalidPaScope = eventPaAssignments.some((assignment) => {
      const eventDay = eventDayById.get(assignment.eventDayId)
      const stage = stageById.get(assignment.stageId)
      return !eventDay || eventDay.eventId !== input.event.id || !stage ||
        stage.eventDayId !== assignment.eventDayId || !memberById.has(assignment.memberId)
    })
  const hasInvalidDutyScope = eventDutyAssignments.some((assignment) =>
    !getDutyAssignmentScopeStatus({
      assignment,
      event: input.event,
      eventDays: input.eventDays,
      stages: input.stages,
    }).valid || !memberById.has(assignment.memberId),
  )
  if (hasInvalidPaScope || hasInvalidDutyScope) warnings.add(assignmentWarning)

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
      return { ok: false, message: `${eventDay.label || eventDay.date}のタイムテーブルを計算できないためCSVを書き出せません。` }
    }
    if (timelines.invalidStages.length > 0) {
      const invalidStage = stages.find((stage) => stage.id === timelines.invalidStages[0].stageId)
      return { ok: false, message: `${invalidStage?.name ?? timelines.invalidStages[0].stageId} Stageのタイムテーブルを計算できないためCSVを書き出せません。` }
    }
    const dayStages = stages.filter((stage) => stage.eventDayId === eventDay.id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    const issues = detectScheduleIssues({
      event: input.event,
      members: input.members,
      eventMembers: input.eventMembers.filter((member) => member.eventId === input.event.id),
      eventMemberDays: input.eventMemberDays,
      eventBands,
      stages: dayStages,
      sections: input.sections,
      paAssignments: eventPaAssignments.filter((assignment) =>
        assignment.eventDayId === eventDay.id),
      dutyTypes,
      dutyAssignments: eventDutyAssignments.filter((assignment) =>
        assignment.eventDayId === eventDay.id),
      calculatedItems: timelines.calculatedItems,
    })

    for (const stage of dayStages) {
      const stageSections = input.sections.filter((section) => section.stageId === stage.id)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      const workspace = createTimetableWorkspaceRows({
        eventDayId: eventDay.id,
        stageId: stage.id,
        scheduleItems: input.scheduleItems,
        calculatedItems: timelines.calculatedItems.filter((item) => item.stageId === stage.id),
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
      ) {
        warnings.add(assignmentWarning)
      }
      for (const row of workspace.rows) {
        const item = row.scheduleItem
        const section = item.sectionId
          ? stageSections.find((candidate) => candidate.id === item.sectionId)
          : undefined
        let sectionLabel = section?.name ?? ''
        if (item.kind === 'break' && item.afterSectionId) {
          const previousIndex = stageSections.findIndex((candidate) => candidate.id === item.afterSectionId)
          const nextSection = stageSections[previousIndex + 1]
          if (previousIndex >= 0 && nextSection) {
            sectionLabel = getInterSectionBreakPresentation(
              stageSections[previousIndex], nextSection, [
                { id: 'time', label: '時刻', width: 1 },
                { id: 'item', label: '内容', width: 1 },
              ], item,
            ).sectionLabel
          }
        }
        rows.push([
          eventDay.date,
          eventDay.label ?? '',
          stage.name,
          sectionLabel,
          formatMinuteAsLocalTime(row.calculatedItem.plannedStartMinute),
          formatMinuteAsLocalTime(row.calculatedItem.plannedEndMinute),
          item.kind === 'performance' ? '出演' : '休憩',
          item.kind === 'performance' ? row.eventBand?.name ?? '' : item.title,
          item.kind === 'performance' && row.eventBand
            ? joinUniqueIdentityLabels(row.eventBand.memberIds.map((memberId) => ({
                identity: memberId,
                label: memberById.has(memberId)
                  ? getMemberDisplayName(memberById.get(memberId)!)
                  : '不明なメンバー',
              })))
            : '',
          String(item.kind === 'performance' ? row.eventBand?.durationMinutes ?? '' : item.durationMinutes),
          joinUniqueIdentityLabels(row.paCoverage.main.map((coverage) => ({
            identity: paById.get(coverage.assignmentId)?.memberId ?? `pa:${coverage.assignmentId}`,
            label: coverage.memberName,
          }))),
          joinUniqueIdentityLabels(row.paCoverage.sub.map((coverage) => ({
            identity: paById.get(coverage.assignmentId)?.memberId ?? `pa:${coverage.assignmentId}`,
            label: coverage.memberName,
          }))),
          ...dutyTypes.map((type) => joinUniqueIdentityLabels(
            (row.dutyCoverage[type.id] ?? []).map((coverage) => ({
              identity: dutyById.get(coverage.assignmentId)?.memberId ?? `duty:${coverage.assignmentId}`,
              label: coverage.memberName,
            })),
          )),
          String(row.issueCounts.ERROR),
          String(row.issueCounts.WARNING),
          String(row.issueCounts.INFO),
          item.id,
          item.kind === 'performance' ? item.eventBandId : '',
        ])
      }
    }
  }
  return { ok: true, csv: serializeSpreadsheetCsv(rows), rowCount: rows.length - 1, warnings: [...warnings] }
}

const sanitizeFilenamePart = (value: string): string =>
  [...value]
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x1f)
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')

const pad = (value: number): string => String(value).padStart(2, '0')

export const createTimetableCsvFilename = (event: Event, now = new Date()): string => {
  const eventPart = sanitizeFilenamePart(event.name) || sanitizeFilenamePart(event.id) || 'event'
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `acappella-tt-${eventPart}-timetable-${timestamp}.csv`
}
