const INVALID_LIVE_TIMESTAMP = '表示不可'

export const formatLiveTimetableTimestamp = (
  value: string | null,
  timeZone: string,
): string => {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return INVALID_LIVE_TIMESTAMP

  try {
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const byType = new Map(parts.map(part => [part.type, part.value]))
    const month = byType.get('month')
    const day = byType.get('day')
    const hour = byType.get('hour')
    const minute = byType.get('minute')
    const second = byType.get('second')
    return month && day && hour && minute && second
      ? `${month}/${day} ${hour}:${minute}:${second}`
      : INVALID_LIVE_TIMESTAMP
  } catch {
    return INVALID_LIVE_TIMESTAMP
  }
}
