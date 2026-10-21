const LIVE_TIMETABLE_HASH_PREFIX = '#live='

export interface LiveTimetableRoute {
  kind: 'live'
  eventId: string
}

export const createLiveTimetableHash = (eventId: string): string =>
  `${LIVE_TIMETABLE_HASH_PREFIX}${encodeURIComponent(eventId)}`

export const resolveLiveTimetableHash = (
  hash: string,
): LiveTimetableRoute | undefined => {
  if (!hash.startsWith(LIVE_TIMETABLE_HASH_PREFIX)) return undefined
  const encoded = hash.slice(LIVE_TIMETABLE_HASH_PREFIX.length)
  if (!encoded || encoded.includes('&')) return undefined
  try {
    const eventId = decodeURIComponent(encoded)
    return eventId.trim().length > 0 ? { kind: 'live', eventId } : undefined
  } catch {
    return undefined
  }
}

export const shouldKeepCloudEditorMounted = (
  wasMounted: boolean,
  route: LiveTimetableRoute | undefined,
): boolean => wasMounted || route === undefined

export const createLocalAppReturnUrl = (
  pathname: string,
  search: string,
): string => `${pathname}${search}`

