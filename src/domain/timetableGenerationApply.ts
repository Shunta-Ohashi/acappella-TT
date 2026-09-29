import type { DutyAssignment, DutyType, Event, EventBand, EventDay, PaAssignment, ScheduleBoundary,
  ScheduleItem, Section, Stage, TimetableLock } from './models'
import type { TimetableGenerationInput, TimetableGenerationPlan } from './timetableGeneration'
import { isValidScheduleItemSectionAssignment } from './schedule.ts'
import { calculateEventDayTimelines } from './timetable.ts'
import { evaluateTimetableLocks } from './timetableLocks.ts'
import { detectScheduleIssues, type ScheduleIssue } from './issues.ts'
import { getDutyAssignmentsForEvent } from './dutyAssignments.ts'
import { resolvePaAssignmentInterval } from './paAssignments.ts'
import { hasSafeStageTimelineArithmetic } from './timetableGenerationArithmetic.ts'
import { hasSameItemContents, hasValidTimetableGenerationDutyTypes, hasValidTimetableGenerationLocks,
  hasValidTimetableGenerationScheduleItems, validateTimetableGenerationBaseline,
  validateTimetableGenerationBreakRemoval } from './timetableGenerationOptions.ts'
import type { CalculatedScheduleItem } from './timeline'

export interface MaterializedTimetable {
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
}

export type MaterializationFailureCode =
  | 'PLAN_SCOPE_MISMATCH' | 'INVALID_PLAN_REFERENCE' | 'ID_COUNT_MISMATCH'
  | 'ID_COLLISION' | 'BOUNDARY_UNRESOLVED'

export type MaterializationResult =
  | ({ ok: true } & MaterializedTimetable)
  | { ok: false; code: MaterializationFailureCode }

