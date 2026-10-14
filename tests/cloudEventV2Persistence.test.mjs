import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createCloudEventSnapshot,
  createCloudEventSnapshotV2,
} from '../src/cloud/cloudEventSnapshot.ts'
import {
  CLOUD_EVENT_V2_SAVE_MAX_REQUEST_BYTES,
  handleCloudEventV2SaveRequest,
} from '../src/cloud/cloudEventV2SaveEndpoint.ts'
import {
  createCloudEventV2Repository,
} from '../src/cloud/cloudEventV2Repository.ts'
import { loadCloudWorkspaceV2AtOneGeneration } from '../src/cloud/cloudWorkspaceReadModel.ts'

const workspaceId = '70000000-0000-0000-0000-000000000001'
const now = '2026-10-13T00:00:00.000Z'

const memberA = { id: 'member-a', realName: 'Alice', active: true }
const memberB = { id: 'member-b', realName: 'Bob', active: true }
const bandA = {
  id: 'band-a',
  name: 'Alpha',
  defaultMemberIds: ['member-b'],
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
  eventDays: [{ id: 'day-a', eventId: 'event-a', date: '2026-10-13', order: 0 }],
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

const createV2 = () => {
  const result = createCloudEventSnapshotV2(createDomainState(), 'event-a')
  assert.equal(result.ok, true)
  return result.snapshot
}

const rawRecord = (snapshot = createV2(), revision = 1) => ({
  workspace_id: workspaceId,
  event_id: snapshot.eventState.events[0].id,
  event_name: snapshot.eventState.events[0].name,
  event_snapshot: structuredClone(snapshot),
  revision,
  created_at: now,
  updated_at: now,
})

const page = (rows, generation = '4', nextCursor = null) => ({
  status: 'ok',
  workspace_id: workspaceId,
  workspace_generation: generation,
  rows,
  next_cursor: nextCursor,
})

const successValue = (
  snapshot = createV2(),
  revision = 1,
  generation = '5',
) => ({
  status: 'ok',
  workspaceId,
  workspaceGeneration: generation,
  record: rawRecord(snapshot, revision),
})

const jsonRequest = (body, headers = {}) => new Request('https://example.invalid/save', {
  method: 'POST',
  headers: {
    authorization: 'Bearer valid-token',
    'content-type': 'application/json',
    ...headers,
  },
  body: JSON.stringify(body),
})

test('V2 repositoryは同一generationのV2だけを読み、V1/V2混在をfail closedにする', async () => {
  const snapshot = createV2()
  const requests = []
  const repository = createCloudEventV2Repository({
    async loadAuthorizedWorkspacePage(...args) {
      requests.push(args)
      return { data: page([rawRecord(snapshot)]), error: null }
    },
    async saveValidatedSnapshot() {
      throw new Error('not used')
    },
  })

  const loaded = await repository.loadWorkspaceEventsAtGeneration(workspaceId)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.value.generation, '4')
  assert.deepEqual(loaded.value.records[0].snapshot, snapshot)
  assert.deepEqual(requests, [[workspaceId, null, 100, null]])

  const v1 = createCloudEventSnapshot(createDomainState(), 'event-a')
  assert.equal(v1.ok, true)
  const mixed = createCloudEventV2Repository({
    async loadAuthorizedWorkspacePage() {
      return { data: page([rawRecord(snapshot), {
        ...rawRecord(snapshot),
        event_id: 'event-v1',
        event_name: 'Event V1',
        event_snapshot: {
          ...v1.snapshot,
          appState: {
            ...v1.snapshot.appState,
            events: [{
              ...v1.snapshot.appState.events[0],
              id: 'event-v1',
              name: 'Event V1',
            }],
          },
        },
      }]), error: null }
    },
    async saveValidatedSnapshot() {
      throw new Error('not used')
    },
  })
  const rejected = await mixed.loadWorkspaceEventsAtGeneration(workspaceId)
  assert.deepEqual(rejected, {
    ok: false,
    error: {
      code: 'INVALID_SNAPSHOT',
      message: 'Cloud Event Snapshot V2の形式またはversionが正しくありません。',
    },
  })

  const changed = createCloudEventV2Repository({
    async loadAuthorizedWorkspacePage() {
      return { data: null, error: { code: '40001' } }
    },
    async saveValidatedSnapshot() {
      throw new Error('not used')
    },
  })
  assert.equal(
    (await changed.loadWorkspaceEventsAtGeneration(workspaceId)).error.code,
    'WORKSPACE_SNAPSHOT_CHANGED',
  )
})

