import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ACTIVITY_SPACING_POLICY,
  buildDutyActivities,
  buildPaActivities,
  buildPerformanceActivities,
  evaluateActivityPair,
  evaluateMemberActivitySpacing,
  getActivitySpacingCategory,
  validateActivitySpacingPolicy,
} from '../src/domain/activitySpacing.ts'

const activity = (id, kind, fromMinute, untilMinute, overrides = {}) => ({
  id, kind, fromMinute, untilMinute,
  memberId: 'member-1', eventDayId: 'day-1', stageId: 'stage-1',
  ...overrides,
})

const item = (id, kind, fromMinute, untilMinute, overrides = {}) => ({
  scheduleItemId: id, kind,
  eventDayId: 'day-1', stageId: 'stage-1',
  plannedStartMinute: fromMinute, plannedEndMinute: untilMinute,
  ...(kind === 'performance' ? { eventBandId: `band-${id}` } : {}),
  ...overrides,
})

const evaluateRest = (firstKind, secondKind, restMinutes, options = {}) =>
  evaluateActivityPair({
    previous: activity('first', firstKind, 0, 10),
    next: activity('second', secondKind, 10 + restMinutes, 20 + restMinutes),
    ...options,
  })

test('PerformanceとPA/Dutyの全組み合わせを4種類の間隔へ分類する', () => {
  const expected = [
    ['performance', 'performance', 'performance-to-performance'],
    ['pa', 'performance', 'work-to-performance'],
    ['duty', 'performance', 'work-to-performance'],
    ['performance', 'pa', 'performance-to-work'],
    ['performance', 'duty', 'performance-to-work'],
    ['pa', 'duty', 'work-to-work'],
    ['duty', 'pa', 'work-to-work'],
    ['pa', 'pa', 'work-to-work'],
    ['duty', 'duty', 'work-to-work'],
  ]
  for (const [first, second, category] of expected) {
    assert.equal(getActivitySpacingCategory(first, second), category)
  }
})

test('DEFAULT policyは各categoryの厳密な境界でHard・最終手段・適切・十分を分ける', () => {
  const cases = [
    ['performance', 'performance', 5, 15, 30],
    ['pa', 'performance', 5, 15, 20],
    ['performance', 'duty', 5, 10, 15],
    ['duty', 'pa', 5, 10, 15],
  ]
  for (const [firstKind, secondKind, minimum, preferred, sufficient] of cases) {
    const expected = [
      [minimum - 1, 'hard-violation', false],
      [minimum, 'last-resort', true],
      [preferred - 1, 'last-resort', true],
      [preferred, 'preferred', true],
      [sufficient - 1, 'preferred', true],
      [sufficient, 'sufficient', true],
      [sufficient + 1, 'sufficient', true],
    ]
    for (const [rest, level, feasible] of expected) {
      const result = evaluateRest(firstKind, secondKind, rest)
      assert.equal(result.restMinutes, rest)
      assert.equal(result.level, level, `${firstKind}→${secondKind}, rest ${rest}`)
      assert.equal(result.feasible, feasible)
      if (level === 'sufficient') assert.equal(result.penalty, 0)
      if (level === 'last-resort') assert.ok(result.penalty >= 100)
      if (level === 'preferred') assert.ok(result.penalty > 0 && result.penalty < 100)
    }
    assert.deepEqual(
      [evaluateRest(firstKind, secondKind, sufficient).level,
        evaluateRest(firstKind, secondKind, sufficient).penalty],
      [evaluateRest(firstKind, secondKind, sufficient + 30).level,
        evaluateRest(firstKind, secondKind, sufficient + 30).penalty],
    )
  }
})

test('幅の広いcustom policyでもpreferred penaltyはlast-resortより低い', () => {
  const policy = {
    ...DEFAULT_ACTIVITY_SPACING_POLICY,
    'performance-to-performance': {
      minimumMinutes: 0, preferredMinutes: 1, sufficientMinutes: 1000,
    },
  }
  const evaluate = rest => evaluateRest('performance', 'performance', rest, { policy })
  const lastResort = evaluate(0)
  const preferred = evaluate(1)
  assert.equal(lastResort.restLevel, 'last-resort')
  assert.equal(preferred.restLevel, 'preferred')
  assert.ok(preferred.penalty < lastResort.penalty)
  assert.deepEqual([evaluate(1000).penalty, evaluate(1030).penalty], [0, 0])
})

