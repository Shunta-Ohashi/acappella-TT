import type {
  Band,
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  ScheduleItem,
  Section,
  Stage,
} from '../domain/models'

export interface DemoData {
  events: Event[]
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  bands: Band[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  initialEventId: string
  initialEventDayId: string
  initialStageId: string
}

const events: Event[] = [
  {
    id: 'event-demo-main',
    name: '2026 デモライブ',
    description: '複数日・複数Stageの動作確認用イベントです。',
    timeZone: 'Asia/Tokyo',
    defaultTransitionMinutes: 2,
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5, 7, 10, 15],
  },
  {
    id: 'event-demo-festival',
    name: '2026 学祭デモ',
    timeZone: 'Asia/Tokyo',
    defaultTransitionMinutes: 2,
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5, 10, 15],
  },
]

const eventDays: EventDay[] = [
  {
    id: 'event-day-demo-main-01',
    eventId: 'event-demo-main',
    date: '2026-11-01',
    label: 'ライブ1日目',
    order: 0,
  },
  {
    id: 'event-day-demo-main-02',
    eventId: 'event-demo-main',
    date: '2026-11-03',
    label: 'ライブ2日目',
    order: 1,
  },
  {
    id: 'event-day-demo-festival-01',
    eventId: 'event-demo-festival',
    date: '2026-11-15',
    order: 0,
  },
]

const stages: Stage[] = [
  {
    id: 'stage-demo-main-day1',
    eventDayId: 'event-day-demo-main-01',
    name: 'Main Stage',
    location: '大ホール',
    order: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '18:00',
    transitionMinutes: 2,
  },
  {
    id: 'stage-demo-sub-day1',
    eventDayId: 'event-day-demo-main-01',
    name: 'Sub Stage',
    location: '中庭',
    order: 1,
    plannedStartTime: '11:00',
    plannedEndTime: '17:00',
    transitionMinutes: 2,
  },
  {
    id: 'stage-demo-main-day2',
    eventDayId: 'event-day-demo-main-02',
    name: 'Main Stage',
    location: '大ホール',
    order: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '18:00',
    transitionMinutes: 2,
  },
  {
    id: 'stage-demo-sub-day2',
    eventDayId: 'event-day-demo-main-02',
    name: 'Sub Stage',
    location: '中庭',
    order: 1,
    plannedStartTime: '11:00',
    plannedEndTime: '17:00',
    transitionMinutes: 2,
  },
  {
    id: 'stage-demo-festival',
    eventDayId: 'event-day-demo-festival-01',
    name: '講堂Stage',
    location: '大学講堂',
    order: 0,
    plannedStartTime: '12:00',
    plannedEndTime: '17:00',
  },
]

const sections: Section[] = [
  {
    id: 'section-demo-day1-01',
    stageId: 'stage-demo-main-day1',
    name: '1部',
    order: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '12:30',
  },
  {
    id: 'section-demo-day1-02',
    stageId: 'stage-demo-main-day1',
    name: '2部',
    order: 1,
    plannedStartTime: '13:30',
    plannedEndTime: '16:00',
  },
  {
    id: 'section-demo-day1-03',
    stageId: 'stage-demo-main-day1',
    name: '3部',
    order: 2,
    plannedStartTime: '16:30',
  },
  {
    id: 'section-demo-day2-01',
    stageId: 'stage-demo-main-day2',
    name: '午前の部',
    order: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '13:00',
  },
  {
    id: 'section-demo-day2-02',
    stageId: 'stage-demo-main-day2',
    name: '午後の部',
    order: 1,
    plannedStartTime: '14:00',
  },
]

