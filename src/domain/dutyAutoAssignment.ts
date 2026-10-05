import type {
  DutyAssignment,
  DutyAssignmentId,
  DutyType,
  DutyTypeId,
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  PaAssignment,
  ScheduleBoundary,
  Section,
  Stage,
} from './models'
import type { CalculatedScheduleItem } from './timeline'
import {
  buildDutyActivities,
  buildPaActivities,
  buildPerformanceActivities,
  DEFAULT_ACTIVITY_SPACING_POLICY,
  evaluateMemberActivitySpacing,
  type ActivitySpacingPolicy,
  type MemberActivity,
} from './activitySpacing.ts'
import {
  createDutyAssignmentAddition,
  createDutySettingsDraft,
  getDutyMemberCandidates,
  resolveDutyAssignmentInterval,
  validateDutyTypeDrafts,
} from './dutyAssignments.ts'
import { isIntervalWithinAvailabilityWindows } from './eventBandSettings.ts'
import { detectScheduleIssues } from './issues.ts'

export interface DutyAutoAssignmentContext {
  event: Event
  eventDay: EventDay
  eventDays: EventDay[]
  stage: Stage
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  calculatedItems: CalculatedScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
}

export interface DutyAutoAssignmentRequest {
  dutyTypeId: DutyTypeId
  fromBoundary: ScheduleBoundary
  untilBoundary: ScheduleBoundary
  fromMinute: number
  untilMinute: number
  additionalCount: number
  activitySpacingPolicy?: ActivitySpacingPolicy
}

export interface DutyAutoAssignmentCandidateMetric {
  memberId: MemberId
  participationStatus: EventMemberDay['participationStatus']
  addedLastResortCount: number
  addedSpacingPenalty: number
  existingDutyMinutes: number
  existingDutyAssignmentCount: number
}

export interface DutyAutoAssignmentPlan {
  dutyTypeId: DutyTypeId
  eventDayId: EventDay['id']
  stageId: Stage['id']
  fromBoundary: ScheduleBoundary
  untilBoundary: ScheduleBoundary
  fromMinute: number
  untilMinute: number
  additionalCount: number
  selectedMemberIds: MemberId[]
  candidateMetrics: DutyAutoAssignmentCandidateMetric[]
  warnings: string[]
  planKey: string
}

export type DutyAutoAssignmentFailureCode =
  | 'INVALID_SCOPE'
  | 'INVALID_DUTY_TYPE'
  | 'INVALID_COUNT'
  | 'BROKEN_PERFORMANCE'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'INSUFFICIENT_ELIGIBLE_CANDIDATES'

export type DutyAutoAssignmentPlanResult =
  | { ok: true; plan: DutyAutoAssignmentPlan }
  | {
      ok: false
      code: DutyAutoAssignmentFailureCode
      message: string
      eligibleCount?: number
      requestedCount?: number
    }

export type DutyAutoAssignmentApplyResult =
  | { ok: true; dutyAssignments: DutyAssignment[] }
  | {
      ok: false
      code: 'INVALID_PLAN' | 'INVALID_IDS' | 'ASSIGNMENT_INVALID'
      message: string
      errors?: string[]
    }

const cloneBoundary = (boundary: ScheduleBoundary): ScheduleBoundary => ({ ...boundary })

const boundaryKey = (boundary: ScheduleBoundary): string => {
  if (boundary.kind === 'schedule-item') {
    return `item:${encodeURIComponent(boundary.scheduleItemId)}:${boundary.edge}`
  }
  if (boundary.kind === 'section') {
    return `section:${encodeURIComponent(boundary.sectionId)}:${boundary.edge}:` +
      `${boundary.offsetMinutes ?? ''}`
  }
  return `time:${encodeURIComponent(boundary.time)}`
}

const createPlanKey = (
  context: DutyAutoAssignmentContext,
  request: DutyAutoAssignmentRequest,
  selectedMetrics: readonly DutyAutoAssignmentCandidateMetric[],
): string => [
  'duty-auto-v1',
  context.event.id,
  context.eventDay.id,
  context.stage.id,
  request.dutyTypeId,
  boundaryKey(request.fromBoundary),
  boundaryKey(request.untilBoundary),
  request.fromMinute,
  request.untilMinute,
  request.additionalCount,
  ...selectedMetrics.map((metric) => [
    metric.memberId,
    metric.participationStatus,
    metric.addedLastResortCount,
    metric.addedSpacingPenalty,
    metric.existingDutyMinutes,
    metric.existingDutyAssignmentCount,
  ].map((value) => encodeURIComponent(String(value))).join(':')),
].map((value) => encodeURIComponent(String(value))).join('|')

