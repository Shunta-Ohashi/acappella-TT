import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getTimetableGridAssignmentTargetLabel,
  resolveTimetableGridSelection,
  selectTimetableGridCell,
} from '../src/ui/timetableGridSelection.ts'

const makeRow = ({
  id,
  fromMinute,
  untilMinute,
  eventDayId = 'day-1',
  stageId = 'stage-1',
  sectionId,
  afterSectionId,
  kind = 'performance',
}) => ({
  scheduleItem: kind === 'break'
    ? {
        id,
        stageId,
        order: 0,
        kind: 'break',
        title: '休憩',
        durationMinutes: untilMinute - fromMinute,
        ...(sectionId ? { sectionId } : {}),
        ...(afterSectionId ? { afterSectionId } : {}),
      }
    : {
        id,
        stageId,
        order: 0,
        kind: 'performance',
        eventBandId: `band-${id}`,
        ...(sectionId ? { sectionId } : {}),
      },
  calculatedItem: {
    scheduleItemId: id,
    eventDayId,
    stageId,
    kind,
    plannedStartMinute: fromMinute,
    plannedEndMinute: untilMinute,
    ...(sectionId ? { sectionId } : {}),
    ...(afterSectionId ? { afterSectionId } : {}),
  },
  memberNames: [],
  issueCounts: { ERROR: 0, WARNING: 0, INFO: 0 },
  fixedPlacementLabels: [],
  hasHardTimeCondition: false,
  hasPreferredTimeCondition: false,
  paCoverage: { main: [], sub: [] },
  dutyCoverage: {},
})

const rows = [
  makeRow({
    id: 'performance-a',
    fromMinute: 600,
    untilMinute: 607,
    sectionId: 'section-1',
  }),
  makeRow({
    id: 'inter-section-break',
    fromMinute: 607,
    untilMinute: 617,
    afterSectionId: 'section-1',
    kind: 'break',
  }),
  makeRow({
    id: 'performance-b',
    fromMinute: 630,
    untilMinute: 640,
    sectionId: 'section-2',
  }),
]

const createSelection = ({
  target = { kind: 'pa', role: 'main' },
  anchorScheduleItemId = 'performance-a',
  focusScheduleItemId = anchorScheduleItemId,
  eventDayId = 'day-1',
  stageId = 'stage-1',
} = {}) => ({
  eventDayId,
  stageId,
  target,
  anchorScheduleItemId,
  focusScheduleItemId,
})

test('Main/Sub PAとDutyの単一セルをScheduleItem boundaryへ解決する', () => {
  for (const target of [
    { kind: 'pa', role: 'main' },
    { kind: 'pa', role: 'sub' },
    { kind: 'duty', dutyTypeId: 'duty-photo' },
  ]) {
    const resolved = resolveTimetableGridSelection(
      createSelection({ target }),
      rows,
    )
    assert.ok(resolved)
    assert.equal(resolved.rowCount, 1)
    assert.deepEqual(resolved.scheduleItemIds, ['performance-a'])
    assert.equal(resolved.fromMinute, 600)
    assert.equal(resolved.untilMinute, 607)
    assert.deepEqual(resolved.fromBoundary, {
      kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'start',
    })
    assert.deepEqual(resolved.untilBoundary, {
      kind: 'schedule-item', scheduleItemId: 'performance-a', edge: 'end',
    })
  }
})

test('同一列の複数行rangeを現在のrow順へ正規化する', () => {
  const twoRows = resolveTimetableGridSelection(createSelection({
    focusScheduleItemId: 'inter-section-break',
  }), rows)
  const forward = resolveTimetableGridSelection(createSelection({
    focusScheduleItemId: 'performance-b',
  }), rows)
  const reverse = resolveTimetableGridSelection(createSelection({
    anchorScheduleItemId: 'performance-b',
    focusScheduleItemId: 'performance-a',
  }), rows)

  assert.ok(twoRows)
  assert.deepEqual(twoRows.scheduleItemIds, [
    'performance-a', 'inter-section-break',
  ])
  assert.equal(twoRows.rowCount, 2)

  for (const resolved of [forward, reverse]) {
    assert.ok(resolved)
    assert.deepEqual(resolved.scheduleItemIds, [
      'performance-a', 'inter-section-break', 'performance-b',
    ])
    assert.equal(resolved.rowCount, 3)
    assert.equal(resolved.fromMinute, 600)
    assert.equal(resolved.untilMinute, 640)
  }
})

test('cross-Section・部間Break・fixed Section startの空白を同じrangeで扱う', () => {
  const resolved = resolveTimetableGridSelection(createSelection({
    focusScheduleItemId: 'performance-b',
  }), rows)

  assert.ok(resolved)
  assert.equal(resolved.firstRow.scheduleItem.sectionId, 'section-1')
  assert.equal(resolved.lastRow.scheduleItem.sectionId, 'section-2')
  assert.equal(resolved.scheduleItemIds.includes('inter-section-break'), true)
  assert.equal(resolved.fromMinute, 600)
  assert.equal(resolved.untilMinute, 640)
})

test('実在する部間Break単体を選択できる', () => {
  const resolved = resolveTimetableGridSelection(createSelection({
    anchorScheduleItemId: 'inter-section-break',
  }), rows)

  assert.ok(resolved)
  assert.deepEqual(resolved.scheduleItemIds, ['inter-section-break'])
  assert.equal(resolved.fromMinute, 607)
  assert.equal(resolved.untilMinute, 617)
})

