import type { SectionId, StageId } from '../domain/models'
import type { ScheduleLane } from '../domain/schedule'

export const TIMETABLE_POOL_DROPPABLE_ID = 'timetable:pool'

const STAGE_PREFIX = 'timetable:stage:'
const SECTION_PREFIX = 'timetable:section:'

export const getStageDroppableId = (stageId: StageId): string =>
  `${STAGE_PREFIX}${encodeURIComponent(stageId)}`

export const getSectionDroppableId = (sectionId: SectionId): string =>
  `${SECTION_PREFIX}${encodeURIComponent(sectionId)}`

export type TimetableDropTarget =
  | { kind: 'pool' }
  | { kind: 'stage'; stageId: StageId }
  | { kind: 'section'; sectionId: SectionId }

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

  return undefined
}

export const resolveScheduleLane = (
  target: TimetableDropTarget,
  currentStageId: StageId,
  currentStageSectionIds: Set<SectionId>,
): ScheduleLane | undefined => {
  if (
    target.kind === 'stage' &&
    target.stageId === currentStageId &&
    currentStageSectionIds.size === 0
  ) {
    return { stageId: currentStageId }
  }

  if (
    target.kind === 'section' &&
    currentStageSectionIds.has(target.sectionId)
  ) {
    return { stageId: currentStageId, sectionId: target.sectionId }
  }

  return undefined
}
