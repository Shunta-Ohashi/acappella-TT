import type {
  EventBand,
  EventBandId,
  EventDay,
  EventDayId,
  EventId,
  PerformanceScheduleItem,
  ScheduleItem,
  Section,
  Stage,
  TimetableOrderConstraint,
} from './models'
import { compareScheduleItemOrder } from './schedule.ts'
import {
  evaluateTimetableOrderConstraints,
  getTargetTimetableOrderConstraints,
  mergeTimetableOrderConstraintBlocks,
  type MergedTimetableOrderConstraintBlock,
} from './timetableOrderConstraints.ts'

export type TimetableOrderConstraintManualIssueCode =
  | 'DUPLICATE_EVENT_BAND'
  | 'LANE_MISMATCH'
  | 'ORDER_MISMATCH'
  | 'BLOCK_INTRUSION'

export interface TimetableOrderConstraintManualIssue {
  code: TimetableOrderConstraintManualIssueCode
  key: string
  blockKey: string
  eventBandIds: EventBandId[]
  scheduleItemIds: string[]
  message: string
}

export interface TimetableOrderConstraintManualTransitionEvaluation {
  allowed: boolean
  introducedIssues: TimetableOrderConstraintManualIssue[]
  currentIssues: TimetableOrderConstraintManualIssue[]
  candidateIssues: TimetableOrderConstraintManualIssue[]
}

export interface EvaluateTimetableOrderConstraintManualTransitionInput {
  eventId: EventId
  eventDayId: EventDayId
  timetableOrderConstraints: TimetableOrderConstraint[]
  currentScheduleItems: ScheduleItem[]
  candidateScheduleItems: ScheduleItem[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
}

const getBlockKey = (block: MergedTimetableOrderConstraintBlock): string =>
  JSON.stringify([
    block.eventDayId,
    block.stageId,
    block.sectionId ?? null,
    block.eventBandIds,
  ])

const issueMessages: Record<TimetableOrderConstraintManualIssueCode, string> = {
  DUPLICATE_EVENT_BAND: '出演順制約の対象バンドを重複して配置できません。',
  LANE_MISMATCH: '出演順制約で指定されたStage / Section以外へ移動できません。',
  ORDER_MISMATCH: '出演順制約で指定された出演順を崩す移動はできません。',
  BLOCK_INTRUSION: '出演順制約で連続するバンドの間に別の出演バンドを配置できません。',
}

const createIssue = ({
  code,
  block,
  eventBandIds,
  scheduleItemIds,
  identity,
}: {
  code: TimetableOrderConstraintManualIssueCode
  block: MergedTimetableOrderConstraintBlock
  eventBandIds: EventBandId[]
  scheduleItemIds: string[]
  identity: unknown[]
}): TimetableOrderConstraintManualIssue => {
  const blockKey = getBlockKey(block)
  return {
    code,
    key: JSON.stringify([code, blockKey, ...identity]),
    blockKey,
    eventBandIds,
    scheduleItemIds,
    message: issueMessages[code],
  }
}

const sortIssues = (
  issues: TimetableOrderConstraintManualIssue[],
): TimetableOrderConstraintManualIssue[] => issues.sort((left, right) =>
  left.key.localeCompare(right.key))

const getManualIssues = (
  blocks: MergedTimetableOrderConstraintBlock[],
  scheduleItems: ScheduleItem[],
): TimetableOrderConstraintManualIssue[] => {
  const performances = scheduleItems.filter(
    (item): item is PerformanceScheduleItem => item.kind === 'performance',
  )
  const performancesByBand = new Map<EventBandId, PerformanceScheduleItem[]>()
  for (const item of performances) {
    performancesByBand.set(item.eventBandId, [
      ...(performancesByBand.get(item.eventBandId) ?? []),
      item,
    ])
  }

  const issues: TimetableOrderConstraintManualIssue[] = []
  for (const block of blocks) {
    const blockBands = new Set(block.eventBandIds)

    for (const eventBandId of block.eventBandIds) {
      const placements = performancesByBand.get(eventBandId) ?? []
      if (placements.length > 1) {
        issues.push(createIssue({
          code: 'DUPLICATE_EVENT_BAND',
          block,
          eventBandIds: [eventBandId],
          scheduleItemIds: placements.map(item => item.id).sort(),
          identity: [eventBandId],
        }))
      }
      for (const placement of placements) {
        if (placement.stageId === block.stageId &&
          placement.sectionId === block.sectionId) continue
        issues.push(createIssue({
          code: 'LANE_MISMATCH',
          block,
          eventBandIds: [eventBandId],
          scheduleItemIds: [placement.id],
          identity: [
            eventBandId,
            placement.id,
            placement.stageId,
            placement.sectionId ?? null,
          ],
        }))
      }
    }

    const lanePerformances = performances
      .filter(item => item.stageId === block.stageId &&
        item.sectionId === block.sectionId)
      .sort(compareScheduleItemOrder)
    const laneIndexByBand = new Map<EventBandId, number>()
    lanePerformances.forEach((item, index) => {
      if (blockBands.has(item.eventBandId)) laneIndexByBand.set(item.eventBandId, index)
    })
    const placedBandIds = block.eventBandIds.filter(eventBandId => {
      const placements = performancesByBand.get(eventBandId) ?? []
      return placements.length === 1 &&
        placements[0].stageId === block.stageId &&
        placements[0].sectionId === block.sectionId
    })

    for (let leftIndex = 0; leftIndex < placedBandIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < placedBandIds.length; rightIndex += 1) {
        const before = placedBandIds[leftIndex]
        const after = placedBandIds[rightIndex]
        if ((laneIndexByBand.get(before) ?? -1) < (laneIndexByBand.get(after) ?? -1)) continue
        issues.push(createIssue({
          code: 'ORDER_MISMATCH',
          block,
          eventBandIds: [before, after],
          scheduleItemIds: [],
          identity: [before, after],
        }))
      }
    }

    if (placedBandIds.length < 2) continue
    const placedIndexes = placedBandIds.map(eventBandId => laneIndexByBand.get(eventBandId) ?? -1)
    const firstIndex = Math.min(...placedIndexes)
    const lastIndex = Math.max(...placedIndexes)
    for (const intruder of lanePerformances.slice(firstIndex + 1, lastIndex)) {
      if (blockBands.has(intruder.eventBandId)) continue
      issues.push(createIssue({
        code: 'BLOCK_INTRUSION',
        block,
        eventBandIds: [intruder.eventBandId],
        scheduleItemIds: [intruder.id],
        identity: [intruder.id, intruder.eventBandId],
      }))
    }
  }
  return sortIssues(issues)
}

