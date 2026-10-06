import type {
  DutyAssignment, DutyType, DutyTypeId, Event, EventBand, EventDay, EventMember,
  EventMemberDay, Member, PaAssignment, ScheduleItem, Section, Stage,
} from '../domain/models.ts'
import { detectScheduleIssues } from '../domain/issues.ts'
import { compareStableText } from '../domain/schedule.ts'
import {
  getDutyAssignmentScopeStatus,
  getDutyAssignmentsForEvent,
} from '../domain/dutyAssignments.ts'
import { calculateEventDayTimelines } from '../domain/timetable.ts'
import { formatMinuteAsLocalTime } from '../domain/timeline.ts'
import { getMemberDisplayName } from '../ui/eventBandPresentation.ts'
import { createTimetableWorkspaceRows } from '../ui/timetableWorkspaceRows.ts'

export interface TimetableWorkbookInput {
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

export interface TimetableWorkbookSheetModel {
  name: string
  eventDayId: string
  stageId: string
  headers: string[]
  rows: string[][]
}

export interface TimetableWorkbookModel {
  sheets: TimetableWorkbookSheetModel[]
  warnings: string[]
  rowCount: number
}

export type TimetableWorkbookModelResult =
  | { ok: true; model: TimetableWorkbookModel }
  | { ok: false; message: string }

export interface TimetableDutyColumn {
  dutyTypeId: DutyTypeId
  header: string
}

const FIXED_HEADERS = ['スタート時間', '内容', 'Main PA', 'Sub PA'] as const

const compareOrderedIds = (
  left: { order: number; id: string },
  right: { order: number; id: string },
): number => left.order - right.order || compareStableText(left.id, right.id)

const compareAssignments = (
  left: { memberId: string; id: string },
  right: { memberId: string; id: string },
): number =>
  compareStableText(left.memberId, right.memberId) || compareStableText(left.id, right.id)

const createUniqueLabel = (
  base: string,
  used: Set<string>,
  separator = ' ',
): string => {
  let suffix = 1
  let candidate = base
  while (used.has(candidate)) {
    suffix += 1
    candidate = `${base}${separator}(${suffix})`
  }
  used.add(candidate)
  return candidate
}

export const createTimetableDutyColumns = (
  dutyTypes: Pick<DutyType, 'id' | 'name'>[],
  memberColumnCount: number,
): TimetableDutyColumn[] => {
  const fixedHeaders = new Set<string>([
    ...FIXED_HEADERS,
    ...Array.from({ length: memberColumnCount }, (_, index) => `メンバー${index + 1}`),
  ])
  const used = new Set(fixedHeaders)
  return dutyTypes.map((type) => {
    const originalName = type.name.trim() || '当日運営'
    const base = fixedHeaders.has(originalName) ? `当日運営:${originalName}` : originalName
    return { dutyTypeId: type.id, header: createUniqueLabel(base, used) }
  })
}

const sanitizeWorksheetNamePart = (value: string): string =>
  [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    })
    .join('')
    .replace(/[:\\/?*[\]]/g, '_')
    .trim()
    .replace(/^'+|'+$/g, '')

const MAX_WORKSHEET_NAME_LENGTH = 31

const truncateWorksheetNameSafely = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value
  const truncated = value.slice(0, maxLength)
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated
}

const finalizeWorksheetName = (
  value: string,
  fallback: string,
  maxLength = MAX_WORKSHEET_NAME_LENGTH,
): string => {
  const normalize = (candidate: string): string =>
    truncateWorksheetNameSafely(sanitizeWorksheetNamePart(candidate), maxLength)
      .trim()
      .replace(/^'+|'+$/g, '')
      .trim()

  return normalize(value) || normalize(fallback) ||
    truncateWorksheetNameSafely('Sheet', maxLength)
}

