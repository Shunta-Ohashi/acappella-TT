import type {
  EventMemberDaySettingsDraft,
} from './eventMemberSettings'
import type { TimeRange } from './models'
import {
  formatMinuteAsLocalTime,
  isValidLocalTime,
  parseLocalTimeToMinute,
} from './timeline.ts'

export type AvailabilityInputMode = 'all-day' | 'available' | 'unavailable'
export type PreferredTimeInputMode = 'none' | 'specified'

export interface EditableTimeRange {
  from: string
  until: string
}

export interface EventMemberDayDetailsDraft {
  availabilityMode: AvailabilityInputMode
  availabilityRanges: EditableTimeRange[]
  preferredTimeMode: PreferredTimeInputMode
  preferredTimeRange: EditableTimeRange
  notes: string
}

export interface EventMemberDayDetailsValidationErrors {
  availability?: string
  preferredTimeRange?: string
}

export type ApplyEventMemberDayDetailsResult =
  | { ok: true; day: EventMemberDaySettingsDraft }
  | { ok: false; errors: EventMemberDayDetailsValidationErrors }

export interface EventMemberDayConditionSummary {
  availabilityLabel: string
  hasDetails: boolean
  supplementaryLabel?: string
}

interface MinuteRange {
  start: number
  end: number
}

const MINUTES_PER_DAY = 24 * 60

const toEditableTimeRange = (range: TimeRange): EditableTimeRange => ({
  from: range.from ?? '',
  until: range.until ?? '',
})

const toMinuteRange = (range: TimeRange): MinuteRange => ({
  start: range.from ? parseLocalTimeToMinute(range.from.trim()) : 0,
  end: range.until
    ? parseLocalTimeToMinute(range.until.trim())
    : MINUTES_PER_DAY,
})

const fromMinuteRange = ({ start, end }: MinuteRange): TimeRange => {
  if (start === 0 && end === MINUTES_PER_DAY) {
    return { from: '00:00' }
  }
  if (start === 0) return { until: formatMinuteAsLocalTime(end) }
  if (end === MINUTES_PER_DAY) {
    return { from: formatMinuteAsLocalTime(start) }
  }
  return {
    from: formatMinuteAsLocalTime(start),
    until: formatMinuteAsLocalTime(end),
  }
}

const createTimeRange = (range: EditableTimeRange): TimeRange => {
  const from = range.from.trim()
  const until = range.until.trim()

  if (from && until) return { from, until }
  if (from) return { from }
  if (until) return { until }
  throw new RangeError('TimeRange requires at least one boundary')
}

export const normalizeTimeRange = (range: TimeRange): TimeRange =>
  createTimeRange(toEditableTimeRange(range))

export const getTimeRangeValidationError = (
  range: { from?: string; until?: string },
): string | undefined => {
  const from = range.from?.trim() ?? ''
  const until = range.until?.trim() ?? ''

  if (!from && !until) {
    return '開始時刻または終了時刻を入力してください。'
  }
  if (from && !isValidLocalTime(from)) {
    return '開始時刻が正しくありません。'
  }
  if (until && !isValidLocalTime(until)) {
    return '終了時刻が正しくありません。'
  }
  if (
    from &&
    until &&
    parseLocalTimeToMinute(from) >= parseLocalTimeToMinute(until)
  ) {
    return '開始時刻は終了時刻より前にしてください。'
  }

  return undefined
}

export const validateAvailabilityWindows = (
  availabilityWindows: TimeRange[] | undefined,
): string | undefined => {
  if (availabilityWindows === undefined) return undefined

  for (let index = 0; index < availabilityWindows.length; index += 1) {
    const error = getTimeRangeValidationError(availabilityWindows[index])
    if (error) return `参加可能時間 ${index + 1}: ${error}`
  }

  return undefined
}

export const validatePreferredTimeRange = (
  preferredTimeRange: TimeRange | undefined,
): string | undefined => preferredTimeRange
  ? getTimeRangeValidationError(preferredTimeRange)
  : undefined

export const normalizeTimeRanges = (ranges: TimeRange[]): TimeRange[] => {
  if (ranges.length === 0) return []

  const orderedRanges = ranges
    .map(toMinuteRange)
    .sort((first, second) => first.start - second.start || first.end - second.end)
  const mergedRanges: MinuteRange[] = []

  orderedRanges.forEach((range) => {
    const previous = mergedRanges.at(-1)
    if (!previous || range.start > previous.end) {
      mergedRanges.push({ ...range })
      return
    }
    previous.end = Math.max(previous.end, range.end)
  })

  return mergedRanges.map(fromMinuteRange)
}

