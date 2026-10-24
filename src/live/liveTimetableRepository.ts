import type { SupabaseClient } from '@supabase/supabase-js'
import { isRecord } from '../persistence/persistenceValidation.ts'
import { isPostgresBigintGeneration } from '../cloud/cloudGeneration.ts'

export type LiveTimetableProgressStatus =
  | 'empty'
  | 'not_started'
  | 'waiting'
  | 'in_progress'
  | 'completed'

export interface LiveTimetableEntryView {
  position: number
  kind: 'performance' | 'break'
  displayName: string
  plannedStartMinute: number
  plannedEndMinute: number
  status: 'pending' | 'in_progress' | 'completed'
  actualStartedAt: string | null
  actualEndedAt: string | null
  sourceScheduleItemId?: string
  sourceSectionId?: string | null
  afterSectionId?: string | null
  startedBy?: string | null
  endedBy?: string | null
}

export interface LiveTimetableStageView {
  stageId?: string
  sourceEventDayId?: string
  sourceStageId?: string
  eventDayPosition: number
  name: string
  position: number
  plannedStartTime: string
  plannedEndTime: string | null
  sections: Array<{
    sourceSectionId?: string
    name: string
    position: number
    plannedStartTime: string | null
    plannedEndTime: string | null
  }>
  revision: string
  projectionVersion: string
  progressStatus: LiveTimetableProgressStatus
  currentEntryPosition: number | null
  nextEntryPosition: number | null
  nextPerformancePosition: number | null
  updatedAt: string
  canOperate?: boolean
  entries: LiveTimetableEntryView[]
}

export interface AuthorizedLiveTimetable {
  liveId: string
  publicId: string
  workspaceId: string
  eventId: string
  eventName: string
  timeZone: string
  eventDays: Array<{
    sourceEventDayId: string
    date: string
    label: string | null
    position: number
  }>
  sourceRevision: number
  sourceSnapshotFingerprint: string
  projectionVersion: string
  managementRevision: string
  isPublished: boolean
  createdAt: string
  updatedAt: string
  role: 'owner' | 'editor' | 'viewer'
  canManage: boolean
  operators: Array<{ stageId: string; userId: string; assignedAt: string }>
  stages: LiveTimetableStageView[]
}

export interface PublicLiveTimetable {
  publicId: string
  eventName: string
  timeZone: string
  projectionVersion: string
  managementRevision: string
  eventDays: Array<{ date: string; position: number }>
  stages: LiveTimetableStageView[]
}

export interface LiveTimetableDiscovery {
  workspaceId: string
  eventId: string
  eventName: string
  sourceRevision: number
  liveId: string | null
}

export interface LiveTimetableOperatorCandidate {
  userId: string
  displayName: string
}

export type LiveTimetableRepositoryErrorCode =
  | 'ACCESS_DENIED'
  | 'AUTHENTICATION_REQUIRED'
  | 'CONFIGURATION_ERROR'
  | 'EVENT_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE'
  | 'INVALID_SOURCE'
  | 'LIVE_ALREADY_EXISTS'
  | 'LIVE_NOT_FOUND'
  | 'NOT_FOUND'
  | 'OPERATOR_NOT_EDITOR'
  | 'OPERATOR_NOT_ELIGIBLE'
  | 'PROJECTION_REPLACEMENT_FORBIDDEN'
  | 'REVISION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'SUPABASE_ERROR'

export interface LiveTimetableRepositoryError {
  code: LiveTimetableRepositoryErrorCode
  message: string
}

export type LiveTimetableRepositoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LiveTimetableRepositoryError }

export interface LiveTimetableDatabaseError {
  code?: string
  message?: string
}

export interface LiveTimetableDatabaseResult<T> {
  data: T | null
  error: LiveTimetableDatabaseError | null
}

export interface LiveTimetableDatabaseGateway {
  createProjection: (input: {
    workspaceId: string
    eventId: string
    expectedSourceRevision: number
    mode: 'create' | 'replace'
    expectedManagementRevision: string | null
  }) => Promise<LiveTimetableDatabaseResult<unknown>>
  loadAuthorized: (
    liveId: string,
    signal?: AbortSignal,
  ) => Promise<LiveTimetableDatabaseResult<unknown>>
  loadPublic: (publicId: string) => Promise<LiveTimetableDatabaseResult<unknown>>
  findForEvent: (input: {
    workspaceId: string
    eventId: string
  }, signal?: AbortSignal) => Promise<LiveTimetableDatabaseResult<unknown>>
  listOperatorCandidates: (
    liveId: string,
    signal?: AbortSignal,
  ) => Promise<LiveTimetableDatabaseResult<unknown>>
  setPublication: (input: {
    liveId: string
    expectedManagementRevision: string
    published: boolean
  }) => Promise<LiveTimetableDatabaseResult<unknown>>
  setStageOperator: (input: {
    liveId: string
    sourceStageId: string
    operatorUserId: string
    assign: boolean
    expectedManagementRevision: string
    expectedProjectionVersion: string
  }) => Promise<LiveTimetableDatabaseResult<unknown>>
  transitionEntry: (input: {
    operation: 'start' | 'end'
    liveId: string
    sourceStageId: string
    sourceScheduleItemId: string
    expectedStageRevision: string
    expectedProjectionVersion: string
  }) => Promise<LiveTimetableDatabaseResult<unknown>>
}

