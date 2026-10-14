import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCloudV2CutoverPreflight,
} from '../src/cloud/cloudV2CutoverPreflight.ts'
import {
  createCloudEventSnapshot,
  createCloudEventSnapshotV2,
} from '../src/cloud/cloudEventSnapshot.ts'
import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
} from '../src/cloud/cloudWorkspaceMasterBackfill.ts'

const workspaceId = '77000000-0000-4000-8000-000000000001'
const emptyExisting = {
  members: 0,
  bands: 0,
  bandMembers: 0,
  eventMemberReferences: 0,
  eventBandReferences: 0,
  completedBackfills: 0,
  completedBackfill: null,
}

const createState = ({
  eventId = 'event-a',
  memberName = 'Alice',
  bandName = 'Alpha',
  defaultMemberIds = ['member-b', 'member-a'],
} = {}) => ({
  members: [
    { id: 'member-a', realName: memberName, active: true },
    { id: 'member-b', realName: 'Bob', active: true },
  ],
  bands: [{
    id: 'band-a', name: bandName, defaultMemberIds, active: true,
  }],
  events: [{
    id: eventId,
    name: `Event ${eventId}`,
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5, 10],
  }],
  eventDays: [{ id: `day-${eventId}`, eventId, date: '2026-10-14', order: 0 }],
  stages: [{
    id: `stage-${eventId}`,
    eventDayId: `day-${eventId}`,
    name: 'Main',
    order: 0,
    plannedStartTime: '10:00',
  }],
  sections: [{
    id: `section-${eventId}`,
    stageId: `stage-${eventId}`,
    name: 'Part 1',
    order: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '12:00',
  }],
  eventMembers: [{
    id: `event-member-${eventId}`,
    eventId,
    memberId: 'member-a',
    paCapabilities: { main: true, sub: true },
  }],
  eventMemberDays: [{
    id: `member-day-${eventId}`,
    eventMemberId: `event-member-${eventId}`,
    eventDayId: `day-${eventId}`,
    participationStatus: 'participating',
    availabilityWindows: [{ from: '09:00', until: '18:00' }],
  }],
  eventBands: [{
    id: `event-band-${eventId}`,
    eventId,
    eventDayId: `day-${eventId}`,
    bandId: 'band-a',
    name: 'Alpha live',
    memberIds: ['member-a'],
    durationMinutes: 5,
    fixedPlacement: {
      stageId: `stage-${eventId}`,
      sectionId: `section-${eventId}`,
      plannedStartTime: '10:00',
    },
  }, {
    id: `event-band-2-${eventId}`,
    eventId,
    eventDayId: `day-${eventId}`,
    bandId: 'band-a',
    name: 'Alpha encore',
    memberIds: ['member-a'],
    durationMinutes: 5,
  }],
  scheduleItems: [{
    id: `item-${eventId}`,
    stageId: `stage-${eventId}`,
    sectionId: `section-${eventId}`,
    kind: 'performance',
    eventBandId: `event-band-${eventId}`,
    order: 0,
  }, {
    id: `item-2-${eventId}`,
    stageId: `stage-${eventId}`,
    sectionId: `section-${eventId}`,
    kind: 'performance',
    eventBandId: `event-band-2-${eventId}`,
    order: 1,
  }],
  paAssignments: [{
    id: `pa-${eventId}`,
    eventId,
    eventDayId: `day-${eventId}`,
    stageId: `stage-${eventId}`,
    memberId: 'member-a',
    role: 'main',
    from: { kind: 'time', time: '10:00' },
    until: { kind: 'time', time: '10:05' },
  }],
  dutyTypes: [{ id: `duty-${eventId}`, eventId, name: 'Reception', order: 0 }],
  dutyAssignments: [{
    id: `assignment-${eventId}`,
    dutyTypeId: `duty-${eventId}`,
    eventDayId: `day-${eventId}`,
    stageId: `stage-${eventId}`,
    memberId: 'member-a',
    from: { kind: 'time', time: '10:00' },
    until: { kind: 'time', time: '10:05' },
  }],
  timetableLocks: [{
    id: `lock-${eventId}`,
    eventId,
    stageId: `stage-${eventId}`,
    sectionId: `section-${eventId}`,
    scheduleItemId: `item-${eventId}`,
    position: { kind: 'first' },
  }],
  timetableOrderConstraints: [{
    id: `constraint-${eventId}`,
    eventId,
    eventDayId: `day-${eventId}`,
    stageId: `stage-${eventId}`,
    sectionId: `section-${eventId}`,
    eventBandIds: [`event-band-${eventId}`, `event-band-2-${eventId}`],
  }],
})

