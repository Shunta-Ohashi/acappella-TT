export type MemberId = string
export type BandId = string
export type EventId = string
export type EventDayId = string
export type EventMemberId = string
export type EventMemberDayId = string
export type StageId = string
export type SectionId = string
export type EventBandId = string
export type ScheduleItemId = string

// Values are stored as ISO-like strings and validated at the input boundary.
export type LocalDate = string // YYYY-MM-DD
export type LocalTime = string // HH:mm

export type TimeRange =
  | { from: LocalTime; until?: LocalTime }
  | { from?: LocalTime; until: LocalTime }

export type ParticipationStatus = 'participating' | 'absent' | 'undecided'

export interface PaCapabilities {
  main: boolean
  sub: boolean
}

export type FixedPosition =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'index'; index: number }

export interface FixedPlacement {
  stageId: StageId
  sectionId?: SectionId
  position?: FixedPosition
  plannedStartTime?: LocalTime
}

export interface Member {
  id: MemberId
  realName: string
  acaName?: string
  entryAcademicYear?: number
  notes?: string
  active: boolean
  paCapabilities?: PaCapabilities
}

export interface Band {
  id: BandId
  name: string
  defaultMemberIds: MemberId[]
  notes?: string
  active: boolean
}

export interface Event {
  id: EventId
  name: string
  description?: string
  timeZone: string
  defaultTransitionMinutes: number
  validationPolicy: {
    minimumGapBands: number
    minimumRestMinutes: number
  }
  performanceSlotMinutes: number[]
  notes?: string
}

export interface EventDay {
  id: EventDayId
  eventId: EventId
  date: LocalDate
  label?: string
  order: number
}

export interface Stage {
  id: StageId
  eventDayId: EventDayId
  name: string
  location?: string
  order: number
  plannedStartTime: LocalTime
  plannedEndTime?: LocalTime
  transitionMinutes?: number
  notes?: string
}

export interface EventMember {
  id: EventMemberId
  eventId: EventId
  memberId: MemberId
  notes?: string
}

export interface EventMemberDay {
  id: EventMemberDayId
  eventMemberId: EventMemberId
  eventDayId: EventDayId
  participationStatus: ParticipationStatus
  // undefined means unrestricted; an empty array means no available time.
  availabilityWindows?: TimeRange[]
  preferredTimeRange?: TimeRange
  notes?: string
}

export interface EventBand {
  id: EventBandId
  eventId: EventId
  eventDayId: EventDayId
  bandId?: BandId
  name: string
  memberIds: MemberId[]
  durationMinutes: number
  availableTimeRange?: TimeRange
  preferredTimeRange?: TimeRange
  fixedPlacement?: FixedPlacement
  notes?: string
}

export interface Section {
  id: SectionId
  stageId: StageId
  name: string
  order: number
  plannedStartTime?: LocalTime
  plannedEndTime?: LocalTime
  notes?: string
}

interface ScheduleItemBase {
  id: ScheduleItemId
  stageId: StageId
  sectionId?: SectionId
  order: number
}

export interface PerformanceScheduleItem extends ScheduleItemBase {
  kind: 'performance'
  eventBandId: EventBandId
}

export interface BreakScheduleItem extends ScheduleItemBase {
  kind: 'break'
  title: string
  durationMinutes: number
}

export type ScheduleItem = PerformanceScheduleItem | BreakScheduleItem
