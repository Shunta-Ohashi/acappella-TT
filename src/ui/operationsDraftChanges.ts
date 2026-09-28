import type { PaAssignmentsDraft } from '../domain/paAssignments'
import type { DutySettingsDraft } from '../domain/dutyAssignments'

/** Shared guard for generation setup, preview apply, and destructive TT reset. */
export const hasUnsavedOperationsChanges = (
  pa?: { hasUnsavedChanges: () => boolean } | null,
  duty?: { hasUnsavedChanges: () => boolean } | null,
): boolean => Boolean(pa?.hasUnsavedChanges() || duty?.hasUnsavedChanges())

// Assignment array order and transient draft IDs do not change saved semantics.
const sortedRows = (rows: unknown[]): string[] => rows.map(row => JSON.stringify(row)).sort()

const paSnapshot = (draft: PaAssignmentsDraft) => sortedRows(draft.items.map(item => ({
  id: item.paAssignmentId, eventId: item.eventId, eventDayId: item.eventDayId,
  stageId: item.stageId, memberId: item.memberId, role: item.role,
  from: [item.from.scheduleItemId, item.from.edge], until: [item.until.scheduleItemId, item.until.edge],
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
      from: [item.from.scheduleItemId, item.from.edge], until: [item.until.scheduleItemId, item.until.edge],
    }))),
  }
}

export const hasPaDraftChanges = (draft: PaAssignmentsDraft, saved: PaAssignmentsDraft): boolean =>
  JSON.stringify(paSnapshot(draft)) !== JSON.stringify(paSnapshot(saved))

export const hasDutyDraftChanges = (draft: DutySettingsDraft, saved: DutySettingsDraft): boolean =>
  JSON.stringify(dutySnapshot(draft)) !== JSON.stringify(dutySnapshot(saved))