test('極端なcustom policyでも休憩が長いほどpenaltyは増えずzone間で逆転しない', () => {
  for (const [minimumMinutes, preferredMinutes, sufficientMinutes] of [
    [0, 1, 1000], [0, 1000, 1001], [5, 5, 1000], [5, 1000, 1000], [5, 5, 5],
  ]) {
    const policy = {
      ...DEFAULT_ACTIVITY_SPACING_POLICY,
      'performance-to-performance': { minimumMinutes, preferredMinutes, sufficientMinutes },
    }
    const evaluate = rest => evaluateRest('performance', 'performance', rest, { policy })
    const boundaries = [minimumMinutes, preferredMinutes - 1, preferredMinutes,
      sufficientMinutes - 1, sufficientMinutes]
      .filter(rest => rest >= minimumMinutes)
    const results = [...new Set(boundaries)].sort((left, right) => left - right).map(evaluate)
    for (const result of results) {
      assert.equal(result.feasible, true)
      assert.ok(Number.isFinite(result.penalty) && result.penalty >= 0)
      assert.equal(result.penalty, evaluate(result.restMinutes).penalty)
      if (result.restLevel === 'last-resort') assert.ok(result.penalty >= 100 && result.penalty <= 199)
      if (result.restLevel === 'preferred') assert.ok(result.penalty >= 1 && result.penalty <= 20)
      if (result.restLevel === 'sufficient') assert.equal(result.penalty, 0)
    }
    for (let index = 1; index < results.length; index += 1) {
      assert.ok(results[index].penalty <= results[index - 1].penalty)
    }
    if (minimumMinutes < preferredMinutes && preferredMinutes < sufficientMinutes) {
      assert.ok(evaluate(preferredMinutes).penalty < evaluate(preferredMinutes - 1).penalty)
    }
  }
})

test('半開区間では接触をoverlapにせず休憩0分、実overlapはHardにする', () => {
  const previous = activity('first', 'performance', 600, 610)
  const overlap = evaluateActivityPair({
    previous, next: activity('second', 'duty', 609, 620),
  })
  const touching = evaluateActivityPair({
    previous, next: activity('second', 'duty', 610, 620),
  })
  assert.equal(overlap.overlaps, true)
  assert.equal(overlap.restMinutes, -1)
  assert.equal(overlap.feasible, false)
  assert.equal(touching.overlaps, false)
  assert.equal(touching.restMinutes, 0)
  assert.equal(touching.feasible, false)
})

test('0以上の昇順thresholdだけを認め、NaN・Infinity・小数も拒否する', () => {
  validateActivitySpacingPolicy(DEFAULT_ACTIVITY_SPACING_POLICY)
  for (const invalid of [-1, NaN, Infinity, 5.5, 16]) {
    assert.throws(() => validateActivitySpacingPolicy({
      ...DEFAULT_ACTIVITY_SPACING_POLICY,
      'performance-to-performance': {
        ...DEFAULT_ACTIVITY_SPACING_POLICY['performance-to-performance'],
        minimumMinutes: invalid,
      },
    }), RangeError)
  }
  assert.throws(() => validateActivitySpacingPolicy({
    ...DEFAULT_ACTIVITY_SPACING_POLICY,
    'work-to-work': { minimumMinutes: 5, preferredMinutes: 4, sufficientMinutes: 15 },
  }), RangeError)
  assert.throws(() => validateActivitySpacingPolicy({
    ...DEFAULT_ACTIVITY_SPACING_POLICY,
    'work-to-work': { minimumMinutes: 5, preferredMinutes: 10, sufficientMinutes: 9 },
  }), RangeError)
})

test('同Stageのband gapは間のPerformanceだけを数え、1組を最終手段・2組を良好にする', () => {
  const previous = activity('a', 'performance', 0, 10, { scheduleItemId: 'a' })
  const next = activity('b', 'performance', 50, 60, { scheduleItemId: 'b' })
  const first = item('a', 'performance', 0, 10)
  const last = item('b', 'performance', 50, 60)
  const x = item('x', 'performance', 12, 20)
  const y = item('y', 'performance', 22, 30)
  const breakItem = item('break', 'break', 30, 40)
  const evaluate = stageItems => evaluateActivityPair({ previous, next, stageItems })

  assert.deepEqual([evaluate([first, last]).bandGap, evaluate([first, last]).feasible], [0, false])
  assert.equal(evaluate([first, x, breakItem, last]).bandGap, 1)
  assert.equal(evaluate([first, x, breakItem, last]).bandGapLevel, 'last-resort')
  assert.equal(evaluate([first, x, breakItem, last]).penalty, 50)
  assert.equal(evaluate([first, x, y, last]).bandGap, 2)
  assert.equal(evaluate([first, x, y, last]).bandGapLevel, 'good')
  assert.equal(evaluate([first, x, y, last]).penalty, 0)
})

