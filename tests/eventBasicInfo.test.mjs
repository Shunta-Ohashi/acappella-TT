import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  canDeleteEventDay,
  createEventBasicInfoDraft,
  createEventBasicInfoUpdate,
  hasEventBasicInfoDraftChanges,
  validateEventBasicInfoDraft,
} from '../src/domain/eventBasicInfo.ts'

const event = {
  id: 'event-1',
  name: '変更前イベント',
  timeZone: 'Asia/Tokyo',
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
  performanceSlotMinutes: [5, 7, 10, 15],
}

const eventDays = [
  {
    id: 'day-a',
    eventId: event.id,
    date: '2027-11-08',
    order: 0,
  },
  {
    id: 'day-b',
    eventId: event.id,
    date: '2027-11-06',
    order: 1,
  },
]

const noReferences = {
  stages: [],
  eventMemberDays: [],
  eventBands: [],
  paAssignments: [],
  dutyAssignments: [],
  timetableOrderConstraints: [],
}

test('基本情報dirty判定はname・日付・説明・メモ・開催日順をsemanticに比較する', () => {
  const saved = createEventBasicInfoDraft({
    ...event,
    description: '説明',
    notes: 'メモ',
  }, eventDays)
  assert.equal(hasEventBasicInfoDraftChanges(structuredClone(saved), saved), false)

  const changes = [
    { ...structuredClone(saved), name: '変更後イベント' },
    {
      ...structuredClone(saved),
      eventDays: saved.eventDays.map((day, index) =>
        index === 0 ? { ...day, date: '2027-11-07' } : day),
    },
    { ...structuredClone(saved), description: '変更後説明' },
    { ...structuredClone(saved), notes: '変更後メモ' },
    { ...structuredClone(saved), eventDays: [...saved.eventDays].reverse() },
    { ...structuredClone(saved), eventDays: saved.eventDays.slice(0, 1) },
    { ...structuredClone(saved), eventDays: [...saved.eventDays, { date: '2027-11-09' }] },
  ]
  for (const changed of changes) {
    assert.equal(hasEventBasicInfoDraftChanges(changed, saved), true)
  }

  const changedThenRestored = structuredClone(saved)
  changedThenRestored.name = '一時変更'
  assert.equal(hasEventBasicInfoDraftChanges(changedThenRestored, saved), true)
  changedThenRestored.name = saved.name
  assert.equal(hasEventBasicInfoDraftChanges(changedThenRestored, saved), false)
})

test('同一orderの開催日は正規化済みdraftをフォーム初期値とbaselineへ共用する', async () => {
  const tiedDays = [
    { id: 'day-z', eventId: event.id, date: '2027-11-08', order: 0 },
    { id: 'day-a', eventId: event.id, date: '2027-11-06', order: 0 },
  ]
  const reversed = [...tiedDays].reverse()
  const firstDraft = createEventBasicInfoDraft(event, tiedDays)
  const secondDraft = createEventBasicInfoDraft(event, reversed)
  const before = structuredClone(tiedDays)

  assert.deepEqual(firstDraft, secondDraft)
  assert.deepEqual(firstDraft.eventDays.map(day => day.eventDayId), [
    'day-a',
    'day-z',
  ])
  assert.equal(hasEventBasicInfoDraftChanges(firstDraft, secondDraft), false)
  assert.deepEqual(tiedDays, before)

  const componentSource = await readFile(new URL(
    '../src/components/EventBasicInfo.tsx',
    import.meta.url,
  ), 'utf8')
  assert.match(componentSource, /createDateInputs\(initialDraft\.eventDays\)/)
  assert.match(componentSource, /const normalizedSavedDraft = createEventBasicInfoDraft/)
  assert.match(componentSource, /createDateInputs\(normalizedSavedDraft\.eventDays\)/)
  assert.match(componentSource, /setSavedDraft\(normalizedSavedDraft\)/)
  assert.doesNotMatch(componentSource, /const initialEventDays = eventDays/)
})

test('基本情報保存の失敗はdirtyを維持し、成功結果をbaselineにするとcleanになる', () => {
  const saved = createEventBasicInfoDraft(event, eventDays)
  const changed = {
    ...saved,
    name: '保存後イベント',
    description: '保存後説明',
    notes: '保存後メモ',
  }
  assert.equal(hasEventBasicInfoDraftChanges(changed, saved), true)

  const failed = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: { ...changed, name: '   ' },
    newEventDayIds: [],
    ...noReferences,
  })
  assert.equal(failed.ok, false)
  assert.equal(hasEventBasicInfoDraftChanges(changed, saved), true)

  const succeeded = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: changed,
    newEventDayIds: [],
    ...noReferences,
  })
  assert.equal(succeeded.ok, true)
  if (!succeeded.ok) return
  const nextSaved = createEventBasicInfoDraft(succeeded.event, succeeded.eventDays)
  assert.equal(hasEventBasicInfoDraftChanges(nextSaved, nextSaved), false)
})