test('V2 repositoryはrevision/generation CAS引数を渡し応答identityを再検証する', async () => {
  const snapshot = createV2()
  let received
  const repository = createCloudEventV2Repository({
    async loadAuthorizedWorkspacePage() {
      throw new Error('not used')
    },
    async saveValidatedSnapshot(input) {
      received = input
      return { data: successValue(snapshot, 3, '10'), error: null }
    },
  })
  const result = await repository.saveEvent(workspaceId, snapshot, 2, '9')
  assert.equal(result.ok, true)
  assert.deepEqual(received, {
    workspaceId,
    snapshot,
    expectedRevision: 2,
    expectedGeneration: '9',
  })

  const wrongIdentity = createCloudEventV2Repository({
    async loadAuthorizedWorkspacePage() {
      throw new Error('not used')
    },
    async saveValidatedSnapshot() {
      const response = successValue(snapshot, 3, '10')
      response.record.event_id = 'other-event'
      return { data: response, error: null }
    },
  })
  assert.equal((await wrongIdentity.saveEvent(
    workspaceId, snapshot, 2, '9',
  )).error.code, 'INVALID_RESPONSE')

  const stale = createCloudEventV2Repository({
    async loadAuthorizedWorkspacePage() {
      throw new Error('not used')
    },
    async saveValidatedSnapshot() {
      return { data: null, error: { code: 'PVE04' } }
    },
  })
  assert.equal((await stale.saveEvent(
    workspaceId, snapshot, 2, '9',
  )).error.code, 'WORKSPACE_SNAPSHOT_CHANGED')
})

test('V2 Edge境界はJWT・runtime validation・CAS応答を検証する', async () => {
  const snapshot = createV2()
  let mutationCalls = 0
  let received
  const dependencies = {
    async authenticate(token) {
      assert.equal(token, 'valid-token')
      return { id: '00000000-0000-0000-0000-000000000071' }
    },
    async saveValidatedSnapshot(input) {
      mutationCalls += 1
      received = input
      return { data: successValue(snapshot, 1, '5'), error: null }
    },
  }
  const response = await handleCloudEventV2SaveRequest(jsonRequest({
    workspaceId,
    snapshot,
    expectedRevision: null,
    expectedGeneration: '4',
  }), dependencies)
  assert.equal(response.status, 200)
  assert.equal(mutationCalls, 1)
  assert.equal(received.expectedRevision, null)
  assert.equal(received.expectedGeneration, '4')

  const malformed = structuredClone(snapshot)
  malformed.eventState.members = []
  const rejected = await handleCloudEventV2SaveRequest(jsonRequest({
    workspaceId,
    snapshot: malformed,
    expectedRevision: null,
    expectedGeneration: '4',
  }), dependencies)
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error.code, 'INVALID_SNAPSHOT')
  assert.equal(mutationCalls, 1)
})

test('V2 EdgeはDB競合を区別し不正応答を成功扱いしない', async () => {
  const snapshot = createV2()
  const requestBody = {
    workspaceId,
    snapshot,
    expectedRevision: 2,
    expectedGeneration: '9',
  }
  for (const [databaseCode, status, endpointCode] of [
    ['23505', 409, 'ALREADY_EXISTS'],
    ['40001', 409, 'REVISION_CONFLICT'],
    ['PVE04', 409, 'WORKSPACE_SNAPSHOT_CHANGED'],
    ['55000', 409, 'WORKSPACE_NOT_READY'],
    ['PVE02', 409, 'MASTER_REFERENCE_INVALID'],
    ['PVE01', 409, 'SNAPSHOT_VERSION_CONFLICT'],
    ['42501', 403, 'ACCESS_DENIED'],
  ]) {
    const response = await handleCloudEventV2SaveRequest(jsonRequest(requestBody), {
      async authenticate() {
        return { id: 'actor' }
      },
      async saveValidatedSnapshot() {
        return { data: null, error: { code: databaseCode } }
      },
    })
    assert.equal(response.status, status, databaseCode)
    assert.equal((await response.json()).error.code, endpointCode, databaseCode)
  }

  const invalidResponse = successValue(snapshot, 3, '10')
  invalidResponse.record.event_snapshot.masterReferences.memberIds = ['member-a']
  const response = await handleCloudEventV2SaveRequest(jsonRequest(requestBody), {
    async authenticate() {
      return { id: 'actor' }
    },
    async saveValidatedSnapshot() {
      return { data: invalidResponse, error: null }
    },
  })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'INVALID_RESPONSE')
})

