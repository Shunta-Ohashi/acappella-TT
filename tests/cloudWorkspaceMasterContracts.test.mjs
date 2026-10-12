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
import { handleCloudWorkspaceMasterRequest } from '../src/cloud/cloudWorkspaceMasterEndpoint.ts'
import { createCloudEventRepository } from '../src/cloud/cloudEventRepository.ts'
import {
  createCloudWorkspaceMasterRepository,
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
  assert.match(source, /p_expected_revision[\s\S]*errcode = '40001'/i)
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
