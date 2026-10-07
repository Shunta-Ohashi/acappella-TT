import type { PaAssignmentsDraft } from '../domain/paAssignments'
import type { DutySettingsDraft } from '../domain/dutyAssignments'
import type { ScheduleBoundary } from '../domain/models'
import type { EventEditorStepId } from './eventEditorSteps'

export type EventEditorNavigationTarget = EventEditorStepId | 'events' | 'sign-out'

export const getUnsavedOperationsNavigationMessage = ({
  activeStep,
  target,
  hasUnsavedChanges,
}: {
  activeStep: EventEditorStepId
  target: EventEditorNavigationTarget
  hasUnsavedChanges: boolean
}): string | undefined => activeStep === 6 && target !== 6 && hasUnsavedChanges
  ? target === 'sign-out'
    ? 'PAまたは当日運営に未保存の変更があります。保存してからログアウトしてください。'
    : 'PAまたは当日運営に未保存の変更があります。保存してから移動してください。'
  : undefined

/** Shared guard for generation setup, preview apply, and destructive TT reset. */
export const hasUnsavedOperationsChanges = (
  pa?: { hasUnsavedChanges: () => boolean } | null,
  duty?: { hasUnsavedChanges: () => boolean } | null,
): boolean => Boolean(pa?.hasUnsavedChanges() || duty?.hasUnsavedChanges())

// Assignment array order and transient draft IDs do not change saved semantics.
const sortedRows = (rows: unknown[]): string[] => rows.map(row => JSON.stringify(row)).sort()

const canonicalBoundarySnapshot = (boundary: ScheduleBoundary): readonly unknown[] => {
  if (boundary.kind === 'schedule-item') {
    return ['schedule-item', boundary.scheduleItemId, boundary.edge]
  }
  if (boundary.kind === 'section') {
    // null keeps whole-Section (omitted) distinct from partial-Section offset 0.
    return ['section', boundary.sectionId, boundary.edge, boundary.offsetMinutes ?? null]
  }
  return ['time', boundary.time]
}

const paSnapshot = (draft: PaAssignmentsDraft) => sortedRows(draft.items.map(item => ({
  id: item.paAssignmentId, eventId: item.eventId, eventDayId: item.eventDayId,
  stageId: item.stageId, memberId: item.memberId, role: item.role,
  from: canonicalBoundarySnapshot(item.from), until: canonicalBoundarySnapshot(item.until),
})))

const dutySnapshot = (draft: DutySettingsDraft) => {
  const typeIdByDraftId = new Map(draft.dutyTypes.map((type, index) =>
    [type.draftId, type.dutyTypeId ?? `new-type:${index}`]))
  return {
    types: draft.dutyTypes.map(type => ({ id: type.dutyTypeId, name: type.name.trim() })),
    assignments: sortedRows(draft.assignments.map(item => ({
      id: item.dutyAssignmentId,
      typeId: item.dutyTypeDraftId === undefined ? item.missingDutyTypeId : typeIdByDraftId.get(item.dutyTypeDraftId),
      eventDayId: item.eventDayId, stageId: item.stageId, memberId: item.memberId,
      from: canonicalBoundarySnapshot(item.from), until: canonicalBoundarySnapshot(item.until),
    }))),
  }
}

export const hasPaDraftChanges = (draft: PaAssignmentsDraft, saved: PaAssignmentsDraft): boolean =>
  JSON.stringify(paSnapshot(draft)) !== JSON.stringify(paSnapshot(saved))

export const hasDutyDraftChanges = (draft: DutySettingsDraft, saved: DutySettingsDraft): boolean =>
  JSON.stringify(dutySnapshot(draft)) !== JSON.stringify(dutySnapshot(saved))
