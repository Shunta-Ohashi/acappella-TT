import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createCloudEventSnapshot,
  createCloudEventSnapshotV2,
  hasResolvedCloudEventSnapshotV2Masters,
  parseCloudEventSnapshot,
  parseCloudEventSnapshotEnvelope,
  parseCloudEventSnapshotV2,
} from '../src/cloud/cloudEventSnapshot.ts'
import {
  CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES,
  handleCloudWorkspaceMasterRequest,
} from '../src/cloud/cloudWorkspaceMasterEndpoint.ts'
import { createCloudEventRepository } from '../src/cloud/cloudEventRepository.ts'
import {
  createCloudWorkspaceMasterRepository,
  isValidCloudWorkspaceMember,
  parseCloudWorkspaceMasterMutationValue,
} from '../src/cloud/cloudWorkspaceMasterRepository.ts'
import { loadCloudWorkspaceAtOneGeneration } from '../src/cloud/cloudWorkspaceReadModel.ts'

const workspaceId = '70000000-0000-0000-0000-000000000001'
const now = '2026-10-12T00:00:00.000Z'

const memberA = {
  id: 'member-a',
  realName: 'Alice',
  acaName: 'A',
  entryAcademicYear: 2024,
  active: true,
}
const memberB = { id: 'member-b', realName: 'Bob', active: true }
const bandA = {
  id: 'band-a',
  name: 'Alpha',
  defaultMemberIds: ['member-b', 'member-a'],
  active: true,
}

const createDomainState = () => ({
  members: [structuredClone(memberA), structuredClone(memberB)],
  bands: [structuredClone(bandA)],
  events: [{
    id: 'event-a',
    name: 'Event A',
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5],
  }],
  eventDays: [{
    id: 'day-a', eventId: 'event-a', date: '2026-10-12', order: 0,
  }],
  stages: [],
  sections: [],
  eventMembers: [{
    id: 'event-member-a',
    eventId: 'event-a',
    memberId: 'member-a',
    paCapabilities: { main: true, sub: false },
  }],
  eventMemberDays: [],
  eventBands: [{
    id: 'event-band-a',
    eventId: 'event-a',
    eventDayId: 'day-a',
    bandId: 'band-a',
    name: 'Alpha at Event',
    memberIds: ['member-a'],
    durationMinutes: 5,
  }],
  scheduleItems: [],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
  timetableLocks: [],
  timetableOrderConstraints: [],
})

const memberRow = (member = memberA, revision = 1) => ({
  kind: 'member',
  workspaceId,
  value: structuredClone(member),
  revision,
  createdAt: now,
  updatedAt: now,
})

const bandRow = (band = bandA, revision = 1) => ({
  kind: 'band',
  workspaceId,
  value: structuredClone(band),
  revision,
  createdAt: now,
  updatedAt: now,
})

const mutationResponse = (record, generation = '4') => ({
  status: 'ok',
  workspaceId,
  workspaceGeneration: generation,
  record,
})

test('Snapshot V2はEvent所有dataとexactなMaster参照だけを保存しV1/V2を明示分岐する', () => {
  const state = createDomainState()
  const v1 = createCloudEventSnapshot(state, 'event-a')
  const v2 = createCloudEventSnapshotV2(state, 'event-a')
  assert.equal(v1.ok, true)
  assert.equal(v2.ok, true)
  if (!v1.ok || !v2.ok) return

  assert.equal('members' in v2.snapshot.eventState, false)
  assert.equal('bands' in v2.snapshot.eventState, false)
  assert.deepEqual(v2.snapshot.masterReferences, {
    memberIds: ['member-a', 'member-b'],
    bandIds: ['band-a'],
  })
  assert.deepEqual(parseCloudEventSnapshotEnvelope(v1.snapshot), v1.snapshot)
  assert.deepEqual(parseCloudEventSnapshotEnvelope(v2.snapshot), v2.snapshot)
  assert.equal(parseCloudEventSnapshot(v2.snapshot), undefined)
  assert.equal(parseCloudEventSnapshotV2(v1.snapshot), undefined)
})

