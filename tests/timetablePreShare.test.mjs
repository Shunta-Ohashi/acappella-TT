import assert from 'node:assert/strict'
import test from 'node:test'

import { strToU8, zlibSync } from 'fflate'

import { createDemoData } from '../src/data/demoData.ts'
import {
  createTimetablePreShareSnapshot,
  filterTimetablePreShareEntries,
  getTimetablePreShareDaySummary,
  getTimetablePreShareStageSummary,
  parseTimetablePreShareSnapshot,
} from '../src/share/timetablePreShare.ts'
import {
  createNormalAppUrl,
  createTimetablePreShareUrl,
  decodeTimetablePreSharePayload,
  encodeTimetablePreShareSnapshot,
  MAX_TIMETABLE_PRE_SHARE_DECOMPRESSED_BYTES,
  MAX_TIMETABLE_PRE_SHARE_PAYLOAD_LENGTH,
  MAX_TIMETABLE_PRE_SHARE_URL_LENGTH,
  resolveTimetablePreShareRoute,
} from '../src/share/timetablePreShareCodec.ts'
import { isTimetablePreShareHash } from '../src/share/timetablePreShareRouting.ts'

const FIXED_NOW = new Date('2027-11-01T09:30:00.000Z')

const makeInput = () => {
  const data = createDemoData()
  const event = data.events.find(item => item.id === 'event-demo-main')
  assert.ok(event)
  return {
    event,
    eventDays: data.eventDays,
    stages: data.stages,
    sections: data.sections,
    members: data.members,
    eventMembers: data.eventMembers,
    eventMemberDays: data.eventMemberDays,
    eventBands: data.eventBands,
    scheduleItems: data.scheduleItems,
    paAssignments: data.paAssignments,
    dutyTypes: data.dutyTypes,
    dutyAssignments: data.dutyAssignments,
  }
}

const getSnapshotResult = (input = makeInput()) => {
  const result = createTimetablePreShareSnapshot(input, FIXED_NOW)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.ok ? result : undefined
}

const getSnapshot = (input = makeInput()) => getSnapshotResult(input)?.snapshot

const toBase64Url = (bytes) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

const encodeUnknown = value => toBase64Url(zlibSync(strToU8(JSON.stringify(value))))

const makeEntry = (overrides = {}) => ({
  startTime: '10:00',
  endTime: '10:10',
  kind: 'performance',
  title: 'Choir',
  members: ['Alice'],
  mainPa: ['Main Person'],
  subPa: ['Sub Person'],
  duties: [{ name: '撮影', members: ['Camera Person'] }],
  ...overrides,
})

const makeSmallSnapshot = (overrides = {}) => ({
  version: 1,
  eventName: '日本語🎤 <script>alert(1)</script> =LOVE',
  createdAt: FIXED_NOW.toISOString(),
  days: [{
    date: '2027-11-01',
    label: '1日目',
    stages: [{
      name: 'Main Stage',
      plannedStartTime: '10:00',
      plannedEndTime: '18:00',
      entries: [makeEntry()],
    }],
  }],
  ...overrides,
})

const makeSingleBreakInput = ({
  plannedStartTime,
  durationMinutes,
  plannedEndTime,
}) => {
  const input = makeInput()
  const eventDay = input.eventDays.find(day => day.eventId === input.event.id)
  assert.ok(eventDay)
  const stage = {
    id: 'stage-share-boundary',
    eventDayId: eventDay.id,
    name: '境界確認',
    order: 0,
    plannedStartTime,
    ...(plannedEndTime === undefined ? {} : { plannedEndTime }),
  }
  return {
    ...input,
    eventDays: [eventDay],
    stages: [stage],
    sections: [],
    eventBands: [],
    scheduleItems: [{
      id: 'schedule-share-boundary-break',
      stageId: stage.id,
      order: 0,
      kind: 'break',
      title: '境界休憩',
      durationMinutes,
    }],
    paAssignments: [],
    dutyTypes: [],
    dutyAssignments: [],
  }
}

