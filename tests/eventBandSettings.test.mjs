import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canChangeEventBandDay,
  canDeleteEventBand,
  createEventBandSettingsDraft,
  createEventBandSettingsUpdate,
  createEventOnlyBandDraft,
  createFixedBandDraft,
  getEventBandDayFeasibility,
  getEventBandSourceLabel,
  hasEventBandSettingsErrors,
  validateEventBandSettingsDraft,
} from '../src/domain/eventBandSettings.ts'
import {
  addPerformanceSlotMinute,
  normalizePerformanceSlotMinutes,
} from '../src/domain/eventStageSettings.ts'

const event = {
  id: 'event-1',
  name: '学園祭',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
  performanceSlotMinutes: [5, 10, 15],
}
const otherEvent = { ...event, id: 'event-2', name: '卒業ライブ' }
const eventDays = [
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
  { id: 'day-2', eventId: event.id, date: '2027-11-07', order: 1 },
  { id: 'other-day', eventId: otherEvent.id, date: '2027-12-01', order: 0 },
]
const members = [
  { id: 'member-1', realName: '佐藤', active: true },
  { id: 'member-2', realName: '鈴木', acaName: 'すず', active: true },
  { id: 'member-3', realName: '高橋', active: false },
]
const eventMembers = [
  { id: 'event-member-1', eventId: event.id, memberId: 'member-1' },
  { id: 'event-member-2', eventId: event.id, memberId: 'member-2' },
]
const defaultEventMemberDays = eventMembers.flatMap((eventMember) => [
  {
    id: `${eventMember.id}-day-1`,
    eventMemberId: eventMember.id,
    eventDayId: 'day-1',
    participationStatus: 'participating',
  },
  {
    id: `${eventMember.id}-day-2`,
    eventMemberId: eventMember.id,
    eventDayId: 'day-2',
    participationStatus: 'participating',
  },
])
const bands = [{
  id: 'band-choir',
  name: 'Choir',
  defaultMemberIds: ['member-1', 'member-2', 'member-3'],
  active: true,
}]

const createExistingEventBand = (overrides = {}) => ({
  id: 'event-band-1',
  eventId: event.id,
  eventDayId: 'day-1',
  bandId: 'band-choir',
  name: 'Choir',
  memberIds: ['member-1', 'member-2'],
  durationMinutes: 10,
  availableTimeRange: { from: '10:00', until: '17:00' },
  preferredTimeRange: { from: '13:00' },
  fixedPlacement: { stageId: 'stage-1', position: { kind: 'last' } },
  notes: '既存条件',
  ...overrides,
})

const createDraftItem = (overrides = {}) => ({
  draftId: 'draft-1',
  eventId: event.id,
  eventDayId: 'day-1',
  name: 'イベント企画',
  memberIds: ['member-1'],
  durationMinutes: '10',
  ...overrides,
})

const update = ({
  draft,
  configuredEvent = event,
  eventBands = [],
  eventMemberDays = defaultEventMemberDays,
  scheduleItems = [],
  newEventBandIds = [],
}) => createEventBandSettingsUpdate({
  event: configuredEvent,
  eventDays,
  members,
  bands,
  eventBands,
  eventMembers,
  eventMemberDays,
  scheduleItems,
  draft,
  newEventBandIds,
})

test('Eventごとの出演枠を正の整数として重複なく昇順に追加する', () => {
  assert.deepEqual(normalizePerformanceSlotMinutes([15, 5, 10, 5]), [5, 10, 15])

  const eventASlots = [5, 10, 15]
  const withSeven = addPerformanceSlotMinute(eventASlots, '7')
  assert.equal(withSeven.ok, true)
  if (!withSeven.ok) return
  const withNine = addPerformanceSlotMinute(withSeven.performanceSlotMinutes, '9')
  assert.equal(withNine.ok, true)
  if (!withNine.ok) return
  assert.deepEqual(withNine.performanceSlotMinutes, [5, 7, 9, 10, 15])
  assert.deepEqual(eventASlots, [5, 10, 15])

  for (const value of ['10', '0', '-1', '1.5', 'Infinity', '9007199254740992']) {
    assert.equal(addPerformanceSlotMinute(eventASlots, value).ok, false)
  }
})