test('V2 Edgeは不正JWT・method・media type・JSONをmutation前に拒否する', async () => {
  let mutationCalls = 0
  const dependencies = {
    async authenticate() {
      return undefined
    },
    async saveValidatedSnapshot() {
      mutationCalls += 1
      return { data: null, error: null }
    },
  }
  const unauthorized = await handleCloudEventV2SaveRequest(jsonRequest({}), dependencies)
  assert.equal(unauthorized.status, 401)

  const wrongMethod = await handleCloudEventV2SaveRequest(new Request(
    'https://example.invalid/save',
    { method: 'GET' },
  ), dependencies)
  assert.equal(wrongMethod.status, 405)

  const wrongMedia = await handleCloudEventV2SaveRequest(new Request(
    'https://example.invalid/save',
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'text/plain' },
      body: '{}',
    },
  ), dependencies)
  assert.equal(wrongMedia.status, 415)

  const malformedJson = await handleCloudEventV2SaveRequest(new Request(
    'https://example.invalid/save',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: '{',
    },
  ), {
    ...dependencies,
    async authenticate() {
      return { id: 'actor' }
    },
  })
  assert.equal(malformedJson.status, 400)
  assert.equal(mutationCalls, 0)
})

test('V2 Edgeは実body byte数を上限で停止しmutationを呼ばない', async () => {
  let mutationCalls = 0
  const response = await handleCloudEventV2SaveRequest(new Request(
    'https://example.invalid/save',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: `{"padding":"${'x'.repeat(CLOUD_EVENT_V2_SAVE_MAX_REQUEST_BYTES)}"}`,
    },
  ), {
    async authenticate() {
      return { id: 'actor' }
    },
    async saveValidatedSnapshot() {
      mutationCalls += 1
      return { data: null, error: null }
    },
  })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, 'REQUEST_TOO_LARGE')
  assert.equal(mutationCalls, 0)
})

test('V2 EdgeはContent-Lengthを信用せずchunk合計の実byte数を検証する', async () => {
  let mutationCalls = 0
  const chunkSize = Math.floor(CLOUD_EVENT_V2_SAVE_MAX_REQUEST_BYTES / 2) + 1
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(chunkSize))
      controller.enqueue(new Uint8Array(chunkSize))
      controller.close()
    },
  })
  const request = new Request('https://example.invalid/save', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
      'content-length': '1',
    },
    body: stream,
    duplex: 'half',
  })
  const response = await handleCloudEventV2SaveRequest(request, {
    async authenticate() {
      return { id: 'actor' }
    },
    async saveValidatedSnapshot() {
      mutationCalls += 1
      return { data: null, error: null }
    },
  })
  assert.equal(response.status, 413)
  assert.equal(mutationCalls, 0)
})

