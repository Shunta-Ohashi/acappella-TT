import type { IssueSeverity, ScheduleIssue } from '../domain/issues'
import type {
  DutyType,
  EventBand,
  Member,
  ScheduleItem,
  ScheduleItemId,
  Section,
  Stage,
  StageId,
} from '../domain/models'

export const ISSUE_SEVERITIES: IssueSeverity[] = [
  'ERROR',
  'WARNING',
  'INFO',
]

const severityPriority: Record<IssueSeverity, number> = {
  ERROR: 3,
  WARNING: 2,
  INFO: 1,
}

export type IssueSeverityCounts = Record<IssueSeverity, number>

export const countIssuesBySeverity = (
  issues: ReadonlyArray<Pick<ScheduleIssue, 'severity'>>,
): IssueSeverityCounts => {
  const counts: IssueSeverityCounts = {
    ERROR: 0,
    WARNING: 0,
    INFO: 0,
  }

  issues.forEach((issue) => {
    counts[issue.severity] += 1
  })

  return counts
}

export interface ScheduleIssueMessageContext {
  members: Member[]
  eventBands: EventBand[]
  dutyTypes?: DutyType[]
  stages: Stage[]
  sections: Section[]
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const replaceEntityTokens = (
  message: string,
  replacements: ReadonlyArray<readonly [token: string, replacement: string]>,
): string => {
  const replacementByToken = new Map(replacements)
  const tokens = [...replacementByToken.keys()].sort((left, right) => right.length - left.length)
  if (tokens.length === 0) return message
  const tokenPattern = new RegExp(tokens.map(escapeRegExp).join('|'), 'g')
  return message.replace(tokenPattern, token => replacementByToken.get(token) ?? token)
}

export const formatScheduleIssueMessage = (
  issue: ScheduleIssue,
  {
    members,
    eventBands,
    dutyTypes = [],
    stages,
    sections,
  }: ScheduleIssueMessageContext,
): string => {
  const memberNameById = new Map(members.map(member => [member.id, member.realName]))
  const eventBandNameById = new Map(eventBands.map(band => [band.id, band.name]))
  const dutyTypeNameById = new Map(dutyTypes.map(type => [type.id, type.name]))
  const stageNameById = new Map(stages.map(stage => [stage.id, stage.name]))
  const sectionNameById = new Map(sections.map(section => [section.id, section.name]))
  const replacements: Array<readonly [string, string]> = []
  issue.memberIds?.forEach((memberId) => {
    const name = memberNameById.get(memberId) ?? '不明なメンバー'
    replacements.push([`メンバー ${memberId}`, `メンバー「${name}」`])
  })
  issue.eventBandIds?.forEach((eventBandId) => {
    const name = eventBandNameById.get(eventBandId) ?? '不明なバンド'
    replacements.push([`EventBand ${eventBandId}`, `バンド「${name}」`])
  })
  issue.stageIds?.forEach((stageId) => {
    const name = stageNameById.get(stageId) ?? '不明なStage'
    replacements.push([`Stage ${stageId}`, `Stage「${name}」`])
  })
  issue.dutyTypeIds?.forEach((dutyTypeId) => {
    const name = dutyTypeNameById.get(dutyTypeId) ?? '不明な仕事'
    replacements.push([`DutyType ${dutyTypeId}`, `仕事「${name}」`])
  })
  issue.sectionIds?.forEach((sectionId) => {
    const name = sectionNameById.get(sectionId) ?? '不明なSection'
    replacements.push([`Section ${sectionId}`, `Section「${name}」`])
  })
  return replaceEntityTokens(issue.message, replacements)
}

export const getHighestSeverityByScheduleItem = (
  issues: ScheduleIssue[],
): Map<ScheduleItemId, IssueSeverity> => {
  const severityByScheduleItem = new Map<ScheduleItemId, IssueSeverity>()

  issues.forEach((issue) => {
    issue.scheduleItemIds?.forEach((scheduleItemId) => {
      const currentSeverity = severityByScheduleItem.get(scheduleItemId)
      if (
        !currentSeverity ||
        severityPriority[issue.severity] > severityPriority[currentSeverity]
      ) {
        severityByScheduleItem.set(scheduleItemId, issue.severity)
      }
    })
  })

  return severityByScheduleItem
}

export const getIssuesForStage = (
  issues: ScheduleIssue[],
  stageId: StageId,
  scheduleItems: Pick<ScheduleItem, 'id' | 'stageId'>[],
): ScheduleIssue[] => {
  const scheduleItemStageById = new Map(
    scheduleItems.map((scheduleItem) => [scheduleItem.id, scheduleItem.stageId]),
  )

  return issues.filter((issue) =>
    issue.stageIds?.includes(stageId) === true ||
    issue.scheduleItemIds?.some(
      (scheduleItemId) => scheduleItemStageById.get(scheduleItemId) === stageId,
    ) === true,
  )
}
