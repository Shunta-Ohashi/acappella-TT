import type { SectionId, StageId } from '../domain/models'
import type { ScheduleLane } from '../domain/schedule'

export const TIMETABLE_POOL_DROPPABLE_ID = 'timetable:pool'

const STAGE_PREFIX = 'timetable:stage:'
const SECTION_PREFIX = 'timetable:section:'
const INTER_SECTION_PREFIX = 'timetable:inter-section:'

export const getStageDroppableId = (stageId: StageId): string =>
  `${STAGE_PREFIX}${encodeURIComponent(stageId)}`

export const getSectionDroppableId = (sectionId: SectionId): string =>
  `${SECTION_PREFIX}${encodeURIComponent(sectionId)}`

export const getInterSectionDroppableId = (afterSectionId: SectionId): string =>
  `${INTER_SECTION_PREFIX}${encodeURIComponent(afterSectionId)}`

export type TimetableDropTarget =
  | { kind: 'pool' }
  | { kind: 'stage'; stageId: StageId }
  | { kind: 'section'; sectionId: SectionId }
  | { kind: 'inter-section'; afterSectionId: SectionId }

const decodeId = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export const parseTimetableDroppableId = (
  droppableId: string,
): TimetableDropTarget | undefined => {
  if (droppableId === TIMETABLE_POOL_DROPPABLE_ID) return { kind: 'pool' }

  if (droppableId.startsWith(STAGE_PREFIX)) {
    const stageId = decodeId(droppableId.slice(STAGE_PREFIX.length))
    return stageId ? { kind: 'stage', stageId } : undefined
  }

  if (droppableId.startsWith(SECTION_PREFIX)) {
    const sectionId = decodeId(droppableId.slice(SECTION_PREFIX.length))
    return sectionId ? { kind: 'section', sectionId } : undefined
  }

  if (droppableId.startsWith(INTER_SECTION_PREFIX)) {
    const afterSectionId = decodeId(
      droppableId.slice(INTER_SECTION_PREFIX.length),
    )
    return afterSectionId
      ? { kind: 'inter-section', afterSectionId }
      : undefined
  }

  return undefined
}

export const resolveScheduleLane = (
  target: TimetableDropTarget,
  currentStageId: StageId,
  currentStageSectionIds: Set<SectionId>,
  validInterSectionAnchorIds: Set<SectionId> = new Set(),
): ScheduleLane | undefined => {
  if (
    target.kind === 'stage' &&
    target.stageId === currentStageId &&
    currentStageSectionIds.size === 0
  ) {
    return { stageId: currentStageId }
  }


  if (
    target.kind === 'inter-section' &&
    validInterSectionAnchorIds.has(target.afterSectionId)
  ) {
    return { stageId: currentStageId, afterSectionId: target.afterSectionId }
  }

  if (
    target.kind === 'section' &&
    currentStageSectionIds.has(target.sectionId)
  ) {
    return { stageId: currentStageId, sectionId: target.sectionId }
  }

  return undefined
}
