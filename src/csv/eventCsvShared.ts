import type { Event, EventDay, EventDayId, TimeRange } from '../domain/models.ts'
import {
  normalizeAvailabilityWindows,
  normalizeTimeRange,
  validateAvailabilityWindows,
  validatePreferredTimeRange,
} from '../domain/eventMemberDayDetails.ts'

export const getOrderedEventDays = (event: Event, eventDays: EventDay[]): EventDay[] =>
  eventDays.filter((day) => day.eventId === event.id).sort((left, right) =>
    left.order - right.order || left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  )

export const resolveEventDayId = (
  event: Event,
  eventDays: EventDay[],
  idValue: string,
  dateValue: string,
): { ok: true; eventDayId: EventDayId } | { ok: false; message: string } => {
  const currentDays = eventDays.filter((day) => day.eventId === event.id)
  const id = idValue.trim()
  if (id) {
    return currentDays.some((day) => day.id === id)
      ? { ok: true, eventDayId: id }
      : { ok: false, message: `開催日ID「${id}」は現在のイベントに存在しません。` }
  }
  const date = dateValue.trim()
  const matches = currentDays.filter((day) => day.date === date)
  if (matches.length === 1) return { ok: true, eventDayId: matches[0].id }
  if (matches.length > 1) return { ok: false, message: `開催日「${date}」が複数あります。開催日IDを指定してください。` }
  return { ok: false, message: `開催日「${date}」が見つかりません。` }
}

const parseTimeRange = (value: string): TimeRange | undefined | string => {
  const normalized = value.trim()
  if (!normalized) return undefined
  const match = /^(\d{2}:\d{2})?-(\d{2}:\d{2})?$/.exec(normalized)
  if (!match || (!match[1] && !match[2])) return '「HH:mm-HH:mm」形式で入力してください。'
  const range: TimeRange = match[1]
    ? { from: match[1], ...(match[2] ? { until: match[2] } : {}) }
    : { until: match[2] as string }
  return range
}

export const parseAvailabilityCell = (
  value: string,
): { ok: true; value?: TimeRange[] } | { ok: false; message: string } => {
  const normalized = value.trim()
  if (!normalized) return { ok: true }
  if (normalized === 'なし' || normalized.toLowerCase() === 'none') {
    return { ok: true, value: [] }
  }
  const ranges: TimeRange[] = []
  for (const part of value.split('|')) {
    const range = parseTimeRange(part)
    if (typeof range === 'string' || !range) {
      return { ok: false, message: typeof range === 'string' ? range : '時間帯が空です。' }
    }
    ranges.push(range)
  }
  const validation = validateAvailabilityWindows(ranges)
  if (validation) return { ok: false, message: validation }
  return { ok: true, value: normalizeAvailabilityWindows(ranges) }
}

export const parsePreferredTimeRangeCell = (
  value: string,
): { ok: true; value?: TimeRange } | { ok: false; message: string } => {
  const range = parseTimeRange(value)
  if (typeof range === 'string') return { ok: false, message: range }
  if (!range) return { ok: true }
  const validation = validatePreferredTimeRange(range)
  if (validation) return { ok: false, message: validation }
  return { ok: true, value: normalizeTimeRange(range) }
}

export const formatTimeRange = (range: TimeRange): string =>
  `${range.from ?? ''}-${range.until ?? ''}`

