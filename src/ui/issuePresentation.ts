import type { IssueSeverity, ScheduleIssue } from '../domain/issues'
import type {
  CalculatedScheduleItem,
} from '../domain/timeline'
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
  members: readonly Member[]
  eventBands: readonly EventBand[]
  dutyTypes?: readonly DutyType[]
  stages: readonly Stage[]
  sections: readonly Section[]
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

export interface ScheduleIssueDetailPresentation {
  message: string
  targets: string[]
  metrics: string[]
}

const uniqueNames = (names: string[]): string[] => [...new Set(names)]

export const createScheduleIssueDetailPresentation = (
  issue: ScheduleIssue,
  context: ScheduleIssueMessageContext,
  calculatedItems: ReadonlyArray<CalculatedScheduleItem> = [],
): ScheduleIssueDetailPresentation => {
  const memberNameById = new Map(
    context.members.map(member => [member.id, member.realName]),
  )
  const eventBandNameById = new Map(
    context.eventBands.map(eventBand => [eventBand.id, eventBand.name]),
  )
  const dutyTypeNameById = new Map(
    (context.dutyTypes ?? []).map(dutyType => [dutyType.id, dutyType.name]),
  )
  const stageNameById = new Map(
    context.stages.map(stage => [stage.id, stage.name]),
  )
  const sectionById = new Map(
    context.sections.map(section => [section.id, section]),
  )
  const calculatedItemById = new Map(
    calculatedItems.map(item => [item.scheduleItemId, item]),
  )
  const memberNames = uniqueNames(
    (issue.memberIds ?? []).map(
      memberId => memberNameById.get(memberId) ?? '不明なメンバー',
    ),
  )
  const bandNames = uniqueNames(
    (issue.eventBandIds ?? []).map(
      eventBandId => eventBandNameById.get(eventBandId) ?? '不明なバンド',
    ),
  )
  const stageNames = uniqueNames([
    ...(issue.stageIds ?? []).map(
      stageId => stageNameById.get(stageId) ?? '不明なStage',
    ),
    ...(issue.scheduleItemIds ?? []).map((scheduleItemId) => {
      const stageId = calculatedItemById.get(scheduleItemId)?.stageId
      return stageId
        ? stageNameById.get(stageId) ?? '不明なStage'
        : '不明なStage'
    }),
  ])
  const sectionRelationsById = new Map<
    string,
    Set<'within' | 'after'>
  >()
  const addSectionReference = (
    sectionId: string,
    relation: 'within' | 'after',
  ) => {
    const relations = sectionRelationsById.get(sectionId) ?? new Set()
    relations.add(relation)
    sectionRelationsById.set(sectionId, relations)
  }
  for (const sectionId of issue.sectionIds ?? []) {
    addSectionReference(sectionId, 'within')
  }
  for (const scheduleItemId of issue.scheduleItemIds ?? []) {
    const calculatedItem = calculatedItemById.get(scheduleItemId)
    if (calculatedItem?.sectionId) {
      addSectionReference(calculatedItem.sectionId, 'within')
    }
    if (calculatedItem?.afterSectionId) {
      addSectionReference(calculatedItem.afterSectionId, 'after')
    }
  }
  const sectionNameCounts = new Map<string, number>()
  context.sections.forEach((section) => {
    sectionNameCounts.set(
      section.name,
      (sectionNameCounts.get(section.name) ?? 0) + 1,
    )
  })
  const sectionNames = [...sectionRelationsById].map(([sectionId, relations]) => {
    const section = sectionById.get(sectionId)
    if (!section) return `不明なSection（Section ID: ${sectionId}）`
    const hasDuplicateName = (sectionNameCounts.get(section.name) ?? 0) > 1
    const stageName = stageNameById.get(section.stageId) ?? '不明なStage'
    const label = hasDuplicateName
      ? `${stageName} / ${section.name}（Section ID: ${section.id}）`
      : section.name
    if (relations.has('within') && relations.has('after')) {
      return `${label}（Section内・直後）`
    }
    return relations.has('after') ? `${label}の後` : label
  })
  const dutyTypeNames = uniqueNames(
    (issue.dutyTypeIds ?? []).map(
      dutyTypeId => dutyTypeNameById.get(dutyTypeId) ?? '不明な仕事',
    ),
  )
  const targets = [
    memberNames.length > 0 ? `メンバー: ${memberNames.join('、')}` : undefined,
    bandNames.length > 0 ? `バンド: ${bandNames.join('、')}` : undefined,
    stageNames.length > 0 ? `Stage: ${stageNames.join('、')}` : undefined,
    sectionNames.length > 0 ? `Section: ${sectionNames.join('、')}` : undefined,
    dutyTypeNames.length > 0 ? `仕事: ${dutyTypeNames.join('、')}` : undefined,
  ].filter((target): target is string => target !== undefined)
  const metrics = [
    issue.gapBands !== undefined
      ? `バンド間隔: ${issue.gapBands}`
      : undefined,
    issue.restMinutes !== undefined
      ? `休憩時間: ${issue.restMinutes}分`
      : undefined,
    issue.overrunMinutes !== undefined
      ? `超過時間: ${issue.overrunMinutes}分`
      : undefined,
  ].filter((metric): metric is string => metric !== undefined)

  return {
    message: formatScheduleIssueMessage(issue, context),
    targets,
    metrics,
  }
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