test('固定Bandから名前・登録済みMemberだけをsnapshotし、出演枠は未選択にする', () => {
  const sourceBand = structuredClone(bands[0])
  const result = createFixedBandDraft({
    draftId: 'draft-fixed',
    event,
    eventDayId: 'day-1',
    band: sourceBand,
    eventMembers,
  })

  assert.deepEqual(result.draft, {
    draftId: 'draft-fixed',
    eventId: event.id,
    eventDayId: 'day-1',
    bandId: sourceBand.id,
    name: 'Choir',
    memberIds: ['member-1', 'member-2'],
    durationMinutes: '',
  })
  assert.deepEqual(result.unregisteredDefaultMemberIds, ['member-3'])
  assert.equal(getEventBandSourceLabel(result.draft), '固定バンド')
  assert.deepEqual(sourceBand, bands[0])

  sourceBand.name = 'New Choir'
  sourceBand.defaultMemberIds.push('member-4')
  assert.equal(result.draft.name, 'Choir')
  assert.deepEqual(result.draft.memberIds, ['member-1', 'member-2'])
  assert.equal(result.draft.durationMinutes, '')
})

test('企画バンドをbandIdなしのEventBandとして作成・保存できる', () => {
  const draftItem = {
    ...createEventOnlyBandDraft({
      draftId: 'event-only',
      event,
      eventDayId: 'day-2',
    }),
    name: '4年生企画',
    memberIds: ['member-1', 'member-2'],
    durationMinutes: '7',
  }
  const result = update({
    configuredEvent: { ...event, performanceSlotMinutes: [5, 7, 10, 15] },
    draft: { items: [draftItem] },
    newEventBandIds: ['event-band-new'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventBands, [{
    id: 'event-band-new',
    eventId: event.id,
    eventDayId: 'day-2',
    name: '4年生企画',
    memberIds: ['member-1', 'member-2'],
    durationMinutes: 7,
  }])
  assert.equal(getEventBandSourceLabel(result.eventBands[0]), '企画バンド')
})

test('新規EventBandはEventの出演枠から選び、custom枠もdurationへ保存する', () => {
  for (const durationMinutes of [5, 10, 9]) {
    const result = update({
      configuredEvent: { ...event, performanceSlotMinutes: [5, 9, 10, 15] },
      draft: { items: [createDraftItem({ durationMinutes: String(durationMinutes) })] },
      newEventBandIds: [`event-band-${durationMinutes}`],
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.eventBands[0].durationMinutes, durationMinutes)
    }
  }

  const unconfigured = update({
    draft: { items: [createDraftItem({ durationMinutes: '9' })] },
    newEventBandIds: ['event-band-invalid-slot'],
  })
  assert.equal(unconfigured.ok, false)
  if (!unconfigured.ok) {
    assert.match(unconfigured.errors.items['draft-1'].durationMinutes, /出演枠/)
  }
})

test('空name・不正duration・0人・Member重複・不正EventDayを拒否する', () => {
  const draft = {
    items: [createDraftItem({
      name: '   ',
      durationMinutes: '0',
      memberIds: [],
      eventDayId: 'other-day',
    })],
  }
  const errors = validateEventBandSettingsDraft({
    draft,
    event,
    eventDays,
    members,
    bands,
    eventMembers,
    eventMemberDays: defaultEventMemberDays,
  })
  assert.equal(hasEventBandSettingsErrors(errors), true)
  assert.ok(errors.items['draft-1'].name)
  assert.ok(errors.items['draft-1'].durationMinutes)
  assert.ok(errors.items['draft-1'].memberIds)
  assert.ok(errors.items['draft-1'].eventDayId)

  const duplicateErrors = validateEventBandSettingsDraft({
    draft: {
      items: [createDraftItem({ memberIds: ['member-1', 'member-1'] })],
    },
    event,
    eventDays,
    members,
    bands,
    eventMembers,
    eventMemberDays: defaultEventMemberDays,
  })
  assert.ok(duplicateErrors.items['draft-1'].memberIds)
})

test('同じ固定Bandを別日または同日に複数出演として保存できる', () => {
  const items = [
    createDraftItem({ draftId: 'one', bandId: 'band-choir', name: 'Choir', eventDayId: 'day-1' }),
    createDraftItem({ draftId: 'two', bandId: 'band-choir', name: 'Choir', eventDayId: 'day-2' }),
    createDraftItem({ draftId: 'three', bandId: 'band-choir', name: 'Choir 2枠目', eventDayId: 'day-1' }),
  ]
  const result = update({
    draft: { items },
    newEventBandIds: ['event-band-1', 'event-band-2', 'event-band-3'],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.eventBands.length, 3)
  assert.ok(result.eventBands.every((eventBand) => eventBand.bandId === 'band-choir'))
})

test('編集でIDとbandIdと既存条件を維持し、snapshot項目だけ変更する', () => {
  const existing = createExistingEventBand()
  const draft = createEventBandSettingsDraft(event, [existing])
  Object.assign(draft.items[0], {
    name: '今回だけ5人編成',
    memberIds: ['member-1'],
    durationMinutes: '15',
  })
  const result = update({ draft, eventBands: [existing] })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventBands[0], {
    ...existing,
    name: '今回だけ5人編成',
    memberIds: ['member-1'],
    durationMinutes: 15,
  })
})

test('既存EventBandも設定済み出演枠だけへ変更でき、option外durationを拒否する', () => {
  const existing = createExistingEventBand()
  const validDraft = createEventBandSettingsDraft(event, [existing])
  validDraft.items[0].durationMinutes = '15'
  const valid = update({ draft: validDraft, eventBands: [existing] })
  assert.equal(valid.ok, true)
  if (valid.ok) assert.equal(valid.eventBands[0].durationMinutes, 15)

  const invalidDraft = createEventBandSettingsDraft(event, [existing])
  invalidDraft.items[0].durationMinutes = '13'
  const invalid = update({ draft: invalidDraft, eventBands: [existing] })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) {
    assert.match(invalid.errors.items[invalidDraft.items[0].draftId].durationMinutes, /出演枠/)
  }

  const inconsistent = createExistingEventBand({ durationMinutes: 9 })
  const inconsistentResult = update({
    draft: createEventBandSettingsDraft(event, [inconsistent]),
    eventBands: [inconsistent],
  })
  assert.equal(inconsistentResult.ok, false)
})

test('未配置なら出演日を変更でき、配置済みならUI判定と保存処理で拒否する', () => {
  const existing = createExistingEventBand({ fixedPlacement: undefined })
  const scheduleItems = [{
    id: 'schedule-1',
    stageId: 'stage-1',
    order: 0,
    kind: 'performance',
    eventBandId: existing.id,
  }]
  assert.equal(canChangeEventBandDay(existing, []), true)
  assert.equal(canChangeEventBandDay(existing, scheduleItems), false)

  const draft = createEventBandSettingsDraft(event, [existing])
  draft.items[0].eventDayId = 'day-2'
  const unplaced = update({ draft, eventBands: [existing] })
  assert.equal(unplaced.ok, true)
  if (unplaced.ok) assert.equal(unplaced.eventBands[0].eventDayId, 'day-2')

  const placed = update({ draft, eventBands: [existing], scheduleItems })
  assert.equal(placed.ok, false)
  if (!placed.ok) assert.ok(placed.errors.items[draft.items[0].draftId].eventDayId)
})

test('fixedPlacementがある既存EventBandは出演日変更を拒否し、同日の編集では設定を維持する', () => {
  const existing = createExistingEventBand()
  assert.equal(canChangeEventBandDay(existing, []), false)

  const movedDraft = createEventBandSettingsDraft(event, [existing])
  movedDraft.items[0].eventDayId = 'day-2'
  const moved = update({ draft: movedDraft, eventBands: [existing] })
  assert.equal(moved.ok, false)
  if (!moved.ok) {
    assert.match(
      moved.errors.items[movedDraft.items[0].draftId].eventDayId,
      /固定配置/,
    )
  }

  const editedDraft = createEventBandSettingsDraft(event, [existing])
  Object.assign(editedDraft.items[0], {
    name: '固定配置を維持する編集',
    memberIds: ['member-1'],
    durationMinutes: '15',
  })
  const edited = update({ draft: editedDraft, eventBands: [existing] })
  assert.equal(edited.ok, true)
  if (!edited.ok) return
  assert.deepEqual(edited.eventBands[0].fixedPlacement, existing.fixedPlacement)
  assert.equal(edited.eventBands[0].eventDayId, existing.eventDayId)
})

test('未配置EventBandだけ削除でき、配置済み削除は保存処理でも拒否する', () => {
  const existing = createExistingEventBand()
  const scheduleItems = [{
    id: 'schedule-1',
    stageId: 'stage-1',
    order: 0,
    kind: 'performance',
    eventBandId: existing.id,
  }]
  assert.equal(canDeleteEventBand(existing.id, []), true)
  assert.equal(canDeleteEventBand(existing.id, scheduleItems), false)
  assert.equal(update({ draft: { items: [] }, eventBands: [existing] }).ok, true)

  const blocked = update({
    draft: { items: [] },
    eventBands: [existing],
    scheduleItems,
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.errors.form, /配置/)
})

test('選択Eventだけdraft化し、保存しても別EventのEventBandを維持する', () => {
  const existing = createExistingEventBand()
  const other = createExistingEventBand({
    id: 'other-event-band',
    eventId: otherEvent.id,
    eventDayId: 'other-day',
    name: '別イベント',
  })
  const draft = createEventBandSettingsDraft(event, [other, existing])
  assert.deepEqual(draft.items.map((item) => item.eventBandId), [existing.id])
  draft.items[0].name = '編集後'

  const result = update({ draft, eventBands: [other, existing] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.eventBands.find((item) => item.id === other.id), other)
  assert.equal(result.eventBands.find((item) => item.id === existing.id)?.name, '編集後')
})

test('固定バンドと企画バンドを複数日へ別IDのEventBandとして一括保存する', () => {
  const fixed = {
    ...createFixedBandDraft({
    draftId: 'fixed-day-1',
    event,
    eventDayId: 'day-1',
    band: bands[0],
    eventMembers,
    }).draft,
    durationMinutes: '10',
  }
  const fixedResult = update({
    draft: {
      items: [
        fixed,
        { ...fixed, draftId: 'fixed-day-2', eventDayId: 'day-2' },
      ],
    },
    newEventBandIds: ['fixed-event-band-1', 'fixed-event-band-2'],
  })
  assert.equal(fixedResult.ok, true)
  if (!fixedResult.ok) return
  assert.deepEqual(
    fixedResult.eventBands.map(({ id, eventDayId, bandId, name, memberIds, durationMinutes }) => ({
      id,
      eventDayId,
      bandId,
      name,
      memberIds,
      durationMinutes,
    })),
    [
      {
        id: 'fixed-event-band-1',
        eventDayId: 'day-1',
        bandId: 'band-choir',
        name: 'Choir',
        memberIds: ['member-1', 'member-2'],
        durationMinutes: 10,
      },
      {
        id: 'fixed-event-band-2',
        eventDayId: 'day-2',
        bandId: 'band-choir',
        name: 'Choir',
        memberIds: ['member-1', 'member-2'],
        durationMinutes: 10,
      },
    ],
  )

  const eventOnly = {
    ...createEventOnlyBandDraft({
      draftId: 'event-only-day-1',
      event,
      eventDayId: 'day-1',
    }),
    name: '学祭企画',
    memberIds: ['member-1'],
    durationMinutes: '8',
  }
  const eventOnlyResult = update({
    configuredEvent: { ...event, performanceSlotMinutes: [5, 8, 10, 15] },
    draft: {
      items: [
        eventOnly,
        { ...eventOnly, draftId: 'event-only-day-2', eventDayId: 'day-2' },
      ],
    },
    newEventBandIds: ['event-only-band-1', 'event-only-band-2'],
  })
  assert.equal(eventOnlyResult.ok, true)
  if (!eventOnlyResult.ok) return
  assert.deepEqual(
    eventOnlyResult.eventBands.map((eventBand) => eventBand.bandId),
    [undefined, undefined],
  )
  assert.notEqual(
    eventOnlyResult.eventBands[0].id,
    eventOnlyResult.eventBands[1].id,
  )
})

const eventMemberDaysFor = (definitions) => definitions.map((definition) => ({
  id: `event-member-day-${definition.eventMemberId}-${definition.eventDayId}`,
  participationStatus: 'participating',
  ...definition,
}))

const feasibility = ({
  eventDayId = 'day-1',
  memberIds = ['member-1', 'member-2'],
  durationMinutes = 10,
  configuredEventMembers = eventMembers,
  eventMemberDays: configuredDays,
}) => getEventBandDayFeasibility({
  event,
  eventDayId,
  memberIds,
  durationMinutes,
  members,
  eventMembers: configuredEventMembers,
  eventMemberDays: configuredDays,
})

test('全員終日なら共通availabilityも終日になる', () => {
  const result = feasibility({
    eventMemberDays: eventMemberDaysFor([
      { eventMemberId: 'event-member-1', eventDayId: 'day-1' },
      { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(result.status, 'available')
  assert.equal(result.commonAvailabilityWindows, undefined)
})

test('2人・3人の単一windowから共通availabilityの積集合を求める', () => {
  const twoMembers = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '10:00', until: '15:00' }],
      },
      {
        eventMemberId: 'event-member-2',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '12:00', until: '16:00' }],
      },
    ]),
  })
  assert.deepEqual(twoMembers.commonAvailabilityWindows, [
    { from: '12:00', until: '15:00' },
  ])

  const memberThree = {
    id: 'event-member-3',
    eventId: event.id,
    memberId: 'member-3',
  }
  const threeMembers = feasibility({
    memberIds: ['member-1', 'member-2', 'member-3'],
    configuredEventMembers: [...eventMembers, memberThree],
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '10:00', until: '15:00' }],
      },
      {
        eventMemberId: 'event-member-2',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '12:00', until: '16:00' }],
      },
      {
        eventMemberId: 'event-member-3',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '13:00', until: '17:00' }],
      },
    ]),
  })
  assert.deepEqual(threeMembers.commonAvailabilityWindows, [
    { from: '13:00', until: '15:00' },
  ])
})