test('V2 read modelはEventとMasterを同一generationで解決しclosure欠損時に返却しない', async () => {
  const snapshot = createV2()
  const eventRecord = {
    workspaceId,
    eventId: 'event-a',
    eventName: 'Event A',
    snapshot,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const events = {
    async loadWorkspaceEventsAtGeneration() {
      return { ok: true, value: { generation: '8', records: [eventRecord] } }
    },
  }
  const masterSnapshot = {
    workspaceId,
    generation: '8',
    members: [memberA, memberB].map(value => ({
      kind: 'member', workspaceId, value, revision: 1, createdAt: now, updatedAt: now,
    })),
    bands: [{
      kind: 'band', workspaceId, value: bandA, revision: 1, createdAt: now, updatedAt: now,
    }],
  }
  const success = await loadCloudWorkspaceV2AtOneGeneration(workspaceId, events, {
    async loadWorkspaceMasters(_workspaceId, expectedGeneration) {
      assert.equal(expectedGeneration, '8')
      return { ok: true, value: masterSnapshot }
    },
  })
  assert.equal(success.ok, true)

  const missing = await loadCloudWorkspaceV2AtOneGeneration(workspaceId, events, {
    async loadWorkspaceMasters() {
      return {
        ok: true,
        value: { ...masterSnapshot, members: masterSnapshot.members.slice(0, 1) },
      }
    },
  })
  assert.deepEqual(missing, {
    ok: false,
    source: 'references',
    error: {
      code: 'MASTER_REFERENCE_INVALID',
      message: 'Cloud EventとWorkspace共通データの参照が一致しません。',
    },
  })
})

test('V2 forward migrationはV1/V2 CHECK・ready guard・CAS・atomic参照更新を同一transactionに持つ', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261013110000_cloud_event_v2_persistence_foundation.sql',
    import.meta.url,
  ), 'utf8')
  assert.equal((sql.match(/^begin;$/gmu) ?? []).length, 1)
  assert.equal((sql.match(/^commit;$/gmu) ?? []).length, 1)
  assert.ok(sql.indexOf('begin;') < sql.indexOf('create function'))
  assert.ok(sql.lastIndexOf('commit;') > sql.indexOf('grant execute'))
  assert.match(sql, /cloud_events_snapshot_shape_check[\s\S]*'1'::jsonb[\s\S]*is_cloud_event_v2_snapshot_shape/u)
  assert.match(sql, /event_state \? 'members'/u)
  assert.match(sql, /event_state \? 'bands'/u)
  assert.match(sql, /master_status is not distinct from 'ready'/u)
  assert.match(sql, /master_status is distinct from 'ready'/u)
  assert.match(sql, /Cloud Event already exists'[\s\S]*errcode = '23505'/u)
  assert.match(sql, /existing_row\.revision <> p_expected_revision/u)
  assert.match(sql, /p_expected_generation::bigint <> current_generation/u)
  assert.match(sql, /for share[\s\S]*workspace_master_members[\s\S]*for share[\s\S]*workspace_master_bands[\s\S]*for update/iu)
  assert.match(sql, /delete from public\.cloud_event_member_references/u)
  assert.match(sql, /insert into public\.cloud_event_member_references/u)
  assert.match(sql, /delete from public\.cloud_event_band_references/u)
  assert.match(sql, /insert into public\.cloud_event_band_references/u)
  assert.match(sql, /from public, anon, authenticated;[\s\S]*to service_role;/u)
})