test('事前共有Snapshot V1はDay・Stage順、Performance・Break、時刻・Member・PA・Dutyを保持する', () => {
  const input = makeInput()
  input.eventDays = [...input.eventDays].reverse()
  input.stages = [...input.stages].reverse()
  const before = structuredClone(input)
  const first = getSnapshot(input)
  const second = getSnapshot(input)

  assert.deepEqual(second, first)
  assert.deepEqual(input, before)
  assert.equal(first?.version, 1)
  assert.equal(first?.eventName, '2026 デモライブ')
  assert.equal(first?.createdAt, FIXED_NOW.toISOString())
  assert.deepEqual(first?.days.map(day => day.date), ['2026-11-01', '2026-11-03'])
  assert.deepEqual(first?.days[0].stages.map(stage => stage.name), ['Main Stage', 'Sub Stage'])

  const entries = first?.days.flatMap(day => day.stages.flatMap(stage => stage.entries)) ?? []
  const performance = entries.find(entry => entry.title === 'Aurora')
  const rest = entries.find(entry => entry.title === '昼休憩')
  assert.deepEqual({
    kind: performance?.kind,
    startTime: performance?.startTime,
    endTime: performance?.endTime,
    members: performance?.members,
  }, {
    kind: 'performance',
    startTime: '16:30',
    endTime: '16:47',
    members: ['あおい', 'れん', 'みさき', 'かなで'],
  })
  assert.equal(rest?.kind, 'break')
  assert.equal(rest?.startTime, '13:30')
  assert.equal(rest?.endTime, '14:00')
  assert.deepEqual(rest?.mainPa, ['みさき'])
  assert.deepEqual(rest?.subPa, [])
  assert.deepEqual(rest?.duties, [
    { name: '撮影', members: ['あおい'] },
    { name: '消毒', members: ['りん'] },
  ])
  assert.deepEqual(
    entries.find(entry => entry.title === 'Window Duo')?.subPa,
    ['みなと'],
  )
})

test('Snapshotは表示情報だけを保存し内部ID・notes・条件・Lock・OrderConstraintを含めない', () => {
  const input = makeInput()
  input.event = { ...input.event, notes: 'PRIVATE_EVENT_NOTE' }
  input.members = input.members.map((member, index) => index === 0
    ? { ...member, notes: 'PRIVATE_MEMBER_NOTE' }
    : member)
  input.eventMemberDays = input.eventMemberDays.map((day, index) => index === 0
    ? {
        ...day,
        notes: 'PRIVATE_MEMBER_DAY_NOTE',
        availabilityWindows: [{ from: '01:23', until: '04:56' }],
        preferredTimeRange: { from: '02:34', until: '03:45' },
      }
    : day)
  input.eventBands = input.eventBands.map((band, index) => index === 0
    ? {
        ...band,
        notes: 'PRIVATE_EVENT_BAND_NOTE',
        availableTimeRange: { from: '05:00', until: '06:00' },
        preferredTimeRange: { from: '05:10', until: '05:50' },
        fixedPlacement: { stageId: 'PRIVATE_FIXED_STAGE' },
      }
    : band)
  input.timetableLocks = [{ id: 'PRIVATE_LOCK_ID' }]
  input.timetableOrderConstraints = [{ id: 'PRIVATE_ORDER_CONSTRAINT_ID' }]

  const snapshot = getSnapshot(input)
  const serialized = JSON.stringify(snapshot)
  for (const secret of [
    'PRIVATE_EVENT_NOTE',
    'PRIVATE_MEMBER_NOTE',
    'PRIVATE_MEMBER_DAY_NOTE',
    'PRIVATE_EVENT_BAND_NOTE',
    'PRIVATE_FIXED_STAGE',
    'PRIVATE_LOCK_ID',
    'PRIVATE_ORDER_CONSTRAINT_ID',
    input.event.id,
    input.eventDays[0].id,
    input.stages[0].id,
    input.eventBands[0].id,
    input.scheduleItems[0].id,
  ]) assert.equal(serialized.includes(secret), false, secret)
  assert.equal(/"(?:id|notes|availabilityWindows|preferredTimeRange|availableTimeRange|fixedPlacement|validationPolicy|performanceSlotMinutes)"/.test(serialized), false)
})

test('Share codecは日本語・emoji・HTML-like・formula-like textをbase64urlでround-tripする', () => {
  const snapshot = makeSmallSnapshot()
  const payload = encodeTimetablePreShareSnapshot(snapshot)
  assert.match(payload, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeTimetablePreSharePayload(payload), { ok: true, snapshot })
})