export interface LiveTimetableRepository {
  createProjection: LiveTimetableDatabaseGateway['createProjection'] extends
    (input: infer T) => unknown
    ? (input: T) => Promise<LiveTimetableRepositoryResult<unknown>>
    : never
  loadAuthorized: (
    liveId: string,
    signal?: AbortSignal,
  ) => Promise<LiveTimetableRepositoryResult<AuthorizedLiveTimetable>>
  loadPublic: (
    publicId: string,
  ) => Promise<LiveTimetableRepositoryResult<PublicLiveTimetable>>
  findForEvent: (
    workspaceId: string,
    eventId: string,
    signal?: AbortSignal,
  ) => Promise<LiveTimetableRepositoryResult<LiveTimetableDiscovery>>
  listOperatorCandidates: (
    liveId: string,
    signal?: AbortSignal,
  ) => Promise<LiveTimetableRepositoryResult<LiveTimetableOperatorCandidate[]>>
  setPublication: (
    liveId: string,
    expectedManagementRevision: string,
    published: boolean,
  ) => Promise<LiveTimetableRepositoryResult<unknown>>
  setStageOperator: (
    liveId: string,
    sourceStageId: string,
    expectedStageId: string,
    operatorUserId: string,
    assign: boolean,
    expectedManagementRevision: string,
    expectedProjectionVersion: string,
  ) => Promise<LiveTimetableRepositoryResult<unknown>>
  startEntry: (
    liveId: string,
    sourceStageId: string,
    expectedStageId: string,
    sourceScheduleItemId: string,
    expectedEntryPosition: number,
    expectedStageRevision: string,
    expectedProjectionVersion: string,
  ) => Promise<LiveTimetableRepositoryResult<unknown>>
  endEntry: (
    liveId: string,
    sourceStageId: string,
    expectedStageId: string,
    sourceScheduleItemId: string,
    expectedEntryPosition: number,
    expectedStageRevision: string,
    expectedProjectionVersion: string,
  ) => Promise<LiveTimetableRepositoryResult<unknown>>
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const fingerprintPattern = /^[0-9a-f]{64}$/u
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u
const localTimePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u

const normalizeUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && uuidPattern.test(value)
    ? value.toLowerCase()
    : undefined

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const allowed = new Set(keys)
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => allowed.has(key))
}

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value))

const isPositiveRevision = (value: unknown): value is string =>
  isPostgresBigintGeneration(value) && value !== '0'

const isPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isNullablePosition = (value: unknown): value is number | null =>
  value === null || isPosition(value)

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isNullableNonEmptyString = (value: unknown): value is string | null =>
  value === null || isNonEmptyString(value)

const isNullableUuid = (value: unknown): value is string | null =>
  value === null || normalizeUuid(value) !== undefined

const isLocalTime = (value: unknown): value is string =>
  typeof value === 'string' && localTimePattern.test(value)

const isLocalTimeOrNull = (value: unknown): value is string | null =>
  value === null || isLocalTime(value)

const hasUniqueBoundedPositions = (
  positions: readonly number[],
): boolean => new Set(positions).size === positions.length &&
  positions.every(position => position < positions.length)

const parseSections = (
  value: unknown,
  internal: boolean,
): LiveTimetableStageView['sections'] | undefined => {
  if (!Array.isArray(value)) return undefined
  const sections: LiveTimetableStageView['sections'] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, internal
        ? [
            'sourceSectionId', 'name', 'position',
            'plannedStartTime', 'plannedEndTime',
          ]
        : ['name', 'position', 'plannedStartTime', 'plannedEndTime']) ||
      !isNonEmptyString(item.name) ||
      !isPosition(item.position) ||
      !isLocalTimeOrNull(item.plannedStartTime) ||
      !isLocalTimeOrNull(item.plannedEndTime) ||
      (internal && !isNonEmptyString(item.sourceSectionId))
    ) return undefined
    sections.push({
      ...(internal ? { sourceSectionId: item.sourceSectionId as string } : {}),
      name: item.name,
      position: item.position,
      plannedStartTime: item.plannedStartTime,
      plannedEndTime: item.plannedEndTime,
    })
  }
  return sections
}

const parseEntries = (
  value: unknown,
  internal: boolean,
): LiveTimetableEntryView[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const entries: LiveTimetableEntryView[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, internal
        ? [
            'sourceScheduleItemId', 'sourceSectionId', 'afterSectionId',
            'position', 'kind', 'displayName', 'plannedStartMinute',
            'plannedEndMinute', 'status', 'actualStartedAt',
            'actualEndedAt', 'startedBy', 'endedBy',
          ]
        : [
            'position', 'kind', 'displayName', 'plannedStartMinute',
            'plannedEndMinute', 'status', 'actualStartedAt',
            'actualEndedAt',
          ]) ||
      !isPosition(item.position) ||
      (item.kind !== 'performance' && item.kind !== 'break') ||
      !isNonEmptyString(item.displayName) ||
      !isPosition(item.plannedStartMinute) ||
      !isPosition(item.plannedEndMinute) ||
      item.plannedEndMinute < item.plannedStartMinute ||
      !['pending', 'in_progress', 'completed'].includes(String(item.status)) ||
      !isNullableString(item.actualStartedAt) ||
      !isNullableString(item.actualEndedAt) ||
      (item.actualStartedAt !== null && !isTimestamp(item.actualStartedAt)) ||
      (item.actualEndedAt !== null && !isTimestamp(item.actualEndedAt)) ||
      (item.status === 'pending' && (
        item.actualStartedAt !== null || item.actualEndedAt !== null
      )) ||
      (item.status === 'in_progress' && (
        item.actualStartedAt === null || item.actualEndedAt !== null
      )) ||
      (item.status === 'completed' && (
        item.actualStartedAt === null || item.actualEndedAt === null ||
        Date.parse(item.actualEndedAt) < Date.parse(item.actualStartedAt)
      )) ||
      (item.kind === 'break' && item.displayName !== '休憩') ||
      (internal && (
        !isNonEmptyString(item.sourceScheduleItemId) ||
        !isNullableNonEmptyString(item.sourceSectionId) ||
        !isNullableNonEmptyString(item.afterSectionId) ||
        !isNullableUuid(item.startedBy) ||
        !isNullableUuid(item.endedBy) ||
        (item.status === 'pending' &&
          (item.startedBy !== null || item.endedBy !== null)) ||
        (item.status === 'in_progress' &&
          (item.startedBy === null || item.endedBy !== null)) ||
        (item.status === 'completed' &&
          (item.startedBy === null || item.endedBy === null))
      ))
    ) return undefined
    entries.push({
      position: item.position,
      kind: item.kind,
      displayName: item.displayName,
      plannedStartMinute: item.plannedStartMinute,
      plannedEndMinute: item.plannedEndMinute,
      status: item.status as LiveTimetableEntryView['status'],
      actualStartedAt: item.actualStartedAt,
      actualEndedAt: item.actualEndedAt,
      ...(internal ? {
        sourceScheduleItemId: item.sourceScheduleItemId as string,
        sourceSectionId: item.sourceSectionId as string | null,
        afterSectionId: item.afterSectionId as string | null,
        startedBy: item.startedBy as string | null,
        endedBy: item.endedBy as string | null,
      } : {}),
    })
  }
  return entries
}