interface MaterializationInput {
  event: Event
  eventDay: EventDay
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
  sourceScheduleItems: ScheduleItem[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
  plan: TimetableGenerationPlan
  newScheduleItemIds: string[]
  newPaAssignmentIds: string[]
}

type CandidateValidationInput = TimetableGenerationInput & {
  paAssignments: PaAssignment[]
  plan: TimetableGenerationPlan
}

const isNonEmptyId = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasUniqueIds = (items: unknown): items is { id: string }[] =>
  Array.isArray(items) &&
  items.every(item => isRecord(item) && isNonEmptyId(item.id)) &&
  new Set(items.map(item => item.id)).size === items.length

const hasUnambiguousGenerationScope = (
  event: Event, eventDay: EventDay, eventDays: EventDay[], stages: Stage[],
  sections: Section[], eventBands: EventBand[],
): boolean => isNonEmptyId(event?.id) && isNonEmptyId(eventDay?.id) &&
  isNonEmptyId(eventDay?.eventId) && eventDay.eventId === event.id &&
  hasUniqueIds(eventDays) && hasUniqueIds(stages) &&
  hasUniqueIds(sections) && hasUniqueIds(eventBands) &&
  eventDays.filter(day => day.id === eventDay.id && day.eventId === event.id).length === 1

const placementFields = new Set(['stageId', 'sectionId', 'afterSectionId', 'order'])

/** A candidate may replace placement only for target-band Performances and retained target Breaks. */
const preservesGenerationBaseline = (
  baseline: ScheduleItem[], candidate: ScheduleItem[], stageIds: Set<string>, bandIds: Set<string>,
): boolean => {
  const baselineById = new Map(baseline.map(item => [item.id, item]))
  const candidateById = new Map(candidate.map(item => [item.id, item]))
  for (const item of baseline) {
    const updated = candidateById.get(item.id)
    if (!updated) return false
    const mayReplacePlacement = item.kind === 'performance'
      ? bandIds.has(item.eventBandId) : stageIds.has(item.stageId)
    if (mayReplacePlacement && item.kind === 'break' && !stageIds.has(updated.stageId)) return false
    if (!hasSameItemContents(item, updated, mayReplacePlacement ? placementFields : undefined)) return false
  }
  return candidate.every(item => baselineById.has(item.id) ||
    (item.kind === 'performance' && bandIds.has(item.eventBandId)))
}

const isRetainedPaAssignment = (pa: PaAssignment, eventId: string, eventDayId: string): boolean =>
  pa.eventId !== eventId || pa.eventDayId !== eventDayId

const hasValidBoundaryReference = (value: unknown): value is Pick<ScheduleBoundary, 'scheduleItemId'> =>
  isRecord(value) && isNonEmptyId(value.scheduleItemId)

const resolvePlannedBoundary = (
  value: unknown, stageId: string, sourceItemById: ReadonlyMap<string, ScheduleItem>,
  candidateItemById: ReadonlyMap<string, ScheduleItem>, performanceIdByBand: ReadonlyMap<string, string>,
): ScheduleBoundary | undefined => {
  if (!isRecord(value) || (value.edge !== 'start' && value.edge !== 'end')) return undefined
  let id: string | undefined
  if (value.kind === 'existing-item' && isNonEmptyId(value.scheduleItemId) &&
    sourceItemById.has(value.scheduleItemId)) id = value.scheduleItemId
  if (value.kind === 'planned-performance' && isNonEmptyId(value.eventBandId)) {
    id = performanceIdByBand.get(value.eventBandId)
    const performance = id === undefined ? undefined : candidateItemById.get(id)
    if (performance?.kind !== 'performance' || performance.eventBandId !== value.eventBandId) return undefined
  }
  if (!id || candidateItemById.get(id)?.stageId !== stageId) return undefined
  return { scheduleItemId: id, edge: value.edge }
}

const paShiftKey = (
  eventId: string, eventDayId: string, stageId: string, memberId: string, role: string,
  from: ScheduleBoundary, until: ScheduleBoundary,
): string => JSON.stringify([eventId, eventDayId, stageId, memberId, role,
  from.scheduleItemId, from.edge, until.scheduleItemId, until.edge])

const hasValidReferenceInputs = (
  paAssignments: PaAssignment[], dutyAssignments: DutyAssignment[], timetableLocks: TimetableLock[],
): boolean =>
  Array.isArray(paAssignments) && paAssignments.every(pa =>
    isRecord(pa) && isNonEmptyId(pa.eventId) && isNonEmptyId(pa.eventDayId) &&
    hasValidBoundaryReference(pa.from) && hasValidBoundaryReference(pa.until)) &&
  Array.isArray(dutyAssignments) && dutyAssignments.every(duty =>
    isRecord(duty) && isNonEmptyId(duty.dutyTypeId) && isNonEmptyId(duty.eventDayId) &&
    isNonEmptyId(duty.stageId) && hasValidBoundaryReference(duty.from) &&
    hasValidBoundaryReference(duty.until)) &&
  hasValidTimetableGenerationLocks(timetableLocks)

const getReservedScheduleReferences = (
  paAssignments: PaAssignment[], dutyAssignments: DutyAssignment[], timetableLocks: TimetableLock[],
  eventId: string, eventDayId: string,
): Set<string> => new Set([
  ...paAssignments.filter(pa => isRetainedPaAssignment(pa, eventId, eventDayId))
    .flatMap(pa => [pa.from.scheduleItemId, pa.until.scheduleItemId]),
  ...dutyAssignments.flatMap(duty => [duty.from.scheduleItemId, duty.until.scheduleItemId]),
  ...timetableLocks.map(lock => lock.scheduleItemId),
])

const hasSameFlatFields = (left: unknown, right: unknown, excluded = new Set<string>()): boolean => {
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left).filter(key => !excluded.has(key))
  return keys.length === Object.keys(right).filter(key => !excluded.has(key)).length &&
    keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
}

const paBoundaryFields = new Set(['from', 'until'])

const hasSamePaAssignmentContents = (left: PaAssignment, right: PaAssignment): boolean =>
  hasSameFlatFields(left, right, paBoundaryFields) &&
  hasSameFlatFields(left.from, right.from) && hasSameFlatFields(left.until, right.until)

const preservesRetainedPaAssignments = (
  source: PaAssignment[], candidate: PaAssignment[], eventId: string, eventDayId: string,
): boolean => {
  const retainedById = new Map(source.filter(pa => isRetainedPaAssignment(pa, eventId, eventDayId))
    .map(pa => [pa.id, pa]))
  const candidateRetained = candidate.filter(pa => isRetainedPaAssignment(pa, eventId, eventDayId))
  return candidateRetained.length === retainedById.size && candidateRetained.every(pa => {
    const original = retainedById.get(pa.id)
    return original !== undefined && hasSamePaAssignmentContents(original, pa)
  })
}

