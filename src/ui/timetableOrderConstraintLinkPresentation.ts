import type {
  EventBand,
  EventBandId,
  EventDay,
  Section,
  Stage,
  TimetableOrderConstraint,
  TimetableOrderConstraintId,
} from '../domain/models'
import { mergeTimetableOrderConstraintBlocks } from '../domain/timetableOrderConstraints.ts'
import { evaluateTimetableOrderConstraintOccurrences } from './timetableOrderConstraintPresentation.ts'

export interface TimetableOrderConstraintBlockPresentation {
  key: string
  label: string
  eventDayId: string
  stageId: string
  sectionId?: string
  laneLabel: string
  eventBandIds: EventBandId[]
  constraintIds: TimetableOrderConstraintId[]
  title: string
}

export interface TimetableOrderConstraintBlockMemberPresentation {
  blockKey: string
  label: string
  eventBandId: EventBandId
  position: number
  total: number
  badgeLabel: string
  title: string
}

const containsContiguousSequence = (
  values: readonly string[],
  sequence: readonly string[],
): boolean => {
  if (sequence.length > values.length) return false
  for (let start = 0; start <= values.length - sequence.length; start += 1) {
    if (sequence.every((value, index) => values[start + index] === value)) return true
  }
  return false
}

const hasSameLane = (
  block: TimetableOrderConstraintBlockPresentation,
  constraint: TimetableOrderConstraint,
): boolean =>
  block.eventDayId === constraint.eventDayId &&
  block.stageId === constraint.stageId &&
  block.sectionId === constraint.sectionId

export const getTimetableOrderConstraintBlockKey = ({
  eventDayId,
  stageId,
  sectionId,
  eventBandIds,
}: Pick<TimetableOrderConstraintBlockPresentation,
  'eventDayId' | 'stageId' | 'sectionId' | 'eventBandIds'>): string =>
  JSON.stringify([eventDayId, stageId, sectionId ?? null, eventBandIds])

export const getTimetableOrderConstraintBlockForConstraint = (
  blocks: readonly TimetableOrderConstraintBlockPresentation[],
  constraint: TimetableOrderConstraint,
): TimetableOrderConstraintBlockPresentation | undefined => blocks.find(block =>
  hasSameLane(block, constraint) &&
  containsContiguousSequence(block.eventBandIds, constraint.eventBandIds),
)

export const getTimetableOrderConstraintBlockMember = (
  blocks: readonly TimetableOrderConstraintBlockPresentation[],
  eventBandId: EventBandId,
): TimetableOrderConstraintBlockMemberPresentation | undefined => {
  const block = blocks.find(candidate => candidate.eventBandIds.includes(eventBandId))
  if (!block) return undefined
  const position = block.eventBandIds.indexOf(eventBandId) + 1
  const total = block.eventBandIds.length
  return {
    blockKey: block.key,
    label: block.label,
    eventBandId,
    position,
    total,
    badgeLabel: `${block.label} ${position}/${total}`,
    title: block.title,
  }
}

export const createTimetableOrderConstraintBlockPresentations = ({
  eventId,
  eventDayId,
  stageId,
  timetableOrderConstraints,
  eventDays,
  stages,
  sections,
  eventBands,
}: {
  eventId: string
  eventDayId: string
  stageId: string
  timetableOrderConstraints: TimetableOrderConstraint[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
}): TimetableOrderConstraintBlockPresentation[] => {
  const eventConstraints = timetableOrderConstraints.filter(
    constraint => constraint.eventId === eventId,
  )
  const validScopedConstraints = evaluateTimetableOrderConstraintOccurrences({
    eventId,
    timetableOrderConstraints: eventConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
  })
    .filter(({ constraint, semanticViolations }) =>
      semanticViolations.length === 0 &&
      constraint.eventDayId === eventDayId &&
      constraint.stageId === stageId)
    .map(({ constraint }) => constraint)

  const merged = mergeTimetableOrderConstraintBlocks(validScopedConstraints)
  if (!merged.valid) return []

  const stageSections = sections
    .filter(section => section.stageId === stageId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const sectionOrderById = new Map(
    stageSections.map((section, index) => [section.id, index]),
  )
  const sectionById = new Map(stageSections.map(section => [section.id, section]))
  const bandById = new Map(eventBands.map(band => [band.id, band]))
  const sortedBlocks = [...merged.blocks].sort((left, right) =>
    (sectionOrderById.get(left.sectionId ?? '') ?? Number.MAX_SAFE_INTEGER) -
      (sectionOrderById.get(right.sectionId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
    (left.sectionId ?? '').localeCompare(right.sectionId ?? '') ||
    (left.eventBandIds[0] ?? '').localeCompare(right.eventBandIds[0] ?? '') ||
    left.eventBandIds.join('\u0000').localeCompare(right.eventBandIds.join('\u0000')))

  return sortedBlocks.map((block, index) => {
    const label = `出演順${index + 1}`
    const laneLabel = block.sectionId
      ? sectionById.get(block.sectionId)?.name ?? `不明なSection（${block.sectionId}）`
      : 'Stage全体'
    const bandOrder = block.eventBandIds.map(eventBandId =>
      bandById.get(eventBandId)?.name ?? `参照先不明（${eventBandId}）`,
    ).join(' → ')
    const matchingConstraints = validScopedConstraints.filter(constraint =>
      constraint.eventDayId === block.eventDayId &&
      constraint.stageId === block.stageId &&
      constraint.sectionId === block.sectionId &&
      containsContiguousSequence(block.eventBandIds, constraint.eventBandIds))
    return {
      key: getTimetableOrderConstraintBlockKey(block),
      label,
      eventDayId: block.eventDayId,
      stageId: block.stageId,
      ...(block.sectionId !== undefined ? { sectionId: block.sectionId } : {}),
      laneLabel,
      eventBandIds: [...block.eventBandIds],
      constraintIds: matchingConstraints
        .map(constraint => constraint.id)
        .sort((left, right) => left.localeCompare(right)),
      title: `${label} / ${laneLabel}: ${bandOrder}`,
    }
  })
}