test('AppのCloud保存と画面遷移はEventBasicInfoの同期dirty handleを通る', async () => {
  const [appSource, componentSource] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EventBasicInfo.tsx', import.meta.url), 'utf8'),
  ])
  const cloudSaveHandler = appSource.slice(
    appSource.indexOf('const handleSaveSelectedEventToCloud'),
    appSource.indexOf('const blockUnsavedOperationsNavigation'),
  )
  assert.match(cloudSaveHandler, /eventBasicInfoRef\.current\?\.hasUnsavedChanges\(\)/)
  assert.ok(
    cloudSaveHandler.indexOf('hasUnsavedChanges()') <
      cloudSaveHandler.indexOf('persistEventToCloud(domainState, selectedEvent.id)'),
  )
  assert.match(appSource, /const blockUnsavedEditorNavigation[\s\S]*reportUnsavedChanges\(\)/)
  assert.match(appSource, /handleEventEditorStepChange[\s\S]*blockUnsavedEditorNavigation\(step\)/)
  assert.match(appSource, /handleBeforeWorkspaceChange[\s\S]*blockUnsavedEditorNavigation\('workspace-switch'\)/)
  assert.match(componentSource, /useImperativeHandle\(ref/)
  assert.match(componentSource, /hasEventBasicInfoDraftChanges\([\s\S]*currentDraft,[\s\S]*savedDraft/)
  assert.ok(
    componentSource.indexOf('if (validationErrors.name || validationErrors.dates) return') <
      componentSource.indexOf('setSavedDraft('),
  )
})

test('基本情報更新で既存EventDay IDを維持し、新規日と日付順のorderを反映する', () => {
  const result = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: {
      name: ' 2027 学園祭 ',
      eventDays: [
        { eventDayId: 'day-a', date: '2027-11-09' },
        { eventDayId: 'day-b', date: '2027-11-06' },
        { date: '2027-11-07' },
      ],
      description: 'イベント説明',
      notes: '運営メモ',
    },
    newEventDayIds: ['day-new'],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.event.name, '2027 学園祭')
  assert.equal(result.event.description, 'イベント説明')
  assert.equal(result.event.notes, '運営メモ')
  assert.deepEqual(result.event.performanceSlotMinutes, [5, 7, 10, 15])
  assert.deepEqual(result.eventDays, [
    { ...eventDays[1], order: 0 },
    {
      id: 'day-new',
      eventId: event.id,
      date: '2027-11-07',
      order: 1,
    },
    { ...eventDays[0], date: '2027-11-09', order: 2 },
  ])
})

test('基本情報編集でも共通の日付・イベント名validationを利用する', () => {
  assert.equal(validateEventBasicInfoDraft({
    name: '   ',
    eventDays: [{ date: '2027-11-06' }],
    description: '',
    notes: '',
  }).name, 'イベント名を入力してください。')

  assert.equal(validateEventBasicInfoDraft({
    name: '日付テスト',
    eventDays: [],
    description: '',
    notes: '',
  }).dates, '開催日を1件以上、すべて入力してください。')

  assert.equal(validateEventBasicInfoDraft({
    name: '日付テスト',
    eventDays: [{ date: '2027-11-06' }, { date: '2027-11-06' }],
    description: '',
    notes: '',
  }).dates, '同じ開催日を重複して登録できません。')

  assert.equal(validateEventBasicInfoDraft({
    name: '日付テスト',
    eventDays: [{ date: '0000-01-01' }],
    description: '',
    notes: '',
  }).dates, '有効な開催日を入力してください。')
})

test('関連データがないEventDayだけ削除可能と判定する', () => {
  assert.equal(canDeleteEventDay('day-a', noReferences), true)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    stages: [{ eventDayId: 'day-a' }],
  }), false)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    eventMemberDays: [{ eventDayId: 'day-a' }],
  }), false)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    eventBands: [{ eventDayId: 'day-a' }],
  }), false)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    paAssignments: [{ eventDayId: 'day-a' }],
  }), false)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    paAssignments: [{ eventDayId: 'day-b' }],
  }), true)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    dutyAssignments: [{ eventDayId: 'day-a' }],
  }), false)
  assert.equal(canDeleteEventDay('day-a', {
    ...noReferences,
    dutyAssignments: [{ eventDayId: 'day-b' }],
  }), true)
})

test('関連データがないEventDayを基本情報更新で削除できる', () => {
  const result = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: {
      name: event.name,
      eventDays: [{ eventDayId: 'day-a', date: '2027-11-08' }],
      description: '',
      notes: '',
    },
    newEventDayIds: [],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.eventDays, [{ ...eventDays[0], order: 0 }])
})

test('関連データがあるEventDayの削除を保存処理でもブロックする', () => {
  const result = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: {
      name: event.name,
      eventDays: [{ eventDayId: 'day-a', date: '2027-11-08' }],
      description: '',
      notes: '',
    },
    newEventDayIds: [],
    stages: [{ eventDayId: 'day-b' }],
    eventMemberDays: [],
    eventBands: [],
    paAssignments: [],
    dutyAssignments: [],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.form ?? '', /削除できません/)
})

test('一般業務担当から参照中のEventDayを保存処理でも削除できない', () => {
  const result = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: {
      name: event.name,
      eventDays: [{ eventDayId: 'day-a', date: '2027-11-08' }],
      description: '',
      notes: '',
    },
    newEventDayIds: [],
    ...noReferences,
    dutyAssignments: [{ eventDayId: 'day-b' }],
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.form ?? '', /削除できません/)
})

test('出演順制約から参照中のEventDayはUI判定と保存処理の両方で削除できない', () => {
  const references = {
    ...noReferences,
    timetableOrderConstraints: [{ eventDayId: 'day-b' }],
  }
  assert.equal(canDeleteEventDay('day-b', references), false)
  assert.equal(canDeleteEventDay('day-a', references), true)

  const result = createEventBasicInfoUpdate({
    event,
    eventDays,
    draft: {
      name: event.name,
      eventDays: [{ eventDayId: 'day-a', date: '2027-11-08' }],
      description: '',
      notes: '',
    },
    newEventDayIds: [],
    ...references,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.form ?? '', /削除できません/)
})