test('ScheduleItem IDを維持したTimeline更新では最新時刻を再解決する', () => {
  const selection = createSelection({ focusScheduleItemId: 'performance-b' })
  const updatedRows = rows.map((row, index) => ({
    ...row,
    calculatedItem: {
      ...row.calculatedItem,
      plannedStartMinute: row.calculatedItem.plannedStartMinute + index * 5,
      plannedEndMinute: row.calculatedItem.plannedEndMinute + index * 5,
    },
  }))
  const resolved = resolveTimetableGridSelection(selection, updatedRows)

  assert.ok(resolved)
  assert.equal(resolved.fromMinute, 600)
  assert.equal(resolved.untilMinute, 650)
})

test('Shift相当のextendは同じ列のanchorを維持する', () => {
  const initial = createSelection()
  const extended = selectTimetableGridCell({
    selection: initial,
    eventDayId: 'day-1',
    stageId: 'stage-1',
    target: { kind: 'pa', role: 'main' },
    scheduleItemId: 'performance-b',
    extend: true,
  })

  assert.equal(extended.anchorScheduleItemId, 'performance-a')
  assert.equal(extended.focusScheduleItemId, 'performance-b')
})

test('別列のclickまたはShift clickは新しいsingle selectionを始める', () => {
  const initial = createSelection({ focusScheduleItemId: 'performance-b' })
  const next = selectTimetableGridCell({
    selection: initial,
    eventDayId: 'day-1',
    stageId: 'stage-1',
    target: { kind: 'pa', role: 'sub' },
    scheduleItemId: 'inter-section-break',
    extend: true,
  })

  assert.deepEqual(next, {
    eventDayId: 'day-1',
    stageId: 'stage-1',
    target: { kind: 'pa', role: 'sub' },
    anchorScheduleItemId: 'inter-section-break',
    focusScheduleItemId: 'inter-section-break',
  })
})

test('Duty列は表示名ではなくDutyType IDをidentityに使う', () => {
  const initial = createSelection({
    target: { kind: 'duty', dutyTypeId: 'duty-a' },
  })
  const sameDuty = selectTimetableGridCell({
    selection: initial,
    eventDayId: 'day-1',
    stageId: 'stage-1',
    target: { kind: 'duty', dutyTypeId: 'duty-a' },
    scheduleItemId: 'performance-b',
    extend: true,
  })
  const sameNameDifferentDuty = selectTimetableGridCell({
    selection: initial,
    eventDayId: 'day-1',
    stageId: 'stage-1',
    target: { kind: 'duty', dutyTypeId: 'duty-b' },
    scheduleItemId: 'performance-b',
    extend: true,
  })

  assert.equal(sameDuty.anchorScheduleItemId, 'performance-a')
  assert.equal(sameNameDifferentDuty.anchorScheduleItemId, 'performance-b')
})

test('anchor/focus欠損とduplicate ScheduleItem IDをfail closedにする', () => {
  assert.equal(resolveTimetableGridSelection(createSelection({
    anchorScheduleItemId: 'missing',
  }), rows), undefined)
  assert.equal(resolveTimetableGridSelection(createSelection({
    focusScheduleItemId: 'missing',
  }), rows), undefined)
  assert.equal(resolveTimetableGridSelection(createSelection(), [
    rows[0], { ...rows[1], scheduleItem: { ...rows[1].scheduleItem, id: 'performance-a' } },
  ]), undefined)
})

test('選択range内のStage/EventDay scope不一致をfail closedにする', () => {
  const range = createSelection({ focusScheduleItemId: 'performance-b' })
  const wrongStageRows = rows.map((row, index) => index === 1
    ? { ...row, calculatedItem: { ...row.calculatedItem, stageId: 'stage-2' } }
    : row)
  const wrongDayRows = rows.map((row, index) => index === 1
    ? { ...row, calculatedItem: { ...row.calculatedItem, eventDayId: 'day-2' } }
    : row)

  assert.equal(resolveTimetableGridSelection(range, wrongStageRows), undefined)
  assert.equal(resolveTimetableGridSelection(range, wrongDayRows), undefined)
})

test('DutyType labelは名前を解決しmissing時も安全な文言を返す', () => {
  const dutyTypes = [{ id: 'duty-photo', name: '撮影' }]
  assert.equal(getTimetableGridAssignmentTargetLabel(
    { kind: 'pa', role: 'main' }, dutyTypes,
  ), 'Main PA')
  assert.equal(getTimetableGridAssignmentTargetLabel(
    { kind: 'duty', dutyTypeId: 'duty-photo' }, dutyTypes,
  ), '撮影')
  assert.equal(getTimetableGridAssignmentTargetLabel(
    { kind: 'duty', dutyTypeId: 'missing' }, dutyTypes,
  ), '不明な当日運営担当')
})

test('selection解決はdeterministicかつinputを変更しない', () => {
  const selection = createSelection({ focusScheduleItemId: 'performance-b' })
  const selectionBefore = structuredClone(selection)
  const rowsBefore = structuredClone(rows)
  const first = resolveTimetableGridSelection(selection, rows)
  const second = resolveTimetableGridSelection(selection, rows)

  assert.deepEqual(first, second)
  assert.deepEqual(selection, selectionBefore)
  assert.deepEqual(rows, rowsBefore)
})