test('Snapshot V2生成は元stateのdangling・重複・不正Master参照を拒否する', () => {
  const expectInvalid = (mutate, message) => {
    const state = createDomainState()
    mutate(state)
    assert.deepEqual(createCloudEventSnapshotV2(state, 'event-a'), {
      ok: false,
      reason: 'INVALID_SNAPSHOT',
    }, message)
  }

  expectInvalid(state => {
    state.eventMembers[0].memberId = 'missing-event-member-master'
  }, 'EventMember.memberId')
  expectInvalid(state => {
    state.eventBands[0].memberIds = ['missing-event-band-member']
  }, 'EventBand.memberIds')
  expectInvalid(state => {
    state.eventBands[0].bandId = 'missing-band'
  }, 'EventBand.bandId')
  expectInvalid(state => {
    state.bands[0].defaultMemberIds = ['missing-default-member']
  }, 'Band.defaultMemberIds')

  const createAssignmentState = () => {
    const state = createDomainState()
    state.stages = [{
      id: 'stage-a',
      eventDayId: 'day-a',
      name: 'Main',
      order: 0,
      plannedStartTime: '10:00',
      plannedEndTime: '12:00',
    }]
    state.dutyTypes = [{ id: 'duty-a', eventId: 'event-a', name: 'Reception', order: 0 }]
    state.paAssignments = [{
      id: 'pa-a',
      eventId: 'event-a',
      eventDayId: 'day-a',
      stageId: 'stage-a',
      memberId: 'member-a',
      role: 'main',
      from: { kind: 'time', time: '10:00' },
      until: { kind: 'time', time: '11:00' },
    }]
    state.dutyAssignments = [{
      id: 'duty-assignment-a',
      dutyTypeId: 'duty-a',
      eventDayId: 'day-a',
      stageId: 'stage-a',
      memberId: 'member-a',
      from: { kind: 'time', time: '10:00' },
      until: { kind: 'time', time: '11:00' },
    }]
    return state
  }
  const validAssignments = createAssignmentState()
  assert.equal(createCloudEventSnapshotV2(validAssignments, 'event-a').ok, true)

  const danglingPa = createAssignmentState()
  danglingPa.paAssignments[0].memberId = 'missing-pa-member'
  assert.equal(createCloudEventSnapshotV2(danglingPa, 'event-a').ok, false)

  const danglingDuty = createAssignmentState()
  danglingDuty.dutyAssignments[0].memberId = 'missing-duty-member'
  assert.equal(createCloudEventSnapshotV2(danglingDuty, 'event-a').ok, false)

  expectInvalid(state => {
    state.members.push(structuredClone(memberA))
  }, 'duplicate Member ID')
  expectInvalid(state => {
    state.bands.push(structuredClone(bandA))
  }, 'duplicate Band ID')
  expectInvalid(state => {
    delete state.members[0].active
  }, 'invalid referenced Member record')
  expectInvalid(state => {
    state.members[0].id = '   '
  }, 'blank Member ID')
  expectInvalid(state => {
    state.members[0].realName = ''
  }, 'blank Member realName')
  expectInvalid(state => {
    state.members[0].unexpected = true
  }, 'unknown Member field')
  expectInvalid(state => {
    state.bands[0].id = ''
  }, 'blank Band ID')
  expectInvalid(state => {
    state.bands[0].name = '   '
  }, 'blank Band name')
  expectInvalid(state => {
    state.bands[0].defaultMemberIds = ['member-a', 'member-a']
  }, 'duplicate Band.defaultMemberIds')
  expectInvalid(state => {
    state.bands[0].defaultMemberIds = ['']
  }, 'blank Band.defaultMemberIds')
  expectInvalid(state => {
    state.bands[0].defaultMemberIds = null
  }, 'invalid Band.defaultMemberIds')
  expectInvalid(state => {
    state.bands[0].unexpected = true
  }, 'unknown Band field')

  const withUnreferencedMasters = createDomainState()
  withUnreferencedMasters.members.push({
    id: 'member-extra', realName: 'Extra', active: true,
  })
  withUnreferencedMasters.bands.push({
    id: 'band-extra', name: 'Extra Band', defaultMemberIds: ['member-extra'], active: true,
  })
  const v2 = createCloudEventSnapshotV2(withUnreferencedMasters, 'event-a')
  assert.equal(v2.ok, true)
  if (v2.ok) {
    assert.equal(v2.snapshot.masterReferences.memberIds.includes('member-extra'), false)
    assert.equal(v2.snapshot.masterReferences.bandIds.includes('band-extra'), false)
    assert.deepEqual(parseCloudEventSnapshotV2(v2.snapshot), v2.snapshot)
  }

  const v1 = createCloudEventSnapshot(createDomainState(), 'event-a')
  assert.equal(v1.ok, true)
  if (v1.ok) assert.deepEqual(parseCloudEventSnapshot(v1.snapshot), v1.snapshot)

  const v1LegacyMasterShape = createDomainState()
  v1LegacyMasterShape.members[0].legacyExtra = 'V1 keeps its existing validator'
  const legacyV1 = createCloudEventSnapshot(v1LegacyMasterShape, 'event-a')
  assert.equal(legacyV1.ok, true)
  if (legacyV1.ok) {
    assert.deepEqual(parseCloudEventSnapshot(legacyV1.snapshot), legacyV1.snapshot)
    assert.deepEqual(createCloudEventSnapshotV2(v1LegacyMasterShape, 'event-a'), {
      ok: false,
      reason: 'INVALID_SNAPSHOT',
    })
  }
})

test('Snapshot V2は欠落・余分・重複Master参照とEvent ownership破損をfail closedする', () => {
  const created = createCloudEventSnapshotV2(createDomainState(), 'event-a')
  assert.equal(created.ok, true)
  if (!created.ok) return

  const missingMember = structuredClone(created.snapshot)
  missingMember.masterReferences.memberIds = []
  assert.equal(parseCloudEventSnapshotV2(missingMember), undefined)

  const missingTransitiveMember = structuredClone(created.snapshot)
  missingTransitiveMember.masterReferences.memberIds = ['member-a']
  assert.ok(parseCloudEventSnapshotV2(missingTransitiveMember))
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    missingTransitiveMember,
    [memberA, memberB],
    [bandA],
  ), false)

  const extraMember = structuredClone(created.snapshot)
  extraMember.masterReferences.memberIds.push('member-extra')
  assert.ok(parseCloudEventSnapshotV2(extraMember))
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    extraMember,
    [memberA, memberB, { id: 'member-extra', realName: 'Extra', active: true }],
    [bandA],
  ), false)

  const duplicateBand = structuredClone(created.snapshot)
  duplicateBand.masterReferences.bandIds.push('band-a')
  assert.equal(parseCloudEventSnapshotV2(duplicateBand), undefined)

  const sparseMembers = structuredClone(created.snapshot)
  sparseMembers.masterReferences.memberIds = new Array(2)
  sparseMembers.masterReferences.memberIds[1] = 'member-a'
  assert.equal(parseCloudEventSnapshotV2(sparseMembers), undefined)

  const foreignDay = structuredClone(created.snapshot)
  foreignDay.eventState.eventDays[0].eventId = 'event-foreign'
  assert.equal(parseCloudEventSnapshotV2(foreignDay), undefined)
})