const createSourceEvent = (eventId, state = createState({ eventId }), revision = 1) => {
  const created = createCloudEventSnapshot(state, eventId)
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('fixture snapshot failed')
  return {
    workspaceId,
    eventId,
    eventName: state.events[0].name,
    snapshot: created.snapshot,
    snapshotFingerprint: (eventId === 'event-a' ? 'a' : 'b').repeat(64),
    revision,
  }
}

const createSource = (events, overrides = {}) => ({
  status: 'ok',
  workspaceId,
  workspaceStatus: 'legacy',
  workspaceGeneration: '7',
  events,
  existing: { ...emptyExisting },
  ...overrides,
})

const issueCodes = result => result.issues.map(issue => issue.code)

test('正常な単一V1 Eventを情報欠落なくV2へ構造変換できるがcutover成功とは扱わない', async () => {
  const source = createSource([createSourceEvent('event-a')])
  const before = structuredClone(source)
  const result = await createCloudV2CutoverPreflight({ source })

  assert.equal(result.structuralStatus, 'convertible')
  assert.equal(result.cutoverReadiness, 'blocked')
  assert.equal(result.safeToCutover, false)
  assert.deepEqual(result.summary, {
    eventCount: 1,
    convertedEventCount: 1,
    memberCount: 2,
    bandCount: 1,
    bandMemberRelationCount: 2,
    eventMemberReferenceCount: 2,
    eventBandReferenceCount: 1,
    conflictCount: 0,
  })
  assert.deepEqual(result.convertedEvents, [{
    eventId: 'event-a',
    revision: 1,
    memberReferenceCount: 2,
    bandReferenceCount: 1,
  }])
  assert.deepEqual(result.issues, [])
  assert.ok(result.unverifiedRequirements.includes('BACKFILL_NOT_COMPLETED'))
  assert.ok(result.unverifiedRequirements.includes('V1_WRITERS_NOT_PROVEN_DRAINED'))
  assert.ok(result.unverifiedRequirements.includes('ATOMIC_CUTOVER_REVALIDATION_UNAVAILABLE'))
  assert.deepEqual(source, before, 'read-only preflightは入力を変更しない')
})

test('複数Eventの同一Masterを統合しBand member順序と全Event-owned collectionを保持する', async () => {
  const eventA = createSourceEvent('event-a')
  const eventBState = createState({ eventId: 'event-b' })
  const eventB = createSourceEvent('event-b', eventBState, 4)
  const result = await createCloudV2CutoverPreflight({
    source: createSource([eventA, eventB]),
  })

  assert.equal(result.structuralStatus, 'convertible')
  assert.equal(result.summary.convertedEventCount, 2)
  assert.equal(result.summary.memberCount, 2)
  assert.equal(result.summary.bandMemberRelationCount, 2)
  assert.deepEqual(result.convertedEvents.map(event => event.eventId), ['event-a', 'event-b'])

  const v2 = createCloudEventSnapshotV2(eventBState, 'event-b')
  assert.equal(v2.ok, true)
  if (v2.ok) {
    assert.equal(Object.hasOwn(v2.snapshot.eventState, 'members'), false)
    assert.equal(Object.hasOwn(v2.snapshot.eventState, 'bands'), false)
    assert.deepEqual(v2.snapshot.masterReferences, {
      memberIds: ['member-a', 'member-b'],
      bandIds: ['band-a'],
    })
  }
})

