import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyEventMemberDayDetails,
  createEventMemberDayDetailsDraft,
  getEventMemberDayConditionSummary,
  getTimeRangeValidationError,
  normalizeTimeRanges,
  unavailableRangesToAvailabilityWindows,
  validateAvailabilityWindows,
  validatePreferredTimeRange,
} from '../src/domain/eventMemberDayDetails.ts'

const createDay = (overrides = {}) => ({
  eventMemberDayId: 'event-member-day-1',
  eventDayId: 'day-1',
  participationStatus: 'participating',
  ...overrides,
})

test('availabilityWindowsはundefined・空配列・片側開放・両側指定を受け入れる', () => {
  assert.equal(validateAvailabilityWindows(undefined), undefined)
  assert.equal(validateAvailabilityWindows([]), undefined)
  assert.equal(validateAvailabilityWindows([{ from: '13:00' }]), undefined)
  assert.equal(validateAvailabilityWindows([{ until: '17:30' }]), undefined)
  assert.equal(
    validateAvailabilityWindows([{ from: '13:00', until: '17:30' }]),
    undefined,
  )
})

test('空TimeRange・同時刻・逆転・不正LocalTimeを拒否する', () => {
  assert.equal(
    getTimeRangeValidationError({}),
    '開始時刻または終了時刻を入力してください。',
  )
  assert.equal(
    getTimeRangeValidationError({ from: '10:00', until: '10:00' }),
    '開始時刻は終了時刻より前にしてください。',
  )
  assert.equal(
    getTimeRangeValidationError({ from: '15:00', until: '12:00' }),
    '開始時刻は終了時刻より前にしてください。',
  )
  assert.equal(
    getTimeRangeValidationError({ from: '25:00' }),
    '開始時刻が正しくありません。',
  )
})

test('参加可能時間を開始順に並べ、重複・接する区間・open-ended区間を統合する', () => {
  assert.deepEqual(normalizeTimeRanges([
    { from: '15:00', until: '17:00' },
    { until: '11:00' },
    { from: '10:00', until: '12:00' },
    { from: '12:00', until: '13:00' },
    { from: '15:00', until: '17:00' },
    { from: '17:00' },
  ]), [
    { until: '13:00' },
    { from: '15:00' },
  ])
})

test('参加不可時間を正規化して参加可能時間の補集合へ変換する', () => {
  assert.deepEqual(
    unavailableRangesToAvailabilityWindows([
      { from: '15:00', until: '16:00' },
    ]),
    [{ until: '15:00' }, { from: '16:00' }],
  )
  assert.deepEqual(
    unavailableRangesToAvailabilityWindows([
      { from: '15:00', until: '16:00' },
      { from: '10:00', until: '12:00' },
    ]),
    [
      { until: '10:00' },
      { from: '12:00', until: '15:00' },
      { from: '16:00' },
    ],
  )
  assert.deepEqual(
    unavailableRangesToAvailabilityWindows([
      { from: '10:00', until: '12:00' },
      { from: '11:00', until: '13:00' },
      { from: '13:00', until: '14:00' },
    ]),
    [{ until: '10:00' }, { from: '14:00' }],
  )
})

test('open-ended参加不可と空の参加不可一覧を変換する', () => {
  assert.deepEqual(
    unavailableRangesToAvailabilityWindows([{ from: '15:00' }]),
    [{ until: '15:00' }],
  )
  assert.deepEqual(
    unavailableRangesToAvailabilityWindows([{ until: '12:00' }]),
    [{ from: '12:00' }],
  )
  assert.equal(unavailableRangesToAvailabilityWindows([]), undefined)
})

