import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv, serializeCsv } from '../src/csv/csv.ts'
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

const csv = (headers, rows) => serializeCsv([headers, ...rows])
const makeMemberDraft = () => createEventMemberSettingsDraft(
  event, eventDays, eventMembers, eventMemberDays,
)
const makeBandDraft = () => createEventBandSettingsDraft(event, existingEventBands)

test('Event Member exportは簡略headerと右端IDで1 Member × 全EventDayを出力する', () => {
  const draft = makeMemberDraft()
  const parsed = parseCsv(createEventMemberCsv({ event, eventDays, members, draft }))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...EVENT_MEMBER_CSV_HEADERS])
  assert.deepEqual(parsed.rows[0].cells.slice(-2), ['メンバーID', '開催日ID'])
  assert.equal(parsed.rows[0].cells.includes('本名'), false)
  assert.equal(parsed.rows[0].cells.includes('開催日ラベル'), false)
  assert.equal(parsed.rows.length, 1 + draft.members.length * 2)
  assert.deepEqual(parsed.rows.slice(1, 3).map((row) => row.cells.at(-1)), ['day-1', 'day-2'])
})

test('Event MemberのExportは技術IDを使ってそのまま再Importできる', () => {
  const draft = makeMemberDraft()
  const result = planEventMemberCsvImport({
    csv: createEventMemberCsv({ event, eventDays, members, draft }),
    event, eventDays, members, eventMembers, eventMemberDays, draft,
    createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 0)
  assert.equal(result.updatedCount, draft.members.length)
  assert.deepEqual(result.candidate, draft)
})

test('Event Memberはavailabilityのblank・なし・通常・複数・片側rangeを区別してround-tripする', () => {
  const cases = [
    { value: undefined, exported: '' },
    { value: [], exported: 'なし' },
    { value: [{ from: '09:00', until: '12:00' }], exported: '09:00-12:00' },
    {
      value: [{ from: '09:00', until: '11:00' }, { from: '13:00', until: '17:00' }],
      exported: '09:00-11:00|13:00-17:00',
    },
    { value: [{ from: '13:00' }], exported: '13:00-' },
  ]
  for (const { value, exported: expectedCell } of cases) {
    const draft = makeMemberDraft()
    const targetDay = draft.members[0].days[0]
    if (value === undefined) delete targetDay.availabilityWindows
    else targetDay.availabilityWindows = value
    const before = structuredClone(draft)
    const source = createEventMemberCsv({ event, eventDays, members, draft })
    const parsed = parseCsv(source)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) continue
    const header = parsed.rows[0].cells
    const row = parsed.rows.slice(1).find((candidate) =>
      candidate.cells[header.indexOf('メンバーID')] === 'member-1' &&
      candidate.cells[header.indexOf('開催日ID')] === 'day-1')
    assert.equal(row?.cells[header.indexOf('出演可能時間帯')], expectedCell)

    const imported = planEventMemberCsvImport({
      csv: source, event, eventDays, members, eventMembers, eventMemberDays, draft,
      createDraftId: () => 'unused',
    })
    assert.equal(imported.ok, true, JSON.stringify(imported))
    if (imported.ok) assert.deepEqual(imported.candidate, draft)
    assert.deepEqual(draft, before)
  }
})