const progressStatuses = new Set<LiveTimetableProgressStatus>([
  'empty', 'not_started', 'waiting', 'in_progress', 'completed',
])

const parseStages = (
  value: unknown,
  internal: boolean,
): LiveTimetableStageView[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const stages: LiveTimetableStageView[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    if (!hasOnlyKeys(item, internal
      ? [
          'stageId', 'sourceEventDayId', 'sourceStageId', 'name',
          'eventDayPosition', 'position', 'plannedStartTime',
          'plannedEndTime', 'sections',
          'revision', 'projectionVersion', 'progressStatus',
          'currentEntryPosition', 'nextEntryPosition',
          'nextPerformancePosition', 'updatedAt', 'canOperate', 'entries',
        ]
      : [
          'name', 'eventDayPosition', 'position',
          'plannedStartTime', 'plannedEndTime',
          'sections', 'revision', 'projectionVersion', 'progressStatus',
          'currentEntryPosition', 'nextEntryPosition',
          'nextPerformancePosition', 'updatedAt', 'entries',
        ])) return undefined
    const sections = parseSections(item.sections, internal)
    const entries = parseEntries(item.entries, internal)
    if (
      !sections || !entries ||
      !isNonEmptyString(item.name) ||
      !isPosition(item.eventDayPosition) ||
      !isPosition(item.position) ||
      !isLocalTime(item.plannedStartTime) ||
      !isLocalTimeOrNull(item.plannedEndTime) ||
      !isPositiveRevision(item.revision) ||
      !isPositiveRevision(item.projectionVersion) ||
      !progressStatuses.has(item.progressStatus as LiveTimetableProgressStatus) ||
      !isNullablePosition(item.currentEntryPosition) ||
      !isNullablePosition(item.nextEntryPosition) ||
      !isNullablePosition(item.nextPerformancePosition) ||
      !isTimestamp(item.updatedAt) ||
      (internal && (
        normalizeUuid(item.stageId) === undefined ||
        !isNonEmptyString(item.sourceEventDayId) ||
        !isNonEmptyString(item.sourceStageId) ||
        typeof item.canOperate !== 'boolean'
      ))
    ) return undefined
    const sectionPositions = sections.map(section => section.position)
    const entryPositions = entries.map(entry => entry.position)
    const inProgressEntries = entries.filter(
      entry => entry.status === 'in_progress',
    )
    const pendingEntries = entries.filter(entry => entry.status === 'pending')
    const nextEntryPosition = pendingEntries.length > 0
      ? Math.min(...pendingEntries.map(entry => entry.position))
      : null
    const pendingPerformances = pendingEntries.filter(
      entry => entry.kind === 'performance',
    )
    const nextPerformancePosition = pendingPerformances.length > 0
      ? Math.min(...pendingPerformances.map(entry => entry.position))
      : null
    if (
      !hasUniqueBoundedPositions(sectionPositions) ||
      !hasUniqueBoundedPositions(entryPositions) ||
      item.nextEntryPosition !== nextEntryPosition ||
      item.nextPerformancePosition !== nextPerformancePosition ||
      (item.progressStatus === 'empty' && entries.length !== 0) ||
      (item.progressStatus !== 'empty' && entries.length === 0) ||
      (item.progressStatus === 'not_started' &&
        entries.some(entry => entry.status !== 'pending')) ||
      (item.progressStatus === 'waiting' &&
        (pendingEntries.length === 0 ||
          inProgressEntries.length !== 0 ||
          !entries.some(entry => entry.status === 'completed'))) ||
      (item.progressStatus === 'in_progress' && (
        inProgressEntries.length !== 1 ||
        item.currentEntryPosition !== inProgressEntries[0]?.position
      )) ||
      (item.progressStatus !== 'in_progress' &&
        (inProgressEntries.length !== 0 || item.currentEntryPosition !== null)) ||
      (item.progressStatus === 'completed' &&
        entries.some(entry => entry.status !== 'completed'))
    ) return undefined
    if (internal) {
      const sourceSectionIds = sections.map(section => section.sourceSectionId as string)
      if (new Set(sourceSectionIds).size !== sourceSectionIds.length ||
        entries.some(entry =>
          (entry.sourceSectionId !== null &&
            !sourceSectionIds.includes(entry.sourceSectionId ?? '')) ||
          (entry.afterSectionId !== null && (
            entry.kind !== 'break' ||
            !sourceSectionIds.includes(entry.afterSectionId ?? '')
          )) ||
          (entry.sourceSectionId !== null && entry.afterSectionId !== null)
        )) return undefined
    }
    stages.push({
      ...(internal ? {
        stageId: normalizeUuid(item.stageId) as string,
        sourceEventDayId: item.sourceEventDayId as string,
        sourceStageId: item.sourceStageId as string,
        canOperate: item.canOperate as boolean,
      } : {}),
      name: item.name,
      eventDayPosition: item.eventDayPosition,
      position: item.position,
      plannedStartTime: item.plannedStartTime,
      plannedEndTime: item.plannedEndTime,
      sections,
      revision: item.revision,
      projectionVersion: item.projectionVersion,
      progressStatus: item.progressStatus as LiveTimetableProgressStatus,
      currentEntryPosition: item.currentEntryPosition,
      nextEntryPosition: item.nextEntryPosition,
      nextPerformancePosition: item.nextPerformancePosition,
      updatedAt: item.updatedAt,
      entries,
    })
  }
  return stages
}