const members: Member[] = [
  {
    id: 'member-demo-01',
    realName: '青木 葵',
    acaName: 'あおい',
    entryAcademicYear: 2023,
    active: true,
    paCapabilities: { main: true, sub: false },
  },
  {
    id: 'member-demo-02',
    realName: '石井 蓮',
    acaName: 'れん',
    entryAcademicYear: 2024,
    active: true,
    paCapabilities: { main: false, sub: true },
  },
  {
    id: 'member-demo-03',
    realName: '上田 美咲',
    acaName: 'みさき',
    entryAcademicYear: 2022,
    active: true,
    paCapabilities: { main: true, sub: true },
  },
  {
    id: 'member-demo-04',
    realName: '江藤 奏',
    acaName: 'かなで',
    entryAcademicYear: 2023,
    active: true,
  },
  {
    id: 'member-demo-05',
    realName: '大西 凛',
    acaName: 'りん',
    entryAcademicYear: 2024,
    active: true,
    paCapabilities: { main: true, sub: false },
  },
  {
    id: 'member-demo-06',
    realName: '加藤 湊',
    acaName: 'みなと',
    entryAcademicYear: 2022,
    active: true,
    paCapabilities: { main: false, sub: true },
  },
  {
    id: 'member-demo-07',
    realName: '木村 結衣',
    acaName: 'ゆい',
    entryAcademicYear: 2025,
    active: true,
  },
  {
    id: 'member-demo-08',
    realName: '佐々木 翔',
    acaName: 'しょう',
    entryAcademicYear: 2023,
    active: true,
    paCapabilities: { main: true, sub: true },
  },
  {
    id: 'member-demo-09',
    realName: '高橋 陽菜',
    acaName: 'ひな',
    entryAcademicYear: 2024,
    active: true,
  },
  {
    id: 'member-demo-10',
    realName: '中村 颯',
    acaName: 'はやて',
    entryAcademicYear: 2022,
    active: true,
  },
]

const bands: Band[] = [
  {
    id: 'band-demo-01',
    name: 'Aurora',
    defaultMemberIds: [
      'member-demo-01',
      'member-demo-02',
      'member-demo-03',
      'member-demo-04',
    ],
    active: true,
  },
  {
    id: 'band-demo-02',
    name: 'Blend Note',
    defaultMemberIds: [
      'member-demo-03',
      'member-demo-04',
      'member-demo-05',
      'member-demo-06',
    ],
    active: true,
  },
  {
    id: 'band-demo-03',
    name: 'Ciel',
    defaultMemberIds: ['member-demo-01', 'member-demo-06', 'member-demo-07'],
    active: true,
  },
  {
    id: 'band-demo-04',
    name: 'Drop Chord',
    defaultMemberIds: ['member-demo-02', 'member-demo-05', 'member-demo-08'],
    active: true,
  },
  {
    id: 'band-demo-05',
    name: 'Echo Bloom',
    defaultMemberIds: ['member-demo-03', 'member-demo-07', 'member-demo-09'],
    active: true,
  },
  {
    id: 'band-demo-06',
    name: 'Legacy Vox',
    defaultMemberIds: ['member-demo-04', 'member-demo-08', 'member-demo-10'],
    active: false,
  },
]

const mainEventMembers: EventMember[] = members.map((member, index) => ({
  id: `event-member-demo-main-${String(index + 1).padStart(2, '0')}`,
  eventId: 'event-demo-main',
  memberId: member.id,
}))

const festivalEventMembers: EventMember[] = members.slice(0, 4).map((
  member,
  index,
) => ({
  id: `event-member-demo-festival-${String(index + 1).padStart(2, '0')}`,
  eventId: 'event-demo-festival',
  memberId: member.id,
}))

const eventMembers: EventMember[] = [
  ...mainEventMembers,
  ...festivalEventMembers,
]

const mainDay1Conditions: Array<Pick<
  EventMemberDay,
  'participationStatus' | 'availabilityWindows' | 'preferredTimeRange'
>> = [
  { participationStatus: 'participating', preferredTimeRange: { from: '15:00' } },
  { participationStatus: 'participating', availabilityWindows: [{ from: '13:00' }] },
  { participationStatus: 'participating', availabilityWindows: [{ until: '17:30' }] },
  {
    participationStatus: 'participating',
    availabilityWindows: [
      { from: '10:00', until: '12:00' },
      { from: '15:00', until: '18:00' },
    ],
  },
  {
    participationStatus: 'participating',
    availabilityWindows: [{ from: '13:00', until: '18:00' }],
  },
  { participationStatus: 'participating', availabilityWindows: [{ until: '17:00' }] },
  {
    participationStatus: 'participating',
    availabilityWindows: [{ from: '14:00', until: '16:00' }],
  },
  { participationStatus: 'participating', preferredTimeRange: { until: '16:00' } },
  {
    participationStatus: 'participating',
    availabilityWindows: [
      { from: '10:00', until: '12:00' },
      { from: '15:00', until: '17:00' },
    ],
  },
  { participationStatus: 'participating' },
]

const mainDay2Conditions: Array<Pick<
  EventMemberDay,
  'participationStatus' | 'availabilityWindows' | 'preferredTimeRange'
