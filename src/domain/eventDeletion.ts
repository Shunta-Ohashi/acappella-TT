import type {
  DutyAssignment,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventId,
  EventMember,
  EventMemberDay,
  PaAssignment,
  ScheduleBoundary,
  ScheduleItem,
  Section,
  Stage,
  TimetableLock,
  TimetableOrderConstraint,
} from './models'

export interface EventDeletionInput {
  eventId: EventId
  events: Event[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
  timetableOrderConstraints: TimetableOrderConstraint[]
}

export type EventDeletionFailureReason =
  | 'EVENT_NOT_FOUND'
  | 'EVENT_RELATIONSHIP_CONFLICT'

export type EventDeletionCheck =
  | { ok: true }
  | { ok: false; reason: EventDeletionFailureReason }

export type EventDeletionResult =
  | ({ ok: true } & Omit<EventDeletionInput, 'eventId'>)
  | { ok: false; reason: EventDeletionFailureReason }

interface EventDeletionOwnership {
  eventDayIds: Set<string>
  stageIds: Set<string>
  sectionIds: Set<string>
  eventMemberIds: Set<string>
  eventMemberDayIds: Set<string>
  eventBandIds: Set<string>
  scheduleItemIds: Set<string>
  paAssignmentIds: Set<string>
  dutyTypeIds: Set<string>
  dutyAssignmentIds: Set<string>
  timetableLockIds: Set<string>
  timetableOrderConstraintIds: Set<string>
}

type OwnershipResolution =
  | { ok: true; ownership: EventDeletionOwnership }
  | { ok: false; reason: EventDeletionFailureReason }

type OwnershipEvidence = EventId | ReadonlySet<EventId> | undefined

const collectResolvedOwners = (
  evidence: OwnershipEvidence[],
): Set<EventId> => {
  const resolvedOwners = new Set<EventId>()
  for (const owner of evidence) {
    if (owner === undefined) continue
    if (typeof owner === 'string') {
      resolvedOwners.add(owner)
      continue
    }
    for (const candidate of owner) resolvedOwners.add(candidate)
  }
  return resolvedOwners
}

const resolveOwnership = (
  evidence: OwnershipEvidence[],
  targetEventId: EventId,
): {
  owners: Set<EventId>
  owner?: EventId
  conflictsWithTarget: boolean
} => {
  const owners = collectResolvedOwners(evidence)
  return {
    owners,
    owner: owners.size === 1 ? [...owners][0] : undefined,
    conflictsWithTarget: owners.size > 1 && owners.has(targetEventId),
  }
}

const hasDirectOwnershipConflict = (
  owner: EventId,
  referencedOwnership: OwnershipEvidence[],
  targetEventId: EventId,
): boolean => [...collectResolvedOwners(referencedOwnership)].some((referencedOwner) =>
  referencedOwner !== undefined &&
  referencedOwner !== owner &&
  (owner === targetEventId || referencedOwner === targetEventId),
)

const resolveEventDeletionOwnership = ({
  eventId,
  events,
  eventDays,
  stages,
  sections,
  eventMembers,
  eventMemberDays,
  eventBands,
  scheduleItems,
  paAssignments,
  dutyTypes,
  dutyAssignments,
  timetableLocks,
  timetableOrderConstraints,
}: EventDeletionInput): OwnershipResolution => {
  if (!events.some((event) => event.id === eventId)) {
    return { ok: false, reason: 'EVENT_NOT_FOUND' }
  }

  const eventByDayId = new Map(eventDays.map((day) => [day.id, day.eventId]))
  const eventByStageId = new Map(stages.flatMap((stage) => {
    const owner = eventByDayId.get(stage.eventDayId)
    return owner === undefined ? [] : [[stage.id, owner] as const]
  }))
  const eventBySectionId = new Map(sections.flatMap((section) => {
    const owner = eventByStageId.get(section.stageId)
    return owner === undefined ? [] : [[section.id, owner] as const]
  }))
  const eventByEventMemberId = new Map(
    eventMembers.map((eventMember) => [eventMember.id, eventMember.eventId]),
  )

  const eventDayIds = new Set(eventDays
    .filter((day) => day.eventId === eventId)
    .map((day) => day.id))
  const stageIds = new Set(stages
    .filter((stage) => eventByStageId.get(stage.id) === eventId)
    .map((stage) => stage.id))
  const sectionIds = new Set(sections
    .filter((section) => eventBySectionId.get(section.id) === eventId)
    .map((section) => section.id))
  const eventMemberIds = new Set(eventMembers
    .filter((eventMember) => eventMember.eventId === eventId)
    .map((eventMember) => eventMember.id))

  const eventMemberDayIds = new Set<string>()
  for (const day of eventMemberDays) {
    const resolution = resolveOwnership([
      eventByEventMemberId.get(day.eventMemberId),
      eventByDayId.get(day.eventDayId),
    ], eventId)
    if (resolution.conflictsWithTarget) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    if (resolution.owner === eventId) eventMemberDayIds.add(day.id)
  }

  const eventByEventBandId = new Map(
    eventBands.map((eventBand) => [eventBand.id, eventBand.eventId]),
  )
  const eventBandIds = new Set<string>()
  for (const eventBand of eventBands) {
    const fixedPlacement = eventBand.fixedPlacement
    if (hasDirectOwnershipConflict(eventBand.eventId, [
      eventByDayId.get(eventBand.eventDayId),
      fixedPlacement ? eventByStageId.get(fixedPlacement.stageId) : undefined,
      fixedPlacement?.sectionId
        ? eventBySectionId.get(fixedPlacement.sectionId)
        : undefined,
    ], eventId)) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    if (eventBand.eventId === eventId) eventBandIds.add(eventBand.id)
  }

  const eventOwnersByScheduleItemId = new Map<string, Set<EventId>>()
  const scheduleItemIds = new Set<string>()
  for (const item of scheduleItems) {
    const referencedOwners = [
      eventByStageId.get(item.stageId),
      item.sectionId ? eventBySectionId.get(item.sectionId) : undefined,
      item.kind === 'performance'
        ? eventByEventBandId.get(item.eventBandId)
        : item.afterSectionId
          ? eventBySectionId.get(item.afterSectionId)
          : undefined,
    ]
    const resolution = resolveOwnership(referencedOwners, eventId)
    if (resolution.conflictsWithTarget) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    eventOwnersByScheduleItemId.set(item.id, resolution.owners)
    if (resolution.owner === eventId) scheduleItemIds.add(item.id)
  }

  const getBoundaryOwners = (
    boundary: ScheduleBoundary,
  ): OwnershipEvidence => {
    if (boundary.kind === 'schedule-item') {
      return eventOwnersByScheduleItemId.get(boundary.scheduleItemId)
    }
    if (boundary.kind === 'section') {
      return eventBySectionId.get(boundary.sectionId)
    }
    return undefined
  }

  const paAssignmentIds = new Set<string>()
  for (const assignment of paAssignments) {
    if (hasDirectOwnershipConflict(assignment.eventId, [
      eventByDayId.get(assignment.eventDayId),
      eventByStageId.get(assignment.stageId),
      getBoundaryOwners(assignment.from),
      getBoundaryOwners(assignment.until),
    ], eventId)) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    if (assignment.eventId === eventId) paAssignmentIds.add(assignment.id)
  }

  const eventByDutyTypeId = new Map(
    dutyTypes.map((dutyType) => [dutyType.id, dutyType.eventId]),
  )
  const dutyTypeIds = new Set(dutyTypes
    .filter((dutyType) => dutyType.eventId === eventId)
    .map((dutyType) => dutyType.id))
  const dutyAssignmentIds = new Set<string>()
  for (const assignment of dutyAssignments) {
    const resolution = resolveOwnership([
      eventByDutyTypeId.get(assignment.dutyTypeId),
      eventByDayId.get(assignment.eventDayId),
      eventByStageId.get(assignment.stageId),
      getBoundaryOwners(assignment.from),
      getBoundaryOwners(assignment.until),
    ], eventId)
    if (resolution.conflictsWithTarget) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    if (resolution.owner === eventId) dutyAssignmentIds.add(assignment.id)
  }

  const timetableLockIds = new Set<string>()
  for (const lock of timetableLocks) {
    if (hasDirectOwnershipConflict(lock.eventId, [
      eventOwnersByScheduleItemId.get(lock.scheduleItemId),
      eventByStageId.get(lock.stageId),
      lock.sectionId ? eventBySectionId.get(lock.sectionId) : undefined,
    ], eventId)) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    if (lock.eventId === eventId) timetableLockIds.add(lock.id)
  }

  const timetableOrderConstraintIds = new Set<string>()
  for (const constraint of timetableOrderConstraints) {
    if (hasDirectOwnershipConflict(constraint.eventId, [
      eventByDayId.get(constraint.eventDayId),
      eventByStageId.get(constraint.stageId),
      constraint.sectionId
        ? eventBySectionId.get(constraint.sectionId)
        : undefined,
      ...constraint.eventBandIds.map((id) => eventByEventBandId.get(id)),
    ], eventId)) {
      return { ok: false, reason: 'EVENT_RELATIONSHIP_CONFLICT' }
    }
    if (constraint.eventId === eventId) {
      timetableOrderConstraintIds.add(constraint.id)
    }
  }

  return {
    ok: true,
    ownership: {
      eventDayIds,
      stageIds,
      sectionIds,
      eventMemberIds,
      eventMemberDayIds,
      eventBandIds,
      scheduleItemIds,
      paAssignmentIds,
      dutyTypeIds,
      dutyAssignmentIds,
      timetableLockIds,
      timetableOrderConstraintIds,
    },
  }
}

export const checkEventDeletion = (
  input: EventDeletionInput,
): EventDeletionCheck => {
  const resolution = resolveEventDeletionOwnership(input)
  return resolution.ok ? { ok: true } : resolution
}

export const createEventDeletion = (
  input: EventDeletionInput,
): EventDeletionResult => {
  const resolution = resolveEventDeletionOwnership(input)
  if (!resolution.ok) return resolution

  const owned = resolution.ownership
  return {
    ok: true,
    events: input.events.filter((event) => event.id !== input.eventId),
    eventDays: input.eventDays.filter((day) => !owned.eventDayIds.has(day.id)),
    stages: input.stages.filter((stage) => !owned.stageIds.has(stage.id)),
    sections: input.sections.filter((section) => !owned.sectionIds.has(section.id)),
    eventMembers: input.eventMembers.filter(
      (eventMember) => !owned.eventMemberIds.has(eventMember.id),
    ),
    eventMemberDays: input.eventMemberDays.filter(
      (day) => !owned.eventMemberDayIds.has(day.id),
    ),
    eventBands: input.eventBands.filter((band) => !owned.eventBandIds.has(band.id)),
    scheduleItems: input.scheduleItems.filter(
      (item) => !owned.scheduleItemIds.has(item.id),
    ),
    paAssignments: input.paAssignments.filter(
      (assignment) => !owned.paAssignmentIds.has(assignment.id),
    ),
    dutyTypes: input.dutyTypes.filter((type) => !owned.dutyTypeIds.has(type.id)),
    dutyAssignments: input.dutyAssignments.filter(
      (assignment) => !owned.dutyAssignmentIds.has(assignment.id),
    ),
    timetableLocks: input.timetableLocks.filter(
      (lock) => !owned.timetableLockIds.has(lock.id),
    ),
    timetableOrderConstraints: input.timetableOrderConstraints.filter(
      (constraint) => !owned.timetableOrderConstraintIds.has(constraint.id),
    ),
  }
}