test('Snapshot V2はMaster本体とallowlist外のkeyをEnvelope経由でも拒否する', () => {
  const v1 = createCloudEventSnapshot(createDomainState(), 'event-a')
  const created = createCloudEventSnapshotV2(createDomainState(), 'event-a')
  assert.equal(v1.ok, true)
  assert.equal(created.ok, true)
  if (!v1.ok || !created.ok) return

  assert.deepEqual(parseCloudEventSnapshotV2(created.snapshot), created.snapshot)
  assert.deepEqual(parseCloudEventSnapshotEnvelope(created.snapshot), created.snapshot)
  assert.deepEqual(parseCloudEventSnapshot(v1.snapshot), v1.snapshot)

  for (const [key, value] of [
    ['members', []],
    ['bands', []],
    ['unexpectedCollection', []],
  ]) {
    const malformed = structuredClone(created.snapshot)
    malformed.eventState[key] = value
    assert.equal(parseCloudEventSnapshotV2(malformed), undefined, key)
    assert.equal(parseCloudEventSnapshotEnvelope(malformed), undefined, key)
  }

  const extraReferenceKey = structuredClone(created.snapshot)
  extraReferenceKey.masterReferences.members = []
  assert.equal(parseCloudEventSnapshotEnvelope(extraReferenceKey), undefined)

  const extraEnvelopeKey = structuredClone(created.snapshot)
  extraEnvelopeKey.appState = {}
  assert.equal(parseCloudEventSnapshotEnvelope(extraEnvelopeKey), undefined)
})

test('Snapshot V2 parserはmalformed collectionを例外なくfail closedする', () => {
  const created = createCloudEventSnapshotV2(createDomainState(), 'event-a')
  assert.equal(created.ok, true)
  if (!created.ok) return

  const malformedValues = []
  for (const key of Object.keys(created.snapshot.eventState)) {
    if (key === 'version') continue
    for (const value of [null, {}]) {
      const malformed = structuredClone(created.snapshot)
      malformed.eventState[key] = value
      malformedValues.push([`${key}:${String(value)}`, malformed])
    }
  }

  const stringCollection = structuredClone(created.snapshot)
  stringCollection.eventState.eventBands = 'invalid'
  malformedValues.push(['string collection', stringCollection])

  const nullCollectionItem = structuredClone(created.snapshot)
  nullCollectionItem.eventState.eventMembers = [null]
  malformedValues.push(['null collection item', nullCollectionItem])

  const invalidEventBandMembers = structuredClone(created.snapshot)
  invalidEventBandMembers.eventState.eventBands[0].memberIds = null
  malformedValues.push(['null EventBand.memberIds', invalidEventBandMembers])

  const missingCollection = structuredClone(created.snapshot)
  delete missingCollection.eventState.eventMembers
  malformedValues.push(['missing required collection', missingCollection])

  const invalidRecord = structuredClone(created.snapshot)
  invalidRecord.eventState.events[0].validationPolicy = null
  malformedValues.push(['invalid Event record', invalidRecord])

  for (const [name, mutate] of [
    ['null masterReferences', snapshot => { snapshot.masterReferences = null }],
    ['object memberIds', snapshot => { snapshot.masterReferences.memberIds = {} }],
    ['string bandIds', snapshot => { snapshot.masterReferences.bandIds = 'band-a' }],
    ['null reference item', snapshot => { snapshot.masterReferences.memberIds = [null] }],
  ]) {
    const malformed = structuredClone(created.snapshot)
    mutate(malformed)
    malformedValues.push([name, malformed])
  }

  for (const [name, malformed] of malformedValues) {
    let direct
    let envelope
    assert.doesNotThrow(() => {
      direct = parseCloudEventSnapshotV2(malformed)
    }, name)
    assert.doesNotThrow(() => {
      envelope = parseCloudEventSnapshotEnvelope(malformed)
    }, `${name}: envelope`)
    assert.equal(direct, undefined, name)
    assert.equal(envelope, undefined, `${name}: envelope`)
  }
})

test('Snapshot V2のMaster解決は参照欠落とBand relation欠落を拒否する', () => {
  const created = createCloudEventSnapshotV2(createDomainState(), 'event-a')
  assert.equal(created.ok, true)
  if (!created.ok) return

  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    created.snapshot,
    [memberA, memberB],
    [bandA],
  ), true)
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    created.snapshot,
    [memberA],
    [bandA],
  ), false)
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    created.snapshot,
    [memberA, memberB],
    [],
  ), false)
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    created.snapshot,
    [memberA, memberB, { id: 'member-extra', realName: 'Extra', active: true }],
    [bandA, {
      id: 'band-extra', name: 'Extra', defaultMemberIds: [], active: true,
    }],
  ), true)
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    created.snapshot,
    [{ ...memberA, unexpected: true }, memberB],
    [bandA],
  ), false)
  assert.equal(hasResolvedCloudEventSnapshotV2Masters(
    created.snapshot,
    [memberA, memberB],
    [{ ...bandA, defaultMemberIds: ['member-a', 'member-a'] }],
  ), false)
})

test('Master repositoryは全pageを同じgenerationで読みMember/Bandを分離する', async () => {
  const calls = []
  const rows = [memberRow(), bandRow()]
  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage(_workspaceId, afterKind, afterId, limit, expected) {
      calls.push({ afterKind, afterId, limit, expected })
      const index = calls.length - 1
      return {
        data: {
          status: 'ok',
          workspaceId,
          workspaceGeneration: '9',
          rows: [rows[index]],
          nextCursor: index === 0 ? { kind: 'member', id: 'member-a' } : null,
        },
        error: null,
      }
    },
    async mutate() { throw new Error('not used') },
  }, 1)

  const result = await repository.loadWorkspaceMasters(workspaceId)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.generation, '9')
  assert.deepEqual(result.value.members.map(record => record.value.id), ['member-a'])
  assert.deepEqual(result.value.bands.map(record => record.value.id), ['band-a'])
  assert.deepEqual(calls, [
    { afterKind: null, afterId: null, limit: 1, expected: null },
    { afterKind: 'member', afterId: 'member-a', limit: 1, expected: '9' },
  ])
})