const uniqueMessages = (messages: Array<string | undefined>): string[] => [
  ...new Set(messages.filter((message): message is string =>
    typeof message === 'string' && Boolean(message.trim()),
  )),
]

const hasValidScope = (context: DutyAutoAssignmentContext): boolean => {
  const matchingDays = context.eventDays.filter((day) => day.id === context.eventDay.id)
  const matchingStages = context.stages.filter((stage) => stage.id === context.stage.id)
  return matchingDays.length === 1 &&
    matchingDays[0].eventId === context.event.id &&
    context.eventDay.eventId === context.event.id &&
    matchingStages.length === 1 &&
    matchingStages[0].eventDayId === context.eventDay.id &&
    context.stage.eventDayId === context.eventDay.id
}

const getMemberDay = (
  context: DutyAutoAssignmentContext,
  memberId: MemberId,
): EventMemberDay | undefined => {
  const eventMember = context.eventMembers.find((candidate) =>
    candidate.eventId === context.event.id && candidate.memberId === memberId,
  )
  return eventMember && context.eventMemberDays.find((candidate) =>
    candidate.eventMemberId === eventMember.id &&
    candidate.eventDayId === context.eventDay.id,
  )
}

const getSyntheticId = (
  memberId: MemberId,
  assignments: readonly DutyAssignment[],
): DutyAssignmentId => {
  const base = `__duty_auto_candidate__:${memberId}`
  const existingIds = new Set(assignments.map((assignment) => assignment.id))
  let candidate = base
  let suffix = 1
  while (existingIds.has(candidate)) {
    candidate = `${base}:${suffix}`
    suffix += 1
  }
  return candidate
}

const hasUnresolvedWorkForMember = (
  memberId: MemberId,
  paAssignments: readonly PaAssignment[],
  dutyAssignments: readonly DutyAssignment[],
  unresolvedPaIds: ReadonlySet<string>,
  unresolvedDutyIds: ReadonlySet<string>,
): boolean => paAssignments.some((assignment) =>
  assignment.memberId === memberId && unresolvedPaIds.has(assignment.id),
) || dutyAssignments.some((assignment) =>
  assignment.memberId === memberId && unresolvedDutyIds.has(assignment.id),
)

const compareMetrics = (
  left: DutyAutoAssignmentCandidateMetric,
  right: DutyAutoAssignmentCandidateMetric,
  memberById: ReadonlyMap<MemberId, Member>,
): number => (
  (left.participationStatus === 'participating' ? 0 : 1) -
    (right.participationStatus === 'participating' ? 0 : 1) ||
  left.addedLastResortCount - right.addedLastResortCount ||
  left.addedSpacingPenalty - right.addedSpacingPenalty ||
  left.existingDutyMinutes - right.existingDutyMinutes ||
  left.existingDutyAssignmentCount - right.existingDutyAssignmentCount ||
  (memberById.get(left.memberId)?.realName ?? '').localeCompare(
    memberById.get(right.memberId)?.realName ?? '',
    'ja',
  ) ||
  left.memberId.localeCompare(right.memberId)
)