test('V2 Edge Functionは専用Deno契約とCI frozen checkを持つ', async () => {
  const [index, config, lock, workflow] = await Promise.all([
    readFile(new URL('../supabase/functions/save-cloud-event-v2/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/save-cloud-event-v2/deno.json', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/save-cloud-event-v2/deno.lock', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  ])
  assert.match(index, /auth\.getUser\(accessToken\)/u)
  assert.match(index, /save_cloud_event_v2_validated/u)
  assert.equal(JSON.parse(config).nodeModulesDir, 'auto')
  assert.equal(
    JSON.parse(config).imports['@supabase/supabase-js'],
    'npm:@supabase/supabase-js@2.117.2',
  )
  assert.equal(JSON.parse(lock).specifiers['npm:@supabase/supabase-js@2.117.2'], '2.117.2')
  assert.match(workflow, /save-cloud-event-v2\/deno\.json/u)
  assert.match(workflow, /save-cloud-event-v2\/index\.ts/u)
})

test('V2実HTTP smokeは専用55721/55722環境・実JWT・DB不変性・限定cleanupを要求する', async () => {
  const [runner, setup, cleanup, verify, packageJson, runbook, masterRunner] =
    await Promise.all([
      readFile(new URL('../scripts/cloudEventV2HttpSmoke.mjs', import.meta.url), 'utf8'),
      readFile(new URL(
        '../supabase/tests/cloud_event_v2_http_smoke_setup.sql',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL(
        '../supabase/tests/cloud_event_v2_http_smoke_cleanup.sql',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL(
        '../supabase/tests/cloud_event_v2_http_smoke_verify.sql',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../docs/cloud-setup.md', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/cloudWorkspaceMasterHttpSmoke.mjs', import.meta.url), 'utf8'),
    ])

  assert.match(runner, /--confirm-disposable/u)
  assert.match(runner, /--cleanup-only/u)
  assert.match(runner, /const API_PORT = '55721'/u)
  assert.match(runner, /const DATABASE_PORT = '55722'/u)
  assert.match(runner, /LOOPBACK_HOSTS/u)
  assert.match(runner, /parsedFunctionUrl\.origin !== parsedSupabaseUrl\.origin/u)
  assert.match(runner, /auth\.admin\.createUser/u)
  assert.match(runner, /auth\.signInWithPassword/u)
  assert.match(runner, /fetch\(functionUrl/u)
  assert.match(runner, /sessions\.viewer\.accessToken[\s\S]*ACCESS_DENIED/u)
  assert.match(runner, /sessions\.outsider\.accessToken[\s\S]*ACCESS_DENIED/u)
  assert.match(runner, /WORKSPACE_NOT_READY/u)
  assert.match(runner, /REVISION_CONFLICT/u)
  assert.match(runner, /WORKSPACE_SNAPSHOT_CHANGED/u)
  assert.match(runner, /INVALID_SNAPSHOT/u)
  assert.equal((runner.match(/MASTER_REFERENCE_INVALID/gu) ?? []).length, 2)
  assert.match(runner, /SNAPSHOT_VERSION_CONFLICT/u)
  assert.match(runner, /save_cloud_event_v2_validated/u)
  assert.match(runner, /assert\.equal\(error\.code, '42501'\)/u)
  assert.match(runner, /MAX_REQUEST_BYTES/u)
  assert.match(runner, /verifyDatabaseState/u)
  assert.match(runner, /assertFailureLeavesDatabaseUnchanged/u)
  assert.doesNotMatch(runner, /console\.(?:log|error)\([^\n]*(?:serviceRoleKey|accessToken|anonKey)/u)
  assert.doesNotMatch(runner, /--no-verify-jwt/u)

  for (const id of [
    '76000000-0000-0000-0000-000000000001',
    '76000000-0000-0000-0000-000000000002',
    '76000000-0000-0000-0000-000000000003',
  ]) {
    assert.match(setup, new RegExp(id, 'u'))
    assert.match(cleanup, new RegExp(id, 'u'))
    assert.doesNotMatch(masterRunner, new RegExp(id, 'u'))
  }
  assert.match(setup, /fixture IDs are already in use/u)
  assert.doesNotMatch(setup, /delete from public\./iu)
  assert.match(setup, /:'owner_user_id'::uuid/u)
  assert.match(setup, /:'editor_user_id'::uuid/u)
  assert.match(setup, /:'viewer_user_id'::uuid/u)
  assert.match(setup, /'version', 1[\s\S]*set status = 'ready'/u)
  assert.match(cleanup, /delete from public\.workspaces[\s\S]*where id in/u)
  assert.doesNotMatch(cleanup, /truncate|delete from auth\.users/iu)
  assert.match(verify, /cloud_event_member_references/u)
  assert.match(verify, /cloud_event_band_references/u)
  assert.match(verify, /expected\.generation/u)
  assert.match(verify, /expected\.legacy_generation/u)
  assert.match(verify, /expected\.v1_generation/u)
  assert.match(verify, /expected\.revision/u)
  assert.match(verify, /Cloud Event V2 HTTP smoke invariant changed/u)

  assert.match(
    JSON.parse(packageJson).scripts['test:cloud-event-v2-http-smoke'],
    /cloudEventV2HttpSmoke\.mjs --confirm-disposable/u,
  )
  assert.match(runbook, /ACAPPELLA_TT_EVENT_V2_SMOKE_SUPABASE_URL/u)
  assert.match(runbook, /55721/u)
  assert.match(runbook, /55722/u)
  assert.match(runbook, /test:cloud-event-v2-http-smoke/u)
})

test('V2実DBfixturesはrollback型とdblink並行競合の双方を登録する', async () => {
  const [contract, concurrency] = await Promise.all([
    readFile(new URL('../supabase/tests/cloud_event_v2_persistence.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/tests/cloud_event_v2_persistence_concurrency.sql', import.meta.url), 'utf8'),
  ])
  assert.match(contract, /^begin;$/mu)
  assert.match(contract, /^rollback;$/mu)
  assert.match(contract, /save_cloud_event_v2_validated/u)
  assert.match(contract, /cloud_event_member_references/u)
  assert.match(contract, /cloud_event_band_references/u)
  assert.match(concurrency, /dblink_send_query/u)
  assert.match(concurrency, /wait_event_type = 'Lock'/u)
  assert.match(concurrency, /dblink_get_result/u)
  assert.match(concurrency, /delete from public\.workspaces where id/u)
})