test('Event Memberは「なし」とNONEを明示的な出演可能時間なしとしてImportする', () => {
  for (const value of ['なし', 'NONE']) {
    const result = planEventMemberCsvImport({
      csv: csv(['メンバー', '開催日', '参加状態', '出演可能時間帯'], [[
        'はな', '2027-11-01', '参加', value,
      ]]),
      event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
      createDraftId: () => 'unused',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) {
      const day = result.candidate.members.find((item) => item.memberId === 'member-1')
        .days.find((item) => item.eventDayId === 'day-1')
      assert.deepEqual(day.availabilityWindows, [])
    }
  }
})

test('Event Memberのhuman member列は本名を使いcross-field collisionを避ける', () => {
  const configuredMembers = members.map((member) => member.id === 'member-1'
    ? { ...member, realName: '山田太郎', acaName: 'たろう' }
    : member.id === 'member-2'
      ? { ...member, realName: 'たろう', acaName: 'びー' }
      : member)
  const exported = parseCsv(createEventMemberCsv({
    event, eventDays, members: configuredMembers, draft: makeMemberDraft(),
  }))
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  const memberOneRow = exported.rows.slice(1).find((row) => row.cells.at(-2) === 'member-1')
  assert.equal(memberOneRow?.cells[0], '山田太郎')

  const imported = planEventMemberCsvImport({
    csv: csv(['メンバー', '開催日', '参加状態'], [['山田太郎', '2027-11-01', '未定']]),
    event, eventDays, members: configuredMembers, eventMembers, eventMemberDays,
    draft: makeMemberDraft(), createDraftId: () => 'unused',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) {
    assert.equal(imported.candidate.members.find((item) => item.memberId === 'member-1')
      .days.find((day) => day.eventDayId === 'day-1').participationStatus, 'undecided')
    assert.equal(imported.candidate.members.find((item) => item.memberId === 'member-2')
      .days.find((day) => day.eventDayId === 'day-1').participationStatus, 'participating')
  }

  const ambiguous = planEventMemberCsvImport({
    csv: csv(['メンバー', '開催日', '参加状態'], [['山田太郎', '2027-11-01', '参加']]),
    event, eventDays,
    members: [...configuredMembers, {
      id: 'member-4', realName: '山田太郎', acaName: 'しー', active: true,
    }],
    eventMembers, eventMemberDays, draft: makeMemberDraft(), createDraftId: () => 'unused',
  })
  assert.equal(ambiguous.ok, false)
})

test('Event Memberのformula-likeなhuman文字列を安全化しImportで詳細を復元する', () => {
  const configuredMembers = members.map((member) => member.id === 'member-1'
    ? { ...member, realName: '@MEMBER' }
    : member)
  const draft = makeMemberDraft()
  draft.members[0].days[0].notes = '=NOTE'
  const csvSource = createEventMemberCsv({ event, eventDays, members: configuredMembers, draft })
  const exported = parseCsv(csvSource)
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  const row = exported.rows.slice(1).find((candidate) => candidate.cells.at(-2) === 'member-1')
  assert.equal(row?.cells[0], "'@MEMBER")
  assert.equal(row?.cells[7], "'=NOTE")

  const imported = planEventMemberCsvImport({
    csv: csvSource, event, eventDays, members: configuredMembers, eventMembers, eventMemberDays,
    draft, createDraftId: () => 'unused',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) assert.equal(imported.candidate.members[0].days[0].notes, '=NOTE')
})

test('Event Memberはメンバー・開催日・参加状態だけでname/date resolutionできる', () => {
  const result = planEventMemberCsvImport({
    csv: csv(['メンバー', '開催日', '参加状態'], [['あおい', '2027-11-01', '参加']]),
    event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
    createDraftId: () => 'draft-new',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  const added = result.candidate.members.find((item) => item.memberId === 'member-3')
  assert.deepEqual(added.paCapabilities, { main: false, sub: false })
  assert.equal(added.days.find((day) => day.eventDayId === 'day-2').participationStatus, 'undecided')
})

test('Event MemberはメンバーIDと開催日IDを名称より優先する', () => {
  const result = planEventMemberCsvImport({
    csv: csv(EVENT_MEMBER_CSV_HEADERS, [[
      '存在しない名前', '2099-01-01', '参加', '可', '不可', '', '', '', 'member-1', 'day-1',
    ]]),
    event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
    createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.candidate.members.find((item) => item.memberId === 'member-1').days[0].eventDayId, 'day-1')
})

test('Event Memberはstatus・PA・複数/open time rangeを維持する', () => {
  const result = planEventMemberCsvImport({
    csv: csv(EVENT_MEMBER_CSV_HEADERS, [[
      'はな', '2027-11-01', '参加', '可', '不可', '09:00-11:00|13:00-', '-17:00', 'note', '', '',
    ]]),
    event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
    createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const first = result.candidate.members.find((item) => item.memberId === 'member-1')
  assert.deepEqual(first.days.find((day) => day.eventDayId === 'day-1'), {
    eventMemberDayId: 'em-1-day-1', eventDayId: 'day-1', participationStatus: 'participating',
    availabilityWindows: [{ from: '09:00', until: '11:00' }, { from: '13:00' }],
    preferredTimeRange: { until: '17:00' }, notes: 'note',
  })
})

test('Event Memberはlocale非依存でuppercase participation・PA tokenを解釈する', () => {
  const cases = [
    ['PARTICIPATING', 'TRUE', 'FALSE', 'participating', { main: true, sub: false }],
    ['ABSENT', 'YES', 'NO', 'absent', { main: true, sub: false }],
    ['UNDECIDED', 'FALSE', 'TRUE', 'undecided', { main: false, sub: true }],
  ]
  for (const [status, main, sub, expectedStatus, expectedCapabilities] of cases) {
    const result = planEventMemberCsvImport({
      csv: csv(['メンバー', '開催日', '参加状態', 'Main PA', 'Sub PA'], [
        ['はな', '2027-11-01', status, main, sub],
      ]),
      event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
      createDraftId: () => 'unused',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) continue
    const updated = result.candidate.members.find((item) => item.memberId === 'member-1')
    assert.equal(updated.days.find((day) => day.eventDayId === 'day-1').participationStatus, expectedStatus)
    assert.deepEqual(updated.paCapabilities, expectedCapabilities)
  }
})

test('Event Memberは省略したPA・詳細headerについて既存draft値を維持する', () => {
  const draft = makeMemberDraft()
  draft.members[0].days[0].notes = 'keep'
  draft.members[0].days[0].availabilityWindows = []
  const result = planEventMemberCsvImport({
    csv: csv(['メンバー', '開催日', '参加状態'], [['はな', '2027-11-01', '未定']]),
    event, eventDays, members, eventMembers, eventMemberDays, draft, createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const updated = result.candidate.members.find((item) => item.memberId === 'member-1')
  assert.deepEqual(updated.paCapabilities, { main: true, sub: false })
  assert.equal(updated.days[0].notes, 'keep')
  assert.deepEqual(updated.days[0].availabilityWindows, [])
})

test('Event Memberはambiguous name・foreign day・duplicate pair・PA不一致をatomicにrejectする', () => {
  const ambiguousMembers = [...members, { id: 'member-4', realName: '別人', acaName: 'あおい', active: true }]
  const cases = [
    { configuredMembers: ambiguousMembers, rows: [['あおい', '2027-11-01', '参加', '', '']] },
    { configuredMembers: members, rows: [['はな', '2027-12-01', '参加', '', '']] },
    { configuredMembers: members, rows: [['はな', '2027-11-01', '参加', '可', '不可'], ['はな', '2027-11-01', '参加', '可', '不可']] },
    { configuredMembers: members, rows: [['はな', '2027-11-01', '参加', '可', '不可'], ['はな', '2027-11-02', '参加', '不可', '不可']] },
  ]
  for (const item of cases) {
    const before = makeMemberDraft()
    const result = planEventMemberCsvImport({
      csv: csv(['メンバー', '開催日', '参加状態', 'Main PA', 'Sub PA'], item.rows),
      event, eventDays, members: item.configuredMembers, eventMembers, eventMemberDays,
      draft: before, createDraftId: () => 'new',
    })
    assert.equal(result.ok, false)
    assert.deepEqual(before, makeMemberDraft())
  }
})

test('Event Memberはdomain invalid rangeとmerge後candidate全体の不整合をrejectする', () => {
  const invalidRange = planEventMemberCsvImport({
    csv: csv(['メンバー', '開催日', '参加状態', '出演可能時間帯'], [['はな', '2027-11-01', '参加', '17:00-09:00']]),
    event, eventDays, members, eventMembers, eventMemberDays, draft: makeMemberDraft(),
    createDraftId: () => 'unused',
  })
  assert.equal(invalidRange.ok, false)
  const draft = makeMemberDraft()
  draft.members[1].days = draft.members[1].days.slice(0, 1)
  const invalidCandidate = planEventMemberCsvImport({
    csv: csv(['メンバー', '開催日', '参加状態'], [['はな', '2027-11-01', '参加']]),
    event, eventDays, members, eventMembers, eventMemberDays, draft, createDraftId: () => 'unused',
  })
  assert.equal(invalidCandidate.ok, false)
})

test('Event Band exportは人間向け列、最低7メンバー列、右端技術列を出力する', () => {
  const parsed = parseCsv(createEventBandCsv({ event, eventDays, bands, members, draft: makeBandDraft() }))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...EVENT_BAND_CSV_HEADERS])
  assert.deepEqual(parsed.rows[1].cells.slice(0, 4), ['Existing', '2027-11-01', '佐藤 花子', ''])
  assert.deepEqual(parsed.rows[0].cells.slice(-5), ['出演バンドID', '開催日ID', '固定バンドID', 'メンバーID一覧', '下書きID'])
  assert.deepEqual(parsed.rows[1].cells.slice(-5), [
    'event-band-1', 'day-1', 'band-1', 'member-1', 'event-band-event-band-1',
  ])
})

test('Event BandのExportは技術IDを使ってそのまま再Importできる', () => {
  const draft = makeBandDraft()
  const result = planEventBandCsvImport({
    csv: createEventBandCsv({ event, eventDays, bands, members, draft }),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 0)
  assert.equal(result.updatedCount, draft.items.length)
  assert.deepEqual(result.candidate, draft)
})

test('Event Bandの未保存draftは下書きIDでExport・再Importして同じrowを更新する', () => {
  const draft = { items: [{
    draftId: 'unsaved-draft-1',
    eventId: event.id,
    eventDayId: 'day-2',
    name: 'Unsaved',
    memberIds: ['member-2'],
    durationMinutes: '10',
  }] }
  const before = structuredClone(draft)
  const csvSource = createEventBandCsv({ event, eventDays, bands, members, draft })
  const exported = parseCsv(csvSource)
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  assert.equal(exported.rows[0].cells.at(-1), '下書きID')
  assert.equal(exported.rows[1].cells.at(-1), 'unsaved-draft-1')

  const roundTrip = planEventBandCsvImport({
    csv: csvSource, event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'must-not-create',
  })
  assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip))
  if (roundTrip.ok) {
    assert.equal(roundTrip.candidate.items.length, 1)
    assert.equal(roundTrip.candidate.items[0].draftId, 'unsaved-draft-1')
    assert.equal(roundTrip.createdCount, 0)
    assert.equal(roundTrip.updatedCount, 1)
  }

  const updated = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '下書きID'], [[
      'Unsaved updated', '2027-11-02', '鈴木 蓮', '10', 'unsaved-draft-1',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'must-not-create',
  })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  if (updated.ok) {
    assert.equal(updated.candidate.items.length, 1)
    assert.equal(updated.candidate.items[0].draftId, 'unsaved-draft-1')
    assert.equal(updated.candidate.items[0].name, 'Unsaved updated')
    assert.equal(updated.createdCount, 0)
    assert.equal(updated.updatedCount, 1)
  }
  assert.deepEqual(draft, before)
})

test('Event Bandのunknown・省略下書きIDはnew draftにし、duplicate・曖昧IDはrejectする', () => {
  const draft = { items: [{
    draftId: 'current-unsaved', eventId: event.id, eventDayId: 'day-2',
    name: 'Current', memberIds: ['member-2'], durationMinutes: '10',
  }] }
  const unknown = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '下書きID'], [[
      'Imported old session', '2027-11-02', '鈴木 蓮', '10', 'old-session-draft',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'generated-new-draft',
  })
  assert.equal(unknown.ok, true, JSON.stringify(unknown))
  if (unknown.ok) {
    assert.equal(unknown.createdCount, 1)
    assert.equal(unknown.updatedCount, 0)
    assert.equal(unknown.candidate.items.some((item) => item.draftId === 'generated-new-draft'), true)
  }

  const omitted = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠'], [[
      'No draft column', '2027-11-02', '鈴木 蓮', '10',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'generated-without-column',
  })
  assert.equal(omitted.ok, true, JSON.stringify(omitted))
  if (omitted.ok) assert.equal(omitted.createdCount, 1)

  const duplicate = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '下書きID'], [
      ['One', '2027-11-02', '鈴木 蓮', '10', 'duplicate-draft'],
      ['Two', '2027-11-02', '鈴木 蓮', '10', 'duplicate-draft'],
    ]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'unused',
  })
  assert.equal(duplicate.ok, false)

  const ambiguousDraft = { items: [
    { ...draft.items[0], draftId: 'ambiguous-draft', name: 'One' },
    { ...draft.items[0], draftId: 'ambiguous-draft', name: 'Two' },
  ] }
  const ambiguous = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '下書きID'], [[
      'Ambiguous', '2027-11-02', '鈴木 蓮', '10', 'ambiguous-draft',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: ambiguousDraft, createDraftId: () => 'unused',
  })
  assert.equal(ambiguous.ok, false)
})