>> = [
  { participationStatus: 'participating', availabilityWindows: [{ from: '13:00' }] },
  {
    participationStatus: 'undecided',
    availabilityWindows: [{ from: '10:00', until: '18:00' }],
  },
  { participationStatus: 'participating' },
  { participationStatus: 'participating' },
  { participationStatus: 'absent' },
  {
    participationStatus: 'participating',
    availabilityWindows: [
      { from: '10:00', until: '12:00' },
      { from: '15:00', until: '17:00' },
    ],
  },
  { participationStatus: 'participating' },
  { participationStatus: 'participating', availabilityWindows: [{ until: '16:00' }] },
  { participationStatus: 'participating', preferredTimeRange: { from: '15:00' } },
  { participationStatus: 'absent' },
]

const eventMemberDays: EventMemberDay[] = [
  ...mainEventMembers.flatMap((eventMember, index): EventMemberDay[] => [
    {
      id: `event-member-day-demo-main-01-${String(index + 1).padStart(2, '0')}`,
      eventMemberId: eventMember.id,
      eventDayId: 'event-day-demo-main-01',
      ...mainDay1Conditions[index],
    },
    {
      id: `event-member-day-demo-main-02-${String(index + 1).padStart(2, '0')}`,
      eventMemberId: eventMember.id,
      eventDayId: 'event-day-demo-main-02',
      ...mainDay2Conditions[index],
    },
  ]),
  ...festivalEventMembers.map((eventMember, index): EventMemberDay => ({
    id: `event-member-day-demo-festival-${String(index + 1).padStart(2, '0')}`,
    eventMemberId: eventMember.id,
    eventDayId: 'event-day-demo-festival-01',
    participationStatus: 'participating',
  })),
]

const eventBands: EventBand[] = [
  {
    id: 'event-band-demo-main-01',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-01',
    bandId: 'band-demo-01',
    name: 'Aurora',
    memberIds: [
      'member-demo-01',
      'member-demo-02',
      'member-demo-03',
      'member-demo-04',
    ],
    durationMinutes: 15,
  },
  {
    id: 'event-band-demo-main-02',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-01',
    bandId: 'band-demo-02',
    name: 'Blend Note',
    memberIds: [
      'member-demo-03',
      'member-demo-04',
      'member-demo-05',
      'member-demo-06',
    ],
    durationMinutes: 10,
  },
  {
    id: 'event-band-demo-main-03',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-01',
    name: 'Availability Trio',
    memberIds: ['member-demo-05', 'member-demo-06', 'member-demo-07'],
    durationMinutes: 10,
    availableTimeRange: { from: '15:00' },
    fixedPlacement: { stageId: 'stage-demo-sub-day1' },
  },
  {
    id: 'event-band-demo-main-04',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-01',
    name: 'Window Duo',
    memberIds: ['member-demo-04', 'member-demo-09'],
    durationMinutes: 7,
    availableTimeRange: { from: '11:00', until: '16:00' },
    preferredTimeRange: { from: '15:00', until: '16:00' },
  },
  {
    id: 'event-band-demo-main-05',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-02',
    bandId: 'band-demo-01',
    name: 'Aurora（2日目）',
    memberIds: ['member-demo-01', 'member-demo-03', 'member-demo-04'],
    durationMinutes: 15,
  },
  {
    id: 'event-band-demo-main-06',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-02',
    bandId: 'band-demo-03',
    name: 'Ciel Special',
    memberIds: ['member-demo-02', 'member-demo-06', 'member-demo-08'],
    durationMinutes: 10,
    preferredTimeRange: { from: '15:00', until: '17:00' },
  },
  {
    id: 'event-band-demo-main-07',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-02',
    bandId: 'band-demo-04',
    name: 'Drop Chord',
    memberIds: ['member-demo-07', 'member-demo-08', 'member-demo-09'],
    durationMinutes: 5,
    fixedPlacement: {
      stageId: 'stage-demo-main-day2',
      sectionId: 'section-demo-day2-02',
      position: { kind: 'last' },
    },
  },
  {
    id: 'event-band-demo-main-08',
    eventId: 'event-demo-main',
    eventDayId: 'event-day-demo-main-02',
    name: '時刻固定ユニット',
    memberIds: ['member-demo-03', 'member-demo-09'],
    durationMinutes: 7,
    fixedPlacement: {
      stageId: 'stage-demo-sub-day2',
      plannedStartTime: '14:00',
    },
  },
  {
    id: 'event-band-demo-festival-01',
    eventId: 'event-demo-festival',
    eventDayId: 'event-day-demo-festival-01',
    bandId: 'band-demo-02',
    name: 'Blend Note（学祭）',
    memberIds: ['member-demo-01', 'member-demo-02'],
    durationMinutes: 10,
  },
  {
    id: 'event-band-demo-festival-02',
    eventId: 'event-demo-festival',
    eventDayId: 'event-day-demo-festival-01',
    name: '学祭限定カルテット',
    memberIds: ['member-demo-03', 'member-demo-04'],
    durationMinutes: 5,
  },
]