test('同一Member/Band IDの内容または順序が異なるV1集合をfail closedにする', async () => {
  const result = await createCloudV2CutoverPreflight({
    source: createSource([
      createSourceEvent('event-a'),
      createSourceEvent('event-b', createState({
        eventId: 'event-b',
        memberName: 'Alice Updated',
        bandName: 'Alpha Updated',
        defaultMemberIds: ['member-a', 'member-b'],
      })),
    ]),
  })

  assert.equal(result.structuralStatus, 'not-convertible')
  assert.equal(result.cutoverReadiness, 'blocked')
  assert.equal(result.summary.conflictCount, 2)
  assert.deepEqual(
    result.issues.filter(issue => issue.code === 'SHARED_MASTER_CONFLICT'),
    [
      { code: 'SHARED_MASTER_CONFLICT', kind: 'band', masterId: 'band-a' },
      { code: 'SHARED_MASTER_CONFLICT', kind: 'member', masterId: 'member-a' },
    ],
  )
  assert.equal(JSON.stringify(result).includes('Alice Updated'), false)
})

test('欠落Master参照・不正Snapshot・Event所有関係の矛盾をEvent ID付きで拒否する', async () => {
  const missingMaster = structuredClone(createSourceEvent('event-a'))
  missingMaster.snapshot.appState.members = missingMaster.snapshot.appState.members
    .filter(member => member.id !== 'member-b')
  const missingBand = structuredClone(createSourceEvent('event-d'))
  missingBand.snapshot.appState.bands = []
  const malformed = structuredClone(createSourceEvent('event-b'))
  malformed.snapshot.appState.eventBands = null
  const wrongOwner = structuredClone(createSourceEvent('event-c'))
  wrongOwner.snapshot.appState.eventDays[0].eventId = 'foreign-event'

  for (const sourceEvent of [missingMaster, missingBand, malformed, wrongOwner]) {
    const result = await createCloudV2CutoverPreflight({ source: createSource([sourceEvent]) })
    assert.equal(result.structuralStatus, 'not-convertible')
    assert.deepEqual(result.invalidEventIds, [sourceEvent.eventId])
    assert.ok(issueCodes(result).includes('INVALID_SNAPSHOT'))
  }
})

test('duplicate Event IDとV1/V2混在を明示的に分類する', async () => {
  const duplicated = createSourceEvent('event-a')
  const duplicateResult = await createCloudV2CutoverPreflight({
    source: createSource([duplicated, { ...structuredClone(duplicated), revision: 2 }]),
  })
  assert.equal(duplicateResult.structuralStatus, 'not-convertible')
  assert.ok(issueCodes(duplicateResult).includes('DUPLICATE_EVENT_ID'))

  const v2State = createState({ eventId: 'event-b' })
  const v2 = createCloudEventSnapshotV2(v2State, 'event-b')
  assert.equal(v2.ok, true)
  if (!v2.ok) return
  const mixedResult = await createCloudV2CutoverPreflight({
    source: createSource([
      createSourceEvent('event-a'),
      {
        ...createSourceEvent('event-b', v2State),
        snapshot: v2.snapshot,
      },
    ]),
  })
  assert.equal(mixedResult.structuralStatus, 'not-convertible')
  assert.ok(issueCodes(mixedResult).includes('MIXED_SNAPSHOT_VERSIONS'))
})

test('空Workspaceは構造変換可能だがbackfill・運用証拠不足を成功扱いにしない', async () => {
  const result = await createCloudV2CutoverPreflight({ source: createSource([]) })
  assert.equal(result.structuralStatus, 'convertible')
  assert.equal(result.summary.eventCount, 0)
  assert.equal(result.summary.convertedEventCount, 0)
  assert.equal(result.safeToCutover, false)
  assert.ok(result.unverifiedRequirements.includes('BACKFILL_NOT_COMPLETED'))
})

