import type {
  EventBand,
  EventBandId,
  EventDay,
  FixedPlacement,
  Section,
  Stage,
  TimetableOrderConstraint,
  TimetableOrderConstraintId,
} from './models'

export type TimetableOrderConstraintViolationCode =
  | 'INVALID_CONSTRAINT'
  | 'DUPLICATE_CONSTRAINT_ID'
  | 'EVENT_MISMATCH'
  | 'EVENT_DAY_NOT_FOUND'
  | 'EVENT_DAY_EVENT_MISMATCH'
  | 'STAGE_NOT_FOUND'
  | 'STAGE_DAY_MISMATCH'
  | 'SECTION_REQUIRED'
  | 'SECTION_NOT_ALLOWED'
  | 'SECTION_NOT_FOUND'
  | 'SECTION_STAGE_MISMATCH'
  | 'EVENT_BAND_NOT_FOUND'
  | 'EVENT_BAND_EVENT_MISMATCH'
  | 'EVENT_BAND_DAY_MISMATCH'
  | 'DUPLICATE_EVENT_BAND'
  | 'EVENT_BAND_LANE_CONFLICT'
  | 'FIXED_PLACEMENT_CONFLICT'
  | 'ORDER_CYCLE'

export interface TimetableOrderConstraintViolation {
  code: TimetableOrderConstraintViolationCode
  constraintIds: TimetableOrderConstraintId[]
  eventBandIds: EventBandId[]
  message: string
}

export interface TimetableOrderConstraintEvaluation {
  valid: boolean
  violations: TimetableOrderConstraintViolation[]
}

export interface EvaluateTimetableOrderConstraintsInput {
  eventId: string
  timetableOrderConstraints: TimetableOrderConstraint[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const hasTimetableOrderConstraintShape = (
  value: unknown,
): value is TimetableOrderConstraint =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.eventId) &&
  isNonEmptyString(value.eventDayId) &&
  isNonEmptyString(value.stageId) &&
  (value.sectionId === undefined || isNonEmptyString(value.sectionId)) &&
  Array.isArray(value.eventBandIds) &&
  Array.from(value.eventBandIds).every(isNonEmptyString)

/** Runtime guard for a self-contained constraint; ownership is evaluated separately. */
export const isTimetableOrderConstraint = (
  value: unknown,
): value is TimetableOrderConstraint =>
  hasTimetableOrderConstraintShape(value) &&
  value.eventBandIds.length >= 2 &&
  new Set(value.eventBandIds).size === value.eventBandIds.length

export const doesFixedPlacementConflictWithOrderConstraint = (
  fixedPlacement: Pick<FixedPlacement, 'stageId' | 'sectionId'> | undefined,
  constraint: Pick<TimetableOrderConstraint, 'stageId' | 'sectionId'>,
): boolean => Boolean(
  fixedPlacement && (
    fixedPlacement.stageId !== constraint.stageId ||
    (fixedPlacement.sectionId !== undefined &&
      fixedPlacement.sectionId !== constraint.sectionId)
  ),
)

const uniqueSorted = <T extends string>(values: T[]): T[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right))

const sortViolations = (
  violations: TimetableOrderConstraintViolation[],
): TimetableOrderConstraintViolation[] => violations.sort((left, right) =>
  left.code.localeCompare(right.code) ||
  left.constraintIds.join('\u0000').localeCompare(right.constraintIds.join('\u0000')) ||
  left.eventBandIds.join('\u0000').localeCompare(right.eventBandIds.join('\u0000')) ||
  left.message.localeCompare(right.message))

const laneKey = (constraint: TimetableOrderConstraint): string =>
  `${constraint.eventDayId}\u0000${constraint.stageId}\u0000${constraint.sectionId ?? ''}`

interface ValidConstraint {
  constraint: TimetableOrderConstraint
}

interface GraphEdge {
  to: EventBandId
  constraintId: TimetableOrderConstraintId
}