export const parseAuthorizedLiveTimetable = (
  value: unknown,
): AuthorizedLiveTimetable | undefined => {
  if (!isRecord(value) || value.status !== 'ok' || !isRecord(value.live) ||
    !hasOnlyKeys(value, ['status', 'live', 'permissions', 'operators', 'stages']) ||
    !isRecord(value.permissions) || !Array.isArray(value.operators)) return undefined
  const live = value.live
  const permissions = value.permissions
  const stages = parseStages(value.stages, true)
  if (
    !stages ||
    !hasOnlyKeys(live, [
      'liveId', 'publicId', 'workspaceId', 'eventId', 'eventName',
      'timeZone', 'eventDays', 'sourceRevision',
      'sourceSnapshotFingerprint', 'projectionVersion',
      'managementRevision', 'isPublished', 'createdAt', 'updatedAt',
    ]) ||
    !hasOnlyKeys(permissions, ['role', 'canManage']) ||
    normalizeUuid(live.liveId) === undefined ||
    normalizeUuid(live.publicId) === undefined ||
    normalizeUuid(live.workspaceId) === undefined ||
    !isNonEmptyString(live.eventId) ||
    !isNonEmptyString(live.eventName) ||
    !isNonEmptyString(live.timeZone) ||
    !Array.isArray(live.eventDays) ||
    !Number.isSafeInteger(live.sourceRevision) || Number(live.sourceRevision) <= 0 ||
    typeof live.sourceSnapshotFingerprint !== 'string' ||
    !fingerprintPattern.test(live.sourceSnapshotFingerprint) ||
    !isPositiveRevision(live.projectionVersion) ||
    !isPositiveRevision(live.managementRevision) ||
    typeof live.isPublished !== 'boolean' ||
    !isTimestamp(live.createdAt) || !isTimestamp(live.updatedAt) ||
    !['owner', 'editor', 'viewer'].includes(String(permissions.role)) ||
    typeof permissions.canManage !== 'boolean' ||
    permissions.canManage !== (permissions.role === 'owner')
  ) return undefined

  const eventDays: AuthorizedLiveTimetable['eventDays'] = []
  for (const day of live.eventDays) {
    if (!isRecord(day) || !hasOnlyKeys(day, [
      'sourceEventDayId', 'date', 'label', 'position',
    ]) || !isNonEmptyString(day.sourceEventDayId) ||
      typeof day.date !== 'string' || !localDatePattern.test(day.date) ||
      (day.label !== null && !isNonEmptyString(day.label)) ||
      !isPosition(day.position)) return undefined
    eventDays.push({
      sourceEventDayId: day.sourceEventDayId,
      date: day.date,
      label: day.label,
      position: day.position,
    })
  }
  const eventDayPositions = eventDays.map(day => day.position)
  const eventDayIds = eventDays.map(day => day.sourceEventDayId)
  const stageIds = stages.map(stage => stage.stageId as string)
  const sourceStageIds = stages.map(stage => stage.sourceStageId as string)
  const stagePositions = stages.map(stage => stage.position)
  const sourceSectionIds = stages.flatMap(stage =>
    stage.sections.map(section => section.sourceSectionId as string))
  const sourceScheduleItemIds = stages.flatMap(stage =>
    stage.entries.map(entry => entry.sourceScheduleItemId as string))
  if (!hasUniqueBoundedPositions(eventDayPositions) ||
    new Set(eventDayIds).size !== eventDayIds.length ||
    !hasUniqueBoundedPositions(stagePositions) ||
    new Set(stageIds).size !== stageIds.length ||
    new Set(sourceStageIds).size !== sourceStageIds.length ||
    new Set(sourceSectionIds).size !== sourceSectionIds.length ||
    new Set(sourceScheduleItemIds).size !== sourceScheduleItemIds.length ||
    stages.some(stage => {
      const day = eventDays.find(candidate =>
        candidate.sourceEventDayId === stage.sourceEventDayId)
      return !day || day.position !== stage.eventDayPosition ||
        stage.projectionVersion !== live.projectionVersion
    })) return undefined
  const operators: AuthorizedLiveTimetable['operators'] = []
  const validStageIds = new Set(stageIds)
  const operatorKeys = new Set<string>()
  if (!permissions.canManage && value.operators.length !== 0) return undefined
  for (const operator of value.operators) {
    if (!isRecord(operator) ||
      !hasOnlyKeys(operator, ['stageId', 'userId', 'assignedAt']) ||
      normalizeUuid(operator.stageId) === undefined ||
      normalizeUuid(operator.userId) === undefined ||
      !isTimestamp(operator.assignedAt)) return undefined
    const stageId = normalizeUuid(operator.stageId) as string
    const userId = normalizeUuid(operator.userId) as string
    const operatorKey = `${stageId}:${userId}`
    if (!validStageIds.has(stageId) || operatorKeys.has(operatorKey)) return undefined
    operatorKeys.add(operatorKey)
    operators.push({
      stageId,
      userId,
      assignedAt: operator.assignedAt,
    })
  }

  return {
    liveId: normalizeUuid(live.liveId) as string,
    publicId: normalizeUuid(live.publicId) as string,
    workspaceId: normalizeUuid(live.workspaceId) as string,
    eventId: live.eventId,
    eventName: live.eventName,
    timeZone: live.timeZone,
    eventDays,
    sourceRevision: Number(live.sourceRevision),
    sourceSnapshotFingerprint: live.sourceSnapshotFingerprint,
    projectionVersion: live.projectionVersion,
    managementRevision: live.managementRevision,
    isPublished: live.isPublished,
    createdAt: live.createdAt,
    updatedAt: live.updatedAt,
    role: permissions.role as AuthorizedLiveTimetable['role'],
    canManage: permissions.canManage,
    operators,
    stages,
  }
}

