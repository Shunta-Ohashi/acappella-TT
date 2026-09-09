import test from 'node:test'
import assert from 'node:assert/strict'

import { createEventListItems } from '../src/ui/eventList.ts'

test('EventDay・Stage・EventBandからイベント一覧の表示値を算出する', () => {
  const events = [
    {
      id: 'event-1',
      name: '2027 学園祭',
      timeZone: 'Asia/Tokyo',
      defaultTransitionMinutes: 2,
      validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    },
    {
      id: 'event-2',
      name: '日程未定イベント',
      timeZone: 'Asia/Tokyo',
      defaultTransitionMinutes: 2,
      validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    },
  ]
  const eventDays = [
    { id: 'day-2', eventId: 'event-1', date: '2027-11-07', order: 1 },
    { id: 'day-1', eventId: 'event-1', date: '2027-11-06', order: 0 },
  ]
  const stages = [
    {
      id: 'stage-1',
      eventDayId: 'day-1',
      name: '教室Stage',
      order: 0,
      plannedStartTime: '10:00',
    },
    {
      id: 'stage-2',
      eventDayId: 'day-1',
      name: '外Stage',
      order: 1,
      plannedStartTime: '10:00',
    },
    {
      id: 'stage-3',
      eventDayId: 'day-2',
      name: '教室Stage',
      order: 0,
      plannedStartTime: '10:00',
    },
  ]
  const eventBands = [
    {
      id: 'choir-day-1',
      eventId: 'event-1',
      eventDayId: 'day-1',
      bandId: 'choir',
      memberIds: ['member-1'],
      durationMinutes: 10,
    },
    {
      id: 'choir-day-2',
      eventId: 'event-1',
      eventDayId: 'day-2',
      bandId: 'choir',
      memberIds: ['member-1'],
      durationMinutes: 15,
    },
  ]

  assert.deepEqual(
    createEventListItems({ events, eventDays, stages, eventBands }),
    [
      {
        eventId: 'event-1',
        name: '2027 学園祭',
        dateLabel: '2027年11月6日・2027年11月7日',
        dayCount: 2,
        stageCount: 3,
        eventBandCount: 2,
      },
      {
        eventId: 'event-2',
        name: '日程未定イベント',
        dateLabel: '開催日未設定',
        dayCount: 0,
        stageCount: 0,
        eventBandCount: 0,
      },
    ],
  )
})