export const createTimetableWorksheetNames = (
  items: { date: string; stageName: string }[],
): string[] => {
  const used = new Set<string>()
  return items.map(({ date, stageName }) => {
    const fallbackDate = sanitizeWorksheetNamePart(date)
    const fallback = fallbackDate ? `${fallbackDate} Stage` : 'Sheet'
    const sanitized = sanitizeWorksheetNamePart(`${date} ${stageName}`)
    let sequence = 1
    let candidate = finalizeWorksheetName(sanitized, fallback)
    while (used.has(candidate.toLowerCase())) {
      sequence += 1
      const suffix = ` (${sequence})`
      const prefix = finalizeWorksheetName(
        sanitized,
        fallback,
        MAX_WORKSHEET_NAME_LENGTH - suffix.length,
      )
      candidate = finalizeWorksheetName(`${prefix}${suffix}`, `Sheet${suffix}`)
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

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

const getUniqueEventBandMemberNames = (
  eventBand: EventBand,
  memberById: Map<string, Member>,
): string[] => {
  const seen = new Set<string>()
  return eventBand.memberIds.flatMap((memberId) => {
    if (seen.has(memberId)) return []
    seen.add(memberId)
    const member = memberById.get(memberId)
    return [member ? getMemberDisplayName(member) : '不明なメンバー']
  })
}

export const createTimetableWorkbookModel = (
  input: TimetableWorkbookInput,
): TimetableWorkbookModelResult => {
  const eventDays = input.eventDays
    .filter((day) => day.eventId === input.event.id)
    .sort((left, right) =>
      left.order - right.order ||
      compareStableText(left.date, right.date) ||
      compareStableText(left.id, right.id),
    )
  const eventDayIds = new Set(eventDays.map((day) => day.id))
  const stages = input.stages.filter((stage) => eventDayIds.has(stage.eventDayId))
  const eventBands = input.eventBands.filter((band) => band.eventId === input.event.id)
  const dutyTypes = input.dutyTypes.filter((type) => type.eventId === input.event.id)
    .sort(compareOrderedIds)
  const eventPaAssignments = input.paAssignments.filter((assignment) =>
    assignment.eventId === input.event.id,
  ).sort(compareAssignments)
  const eventDutyAssignments = getDutyAssignmentsForEvent({
    event: input.event,
    stages,
    dutyTypes: input.dutyTypes,
    dutyAssignments: input.dutyAssignments,
  }).sort(compareAssignments)
  const memberById = new Map(input.members.map((member) => [member.id, member]))
  const paById = new Map(eventPaAssignments.map((assignment) => [assignment.id, assignment]))
  const dutyById = new Map(eventDutyAssignments.map((assignment) => [assignment.id, assignment]))
  const memberColumnCount = Math.max(7, ...eventBands.map((band) => band.memberIds.length))
  const memberHeaders = Array.from(
    { length: memberColumnCount },
    (_, index) => `メンバー${index + 1}`,
  )
  const dutyColumns = createTimetableDutyColumns(dutyTypes, memberColumnCount)
  const headers = [
    'スタート時間', '内容', ...memberHeaders, 'Main PA', 'Sub PA',
    ...dutyColumns.map((column) => column.header),
  ]
  const orderedScopes = eventDays.flatMap((eventDay) =>
    stages.filter((stage) => stage.eventDayId === eventDay.id)
      .sort(compareOrderedIds)
      .map((stage) => ({ eventDay, stage })),
  )
  const sheetNames = createTimetableWorksheetNames(orderedScopes.map(({ eventDay, stage }) => ({
    date: eventDay.date,
    stageName: stage.name,
  })))
  const warnings = new Set<string>()
  const assignmentWarning = 'Grid外または参照切れの担当はExcelの各行に完全には反映されていません。'
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

  const sheets: TimetableWorkbookSheetModel[] = []
  let rowCount = 0
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
        message: `${eventDay.label || eventDay.date}のタイムテーブルを計算できないためExcelを書き出せません。`,
      }
    }
    if (timelines.invalidStages.length > 0) {
      const invalidStage = stages.find((stage) => stage.id === timelines.invalidStages[0].stageId)
      return {
        ok: false,
        message: `${invalidStage?.name ?? timelines.invalidStages[0].stageId} Stageのタイムテーブルを計算できないためExcelを書き出せません。`,
      }
    }
    const dayStages = stages.filter((stage) => stage.eventDayId === eventDay.id)
      .sort(compareOrderedIds)
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
      const scopeIndex = orderedScopes.findIndex((scope) =>
        scope.eventDay.id === eventDay.id && scope.stage.id === stage.id,
      )
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
      const rows = workspace.rows.map((row) => {
        const item = row.scheduleItem
        const memberNames = item.kind === 'performance' && row.eventBand
          ? getUniqueEventBandMemberNames(row.eventBand, memberById)
          : []
        return [
          formatMinuteAsLocalTime(row.calculatedItem.plannedStartMinute),
          item.kind === 'performance' ? row.eventBand?.name ?? '' : item.title,
          ...Array.from({ length: memberColumnCount }, (_, index) => memberNames[index] ?? ''),
          joinUniqueIdentityLabels(row.paCoverage.main.map((coverage) => ({
            identity: paById.get(coverage.assignmentId)?.memberId ?? `pa:${coverage.assignmentId}`,
            label: coverage.memberName,
          }))),
          joinUniqueIdentityLabels(row.paCoverage.sub.map((coverage) => ({
            identity: paById.get(coverage.assignmentId)?.memberId ?? `pa:${coverage.assignmentId}`,
            label: coverage.memberName,
          }))),
          ...dutyColumns.map((column) => joinUniqueIdentityLabels(
            (row.dutyCoverage[column.dutyTypeId] ?? []).map((coverage) => ({
              identity: dutyById.get(coverage.assignmentId)?.memberId ??
                `duty:${coverage.assignmentId}`,
              label: coverage.memberName,
            })),
          )),
        ]
      })
      rowCount += rows.length
      sheets.push({
        name: sheetNames[scopeIndex],
        eventDayId: eventDay.id,
        stageId: stage.id,
        headers: [...headers],
        rows,
      })
    }
  }
  return { ok: true, model: { sheets, warnings: [...warnings], rowCount } }
}

const sanitizeFilenamePart = (value: string): string =>
  [...value]
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x1f)
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')

const pad = (value: number): string => String(value).padStart(2, '0')

export const createTimetableWorkbookFilename = (event: Event, now = new Date()): string => {
  const eventPart = sanitizeFilenamePart(event.name) || sanitizeFilenamePart(event.id) || 'event'
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `acappella-tt-${eventPart}-timetable-${timestamp}.xlsx`
}