const getEnforcedBlocks = ({
  eventId,
  eventDayId,
  timetableOrderConstraints,
  eventDays,
  stages,
  sections,
  eventBands,
}: Omit<EvaluateTimetableOrderConstraintManualTransitionInput,
  'currentScheduleItems' | 'candidateScheduleItems'>): MergedTimetableOrderConstraintBlock[] => {
  const currentEventConstraints = timetableOrderConstraints.filter(
    constraint => constraint.eventId === eventId,
  )
  const semanticEvaluation = evaluateTimetableOrderConstraints({
    eventId,
    timetableOrderConstraints: currentEventConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
  })
  const invalidConstraintIds = new Set(
    semanticEvaluation.violations.flatMap(violation => violation.constraintIds),
  )
  const targetStageIds = new Set(stages
    .filter(stage => stage.eventDayId === eventDayId)
    .map(stage => stage.id))
  const targetBandIds = new Set(eventBands
    .filter(band => band.eventId === eventId && band.eventDayId === eventDayId)
    .map(band => band.id))
  const targetConstraints = getTargetTimetableOrderConstraints({
    timetableOrderConstraints: currentEventConstraints,
    eventDayId,
    stageIds: targetStageIds,
    eventBandIds: targetBandIds,
  }).filter(constraint => !invalidConstraintIds.has(constraint.id))

  return mergeTimetableOrderConstraintBlocks(targetConstraints).blocks
}

/**
 * Validate a manual schedule transition with partial-placement semantics.
 * Missing constraint members are allowed; only newly introduced issue keys reject.
 */
export const evaluateTimetableOrderConstraintManualTransition = (
  input: EvaluateTimetableOrderConstraintManualTransitionInput,
): TimetableOrderConstraintManualTransitionEvaluation => {
  const blocks = getEnforcedBlocks(input)
  const currentIssues = getManualIssues(blocks, input.currentScheduleItems)
  const candidateIssues = getManualIssues(blocks, input.candidateScheduleItems)
  const currentIssueKeys = new Set(currentIssues.map(issue => issue.key))
  const introducedIssues = candidateIssues.filter(issue => !currentIssueKeys.has(issue.key))
  return {
    allowed: introducedIssues.length === 0,
    introducedIssues,
    currentIssues,
    candidateIssues,
  }
}