test('明示Breakと十分な実休憩があれば0 bandを代替し、29分では代替しない', () => {
  const previous = activity('a', 'performance', 0, 10)
  const stageItems = [item('a', 'performance', 0, 10), item('break', 'break', 10, 40)]
  const sufficient = evaluateActivityPair({
    previous, next: activity('b', 'performance', 40, 50),
    stageItems: [...stageItems, item('b', 'performance', 40, 50)],
  })
  const short = evaluateActivityPair({
    previous, next: activity('b', 'performance', 39, 49),
    stageItems: [item('a', 'performance', 0, 10), item('break', 'break', 10, 39),
      item('b', 'performance', 39, 49)],
  })
  assert.equal(sufficient.bandGap, 0)
  assert.equal(sufficient.bandGapLevel, 'break-substituted')
  assert.equal(sufficient.feasible, true)
  assert.equal(sufficient.penalty, 0)
  assert.equal(short.restLevel, 'preferred')
  assert.equal(short.bandGapLevel, 'hard-violation')
  assert.equal(short.feasible, false)
  assert.equal(short.penalty, 0)
})

test('短い明示BreakとSection anchor由来のidle gapを合算して代替しない', () => {
  const previous = activity('a', 'performance', 0, 10)
  for (const breakEnd of [11, 39]) {
    const next = activity('b', 'performance', 40, 50)
    const result = evaluateActivityPair({
      previous, next,
      stageItems: [
        item('a', 'performance', 0, 10),
        item('break', 'break', 10, breakEnd),
        item('b', 'performance', 40, 50),
      ],
    })
    assert.equal(result.restMinutes, 30)
    assert.equal(result.bandGap, 0)
    assert.equal(result.bandGapLevel, 'hard-violation')
    assert.equal(result.feasible, false)
  }
})

test('複数Breakの重複時間は代替時間へ二重計上しない', () => {
  const previous = activity('a', 'performance', 0, 10)
  const next = activity('b', 'performance', 40, 50)
  const evaluate = breaks => evaluateActivityPair({
    previous, next,
    stageItems: [item('a', 'performance', 0, 10), ...breaks, item('b', 'performance', 40, 50)],
  })
  assert.equal(evaluate([
    item('break-1', 'break', 10, 25),
    item('break-2', 'break', 25, 40),
  ]).bandGapLevel, 'break-substituted')
  assert.equal(evaluate([
    item('break-1', 'break', 10, 30),
    item('break-2', 'break', 10, 30),
  ]).bandGapLevel, 'hard-violation')
})

test('同StageのPerformance↔workにもband gapを適用し、work↔workは実時間のみで判定する', () => {
  const stageItems = [item('a', 'performance', 0, 10),
    item('b', 'performance', 50, 60)]
  const performanceToWork = evaluateActivityPair({
    previous: activity('a', 'performance', 0, 10),
    next: activity('work', 'pa', 50, 60), stageItems,
  })
  const workToPerformance = evaluateActivityPair({
    previous: activity('work', 'duty', 0, 10),
    next: activity('b', 'performance', 50, 60), stageItems,
  })
  const workToWork = evaluateActivityPair({
    previous: activity('first-work', 'pa', 0, 10),
    next: activity('second-work', 'duty', 50, 60), stageItems,
  })
  assert.deepEqual([performanceToWork.bandGap, performanceToWork.feasible], [0, false])
  assert.deepEqual([workToPerformance.bandGap, workToPerformance.feasible], [0, false])
  assert.equal(workToWork.bandGap, undefined)
  assert.equal(workToWork.feasible, true)
})

test('別Stageではband gapを推定せず実休憩だけ評価する', () => {
  const result = evaluateActivityPair({
    previous: activity('a', 'performance', 600, 610),
    next: activity('b', 'performance', 620, 630, { stageId: 'stage-2' }),
    stageItems: [item('a', 'performance', 600, 610), item('b', 'performance', 620, 630, {
      stageId: 'stage-2',
    })],
  })
  assert.equal(result.bandGap, undefined)
  assert.equal(result.restMinutes, 10)
  assert.equal(result.level, 'last-resort')
  assert.equal(result.feasible, true)
})