test('複数window同士とopen-ended windowの積集合を求める', () => {
  const multiple = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [
          { from: '10:00', until: '12:00' },
          { from: '15:00', until: '18:00' },
        ],
      },
      {
        eventMemberId: 'event-member-2',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '11:00', until: '16:00' }],
      },
    ]),
  })
  assert.deepEqual(multiple.commonAvailabilityWindows, [
    { from: '11:00', until: '12:00' },
    { from: '15:00', until: '16:00' },
  ])

  const openEnded = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '13:00' }],
      },
      {
        eventMemberId: 'event-member-2',
        eventDayId: 'day-1',
        availabilityWindows: [{ until: '17:00' }],
      },
    ]),
  })
  assert.deepEqual(openEnded.commonAvailabilityWindows, [
    { from: '13:00', until: '17:00' },
  ])
})

test('空availabilityまたは交差しないwindowがあれば出演不可になる', () => {
  const empty = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [],
      },
      { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(empty.status, 'blocked')
  assert.deepEqual(empty.commonAvailabilityWindows, [])

  const disjoint = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [{ until: '10:00' }],
      },
      {
        eventMemberId: 'event-member-2',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '11:00' }],
      },
    ]),
  })
  assert.equal(disjoint.status, 'blocked')
  assert.deepEqual(disjoint.commonAvailabilityWindows, [])
})