export const planDutyAutoAssignments = (
  context: DutyAutoAssignmentContext,
  request: DutyAutoAssignmentRequest,
): DutyAutoAssignmentPlanResult => {
  if (!hasValidScope(context) ||
    !Number.isSafeInteger(request.fromMinute) ||
    !Number.isSafeInteger(request.untilMinute) ||
    request.fromMinute >= request.untilMinute) {
    return {
      ok: false,
      code: 'INVALID_SCOPE',
      message: '選択した開催日・Stage・時間範囲を確認できません。範囲を選択し直してください。',
    }
  }
  if (!Number.isSafeInteger(request.additionalCount) || request.additionalCount < 1) {
    return {
      ok: false,
      code: 'INVALID_COUNT',
      message: '追加人数は1以上の整数で入力してください。',
    }
  }

  const matchingDutyTypes = context.dutyTypes.filter((dutyType) =>
    dutyType.id === request.dutyTypeId,
  )
  if (matchingDutyTypes.length !== 1 || matchingDutyTypes[0].eventId !== context.event.id) {
    return {
      ok: false,
      code: 'INVALID_DUTY_TYPE',
      message: '選択した仕事の種類を現在のイベントで確認できません。',
    }
  }
  const dutyDraft = createDutySettingsDraft(
    context.event,
    context.stages,
    context.dutyTypes,
    context.dutyAssignments,
  )
  const selectedDutyTypeDraft = dutyDraft.dutyTypes.find((dutyType) =>
    dutyType.dutyTypeId === request.dutyTypeId,
  )
  const selectedDutyTypeErrors = selectedDutyTypeDraft
    ? validateDutyTypeDrafts(dutyDraft.dutyTypes)[selectedDutyTypeDraft.draftId]
    : undefined
  if (!selectedDutyTypeDraft || Object.values(selectedDutyTypeErrors ?? {}).some(Boolean)) {
    const messages = uniqueMessages(Object.values(selectedDutyTypeErrors ?? {}))
    return {
      ok: false,
      code: 'INVALID_DUTY_TYPE',
      message: messages.join(' ') || '選択した仕事の種類が正しくありません。',
    }
  }

  const requestedInterval = resolveDutyAssignmentInterval({
    eventDayId: context.eventDay.id,
    stageId: context.stage.id,
    from: request.fromBoundary,
    until: request.untilBoundary,
  }, context.calculatedItems, {
    stages: context.stages,
    sections: context.sections,
  })
  if (
    !requestedInterval.ok ||
    requestedInterval.interval.fromMinute !== request.fromMinute ||
    requestedInterval.interval.untilMinute !== request.untilMinute
  ) {
    return {
      ok: false,
      code: 'INVALID_SCOPE',
      message: '選択した担当範囲の境界を確認できません。範囲を選択し直してください。',
    }
  }

  const calculatedItems = context.calculatedItems.filter((item) =>
    item.eventDayId === context.eventDay.id,
  )
  const performanceResult = buildPerformanceActivities(
    calculatedItems,
    context.eventBands.filter((band) => band.eventId === context.event.id),
  )
  if (performanceResult.unresolved.length > 0) {
    return {
      ok: false,
      code: 'BROKEN_PERFORMANCE',
      message: '出演情報の参照を確認できないため、自動割り当てできません。',
    }
  }

  const dayPaAssignments = context.paAssignments.filter((assignment) =>
    assignment.eventDayId === context.eventDay.id,
  )
  const dayDutyAssignments = context.dutyAssignments.filter((assignment) =>
    assignment.eventDayId === context.eventDay.id,
  )
  const boundaryContext = { stages: context.stages, sections: context.sections }
  const paActivities = buildPaActivities(
    dayPaAssignments,
    calculatedItems,
    boundaryContext,
  )
  const dutyActivities = buildDutyActivities(
    dayDutyAssignments,
    calculatedItems,
    boundaryContext,
  )
  const unresolvedPaIds = new Set(paActivities.unresolved.map((source) => source.id))
  const unresolvedDutyIds = new Set(dutyActivities.unresolved.map((source) => source.id))
  const memberById = new Map(context.members.map((member) => [member.id, member]))
  const metrics: DutyAutoAssignmentCandidateMetric[] = []
  const evaluatedMemberIds = new Set<MemberId>()

  for (const candidate of getDutyMemberCandidates({
    event: context.event,
    eventDayId: context.eventDay.id,
    members: context.members,
    eventMembers: context.eventMembers,
    eventMemberDays: context.eventMemberDays,
  })) {
    if (evaluatedMemberIds.has(candidate.member.id)) continue
    evaluatedMemberIds.add(candidate.member.id)
    const memberDay = getMemberDay(context, candidate.member.id)
    if (!memberDay || !isIntervalWithinAvailabilityWindows(
      memberDay.availabilityWindows,
      request.fromMinute,
      request.untilMinute,
    )) continue
    if (hasUnresolvedWorkForMember(
      candidate.member.id,
      dayPaAssignments,
      dayDutyAssignments,
      unresolvedPaIds,
      unresolvedDutyIds,
    )) continue

    const syntheticId = getSyntheticId(candidate.member.id, context.dutyAssignments)
    const addition = createDutyAssignmentAddition({
      event: context.event,
      eventDays: context.eventDays,
      stages: context.stages,
      sections: context.sections,
      members: context.members,
      eventMembers: context.eventMembers,
      eventMemberDays: context.eventMemberDays,
      eventBands: context.eventBands,
      paAssignments: context.paAssignments,
      calculatedItems: context.calculatedItems,
      dutyTypes: context.dutyTypes,
      dutyAssignments: context.dutyAssignments,
      item: {
        dutyTypeId: request.dutyTypeId,
        eventDayId: context.eventDay.id,
        stageId: context.stage.id,
        memberId: candidate.member.id,
        from: cloneBoundary(request.fromBoundary),
        until: cloneBoundary(request.untilBoundary),
      },
      newDutyAssignmentId: syntheticId,
    })
    if (!addition.ok) continue

    let relatedErrors: string[]
    try {
      relatedErrors = detectScheduleIssues({
        event: context.event,
        members: context.members,
        eventMembers: context.eventMembers,
        eventMemberDays: context.eventMemberDays,
        eventBands: context.eventBands,
        stages: context.stages,
        sections: context.sections,
        paAssignments: dayPaAssignments,
        dutyTypes: context.dutyTypes,
        dutyAssignments: addition.dutyAssignments.filter((assignment) =>
          assignment.eventDayId === context.eventDay.id,
        ),
        calculatedItems,
      }).filter((issue) =>
        issue.severity === 'ERROR' && issue.dutyAssignmentIds?.includes(syntheticId),
      ).map((issue) => issue.message)
    } catch {
      return {
        ok: false,
        code: 'BROKEN_PERFORMANCE',
        message: '出演情報の参照を確認できないため、自動割り当てできません。',
      }
    }
    if (relatedErrors.length > 0) continue

    const proposedAssignment = addition.dutyAssignments.find((assignment) =>
      assignment.id === syntheticId,
    )
    if (!proposedAssignment) continue
    const proposedActivityResult = buildDutyActivities(
      [proposedAssignment],
      calculatedItems,
      boundaryContext,
    )
    const proposedActivity = proposedActivityResult.activities[0]
    if (!proposedActivity || proposedActivityResult.unresolved.length > 0) continue
    const existingMemberDutyActivities = dutyActivities.activities.filter((activity) =>
      activity.memberId === candidate.member.id,
    )
    const activities: MemberActivity[] = [
      ...performanceResult.activities.filter((activity) =>
        activity.memberId === candidate.member.id,
      ),
      ...paActivities.activities.filter((activity) =>
        activity.memberId === candidate.member.id,
      ),
      ...existingMemberDutyActivities,
      proposedActivity,
    ]
    let spacing
    try {
      spacing = evaluateMemberActivitySpacing({
        activities,
        policy: request.activitySpacingPolicy ?? DEFAULT_ACTIVITY_SPACING_POLICY,
        stageItems: calculatedItems,
      })
    } catch {
      continue
    }
    if (!spacing.feasible) continue
    const addedPairs = spacing.pairs.filter((pair) =>
      pair.previous.id === proposedActivity.id || pair.next.id === proposedActivity.id,
    )
    metrics.push({
      memberId: candidate.member.id,
      participationStatus: candidate.participationStatus,
      addedLastResortCount: addedPairs.filter((pair) =>
        pair.level === 'last-resort',
      ).length,
      addedSpacingPenalty: addedPairs.reduce((total, pair) => total + pair.penalty, 0),
      existingDutyMinutes: existingMemberDutyActivities.reduce((total, activity) =>
        total + activity.untilMinute - activity.fromMinute,
      0),
      existingDutyAssignmentCount: existingMemberDutyActivities.length,
    })
  }

  metrics.sort((left, right) => compareMetrics(left, right, memberById))
  if (metrics.length < request.additionalCount) {
    return {
      ok: false,
      code: metrics.length === 0
        ? 'NO_ELIGIBLE_CANDIDATE'
        : 'INSUFFICIENT_ELIGIBLE_CANDIDATES',
      message: `${request.additionalCount}名必要ですが、条件を満たす候補は${metrics.length}名です。`,
      eligibleCount: metrics.length,
      requestedCount: request.additionalCount,
    }
  }

  const selectedMetrics = metrics.slice(0, request.additionalCount)
  const warnings = selectedMetrics.flatMap((metric) => {
    if (metric.participationStatus !== 'undecided') return []
    const name = memberById.get(metric.memberId)?.realName ?? metric.memberId
    return [`${name}さんはこの開催日の参加状況が未定です。`]
  })
  const plan: DutyAutoAssignmentPlan = {
    dutyTypeId: request.dutyTypeId,
    eventDayId: context.eventDay.id,
    stageId: context.stage.id,
    fromBoundary: cloneBoundary(request.fromBoundary),
    untilBoundary: cloneBoundary(request.untilBoundary),
    fromMinute: request.fromMinute,
    untilMinute: request.untilMinute,
    additionalCount: request.additionalCount,
    selectedMemberIds: selectedMetrics.map((metric) => metric.memberId),
    candidateMetrics: selectedMetrics.map((metric) => ({ ...metric })),
    warnings,
    planKey: '',
  }
  plan.planKey = createPlanKey(context, request, selectedMetrics)
  return { ok: true, plan }
}

