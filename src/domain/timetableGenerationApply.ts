import type { Event, EventBand, EventDay, PaAssignment, ScheduleBoundary, ScheduleItem, Section, Stage } from './models'
import type { PlannedScheduleBoundary } from './paShiftPlanning'
import type { TimetableGenerationInput, TimetableGenerationPlan } from './timetableGeneration'
import { isValidScheduleItemSectionAssignment } from './schedule.ts'
import { calculateEventDayTimelines } from './timetable.ts'
import { evaluateTimetableLocks } from './timetableLocks.ts'
import { detectScheduleIssues, type ScheduleIssue } from './issues.ts'
import { getDutyAssignmentsForEvent } from './dutyAssignments.ts'
import { resolvePaAssignmentInterval } from './paAssignments.ts'
import { hasSafeStageTimelineArithmetic } from './timetableGenerationArithmetic.ts'
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
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  plan: TimetableGenerationPlan
  newScheduleItemIds: string[]
  newPaAssignmentIds: string[]
}

const hasUniqueIds = (items: { id: string }[]): boolean =>
  new Set(items.map(item => item.id)).size === items.length

const hasUnambiguousGenerationScope = (
  event: Event, eventDay: EventDay, eventDays: EventDay[], stages: Stage[],
  sections: Section[], eventBands: EventBand[],
): boolean => eventDay.eventId === event.id && hasUniqueIds(eventDays) && hasUniqueIds(stages) &&
  hasUniqueIds(sections) && hasUniqueIds(eventBands) &&
  eventDays.filter(day => day.id === eventDay.id && day.eventId === event.id).length === 1

/** Convert a plan without allocating IDs or changing any committed collection. */
export const materializeTimetableGenerationPlan = ({
  event, eventDay, eventDays, stages, sections, eventBands, scheduleItems, paAssignments,
  plan, newScheduleItemIds, newPaAssignmentIds,
}: MaterializationInput): MaterializationResult => {
  const fail = (code: MaterializationFailureCode): MaterializationResult => ({ ok: false, code })
  if (!hasUnambiguousGenerationScope(event, eventDay, eventDays, stages, sections, eventBands) ||
    plan.eventDayId !== eventDay.id) {
    return fail('PLAN_SCOPE_MISMATCH')
  }
  if (newScheduleItemIds.length !== plan.placements.filter(p => p.scheduleItemId === undefined).length ||
    newPaAssignmentIds.length !== plan.paShifts.length) return fail('ID_COUNT_MISMATCH')
  const newIds = [...newScheduleItemIds, ...newPaAssignmentIds]
  const existingIds = new Set([...scheduleItems, ...paAssignments].map(item => item.id))
  if (new Set(newIds).size !== newIds.length ||
    newIds.some(id => !id.trim() || existingIds.has(id))) return fail('ID_COLLISION')

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

  const candidateItems = [
    ...scheduleItems.filter(item => !stageById.has(item.stageId) &&
      !(item.kind === 'performance' && bandById.has(item.eventBandId))),
    ...generated,
  ]
  const candidateItemById = new Map(candidateItems.map(item => [item.id, item]))
  const boundary = (value: PlannedScheduleBoundary, stageId: string): ScheduleBoundary | undefined => {
    const id = value.kind === 'existing-item' ? value.scheduleItemId
      : value.kind === 'planned-performance' ? performanceIdByBand.get(value.eventBandId) : undefined
    if (!id || candidateItemById.get(id)?.stageId !== stageId ||
      (value.edge !== 'start' && value.edge !== 'end')) return undefined
    return { scheduleItemId: id, edge: value.edge }
  }
  const assignments: PaAssignment[] = []
  for (const [index, shift] of plan.paShifts.entries()) {
    if (shift.eventDayId !== eventDay.id || !stageById.has(shift.stageId) ||
      (shift.sectionId !== undefined && !sections.some(s => s.id === shift.sectionId && s.stageId === shift.stageId)) ||
      !shift.memberId || (shift.role !== 'main' && shift.role !== 'sub')) return fail('INVALID_PLAN_REFERENCE')
    const from = boundary(shift.fromBoundary, shift.stageId)
    const until = boundary(shift.untilBoundary, shift.stageId)
    if (!from || !until) return fail('BOUNDARY_UNRESOLVED')
    assignments.push({
      id: newPaAssignmentIds[index], eventId: event.id, eventDayId: eventDay.id,
      stageId: shift.stageId, memberId: shift.memberId, role: shift.role, from, until,
    })
  }
  return {
    ok: true, scheduleItems: candidateItems,
    paAssignments: [...paAssignments.filter(item => item.eventId !== event.id || item.eventDayId !== eventDay.id), ...assignments],
  }
}

export type GenerationCandidateValidation =
  | { ok: true; calculatedItems: CalculatedScheduleItem[]; issues: ScheduleIssue[] }
  | { ok: false; reason: string }

/** Final guard using the real IDs and the same domain evaluators as Step 6. */
export const validateTimetableGenerationCandidate = (
  input: TimetableGenerationInput,
  candidate: MaterializedTimetable,
): GenerationCandidateValidation => {
  const { event, eventDay, eventDays, stages, sections, eventBands, eventMembers, eventMemberDays,
    timetableLocks, members, dutyTypes, dutyAssignments } = input
  const fail = (reason: string): GenerationCandidateValidation => ({ ok: false, reason })
  if (!hasUnambiguousGenerationScope(event, eventDay, eventDays, stages, sections, eventBands)) {
    return fail('開催日・Stage・Section・出演バンドの所属を一意に判定できません。')
  }
  const targetStages = stages.filter(stage => stage.eventDayId === eventDay.id)
  const stageIds = new Set(targetStages.map(stage => stage.id))
  const targetSections = sections.filter(section => stageIds.has(section.stageId))
  const sectionIds = new Set(targetSections.map(section => section.id))
  const targetBands = eventBands.filter(band => band.eventId === event.id && band.eventDayId === eventDay.id)
  const bandIds = new Set(targetBands.map(band => band.id))
  const targetItems = candidate.scheduleItems.filter(item => stageIds.has(item.stageId))
  const originalItemById = new Map(input.scheduleItems.map(item => [item.id, item]))
  const targetLocks = timetableLocks.filter(lock => {
    const item = originalItemById.get(lock.scheduleItemId)
    return lock.eventId === event.id && (stageIds.has(lock.stageId) ||
      (lock.sectionId !== undefined && sectionIds.has(lock.sectionId)) ||
      (item !== undefined && (stageIds.has(item.stageId) ||
        (item.kind === 'performance' && bandIds.has(item.eventBandId)))))
  })
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
    const targetPa = candidate.paAssignments.filter(item => item.eventId === event.id && item.eventDayId === eventDay.id)
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