test('Master repositoryはEvent側generationを初回pageから照合し不一致を区別する', async () => {
  const expectedValues = []
  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage(_workspaceId, _kind, _id, _limit, expected) {
      expectedValues.push(expected)
      return { data: null, error: { code: 'WORKSPACE_SNAPSHOT_CHANGED' } }
    },
    async mutate() { throw new Error('not used') },
  })
  const result = await repository.loadWorkspaceMasters(workspaceId, '12')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'WORKSPACE_SNAPSHOT_CHANGED')
  assert.deepEqual(expectedValues, ['12'])
})

test('Cloud Memberの入学年度はPostgreSQL integer上限まで全境界で統一する', async () => {
  const postgresIntegerMax = 2_147_483_647
  for (const member of [
    { id: 'without-year', realName: 'No Year', active: true },
    { ...memberA, entryAcademicYear: 2024 },
    { ...memberA, entryAcademicYear: postgresIntegerMax },
  ]) {
    assert.equal(isValidCloudWorkspaceMember(member), true)
  }
  for (const entryAcademicYear of [
    postgresIntegerMax + 1,
    Number.MAX_SAFE_INTEGER,
    0,
    -1,
    1.5,
    '2024',
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(isValidCloudWorkspaceMember({
      ...memberA,
      entryAcademicYear,
    }), false, String(entryAcademicYear))
  }

  let repositoryMutationCalls = 0
  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage() {
      return {
        data: {
          status: 'ok',
          workspaceId,
          workspaceGeneration: '4',
          rows: [memberRow({
            ...memberA,
            entryAcademicYear: postgresIntegerMax + 1,
          })],
          nextCursor: null,
        },
        error: null,
      }
    },
    async mutate() {
      repositoryMutationCalls += 1
      throw new Error('invalid Member must not reach the gateway')
    },
  })
  for (const result of [
    await repository.createMember(workspaceId, {
      ...memberA, entryAcademicYear: postgresIntegerMax + 1,
    }),
    await repository.updateMember(workspaceId, {
      ...memberA, entryAcademicYear: postgresIntegerMax + 1,
    }, 1),
  ]) {
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'INVALID_ARGUMENT')
  }
  assert.equal(repositoryMutationCalls, 0)
  const invalidRead = await repository.loadWorkspaceMasters(workspaceId)
  assert.equal(invalidRead.ok, false)
  if (!invalidRead.ok) assert.equal(invalidRead.error.code, 'INVALID_RESPONSE')

  let endpointMutationCalls = 0
  const endpointDependencies = {
    async authenticate() { return { id: 'actor-a' } },
    async mutateValidatedMaster() {
      endpointMutationCalls += 1
      throw new Error('invalid Member must not reach the RPC')
    },
  }
  const endpointRequest = body => new Request('https://example.test/workspace-masters', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  for (const body of [
    {
      workspaceId,
      operation: 'create-member',
      member: { ...memberA, entryAcademicYear: postgresIntegerMax + 1 },
    },
    {
      workspaceId,
      operation: 'update-member',
      member: { ...memberA, entryAcademicYear: postgresIntegerMax + 1 },
      expectedRevision: 1,
    },
  ]) {
    const response = await handleCloudWorkspaceMasterRequest(
      endpointRequest(body),
      endpointDependencies,
    )
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST')
  }
  assert.equal(endpointMutationCalls, 0)

  const invalidV2State = createDomainState()
  invalidV2State.members[0].entryAcademicYear = postgresIntegerMax + 1
  assert.deepEqual(createCloudEventSnapshotV2(invalidV2State, 'event-a'), {
    ok: false,
    reason: 'INVALID_SNAPSHOT',
  })

  const validV2State = createDomainState()
  validV2State.members[0].entryAcademicYear = postgresIntegerMax
  const validV2 = createCloudEventSnapshotV2(validV2State, 'event-a')
  assert.equal(validV2.ok, true)
  if (validV2.ok) {
    assert.equal(hasResolvedCloudEventSnapshotV2Masters(
      validV2.snapshot,
      validV2State.members,
      validV2State.bands,
    ), true)
    assert.equal(hasResolvedCloudEventSnapshotV2Masters(
      validV2.snapshot,
      [{ ...validV2State.members[0], entryAcademicYear: postgresIntegerMax + 1 }, memberB],
      validV2State.bands,
    ), false)
  }

  const legacyV1State = createDomainState()
  legacyV1State.members[0].entryAcademicYear = postgresIntegerMax + 1
  const legacyV1 = createCloudEventSnapshot(legacyV1State, 'event-a')
  assert.equal(legacyV1.ok, true)
  if (legacyV1.ok) {
    assert.deepEqual(parseCloudEventSnapshot(legacyV1.snapshot), legacyV1.snapshot)
  }
})

