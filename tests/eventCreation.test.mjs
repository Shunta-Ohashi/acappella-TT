import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createEventData,
  validateNewEventDraft,
} from '../src/domain/eventCreation.ts'

const defaults = {
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
}

test('非連続の複数開催日を日付昇順に並べてorderを付ける', () => {
  const created = createEventData({
    eventId: 'event-new',
    eventDayIds: ['event-day-first', 'event-day-second'],
    draft: {
      name: ' 2027 学園祭 ',
      dates: ['2027-11-08', '2027-11-06'],
    },
    defaults,
  })

  assert.deepEqual(created.event, {
    id: 'event-new',
    name: '2027 学園祭',
    ...defaults,
    performanceSlotMinutes: [5, 10, 15],
  })
  assert.deepEqual(created.eventDays, [
    {
      id: 'event-day-first',
      eventId: 'event-new',
      date: '2027-11-06',
      order: 0,
    },
    {
      id: 'event-day-second',
      eventId: 'event-new',
      date: '2027-11-08',
      order: 1,
    },
  ])
})

test('同じ開催日の重複を拒否する', () => {
  const errors = validateNewEventDraft({
    name: '重複テスト',
    dates: ['2027-11-06', '2027-11-06'],
  })

  assert.equal(errors.dates, '同じ開催日を重複して登録できません。')
})

test('空の開催日を拒否する', () => {
  const errors = validateNewEventDraft({
    name: '空欄テスト',
    dates: ['2027-11-06', ''],
  })

  assert.equal(errors.dates, '開催日を1件以上、すべて入力してください。')
})

test('イベント名の空欄と実在しない日付を拒否する', () => {
  const errors = validateNewEventDraft({
    name: '   ',
    dates: ['2027-02-30'],
  })

  assert.equal(errors.name, 'イベント名を入力してください。')
  assert.equal(errors.dates, '有効な開催日を入力してください。')
})

test('HTMLの日付入力で表現できない年0を拒否する', () => {
  const errors = validateNewEventDraft({
    name: '年0テスト',
    dates: ['0000-01-01'],
  })

  assert.equal(errors.dates, '有効な開催日を入力してください。')
})
