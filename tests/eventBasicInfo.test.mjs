import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canDeleteEventDay,
  createEventBasicInfoUpdate,
  validateEventBasicInfoDraft,
} from '../src/domain/eventBasicInfo.ts'

const event = {
  id: 'event-1',
  name: '変更前イベント',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
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
}

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
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.form ?? '', /削除できません/)
})