test('Cloud Event repositoryはMaster読込へ渡せるgeneration付きsnapshotを返す', async () => {
  const created = createCloudEventSnapshot(createDomainState(), 'event-a')
  assert.equal(created.ok, true)
  if (!created.ok) return
  const expectedValues = []
  const repository = createCloudEventRepository({
    async getWorkspaceRole() { throw new Error('versioned page RPC owns auth') },
    async listRows() { throw new Error('not used') },
    async loadRow() { throw new Error('not used') },
    async saveRow() { throw new Error('not used') },
    async deleteAuthorizedEvent() { throw new Error('not used') },
    async loadAuthorizedWorkspacePage(_workspaceId, _after, _limit, expected) {
      expectedValues.push(expected)
      return {
        data: {
          status: 'ok',
          workspace_id: workspaceId,
          workspace_generation: '14',
          rows: [{
            workspace_id: workspaceId,
            event_id: 'event-a',
            event_name: 'Event A',
            event_snapshot: created.snapshot,
            revision: 1,
            created_at: now,
            updated_at: now,
          }],
          next_cursor: null,
        },
        error: null,
      }
    },
  })
  const result = await repository.loadWorkspaceEventsAtGeneration(workspaceId, '14')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.generation, '14')
  assert.equal(result.value.records.length, 1)
  assert.deepEqual(expectedValues, ['14'])
})

test('Workspace read modelはEventとMasterを同じgenerationでのみ返す', async () => {
  const expected = []
  const events = {
    async loadWorkspaceEventsAtGeneration() {
      return { ok: true, value: { generation: '21', records: [] } }
    },
  }
  const masters = {
    async loadWorkspaceMasters(requestedWorkspaceId, expectedGeneration) {
      expected.push({ requestedWorkspaceId, expectedGeneration })
      return {
        ok: true,
        value: {
          workspaceId,
          generation: '21',
          members: [],
          bands: [],
        },
      }
    },
  }
  const result = await loadCloudWorkspaceAtOneGeneration(workspaceId, events, masters)
  assert.equal(result.ok, true)
  assert.deepEqual(expected, [{ requestedWorkspaceId: workspaceId, expectedGeneration: '21' }])

  const changed = await loadCloudWorkspaceAtOneGeneration(workspaceId, events, {
    async loadWorkspaceMasters() {
      return {
        ok: false,
        error: { code: 'WORKSPACE_SNAPSHOT_CHANGED', message: 'changed' },
      }
    },
  })
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.equal(changed.source, 'masters')
})

test('Master CRUDはrevisionを必須化しCAS/参照/認可errorを区別する', async () => {
  const calls = []
  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage() { throw new Error('not used') },
    async mutate(_workspaceId, mutation) {
      calls.push(structuredClone(mutation))
      if (mutation.operation === 'update-member' && mutation.expectedRevision === 1) {
        return { data: null, error: { code: '40001' } }
      }
      if (mutation.operation === 'delete-member') {
        return { data: null, error: { code: '23503' } }
      }
      if (mutation.operation === 'delete-band') {
        return { data: null, error: { code: '42501' } }
      }
      const record = mutation.operation.endsWith('member')
        ? memberRow(mutation.member, 2)
        : bandRow(mutation.band, 2)
      return { data: mutationResponse(record), error: null }
    },
  })

  assert.equal((await repository.createMember(workspaceId, memberA)).ok, true)
  const conflict = await repository.updateMember(workspaceId, memberA, 1)
  assert.equal(conflict.ok, false)
  if (!conflict.ok) assert.equal(conflict.error.code, 'REVISION_CONFLICT')
  const referenced = await repository.deleteMember(workspaceId, 'member-a', 2)
  assert.equal(referenced.ok, false)
  if (!referenced.ok) assert.equal(referenced.error.code, 'MASTER_REFERENCED')
  const denied = await repository.deleteBand(workspaceId, 'band-a', 2)
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'ACCESS_DENIED')

  assert.equal((await repository.updateMember(workspaceId, memberA, 0)).ok, false)
  assert.equal((await repository.updateBand(
    workspaceId,
    { ...bandA, defaultMemberIds: ['member-a', 'member-a'] },
    1,
  )).ok, false)
  assert.equal(calls.length, 4)
})

test('Master mutation responseは要求kind・Workspace・IDが完全一致する場合だけ受理する', async () => {
  const mutations = [
    { operation: 'create-member', member: memberA },
    { operation: 'update-member', member: memberA, expectedRevision: 1 },
    { operation: 'create-band', band: bandA },
    { operation: 'update-band', band: bandA, expectedRevision: 1 },
  ]
  for (const mutation of mutations) {
    const isMemberMutation = mutation.operation.endsWith('member')
    const wrongRecord = isMemberMutation
      ? memberRow({ ...mutation.member, id: 'different-member' })
      : bandRow({ ...mutation.band, id: 'different-band' })
    assert.equal(parseCloudWorkspaceMasterMutationValue(
      mutationResponse(wrongRecord),
      workspaceId,
      mutation,
    ), undefined, mutation.operation)
  }

  assert.ok(parseCloudWorkspaceMasterMutationValue(
    mutationResponse(memberRow()),
    workspaceId,
    { operation: 'create-member', member: memberA },
  ))
  assert.equal(parseCloudWorkspaceMasterMutationValue(
    mutationResponse(bandRow()),
    workspaceId,
    { operation: 'create-member', member: memberA },
  ), undefined)
  assert.equal(parseCloudWorkspaceMasterMutationValue(
    mutationResponse({ ...memberRow(), workspaceId: '70000000-0000-0000-0000-000000000002' }),
    workspaceId,
    { operation: 'create-member', member: memberA },
  ), undefined)

  const deletionMutation = {
    operation: 'delete-member', memberId: 'member-a', expectedRevision: 1,
  }
  const deletionResponse = id => ({
    status: 'ok',
    workspaceId,
    workspaceGeneration: '4',
    deletion: { kind: 'member', workspaceId, id, revision: 1 },
  })
  assert.ok(parseCloudWorkspaceMasterMutationValue(
    deletionResponse('member-a'), workspaceId, deletionMutation,
  ))
  assert.equal(parseCloudWorkspaceMasterMutationValue(
    deletionResponse('different-member'), workspaceId, deletionMutation,
  ), undefined)

  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage() { throw new Error('not used') },
    async mutate(_workspaceId, mutation) {
      const record = mutation.operation.endsWith('member')
        ? memberRow({ ...mutation.member, id: 'different-member' })
        : bandRow({ ...mutation.band, id: 'different-band' })
      return { data: mutationResponse(record), error: null }
    },
  })
  for (const result of [
    await repository.createMember(workspaceId, memberA),
    await repository.updateMember(workspaceId, memberA, 1),
    await repository.createBand(workspaceId, bandA),
    await repository.updateBand(workspaceId, bandA, 1),
  ]) {
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'INVALID_RESPONSE')
  }
})