test('Event Bandは出演バンドIDを下書きIDより優先する', () => {
  const draft = { items: [
    ...makeBandDraft().items,
    {
      draftId: 'unsaved-draft', eventId: event.id, eventDayId: 'day-2',
      name: 'Unsaved remains', memberIds: ['member-2'], durationMinutes: '10',
    },
  ] }
  const result = planEventBandCsvImport({
    csv: csv([
      'バンド名', '開催日', 'メンバー1', '出演枠', '出演バンドID', '下書きID',
    ], [[
      'Persistent updated', '2027-11-01', '佐藤 花子', '10', 'event-band-1', 'unsaved-draft',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return
  assert.equal(result.createdCount, 0)
  assert.equal(result.updatedCount, 1)
  assert.equal(result.candidate.items.find((item) => item.eventBandId === 'event-band-1').name, 'Persistent updated')
  assert.equal(result.candidate.items.find((item) => item.draftId === 'unsaved-draft').name, 'Unsaved remains')
})

test('Event Bandのhuman member列は本名を使いcross-field collisionを避ける', () => {
  const configuredMembers = members.map((member) => member.id === 'member-1'
    ? { ...member, realName: '山田太郎', acaName: 'たろう' }
    : member.id === 'member-2'
      ? { ...member, realName: 'たろう', acaName: 'びー' }
      : member)
  const exported = parseCsv(createEventBandCsv({
    event, eventDays, bands, members: configuredMembers, draft: makeBandDraft(),
  }))
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  assert.equal(exported.rows[1].cells[2], '山田太郎')

  const imported = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠'], [[
      'Cross field', '2027-11-02', '山田太郎', '10',
    ]]),
    event, eventDays, bands, members: configuredMembers, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'cross-field-band',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) {
    assert.deepEqual(imported.candidate.items.find((item) => item.draftId === 'cross-field-band').memberIds, ['member-1'])
  }

  const ambiguous = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠'], [[
      'Ambiguous', '2027-11-02', '山田太郎', '10',
    ]]),
    event, eventDays, bands,
    members: [...configuredMembers, {
      id: 'member-4', realName: '山田太郎', acaName: 'しー', active: true,
    }],
    eventMembers, eventMemberDays, eventBands: existingEventBands,
    draft: makeBandDraft(), createDraftId: () => 'ambiguous-band',
  })
  assert.equal(ambiguous.ok, false)
})