test('Share parser/decoderはinvalid createdAt、base64url・圧縮・JSON・version・shapeをrejectする', () => {
  assert.equal(parseTimetablePreShareSnapshot({ ...makeSmallSnapshot(), createdAt: 'bad' }), undefined)
  assert.deepEqual(decodeTimetablePreSharePayload('not+base64'), {
    ok: false, reason: 'MALFORMED',
  })
  assert.deepEqual(decodeTimetablePreSharePayload(toBase64Url(new Uint8Array([1, 2, 3]))), {
    ok: false, reason: 'MALFORMED',
  })
  assert.deepEqual(decodeTimetablePreSharePayload(toBase64Url(zlibSync(strToU8('{bad')))), {
    ok: false, reason: 'MALFORMED',
  })
  assert.deepEqual(decodeTimetablePreSharePayload(encodeUnknown({
    ...makeSmallSnapshot(), version: 2,
  })), { ok: false, reason: 'MALFORMED' })
  assert.deepEqual(decodeTimetablePreSharePayload(encodeUnknown({
    ...makeSmallSnapshot(), days: [{ date: 'bad', stages: [] }],
  })), { ok: false, reason: 'MALFORMED' })
})

test('plannedEndTimeはfield absentとvalid LocalTimeだけを許可しpresent-but-invalid値をrejectする', () => {
  const withoutEnd = makeSmallSnapshot()
  delete withoutEnd.days[0].stages[0].plannedEndTime
  assert.ok(parseTimetablePreShareSnapshot(withoutEnd))
  assert.ok(parseTimetablePreShareSnapshot(makeSmallSnapshot()))

  for (const invalid of [null, 123, true, {}, [], '']) {
    const snapshot = makeSmallSnapshot()
    snapshot.days[0].stages[0].plannedEndTime = invalid
    assert.equal(parseTimetablePreShareSnapshot(snapshot), undefined, String(invalid))
    assert.deepEqual(decodeTimetablePreSharePayload(encodeUnknown(snapshot)), {
      ok: false, reason: 'MALFORMED',
    }, String(invalid))
  }
})

test('Share decoderとURL生成は明示的size上限を超えるpayloadをrejectする', () => {
  assert.deepEqual(
    decodeTimetablePreSharePayload('A'.repeat(MAX_TIMETABLE_PRE_SHARE_PAYLOAD_LENGTH + 1)),
    { ok: false, reason: 'TOO_LARGE' },
  )
  const decompressionBomb = encodeUnknown(makeSmallSnapshot({
    eventName: 'x'.repeat(MAX_TIMETABLE_PRE_SHARE_DECOMPRESSED_BYTES + 1),
  }))
  assert.deepEqual(decodeTimetablePreSharePayload(decompressionBomb), {
    ok: false, reason: 'TOO_LARGE',
  })

  const oversizedSnapshot = makeSmallSnapshot({
    eventName: '🎤'.repeat(Math.floor(MAX_TIMETABLE_PRE_SHARE_DECOMPRESSED_BYTES / 4) + 1),
  })
  assert.throws(() => encodeTimetablePreShareSnapshot(oversizedSnapshot))
  const oversizedResult = createTimetablePreShareUrl(
    oversizedSnapshot,
    'https://example.test/app?mode=preview',
  )
  assert.equal(oversizedResult.ok, false)
  if (!oversizedResult.ok) assert.match(oversizedResult.message, /大きすぎる/)

  let state = 0x12345678
  const largeName = Array.from({ length: 100_000 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return String.fromCharCode(0x20 + (state % 0x5f))
  }).join('')
  const result = createTimetablePreShareUrl(
    makeSmallSnapshot({ eventName: largeName }),
    'https://example.test/app?mode=preview#old',
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /大きすぎる/)
})