test('同一Masterの古いrevisionだけが競合し異なるIDのmutationは独立して送信される', async () => {
  const revisionById = new Map([['member-a', 1], ['member-b', 1]])
  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage() { throw new Error('not used') },
    async mutate(_workspaceId, mutation) {
      if (mutation.operation !== 'update-member') throw new Error('unexpected')
      const current = revisionById.get(mutation.member.id)
      if (current !== mutation.expectedRevision) {
        return { data: null, error: { code: '40001' } }
      }
      revisionById.set(mutation.member.id, current + 1)
      return {
        data: mutationResponse(memberRow(mutation.member, current + 1)),
        error: null,
      }
    },
  })

  const [first, stale, other] = await Promise.all([
    repository.updateMember(workspaceId, memberA, 1),
    repository.updateMember(workspaceId, { ...memberA, realName: 'Stale' }, 1),
    repository.updateMember(workspaceId, memberB, 1),
  ])
  assert.equal(first.ok, true)
  assert.equal(stale.ok, false)
  assert.equal(other.ok, true)
})

test('Master Edge境界はauth・runtime input・DB outputを検証する', async () => {
  let calls = 0
  const dependencies = {
    async authenticate(token) {
      return token === 'valid-token' ? { id: 'actor-a' } : undefined
    },
    async mutateValidatedMaster({ mutation }) {
      calls += 1
      return {
        data: mutationResponse(memberRow(mutation.member, 1)),
        error: null,
      }
    },
  }
  const request = body => new Request('https://example.test/workspace-masters', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const success = await handleCloudWorkspaceMasterRequest(request({
    workspaceId,
    operation: 'create-member',
    member: memberA,
  }), dependencies)
  assert.equal(success.status, 200)

  const missingRevision = await handleCloudWorkspaceMasterRequest(request({
    workspaceId,
    operation: 'update-member',
    member: memberA,
  }), dependencies)
  assert.equal(missingRevision.status, 400)

  const invalidAuth = await handleCloudWorkspaceMasterRequest(new Request(
    'https://example.test/workspace-masters',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  ), dependencies)
  assert.equal(invalidAuth.status, 401)
  assert.equal(calls, 1)
})

test('Master Edgeは本文をbyte単位でstreamし上限超過時にmutation前で停止する', async () => {
  let calls = 0
  const dependencies = {
    async authenticate() { return { id: 'actor-a' } },
    async mutateValidatedMaster({ mutation }) {
      calls += 1
      return { data: mutationResponse(memberRow(mutation.member, 1)), error: null }
    },
  }
  const headers = {
    authorization: 'Bearer valid-token',
    'content-type': 'application/json',
  }
  const createBody = (targetBytes, realNameUnit = 'a') => {
    const value = {
      workspaceId,
      operation: 'create-member',
      member: { id: 'stream-member', realName: '', active: true },
    }
    const baseBytes = Buffer.byteLength(JSON.stringify(value))
    const unitBytes = Buffer.byteLength(realNameUnit)
    const unitCount = Math.floor((targetBytes - baseBytes) / unitBytes)
    value.member.realName = realNameUnit.repeat(Math.max(1, unitCount))
    let text = JSON.stringify(value)
    while (Buffer.byteLength(text) < targetBytes) {
      value.member.realName += 'a'
      text = JSON.stringify(value)
    }
    return text
  }
  const request = (body, extraHeaders = {}) => new Request(
    'https://example.test/workspace-masters',
    { method: 'POST', headers: { ...headers, ...extraHeaders }, body },
  )
  const streamRequest = chunks => new Request(
    'https://example.test/workspace-masters',
    {
      method: 'POST',
      headers,
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
      duplex: 'half',
    },
  )

  const smallJapanese = JSON.stringify({
    workspaceId,
    operation: 'create-member',
    member: { id: 'member-ja', realName: '日本語', active: true },
  })
  assert.equal((await handleCloudWorkspaceMasterRequest(
    request(smallJapanese), dependencies,
  )).status, 200)

  const exact = createBody(CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES)
  assert.equal(Buffer.byteLength(exact), CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES)
  assert.equal((await handleCloudWorkspaceMasterRequest(
    request(exact), dependencies,
  )).status, 200)

  const over = createBody(CLOUD_WORKSPACE_MASTER_MAX_REQUEST_BYTES + 1)
  assert.equal((await handleCloudWorkspaceMasterRequest(
    request(over, { 'content-length': '1' }), dependencies,
  )).status, 413)

  const encodedOver = new TextEncoder().encode(over)
  assert.equal((await handleCloudWorkspaceMasterRequest(
    streamRequest([encodedOver]), dependencies,
  )).status, 413)

  let streamCancellationCount = 0
  const cancellableOverRequest = new Request(
    'https://example.test/workspace-masters',
    {
      method: 'POST',
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encodedOver)
        },
        cancel() {
          streamCancellationCount += 1
        },
      }),
      duplex: 'half',
    },
  )
  assert.equal((await handleCloudWorkspaceMasterRequest(
    cancellableOverRequest, dependencies,
  )).status, 413)
  assert.equal(streamCancellationCount, 1)

  assert.equal((await handleCloudWorkspaceMasterRequest(
    streamRequest([
      encodedOver.subarray(0, 600_000),
      encodedOver.subarray(600_000),
    ]),
    dependencies,
  )).status, 413)

  assert.equal((await handleCloudWorkspaceMasterRequest(
    request(smallJapanese, { 'content-length': 'not-a-number' }), dependencies,
  )).status, 200)
  assert.equal((await handleCloudWorkspaceMasterRequest(
    request('{not-json'), dependencies,
  )).status, 400)
  assert.equal(calls, 3)
})

