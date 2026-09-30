import type { DemoData } from './demoData'
import type { EventBand, ScheduleItem } from '../domain/models'

export const GENERATION_DEMO_EVENT_ID = 'event-demo-generation'

/** Separate from the existing demos: both days must generate with default options. */
export const createGenerationDemoData = (): Omit<DemoData,
  'initialEventId' | 'initialEventDayId' | 'initialStageId'> => {
  const eventId = GENERATION_DEMO_EVENT_ID
  const day1 = 'day-demo-generation-1'
  const day2 = 'day-demo-generation-2'
  const main1 = 'stage-demo-generation-main-1'
  const sub1 = 'stage-demo-generation-sub-1'
  const main2 = 'stage-demo-generation-main-2'
  const sub2 = 'stage-demo-generation-sub-2'
  const sections = [
    { id: 'section-demo-generation-1a', stageId: main1, name: '第1部', order: 0, plannedStartTime: '10:00', plannedEndTime: '11:00' },
    { id: 'section-demo-generation-1b', stageId: main1, name: '第2部', order: 1, plannedStartTime: '11:30', plannedEndTime: '12:30' },
    { id: 'section-demo-generation-1c', stageId: main1, name: '第3部', order: 2, plannedStartTime: '13:00', plannedEndTime: '14:00' },
    { id: 'section-demo-generation-2a', stageId: main2, name: '午前の部', order: 0, plannedStartTime: '10:00', plannedEndTime: '11:00' },
    { id: 'section-demo-generation-2b', stageId: main2, name: '午後の部', order: 1, plannedStartTime: '12:00', plannedEndTime: '13:00' },
  ]
  const members = [
    ['main-haru', '春野 遥', 'はる'], ['main-tomo', '高橋 智', 'とも'],
    ['sub-saki', '佐藤 咲', 'さき'], ['sub-nao', '中村 直', 'なお'],
    ['duty-koh', '小林 光', 'こう'], ['duty-rio', '鈴木 莉央', 'りお'],
    ['duty-sui', '水野 翠', 'すい'],
  ].map(([id, realName, acaName]) => ({
    id: `member-demo-generation-${id}`, realName, acaName, active: true,
  }))
  // Reuse the common performers, but keep participation and PA capability Event-specific.
  const performerIds = Array.from({ length: 10 }, (_, i) => `member-demo-${String(i + 1).padStart(2, '0')}`)
  const eventMembers = [...performerIds, ...members.map(member => member.id)].map(memberId => ({
    id: `em-demo-generation-${memberId}`, eventId, memberId,
    paCapabilities: {
      main: memberId.startsWith('member-demo-generation-main-'),
      sub: memberId.startsWith('member-demo-generation-sub-'),
    },
  }))
  const bands = ['Moonlight', 'Breeze', 'Amber', 'Prism'].map((name, index) => ({
    id: `band-demo-generation-${index + 1}`, name, active: true,
    defaultMemberIds: index === 3
      ? [...performerIds.slice(0, 2), ...performerIds.slice(6, 8)]
      : performerIds.slice(index * 2, index * 2 + 4),
  }))
  const eventBands: EventBand[] = [day1, day2].flatMap((eventDayId, dayIndex) =>
    bands.map((band, index) => ({
      id: `eb-demo-generation-${dayIndex + 1}-${index + 1}`,
      eventId, eventDayId, bandId: band.id, name: `${band.name}（${dayIndex + 1}日目）`,
      memberIds: [...band.defaultMemberIds], durationMinutes: [10, 15, 7, 10][index],
      fixedPlacement: dayIndex === 0
        ? index < 3 ? { stageId: main1, sectionId: sections[index].id }
          : { stageId: sub1 }
        : index < 2 ? { stageId: main2, sectionId: sections[index + 3].id }
          : { stageId: sub2, ...(index === 2 ? { plannedStartTime: '14:00' } : {}) },
      ...(index === 3 ? { availableTimeRange: { from: '14:00', until: '16:00' },
        preferredTimeRange: { from: '14:00', until: '15:00' } } : {}),
      notes: '自動生成用サンプル。別日の出演は独立したEventBandです。',
    })),
  )
  const scheduleItems: ScheduleItem[] = [
    { id: 'schedule-demo-generation-opening', kind: 'performance', stageId: main1, sectionId: sections[0].id, eventBandId: eventBands[0].id, order: 0 },
    { id: 'schedule-demo-generation-middle', kind: 'performance', stageId: main1, sectionId: sections[1].id, eventBandId: eventBands[1].id, order: 0 },
    { id: 'schedule-demo-generation-sub', kind: 'performance', stageId: sub1, eventBandId: eventBands[3].id, order: 0 },
    { id: 'schedule-demo-generation-fixed-start', kind: 'performance', stageId: sub2, eventBandId: eventBands[6].id, order: 0 },
    { id: 'break-demo-generation-between-1', kind: 'break', stageId: main1, afterSectionId: sections[0].id, title: '第1部→第2部の休憩', durationMinutes: 30, order: 0 },
    { id: 'break-demo-generation-between-2', kind: 'break', stageId: main1, afterSectionId: sections[1].id, title: '第2部→第3部の休憩', durationMinutes: 30, order: 0 },
    { id: 'break-demo-generation-inside', kind: 'break', stageId: main1, sectionId: sections[1].id, title: '第2部内の小休憩', durationMinutes: 5, order: 1 },
    { id: 'break-demo-generation-day2', kind: 'break', stageId: main2, afterSectionId: sections[3].id, title: '午前→午後の休憩', durationMinutes: 30, order: 0 },
    { id: 'break-demo-generation-sub2', kind: 'break', stageId: sub2, title: '掛け持ちメンバーの休憩・PA交代', durationMinutes: 30, order: 1 },
  ]
  const dutyTypes = [{ id: 'duty-demo-generation-photo', eventId, name: '撮影', order: 0 },
    { id: 'duty-demo-generation-reception', eventId, name: '受付', order: 1 }]
  return {
    events: [{ id: eventId, name: '自動生成お試しライブ（2日開催）',
      description: '両日とも自動生成可能。部内／部間休憩、TT固定、PA、撮影3名を確認できます。',
      timeZone: 'Asia/Tokyo', defaultTransitionMinutes: 2,
      validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
      performanceSlotMinutes: [5, 7, 10, 15] }],
    eventDays: [{ id: day1, eventId, date: '2026-12-05', label: 'お試し1日目', order: 0 },
      { id: day2, eventId, date: '2026-12-06', label: 'お試し2日目', order: 1 }],
    stages: [
      { id: main1, eventDayId: day1, name: 'Main Stage', order: 0, plannedStartTime: '10:00', plannedEndTime: '17:00' },
      { id: sub1, eventDayId: day1, name: 'Sub Stage', order: 1, plannedStartTime: '14:00', plannedEndTime: '17:00' },
      { id: main2, eventDayId: day2, name: 'Main Stage', order: 0, plannedStartTime: '10:00', plannedEndTime: '17:00' },
      { id: sub2, eventDayId: day2, name: 'Sub Stage', order: 1, plannedStartTime: '14:00', plannedEndTime: '17:00' },
    ],
    sections, members, bands, eventMembers,
    eventMemberDays: [day1, day2].flatMap(eventDayId => eventMembers.map(member => ({
      id: `emd-demo-generation-${eventDayId}-${member.id}`, eventMemberId: member.id,
      eventDayId, participationStatus: eventDayId === day2 && member.memberId === performerIds[7]
        ? 'undecided' as const
        : eventDayId === day2 && member.memberId === performerIds[9]
          ? 'absent' as const : 'participating' as const,
      ...(member.memberId === performerIds[0] ? { availabilityWindows: [
        { from: '09:00', until: '11:00' }, { from: '13:00', until: '17:00' },
      ] } : {}),
    }))),
    eventBands, scheduleItems,
    paAssignments: ['main', 'sub'].map((role, index) => ({
      id: `pa-demo-generation-${role}`, eventId, eventDayId: day1, stageId: main1,
      memberId: members[index === 0 ? 0 : 2].id, role: role as 'main' | 'sub',
      from: { scheduleItemId: scheduleItems[0].id, edge: 'start' as const },
      until: { scheduleItemId: scheduleItems[0].id, edge: 'end' as const },
    })),
    dutyTypes,
    dutyAssignments: members.slice(4).map((member, index) => ({
      id: `duty-assignment-demo-generation-photo-${index + 1}`,
      dutyTypeId: dutyTypes[0].id, eventDayId: day1, stageId: main1, memberId: member.id,
      from: { scheduleItemId: 'break-demo-generation-inside', edge: 'start' as const },
      until: { scheduleItemId: 'break-demo-generation-inside', edge: 'end' as const },
    })),
    timetableLocks: [{ id: 'lock-demo-generation-opening', eventId,
      scheduleItemId: scheduleItems[0].id, stageId: main1, sectionId: sections[0].id,
      position: { kind: 'first' } }],
  }
}
