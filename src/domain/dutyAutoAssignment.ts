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
  getDutyAssignmentsForEvent,
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
  eventMemberId: EventMember['id']
  eventMemberDayId: EventMemberDay['id']
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
  activitySpacingPolicy: ActivitySpacingPolicy
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

const activitySpacingCategories = [
  'performance-to-performance',
  'work-to-performance',
  'performance-to-work',
  'work-to-work',
] as const

const cloneActivitySpacingPolicy = (
  policy: Readonly<ActivitySpacingPolicy>,
): ActivitySpacingPolicy => ({
  'performance-to-performance': { ...policy['performance-to-performance'] },
  'work-to-performance': { ...policy['work-to-performance'] },
  'performance-to-work': { ...policy['performance-to-work'] },
  'work-to-work': { ...policy['work-to-work'] },
})

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
  activitySpacingPolicy: ActivitySpacingPolicy,
  selectedMetrics: readonly DutyAutoAssignmentCandidateMetric[],
): string => [
  'duty-auto-v3',
  context.event.id,
  context.eventDay.id,
  context.stage.id,
  request.dutyTypeId,
  boundaryKey(request.fromBoundary),
  boundaryKey(request.untilBoundary),
  request.fromMinute,
  request.untilMinute,
  request.additionalCount,
  ...activitySpacingCategories.map((category) => {
    const thresholds = activitySpacingPolicy[category]
    return [
      category,
      thresholds.minimumMinutes,
      thresholds.preferredMinutes,
      thresholds.sufficientMinutes,
    ].join(':')
  }),
  ...selectedMetrics.map((metric) => [
    metric.memberId,
    metric.eventMemberId,
    metric.eventMemberDayId,
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

const getEventStages = (context: DutyAutoAssignmentContext): Stage[] => {
  const eventDayIds = new Set(
    context.eventDays
      .filter((day) => day.eventId === context.event.id)
      .map((day) => day.id),
  )
  return context.stages.filter((candidate) =>
    eventDayIds.has(candidate.eventDayId),
  )
}

const getEventDutyAssignments = (
  context: DutyAutoAssignmentContext,
  dutyAssignments: DutyAssignment[],
): DutyAssignment[] => {
  return getDutyAssignmentsForEvent({
    event: context.event,
    stages: getEventStages(context),
    dutyTypes: context.dutyTypes,
    dutyAssignments,
  })
}

interface DutyCandidateIdentityScope {
  eventMember: EventMember
  eventMemberDay: EventMemberDay
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}

const createDutyCandidateIdentityScope = ({
  event,
  eventDayId,
  memberId,
  eventMemberId,
  eventMemberDayId,
  eventMembers,
  eventMemberDays,
}: {
  event: Pick<Event, 'id'>
  eventDayId: EventDay['id']
  memberId: MemberId
  eventMemberId: EventMember['id']
  eventMemberDayId: EventMemberDay['id']
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
}): DutyCandidateIdentityScope | undefined => {
  const matchingEventMembers = eventMembers.filter((candidate) =>
    candidate.id === eventMemberId,
  )
  const matchingMemberDays = eventMemberDays.filter((candidate) =>
    candidate.id === eventMemberDayId,
  )
  if (
    matchingEventMembers.length !== 1 ||
    matchingEventMembers[0].eventId !== event.id ||
    matchingEventMembers[0].memberId !== memberId ||
    matchingMemberDays.length !== 1 ||
    matchingMemberDays[0].eventMemberId !== eventMemberId ||
    matchingMemberDays[0].eventDayId !== eventDayId
  ) return undefined

  const duplicateEventMemberIds = new Set(
    eventMembers
      .filter((candidate) =>
        candidate.eventId === event.id && candidate.memberId === memberId,
      )
      .map((candidate) => candidate.id),
  )
  return {
    eventMember: matchingEventMembers[0],
    eventMemberDay: matchingMemberDays[0],
    eventMembers: [
      matchingEventMembers[0],
      ...eventMembers.filter((candidate) =>
        !duplicateEventMemberIds.has(candidate.id),
      ),
    ],
    eventMemberDays: [
      matchingMemberDays[0],
      ...eventMemberDays.filter((candidate) =>
        !duplicateEventMemberIds.has(candidate.eventMemberId),
      ),
    ],
  }
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
  left.memberId.localeCompare(right.memberId) ||
  left.eventMemberId.localeCompare(right.eventMemberId) ||
  left.eventMemberDayId.localeCompare(right.eventMemberDayId)
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

  const eventStages = getEventStages(context)
  const eventPaAssignments = context.paAssignments.filter((assignment) =>
    assignment.eventId === context.event.id,
  )
  const dayPaAssignments = eventPaAssignments.filter((assignment) =>
    assignment.eventDayId === context.eventDay.id)
  const dayDutyAssignments = getEventDutyAssignments(
    context,
    context.dutyAssignments,
  ).filter((assignment) => assignment.eventDayId === context.eventDay.id)
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
  const activitySpacingPolicy = cloneActivitySpacingPolicy(
    request.activitySpacingPolicy ?? DEFAULT_ACTIVITY_SPACING_POLICY,
  )
  const viableMetrics: DutyAutoAssignmentCandidateMetric[] = []

  for (const candidate of getDutyMemberCandidates({
    event: context.event,
    eventDayId: context.eventDay.id,
    members: context.members,
    eventMembers: context.eventMembers,
    eventMemberDays: context.eventMemberDays,
  })) {
    const identityScope = createDutyCandidateIdentityScope({
      event: context.event,
      eventDayId: context.eventDay.id,
      memberId: candidate.member.id,
      eventMemberId: candidate.eventMemberId,
      eventMemberDayId: candidate.eventMemberDay.id,
      eventMembers: context.eventMembers,
      eventMemberDays: context.eventMemberDays,
    })
    if (!identityScope) continue
    if (!isIntervalWithinAvailabilityWindows(
      identityScope.eventMemberDay.availabilityWindows,
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
      stages: eventStages,
      sections: context.sections,
      members: context.members,
      eventMembers: identityScope.eventMembers,
      eventMemberDays: identityScope.eventMemberDays,
      eventBands: context.eventBands,
      paAssignments: eventPaAssignments,
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
        eventMembers: identityScope.eventMembers,
        eventMemberDays: identityScope.eventMemberDays,
        eventBands: context.eventBands,
        stages: context.stages,
        sections: context.sections,
        paAssignments: dayPaAssignments,
        dutyTypes: context.dutyTypes,
        dutyAssignments: getEventDutyAssignments(context, addition.dutyAssignments)
          .filter((assignment) => assignment.eventDayId === context.eventDay.id),
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
        policy: activitySpacingPolicy,
        stageItems: calculatedItems,
      })
    } catch {
      continue
    }
    if (!spacing.feasible) continue
    const addedPairs = spacing.pairs.filter((pair) =>
      pair.previous.id === proposedActivity.id || pair.next.id === proposedActivity.id,
    )
    viableMetrics.push({
      memberId: candidate.member.id,
      eventMemberId: candidate.eventMemberId,
      eventMemberDayId: candidate.eventMemberDay.id,
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

  const bestMetricByMember = new Map<MemberId, DutyAutoAssignmentCandidateMetric>()
  for (const metric of viableMetrics) {
    const currentBest = bestMetricByMember.get(metric.memberId)
    if (!currentBest || compareMetrics(metric, currentBest, memberById) < 0) {
      bestMetricByMember.set(metric.memberId, metric)
    }
  }
  const metrics = [...bestMetricByMember.values()]
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
    return [`${name}はこの開催日の参加状況が未定です。`]
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
    activitySpacingPolicy: cloneActivitySpacingPolicy(activitySpacingPolicy),
    selectedMemberIds: selectedMetrics.map((metric) => metric.memberId),
    candidateMetrics: selectedMetrics.map((metric) => ({ ...metric })),
    warnings,
    planKey: '',
  }
  plan.planKey = createPlanKey(context, request, activitySpacingPolicy, selectedMetrics)
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
    !hasValidScope(context) ||
    plan.eventDayId !== context.eventDay.id ||
    plan.stageId !== context.stage.id ||
    !Number.isSafeInteger(plan.additionalCount) ||
    plan.additionalCount < 1 ||
    plan.additionalCount !== plan.selectedMemberIds.length ||
    plan.candidateMetrics.length !== plan.selectedMemberIds.length ||
    new Set(plan.selectedMemberIds).size !== plan.selectedMemberIds.length ||
    new Set(plan.candidateMetrics.map((metric) => metric.memberId)).size !==
      plan.candidateMetrics.length ||
    plan.candidateMetrics.some((metric, index) =>
      metric.memberId !== plan.selectedMemberIds[index],
    )
  ) {
    return {
      ok: false,
      code: 'INVALID_PLAN',
      message: '自動割り当てplanが現在の選択範囲と一致しません。',
    }
  }
  let authorizedPlan: DutyAutoAssignmentPlan
  try {
    const activitySpacingPolicy = cloneActivitySpacingPolicy(plan.activitySpacingPolicy)
    const request: DutyAutoAssignmentRequest = {
      dutyTypeId: plan.dutyTypeId,
      fromBoundary: cloneBoundary(plan.fromBoundary),
      untilBoundary: cloneBoundary(plan.untilBoundary),
      fromMinute: plan.fromMinute,
      untilMinute: plan.untilMinute,
      additionalCount: plan.additionalCount,
      activitySpacingPolicy,
    }
    if (
      createPlanKey(context, request, activitySpacingPolicy, plan.candidateMetrics) !==
        plan.planKey
    ) {
      return {
        ok: false,
        code: 'INVALID_PLAN',
        message: '自動割り当てplanの内容を確認できません。候補を更新してください。',
      }
    }
    const latest = planDutyAutoAssignments(context, request)
    if (!latest.ok || latest.plan.planKey !== plan.planKey) {
      return {
        ok: false,
        code: 'INVALID_PLAN',
        message: '担当状況が変わったため、自動割り当て候補を更新してください。',
      }
    }
    authorizedPlan = latest.plan
  } catch {
    return {
      ok: false,
      code: 'INVALID_PLAN',
      message: '自動割り当てplanの内容を確認できません。候補を更新してください。',
    }
  }
  const existingIds = new Set(context.dutyAssignments.map((assignment) => assignment.id))
  if (
    newDutyAssignmentIds.length !== authorizedPlan.selectedMemberIds.length ||
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

  const eventStages = getEventStages(context)
  const eventPaAssignments = context.paAssignments.filter((assignment) =>
    assignment.eventId === context.event.id,
  )
  const identityScopes: DutyCandidateIdentityScope[] = []
  let scopedEventMembers = context.eventMembers
  let scopedEventMemberDays = context.eventMemberDays
  for (const metric of authorizedPlan.candidateMetrics) {
    const identityScope = createDutyCandidateIdentityScope({
      event: context.event,
      eventDayId: authorizedPlan.eventDayId,
      memberId: metric.memberId,
      eventMemberId: metric.eventMemberId,
      eventMemberDayId: metric.eventMemberDayId,
      eventMembers: scopedEventMembers,
      eventMemberDays: scopedEventMemberDays,
    })
    if (!identityScope) {
      return {
        ok: false,
        code: 'INVALID_PLAN',
        message: '自動割り当てplanの参加情報を現在のデータで確認できません。',
      }
    }
    identityScopes.push(identityScope)
    scopedEventMembers = identityScope.eventMembers
    scopedEventMemberDays = identityScope.eventMemberDays
  }
  let workingAssignments = [...context.dutyAssignments]
  for (let index = 0; index < authorizedPlan.selectedMemberIds.length; index += 1) {
    const addition = createDutyAssignmentAddition({
      event: context.event,
      eventDays: context.eventDays,
      stages: eventStages,
      sections: context.sections,
      members: context.members,
      eventMembers: identityScopes[index].eventMembers,
      eventMemberDays: identityScopes[index].eventMemberDays,
      eventBands: context.eventBands,
      paAssignments: eventPaAssignments,
      calculatedItems: context.calculatedItems,
      dutyTypes: context.dutyTypes,
      dutyAssignments: workingAssignments,
      item: {
        dutyTypeId: authorizedPlan.dutyTypeId,
        eventDayId: authorizedPlan.eventDayId,
        stageId: authorizedPlan.stageId,
        memberId: authorizedPlan.selectedMemberIds[index],
        from: cloneBoundary(authorizedPlan.fromBoundary),
        until: cloneBoundary(authorizedPlan.untilBoundary),
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
      item.eventDayId === authorizedPlan.eventDayId,
    )
    issueErrors = uniqueMessages(detectScheduleIssues({
      event: context.event,
      members: context.members,
      eventMembers: scopedEventMembers,
      eventMemberDays: scopedEventMemberDays,
      eventBands: context.eventBands,
      stages: context.stages,
      sections: context.sections,
      paAssignments: eventPaAssignments.filter((assignment) =>
        assignment.eventDayId === authorizedPlan.eventDayId,
      ),
      dutyTypes: context.dutyTypes,
      dutyAssignments: getEventDutyAssignments(context, workingAssignments)
        .filter((assignment) => assignment.eventDayId === authorizedPlan.eventDayId),
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
