import type {
  Band,
  DutyAssignment,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  FixedPlacement,
  FixedPosition,
  Member,
  PaAssignment,
  PaCapabilities,
  ScheduleBoundary,
  ScheduleItem,
  Section,
  Stage,
  TimeRange,
} from '../domain/models'
import { isValidLocalDate } from '../domain/eventCreation.ts'
import { getTimeRangeValidationError } from '../domain/eventMemberDayDetails.ts'
import { isValidStageTimeRange } from '../domain/eventStageSettings.ts'
import { isValidLocalTime } from '../domain/timeline.ts'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0
const isLocalTime = (value: unknown): value is string =>
  isString(value) && isValidLocalTime(value)
const isLocalDate = (value: unknown): value is string =>
  isString(value) && isValidLocalDate(value)
const isOptional = <T>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T,
): value is T | undefined => value === undefined || validator(value)
const isArrayOf = <T>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T,
): value is T[] => Array.isArray(value) && value.every(validator)
const isStringArray = (value: unknown): value is string[] =>
  isArrayOf(value, isString)
const isPositiveIntegerArray = (value: unknown): value is number[] =>
  isArrayOf(value, isPositiveInteger)

const isPaCapabilities = (value: unknown): value is PaCapabilities =>
  isRecord(value) && isBoolean(value.main) && isBoolean(value.sub)

const isTimeRange = (value: unknown): value is TimeRange =>
  isRecord(value) &&
  isOptional(value.from, isLocalTime) &&
  isOptional(value.until, isLocalTime) &&
  getTimeRangeValidationError(value) === undefined

const isFixedPosition = (value: unknown): value is FixedPosition =>
  isRecord(value) && (
    value.kind === 'first' ||
    value.kind === 'last' ||
    (value.kind === 'index' && isNonNegativeInteger(value.index))
  )

const isFixedPlacement = (value: unknown): value is FixedPlacement =>
  isRecord(value) &&
  isString(value.stageId) &&
  isOptional(value.sectionId, isString) &&
  isOptional(value.position, isFixedPosition) &&
  isOptional(value.plannedStartTime, isLocalTime)

const isScheduleBoundary = (value: unknown): value is ScheduleBoundary =>
  isRecord(value) &&
  isString(value.scheduleItemId) &&
  (value.edge === 'start' || value.edge === 'end')

export const isMember = (value: unknown): value is Member =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.realName) &&
  isOptional(value.acaName, isString) &&
  isOptional(value.entryAcademicYear, isPositiveInteger) &&
  isOptional(value.notes, isString) &&
  isBoolean(value.active) &&
  isOptional(value.paCapabilities, isPaCapabilities)

export const isBand = (value: unknown): value is Band =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isStringArray(value.defaultMemberIds) &&
  isOptional(value.notes, isString) &&
  isBoolean(value.active)

export const isEvent = (value: unknown): value is Event =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isOptional(value.description, isString) &&
  isString(value.timeZone) &&
  isNonNegativeInteger(value.defaultTransitionMinutes) &&
  isRecord(value.validationPolicy) &&
  isNonNegativeInteger(value.validationPolicy.minimumGapBands) &&
  isNonNegativeInteger(value.validationPolicy.minimumRestMinutes) &&
  isPositiveIntegerArray(value.performanceSlotMinutes) &&
  isOptional(value.notes, isString)

export const isEventDay = (value: unknown): value is EventDay =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventId) &&
  isLocalDate(value.date) &&
  isOptional(value.label, isString) &&
  isNonNegativeInteger(value.order)

export const isStage = (value: unknown): value is Stage =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventDayId) &&
  isString(value.name) &&
  isOptional(value.location, isString) &&
  isNonNegativeInteger(value.order) &&
  isLocalTime(value.plannedStartTime) &&
  isOptional(value.plannedEndTime, isLocalTime) &&
  isValidStageTimeRange(value.plannedStartTime, value.plannedEndTime) &&
  isOptional(value.transitionMinutes, isNonNegativeInteger) &&
  isOptional(value.notes, isString)

export const isSection = (value: unknown): value is Section =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.stageId) &&
  isString(value.name) &&
  isNonNegativeInteger(value.order) &&
  isOptional(value.plannedStartTime, isLocalTime) &&
  isOptional(value.plannedEndTime, isLocalTime) &&
  (value.plannedStartTime === undefined || value.plannedEndTime === undefined ||
    isValidStageTimeRange(value.plannedStartTime, value.plannedEndTime)) &&
  isOptional(value.notes, isString)

export const isEventMember = (value: unknown): value is EventMember =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventId) &&
  isString(value.memberId) &&
  isOptional(value.notes, isString)

export const isEventMemberDay = (value: unknown): value is EventMemberDay =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventMemberId) &&
  isString(value.eventDayId) &&
  (value.participationStatus === 'participating' ||
    value.participationStatus === 'absent' ||
    value.participationStatus === 'undecided') &&
  isOptional(value.availabilityWindows, (candidate): candidate is TimeRange[] =>
    isArrayOf(candidate, isTimeRange)) &&
  isOptional(value.preferredTimeRange, isTimeRange) &&
  isOptional(value.notes, isString)

export const isEventBand = (value: unknown): value is EventBand =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventId) &&
  isString(value.eventDayId) &&
  isOptional(value.bandId, isString) &&
  isString(value.name) &&
  isStringArray(value.memberIds) &&
  isPositiveInteger(value.durationMinutes) &&
  isOptional(value.availableTimeRange, isTimeRange) &&
  isOptional(value.preferredTimeRange, isTimeRange) &&
  isOptional(value.fixedPlacement, isFixedPlacement) &&
  isOptional(value.notes, isString)

export const isScheduleItem = (value: unknown): value is ScheduleItem =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.stageId) &&
  isOptional(value.sectionId, isString) &&
  isNonNegativeInteger(value.order) && (
    (value.kind === 'performance' && isString(value.eventBandId)) ||
    (value.kind === 'break' &&
      isString(value.title) &&
      isPositiveInteger(value.durationMinutes))
  )

export const isPaAssignment = (value: unknown): value is PaAssignment =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventId) &&
  isString(value.eventDayId) &&
  isString(value.stageId) &&
  isString(value.memberId) &&
  (value.role === 'main' || value.role === 'sub') &&
  isScheduleBoundary(value.from) &&
  isScheduleBoundary(value.until)

export const isDutyType = (value: unknown): value is DutyType =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.eventId) &&
  isString(value.name) &&
  isNonNegativeInteger(value.order)

export const isDutyAssignment = (value: unknown): value is DutyAssignment =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.dutyTypeId) &&
  isString(value.eventDayId) &&
  isString(value.stageId) &&
  isString(value.memberId) &&
  isScheduleBoundary(value.from) &&
  isScheduleBoundary(value.until)

export const isPersistedCollection = isArrayOf
