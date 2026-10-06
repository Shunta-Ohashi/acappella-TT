import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv } from '../src/csv/csv.ts'
import {
  EVENT_MEMBER_CSV_HEADERS,
  createEventMemberCsv,
  planEventMemberCsvImport,
} from '../src/csv/eventMemberCsv.ts'
import {
  EVENT_BAND_CSV_HEADERS,
  createEventBandCsv,
  planEventBandCsvImport,
} from '../src/csv/eventBandCsv.ts'
import { createEventMemberSettingsDraft } from '../src/domain/eventMemberSettings.ts'
import {
  createEventBandSettingsDraft,
  createEventBandSettingsUpdate,
} from '../src/domain/eventBandSettings.ts'

const event = {
  id: 'event-1', name: 'CSV Live', timeZone: 'Asia/Tokyo',
  validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
  performanceSlotMinutes: [10, 15],
}
const otherEvent = { ...event, id: 'event-2', name: 'Other' }
const eventDays = [
  { id: 'day-2', eventId: event.id, date: '2027-11-02', label: 'Day 2', order: 1 },
  { id: 'day-1', eventId: event.id, date: '2027-11-01', label: 'Day 1', order: 0 },
  { id: 'foreign-day', eventId: otherEvent.id, date: '2027-12-01', order: 0 },
]
const members = [
  { id: 'member-1', realName: '佐藤 花子', acaName: 'はな', active: true },
  { id: 'member-2', realName: '鈴木 蓮', acaName: 'れん', active: true },
  { id: 'member-3', realName: '高橋 葵', acaName: 'あおい', active: true },
]
const eventMembers = [
  { id: 'em-1', eventId: event.id, memberId: 'member-1', paCapabilities: { main: true, sub: false } },
  { id: 'em-2', eventId: event.id, memberId: 'member-2', paCapabilities: { main: false, sub: true } },
]
const eventMemberDays = eventMembers.flatMap((eventMember) => ['day-1', 'day-2'].map((eventDayId) => ({
  id: `${eventMember.id}-${eventDayId}`,
  eventMemberId: eventMember.id,
  eventDayId,
  participationStatus: 'participating',
})))
const bands = [{
  id: 'band-1', name: 'Fixed', defaultMemberIds: ['member-1'], active: true,
}]
const existingEventBands = [{
  id: 'event-band-1', eventId: event.id, eventDayId: 'day-1', bandId: 'band-1',
  name: 'Existing', memberIds: ['member-1'], durationMinutes: 10,
  availableTimeRange: { from: '10:00', until: '15:00' },
  preferredTimeRange: { from: '12:00', until: '13:00' },
  fixedPlacement: { stageId: 'stage-1', position: { kind: 'first' } },
  notes: 'Step 5 condition',
}]

const eventMemberCsv = (rows) => [EVENT_MEMBER_CSV_HEADERS.join(','), ...rows].join('\n')
const eventBandCsv = (rows) => [EVENT_BAND_CSV_HEADERS.join(','), ...rows].join('\n')
const makeMemberDraft = () => createEventMemberSettingsDraft(
  event, eventDays, eventMembers, eventMemberDays,
)
const makeBandDraft = () => createEventBandSettingsDraft(event, existingEventBands)

test('Event Member CSVは1 Member × 全EventDayを順序付きでexportする', () => {
  const draft = makeMemberDraft()
  const parsed = parseCsv(createEventMemberCsv({ event, eventDays, members, draft }))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...EVENT_MEMBER_CSV_HEADERS])
  assert.equal(parsed.rows.length, 1 + draft.members.length * 2)
  assert.deepEqual(parsed.rows.slice(1, 3).map((row) => row.cells[3]), ['day-1', 'day-2'])
})

