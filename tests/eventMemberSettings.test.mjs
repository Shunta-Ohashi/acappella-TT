import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addEventMembersToDraft,
  canDeleteEventMember,
  createEventMemberSettingsDraft,
  createEventMemberSettingsUpdate,
  EVENT_MEMBER_DELETE_BLOCKED_MESSAGE,
  getEventBandCountByMember,
  getEventMemberDayDraftErrorKey,
  getFirstEventMemberDayErrorTarget,
  hasEventMemberSettingsErrors,
  validateEventMemberSettingsDraft,
} from '../src/domain/eventMemberSettings.ts'

const event = {
  id: 'event-1',
  name: 'テストイベント',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
}

const otherEvent = { ...event, id: 'event-2', name: '別イベント' }

const eventDays = [
  { id: 'day-2', eventId: event.id, date: '2027-11-07', order: 1 },
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
  { id: 'other-day', eventId: otherEvent.id, date: '2027-12-01', order: 0 },
]

const members = [
  { id: 'member-1', realName: '佐藤', acaName: 'さとう', active: true },
  { id: 'member-2', realName: '鈴木', acaName: 'すず', active: true },
  { id: 'member-3', realName: '高橋', active: true },
]

const createEventMember = (id, memberId, eventId = event.id) => ({
  id,
  eventId,
  memberId,
})

const createEventMemberDay = (
  id,
  eventMemberId,
  eventDayId,
  participationStatus = 'participating',
  overrides = {},
) => ({
  id,
  eventMemberId,
  eventDayId,
  participationStatus,
  ...overrides,
})

const createEventBand = (
  id,
  memberIds,
  eventId = event.id,
  bandId = `band-${id}`,
) => ({
  id,
  eventId,
  eventDayId: eventId === event.id ? 'day-1' : 'other-day',
  bandId,
  memberIds,
  durationMinutes: 10,
})

test('既存EventMemberと日別statusを読み込み、不足日はundecidedで補完する', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const otherEventMember = createEventMember(
    'event-member-other',
    'member-2',
    otherEvent.id,
  )
  const draft = createEventMemberSettingsDraft(
    event,
    eventDays,
    [eventMember, otherEventMember],
    [
      createEventMemberDay(
        'event-member-day-1',
        eventMember.id,
        'day-1',
        'absent',
      ),
      createEventMemberDay(
        'event-member-day-other',
        otherEventMember.id,
        'other-day',
        'participating',
      ),
    ],
  )

  assert.equal(draft.members.length, 1)
  assert.equal(draft.members[0].eventMemberId, eventMember.id)
  assert.deepEqual(draft.members[0].days, [
    {
      eventMemberDayId: 'event-member-day-1',
      eventDayId: 'day-1',
      participationStatus: 'absent',
    },
    {
      eventMemberDayId: undefined,
      eventDayId: 'day-2',
      participationStatus: 'undecided',
    },
  ])
})

test('共通Memberを重複させず追加し、全EventDayをundecidedで用意する', () => {
  const existingDraft = {
    members: [{
      draftId: 'existing-member-1',
      eventMemberId: 'event-member-1',
      memberId: 'member-1',
      days: [],
    }],
  }
  const added = addEventMembersToDraft({
    draft: existingDraft,
    event,
    eventDays,
    memberIds: ['member-1', 'member-2', 'member-2', 'member-3'],
    newDraftIds: ['new-member-2', 'new-member-3'],
  })

  assert.deepEqual(
    added.members.map((memberDraft) => memberDraft.memberId),
    ['member-1', 'member-2', 'member-3'],
  )
  assert.deepEqual(added.members[1].days, [
    { eventDayId: 'day-1', participationStatus: 'undecided' },
    { eventDayId: 'day-2', participationStatus: 'undecided' },
  ])

  const singleDay = addEventMembersToDraft({
    draft: { members: [] },
    event,
    eventDays: [eventDays[1]],
    memberIds: ['member-1'],
    newDraftIds: ['single-day-member'],
  })
  assert.equal(singleDay.members[0].days.length, 1)
})

test('出演予定数はEventBand単位で集計し、別Eventを混ぜない', () => {
  const counts = getEventBandCountByMember(event.id, [
    createEventBand('appearance-1', ['member-1', 'member-1']),
    createEventBand('appearance-2', ['member-1', 'member-2'], event.id, 'same-band'),
    createEventBand('appearance-3', ['member-1'], event.id, 'same-band'),
    createEventBand('other-appearance', ['member-1'], otherEvent.id),
  ])

  assert.equal(counts.get('member-1'), 3)
  assert.equal(counts.get('member-2'), 1)
  assert.equal(counts.get('member-3') ?? 0, 0)
})