export const parsePublicLiveTimetable = (
  value: unknown,
): PublicLiveTimetable | undefined => {
  if (!isRecord(value) || value.status !== 'ok' ||
    !hasOnlyKeys(value, ['status', 'live', 'stages']) ||
    !isRecord(value.live)) {
    return undefined
  }
  const live = value.live
  const stages = parseStages(value.stages, false)
  if (
    !stages ||
    !hasOnlyKeys(live, [
      'publicId', 'eventName', 'timeZone', 'projectionVersion',
      'managementRevision', 'eventDays',
    ]) ||
    normalizeUuid(live.publicId) === undefined ||
    !isNonEmptyString(live.eventName) ||
    !isNonEmptyString(live.timeZone) ||
    !isPositiveRevision(live.projectionVersion) ||
    !isPositiveRevision(live.managementRevision) ||
    !Array.isArray(live.eventDays)
  ) return undefined
  const eventDays: PublicLiveTimetable['eventDays'] = []
  for (const day of live.eventDays) {
    if (!isRecord(day) || !hasOnlyKeys(day, ['date', 'position']) ||
      typeof day.date !== 'string' || !localDatePattern.test(day.date) ||
      !isPosition(day.position)) {
      return undefined
    }
    eventDays.push({ date: day.date, position: day.position })
  }
  const eventDayPositions = eventDays.map(day => day.position)
  const stagePositions = stages.map(stage => stage.position)
  if (!hasUniqueBoundedPositions(eventDayPositions) ||
    !hasUniqueBoundedPositions(stagePositions) ||
    stages.some(stage =>
      !eventDayPositions.includes(stage.eventDayPosition) ||
      stage.projectionVersion !== live.projectionVersion)) return undefined
  return {
    publicId: normalizeUuid(live.publicId) as string,
    eventName: live.eventName,
    timeZone: live.timeZone,
    projectionVersion: live.projectionVersion,
    managementRevision: live.managementRevision,
    eventDays,
    stages,
  }
}

export const parseLiveTimetableDiscovery = (
  value: unknown,
  expectedWorkspaceId: string,
  expectedEventId: string,
): LiveTimetableDiscovery | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'status', 'workspaceId', 'eventId', 'eventName', 'sourceRevision', 'liveId',
  ]) || value.status !== 'ok' || value.workspaceId !== expectedWorkspaceId ||
    value.eventId !== expectedEventId || !isNonEmptyString(value.eventName) ||
    typeof value.sourceRevision !== 'number' ||
    !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 1 ||
    (value.liveId !== null && normalizeUuid(value.liveId) === undefined)) {
    return undefined
  }
  return {
    workspaceId: expectedWorkspaceId,
    eventId: expectedEventId,
    eventName: value.eventName,
    sourceRevision: value.sourceRevision,
    liveId: value.liveId === null ? null : normalizeUuid(value.liveId) as string,
  }
}

export const parseLiveTimetableOperatorCandidates = (
  value: unknown,
  expectedLiveId: string,
): LiveTimetableOperatorCandidate[] | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'status', 'liveId', 'candidates',
  ]) || value.status !== 'ok' || normalizeUuid(value.liveId) !== expectedLiveId ||
    !Array.isArray(value.candidates)) return undefined

  const candidates: LiveTimetableOperatorCandidate[] = []
  const userIds = new Set<string>()
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, [
      'userId', 'displayName',
    ])) return undefined
    const userId = normalizeUuid(candidate.userId)
    if (!userId || !isNonEmptyString(candidate.displayName) ||
      userIds.has(userId)) return undefined
    userIds.add(userId)
    candidates.push({ userId, displayName: candidate.displayName })
  }
  return candidates
}

const errorResult = (
  code: LiveTimetableRepositoryErrorCode,
  message: string,
): LiveTimetableRepositoryResult<never> => ({ ok: false, error: { code, message } })

const databaseFailure = (
  error: LiveTimetableDatabaseError,
): LiveTimetableRepositoryResult<never> => {
  switch (error.code) {
    case '42501':
    case 'ACCESS_DENIED':
      return errorResult('ACCESS_DENIED', 'Live TTへのアクセス権限がありません。')
    case 'AUTHENTICATION_REQUIRED':
      return errorResult('AUTHENTICATION_REQUIRED', '認証が必要です。')
    case 'CONFIGURATION_ERROR':
      return errorResult('CONFIGURATION_ERROR', 'Live TTのserver設定が不足しています。')
    case 'EVENT_NOT_FOUND':
      return errorResult('EVENT_NOT_FOUND', '元のCloud Eventが見つかりません。')
    case 'INVALID_SOURCE':
      return errorResult('INVALID_SOURCE', '投影元のCloud Eventを検証できません。')
    case 'PROJECTION_REPLACEMENT_FORBIDDEN':
      return errorResult(
        'PROJECTION_REPLACEMENT_FORBIDDEN',
        '進行開始後または公開中の投影は差し替えできません。',
      )
    case 'INVALID_RESPONSE':
      return errorResult('INVALID_RESPONSE', 'Live TTの応答を検証できません。')
    case 'P0002':
    case 'LIVE_NOT_FOUND':
      return errorResult('LIVE_NOT_FOUND', 'Live TTが見つかりません。')
    case '23505':
    case 'LIVE_ALREADY_EXISTS':
      return errorResult('LIVE_ALREADY_EXISTS', 'このEventのLive TTは既に存在します。')
    case '40001':
    case 'REVISION_CONFLICT':
      return errorResult('REVISION_CONFLICT', 'Live TTが他の端末で更新されています。')
    case '55000':
    case 'STATE_CONFLICT':
      return errorResult('STATE_CONFLICT', 'Live TTの現在状態ではこの操作を実行できません。')
    case 'LTT01':
    case 'OPERATOR_NOT_EDITOR':
    case 'OPERATOR_NOT_ELIGIBLE':
      return errorResult(
        'OPERATOR_NOT_ELIGIBLE',
        '割当先は現在のeditorまたはviewerである必要があります。',
      )
    case '22023':
      return errorResult('INVALID_ARGUMENT', 'Live TTの引数が正しくありません。')
    default:
      return errorResult('SUPABASE_ERROR', 'Live TTと通信できませんでした。')
  }
}