const isTargetTimetableLock = (
  lock: TimetableLock, eventId: string, stageIds: Set<string>, sectionIds: Set<string>,
  bandIds: Set<string>, itemById: Map<string, ScheduleItem>,
): boolean => {
  const item = itemById.get(lock.scheduleItemId)
  return lock.eventId === eventId && (stageIds.has(lock.stageId) ||
    (lock.sectionId !== undefined && sectionIds.has(lock.sectionId)) ||
    (item !== undefined && (stageIds.has(item.stageId) ||
      (item.kind === 'performance' && bandIds.has(item.eventBandId)))))
}

const referencesItem = (
  assignment: Pick<PaAssignment, 'from' | 'until'>, itemIds: Set<string>,
): boolean => itemIds.has(assignment.from.scheduleItemId) || itemIds.has(assignment.until.scheduleItemId)

/** Convert a plan without allocating IDs or changing any committed collection. */
export const materializeTimetableGenerationPlan = ({
  event, eventDay, eventDays, stages, sections, eventBands, sourceScheduleItems,
  scheduleItems, paAssignments, dutyTypes, dutyAssignments, timetableLocks,
  plan, newScheduleItemIds, newPaAssignmentIds,
}: MaterializationInput): MaterializationResult => {
  const fail = (code: MaterializationFailureCode): MaterializationResult => ({ ok: false, code })
  if (!hasUnambiguousGenerationScope(event, eventDay, eventDays, stages, sections, eventBands) ||
    !isRecord(plan) || plan.eventDayId !== eventDay.id) {
    return fail('PLAN_SCOPE_MISMATCH')
  }
  if (!hasValidTimetableGenerationScheduleItems(sourceScheduleItems) ||
    !hasValidTimetableGenerationScheduleItems(scheduleItems) ||
    !hasUniqueIds(sourceScheduleItems) || !hasUniqueIds(scheduleItems) || !hasUniqueIds(paAssignments) ||
    !hasValidTimetableGenerationDutyTypes(dutyTypes) ||
    !hasValidReferenceInputs(paAssignments, dutyAssignments, timetableLocks) ||
    !validateTimetableGenerationBaseline({
    event, eventDay, eventDays, stages, sections, sourceScheduleItems,
    generationScheduleItems: scheduleItems,
  }) || !validateTimetableGenerationBreakRemoval({
    event, eventDay, originalScheduleItems: sourceScheduleItems,
    generationScheduleItems: scheduleItems, paAssignments, dutyAssignments, timetableLocks,
  }).ok) return fail('INVALID_PLAN_REFERENCE')
  if (!Array.isArray(plan.placements) || !plan.placements.every(isRecord) ||
    !Array.isArray(plan.breaks) || !plan.breaks.every(isRecord) ||
    !Array.isArray(plan.paShifts) || !plan.paShifts.every(isRecord)) return fail('INVALID_PLAN_REFERENCE')
  if (!Array.isArray(newScheduleItemIds) || !Array.isArray(newPaAssignmentIds)) return fail('ID_COUNT_MISMATCH')
  if (newScheduleItemIds.length !== plan.placements.filter(p => p.scheduleItemId === undefined).length ||
    newPaAssignmentIds.length !== plan.paShifts.length) return fail('ID_COUNT_MISMATCH')
  const newIds = [...newScheduleItemIds, ...newPaAssignmentIds]
  const existingIds = new Set([...sourceScheduleItems, ...scheduleItems, ...paAssignments].map(item => item.id))
  const retainedPaAssignments = paAssignments.filter(pa => isRetainedPaAssignment(pa, event.id, eventDay.id))
  const reservedScheduleReferences = getReservedScheduleReferences(
    paAssignments, dutyAssignments, timetableLocks, event.id, eventDay.id)
  if (new Set(newIds).size !== newIds.length ||
    newIds.some(id => !isNonEmptyId(id) || existingIds.has(id)) ||
    newScheduleItemIds.some(id => reservedScheduleReferences.has(id))) return fail('ID_COLLISION')

  const targetStages = stages.filter(stage => stage.eventDayId === eventDay.id)
  const stageById = new Map(targetStages.map(stage => [stage.id, stage]))
  const targetBands = eventBands.filter(band => band.eventId === event.id && band.eventDayId === eventDay.id)
  const bandById = new Map(targetBands.map(band => [band.id, band]))
  const itemById = new Map(scheduleItems.map(item => [item.id, item]))
  if (itemById.size !== scheduleItems.length) return fail('INVALID_PLAN_REFERENCE')
  const targetBreaks = scheduleItems.filter(item => item.kind === 'break' && stageById.has(item.stageId))
  const existingByBand = new Map<string, ScheduleItem>()
  for (const item of scheduleItems) {
    if (item.kind !== 'performance') continue
    if (bandById.has(item.eventBandId)) {
      if (existingByBand.has(item.eventBandId)) return fail('INVALID_PLAN_REFERENCE')
      existingByBand.set(item.eventBandId, item)
    } else if (stageById.has(item.stageId)) return fail('INVALID_PLAN_REFERENCE')
  }

  const generated: ScheduleItem[] = []
  const performanceIdByBand = new Map<string, string>()
  let newIndex = 0
  for (const placement of plan.placements) {
    if (!bandById.has(placement.eventBandId) || performanceIdByBand.has(placement.eventBandId)) {
      return fail('INVALID_PLAN_REFERENCE')
    }
    const existing = placement.scheduleItemId === undefined ? undefined : itemById.get(placement.scheduleItemId)
    if (placement.scheduleItemId !== undefined && (!existing || existing.kind !== 'performance' ||
      existing.eventBandId !== placement.eventBandId)) return fail('INVALID_PLAN_REFERENCE')
    // An omitted reuse reference must not silently replace a historical ID.
    if (existingByBand.get(placement.eventBandId)?.id !== existing?.id) return fail('INVALID_PLAN_REFERENCE')
    const item: ScheduleItem = {
      id: existing?.id ?? newScheduleItemIds[newIndex++], kind: 'performance',
      eventBandId: placement.eventBandId, stageId: placement.stageId, order: placement.order,
      ...(placement.sectionId !== undefined ? { sectionId: placement.sectionId } : {}),
    }
    generated.push(item)
    performanceIdByBand.set(placement.eventBandId, item.id)
  }
  if (performanceIdByBand.size !== targetBands.length) return fail('INVALID_PLAN_REFERENCE')

  const breakIds = new Set<string>()
  for (const placement of plan.breaks) {
    const existing = itemById.get(placement.scheduleItemId)
    if (!existing || existing.kind !== 'break' || !stageById.has(existing.stageId) ||
      breakIds.has(existing.id)) return fail('INVALID_PLAN_REFERENCE')
    const item = { ...existing, stageId: placement.stageId, order: placement.order }
    delete item.sectionId
    delete item.afterSectionId
    if (placement.sectionId !== undefined) item.sectionId = placement.sectionId
    if (placement.afterSectionId !== undefined) item.afterSectionId = placement.afterSectionId
    generated.push(item)
    breakIds.add(item.id)
  }
  if (breakIds.size !== targetBreaks.length) return fail('INVALID_PLAN_REFERENCE')
  for (const item of generated) {
    const stage = stageById.get(item.stageId)
    if (!stage || !Number.isSafeInteger(item.order) || item.order < 0 ||
      !isValidScheduleItemSectionAssignment(stage.id, sections.filter(s => s.stageId === stage.id), item)) {
      return fail('INVALID_PLAN_REFERENCE')
    }
  }

  const replacedScheduleItemIds = new Set([
    ...targetBreaks.map(item => item.id),
    ...[...existingByBand.values()].map(item => item.id),
  ])
  const targetStageIds = new Set(targetStages.map(stage => stage.id))
  const targetSectionIds = new Set(sections.filter(section => targetStageIds.has(section.stageId))
    .map(section => section.id))
  const targetBandIds = new Set(targetBands.map(band => band.id))
  const targetDuties = new Set(getDutyAssignmentsForEvent({
    event, stages: targetStages, dutyTypes, dutyAssignments,
  }).filter(duty => duty.eventDayId === eventDay.id))
  if (paAssignments.some(pa => (pa.eventId !== event.id || pa.eventDayId !== eventDay.id) &&
    referencesItem(pa, replacedScheduleItemIds)) ||
    dutyAssignments.some(duty => !targetDuties.has(duty) && referencesItem(duty, replacedScheduleItemIds)) ||
    timetableLocks.some(lock => replacedScheduleItemIds.has(lock.scheduleItemId) &&
      !isTargetTimetableLock(lock, event.id, targetStageIds, targetSectionIds, targetBandIds, itemById))) {
    return fail('INVALID_PLAN_REFERENCE')
  }
  const candidateItems = [
    ...scheduleItems.filter(item => !replacedScheduleItemIds.has(item.id)).map(item => ({ ...item })),
    ...generated,
  ]
  const candidateItemById = new Map(candidateItems.map(item => [item.id, item]))
  const assignments: PaAssignment[] = []
  for (const [index, shift] of plan.paShifts.entries()) {
    if (shift.eventDayId !== eventDay.id || !stageById.has(shift.stageId) ||
      (shift.sectionId !== undefined && !sections.some(s => s.id === shift.sectionId && s.stageId === shift.stageId)) ||
      !shift.memberId || (shift.role !== 'main' && shift.role !== 'sub')) return fail('INVALID_PLAN_REFERENCE')
    const from = resolvePlannedBoundary(shift.fromBoundary, shift.stageId,
      itemById, candidateItemById, performanceIdByBand)
    const until = resolvePlannedBoundary(shift.untilBoundary, shift.stageId,
      itemById, candidateItemById, performanceIdByBand)
    if (!from || !until) return fail('BOUNDARY_UNRESOLVED')
    assignments.push({
      id: newPaAssignmentIds[index], eventId: event.id, eventDayId: eventDay.id,
      stageId: shift.stageId, memberId: shift.memberId, role: shift.role, from, until,
    })
  }
  return {
    ok: true, scheduleItems: candidateItems,
    paAssignments: [...retainedPaAssignments.map(pa => ({ ...pa, from: { ...pa.from }, until: { ...pa.until } })),
      ...assignments],
  }
}