test('preferredTimeRangeはundefined・片側・両側を許可し、空・同時刻・逆転を拒否する', () => {
  assert.equal(validatePreferredTimeRange(undefined), undefined)
  assert.equal(validatePreferredTimeRange({ from: '13:00' }), undefined)
  assert.equal(validatePreferredTimeRange({ until: '12:00' }), undefined)
  assert.equal(
    validatePreferredTimeRange({ from: '13:00', until: '17:00' }),
    undefined,
  )
  assert.ok(validatePreferredTimeRange({}))
  assert.ok(validatePreferredTimeRange({ from: '13:00', until: '13:00' }))
  assert.ok(validatePreferredTimeRange({ from: '17:00', until: '13:00' }))
})

test('詳細draftを適用するとavailabilityを正規化し、希望時間とnotesを保存する', () => {
  const result = applyEventMemberDayDetails(createDay(), {
    availabilityMode: 'available',
    availabilityRanges: [
      { from: '15:00', until: '17:00' },
      { from: '10:00', until: '12:00' },
      { from: '11:00', until: '13:00' },
    ],
    preferredTimeMode: 'specified',
    preferredTimeRange: { from: ' 13:00 ', until: '' },
    notes: '  途中で授業があります  ',
  })

  assert.deepEqual(result, {
    ok: true,
    day: {
      eventMemberDayId: 'event-member-day-1',
      eventDayId: 'day-1',
      participationStatus: 'participating',
      availabilityWindows: [
        { from: '10:00', until: '13:00' },
        { from: '15:00', until: '17:00' },
      ],
      preferredTimeRange: { from: '13:00' },
      notes: '途中で授業があります',
    },
  })
})

test('参加不可入力をcanonical availabilityWindowsへ変換する', () => {
  const result = applyEventMemberDayDetails(createDay(), {
    availabilityMode: 'unavailable',
    availabilityRanges: [{ from: '15:00', until: '16:00' }],
    preferredTimeMode: 'none',
    preferredTimeRange: { from: '', until: '' },
    notes: '',
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.day.availabilityWindows, [
    { until: '15:00' },
    { from: '16:00' },
  ])
})

test('終日・希望なし・空notesは省略し、participationStatusとIDを維持する', () => {
  const day = createDay({
    participationStatus: 'absent',
    availabilityWindows: [{ from: '10:00' }],
    preferredTimeRange: { until: '17:00' },
    notes: '既存メモ',
  })
  const result = applyEventMemberDayDetails(day, {
    availabilityMode: 'all-day',
    availabilityRanges: [{ from: '', until: '' }],
    preferredTimeMode: 'none',
    preferredTimeRange: { from: '', until: '' },
    notes: '   ',
  })

  assert.deepEqual(result, {
    ok: true,
    day: {
      eventMemberDayId: day.eventMemberDayId,
      eventDayId: day.eventDayId,
      participationStatus: 'absent',
    },
  })
})

test('absentの既存詳細はdraftを変更しなければ保持される', () => {
  const day = createDay({
    participationStatus: 'absent',
    availabilityWindows: [{ from: '10:00', until: '12:00' }],
    preferredTimeRange: { until: '11:30' },
    notes: '日別メモ',
  })
  const result = applyEventMemberDayDetails(
    day,
    createEventMemberDayDetailsDraft(day),
  )

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.day, day)
})

test('一覧用サマリーで終日・参加不可・複数条件・希望・メモを区別する', () => {
  assert.deepEqual(getEventMemberDayConditionSummary(createDay()), {
    availabilityLabel: '終日',
    hasDetails: false,
  })
  assert.deepEqual(getEventMemberDayConditionSummary(createDay({
    availabilityWindows: [],
  })), {
    availabilityLabel: '参加可能時間なし',
    hasDetails: true,
  })
  assert.deepEqual(getEventMemberDayConditionSummary(createDay({
    availabilityWindows: [
      { from: '10:00', until: '12:00' },
      { from: '15:00', until: '17:00' },
    ],
    preferredTimeRange: { from: '15:00' },
    notes: '希望あり',
  })), {
    availabilityLabel: '10:00〜12:00 他1件',
    hasDetails: true,
    supplementaryLabel: '希望あり / メモあり',
  })
})