test('検索はBand・出演Member・Main/Sub PA・Duty担当・Duty名をtrim/case-insensitiveで検索する', () => {
  const performance = makeEntry()
  const rest = makeEntry({
    startTime: '10:10', endTime: '10:20', kind: 'break', title: '休憩',
    members: [], mainPa: [], subPa: [], duties: [],
  })
  const dutyRest = makeEntry({
    startTime: '10:20', endTime: '10:30', kind: 'break', title: '準備休憩',
    members: [], mainPa: [], subPa: [], duties: [{ name: '受付', members: ['Dana'] }],
  })
  const entries = [performance, rest, dutyRest]

  for (const query of [' choir ', 'alice', 'MAIN PERSON', 'sub person', 'camera person', '撮影']) {
    assert.deepEqual(filterTimetablePreShareEntries(entries, query), [performance], query)
  }
  assert.deepEqual(filterTimetablePreShareEntries(entries, 'dana'), [dutyRest])
  assert.deepEqual(filterTimetablePreShareEntries(entries, '受付'), [dutyRest])
  assert.deepEqual(filterTimetablePreShareEntries(entries, ''), entries)
  assert.deepEqual(filterTimetablePreShareEntries(entries, '休憩'), [])
})

test('検索はNFKC互換文字を正規化して全角ASCII・半角カナを一致させる', () => {
  const alpha = makeEntry({ title: 'Alpha' })
  const timekeeper = makeEntry({
    title: 'Bravo',
    duties: [{ name: 'タイムキーパー', members: ['担当者'] }],
  })
  assert.deepEqual(filterTimetablePreShareEntries([alpha, timekeeper], ' ＡＬＰＨＡ '), [alpha])
  assert.deepEqual(filterTimetablePreShareEntries([alpha, timekeeper], 'ﾀｲﾑｷｰﾊﾟｰ'), [timekeeper])
})

test('検索はASCII caseを閲覧環境に依存しない形で一致させる', () => {
  const entry = makeEntry({ mainPa: ['MAIN PERSON'] })
  assert.deepEqual(filterTimetablePreShareEntries([entry], 'main person'), [entry])
})

test('Snapshot creatorは24:00終端を許可し24:00超過をwrapせずrejectする', () => {
  const untilMidnight = createTimetablePreShareSnapshot(makeSingleBreakInput({
    plannedStartTime: '23:40', durationMinutes: 20,
  }), FIXED_NOW)
  assert.equal(untilMidnight.ok, true, JSON.stringify(untilMidnight))
  if (untilMidnight.ok) {
    const entry = untilMidnight.snapshot.days[0].stages[0].entries[0]
    assert.deepEqual([entry.startTime, entry.endTime], ['23:40', '24:00'])
    const payload = encodeTimetablePreShareSnapshot(untilMidnight.snapshot)
    assert.deepEqual(decodeTimetablePreSharePayload(payload), {
      ok: true, snapshot: untilMidnight.snapshot,
    })
  }

  const crossesMidnight = createTimetablePreShareSnapshot(makeSingleBreakInput({
    plannedStartTime: '23:50', durationMinutes: 20,
  }), FIXED_NOW)
  assert.equal(crossesMidnight.ok, false)
  if (!crossesMidnight.ok) assert.match(crossesMidnight.message, /24:00|日付をまたぐ/)
})

test('Snapshot creatorはStageのinvalid plannedEndTimeをparser到達前にrejectする', () => {
  for (const [start, end] of [
    ['10:00', 'bad'],
    ['18:00', '10:00'],
    ['10:00', '10:00'],
  ]) {
    const result = createTimetablePreShareSnapshot(makeSingleBreakInput({
      plannedStartTime: start, plannedEndTime: end, durationMinutes: 10,
    }), FIXED_NOW)
    assert.equal(result.ok, false, `${start}→${end}`)
  }
  assert.equal(createTimetablePreShareSnapshot(makeSingleBreakInput({
    plannedStartTime: '10:00', durationMinutes: 10,
  }), FIXED_NOW).ok, true)
})