export type GenerationCandidateValidation =
  | { ok: true; calculatedItems: CalculatedScheduleItem[]; issues: ScheduleIssue[] }
  | { ok: false; reason: string }

/** Final guard using the real IDs and the same domain evaluators as Step 6. */
export const validateTimetableGenerationCandidate = (
  input: CandidateValidationInput,
  candidate: MaterializedTimetable,
): GenerationCandidateValidation => {
  const { event, eventDay, eventDays, stages, sections, eventBands, eventMembers, eventMemberDays,
    timetableLocks, members, dutyTypes, dutyAssignments } = input
  const fail = (reason: string): GenerationCandidateValidation => ({ ok: false, reason })
  if (!hasUnambiguousGenerationScope(event, eventDay, eventDays, stages, sections, eventBands)) {
    return fail('開催日・Stage・Section・出演バンドの所属を一意に判定できません。')
  }
  if (!hasUniqueIds(input.scheduleItems)) {
    return fail('元のScheduleItem IDが重複しています。')
  }
  if (!hasValidTimetableGenerationScheduleItems(input.scheduleItems)) {
    return fail('元のScheduleItemの形式が不正です。')
  }
  if (!hasUniqueIds(input.paAssignments)) {
    return fail('元のPA Assignment IDが重複しています。')
  }
  if (!hasValidReferenceInputs(input.paAssignments, dutyAssignments, timetableLocks)) {
    return fail('既存の担当またはTT固定参照が不正です。')
  }
  if (!hasValidTimetableGenerationDutyTypes(dutyTypes)) {
    return fail('既存の仕事種別の形式または所属を確認できません。')
  }
  if (!isRecord(candidate)) return fail('生成結果の形式が不正です。')
  if (!hasUniqueIds(candidate.scheduleItems)) {
    return fail('生成結果のScheduleItem IDが重複しています。')
  }
  if (!hasValidTimetableGenerationScheduleItems(candidate.scheduleItems)) {
    return fail('生成結果のScheduleItemの形式が不正です。')
  }
  if (!hasUniqueIds(candidate.paAssignments)) {
    return fail('生成結果のPA Assignment IDが重複しています。')
  }
  const scheduleItemIds = new Set(candidate.scheduleItems.map(item => item.id))
  if (candidate.paAssignments.some(pa => scheduleItemIds.has(pa.id))) {
    return fail('生成結果のScheduleItemとPA AssignmentのIDが重複しています。')
  }
  const originalScheduleItemIds = new Set(input.scheduleItems.map(item => item.id))
  const reservedScheduleReferences = getReservedScheduleReferences(
    input.paAssignments, dutyAssignments, timetableLocks, event.id, eventDay.id)
  if (candidate.scheduleItems.some(item => !originalScheduleItemIds.has(item.id) &&
    reservedScheduleReferences.has(item.id))) {
    return fail('生成結果の新規ScheduleItem IDが保持対象の参照と衝突しています。')
  }
  const targetStages = stages.filter(stage => stage.eventDayId === eventDay.id)
  const stageIds = new Set(targetStages.map(stage => stage.id))
  const targetSections = sections.filter(section => stageIds.has(section.stageId))
  const sectionIds = new Set(targetSections.map(section => section.id))
  const targetBands = eventBands.filter(band => band.eventId === event.id && band.eventDayId === eventDay.id)
  const bandIds = new Set(targetBands.map(band => band.id))
  if (!preservesGenerationBaseline(input.scheduleItems, candidate.scheduleItems, stageIds, bandIds)) {
    return fail('生成結果で元のScheduleItemが欠落・変更されたか、対象外の項目が追加されています。')
  }
  if (!preservesRetainedPaAssignments(input.paAssignments, candidate.paAssignments, event.id, eventDay.id)) {
    return fail('生成結果で対象外のPA Assignmentが欠落・変更・追加されています。')
  }
  const candidatePerformances = candidate.scheduleItems.filter(item => item.kind === 'performance')
  const targetBandPerformances = candidatePerformances.filter(item => bandIds.has(item.eventBandId))
  if (targetBandPerformances.length !== targetBands.length ||
    new Set(targetBandPerformances.map(item => item.eventBandId)).size !== targetBands.length ||
    targetBandPerformances.some(item => !stageIds.has(item.stageId))) {
    return fail('生成結果に出演バンドの不足・重複、または開催日の不一致があります。')
  }
  if (candidatePerformances.some(item => stageIds.has(item.stageId) && !bandIds.has(item.eventBandId))) {
    return fail('生成結果に対象外の出演バンドが含まれています。')
  }
  const plan = input.plan
  if (!isRecord(plan) || plan.eventDayId !== eventDay.id ||
    !Array.isArray(plan.paShifts) || !plan.paShifts.every(isRecord)) {
    return fail('生成計画のPA担当の形式が不正です。')
  }
  const targetPa = candidate.paAssignments.filter(item => item.eventId === event.id && item.eventDayId === eventDay.id)
  if (targetPa.length !== plan.paShifts.length) return fail('生成計画とPA担当の件数が一致しません。')
  const sourceItemById = new Map(input.scheduleItems.map(item => [item.id, item]))
  const candidateItemById = new Map(candidate.scheduleItems.map(item => [item.id, item]))
  const performanceIdByBand = new Map(targetBandPerformances.map(item => [item.eventBandId, item.id]))
  const expectedPaCounts = new Map<string, number>()
  for (const shift of plan.paShifts) {
    if (shift.eventDayId !== eventDay.id || !stageIds.has(shift.stageId) ||
      !isNonEmptyId(shift.memberId) || (shift.role !== 'main' && shift.role !== 'sub') ||
      (shift.sectionId !== undefined && !targetSections.some(section =>
        section.id === shift.sectionId && section.stageId === shift.stageId))) {
      return fail('生成計画のPA担当の所属が不正です。')
    }
    const from = resolvePlannedBoundary(shift.fromBoundary, shift.stageId,
      sourceItemById, candidateItemById, performanceIdByBand)
    const until = resolvePlannedBoundary(shift.untilBoundary, shift.stageId,
      sourceItemById, candidateItemById, performanceIdByBand)
    if (!from || !until) return fail('生成計画のPA担当範囲を解決できません。')
    const key = paShiftKey(event.id, eventDay.id, shift.stageId, shift.memberId, shift.role, from, until)
    expectedPaCounts.set(key, (expectedPaCounts.get(key) ?? 0) + 1)
  }
  for (const pa of targetPa) {
    if (!stageIds.has(pa.stageId) || !isNonEmptyId(pa.memberId) ||
      (pa.role !== 'main' && pa.role !== 'sub') || !isRecord(pa.from) || !isRecord(pa.until) ||
      !isNonEmptyId(pa.from.scheduleItemId) || !isNonEmptyId(pa.until.scheduleItemId) ||
      (pa.from.edge !== 'start' && pa.from.edge !== 'end') ||
      (pa.until.edge !== 'start' && pa.until.edge !== 'end')) {
      return fail('生成結果のPA担当の形式が不正です。')
    }
    const key = paShiftKey(event.id, eventDay.id, pa.stageId, pa.memberId, pa.role, pa.from, pa.until)
    const remaining = expectedPaCounts.get(key) ?? 0
    if (remaining === 0) return fail('生成結果に計画外のPA担当があります。')
    expectedPaCounts.set(key, remaining - 1)
  }
  const targetItems = candidate.scheduleItems.filter(item => stageIds.has(item.stageId))
  const originalItemById = new Map(input.scheduleItems.map(item => [item.id, item]))
  const targetLocks = timetableLocks.filter(lock =>
    isTargetTimetableLock(lock, event.id, stageIds, sectionIds, bandIds, originalItemById))
  // The Lock evaluator compares lane-local positions. Stage-wide fixed positions
  // are checked against the complete Stage sequence by detectScheduleIssues.
  const lockBands = targetBands.map(band => {
    if (!band.fixedPlacement?.position || band.fixedPlacement.sectionId !== undefined ||
      !targetSections.some(section => section.stageId === band.fixedPlacement?.stageId)) return band
    const fixedPlacement = { ...band.fixedPlacement }
    delete fixedPlacement.position
    return { ...band, fixedPlacement }
  })
  try {
    if (targetStages.some(stage => !hasSafeStageTimelineArithmetic({
      event, stage, sections: targetSections, scheduleItems: targetItems, eventBands: targetBands,
    }))) return fail('予定時刻を安全に計算できません。')
    const timeline = calculateEventDayTimelines({
      event, eventDayId: eventDay.id, stages: targetStages, sections: targetSections,
      scheduleItems: targetItems, eventBands: targetBands,
    })
    if (timeline.invalidStages.length) return fail('Sectionと出演項目の所属が一致していません。')
    if (!evaluateTimetableLocks({ eventId: event.id, timetableLocks: targetLocks,
      scheduleItems: candidate.scheduleItems, eventBands: lockBands,
      eventDays: [eventDay], stages: targetStages, sections: targetSections }).valid) {
      return fail('生成結果がTT固定と一致していません。')
    }
    if (targetPa.some(item => !resolvePaAssignmentInterval(item, timeline.calculatedItems).ok)) {
      return fail('PA担当の範囲を解決できません。')
    }
    const targetDuties = getDutyAssignmentsForEvent({
      event, stages: targetStages, dutyTypes, dutyAssignments,
    }).filter(item => item.eventDayId === eventDay.id)
    const memberIds = new Set(eventMembers.filter(member => member.eventId === event.id).map(member => member.id))
    const issues = detectScheduleIssues({ event, members, eventMembers,
      eventMemberDays: eventMemberDays.filter(day => day.eventDayId === eventDay.id && memberIds.has(day.eventMemberId)),
      eventBands: targetBands, stages: targetStages, sections: targetSections,
      paAssignments: targetPa, dutyTypes, dutyAssignments: targetDuties,
      calculatedItems: timeline.calculatedItems,
    })
    if (issues.some(issue => issue.severity === 'ERROR')) return fail('生成結果にERRORがあるため適用できません。')
    return { ok: true, calculatedItems: timeline.calculatedItems, issues }
  } catch {
    return fail('生成結果の時刻・参照を検証できません。')
  }
}