test('Event Bandのformula-likeなhuman文字列を安全化しImportで復元する', () => {
  const configuredMembers = members.map((member) => member.id === 'member-1'
    ? { ...member, realName: '+MEMBER' }
    : member)
  const draft = makeBandDraft()
  draft.items[0].name = '-BAND'
  const csvSource = createEventBandCsv({ event, eventDays, bands, members: configuredMembers, draft })
  const exported = parseCsv(csvSource)
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  assert.equal(exported.rows[1].cells[0], "'-BAND")
  assert.equal(exported.rows[1].cells[2], "'+MEMBER")

  const imported = planEventBandCsvImport({
    csv: csvSource, event, eventDays, bands, members: configuredMembers,
    eventMembers, eventMemberDays, eventBands: existingEventBands,
    draft, createDraftId: () => 'unused',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) assert.equal(imported.candidate.items[0].name, '-BAND')
})

test('Event Bandは技術headerなしで企画Bandをname/date/member fallbackから作成する', () => {
  const result = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠'], [['New', '2027-11-02', 'れん', '15']]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'draft-new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  const added = result.candidate.items.find((item) => item.draftId === 'draft-new')
  assert.equal(added.eventDayId, 'day-2')
  assert.deepEqual(added.memberIds, ['member-2'])
  assert.equal(added.bandId, undefined)
})

test('Event Bandは固定バンド名をunique exact matchで解決する', () => {
  const valid = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '固定バンド名'], [
      ['Fixed appearance', '2027-11-02', 'はな', '10', 'Fixed'],
    ]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'new',
  })
  assert.equal(valid.ok, true)
  if (valid.ok) assert.equal(valid.candidate.items.find((item) => item.draftId === 'new').bandId, 'band-1')
  const ambiguous = planEventBandCsvImport({
    csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '固定バンド名'], [
      ['Fixed appearance', '2027-11-02', 'はな', '10', 'Fixed'],
    ]),
    event, eventDays, bands: [...bands, { ...bands[0], id: 'band-2' }], members,
    eventMembers, eventMemberDays, eventBands: existingEventBands,
    draft: makeBandDraft(), createDraftId: () => 'new',
  })
  assert.equal(ambiguous.ok, false)
})

