import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getReferencedScheduleItemIds,
  getReferencedSectionIds,
  isValidScheduleBoundaryShape,
  resolveEffectiveSectionInterval,
  resolveScheduleBoundaryInterval,
} from '../src/domain/scheduleBoundaries.ts'
import {
  createAssignmentRangeForMode,
  createDefaultAssignmentRange,
  getAssignmentRangeMode,
} from '../src/domain/assignmentRanges.ts'

const stage = {
  id: 'stage-1', eventDayId: 'day-1', name: 'Main', order: 0,
  plannedStartTime: '10:00', plannedEndTime: '18:00',
}
const sections = [
  { id: 'section-1', stageId: stage.id, name: '第1部', order: 0 },
  { id: 'section-2', stageId: stage.id, name: '第2部', order: 1 },
]
const items = [
  {
    scheduleItemId: 'item-1', eventDayId: 'day-1', stageId: stage.id,
    sectionId: 'section-1', kind: 'performance',
    plannedStartMinute: 600, plannedEndMinute: 610,
  },
  {
    scheduleItemId: 'item-2', eventDayId: 'day-1', stageId: stage.id,
    sectionId: 'section-2', kind: 'performance',
    plannedStartMinute: 615, plannedEndMinute: 625,
  },
]
const context = { stages: [stage], sections }
const resolve = (from, until, calculatedItems = items, configuredContext = context) =>
  resolveScheduleBoundaryInterval({
    eventDayId: 'day-1', stageId: stage.id, from, until,
  }, calculatedItems, '担当', configuredContext)