test('一覧評価は入力順や同時刻開始に依存せず、離れた要素間のoverlapも検出する', () => {
  const activities = Object.freeze([
    Object.freeze(activity('c', 'duty', 615, 625)),
    Object.freeze(activity('a', 'performance', 600, 620)),
    Object.freeze(activity('b', 'pa', 605, 610)),
  ])
  const evaluate = values => evaluateMemberActivitySpacing({ activities: values })
  const result = evaluate(activities)
  assert.deepEqual(result, evaluate([...activities].reverse()))
  assert.equal(result.feasible, false)
  assert.ok(result.pairs.some(pair => pair.previous.id === 'a' && pair.next.id === 'c' && pair.overlaps))
  assert.deepEqual(evaluate([]), { pairs: [], feasible: true, totalPenalty: 0 })

  const sameTime = [activity('z', 'pa', 600, 610), activity('a', 'duty', 600, 610)]
  assert.deepEqual(evaluate(sameTime), evaluate([...sameTime].reverse()))
  assert.throws(() => evaluate([activity('a', 'pa', 0, 10),
    activity('b', 'duty', 20, 30, { eventDayId: 'day-2' })]), RangeError)
})

test('Performance builderはEventBandの各Memberへ展開し参照切れを推測しない', () => {
  const calculated = Object.freeze([
    Object.freeze(item('a', 'performance', 600, 610)),
    Object.freeze(item('missing', 'performance', 620, 630)),
  ])
  const bands = Object.freeze([Object.freeze({
    id: 'band-a', eventId: 'event-1', eventDayId: 'day-1', name: 'Band A',
    memberIds: Object.freeze(['member-1', 'member-2', 'member-1']), durationMinutes: 10,
  })])
  const result = buildPerformanceActivities(calculated, bands)
  assert.deepEqual(result.activities.map(value => value.memberId), ['member-1', 'member-2'])
  assert.deepEqual(result.activities.map(value => value.scheduleItemId), ['a', 'a'])
  assert.deepEqual(result.unresolved.map(value => value.id), ['missing'])
  assert.equal(buildPerformanceActivities([item('foreign', 'performance', 0, 10,
    { eventBandId: 'band-a', eventDayId: 'day-2' })], bands).unresolved.length, 1)
})

test('PA/Duty builderは共通Boundary解決を使い、Break endと参照切れを扱う', () => {
  const calculated = Object.freeze([
    Object.freeze(item('performance', 'performance', 600, 610)),
    Object.freeze(item('break', 'break', 610, 625)),
  ])
  const base = {
    eventDayId: 'day-1', stageId: 'stage-1', memberId: 'member-1',
    from: { scheduleItemId: 'performance', edge: 'start' },
    until: { scheduleItemId: 'break', edge: 'end' },
  }
  const pa = Object.freeze({ id: 'pa-1', eventId: 'event-1', role: 'main', ...base })
  const duty = Object.freeze({ id: 'duty-1', dutyTypeId: 'duty-type-1', ...base })
  const broken = Object.freeze({ ...base, id: 'pa-broken',
    until: { scheduleItemId: 'missing', edge: 'end' } })
  const paResult = buildPaActivities([pa, broken], calculated)
  const dutyResult = buildDutyActivities([duty, { ...broken, id: 'duty-broken' }], calculated)
  assert.deepEqual(paResult.activities.map(value => [value.kind, value.fromMinute,
    value.untilMinute, value.paAssignmentId]), [['pa', 600, 625, 'pa-1']])
  assert.deepEqual(dutyResult.activities.map(value => [value.kind, value.fromMinute,
    value.untilMinute, value.dutyAssignmentId]), [['duty', 600, 625, 'duty-1']])
  assert.equal(paResult.unresolved[0].id, 'pa-broken')
  assert.match(paResult.unresolved[0].reason, /終了参照先/)
  assert.equal(dutyResult.unresolved[0].id, 'duty-broken')
})

test('候補Activityを既存一覧へ追加して同じ評価APIで可否とpenaltyを比較できる', () => {
  const existing = activity('existing', 'performance', 600, 610)
  const candidate = start => activity('candidate', 'duty', start, start + 10,
    { stageId: 'stage-2' })
  assert.equal(evaluateMemberActivitySpacing({
    activities: [existing, candidate(614)],
  }).feasible, false)
  const minimum = evaluateMemberActivitySpacing({
    activities: [existing, candidate(615)],
  })
  const sufficient = evaluateMemberActivitySpacing({
    activities: [existing, candidate(625)],
  })
  assert.equal(minimum.feasible, true)
  assert.ok(minimum.totalPenalty >= 100)
  assert.equal(sufficient.totalPenalty, 0)
})