export const unavailableRangesToAvailabilityWindows = (
  unavailableRanges: TimeRange[],
): TimeRange[] | undefined => {
  if (unavailableRanges.length === 0) return undefined

  const normalizedUnavailableRanges = normalizeTimeRanges(unavailableRanges)
    .map(toMinuteRange)
  const availableRanges: MinuteRange[] = []
  let availableStart = 0

  normalizedUnavailableRanges.forEach((unavailableRange) => {
    if (availableStart < unavailableRange.start) {
      availableRanges.push({
        start: availableStart,
        end: unavailableRange.start,
      })
    }
    availableStart = Math.max(availableStart, unavailableRange.end)
  })

  if (availableStart < MINUTES_PER_DAY) {
    availableRanges.push({ start: availableStart, end: MINUTES_PER_DAY })
  }

  return availableRanges.map(fromMinuteRange)
}

export const createEventMemberDayDetailsDraft = (
  day: EventMemberDaySettingsDraft,
): EventMemberDayDetailsDraft => ({
  availabilityMode: day.availabilityWindows === undefined
    ? 'all-day'
    : 'available',
  availabilityRanges: day.availabilityWindows?.map(toEditableTimeRange) ?? [],
  preferredTimeMode: day.preferredTimeRange ? 'specified' : 'none',
  preferredTimeRange: day.preferredTimeRange
    ? toEditableTimeRange(day.preferredTimeRange)
    : { from: '', until: '' },
  notes: day.notes ?? '',
})

export const validateEventMemberDayDetailsDraft = (
  details: EventMemberDayDetailsDraft,
): EventMemberDayDetailsValidationErrors => {
  const errors: EventMemberDayDetailsValidationErrors = {}

  if (details.availabilityMode !== 'all-day') {
    for (let index = 0; index < details.availabilityRanges.length; index += 1) {
      const error = getTimeRangeValidationError(
        details.availabilityRanges[index],
      )
      if (error) {
        errors.availability = `${index + 1}件目: ${error}`
        break
      }
    }
  }

  if (details.preferredTimeMode === 'specified') {
    errors.preferredTimeRange = getTimeRangeValidationError(
      details.preferredTimeRange,
    )
  }

  return errors
}

export const applyEventMemberDayDetails = (
  day: EventMemberDaySettingsDraft,
  details: EventMemberDayDetailsDraft,
): ApplyEventMemberDayDetailsResult => {
  const errors = validateEventMemberDayDetailsDraft(details)
  if (errors.availability || errors.preferredTimeRange) {
    return { ok: false, errors }
  }

  const inputRanges = details.availabilityMode === 'all-day'
    ? []
    : details.availabilityRanges.map(createTimeRange)
  const availabilityWindows = details.availabilityMode === 'all-day'
    ? undefined
    : details.availabilityMode === 'unavailable'
      ? unavailableRangesToAvailabilityWindows(inputRanges)
      : normalizeTimeRanges(inputRanges)
  const preferredTimeRange = details.preferredTimeMode === 'specified'
    ? createTimeRange(details.preferredTimeRange)
    : undefined
  const notes = details.notes.trim() || undefined

  return {
    ok: true,
    day: {
      eventMemberDayId: day.eventMemberDayId,
      eventDayId: day.eventDayId,
      participationStatus: day.participationStatus,
      ...(availabilityWindows !== undefined ? { availabilityWindows } : {}),
      ...(preferredTimeRange ? { preferredTimeRange } : {}),
      ...(notes ? { notes } : {}),
    },
  }
}

const formatTimeRange = (range: TimeRange): string => {
  if (getTimeRangeValidationError(range)) return '条件を確認'
  if (range.from && range.until) return `${range.from}〜${range.until}`
  if (range.from) return `${range.from}以降`
  return `${range.until}まで`
}

export const getEventMemberDayConditionSummary = (
  day: EventMemberDaySettingsDraft,
): EventMemberDayConditionSummary => {
  let availabilityLabel = '終日'
  if (day.availabilityWindows !== undefined) {
    if (day.availabilityWindows.length === 0) {
      availabilityLabel = '参加可能時間なし'
    } else {
      availabilityLabel = formatTimeRange(day.availabilityWindows[0])
      if (day.availabilityWindows.length > 1) {
        availabilityLabel += ` 他${day.availabilityWindows.length - 1}件`
      }
    }
  }

  const supplementaryLabels = [
    day.preferredTimeRange ? '希望あり' : undefined,
    day.notes?.trim() ? 'メモあり' : undefined,
  ].filter((label): label is string => label !== undefined)

  return {
    availabilityLabel,
    hasDetails: day.availabilityWindows !== undefined ||
      day.preferredTimeRange !== undefined ||
      Boolean(day.notes?.trim()),
    ...(supplementaryLabels.length > 0
      ? { supplementaryLabel: supplementaryLabels.join(' / ') }
      : {}),
  }
}