test('Event Member importはID・日付fallback・status・PA・time rangeを解釈する', () => {
  const draft = makeMemberDraft()
  const result = planEventMemberCsvImport({
    csv: eventMemberCsv([
      'member-1,ignored,,day-1,,,参加,可,不可,09:00-11:00|13:00-,-17:00,note',
      ',鈴木 蓮,,,2027-11-02,,undecided,false,yes,,,',
    ]),
    event, eventDays, members, eventMembers, eventMemberDays, draft,
    createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.updatedCount, 2)
  const first = result.candidate.members.find((item) => item.memberId === 'member-1')
  assert.deepEqual(first.paCapabilities, { main: true, sub: false })
  assert.deepEqual(first.days.find((day) => day.eventDayId === 'day-1'), {
    eventMemberDayId: 'em-1-day-1',
    eventDayId: 'day-1',
    participationStatus: 'participating',
    availabilityWindows: [{ from: '09:00', until: '11:00' }, { from: '13:00' }],
    preferredTimeRange: { until: '17:00' },
    notes: 'note',
  })
})

test('Event Member importはacaName fallbackを使い、新規Memberの未記載日をundecidedにする', () => {
  const result = planEventMemberCsvImport({
    csv: eventMemberCsv([',存在しない本名,あおい,day-1,,,参加,不可,不可,,,']),
    event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
    createDraftId: () => 'draft-new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  const added = result.candidate.members.find((item) => item.memberId === 'member-3')
  assert.equal(added.days.find((day) => day.eventDayId === 'day-2').participationStatus, 'undecided')
  assert.equal(result.candidate.members.some((item) => item.memberId === 'member-2'), true)
})

test('Event Member importはambiguous name・foreign day・duplicate pairをrejectする', () => {
  const ambiguousMembers = [...members, { id: 'member-4', realName: '別人', acaName: 'あおい', active: true }]
  const cases = [
    { csv: eventMemberCsv([',,あおい,day-1,,,参加,不可,不可,,,']), configuredMembers: ambiguousMembers },
    { csv: eventMemberCsv(['member-1,,,foreign-day,,,参加,可,不可,,,']), configuredMembers: members },
    { csv: eventMemberCsv(['member-1,,,day-1,,,参加,可,不可,,,', 'member-1,,,day-1,,,参加,可,不可,,,']), configuredMembers: members },
  ]
  for (const item of cases) {
    const result = planEventMemberCsvImport({
      csv: item.csv, event, eventDays, members: item.configuredMembers,
      eventMembers, eventMemberDays, draft: makeMemberDraft(), createDraftId: () => 'new',
    })
    assert.equal(result.ok, false)
  }
})

test('Event Member importは同じMemberの日別PA不一致とdomain invalid rangeをatomicにrejectする', () => {
  const before = makeMemberDraft()
  const result = planEventMemberCsvImport({
    csv: eventMemberCsv([
      'member-1,,,day-1,,,参加,可,不可,17:00-09:00,,',
      'member-1,,,day-2,,,参加,不可,不可,,,',
    ]),
    event, eventDays, members, eventMembers, eventMemberDays, draft: before,
    createDraftId: () => 'unused',
  })
  assert.equal(result.ok, false)
  assert.deepEqual(before, makeMemberDraft())
})

test('Event Member importはmerge後のcandidate全体をdomain validationへ通す', () => {
  const draft = makeMemberDraft()
  draft.members[1].days = draft.members[1].days.slice(0, 1)
  const result = planEventMemberCsvImport({
    csv: eventMemberCsv(['member-1,,,day-1,,,参加,可,不可,,,']),
    event, eventDays, members, eventMembers, eventMemberDays, draft,
    createDraftId: () => 'unused',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors.some((error) => error.message.includes('開催日')), true)
})

test('Event Band CSVはeditable fieldsをexportする', () => {
  const parsed = parseCsv(createEventBandCsv({ event, eventDays, members, draft: makeBandDraft() }))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...EVENT_BAND_CSV_HEADERS])
  assert.deepEqual(parsed.rows[1].cells.slice(0, 7), [
    'event-band-1', 'day-1', '2027-11-01', 'Day 1', 'band-1', 'Existing', 'member-1',
  ])
})

test('Event Band importは既存更新・空ID新規・日付fallbackをmergeする', () => {
  const before = makeBandDraft()
  let index = 0
  const result = planEventBandCsvImport({
    csv: eventBandCsv([
      'event-band-1,day-1,,,band-1,Updated,member-1,,10',
      ',,2027-11-02,,,New,,鈴木 蓮,15',
    ]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: before,
    createDraftId: () => `draft-${index += 1}`,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  assert.equal(result.updatedCount, 1)
  assert.equal(result.candidate.items.length, 2)
  assert.equal(result.candidate.items.find((item) => !item.eventBandId).eventDayId, 'day-2')
  assert.deepEqual(before, makeBandDraft())
})

test('Event Band importは未知existing ID・foreign day・missing fixed Bandをrejectする', () => {
  const rows = [
    'missing,day-1,,,,Name,member-1,,10',
    ',foreign-day,,,,Name,member-1,,10',
    ',day-1,,,missing-band,Name,member-1,,10',
  ]
  for (const row of rows) {
    const result = planEventBandCsvImport({
      csv: eventBandCsv([row]), event, eventDays, bands, members, eventMembers,
      eventMemberDays, eventBands: existingEventBands, draft: makeBandDraft(),
      createDraftId: () => 'new',
    })
    assert.equal(result.ok, false)
  }
})

test('Event Band importは既存bandId変更・invalid duration・未登録EventMemberをrejectする', () => {
  const rows = [
    'event-band-1,day-1,,,,Changed,member-1,,10',
    ',day-1,,,,Bad duration,member-1,,11',
    ',day-1,,,,Unregistered,member-3,,10',
  ]
  for (const row of rows) {
    const result = planEventBandCsvImport({
      csv: eventBandCsv([row]), event, eventDays, bands, members, eventMembers,
      eventMemberDays, eventBands: existingEventBands, draft: makeBandDraft(),
      createDraftId: () => 'new',
    })
    assert.equal(result.ok, false)
  }
})

test('Event Band import後の既存save semanticsはStep 5 conditionsを維持する', () => {
  const plan = planEventBandCsvImport({
    csv: eventBandCsv(['event-band-1,day-1,,,band-1,Renamed,member-1,,10']),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  const update = createEventBandSettingsUpdate({
    draft: plan.candidate,
    event,
    eventDays,
    members,
    bands,
    eventMembers,
    eventMemberDays,
    eventBands: existingEventBands,
    scheduleItems: [],
    timetableOrderConstraints: [],
    newEventBandIds: [],
  })
  assert.equal(update.ok, true)
  if (!update.ok) return
  const saved = update.eventBands.find((item) => item.id === 'event-band-1')
  assert.equal(saved.name, 'Renamed')
  assert.deepEqual(saved.availableTimeRange, existingEventBands[0].availableTimeRange)
  assert.deepEqual(saved.preferredTimeRange, existingEventBands[0].preferredTimeRange)
  assert.deepEqual(saved.fixedPlacement, existingEventBands[0].fixedPlacement)
  assert.equal(saved.notes, 'Step 5 condition')
})

test('Event Band importはCSVにないdraft rowを維持しinvalid rowではcandidateを返さない', () => {
  const draft = { items: [
    ...makeBandDraft().items,
    { draftId: 'existing-new', eventId: event.id, eventDayId: 'day-2', name: 'Omitted', memberIds: ['member-2'], durationMinutes: '10' },
  ] }
  const valid = planEventBandCsvImport({
    csv: eventBandCsv(['event-band-1,day-1,,,band-1,Updated,member-1,,10']),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'unused',
  })
  assert.equal(valid.ok, true)
  if (valid.ok) assert.equal(valid.candidate.items.some((item) => item.draftId === 'existing-new'), true)
  const invalid = planEventBandCsvImport({
    csv: eventBandCsv([',day-1,,,,Bad,missing,,10']),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'new',
  })
  assert.equal(invalid.ok, false)
  assert.equal('candidate' in invalid, false)
})