const scheduleItems: ScheduleItem[] = [
  {
    id: 'schedule-demo-main-day1-break',
    stageId: 'stage-demo-main-day1',
    sectionId: 'section-demo-day1-02',
    order: 0,
    kind: 'break',
    title: '昼休憩',
    durationMinutes: 30,
  },
  {
    id: 'schedule-demo-main-day1-performance',
    stageId: 'stage-demo-main-day1',
    sectionId: 'section-demo-day1-03',
    order: 0,
    kind: 'performance',
    eventBandId: 'event-band-demo-main-01',
  },
  {
    id: 'schedule-demo-sub-day1-performance',
    stageId: 'stage-demo-sub-day1',
    order: 0,
    kind: 'performance',
    eventBandId: 'event-band-demo-main-04',
  },
  {
    id: 'schedule-demo-main-day2-performance',
    stageId: 'stage-demo-main-day2',
    sectionId: 'section-demo-day2-01',
    order: 0,
    kind: 'performance',
    eventBandId: 'event-band-demo-main-06',
  },
  {
    id: 'schedule-demo-main-day2-break',
    stageId: 'stage-demo-main-day2',
    sectionId: 'section-demo-day2-01',
    order: 1,
    kind: 'break',
    title: '転換調整',
    durationMinutes: 10,
  },
  {
    id: 'schedule-demo-festival-performance',
    stageId: 'stage-demo-festival',
    order: 0,
    kind: 'performance',
    eventBandId: 'event-band-demo-festival-01',
  },
]

export const createDemoData = (): DemoData => ({
  events: events.map((event) => ({
    ...event,
    performanceSlotMinutes: [...event.performanceSlotMinutes],
    validationPolicy: { ...event.validationPolicy },
  })),
  eventDays: eventDays.map((eventDay) => ({ ...eventDay })),
  stages: stages.map((stage) => ({ ...stage })),
  sections: sections.map((section) => ({ ...section })),
  members: members.map((member) => ({
    ...member,
    ...(member.paCapabilities
      ? { paCapabilities: { ...member.paCapabilities } }
      : {}),
  })),
  bands: bands.map((band) => ({
    ...band,
    defaultMemberIds: [...band.defaultMemberIds],
  })),
  eventMembers: eventMembers.map((eventMember) => ({ ...eventMember })),
  eventMemberDays: eventMemberDays.map((eventMemberDay) => ({
    ...eventMemberDay,
    ...(eventMemberDay.availabilityWindows
      ? {
          availabilityWindows: eventMemberDay.availabilityWindows.map(
            (window) => ({ ...window }),
          ),
        }
      : {}),
    ...(eventMemberDay.preferredTimeRange
      ? { preferredTimeRange: { ...eventMemberDay.preferredTimeRange } }
      : {}),
  })),
  eventBands: eventBands.map((eventBand) => ({
    ...eventBand,
    memberIds: [...eventBand.memberIds],
    ...(eventBand.availableTimeRange
      ? { availableTimeRange: { ...eventBand.availableTimeRange } }
      : {}),
    ...(eventBand.preferredTimeRange
      ? { preferredTimeRange: { ...eventBand.preferredTimeRange } }
      : {}),
    ...(eventBand.fixedPlacement
      ? {
          fixedPlacement: {
            ...eventBand.fixedPlacement,
            ...(eventBand.fixedPlacement.position
              ? { position: { ...eventBand.fixedPlacement.position } }
              : {}),
          },
        }
      : {}),
  })),
  scheduleItems: scheduleItems.map((scheduleItem) => ({ ...scheduleItem })),
  initialEventId: 'event-demo-main',
  initialEventDayId: 'event-day-demo-main-01',
  initialStageId: 'stage-demo-main-day1',
})