const discoveryDatabaseFailure = (
  error: LiveTimetableDatabaseError,
): LiveTimetableRepositoryResult<never> => error.code === 'P0002'
  ? errorResult(
    'EVENT_NOT_FOUND',
    'Cloudに保存されたEventが見つかりません。通常のイベント編集画面でCloudへ保存してから、Live TTを開いてください。',
  )
  : databaseFailure(error)

const isValidIdAndRevisions = (
  liveId: string,
  ...revisions: string[]
): boolean => normalizeUuid(liveId) !== undefined && revisions.every(isPositiveRevision)

const parseProjectionMutationResponse = (
  value: unknown,
  expected: {
    workspaceId: string
    eventId: string
    expectedSourceRevision: number
    mode: 'create' | 'replace'
  },
): unknown | undefined => isRecord(value) &&
  hasOnlyKeys(value, [
    'status', 'workspaceId', 'eventId', 'liveId', 'publicId',
    'sourceRevision', 'sourceSnapshotFingerprint', 'projectionVersion',
    'managementRevision', 'isPublished',
  ]) &&
  value.status === (expected.mode === 'create' ? 'created' : 'replaced') &&
  value.workspaceId === expected.workspaceId &&
  value.eventId === expected.eventId &&
  normalizeUuid(value.liveId) !== undefined &&
  normalizeUuid(value.publicId) !== undefined &&
  value.sourceRevision === expected.expectedSourceRevision &&
  typeof value.sourceSnapshotFingerprint === 'string' &&
  fingerprintPattern.test(value.sourceSnapshotFingerprint) &&
  isPositiveRevision(value.projectionVersion) &&
  isPositiveRevision(value.managementRevision) &&
  value.isPublished === false
  ? value
  : undefined

const parsePublicationMutationResponse = (
  value: unknown,
  liveId: string,
  published: boolean,
): unknown | undefined => isRecord(value) &&
  hasOnlyKeys(value, [
    'status', 'liveId', 'projectionVersion', 'managementRevision',
    'isPublished',
  ]) &&
  value.status === 'ok' && normalizeUuid(value.liveId) === liveId &&
  isPositiveRevision(value.projectionVersion) &&
  isPositiveRevision(value.managementRevision) &&
  value.isPublished === published
  ? value
  : undefined

const parseOperatorMutationResponse = (
  value: unknown,
  liveId: string,
  expectedStageId: string,
  operatorUserId: string,
  assigned: boolean,
  expectedManagementRevision: string,
  expectedProjectionVersion: string,
): unknown | undefined => isRecord(value) &&
  hasOnlyKeys(value, [
    'status', 'liveId', 'stageId', 'operatorUserId', 'assigned',
    'projectionVersion', 'managementRevision',
  ]) &&
  value.status === 'ok' && normalizeUuid(value.liveId) === liveId &&
  normalizeUuid(value.stageId) === expectedStageId &&
  normalizeUuid(value.operatorUserId) === operatorUserId &&
  value.assigned === assigned &&
  value.projectionVersion === expectedProjectionVersion &&
  value.managementRevision ===
    (BigInt(expectedManagementRevision) + 1n).toString()
  ? value
  : undefined

const parseTransitionMutationResponse = (
  value: unknown,
  operation: 'start' | 'end',
  liveId: string,
  expectedStageId: string,
  expectedEntryPosition: number,
  expectedStageRevision: string,
  expectedProjectionVersion: string,
): unknown | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'status', 'operation', 'liveId', 'stageId', 'projectionVersion',
    'stageRevision', 'progressStatus', 'currentEntryPosition',
    'nextEntryPosition', 'nextPerformancePosition', 'entry',
  ]) || value.status !== 'ok' || value.operation !== operation ||
    normalizeUuid(value.liveId) !== liveId ||
    normalizeUuid(value.stageId) !== expectedStageId ||
    value.projectionVersion !== expectedProjectionVersion ||
    value.stageRevision !== (BigInt(expectedStageRevision) + 1n).toString() ||
    !progressStatuses.has(value.progressStatus as LiveTimetableProgressStatus) ||
    !isNullablePosition(value.currentEntryPosition) ||
    !isNullablePosition(value.nextEntryPosition) ||
    !isNullablePosition(value.nextPerformancePosition) ||
    !isRecord(value.entry) || !hasOnlyKeys(value.entry, [
      'position', 'status', 'actualStartedAt', 'actualEndedAt',
    ]) || value.entry.position !== expectedEntryPosition ||
    !['in_progress', 'completed'].includes(String(value.entry.status)) ||
    !isNullableString(value.entry.actualStartedAt) ||
    !isNullableString(value.entry.actualEndedAt) ||
    !isTimestamp(value.entry.actualStartedAt) ||
    (value.entry.actualEndedAt !== null &&
      !isTimestamp(value.entry.actualEndedAt)) ||
    (operation === 'start' && (
      value.entry.status !== 'in_progress' ||
      value.entry.actualEndedAt !== null ||
      value.progressStatus !== 'in_progress' ||
      value.currentEntryPosition !== value.entry.position
    )) ||
    (operation === 'end' && (
      value.entry.status !== 'completed' ||
      value.entry.actualEndedAt === null ||
      value.currentEntryPosition !== null ||
      Date.parse(value.entry.actualEndedAt) <
        Date.parse(value.entry.actualStartedAt)
    ))) return undefined
  return value
}