test('Share parserはStage・Entryの逆転/同時刻をrejectし23:50→24:00を許可する', () => {
  const assertMalformed = (mutate) => {
    const snapshot = makeSmallSnapshot()
    mutate(snapshot.days[0].stages[0])
    assert.equal(parseTimetablePreShareSnapshot(snapshot), undefined)
    assert.deepEqual(decodeTimetablePreSharePayload(encodeUnknown(snapshot)), {
      ok: false, reason: 'MALFORMED',
    })
  }

  assert.ok(parseTimetablePreShareSnapshot(makeSmallSnapshot()))
  const noStageEnd = makeSmallSnapshot()
  delete noStageEnd.days[0].stages[0].plannedEndTime
  assert.ok(parseTimetablePreShareSnapshot(noStageEnd))
  assertMalformed(stage => {
    stage.plannedStartTime = '18:00'
    stage.plannedEndTime = '10:00'
  })
  assertMalformed(stage => {
    stage.plannedStartTime = '10:00'
    stage.plannedEndTime = '10:00'
  })
  assertMalformed(stage => {
    stage.entries[0].startTime = '10:10'
    stage.entries[0].endTime = '10:00'
  })
  assertMalformed(stage => {
    stage.entries[0].startTime = '10:00'
    stage.entries[0].endTime = '10:00'
  })
  const untilMidnight = makeSmallSnapshot()
  untilMidnight.days[0].stages[0].entries[0].startTime = '23:50'
  untilMidnight.days[0].stages[0].entries[0].endTime = '24:00'
  assert.ok(parseTimetablePreShareSnapshot(untilMidnight))
  assertMalformed(stage => {
    stage.entries[0].startTime = '24:00'
    stage.entries[0].endTime = '24:00'
  })
})

test('Day/Stage summaryは予定順とPerformance・Break件数を算出する', () => {
  const early = makeEntry({ startTime: '09:00', endTime: '09:10' })
  const rest = makeEntry({
    startTime: '09:10', endTime: '09:20', kind: 'break', title: '休憩',
    members: [], mainPa: [], subPa: [], duties: [],
  })
  const late = makeEntry({ startTime: '11:00', endTime: '11:10', title: 'Late' })
  const stage = {
    name: 'Main', plannedStartTime: '08:00', plannedEndTime: '18:00', entries: [early, rest],
  }
  assert.deepEqual(getTimetablePreShareStageSummary(stage), {
    startTime: '09:00', endTime: '09:20', performanceCount: 1, breakCount: 1,
  })
  assert.deepEqual(getTimetablePreShareDaySummary({
    date: '2027-11-01', stages: [
      { name: 'Late', plannedStartTime: '10:00', entries: [late] }, stage,
    ],
  }), {
    startTime: '09:00', endTime: '11:10', performanceCount: 2, breakCount: 1,
  })
})

test('Day/Stage summaryはentry配列順や並行Stageに依存せず最小開始・最大終了を使う', () => {
  const stageAEntry = makeEntry({
    startTime: '13:00', endTime: '14:00', kind: 'break', title: 'Long Break',
    members: [], mainPa: [], subPa: [], duties: [],
  })
  const stageBEntry = makeEntry({ startTime: '13:30', endTime: '13:40' })
  assert.deepEqual(getTimetablePreShareDaySummary({
    date: '2027-11-01',
    stages: [
      { name: 'Stage A', plannedStartTime: '13:00', entries: [stageAEntry] },
      { name: 'Stage B', plannedStartTime: '13:30', entries: [stageBEntry] },
    ],
  }), {
    startTime: '13:00', endTime: '14:00', performanceCount: 1, breakCount: 1,
  })

  assert.deepEqual(getTimetablePreShareStageSummary({
    name: 'Scrambled', plannedStartTime: '09:00', plannedEndTime: '18:00',
    entries: [stageBEntry, stageAEntry],
  }), {
    startTime: '13:00', endTime: '14:00', performanceCount: 1, breakCount: 1,
  })
  assert.deepEqual(getTimetablePreShareStageSummary({
    name: 'Empty', plannedStartTime: '09:00', plannedEndTime: '18:00', entries: [],
  }), {
    startTime: '09:00', endTime: '18:00', performanceCount: 0, breakCount: 0,
  })
})

test('Routingは通常URL・valid share・broken shareを分離しqueryを維持する', () => {
  const snapshot = makeSmallSnapshot()
  const created = createTimetablePreShareUrl(snapshot, 'https://example.test/app?mode=preview#old')
  assert.equal(created.ok, true)
  if (!created.ok) return
  const url = new URL(created.url)
  assert.equal(url.search, '?mode=preview')
  assert.equal(resolveTimetablePreShareRoute('', 1).kind, 'app')
  assert.equal(resolveTimetablePreShareRoute('#other', 20).kind, 'app')
  assert.equal(resolveTimetablePreShareRoute('#share-other', 30).kind, 'app')
  assert.equal(resolveTimetablePreShareRoute('#share', 30).kind, 'error')
  assert.equal(resolveTimetablePreShareRoute('#share=', 31).kind, 'error')
  assert.deepEqual(resolveTimetablePreShareRoute(url.hash, created.url.length), {
    kind: 'share', snapshot,
  })
  assert.equal(resolveTimetablePreShareRoute('#share=broken', 40).kind, 'error')
  assert.equal(resolveTimetablePreShareRoute(
    url.hash,
    MAX_TIMETABLE_PRE_SHARE_URL_LENGTH + 1,
  ).kind, 'error')
  assert.equal(createNormalAppUrl(created.url), 'https://example.test/app?mode=preview')
})

