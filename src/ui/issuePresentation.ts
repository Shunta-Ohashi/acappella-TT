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
  let message = issue.message

  issue.memberIds?.forEach((memberId) => {
    const name = memberNameById.get(memberId) ?? '不明なメンバー'
    message = message.replaceAll(`メンバー ${memberId}`, `メンバー「${name}」`)
      .replaceAll(memberId, name)
  })
  issue.eventBandIds?.forEach((eventBandId) => {
    const name = eventBandNameById.get(eventBandId) ?? '不明なバンド'
    message = message.replaceAll(`EventBand ${eventBandId}`, `バンド「${name}」`)
      .replaceAll(eventBandId, name)
  })
  issue.stageIds?.forEach((stageId) => {
    const name = stageNameById.get(stageId) ?? '不明なStage'
    message = message.replaceAll(`Stage ${stageId}`, `Stage「${name}」`)
      .replaceAll(stageId, name)
  })
  issue.dutyTypeIds?.forEach((dutyTypeId) => {
    const name = dutyTypeNameById.get(dutyTypeId) ?? '不明な仕事'
    message = message.replaceAll(`DutyType ${dutyTypeId}`, `仕事「${name}」`)
      .replaceAll(dutyTypeId, name)
  })
  issue.sectionIds?.forEach((sectionId) => {
    const name = sectionNameById.get(sectionId) ?? '不明なSection'
    message = message.replaceAll(`Section ${sectionId}`, `Section「${name}」`)
      .replaceAll(sectionId, name)
  })
  return message
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