test('ScheduleItem境界は既存のstart/end時刻を解決する', () => {
  assert.deepEqual(resolve(
    { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' },
  ), { ok: true, interval: { fromMinute: 600, untilMinute: 610 } })
})

test('Section境界はplanned anchorを優先し、未指定時はitemとcross-section transitionへfallbackする', () => {
  const anchored = {
    ...sections[0], plannedStartTime: '10:30', plannedEndTime: '11:30',
  }
  assert.deepEqual(resolveEffectiveSectionInterval({
    section: anchored, stage, sections: [anchored, sections[1]], calculatedItems: items,
  }), { ok: true, interval: { fromMinute: 630, untilMinute: 690 } })

  assert.deepEqual(resolveEffectiveSectionInterval({
    section: sections[0], stage, sections, calculatedItems: items,
  }), { ok: true, interval: { fromMinute: 600, untilMinute: 615 } })

  const emptyMiddle = {
    id: 'section-empty', stageId: stage.id, name: '空の部', order: 1,
  }
  const lastSection = { ...sections[1], order: 2 }
  assert.deepEqual(resolveEffectiveSectionInterval({
    section: sections[0], stage,
    sections: [sections[0], emptyMiddle, lastSection],
    calculatedItems: items,
  }), { ok: true, interval: { fromMinute: 600, untilMinute: 615 } })

  const betweenBreak = {
    scheduleItemId: 'between-break', eventDayId: 'day-1', stageId: stage.id,
    afterSectionId: 'section-1', kind: 'break',
    plannedStartMinute: 610, plannedEndMinute: 615,
  }
  assert.deepEqual(resolveEffectiveSectionInterval({
    section: sections[0], stage, sections,
    calculatedItems: [items[0], betweenBreak, items[1]],
  }), { ok: true, interval: { fromMinute: 600, untilMinute: 610 } })
})

test('空Sectionは対応するanchorがあるedgeだけ解決し、両anchorなら全体を解決する', () => {
  const both = {
    id: 'empty', stageId: stage.id, name: '空', order: 2,
    plannedStartTime: '13:00', plannedEndTime: '14:00',
  }
  assert.deepEqual(resolve(
    { kind: 'section', sectionId: both.id, edge: 'start' },
    { kind: 'section', sectionId: both.id, edge: 'end' },
    [], { stages: [stage], sections: [both] },
  ), { ok: true, interval: { fromMinute: 780, untilMinute: 840 } })

  const startOnly = { ...both, id: 'start-only', plannedEndTime: undefined }
  assert.equal(resolve(
    { kind: 'section', sectionId: startOnly.id, edge: 'start' },
    { kind: 'time', time: '13:30' }, [],
    { stages: [stage], sections: [startOnly] },
  ).ok, true)
  assert.equal(resolve(
    { kind: 'time', time: '12:30' },
    { kind: 'section', sectionId: startOnly.id, edge: 'end' }, [],
    { stages: [stage], sections: [startOnly] },
  ).ok, false)
})

test('Section offsetはstartへ加算、endから減算し、Section外を拒否する', () => {
  assert.deepEqual(resolve(
    { kind: 'section', sectionId: 'section-1', edge: 'start', offsetMinutes: 5 },
    { kind: 'section', sectionId: 'section-1', edge: 'end', offsetMinutes: 2 },
  ), { ok: true, interval: { fromMinute: 605, untilMinute: 613 } })
  assert.equal(resolve(
    { kind: 'section', sectionId: 'section-1', edge: 'start', offsetMinutes: 16 },
    { kind: 'time', time: '17:00' },
  ).ok, false)
  assert.equal(isValidScheduleBoundaryShape({
    kind: 'section', sectionId: 'section-1', edge: 'start', offsetMinutes: -1,
  }), false)
  assert.equal(isValidScheduleBoundaryShape({
    kind: 'section', sectionId: 'section-1', edge: 'start', offsetMinutes: 1.5,
  }), false)
})

test('直接時刻はLocalTimeとStage範囲を検証し、同値・逆転intervalを拒否する', () => {
  assert.deepEqual(resolve(
    { kind: 'time', time: '10:30' },
    { kind: 'time', time: '17:30' },
  ), { ok: true, interval: { fromMinute: 630, untilMinute: 1050 } })
  assert.equal(isValidScheduleBoundaryShape({ kind: 'time', time: '25:00' }), false)
  assert.equal(resolve(
    { kind: 'time', time: '09:59' }, { kind: 'time', time: '10:30' },
  ).ok, false)
  assert.equal(resolve(
    { kind: 'time', time: '17:00' }, { kind: 'time', time: '18:01' },
  ).ok, false)
  assert.equal(resolve(
    { kind: 'time', time: '11:00' }, { kind: 'time', time: '11:00' },
  ).ok, false)
  assert.equal(resolve(
    { kind: 'time', time: '12:00' }, { kind: 'time', time: '11:00' },
  ).ok, false)
})

test('resolverはmalformed Boundaryをthrowせずfail closedにする', () => {
  const validUntil = { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' }
  const malformed = [
    undefined,
    null,
    { scheduleItemId: 'item-1', edge: 'start' },
    { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'middle' },
    { kind: 'schedule-item', scheduleItemId: 'item-1', edge: null },
    { kind: 'schedule-item', scheduleItemId: 'item-1' },
    { kind: 'section', sectionId: 'section-1', edge: 'middle' },
    { kind: 'section', sectionId: 'section-1' },
    { kind: 'unknown', edge: 'start' },
    { kind: 'schedule-item', edge: 'start' },
    { kind: 'section', edge: 'start' },
    { kind: 'time' },
    { kind: 'section', sectionId: 'section-1', edge: 'start', offsetMinutes: -1 },
    { kind: 'time', time: '24:00' },
  ]
  for (const from of malformed) {
    assert.doesNotThrow(() => resolve(from, validUntil))
    assert.equal(resolve(from, validUntil).ok, false)
  }
})

test('Section effective intervalは明示anchorとfallback edgeをStage範囲内に制限する', () => {
  for (const section of [
    { id: 'too-early', stageId: stage.id, name: '早い', order: 0,
      plannedStartTime: '09:00', plannedEndTime: '11:00' },
    { id: 'too-late', stageId: stage.id, name: '遅い', order: 0,
      plannedStartTime: '17:00', plannedEndTime: '19:00' },
    { id: 'reversed', stageId: stage.id, name: '逆転', order: 0,
      plannedStartTime: '12:00', plannedEndTime: '11:00' },
    { id: 'at-end', stageId: stage.id, name: '終了境界', order: 0,
      plannedStartTime: '18:00' },
  ]) {
    assert.equal(resolveEffectiveSectionInterval({
      section, stage, sections: [section], calculatedItems: [],
    }).ok, false)
  }

  const exact = { id: 'exact', stageId: stage.id, name: '全時間', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '18:00' }
  assert.deepEqual(resolveEffectiveSectionInterval({
    section: exact, stage, sections: [exact], calculatedItems: [],
  }), { ok: true, interval: { fromMinute: 600, untilMinute: 1080 } })

  const fallback = { id: 'fallback', stageId: stage.id, name: 'fallback', order: 0 }
  assert.equal(resolveEffectiveSectionInterval({
    section: fallback, stage, sections: [fallback],
    calculatedItems: [{ ...items[0], sectionId: fallback.id,
      plannedStartMinute: 590, plannedEndMinute: 610 }],
  }).ok, false)
})

test('別StageのSectionを拒否し、参照helperは各boundary kindだけを抽出する', () => {
  const foreignSection = { id: 'foreign', stageId: 'stage-2', name: '別', order: 0 }
  assert.equal(resolve(
    { kind: 'section', sectionId: foreignSection.id, edge: 'start' },
    { kind: 'time', time: '12:00' }, items,
    { stages: [stage], sections: [...sections, foreignSection] },
  ).ok, false)

  const boundaries = [
    { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'start' },
    { kind: 'schedule-item', scheduleItemId: 'item-1', edge: 'end' },
    { kind: 'section', sectionId: 'section-1', edge: 'start' },
    { kind: 'time', time: '13:00' },
  ]
  assert.deepEqual(getReferencedScheduleItemIds(boundaries), ['item-1'])
  assert.deepEqual(getReferencedSectionIds(boundaries), ['section-1'])
})

test('Section全体と一部をoffset fieldの有無で安定して区別する', () => {
  const whole = createDefaultAssignmentRange({
    mode: 'section-whole', stage, sections, calculatedItems: items,
  })
  const partial = createDefaultAssignmentRange({
    mode: 'section-partial', stage, sections, calculatedItems: items,
  })

  assert.ok(whole)
  assert.ok(partial)
  assert.equal(getAssignmentRangeMode(whole.from, whole.until), 'section-whole')
  assert.equal(getAssignmentRangeMode(partial.from, partial.until), 'section-partial')
  assert.equal(partial.from.offsetMinutes, 0)
  assert.equal(partial.until.offsetMinutes, 0)
  assert.equal(getAssignmentRangeMode(
    { ...partial.from, offsetMinutes: 15 },
    { ...partial.until, offsetMinutes: 10 },
  ), 'section-partial')
})

test('Section全体と一部の切替は現在のSection IDを維持しoffsetだけを正規化する', () => {
  const whole = {
    from: { kind: 'section', sectionId: 'section-2', edge: 'start' },
    until: { kind: 'section', sectionId: 'section-2', edge: 'end' },
  }
  const partial = createAssignmentRangeForMode({
    mode: 'section-partial', ...whole, stage, sections, calculatedItems: items,
  })
  assert.deepEqual(partial, {
    from: { kind: 'section', sectionId: 'section-2', edge: 'start', offsetMinutes: 0 },
    until: { kind: 'section', sectionId: 'section-2', edge: 'end', offsetMinutes: 0 },
  })

  const backToWhole = createAssignmentRangeForMode({
    mode: 'section-whole',
    from: { ...partial.from, offsetMinutes: 10 },
    until: { ...partial.until, offsetMinutes: 5 },
    stage, sections, calculatedItems: items,
  })
  assert.deepEqual(backToWhole, whole)
  assert.deepEqual(createAssignmentRangeForMode({
    mode: 'section-whole', ...partial, stage, sections, calculatedItems: items,
  }), whole)
})

test('参照切れSectionもmode切替では維持し、他modeからは既存defaultを利用する', () => {
  const missing = {
    from: { kind: 'section', sectionId: 'missing-section', edge: 'start' },
    until: { kind: 'section', sectionId: 'missing-section', edge: 'end' },
  }
  const missingPartial = createAssignmentRangeForMode({
    mode: 'section-partial', ...missing, stage, sections, calculatedItems: items,
  })
  assert.equal(missingPartial.from.sectionId, 'missing-section')
  assert.equal(missingPartial.until.sectionId, 'missing-section')

  for (const current of [
    {
      from: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'start' },
      until: { kind: 'schedule-item', scheduleItemId: 'item-2', edge: 'end' },
    },
    {
      from: { kind: 'time', time: '12:00' },
      until: { kind: 'time', time: '13:00' },
    },
  ]) {
    assert.deepEqual(createAssignmentRangeForMode({
      mode: 'section-whole', ...current, stage, sections, calculatedItems: items,
    }), {
      from: { kind: 'section', sectionId: 'section-1', edge: 'start' },
      until: { kind: 'section', sectionId: 'section-1', edge: 'end' },
    })
  }
})
