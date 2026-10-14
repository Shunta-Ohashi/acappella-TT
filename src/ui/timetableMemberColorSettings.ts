import type {
  EventBand,
  EventDayId,
  EventId,
  Member,
  MemberId,
} from '../domain/models'
import { getMemberDisplayName } from './eventBandPresentation.ts'

export const TIMETABLE_MEMBER_COLOR_SETTINGS_VERSION = 1

export interface TimetableMemberColor {
  id: string
  label: string
  background: string
  border: string
  text: string
}

export const TIMETABLE_MEMBER_COLOR_PALETTE = [
  { id: 'rose', label: 'ローズ', background: '#fde8ec', border: '#c94b68', text: '#641d31' },
  { id: 'coral', label: 'コーラル', background: '#ffe8e1', border: '#c65f43', text: '#652b1d' },
  { id: 'orange', label: 'オレンジ', background: '#ffecd8', border: '#c56a1f', text: '#62340f' },
  { id: 'amber', label: 'アンバー', background: '#fff1c9', border: '#b97808', text: '#5d3b02' },
  { id: 'yellow', label: 'イエロー', background: '#fff8c7', border: '#9b7a00', text: '#514000' },
  { id: 'lime', label: 'ライム', background: '#eff8cf', border: '#769928', text: '#3b4e12' },
  { id: 'green', label: 'グリーン', background: '#dff4df', border: '#438a4d', text: '#214827' },
  { id: 'mint', label: 'ミント', background: '#dff6ec', border: '#368b6b', text: '#1b4938' },
  { id: 'teal', label: 'ティール', background: '#daf3f1', border: '#2d8580', text: '#174542' },
  { id: 'cyan', label: 'シアン', background: '#ddf4f8', border: '#33869a', text: '#184754' },
  { id: 'sky', label: 'スカイ', background: '#e1f1fb', border: '#3c83af', text: '#1d455f' },
  { id: 'blue', label: 'ブルー', background: '#e3edfc', border: '#4c75b5', text: '#263d62' },
  { id: 'indigo', label: 'インディゴ', background: '#e9e9fb', border: '#6669ad', text: '#34355e' },
  { id: 'violet', label: 'バイオレット', background: '#efe7fb', border: '#805dac', text: '#432e5d' },
  { id: 'purple', label: 'パープル', background: '#f3e5f7', border: '#9257a3', text: '#4b2955' },
  { id: 'magenta', label: 'マゼンタ', background: '#f9e4f2', border: '#aa4e88', text: '#592646' },
  { id: 'pink', label: 'ピンク', background: '#fde6f0', border: '#bd527e', text: '#61283f' },
  { id: 'brown', label: 'ブラウン', background: '#eee7df', border: '#8b6849', text: '#473526' },
  { id: 'slate', label: 'スレート', background: '#e9edf2', border: '#68788b', text: '#35404d' },
  { id: 'navy', label: 'ネイビー', background: '#e5ebf4', border: '#4b6688', text: '#27374b' },
  { id: 'olive', label: 'オリーブ', background: '#eef0d9', border: '#7d843f', text: '#41451f' },
  { id: 'aqua', label: 'アクア', background: '#dcf5f4', border: '#318e8b', text: '#194a48' },
  { id: 'lavender', label: 'ラベンダー', background: '#eee9fa', border: '#7564ad', text: '#3d345d' },
  { id: 'salmon', label: 'サーモン', background: '#fae8e3', border: '#b76550', text: '#5d3328' },
] as const satisfies readonly TimetableMemberColor[]

const paletteById: ReadonlyMap<string, TimetableMemberColor> = new Map(
  TIMETABLE_MEMBER_COLOR_PALETTE.map(color => [color.id, color]),
)

export interface TimetableMemberColorAssignment {
  memberId: MemberId
  colorId: string
}

export interface TimetableMemberColorCandidate {
  memberId: MemberId
  displayName: string
  eventBandCount: number
  selectedEventDayBandCount: number
}

