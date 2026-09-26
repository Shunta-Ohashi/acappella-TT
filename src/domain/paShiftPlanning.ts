import type {
  Event, EventDayId, EventMember, EventMemberDay, Member, MemberId,
  PaRole, SectionId, StageId,
} from './models'
import {
  evaluateMemberActivitySpacing,
  type ActivitySpacingPolicy,
  type MemberActivity,
} from './activitySpacing.ts'
import { isIntervalWithinAvailabilityWindows } from './eventBandSettings.ts'
import { getPaMemberCandidates } from './paAssignments.ts'
import { getPaWorkloadImbalance } from './timetableGenerationScore.ts'
import type { CalculatedScheduleItem } from './timeline'

export type PlannedScheduleBoundary =
  | { kind: 'existing-item'; scheduleItemId: string; edge: 'start' | 'end' }
  | { kind: 'planned-performance'; eventBandId: string; edge: 'start' | 'end' }

export interface PlannedPaShift {
  eventDayId: EventDayId
  stageId: StageId
  sectionId?: SectionId
  role: PaRole
  memberId: MemberId
  fromMinute: number
  untilMinute: number
  fromBoundary: PlannedScheduleBoundary
  untilBoundary: PlannedScheduleBoundary
}

export interface PlannedPaShiftScope extends Omit<PlannedPaShift, 'role' | 'memberId'> {
  key: string
}

interface PaPlan {
  shifts: PlannedPaShift[]
  undecidedCount: number
  eligibleMemberIds: Record<PaRole, MemberId[]>
}

type PaPlanningResult =
  | { ok: true; plans: PaPlan[] }
  | { ok: false; code: 'NO_MAIN_PA_CANDIDATE' | 'NO_SUB_PA_CANDIDATE' |
      'NO_FEASIBLE_PA_PLAN' | 'SEARCH_LIMIT_REACHED'; scope?: PlannedPaShiftScope }

interface PaState {
  shifts: PlannedPaShift[]
  activities: MemberActivity[]
  lastResortCount: number
  spacingPenalty: number
  undecidedCount: number
  key: string
}

export const planPaShifts = ({
  event, eventDayId, scopes, calculatedItems, baseActivities, policy,
  members, eventMembers, eventMemberDays, beamWidth, maxExpandedStates,
}: {
  event: Event
  eventDayId: EventDayId
  scopes: PlannedPaShiftScope[]
  calculatedItems: CalculatedScheduleItem[]
  baseActivities: MemberActivity[]
  policy?: ActivitySpacingPolicy
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  beamWidth: number
  maxExpandedStates: number
}): PaPlanningResult => {
  const memberDayByMemberId = new Map(eventMembers
    .filter(member => member.eventId === event.id)
    .map(member => [member.memberId, eventMemberDays.find(day =>
      day.eventMemberId === member.id && day.eventDayId === eventDayId)]))
  const eligibleMemberIds: Record<PaRole, MemberId[]> = { main: [], sub: [] }
  const tasks = scopes.flatMap(scope => (['main', 'sub'] as const).map(role => {
    const candidates = getPaMemberCandidates({
      event, eventDayId, role, members, eventMembers, eventMemberDays,
    }).filter(candidate => isIntervalWithinAvailabilityWindows(
      memberDayByMemberId.get(candidate.member.id)?.availabilityWindows,
      scope.fromMinute, scope.untilMinute,
    ))
    candidates.forEach(candidate => {
      if (!eligibleMemberIds[role].includes(candidate.member.id)) {
        eligibleMemberIds[role].push(candidate.member.id)
      }
    })
    return { scope, role, candidates }
  }))
  const unavailable = tasks.find(task => task.candidates.length === 0)
  if (unavailable) return {
    ok: false,
    code: unavailable.role === 'main' ? 'NO_MAIN_PA_CANDIDATE' : 'NO_SUB_PA_CANDIDATE',
    scope: unavailable.scope,
  }
  if (tasks.length === 0) return { ok: true, plans: [{
    shifts: [], undecidedCount: 0, eligibleMemberIds,
  }] }

  const orderedTasks = [...tasks].sort((left, right) =>
    left.candidates.length - right.candidates.length ||
    left.scope.key.localeCompare(right.scope.key) ||
    left.role.localeCompare(right.role),
  )
  let states: PaState[] = [{
    shifts: [], activities: [], lastResortCount: 0,
    spacingPenalty: 0, undecidedCount: 0, key: '',
  }]
  let expandedStates = 0
  for (const task of orderedTasks) {
    const nextStates: PaState[] = []
    for (const state of states) {
      for (const candidate of task.candidates) {
        if (expandedStates >= maxExpandedStates) {
          return { ok: false, code: 'SEARCH_LIMIT_REACHED', scope: task.scope }
        }
        expandedStates += 1
        const shift: PlannedPaShift = {
          eventDayId, stageId: task.scope.stageId,
          ...(task.scope.sectionId ? { sectionId: task.scope.sectionId } : {}),
          role: task.role, memberId: candidate.member.id,
          fromMinute: task.scope.fromMinute, untilMinute: task.scope.untilMinute,
          fromBoundary: task.scope.fromBoundary, untilBoundary: task.scope.untilBoundary,
        }
        const activity: MemberActivity = {
          id: `pa-plan:${task.scope.key}:${task.role}`,
          kind: 'pa', memberId: candidate.member.id, eventDayId,
          stageId: task.scope.stageId,
          fromMinute: shift.fromMinute, untilMinute: shift.untilMinute,
        }
        const priorActivities = [...baseActivities, ...state.activities]
          .filter(item => item.memberId === candidate.member.id)
        const before = priorActivities.length > 0
          ? evaluateMemberActivitySpacing({
              activities: priorActivities, policy, stageItems: calculatedItems,
            })
          : { feasible: true, pairs: [], totalPenalty: 0 }
        const after = evaluateMemberActivitySpacing({
          activities: [...priorActivities, activity], policy, stageItems: calculatedItems,
        })
        if (!after.feasible) continue
        nextStates.push({
          shifts: [...state.shifts, shift],
          activities: [...state.activities, activity],
          lastResortCount: state.lastResortCount +
            after.pairs.filter(pair => pair.level === 'last-resort').length -
            before.pairs.filter(pair => pair.level === 'last-resort').length,
          spacingPenalty: state.spacingPenalty + after.totalPenalty - before.totalPenalty,
          undecidedCount: state.undecidedCount +
            Number(candidate.participationStatus === 'undecided'),
          key: `${state.key}|${candidate.member.id}`,
        })
      }
    }
    if (nextStates.length === 0) return {
      ok: false, code: 'NO_FEASIBLE_PA_PLAN', scope: task.scope,
    }
    nextStates.sort((left, right) =>
      left.lastResortCount - right.lastResortCount ||
      left.spacingPenalty - right.spacingPenalty ||
      getPaWorkloadImbalance('main', left.shifts, eligibleMemberIds.main) -
        getPaWorkloadImbalance('main', right.shifts, eligibleMemberIds.main) ||
      getPaWorkloadImbalance('sub', left.shifts, eligibleMemberIds.sub) -
        getPaWorkloadImbalance('sub', right.shifts, eligibleMemberIds.sub) ||
      left.undecidedCount - right.undecidedCount ||
      left.key.localeCompare(right.key),
    )
    states = nextStates.slice(0, beamWidth)
  }
  return { ok: true, plans: states.map(state => ({
    shifts: state.shifts,
    undecidedCount: state.undecidedCount,
    eligibleMemberIds,
  })) }
}