test('Event Bandは固定バンドID・メンバーID一覧・開催日IDを名称より優先する', () => {
  const result = planEventBandCsvImport({
    csv: csv(EVENT_BAND_CSV_HEADERS, [[
      'ID wins', '2099-01-01', 'missing member', '', '', '', '', '', '', '10', 'missing band',
      '', 'day-2', 'band-1', 'member-1',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const added = result.candidate.items.find((item) => item.draftId === 'new')
  assert.equal(added.eventDayId, 'day-2')
  assert.equal(added.bandId, 'band-1')
  assert.deepEqual(added.memberIds, ['member-1'])
})

test('Event Bandは8人以上の名前列を認識しExportも動的拡張する', () => {
  const largeMembers = Array.from({ length: 8 }, (_, index) => ({
    id: `large-${index + 1}`, realName: `Large ${index + 1}`, active: true,
  }))
  const largeEventMembers = largeMembers.map((member, index) => ({
    id: `large-em-${index}`, eventId: event.id, memberId: member.id, paCapabilities: { main: false, sub: false },
  }))
  const largeEventMemberDays = largeEventMembers.map((eventMember, index) => ({
    id: `large-emd-${index}`, eventMemberId: eventMember.id, eventDayId: 'day-1',
    participationStatus: 'participating',
  }))
  const headers = ['バンド名', '開催日', ...largeMembers.map((_, index) => `メンバー${index + 1}`), '出演枠']
  const plan = planEventBandCsvImport({
    csv: csv(headers, [['Large Band', '2027-11-01', ...largeMembers.map((item) => item.realName), '10']]),
    event, eventDays, bands: [], members: largeMembers, eventMembers: largeEventMembers,
    eventMemberDays: largeEventMemberDays, eventBands: [], draft: { items: [] }, createDraftId: () => 'large-draft',
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  if (!plan.ok) return
  assert.equal(plan.candidate.items[0].memberIds.length, 8)
  const parsed = parseCsv(createEventBandCsv({ event, eventDays, bands: [], members: largeMembers, draft: plan.candidate }))
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.rows[0].cells.includes('メンバー8'), true)
})

test('Event Bandは出演バンドIDで更新しunknown ID・foreign day・missing fixed Bandをrejectする', () => {
  const update = planEventBandCsvImport({
    csv: csv(EVENT_BAND_CSV_HEADERS, [[
      'Updated', '2027-11-01', 'はな', '', '', '', '', '', '', '10', 'Fixed',
      'event-band-1', 'day-1', 'band-1', 'member-1',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(update.ok, true, JSON.stringify(update))
  const invalidRows = [
    ['Name', '2027-11-01', 'はな', '10', '', 'missing'],
    ['Name', '2027-12-01', 'はな', '10', '', ''],
    ['Name', '2027-11-01', 'はな', '10', 'missing fixed', ''],
  ]
  for (const [name, date, member, duration, fixedName, eventBandId] of invalidRows) {
    const result = planEventBandCsvImport({
      csv: csv(['バンド名', '開催日', 'メンバー1', '出演枠', '固定バンド名', '出演バンドID'], [
        [name, date, member, duration, fixedName, eventBandId],
      ]),
      event, eventDays, bands, members, eventMembers, eventMemberDays,
      eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'new',
    })
    assert.equal(result.ok, false)
  }
})

test('Event Band既存fixed sourceは列省略時に維持し、明示変更だけを検証する', () => {
  const baseHeaders = ['バンド名', '開催日', 'メンバー1', '出演枠', '出演バンドID']
  const omitted = planEventBandCsvImport({
    csv: csv(baseHeaders, [['Minimal update', '2027-11-01', 'はな', '10', 'event-band-1']]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(omitted.ok, true, JSON.stringify(omitted))
  if (omitted.ok) assert.equal(omitted.candidate.items[0].bandId, 'band-1')

  const blank = planEventBandCsvImport({
    csv: csv([...baseHeaders, '固定バンド名', '固定バンドID'], [[
      'Remove source', '2027-11-01', 'はな', '10', 'event-band-1', '', '',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(blank.ok, false)

  const same = planEventBandCsvImport({
    csv: csv([...baseHeaders, '固定バンド名'], [[
      'Same source', '2027-11-01', 'はな', '10', 'event-band-1', 'Fixed',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(same.ok, true, JSON.stringify(same))

  const differentBand = { id: 'band-2', name: 'Different', defaultMemberIds: ['member-1'], active: true }
  const changed = planEventBandCsvImport({
    csv: csv([...baseHeaders, '固定バンド名'], [[
      'Changed source', '2027-11-01', 'はな', '10', 'event-band-1', 'Different',
    ]]),
    event, eventDays, bands: [...bands, differentBand], members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(changed.ok, false)
})

test('Event Band import後の既存save semanticsはStep 5 conditionsを維持する', () => {
  const plan = planEventBandCsvImport({
    csv: csv(EVENT_BAND_CSV_HEADERS, [[
      'Renamed', '2027-11-01', 'はな', '', '', '', '', '', '', '10', 'Fixed',
      'event-band-1', 'day-1', 'band-1', 'member-1',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft: makeBandDraft(), createDraftId: () => 'unused',
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  if (!plan.ok) return
  const update = createEventBandSettingsUpdate({
    draft: plan.candidate, event, eventDays, members, bands, eventMembers, eventMemberDays,
    eventBands: existingEventBands, scheduleItems: [], timetableOrderConstraints: [], newEventBandIds: [],
  })
  assert.equal(update.ok, true)
  if (!update.ok) return
  const saved = update.eventBands.find((item) => item.id === 'event-band-1')
  assert.deepEqual(saved.availableTimeRange, existingEventBands[0].availableTimeRange)
  assert.deepEqual(saved.preferredTimeRange, existingEventBands[0].preferredTimeRange)
  assert.deepEqual(saved.fixedPlacement, existingEventBands[0].fixedPlacement)
  assert.equal(saved.notes, 'Step 5 condition')
})

test('Event Bandは不連続member列・invalid duration・未登録EventMemberをatomicにrejectする', () => {
  const cases = [
    { headers: ['バンド名', '開催日', 'メンバー1', 'メンバー3', '出演枠'], row: ['Gap', '2027-11-01', 'はな', 'れん', '10'] },
    { headers: ['バンド名', '開催日', 'メンバー1', '出演枠'], row: ['Duration', '2027-11-01', 'はな', '11'] },
    { headers: ['バンド名', '開催日', 'メンバー1', '出演枠'], row: ['Unregistered', '2027-11-01', 'あおい', '10'] },
  ]
  for (const item of cases) {
    const before = makeBandDraft()
    const result = planEventBandCsvImport({
      csv: csv(item.headers, [item.row]), event, eventDays, bands, members, eventMembers,
      eventMemberDays, eventBands: existingEventBands, draft: before, createDraftId: () => 'new',
    })
    assert.equal(result.ok, false)
    assert.deepEqual(before, makeBandDraft())
  }
})

test('Event Band importはCSVにないdraft rowを維持する', () => {
  const draft = { items: [
    ...makeBandDraft().items,
    { draftId: 'existing-new', eventId: event.id, eventDayId: 'day-2', name: 'Omitted', memberIds: ['member-2'], durationMinutes: '10' },
  ] }
  const result = planEventBandCsvImport({
    csv: csv(EVENT_BAND_CSV_HEADERS, [[
      'Updated', '2027-11-01', 'はな', '', '', '', '', '', '', '10', 'Fixed',
      'event-band-1', 'day-1', 'band-1', 'member-1',
    ]]),
    event, eventDays, bands, members, eventMembers, eventMemberDays,
    eventBands: existingEventBands, draft, createDraftId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.candidate.items.some((item) => item.draftId === 'existing-new'), true)
})