export const createLiveTimetableRepository = (
  gateway: LiveTimetableDatabaseGateway,
): LiveTimetableRepository => ({
  async createProjection(input) {
    if (!normalizeUuid(input.workspaceId) || !isNonEmptyString(input.eventId) ||
      !Number.isSafeInteger(input.expectedSourceRevision) ||
      input.expectedSourceRevision <= 0 ||
      (input.mode !== 'create' && input.mode !== 'replace') ||
      (input.mode === 'create' && input.expectedManagementRevision !== null) ||
      (input.mode === 'replace' &&
        !isPositiveRevision(input.expectedManagementRevision))) {
      return errorResult('INVALID_ARGUMENT', '投影作成の引数が正しくありません。')
    }
    try {
      const result = await gateway.createProjection({
        ...input,
        workspaceId: normalizeUuid(input.workspaceId) as string,
      })
      if (result.error) return databaseFailure(result.error)
      const parsed = parseProjectionMutationResponse(result.data, {
        workspaceId: normalizeUuid(input.workspaceId) as string,
        eventId: input.eventId,
        expectedSourceRevision: input.expectedSourceRevision,
        mode: input.mode,
      })
      return parsed
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', '投影作成結果を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async loadAuthorized(liveId, signal) {
    const normalized = normalizeUuid(liveId)
    if (!normalized) return errorResult('INVALID_ARGUMENT', 'Live IDが正しくありません。')
    try {
      const result = await gateway.loadAuthorized(normalized, signal)
      if (result.error) return databaseFailure(result.error)
      const parsed = parseAuthorizedLiveTimetable(result.data)
      return parsed?.liveId === normalized
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', 'Live TT応答を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async loadPublic(publicId) {
    const normalized = normalizeUuid(publicId)
    if (!normalized) return errorResult('INVALID_ARGUMENT', '公開IDが正しくありません。')
    try {
      const result = await gateway.loadPublic(normalized)
      if (result.error) return databaseFailure(result.error)
      if (result.data === null) {
        return errorResult('NOT_FOUND', '公開中のLive TTが見つかりません。')
      }
      const parsed = parsePublicLiveTimetable(result.data)
      return parsed?.publicId === normalized
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', '公開Live TT応答を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async findForEvent(workspaceId, eventId, signal) {
    const normalizedWorkspaceId = normalizeUuid(workspaceId)
    if (!normalizedWorkspaceId || !isNonEmptyString(eventId)) {
      return errorResult('INVALID_ARGUMENT', 'Workspace IDとEvent IDが必要です。')
    }
    try {
      const result = await gateway.findForEvent({
        workspaceId: normalizedWorkspaceId,
        eventId,
      }, signal)
      if (result.error) return discoveryDatabaseFailure(result.error)
      const parsed = parseLiveTimetableDiscovery(
        result.data,
        normalizedWorkspaceId,
        eventId,
      )
      return parsed
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', 'Live TT discovery応答を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async listOperatorCandidates(liveId, signal) {
    const normalizedLiveId = normalizeUuid(liveId)
    if (!normalizedLiveId) {
      return errorResult('INVALID_ARGUMENT', 'Live IDが正しくありません。')
    }
    try {
      const result = await gateway.listOperatorCandidates(normalizedLiveId, signal)
      if (result.error) return databaseFailure(result.error)
      const parsed = parseLiveTimetableOperatorCandidates(
        result.data,
        normalizedLiveId,
      )
      return parsed
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', 'operator候補応答を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async setPublication(liveId, expectedManagementRevision, published) {
    if (!isValidIdAndRevisions(liveId, expectedManagementRevision) ||
      typeof published !== 'boolean') {
      return errorResult('INVALID_ARGUMENT', '公開状態変更の引数が正しくありません。')
    }
    try {
      const result = await gateway.setPublication({
        liveId: normalizeUuid(liveId) as string,
        expectedManagementRevision,
        published,
      })
      if (result.error) return databaseFailure(result.error)
      const parsed = parsePublicationMutationResponse(
        result.data,
        normalizeUuid(liveId) as string,
        published,
      )
      return parsed
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', '公開状態変更結果を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async setStageOperator(
    liveId,
    sourceStageId,
    expectedStageId,
    operatorUserId,
    assign,
    expectedManagementRevision,
    expectedProjectionVersion,
  ) {
    if (!isValidIdAndRevisions(
      liveId, expectedManagementRevision, expectedProjectionVersion,
    ) || !isNonEmptyString(sourceStageId) || !normalizeUuid(expectedStageId) ||
      !normalizeUuid(operatorUserId) ||
      typeof assign !== 'boolean') {
      return errorResult('INVALID_ARGUMENT', 'operator割当の引数が正しくありません。')
    }
    try {
      const result = await gateway.setStageOperator({
        liveId: normalizeUuid(liveId) as string,
        sourceStageId,
        operatorUserId: normalizeUuid(operatorUserId) as string,
        assign,
        expectedManagementRevision,
        expectedProjectionVersion,
      })
      if (result.error) return databaseFailure(result.error)
      const parsed = parseOperatorMutationResponse(
        result.data,
        normalizeUuid(liveId) as string,
        normalizeUuid(expectedStageId) as string,
        normalizeUuid(operatorUserId) as string,
        assign,
        expectedManagementRevision,
        expectedProjectionVersion,
      )
      return parsed
        ? { ok: true, value: parsed }
        : errorResult('INVALID_RESPONSE', 'operator割当結果を検証できません。')
    } catch {
      return databaseFailure({})
    }
  },

  async startEntry(
    liveId, sourceStageId, expectedStageId, sourceScheduleItemId,
    expectedEntryPosition,
    expectedStageRevision, expectedProjectionVersion,
  ) {
    return transition(
      gateway, 'start', liveId, sourceStageId, expectedStageId,
      sourceScheduleItemId, expectedEntryPosition,
      expectedStageRevision, expectedProjectionVersion,
    )
  },

  async endEntry(
    liveId, sourceStageId, expectedStageId, sourceScheduleItemId,
    expectedEntryPosition,
    expectedStageRevision, expectedProjectionVersion,
  ) {
    return transition(
      gateway, 'end', liveId, sourceStageId, expectedStageId,
      sourceScheduleItemId, expectedEntryPosition,
      expectedStageRevision, expectedProjectionVersion,
    )
  },
})

const transition = async (
  gateway: LiveTimetableDatabaseGateway,
  operation: 'start' | 'end',
  liveId: string,
  sourceStageId: string,
  expectedStageId: string,
  sourceScheduleItemId: string,
  expectedEntryPosition: number,
  expectedStageRevision: string,
  expectedProjectionVersion: string,
): Promise<LiveTimetableRepositoryResult<unknown>> => {
  if (!isValidIdAndRevisions(
    liveId, expectedStageRevision, expectedProjectionVersion,
  ) || !isNonEmptyString(sourceStageId) || !normalizeUuid(expectedStageId) ||
    !isPosition(expectedEntryPosition) ||
    !isNonEmptyString(sourceScheduleItemId)) {
    return errorResult('INVALID_ARGUMENT', '進行操作の引数が正しくありません。')
  }
  try {
    const result = await gateway.transitionEntry({
      operation,
      liveId: normalizeUuid(liveId) as string,
      sourceStageId,
      sourceScheduleItemId,
      expectedStageRevision,
      expectedProjectionVersion,
    })
    if (result.error) return databaseFailure(result.error)
    const parsed = parseTransitionMutationResponse(
      result.data,
      operation,
      normalizeUuid(liveId) as string,
      normalizeUuid(expectedStageId) as string,
      expectedEntryPosition,
      expectedStageRevision,
      expectedProjectionVersion,
    )
    return parsed
      ? { ok: true, value: parsed }
      : errorResult('INVALID_RESPONSE', '進行操作の結果を検証できません。')
  } catch {
    return databaseFailure({})
  }
}

const parseFunctionError = async (error: unknown): Promise<LiveTimetableDatabaseError> => {
  if (!isRecord(error)) return {}
  const context = error.context
  if (context && typeof (context as { json?: unknown }).json === 'function') {
    try {
      const payload: unknown = await (context as { json: () => Promise<unknown> }).json()
      if (isRecord(payload) && payload.status === 'error' &&
        isRecord(payload.error) && typeof payload.error.code === 'string') {
        return { code: payload.error.code }
      }
    } catch {
      return {}
    }
  }
  return {}
}

export const createSupabaseLiveTimetableGateway = (
  client: SupabaseClient,
): LiveTimetableDatabaseGateway => ({
  async createProjection(input) {
    const result = await client.functions.invoke('create-live-timetable', {
      body: input,
    })
    return result.error
      ? { data: null, error: await parseFunctionError(result.error) }
      : { data: result.data, error: null }
  },
  async loadAuthorized(liveId, signal) {
    const request = client.rpc('load_live_timetable_authorized', {
      p_live_id: liveId,
    })
    const result = signal
      ? await request.abortSignal(signal)
      : await request
    return { data: result.data, error: result.error }
  },
  async loadPublic(publicId) {
    const result = await client.rpc('load_live_timetable_public', {
      p_public_id: publicId,
    })
    return { data: result.data, error: result.error }
  },
  async findForEvent(input, signal) {
    const request = client.rpc('find_live_timetable_for_event_authorized', {
      p_workspace_id: input.workspaceId,
      p_event_id: input.eventId,
    })
    const result = signal
      ? await request.abortSignal(signal)
      : await request
    return { data: result.data, error: result.error }
  },
  async listOperatorCandidates(liveId, signal) {
    const request = client.rpc('list_live_timetable_operator_candidates', {
      p_live_id: liveId,
    })
    const result = signal
      ? await request.abortSignal(signal)
      : await request
    return { data: result.data, error: result.error }
  },
  async setPublication(input) {
    const result = await client.rpc('set_live_timetable_publication', {
      p_live_id: input.liveId,
      p_expected_management_revision: input.expectedManagementRevision,
      p_published: input.published,
    })
    return { data: result.data, error: result.error }
  },
  async setStageOperator(input) {
    const result = await client.rpc('set_live_timetable_stage_operator', {
      p_live_id: input.liveId,
      p_source_stage_id: input.sourceStageId,
      p_operator_user_id: input.operatorUserId,
      p_assign: input.assign,
      p_expected_management_revision: input.expectedManagementRevision,
      p_expected_projection_version: input.expectedProjectionVersion,
    })
    return { data: result.data, error: result.error }
  },
  async transitionEntry(input) {
    const functionName = input.operation === 'start'
      ? 'start_live_timetable_entry'
      : 'end_live_timetable_entry'
    const result = await client.rpc(functionName, {
      p_live_id: input.liveId,
      p_source_stage_id: input.sourceStageId,
      p_source_schedule_item_id: input.sourceScheduleItemId,
      p_expected_stage_revision: input.expectedStageRevision,
      p_expected_projection_version: input.expectedProjectionVersion,
    })
    return { data: result.data, error: result.error }
  },
})

export const createSupabaseLiveTimetableRepository = (
  client: SupabaseClient,
): LiveTimetableRepository => createLiveTimetableRepository(
  createSupabaseLiveTimetableGateway(client),
)
