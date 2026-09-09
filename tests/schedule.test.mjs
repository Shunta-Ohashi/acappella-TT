import test from 'node:test'
import assert from 'node:assert/strict'

import { getEventBandsForEventDay } from '../src/domain/schedule.ts'

test('EventBandを選択中Eventかつ現在のEventDayで絞り込む', () => {
  const sameEventAndDay = {
    id: 'event-band-current-day',
    eventId: 'event-1',
    eventDayId: 'day-1',
    memberIds: [],
    durationMinutes: 10,
  }
  const sameEventButAnotherDay = {
    id: 'event-band-another-day',
    eventId: 'event-1',
    eventDayId: 'day-2',
    memberIds: [],
    durationMinutes: 10,
  }
  const anotherEvent = {
    id: 'event-band-another-event',
    eventId: 'event-2',
    eventDayId: 'day-1',
    memberIds: [],
    durationMinutes: 10,
  }

  assert.deepEqual(
    getEventBandsForEventDay(
      [sameEventAndDay, sameEventButAnotherDay, anotherEvent],
      'event-1',
      'day-1',
    ),
    [sameEventAndDay],
  )
})