test('共通windowが出演時間以上なら許可し、短い場合だけblockする', () => {
  const configuredDays = eventMemberDaysFor([
    {
      eventMemberId: 'event-member-1',
      eventDayId: 'day-1',
      availabilityWindows: [{ from: '13:00', until: '13:10' }],
    },
    { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
  ])
  assert.equal(feasibility({ durationMinutes: 9, eventMemberDays: configuredDays }).status, 'available')
  assert.equal(feasibility({ durationMinutes: 10, eventMemberDays: configuredDays }).status, 'available')
  assert.equal(feasibility({ durationMinutes: 11, eventMemberDays: configuredDays }).status, 'blocked')
})

test('不参加・日別設定不足はblockし、未定はwarningだが保存可能と判定する', () => {
  const absent = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        participationStatus: 'absent',
      },
      { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(absent.status, 'blocked')
  assert.match(absent.blockingReasons[0], /佐藤.*不参加/)

  const missing = feasibility({
    eventMemberDays: eventMemberDaysFor([
      { eventMemberId: 'event-member-1', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(missing.status, 'blocked')
  assert.match(missing.blockingReasons[0], /鈴木.*参加設定/)

  const undecided = feasibility({
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        participationStatus: 'undecided',
      },
      { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(undecided.status, 'warning')
  assert.match(undecided.warnings[0], /佐藤.*未定/)
})

test('日別の参加設定を混ぜずDay1とDay2を独立して判定する', () => {
  const configuredDays = eventMemberDaysFor([
    { eventMemberId: 'event-member-1', eventDayId: 'day-1' },
    { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    {
      eventMemberId: 'event-member-1',
      eventDayId: 'day-2',
      participationStatus: 'absent',
    },
    { eventMemberId: 'event-member-2', eventDayId: 'day-2' },
  ])
  assert.equal(feasibility({ eventDayId: 'day-1', eventMemberDays: configuredDays }).status, 'available')
  assert.equal(feasibility({ eventDayId: 'day-2', eventMemberDays: configuredDays }).status, 'blocked')
})

test('新規EventBandの保存でも日別blockを拒否し、undecided警告だけなら許可する', () => {
  const draft = { items: [createDraftItem()] }
  const absentDays = eventMemberDaysFor([
    {
      eventMemberId: 'event-member-1',
      eventDayId: 'day-1',
      participationStatus: 'absent',
    },
  ])
  const blocked = update({
    draft,
    eventMemberDays: absentDays,
    newEventBandIds: ['blocked-band'],
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.match(blocked.errors.items['draft-1'].form, /不参加/)
  }

  const undecidedDays = eventMemberDaysFor([
    {
      eventMemberId: 'event-member-1',
      eventDayId: 'day-1',
      participationStatus: 'undecided',
    },
  ])
  const allowed = update({
    draft,
    eventMemberDays: undecidedDays,
    newEventBandIds: ['warning-band'],
  })
  assert.equal(allowed.ok, true)
})

test('既存EventBand編集でもduration・Member・出演日のfeasibilityを再判定する', () => {
  const existing = createExistingEventBand({ durationMinutes: 5 })

  const longerDraft = createEventBandSettingsDraft(event, [existing])
  longerDraft.items[0].durationMinutes = '15'
  const longer = update({
    draft: longerDraft,
    eventBands: [existing],
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        availabilityWindows: [{ from: '10:00', until: '10:10' }],
      },
      { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(longer.ok, false)

  const absentDraft = createEventBandSettingsDraft(event, [existing])
  const absent = update({
    draft: absentDraft,
    eventBands: [existing],
    eventMemberDays: eventMemberDaysFor([
      { eventMemberId: 'event-member-1', eventDayId: 'day-1' },
      {
        eventMemberId: 'event-member-2',
        eventDayId: 'day-1',
        participationStatus: 'absent',
      },
    ]),
  })
  assert.equal(absent.ok, false)

  const movedDraft = createEventBandSettingsDraft(event, [existing])
  movedDraft.items[0].eventDayId = 'day-2'
  const moved = update({
    draft: movedDraft,
    eventBands: [existing],
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-2',
        participationStatus: 'absent',
      },
      { eventMemberId: 'event-member-2', eventDayId: 'day-2' },
    ]),
  })
  assert.equal(moved.ok, false)

  const undecidedDraft = createEventBandSettingsDraft(event, [existing])
  const undecided = update({
    draft: undecidedDraft,
    eventBands: [existing],
    eventMemberDays: eventMemberDaysFor([
      {
        eventMemberId: 'event-member-1',
        eventDayId: 'day-1',
        participationStatus: 'undecided',
      },
      { eventMemberId: 'event-member-2', eventDayId: 'day-1' },
    ]),
  })
  assert.equal(undecided.ok, true)
})