test('既存IDと時間条件を維持し、日別statusと不足EventMemberDayだけ更新する', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const otherEventMember = createEventMember(
    'event-member-other',
    'member-2',
    otherEvent.id,
  )
  const existingDay = createEventMemberDay(
    'event-member-day-1',
    eventMember.id,
    'day-1',
    'participating',
    {
      availabilityWindows: [{ from: '10:00', until: '12:00' }],
      preferredTimeRange: { until: '11:30' },
      notes: '既存の日別メモ',
    },
  )
  const otherDay = createEventMemberDay(
    'event-member-day-other',
    otherEventMember.id,
    'other-day',
  )
  const draft = createEventMemberSettingsDraft(
    event,
    eventDays,
    [eventMember, otherEventMember],
    [existingDay, otherDay],
  )
  draft.members[0].days[0].participationStatus = 'absent'
  draft.members[0].days[1].participationStatus = 'participating'

  const result = createEventMemberSettingsUpdate({
    event,
    eventDays,
    members,
    eventMembers: [eventMember, otherEventMember],
    eventMemberDays: [existingDay, otherDay],
    eventBands: [],
    draft,
    newEventMemberIds: [],
    newEventMemberDayIds: ['event-member-day-2'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.eventMembers.some((candidate) => candidate === eventMember))
  const updatedExistingDay = result.eventMemberDays.find(
    (day) => day.id === existingDay.id,
  )
  assert.deepEqual(updatedExistingDay, {
    ...existingDay,
    participationStatus: 'absent',
  })
  assert.deepEqual(
    result.eventMemberDays.find((day) => day.id === 'event-member-day-2'),
    {
      id: 'event-member-day-2',
      eventMemberId: eventMember.id,
      eventDayId: 'day-2',
      participationStatus: 'participating',
    },
  )
  assert.ok(result.eventMemberDays.some((day) => day === otherDay))
})

test('新規EventMemberと全EventDayに指定された新規IDだけを使用する', () => {
  const draft = addEventMembersToDraft({
    draft: { members: [] },
    event,
    eventDays,
    memberIds: ['member-1'],
    newDraftIds: ['new-draft-1'],
  })
  const result = createEventMemberSettingsUpdate({
    event,
    eventDays,
    members,
    eventMembers: [],
    eventMemberDays: [],
    eventBands: [],
    draft,
    newEventMemberIds: ['new-event-member-1'],
    newEventMemberDayIds: ['new-day-1', 'new-day-2'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventMembers, [{
    id: 'new-event-member-1',
    eventId: event.id,
    memberId: 'member-1',
  }])
  assert.deepEqual(
    result.eventMemberDays.map((day) => ({
      id: day.id,
      eventMemberId: day.eventMemberId,
      eventDayId: day.eventDayId,
      participationStatus: day.participationStatus,
    })),
    [
      {
        id: 'new-day-1',
        eventMemberId: 'new-event-member-1',
        eventDayId: 'day-1',
        participationStatus: 'undecided',
      },
      {
        id: 'new-day-2',
        eventMemberId: 'new-event-member-1',
        eventDayId: 'day-2',
        participationStatus: 'undecided',
      },
    ],
  )
})

test('未参照EventMemberを削除すると従属日だけ削除し、他Memberと別Eventを維持する', () => {
  const removedMember = createEventMember('event-member-1', 'member-1')
  const retainedMember = createEventMember('event-member-2', 'member-2')
  const otherEventMember = createEventMember(
    'event-member-other',
    'member-3',
    otherEvent.id,
  )
  const memberDays = [
    createEventMemberDay('removed-day-1', removedMember.id, 'day-1'),
    createEventMemberDay('removed-day-2', removedMember.id, 'day-2'),
    createEventMemberDay('retained-day-1', retainedMember.id, 'day-1'),
    createEventMemberDay('retained-day-2', retainedMember.id, 'day-2'),
    createEventMemberDay(
      'other-day-data',
      otherEventMember.id,
      'other-day',
    ),
  ]
  const fullDraft = createEventMemberSettingsDraft(
    event,
    eventDays,
    [removedMember, retainedMember, otherEventMember],
    memberDays,
  )
  const draft = {
    members: fullDraft.members.filter(
      (memberDraft) => memberDraft.eventMemberId === retainedMember.id,
    ),
  }
  const result = createEventMemberSettingsUpdate({
    event,
    eventDays,
    members,
    eventMembers: [removedMember, retainedMember, otherEventMember],
    eventMemberDays: memberDays,
    eventBands: [],
    draft,
    newEventMemberIds: [],
    newEventMemberDayIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(
    result.eventMembers.map((candidate) => candidate.id),
    [otherEventMember.id, retainedMember.id],
  )
  assert.deepEqual(
    result.eventMemberDays.map((day) => day.id),
    ['other-day-data', 'retained-day-1', 'retained-day-2'],
  )
})

test('EventBand参照中のEventMemberをUI判定と保存処理の両方で削除不可にする', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const memberDays = [
    createEventMemberDay('day-data-1', eventMember.id, 'day-1'),
    createEventMemberDay('day-data-2', eventMember.id, 'day-2'),
  ]
  const selectedEventBand = createEventBand('appearance-1', ['member-1'])
  const otherEventBand = createEventBand(
    'other-appearance',
    ['member-2'],
    otherEvent.id,
  )

  assert.equal(
    canDeleteEventMember('member-1', event.id, [selectedEventBand]),
    false,
  )
  assert.equal(
    canDeleteEventMember('member-2', event.id, [otherEventBand]),
    true,
  )

  const result = createEventMemberSettingsUpdate({
    event,
    eventDays,
    members,
    eventMembers: [eventMember],
    eventMemberDays: memberDays,
    eventBands: [selectedEventBand, otherEventBand],
    draft: { members: [] },
    newEventMemberIds: [],
    newEventMemberDayIds: [],
  })

  assert.deepEqual(result, {
    ok: false,
    errors: {
      members: {},
      days: {},
      form: EVENT_MEMBER_DELETE_BLOCKED_MESSAGE,
    },
  })
})

test('重複Member・不正参照・不正statusを保存前validationで拒否する', () => {
  const existing = createEventMember('event-member-1', 'member-1')
  const draft = {
    members: [
      {
        draftId: 'invalid-existing',
        eventMemberId: 'other-event-member-id',
        memberId: 'member-1',
        days: [
          { eventDayId: 'day-1', participationStatus: 'invalid-status' },
          { eventDayId: 'other-day', participationStatus: 'participating' },
        ],
      },
      {
        draftId: 'duplicate-member',
        memberId: 'member-1',
        days: [
          { eventDayId: 'day-1', participationStatus: 'undecided' },
          { eventDayId: 'day-2', participationStatus: 'undecided' },
        ],
      },
    ],
  }
  const errors = validateEventMemberSettingsDraft({
    event,
    eventDays,
    members,
    eventMembers: [existing],
    eventMemberDays: [],
    draft,
  })

  assert.equal(hasEventMemberSettingsErrors(errors), true)
  assert.ok(errors.members['invalid-existing'])
  assert.ok(errors.members['duplicate-member'])
  assert.ok(Object.keys(errors.days).length > 0)
})

test('日別詳細をdraftへ読み込み、既存EventMemberDay IDと他条件を維持して更新する', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const existingDay = createEventMemberDay(
    'event-member-day-1',
    eventMember.id,
    'day-1',
    'participating',
    {
      availabilityWindows: [{ from: '10:00', until: '12:00' }],
      preferredTimeRange: { from: '10:30' },
      notes: '既存メモ',
    },
  )
  const draft = createEventMemberSettingsDraft(
    event,
    [eventDays[1]],
    [eventMember],
    [existingDay],
  )

  assert.deepEqual(draft.members[0].days[0], {
    eventMemberDayId: existingDay.id,
    eventDayId: 'day-1',
    participationStatus: 'participating',
    availabilityWindows: [{ from: '10:00', until: '12:00' }],
    preferredTimeRange: { from: '10:30' },
    notes: '既存メモ',
  })
  draft.members[0].days[0].availabilityWindows = [
    { from: '15:00', until: '17:00' },
  ]

  const result = createEventMemberSettingsUpdate({
    event,
    eventDays: [eventDays[1]],
    members,
    eventMembers: [eventMember],
    eventMemberDays: [existingDay],
    eventBands: [],
    draft,
    newEventMemberIds: [],
    newEventMemberDayIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventMemberDays[0], {
    ...existingDay,
    availabilityWindows: [{ from: '15:00', until: '17:00' }],
  })
})

test('不足EventMemberDayにも日別詳細を付けて新規IDで保存する', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const draft = createEventMemberSettingsDraft(
    event,
    [eventDays[1]],
    [eventMember],
    [],
  )
  Object.assign(draft.members[0].days[0], {
    participationStatus: 'participating',
    availabilityWindows: [{ until: '15:00' }, { from: '16:00' }],
    preferredTimeRange: { from: '10:00', until: '12:00' },
    notes: '  新規の日別メモ  ',
  })

  const result = createEventMemberSettingsUpdate({
    event,
    eventDays: [eventDays[1]],
    members,
    eventMembers: [eventMember],
    eventMemberDays: [],
    eventBands: [],
    draft,
    newEventMemberIds: [],
    newEventMemberDayIds: ['new-event-member-day'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventMemberDays, [{
    id: 'new-event-member-day',
    eventMemberId: eventMember.id,
    eventDayId: 'day-1',
    participationStatus: 'participating',
    availabilityWindows: [{ until: '15:00' }, { from: '16:00' }],
    preferredTimeRange: { from: '10:00', until: '12:00' },
    notes: '新規の日別メモ',
  }])
})

test('absentへの変更では日別時間条件を削除せず、参加へ戻しても維持する', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const existingDay = createEventMemberDay(
    'event-member-day-1',
    eventMember.id,
    'day-1',
    'participating',
    {
      availabilityWindows: [{ from: '13:00' }],
      preferredTimeRange: { until: '17:00' },
      notes: '保持するメモ',
    },
  )
  const draft = createEventMemberSettingsDraft(
    event,
    [eventDays[1]],
    [eventMember],
    [existingDay],
  )
  draft.members[0].days[0].participationStatus = 'absent'

  const absentResult = createEventMemberSettingsUpdate({
    event,
    eventDays: [eventDays[1]],
    members,
    eventMembers: [eventMember],
    eventMemberDays: [existingDay],
    eventBands: [],
    draft,
    newEventMemberIds: [],
    newEventMemberDayIds: [],
  })

  assert.equal(absentResult.ok, true)
  if (!absentResult.ok) return
  assert.deepEqual(absentResult.eventMemberDays[0], {
    ...existingDay,
    participationStatus: 'absent',
  })

  const restoredDraft = createEventMemberSettingsDraft(
    event,
    [eventDays[1]],
    [eventMember],
    absentResult.eventMemberDays,
  )
  restoredDraft.members[0].days[0].participationStatus = 'participating'
  assert.deepEqual(
    restoredDraft.members[0].days[0].availabilityWindows,
    existingDay.availabilityWindows,
  )
  assert.deepEqual(
    restoredDraft.members[0].days[0].preferredTimeRange,
    existingDay.preferredTimeRange,
  )
})

test('日別詳細の不正TimeRangeを保存前に検出し、最初のMemberとEventDayを特定する', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const draft = createEventMemberSettingsDraft(
    event,
    eventDays,
    [eventMember],
    [],
  )
  draft.members[0].days[1].availabilityWindows = [
    { from: '17:00', until: '15:00' },
  ]
  const errors = validateEventMemberSettingsDraft({
    event,
    eventDays,
    members,
    eventMembers: [eventMember],
    eventMemberDays: [],
    draft,
  })
  const errorKey = getEventMemberDayDraftErrorKey(
    draft.members[0].draftId,
    'day-2',
  )

  assert.match(errors.days[errorKey], /開始時刻は終了時刻より前/)
  assert.deepEqual(
    getFirstEventMemberDayErrorTarget(errors, draft, [
      eventDays[1],
      eventDays[0],
    ]),
    {
      memberDraftId: draft.members[0].draftId,
      eventDayId: 'day-2',
      message: errors.days[errorKey],
    },
  )
})

test('選択Eventの詳細保存で別EventのEventMemberDayを変更しない', () => {
  const eventMember = createEventMember('event-member-1', 'member-1')
  const otherEventMember = createEventMember(
    'event-member-other',
    'member-2',
    otherEvent.id,
  )
  const selectedDay = createEventMemberDay(
    'selected-day',
    eventMember.id,
    'day-1',
  )
  const otherDay = createEventMemberDay(
    'other-day-data',
    otherEventMember.id,
    'other-day',
    'participating',
    { notes: '別イベントのメモ' },
  )
  const draft = createEventMemberSettingsDraft(
    event,
    [eventDays[1]],
    [eventMember],
    [selectedDay],
  )
  draft.members[0].days[0].notes = '選択イベントのメモ'

  const result = createEventMemberSettingsUpdate({
    event,
    eventDays: [eventDays[1]],
    members,
    eventMembers: [eventMember, otherEventMember],
    eventMemberDays: [selectedDay, otherDay],
    eventBands: [],
    draft,
    newEventMemberIds: [],
    newEventMemberDayIds: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.eventMemberDays.some((day) => day === otherDay))
})