test('Share routingとURL生成は同じpayloadでも完全URL長の上限を適用する', () => {
  const snapshot = makeSmallSnapshot()
  const short = createTimetablePreShareUrl(snapshot, 'https://example.test/app?mode=preview')
  assert.equal(short.ok, true)
  if (!short.ok) return
  const shortUrl = new URL(short.url)
  assert.equal(resolveTimetablePreShareRoute(shortUrl.hash, short.url.length).kind, 'share')

  const longBase = `https://example.test/${'x'.repeat(MAX_TIMETABLE_PRE_SHARE_URL_LENGTH)}?mode=preview`
  const long = createTimetablePreShareUrl(snapshot, longBase)
  assert.equal(long.ok, false)
  assert.equal(resolveTimetablePreShareRoute(
    shortUrl.hash,
    longBase.length + shortUrl.hash.length,
  ).kind, 'error')
})

test('lazy routing markerはbare・empty・valid payloadをShare側へ送り類似hashを除外する', () => {
  assert.equal(isTimetablePreShareHash('#share'), true)
  assert.equal(isTimetablePreShareHash('#share='), true)
  assert.equal(isTimetablePreShareHash('#share=payload'), true)
  assert.equal(isTimetablePreShareHash(''), false)
  assert.equal(isTimetablePreShareHash('#other'), false)
  assert.equal(isTimetablePreShareHash('#share-other'), false)
})

test('Timeline計算不能Stageが1件でもあればShare Snapshot全体をfailureにする', () => {
  const input = makeInput()
  const target = input.scheduleItems.find(item => item.kind === 'performance')
  assert.ok(target)
  input.scheduleItems = input.scheduleItems.map(item => item.id === target.id
    ? { ...item, eventBandId: 'missing-event-band' }
    : item)
  assert.equal(createTimetablePreShareSnapshot(input, FIXED_NOW).ok, false)
})

test('foreign PA/DutyをSnapshot・warningから隔離しselected Eventのbroken担当だけwarningにする', () => {
  const input = makeInput()
  const baseline = getSnapshotResult(input)
  assert.ok(baseline)
  const foreignDay = input.eventDays.find(day => day.eventId !== input.event.id)
  assert.ok(foreignDay)
  const foreignStage = input.stages.find(stage => stage.eventDayId === foreignDay.id)
  assert.ok(foreignStage)
  const paTemplate = input.paAssignments.find(item => item.eventId === input.event.id)
  const dutyTemplate = input.dutyAssignments[0]
  assert.ok(paTemplate)
  assert.ok(dutyTemplate)
  const foreignDutyType = {
    id: 'foreign-duty-type', eventId: foreignDay.eventId, name: 'Foreign', order: 0,
  }
  input.paAssignments.push({
    ...paTemplate, id: 'foreign-pa', eventId: foreignDay.eventId,
    eventDayId: foreignDay.id, stageId: foreignStage.id, memberId: 'missing-member',
  })
  input.dutyTypes.push(foreignDutyType)
  input.dutyAssignments.push({
    ...dutyTemplate, id: 'foreign-duty', dutyTypeId: foreignDutyType.id,
    eventDayId: foreignDay.id, stageId: foreignStage.id, memberId: 'missing-member',
  })
  assert.deepEqual(getSnapshotResult(input), baseline)

  input.paAssignments.push({
    ...paTemplate, id: 'selected-broken-pa', stageId: 'missing-stage',
  })
  const broken = getSnapshotResult(input)
  assert.equal(broken?.warnings.length, 1)
  assert.match(broken?.warnings[0] ?? '', /Grid外|参照切れ/)
})
