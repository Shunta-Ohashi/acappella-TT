import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTimetableOrderConstraintBlockPresentations,
  getTimetableOrderConstraintBlockForConstraint,
  getTimetableOrderConstraintBlockMember,
} from '../src/ui/timetableOrderConstraintLinkPresentation.ts'

const eventDays = [
  { id: 'day-1', eventId: 'event-1', date: '2027-01-01', order: 0 },
  { id: 'day-2', eventId: 'event-1', date: '2027-01-02', order: 1 },
]
const stages = [
  { id: 'stage-1', eventDayId: 'day-1', name: 'Main', order: 0,
    plannedStartTime: '10:00' },
  { id: 'stage-other', eventDayId: 'day-1', name: 'Sub', order: 1,
    plannedStartTime: '10:00' },
  { id: 'stage-day-2', eventDayId: 'day-2', name: 'Day 2', order: 0,
    plannedStartTime: '10:00' },
]
const sections = [
  { id: 'section-2', stageId: 'stage-1', name: '2部', order: 1 },
  { id: 'section-1', stageId: 'stage-1', name: '1部', order: 0 },
]
const band = (id, eventDayId = 'day-1') => ({
  id,
  eventId: 'event-1',
  eventDayId,
  name: id.toUpperCase(),
  memberIds: [`member-${id}`],
  durationMinutes: 10,
})
const eventBands = [
  band('a'), band('b'), band('c'), band('d'), band('e'), band('f'),
  band('g', 'day-2'), band('h', 'day-2'),
]
const constraint = (id, eventBandIds, overrides = {}) => ({
  id,
  eventId: 'event-1',
  eventDayId: 'day-1',
  stageId: 'stage-1',
  sectionId: 'section-1',
  eventBandIds,
  ...overrides,
})

const present = (timetableOrderConstraints, overrides = {}) =>
  createTimetableOrderConstraintBlockPresentations({
    eventId: 'event-1',
    eventDayId: 'day-1',
    stageId: 'stage-1',
    timetableOrderConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
    ...overrides,
  })

test('連結fragmentを1つの表示blockへ統合し、未配置に依存せずmember位置を保つ', () => {
  const ab = constraint('ab', ['a', 'b'])
  const bc = constraint('bc', ['b', 'c'])
  const blocks = present([bc, ab])

  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0].eventBandIds, ['a', 'b', 'c'])
  assert.deepEqual(blocks[0].constraintIds, ['ab', 'bc'])
  assert.deepEqual(
    ['a', 'b', 'c'].map(id => getTimetableOrderConstraintBlockMember(blocks, id)),
    [
      { blockKey: blocks[0].key, label: '出演順1', eventBandId: 'a', position: 1,
        total: 3, badgeLabel: '出演順1 1/3', title: blocks[0].title },
      { blockKey: blocks[0].key, label: '出演順1', eventBandId: 'b', position: 2,
        total: 3, badgeLabel: '出演順1 2/3', title: blocks[0].title },
      { blockKey: blocks[0].key, label: '出演順1', eventBandId: 'c', position: 3,
        total: 3, badgeLabel: '出演順1 3/3', title: blocks[0].title },
    ],
  )
  assert.equal(getTimetableOrderConstraintBlockForConstraint(blocks, ab)?.key, blocks[0].key)
  assert.equal(getTimetableOrderConstraintBlockForConstraint(blocks, bc)?.key, blocks[0].key)
})

test('Section順とblock内容で複数blockのlabelを決定的に付ける', () => {
  const constraints = [
    constraint('ef', ['e', 'f'], { sectionId: 'section-1' }),
    constraint('cd', ['c', 'd'], { sectionId: 'section-2' }),
    constraint('ab', ['a', 'b'], { sectionId: 'section-1' }),
  ]
  const first = present(constraints)
  const second = present([...constraints].reverse())

  assert.deepEqual(first.map(block => ({
    label: block.label,
    sectionId: block.sectionId,
    eventBandIds: block.eventBandIds,
  })), [
    { label: '出演順1', sectionId: 'section-1', eventBandIds: ['a', 'b'] },
    { label: '出演順2', sectionId: 'section-1', eventBandIds: ['e', 'f'] },
    { label: '出演順3', sectionId: 'section-2', eventBandIds: ['c', 'd'] },
  ])
  assert.deepEqual(second, first)
})

test('semantic-invalid constraintとduplicate IDを表示blockから除外する', () => {
  const valid = constraint('valid', ['a', 'b'])
  const missingBand = constraint('missing', ['c', 'missing-band'])
  const duplicateA = constraint('duplicate', ['c', 'd'])
  const duplicateB = constraint('duplicate', ['e', 'f'])

  const blocks = present([valid, missingBand, duplicateA, duplicateB])

  assert.deepEqual(blocks.map(block => block.eventBandIds), [['a', 'b']])
  assert.equal(getTimetableOrderConstraintBlockForConstraint(blocks, missingBand), undefined)
  assert.equal(getTimetableOrderConstraintBlockForConstraint(blocks, duplicateA), undefined)
})

test('別EventDayと別Stageのconstraintをcurrent Stage presentationへ含めない', () => {
  const current = constraint('current', ['a', 'b'])
  const otherStage = constraint('other-stage', ['e', 'f'], {
    stageId: 'stage-other',
    sectionId: undefined,
  })
  const otherDay = constraint('other-day', ['g', 'h'], {
    eventDayId: 'day-2',
    stageId: 'stage-day-2',
    sectionId: undefined,
  })

  const blocks = present([otherDay, otherStage, current])

  assert.deepEqual(blocks.map(block => block.eventBandIds), [['a', 'b']])
})

test('EventBand lookupはblock外Bandを返さず定義上のpositionを返す', () => {
  const blocks = present([
    constraint('ab', ['a', 'b']),
    constraint('bc', ['b', 'c']),
  ])

  assert.equal(getTimetableOrderConstraintBlockMember(blocks, 'b')?.position, 2)
  assert.equal(getTimetableOrderConstraintBlockMember(blocks, 'b')?.total, 3)
  assert.equal(getTimetableOrderConstraintBlockMember(blocks, 'd'), undefined)
})

test('presentation生成は入力を変更しない', () => {
  const timetableOrderConstraints = [
    constraint('bc', ['b', 'c']),
    constraint('ab', ['a', 'b']),
  ]
  const input = { timetableOrderConstraints, eventDays, stages, sections, eventBands }
  const original = structuredClone(input)

  present(timetableOrderConstraints)

  assert.deepEqual(input, original)
})
