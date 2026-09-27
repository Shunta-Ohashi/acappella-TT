export const createGenerationUiInput = () => {
  const event = { id: 'event-a', name: '学園祭', timeZone: 'Asia/Tokyo', defaultTransitionMinutes: 0,
    performanceSlotMinutes: [10], validationPolicy: { minimumGapBands: 0, minimumRestMinutes: 0 } }
  const eventDay = { id: 'day-a1', eventId: event.id, date: '2027-11-06', order: 0 }
  const eventDays = [eventDay, { ...eventDay, id: 'day-a2', date: '2027-11-07', order: 1 },
    { ...eventDay, id: 'day-b', eventId: 'event-b' }]
  const stages = [
    { id: 'stage-a1', eventDayId: eventDay.id, name: 'Main Stage', order: 0, plannedStartTime: '10:00' },
    { id: 'stage-sub', eventDayId: eventDay.id, name: 'Sub Stage', order: 1, plannedStartTime: '10:00' },
    { id: 'stage-a2', eventDayId: 'day-a2', name: '翌日Stage', order: 0, plannedStartTime: '10:00' },
    { id: 'stage-b', eventDayId: 'day-b', name: '別イベントStage', order: 0, plannedStartTime: '10:00' },
  ]
  const sections = [
    { id: 'section-1', stageId: 'stage-a1', name: '第1部', order: 0 },
    { id: 'section-2', stageId: 'stage-a1', name: '第2部', order: 1, plannedStartTime: '11:00' },
  ]
  const members = ['performer-1', 'performer-2', 'main', 'sub', 'duty'].map(id => ({
    id, realName: `本名 ${id}`, acaName: `表示 ${id}`, active: true,
  }))
  const eventMembers = members.map(member => ({ id: `em-${member.id}`, eventId: event.id,
    memberId: member.id, paCapabilities: { main: member.id === 'main', sub: member.id === 'sub' } }))
  const eventMemberDays = eventMembers.map(member => ({ id: `emd-${member.id}`, eventMemberId: member.id,
    eventDayId: eventDay.id, participationStatus: 'participating' }))
  const eventBands = [
    { id: 'band-1', eventId: event.id, eventDayId: eventDay.id, name: 'Choir',
      memberIds: ['performer-1'], durationMinutes: 10, fixedPlacement: { stageId: 'stage-a1', sectionId: 'section-1' } },
    { id: 'band-2', eventId: event.id, eventDayId: eventDay.id, name: 'Blend Note',
      memberIds: ['performer-2'], durationMinutes: 10, fixedPlacement: { stageId: 'stage-a1', sectionId: 'section-2' } },
    { id: 'band-a2', eventId: event.id, eventDayId: 'day-a2', name: '翌日', memberIds: [], durationMinutes: 10 },
    { id: 'band-b', eventId: 'event-b', eventDayId: 'day-b', name: '別Event', memberIds: [], durationMinutes: 10 },
  ]
  const scheduleItems = [
    { id: 'old-p1', kind: 'performance', eventBandId: 'band-1', stageId: 'stage-a1', sectionId: 'section-1', order: 0 },
    { id: 'p-a2', kind: 'performance', eventBandId: 'band-a2', stageId: 'stage-a2', order: 5 },
    { id: 'break-1', kind: 'break', title: '部間休憩', durationMinutes: 15, stageId: 'stage-a1', afterSectionId: 'section-1', order: 0 },
    { id: 'p-b', kind: 'performance', eventBandId: 'band-b', stageId: 'stage-b', order: 7 },
  ]
  const pa = (id, eventId, eventDayId, stageId, itemId) => ({
    id, eventId, eventDayId, stageId, memberId: 'main', role: 'main',
    from: { scheduleItemId: itemId, edge: 'start' }, until: { scheduleItemId: itemId, edge: 'end' },
  })
  const paAssignments = [pa('old-pa', event.id, eventDay.id, 'stage-a1', 'old-p1'),
    pa('pa-a2', event.id, 'day-a2', 'stage-a2', 'p-a2'), pa('pa-b', 'event-b', 'day-b', 'stage-b', 'p-b')]
  const timetableLocks = [{ id: 'lock-1', eventId: event.id, scheduleItemId: 'old-p1',
    stageId: 'stage-a1', sectionId: 'section-1', position: { kind: 'first' } }]
  const dutyTypes = [{ id: 'duty-photo', eventId: event.id, name: '撮影', order: 0 }]
  const dutyAssignments = [{ id: 'duty-1', dutyTypeId: 'duty-photo', eventDayId: eventDay.id,
    stageId: 'stage-a1', memberId: 'duty', from: { scheduleItemId: 'break-1', edge: 'start' },
    until: { scheduleItemId: 'break-1', edge: 'end' } }]
  return { event, eventDay, eventDays, stages, sections, members, eventMembers, eventMemberDays,
    eventBands, scheduleItems, paAssignments, timetableLocks, dutyTypes, dutyAssignments }
}

export const createGenerationUiPlan = () => ({
  eventDayId: 'day-a1',
  placements: [
    { eventBandId: 'band-1', stageId: 'stage-a1', sectionId: 'section-1', order: 0, position: 0, scheduleItemId: 'old-p1' },
    { eventBandId: 'band-2', stageId: 'stage-a1', sectionId: 'section-2', order: 0, position: 0 },
  ],
  breaks: [{ scheduleItemId: 'break-1', stageId: 'stage-a1', afterSectionId: 'section-1', order: 0 }],
  paShifts: ['section-1', 'section-2'].flatMap((sectionId, index) => ['main', 'sub'].map(role => ({
    eventDayId: 'day-a1', stageId: 'stage-a1', sectionId, role, memberId: role,
    fromMinute: index ? 660 : 600, untilMinute: index ? 670 : 610,
    fromBoundary: { kind: 'planned-performance', eventBandId: `band-${index + 1}`, edge: 'start' },
    untilBoundary: index ? { kind: 'planned-performance', eventBandId: 'band-2', edge: 'end' }
      : { kind: 'existing-item', scheduleItemId: 'old-p1', edge: 'end' },
  }))),
  score: { lastResortActivityCount: 0, schedulingSoftPenalty: 0, activitySpacingPenalty: 0,
    sectionDurationImbalance: 0, paMainWorkloadImbalance: 0, paSubWorkloadImbalance: 0,
    sectionBandCountImbalance: 0, undecidedPaShiftCount: 0 },
  diagnostics: { scheduleCandidatesEvaluated: 2, paPlansEvaluated: 4, schedulingSoftViolations: [] },
})

export const materializationInput = () => ({ ...createGenerationUiInput(), plan: createGenerationUiPlan(),
  newScheduleItemIds: ['new-p2'], newPaAssignmentIds: ['new-pa-0', 'new-pa-1', 'new-pa-2', 'new-pa-3'] })