const getCycleViolations = (
  constraints: ValidConstraint[],
): TimetableOrderConstraintViolation[] => {
  const nodes = uniqueSorted(constraints.flatMap(({ constraint }) =>
    constraint.eventBandIds))
  const edgesByFrom = new Map<EventBandId, GraphEdge[]>()
  for (const { constraint } of constraints) {
    for (let index = 0; index < constraint.eventBandIds.length - 1; index += 1) {
      const from = constraint.eventBandIds[index]
      const edge = {
        to: constraint.eventBandIds[index + 1],
        constraintId: constraint.id,
      }
      edgesByFrom.set(from, [...(edgesByFrom.get(from) ?? []), edge])
    }
  }
  for (const edges of edgesByFrom.values()) {
    edges.sort((left, right) =>
      left.to.localeCompare(right.to) ||
      left.constraintId.localeCompare(right.constraintId))
  }

  let nextIndex = 0
  const indexByNode = new Map<EventBandId, number>()
  const lowLinkByNode = new Map<EventBandId, number>()
  const stack: EventBandId[] = []
  const onStack = new Set<EventBandId>()
  const components: EventBandId[][] = []

  const visit = (node: EventBandId) => {
    indexByNode.set(node, nextIndex)
    lowLinkByNode.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const edge of edgesByFrom.get(node) ?? []) {
      if (!indexByNode.has(edge.to)) {
        visit(edge.to)
        lowLinkByNode.set(node, Math.min(
          lowLinkByNode.get(node)!,
          lowLinkByNode.get(edge.to)!,
        ))
      } else if (onStack.has(edge.to)) {
        lowLinkByNode.set(node, Math.min(
          lowLinkByNode.get(node)!,
          indexByNode.get(edge.to)!,
        ))
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return
    const component: EventBandId[] = []
    let current: EventBandId
    do {
      current = stack.pop()!
      onStack.delete(current)
      component.push(current)
    } while (current !== node)
    if (component.length > 1) components.push(component.sort())
  }

  for (const node of nodes) if (!indexByNode.has(node)) visit(node)

  return components
    .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')))
    .map((eventBandIds) => {
      const members = new Set(eventBandIds)
      const constraintIds = uniqueSorted(eventBandIds.flatMap((from) =>
        (edgesByFrom.get(from) ?? [])
          .filter((edge) => members.has(edge.to))
          .map((edge) => edge.constraintId)))
      return {
        code: 'ORDER_CYCLE' as const,
        constraintIds,
        eventBandIds,
        message: '出演順制約が循環しています。',
      }
    })
}

export const evaluateTimetableOrderConstraints = ({
  eventId,
  timetableOrderConstraints,
  eventDays,
  stages,
  sections,
  eventBands,
}: EvaluateTimetableOrderConstraintsInput): TimetableOrderConstraintEvaluation => {
  const violations: TimetableOrderConstraintViolation[] = []
  if (!Array.isArray(timetableOrderConstraints)) {
    return {
      valid: false,
      violations: [{
        code: 'INVALID_CONSTRAINT',
        constraintIds: [],
        eventBandIds: [],
        message: '出演順制約の形式が不正です。',
      }],
    }
  }

  const dayById = new Map(eventDays.map((day) => [day.id, day]))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const bandById = new Map(eventBands.map((band) => [band.id, band]))
  const sectionCountByStage = new Map<string, number>()
  for (const section of sections) {
    sectionCountByStage.set(
      section.stageId,
      (sectionCountByStage.get(section.stageId) ?? 0) + 1,
    )
  }

  const constraintIdCounts = new Map<string, number>()
  for (const candidate of timetableOrderConstraints as unknown[]) {
    if (isRecord(candidate) && isNonEmptyString(candidate.id)) {
      constraintIdCounts.set(candidate.id, (constraintIdCounts.get(candidate.id) ?? 0) + 1)
    }
  }
  for (const [constraintId, count] of [...constraintIdCounts].sort()) {
    if (count > 1) violations.push({
      code: 'DUPLICATE_CONSTRAINT_ID',
      constraintIds: [constraintId],
      eventBandIds: [],
      message: '同じ出演順制約IDが重複しています。',
    })
  }

  const validConstraints: ValidConstraint[] = []
  const orderedCandidates = [...(timetableOrderConstraints as unknown[])]
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftId = isRecord(left.candidate) && typeof left.candidate.id === 'string'
        ? left.candidate.id : ''
      const rightId = isRecord(right.candidate) && typeof right.candidate.id === 'string'
        ? right.candidate.id : ''
      return leftId.localeCompare(rightId) || left.index - right.index
    })

  for (const { candidate } of orderedCandidates) {
    if (!hasTimetableOrderConstraintShape(candidate)) {
      violations.push({
        code: 'INVALID_CONSTRAINT',
        constraintIds: isRecord(candidate) && isNonEmptyString(candidate.id)
          ? [candidate.id] : [],
        eventBandIds: [],
        message: '出演順制約の形式が不正です。',
      })
      continue
    }
    const constraint = candidate
    const constraintIds = [constraint.id]
    let valid = true
    const add = (
      code: TimetableOrderConstraintViolationCode,
      message: string,
      relatedBandIds: EventBandId[] = [],
    ) => {
      valid = false
      violations.push({
        code,
        constraintIds,
        eventBandIds: uniqueSorted(relatedBandIds),
        message,
      })
    }

    if ((constraintIdCounts.get(constraint.id) ?? 0) > 1) valid = false
    if (constraint.eventBandIds.length < 2) {
      add('INVALID_CONSTRAINT', '出演順制約には2組以上の出演バンドが必要です。')
    }
    if (new Set(constraint.eventBandIds).size !== constraint.eventBandIds.length) {
      add('DUPLICATE_EVENT_BAND', '同じ出演バンドを1つの出演順制約へ重複して指定できません。',
        constraint.eventBandIds)
    }
    if (constraint.eventId !== eventId) {
      add('EVENT_MISMATCH', '評価対象と異なるイベントの出演順制約です。')
    }
    const day = dayById.get(constraint.eventDayId)
    if (!day) add('EVENT_DAY_NOT_FOUND', '出演順制約の開催日が見つかりません。')
    else if (day.eventId !== constraint.eventId) {
      add('EVENT_DAY_EVENT_MISMATCH', '出演順制約の開催日がイベントに属していません。')
    }
    const stage = stageById.get(constraint.stageId)
    if (!stage) add('STAGE_NOT_FOUND', '出演順制約のStageが見つかりません。')
    else if (stage.eventDayId !== constraint.eventDayId) {
      add('STAGE_DAY_MISMATCH', '出演順制約のStageが開催日に属していません。')
    }

    const stageHasSections = (sectionCountByStage.get(constraint.stageId) ?? 0) > 0
    if (stageHasSections && constraint.sectionId === undefined) {
      add('SECTION_REQUIRED', 'Sectionを持つStageでは出演順制約のSection指定が必要です。')
    } else if (!stageHasSections && constraint.sectionId !== undefined) {
      add('SECTION_NOT_ALLOWED', 'SectionのないStageにはSectionを指定できません。')
    }
    if (constraint.sectionId !== undefined) {
      const section = sectionById.get(constraint.sectionId)
      if (!section) add('SECTION_NOT_FOUND', '出演順制約のSectionが見つかりません。')
      else if (section.stageId !== constraint.stageId) {
        add('SECTION_STAGE_MISMATCH', '出演順制約のSectionがStageに属していません。')
      }
    }

    for (const bandId of uniqueSorted(constraint.eventBandIds)) {
      const band = bandById.get(bandId)
      if (!band) {
        add('EVENT_BAND_NOT_FOUND', '出演順制約の出演バンドが見つかりません。', [bandId])
        continue
      }
      if (band.eventId !== constraint.eventId) {
        add('EVENT_BAND_EVENT_MISMATCH', '出演バンドが出演順制約のイベントに属していません。', [band.id])
      }
      if (band.eventDayId !== constraint.eventDayId) {
        add('EVENT_BAND_DAY_MISMATCH', '出演バンドが出演順制約の開催日に属していません。', [band.id])
      }
      if (doesFixedPlacementConflictWithOrderConstraint(
        band.fixedPlacement,
        constraint,
      )) {
        add('FIXED_PLACEMENT_CONFLICT', '出演バンドの固定配置と出演順制約のlaneが一致しません。', [band.id])
      }
    }
    if (valid) validConstraints.push({ constraint })
  }

  const laneByBand = new Map<EventBandId, { lane: string; constraintIds: string[] }>()
  const laneConflictConstraintIds = new Set<string>()
  for (const { constraint } of validConstraints) {
    const lane = laneKey(constraint)
    for (const bandId of constraint.eventBandIds) {
      const previous = laneByBand.get(bandId)
      if (!previous) {
        laneByBand.set(bandId, { lane, constraintIds: [constraint.id] })
      } else if (previous.lane === lane) {
        previous.constraintIds.push(constraint.id)
      } else {
        const constraintIds = uniqueSorted([...previous.constraintIds, constraint.id])
        constraintIds.forEach((id) => laneConflictConstraintIds.add(id))
        violations.push({
          code: 'EVENT_BAND_LANE_CONFLICT',
          constraintIds,
          eventBandIds: [bandId],
          message: '同じ出演バンドを異なるlaneの出演順制約へ指定できません。',
        })
      }
    }
  }

  violations.push(...getCycleViolations(validConstraints.filter(({ constraint }) =>
    !laneConflictConstraintIds.has(constraint.id))))
  const sorted = sortViolations(violations)
  return { valid: sorted.length === 0, violations: sorted }
}