export const createDutyAutoAssignments = ({
  context,
  plan,
  newDutyAssignmentIds,
}: {
  context: DutyAutoAssignmentContext
  plan: DutyAutoAssignmentPlan
  newDutyAssignmentIds: DutyAssignmentId[]
}): DutyAutoAssignmentApplyResult => {
  if (
    plan.eventDayId !== context.eventDay.id ||
    plan.stageId !== context.stage.id ||
    plan.additionalCount !== plan.selectedMemberIds.length ||
    new Set(plan.selectedMemberIds).size !== plan.selectedMemberIds.length
  ) {
    return {
      ok: false,
      code: 'INVALID_PLAN',
      message: '自動割り当てplanが現在の選択範囲と一致しません。',
    }
  }
  const existingIds = new Set(context.dutyAssignments.map((assignment) => assignment.id))
  if (
    newDutyAssignmentIds.length !== plan.selectedMemberIds.length ||
    newDutyAssignmentIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(newDutyAssignmentIds).size !== newDutyAssignmentIds.length ||
    newDutyAssignmentIds.some((id) => existingIds.has(id))
  ) {
    return {
      ok: false,
      code: 'INVALID_IDS',
      message: '新しい一般業務担当のIDを正しく生成できませんでした。',
    }
  }

  let workingAssignments = [...context.dutyAssignments]
  for (let index = 0; index < plan.selectedMemberIds.length; index += 1) {
    const addition = createDutyAssignmentAddition({
      event: context.event,
      eventDays: context.eventDays,
      stages: context.stages,
      sections: context.sections,
      members: context.members,
      eventMembers: context.eventMembers,
      eventMemberDays: context.eventMemberDays,
      eventBands: context.eventBands,
      paAssignments: context.paAssignments,
      calculatedItems: context.calculatedItems,
      dutyTypes: context.dutyTypes,
      dutyAssignments: workingAssignments,
      item: {
        dutyTypeId: plan.dutyTypeId,
        eventDayId: plan.eventDayId,
        stageId: plan.stageId,
        memberId: plan.selectedMemberIds[index],
        from: cloneBoundary(plan.fromBoundary),
        until: cloneBoundary(plan.untilBoundary),
      },
      newDutyAssignmentId: newDutyAssignmentIds[index],
    })
    if (!addition.ok) {
      const errors = uniqueMessages(Object.values(addition.errors))
      return {
        ok: false,
        code: 'ASSIGNMENT_INVALID',
        message: errors.join(' ') || '自動割り当て結果を追加できませんでした。',
        errors,
      }
    }
    workingAssignments = addition.dutyAssignments
  }

  let issueErrors: string[]
  try {
    const newIds = new Set(newDutyAssignmentIds)
    const calculatedItems = context.calculatedItems.filter((item) =>
      item.eventDayId === plan.eventDayId,
    )
    issueErrors = uniqueMessages(detectScheduleIssues({
      event: context.event,
      members: context.members,
      eventMembers: context.eventMembers,
      eventMemberDays: context.eventMemberDays,
      eventBands: context.eventBands,
      stages: context.stages,
      sections: context.sections,
      paAssignments: context.paAssignments.filter((assignment) =>
        assignment.eventDayId === plan.eventDayId,
      ),
      dutyTypes: context.dutyTypes,
      dutyAssignments: workingAssignments.filter((assignment) =>
        assignment.eventDayId === plan.eventDayId,
      ),
      calculatedItems,
    }).filter((issue) =>
      issue.severity === 'ERROR' && issue.dutyAssignmentIds?.some((id) => newIds.has(id)),
    ).map((issue) => issue.message))
  } catch {
    issueErrors = ['出演情報の参照を確認できないため、自動割り当てできません。']
  }
  if (issueErrors.length > 0) {
    return {
      ok: false,
      code: 'ASSIGNMENT_INVALID',
      message: issueErrors.join(' '),
      errors: issueErrors,
    }
  }

  return { ok: true, dutyAssignments: workingAssignments }
}