interface TimetableMemberColorStorageValue {
  version: typeof TIMETABLE_MEMBER_COLOR_SETTINGS_VERSION
  assignments: TimetableMemberColorAssignment[]
}

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface TimetableMemberColorLoadResult {
  assignments: TimetableMemberColorAssignment[]
  warning?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getBrowserStorage = (): StorageLike | undefined => {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export const getTimetableMemberColor = (
  colorId: string,
): TimetableMemberColor | undefined => paletteById.get(colorId)

export const createTimetableMemberColorMap = (
  assignments: readonly TimetableMemberColorAssignment[],
): ReadonlyMap<MemberId, TimetableMemberColor> => {
  const colors = new Map<MemberId, TimetableMemberColor>()
  for (const assignment of assignments) {
    const color = getTimetableMemberColor(assignment.colorId)
    if (color) colors.set(assignment.memberId, color)
  }
  return colors
}

export const createTimetableMemberColorStorageKey = (
  persistenceScopeKey: string,
  eventId: EventId,
): string => `${persistenceScopeKey}:ui:timetable-member-colors:v1:${encodeURIComponent(eventId)}`

export const parseTimetableMemberColorStorageValue = (
  value: unknown,
): TimetableMemberColorAssignment[] | undefined => {
  if (
    !isRecord(value) ||
    value.version !== TIMETABLE_MEMBER_COLOR_SETTINGS_VERSION ||
    !Array.isArray(value.assignments)
  ) return undefined

  const seenMemberIds = new Set<string>()
  const assignments: TimetableMemberColorAssignment[] = []
  for (const assignment of value.assignments) {
    if (
      !isRecord(assignment) ||
      typeof assignment.memberId !== 'string' ||
      assignment.memberId.trim().length === 0 ||
      typeof assignment.colorId !== 'string' ||
      !paletteById.has(assignment.colorId) ||
      seenMemberIds.has(assignment.memberId)
    ) return undefined

    seenMemberIds.add(assignment.memberId)
    assignments.push({
      memberId: assignment.memberId,
      colorId: assignment.colorId,
    })
  }
  return assignments
}

export const loadTimetableMemberColorAssignments = (
  storageKey: string,
  storage: StorageLike | undefined = getBrowserStorage(),
): TimetableMemberColorLoadResult => {
  if (!storage || !storageKey) return { assignments: [] }
  try {
    const serialized = storage.getItem(storageKey)
    if (serialized === null) return { assignments: [] }
    const assignments = parseTimetableMemberColorStorageValue(
      JSON.parse(serialized) as unknown,
    )
    return assignments
      ? { assignments }
      : {
          assignments: [],
          warning: '保存済みのメンバー色設定が不正なため読み込みませんでした。',
        }
  } catch {
    return {
      assignments: [],
      warning: 'メンバー色設定を読み込めませんでした。現在の画面では新しい設定を利用できます。',
    }
  }
}

export const saveTimetableMemberColorAssignments = (
  storageKey: string,
  assignments: readonly TimetableMemberColorAssignment[],
  storage: StorageLike | undefined = getBrowserStorage(),
): boolean => {
  if (!storage || !storageKey) return false
  const parsed = parseTimetableMemberColorStorageValue({
    version: TIMETABLE_MEMBER_COLOR_SETTINGS_VERSION,
    assignments: [...assignments],
  } satisfies TimetableMemberColorStorageValue)
  if (!parsed) return false
  try {
    storage.setItem(storageKey, JSON.stringify({
      version: TIMETABLE_MEMBER_COLOR_SETTINGS_VERSION,
      assignments: parsed,
    } satisfies TimetableMemberColorStorageValue))
    return true
  } catch {
    return false
  }
}

export const filterTimetableMemberColorAssignments = (
  assignments: readonly TimetableMemberColorAssignment[],
  existingMemberIds: ReadonlySet<MemberId>,
): TimetableMemberColorAssignment[] => assignments.filter(
  assignment => existingMemberIds.has(assignment.memberId),
)

export const getNextAvailableTimetableMemberColorId = (
  assignments: readonly TimetableMemberColorAssignment[],
): string => {
  const usedColorIds = new Set(assignments.map(assignment => assignment.colorId))
  return TIMETABLE_MEMBER_COLOR_PALETTE.find(
    color => !usedColorIds.has(color.id),
  )?.id ?? TIMETABLE_MEMBER_COLOR_PALETTE[
    assignments.length % TIMETABLE_MEMBER_COLOR_PALETTE.length
  ].id
}

export const setTimetableMemberColorAssignment = (
  assignments: readonly TimetableMemberColorAssignment[],
  memberId: MemberId,
  colorId = getNextAvailableTimetableMemberColorId(assignments),
): TimetableMemberColorAssignment[] => {
  if (!paletteById.has(colorId)) return [...assignments]
  const existingIndex = assignments.findIndex(
    assignment => assignment.memberId === memberId,
  )
  if (existingIndex < 0) return [...assignments, { memberId, colorId }]
  return assignments.map((assignment, index) => index === existingIndex
    ? { memberId, colorId }
    : assignment)
}

export const removeTimetableMemberColorAssignment = (
  assignments: readonly TimetableMemberColorAssignment[],
  memberId: MemberId,
): TimetableMemberColorAssignment[] => assignments.filter(
  assignment => assignment.memberId !== memberId,
)

export const createTimetableMemberColorCandidates = ({
  members,
  eventBands,
  eventId,
  selectedEventDayId,
}: {
  members: readonly Member[]
  eventBands: readonly EventBand[]
  eventId: EventId
  selectedEventDayId?: EventDayId
}): TimetableMemberColorCandidate[] => {
  const eventBandIdsByMemberId = new Map<MemberId, Set<EventBand['id']>>()
  const dayBandIdsByMemberId = new Map<MemberId, Set<EventBand['id']>>()

  for (const eventBand of eventBands) {
    if (eventBand.eventId !== eventId) continue
    for (const memberId of new Set(eventBand.memberIds)) {
      const eventBandIds = eventBandIdsByMemberId.get(memberId) ?? new Set()
      eventBandIds.add(eventBand.id)
      eventBandIdsByMemberId.set(memberId, eventBandIds)
      if (selectedEventDayId && eventBand.eventDayId === selectedEventDayId) {
        const dayBandIds = dayBandIdsByMemberId.get(memberId) ?? new Set()
        dayBandIds.add(eventBand.id)
        dayBandIdsByMemberId.set(memberId, dayBandIds)
      }
    }
  }

  return members.flatMap((member): TimetableMemberColorCandidate[] => {
    const eventBandCount = eventBandIdsByMemberId.get(member.id)?.size ?? 0
    if (eventBandCount === 0) return []
    return [{
      memberId: member.id,
      displayName: getMemberDisplayName(member),
      eventBandCount,
      selectedEventDayBandCount: dayBandIdsByMemberId.get(member.id)?.size ?? 0,
    }]
  }).sort((first, second) =>
    second.eventBandCount - first.eventBandCount ||
    second.selectedEventDayBandCount - first.selectedEventDayBandCount ||
    first.memberId.localeCompare(second.memberId),
  )
}