test('generation不一致、conflict/ready状態、部分backfillをcutover blockerとして扱う', async () => {
  const event = createSourceEvent('event-a')
  const generation = await createCloudV2CutoverPreflight({
    source: createSource([event]),
    expectedGeneration: '6',
  })
  assert.equal(generation.structuralStatus, 'convertible')
  assert.equal(generation.cutoverReadiness, 'blocked')
  assert.ok(issueCodes(generation).includes('GENERATION_EVIDENCE_MISMATCH'))

  for (const [workspaceStatus, code] of [
    ['conflict', 'WORKSPACE_CONFLICT'],
    ['ready', 'WORKSPACE_ALREADY_READY'],
  ]) {
    const result = await createCloudV2CutoverPreflight({
      source: createSource([event], { workspaceStatus }),
    })
    assert.equal(result.structuralStatus, 'convertible')
    assert.ok(issueCodes(result).includes(code))
  }

  const partial = await createCloudV2CutoverPreflight({
    source: createSource([event], {
      existing: { ...emptyExisting, members: 1 },
    }),
  })
  assert.equal(partial.structuralStatus, 'convertible')
  assert.ok(issueCodes(partial).includes('BACKFILL_STATE_INCONSISTENT'))
})

const createCompletedSourceAndMasters = async () => {
  const raw = createSource([createSourceEvent('event-a')])
  const planned = createCloudWorkspaceMasterBackfillPlan(raw)
  assert.equal(planned.ok, true)
  if (!planned.ok) throw new Error('fixture plan failed')
  const fingerprint = await createCloudWorkspaceMasterBackfillFingerprint(planned.plan)
  const resultGeneration = '8'
  const source = createSource(raw.events, {
    workspaceGeneration: resultGeneration,
    existing: {
      members: planned.report.memberCount,
      bands: planned.report.bandCount,
      bandMembers: planned.report.bandMemberRelationCount,
      eventMemberReferences: planned.report.eventMemberReferenceCount,
      eventBandReferences: planned.report.eventBandReferenceCount,
      completedBackfills: 1,
      completedBackfill: {
        planFingerprint: fingerprint,
        sourceGeneration: planned.plan.sourceGeneration,
        resultGeneration,
        eventCount: planned.report.eventCount,
        memberCount: planned.report.memberCount,
        bandCount: planned.report.bandCount,
        bandMemberRelationCount: planned.report.bandMemberRelationCount,
        eventMemberReferenceCount: planned.report.eventMemberReferenceCount,
        eventBandReferenceCount: planned.report.eventBandReferenceCount,
      },
    },
  })
  const toRecord = (kind, value) => ({
    kind,
    workspaceId,
    value,
    revision: 1,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  })
  return {
    source,
    masters: {
      workspaceId,
      generation: resultGeneration,
      members: planned.plan.members.map(member => toRecord('member', member)),
      bands: planned.plan.bands.map(band => toRecord('band', band)),
    },
  }
}

test('完了backfillのfingerprint・件数・任意Master readを照合する', async () => {
  const { source, masters } = await createCompletedSourceAndMasters()
  const verified = await createCloudV2CutoverPreflight({ source, masters })
  assert.equal(verified.structuralStatus, 'convertible')
  assert.deepEqual(verified.issues, [])
  assert.equal(
    verified.unverifiedRequirements.includes('NORMALIZED_MASTER_CONTENTS_NOT_OBSERVED'),
    false,
  )
  assert.ok(verified.unverifiedRequirements.includes('REFERENCE_INDEX_CONTENTS_NOT_OBSERVED'))

  const missingEvidence = await createCloudV2CutoverPreflight({ source })
  assert.ok(missingEvidence.unverifiedRequirements.includes(
    'NORMALIZED_MASTER_CONTENTS_NOT_OBSERVED',
  ))

  const changedMasters = structuredClone(masters)
  changedMasters.members[0].value.realName = 'Unexpected'
  const mismatch = await createCloudV2CutoverPreflight({
    source,
    masters: changedMasters,
  })
  assert.ok(issueCodes(mismatch).includes('NORMALIZED_MASTER_MISMATCH'))
  assert.equal(mismatch.cutoverReadiness, 'blocked')
})

test('完了記録のfingerprint改変を検出しSnapshot本文や個人名をreportへ出さない', async () => {
  const { source } = await createCompletedSourceAndMasters()
  source.existing.completedBackfill.planFingerprint = 'f'.repeat(64)
  const result = await createCloudV2CutoverPreflight({ source })
  assert.ok(issueCodes(result).includes('BACKFILL_FINGERPRINT_MISMATCH'))
  assert.equal(JSON.stringify(result).includes('Alice'), false)
  assert.equal(JSON.stringify(result).includes('appState'), false)
})