test('Band Member参照欠落は削除時のMASTER_REFERENCEDと区別する', async () => {
  const repository = createCloudWorkspaceMasterRepository({
    async loadAuthorizedPage() { throw new Error('not used') },
    async mutate() { return { data: null, error: { code: 'PMA01' } } },
  })
  const result = await repository.createBand(workspaceId, bandA)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'MASTER_MEMBER_NOT_FOUND')
    assert.match(result.error.message, /バンドメンバー/)
  }

  const response = await handleCloudWorkspaceMasterRequest(new Request(
    'https://example.test/workspace-masters',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspaceId, operation: 'create-band', band: bandA }),
    },
  ), {
    async authenticate() { return { id: 'actor-a' } },
    async mutateValidatedMaster() { return { data: null, error: { code: 'PMA01' } } },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'MASTER_MEMBER_NOT_FOUND')
})

test('Master Edge adapterはauth.getUserとservice-role限定RPCを分離する', async () => {
  const source = await readFile(new URL(
    '../supabase/functions/workspace-masters/index.ts',
    import.meta.url,
  ), 'utf8')
  assert.match(source, /authClient\.auth\.getUser\(accessToken\)/)
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.match(source, /backendClient\.rpc\('mutate_workspace_master_validated'/)
  assert.match(source, /p_actor_id: actorId/)
  assert.match(source, /p_expected_revision: args\.expectedRevision/)
  assert.doesNotMatch(source, /\.from\('workspace_master_/)
})

test('Workspace Master EdgeのDeno import mapはentrypointと同じSupabase versionを固定する', async () => {
  const [source, denoConfigText, packageJsonText] = await Promise.all([
    readFile(new URL(
      '../supabase/functions/workspace-masters/index.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/functions/workspace-masters/deno.json',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  const denoConfig = JSON.parse(denoConfigText)
  const packageJson = JSON.parse(packageJsonText)

  assert.deepEqual(denoConfig, {
    imports: {
      '@supabase/supabase-js': 'npm:@supabase/supabase-js@2.117.2',
    },
  })

  const entrypointVersion = source.match(
    /from 'npm:@supabase\/supabase-js@([^']+)'/,
  )?.[1]
  const importMapVersion = denoConfig.imports['@supabase/supabase-js'].match(
    /^npm:@supabase\/supabase-js@(.+)$/,
  )?.[1]

  assert.equal(entrypointVersion, importMapVersion)
  assert.equal(
    packageJson.dependencies['@supabase/supabase-js'],
    `^${importMapVersion}`,
  )
})

test('Workspace Master実HTTP smokeは実JWT・Edge route・限定fixture cleanupを要求する', async () => {
  const [runner, setup, cleanup, packageJson, runbook] = await Promise.all([
    readFile(new URL(
      '../scripts/cloudWorkspaceMasterHttpSmoke.mjs', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_workspace_master_http_smoke_setup.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_workspace_master_http_smoke_cleanup.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/cloud-setup.md', import.meta.url), 'utf8'),
  ])

  assert.match(runner, /--confirm-disposable/)
  assert.match(runner, /PROTECTED_DATABASE_PORTS/)
  assert.match(runner, /auth\.admin\.createUser/)
  assert.match(runner, /auth\.signInWithPassword/)
  assert.match(runner, /fetch\(functionUrl/)
  assert.match(runner, /expectAuthenticationRejected\('', deniedMember\)/)
  assert.match(runner, /sessions\.viewer\.accessToken[\s\S]*ACCESS_DENIED/)
  assert.match(runner, /sessions\.outsider\.accessToken[\s\S]*ACCESS_DENIED/)
  assert.match(runner, /WORKSPACE_NOT_READY/)
  assert.match(runner, /REVISION_CONFLICT/)
  assert.match(runner, /MASTER_MEMBER_NOT_FOUND/)
  assert.match(runner, /load_workspace_masters_page_authorized/)
  assert.match(runner, /sessions\.owner\.client\.rpc\('mutate_workspace_master_validated'/)
  assert.doesNotMatch(runner, /handleCloudWorkspaceMasterRequest/)
  assert.doesNotMatch(runner, /console\.(log|error)\([^\n]*(serviceRoleKey|accessToken|anonKey)/)

  for (const id of [
    '68000000-0000-0000-0000-000000000001',
    '68000000-0000-0000-0000-000000000002',
    '68000000-0000-0000-0000-000000000003',
  ]) {
    assert.match(setup, new RegExp(id, 'u'))
    assert.match(cleanup, new RegExp(id, 'u'))
  }
  assert.match(setup, /:'owner_user_id'::uuid/)
  assert.match(setup, /:'editor_user_id'::uuid/)
  assert.match(setup, /:'viewer_user_id'::uuid/)
  assert.match(setup, /:'outsider_user_id'::uuid/)
  assert.match(setup, /set status = 'ready'/)
  assert.match(setup, /status = 'ready'[\s\S]*status[^;]*is distinct from 'legacy'/)
  assert.match(cleanup, /delete from public\.workspaces[\s\S]*where id in/)
  assert.doesNotMatch(cleanup, /delete from auth\.users/)
  assert.match(JSON.parse(packageJson).scripts['test:cloud-workspace-master-http-smoke'],
    /--confirm-disposable/)
  assert.match(runbook, /ACAPPELLA_TT_SMOKE_SUPABASE_URL/)
  assert.match(runbook, /JWT verificationを無効化せず/)
})

test('Master migrationはready gate・CAS・generation・backend-only ACLを同一transactionで定義する', async () => {
  const source = await readFile(
    new URL('../supabase/migrations/20261012110000_cloud_workspace_master_contracts_v2.sql', import.meta.url),
    'utf8',
  )
  assert.equal((source.match(/^begin;$/gmu) ?? []).length, 1)
  assert.equal((source.match(/^commit;$/gmu) ?? []).length, 1)
  assert.match(source, /load_workspace_masters_page_authorized\([\s\S]*p_expected_generation text/i)
  assert.match(source, /from public\.workspace_members[\s\S]*for share/i)
  assert.match(source, /cloud_workspace_master_states[\s\S]*for share/i)
  assert.match(source, /master_status is distinct from 'ready'/i)
  assert.match(source, /p_operation is null/i)
  assert.match(source, /p_master_kind is null/i)
  assert.match(source, /p_payload is null/i)
  assert.match(source, /jsonb_typeof\(p_payload\) is distinct from 'object'/i)
  assert.match(source,
    /jsonb_typeof\(p_payload -> 'realName'\) is distinct from 'string'/i)
  assert.match(source,
    /jsonb_typeof\(p_payload -> 'active'\) is distinct from 'boolean'/i)
  assert.match(source, /jsonb_typeof\(p_payload -> 'name'\) is distinct from 'string'/i)
  assert.match(source,
    /jsonb_typeof\(p_payload -> 'defaultMemberIds'\) is distinct from 'array'/i)
  assert.ok(
    source.indexOf("jsonb_typeof(p_payload -> 'defaultMemberIds') is distinct from 'array'") <
      source.indexOf("jsonb_array_elements(p_payload -> 'defaultMemberIds')"),
  )
  assert.match(source, /p_expected_revision[\s\S]*errcode = '40001'/i)
  assert.match(source, /Workspace Band references an unknown Member[\s\S]*errcode = 'PMA01'/i)
  assert.match(source, /delete from public\.workspace_master_band_members[\s\S]*insert into public\.workspace_master_band_members/i)
  assert.match(source, /grant execute on function public\.load_workspace_masters_page_authorized[\s\S]*to authenticated/i)
  assert.match(source, /grant execute on function public\.mutate_workspace_master_validated[\s\S]*to service_role/i)
  assert.doesNotMatch(source, /grant\s+(insert|update|delete)[\s\S]*workspace_master_/i)
})

test('実DB fixtureはCRUD/CAS/role/generationとasync concurrencyをrollbackまたは固定ID cleanupする', async () => {
  const integration = await readFile(new URL(
    '../supabase/tests/cloud_workspace_master_contracts.sql',
    import.meta.url,
  ), 'utf8')
  const concurrency = await readFile(new URL(
    '../supabase/tests/cloud_workspace_master_contracts_concurrency.sql',
    import.meta.url,
  ), 'utf8')
  assert.match(integration, /^\\set ON_ERROR_STOP on[\s\S]*\bbegin;/i)
  assert.match(integration, /exception when sqlstate '40001'/i)
  assert.match(integration, /exception when sqlstate '42501'/i)
  assert.match(integration, /exception when sqlstate '55000'/i)
  assert.match(integration, /SQL NULL operation[\s\S]*SQL NULL kind/i)
  assert.match(integration, /SQL NULL payload[\s\S]*JSON null payload/i)
  assert.match(integration, /create revision[\s\S]*missing update revision/i)
  assert.match(integration, /missing delete revision/i)
  assert.match(integration,
    /Member create missing realName[\s\S]*Member update missing realName/i)
  assert.match(integration,
    /Band create missing defaultMemberIds[\s\S]*Band update missing defaultMemberIds/i)
  assert.match(integration,
    /Band create object defaultMemberIds[\s\S]*Band update string defaultMemberIds/i)
  assert.match(integration, /Rejected invalid mutation changed Master or generation state/i)
  assert.match(integration, /Valid optional\/empty-relation mutation contract failed/i)
  assert.match(integration, /exception when sqlstate '22023'/i)
  assert.match(integration, /exception when sqlstate 'PMA01'/i)
  assert.match(integration, /exception when foreign_key_violation/i)
  assert.match(integration, /load_workspace_masters_page_authorized[\s\S]*workspaceGeneration/i)
  assert.match(integration, /rollback;\s*$/i)

  assert.match(concurrency, /dblink_send_query\('master_cas_b'/i)
  assert.match(concurrency, /dblink_send_query\('master_cas_b'[\s\S]*<> 1/i)
  assert.equal((concurrency.match(/dblink_get_result\('master_cas_b'\)/g) ?? []).length, 4)
  assert.match(concurrency, /same-Master CAS writer did not wait/i)
  assert.match(concurrency, /different-Master update did not serialize on Workspace generation/i)
  assert.match(concurrency, /delete from public\.workspaces[\s\S]*72000000-0000-0000-0000-000000000001/i)
  assert.match(concurrency, /delete from auth\.users where id in/i)
})
