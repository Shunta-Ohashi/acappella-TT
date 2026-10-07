import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import {
  createCloudEventRepository,
} from '../src/cloud/cloudEventRepository.ts'
import {
  isCloudEventCacheWriteReady,
  loadCloudWorkspaceEvents,
  saveCloudEventFromState,
} from '../src/cloud/cloudEventLifecycle.ts'
import {
  CLOUD_EVENT_SNAPSHOT_FORMAT,
  CLOUD_EVENT_SNAPSHOT_VERSION,
  createCloudEventSnapshot,
  createCloudWorkspaceState,
  parseCloudEventSnapshot,
} from '../src/cloud/cloudEventSnapshot.ts'
import { CURRENT_STORAGE_VERSION } from '../src/persistence/localPersistence.ts'

const createEmptyState = () => ({
  members: [], bands: [], events: [], eventDays: [], stages: [], sections: [],
  eventMembers: [], eventMemberDays: [], eventBands: [], scheduleItems: [],
  paAssignments: [], dutyTypes: [], dutyAssignments: [], timetableLocks: [],
  timetableOrderConstraints: [],
})

class MemoryCloudEventGateway {
  rows = new Map()
  allowedWorkspaces = new Set()
  clock = 0

  constructor(allowedWorkspaces) {
    this.allowedWorkspaces = new Set(allowedWorkspaces)
  }

  key(workspaceId, eventId) {
    return `${workspaceId}:${eventId}`
  }

  deny(workspaceId) {
    return this.allowedWorkspaces.has(workspaceId)
      ? undefined
      : { data: null, error: { code: '42501' } }
  }

  timestamp() {
    this.clock += 1
    return new Date(Date.UTC(2026, 9, 7, 0, 0, this.clock)).toISOString()
  }

  async getWorkspaceRole(workspaceId) {
    return this.allowedWorkspaces.has(workspaceId)
      ? { data: { role: 'editor' }, error: null }
      : { data: null, error: null }
  }

  async listRows(workspaceId) {
    const denied = this.deny(workspaceId)
    if (denied) return denied
    return {
      data: [...this.rows.values()]
        .filter(row => row.workspace_id === workspaceId)
        .map(({ event_snapshot: _snapshot, ...summary }) => structuredClone(summary)),
      error: null,
    }
  }

  async loadRow(workspaceId, eventId) {
    const denied = this.deny(workspaceId)
    if (denied) return denied
    return {
      data: structuredClone(this.rows.get(this.key(workspaceId, eventId)) ?? null),
      error: null,
    }
  }

  async saveRow({ workspaceId, eventId, eventName, snapshot }) {
    const denied = this.deny(workspaceId)
    if (denied) return denied
    const key = this.key(workspaceId, eventId)
    const previous = this.rows.get(key)
    const now = this.timestamp()
    const row = {
      workspace_id: workspaceId,
      event_id: eventId,
      event_name: eventName,
      event_snapshot: structuredClone(snapshot),
      revision: previous ? previous.revision + 1 : 1,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    }
    this.rows.set(key, row)
    return { data: structuredClone(row), error: null }
  }

  async deleteRow(workspaceId, eventId) {
    const denied = this.deny(workspaceId)
    if (denied) return denied
    const key = this.key(workspaceId, eventId)
    const row = this.rows.get(key)
    if (!row) return { data: null, error: null }
    this.rows.delete(key)
    const { event_snapshot: _snapshot, ...summary } = row
    return { data: structuredClone(summary), error: null }
  }
}

const createSnapshot = (state, eventId) => {
  const result = createCloudEventSnapshot(state, eventId)
  assert.equal(result.ok, true)
  return result.snapshot
}

const loadSnapshotsInOrder = (
  snapshots,
  order,
  updatedAts,
  localState = createEmptyState(),
) => {
  const records = snapshots.map((snapshot, index) => ({
    workspaceId: 'workspace-a',
    eventId: snapshot.appState.events[0].id,
    eventName: snapshot.appState.events[0].name,
    revision: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: updatedAts[index],
    snapshot,
  }))
  return loadCloudWorkspaceEvents({
    async listEvents() {
      return { ok: true, value: order.map(index => {
        const { snapshot: _snapshot, ...summary } = records[index]
        return summary
      }) }
    },
    async loadEvent(_workspaceId, eventId) {
      return { ok: true, value: records.find(record => record.eventId === eventId) }
    },
    async saveEvent() { throw new Error('not called') },
    async deleteEvent() { throw new Error('not called') },
  }, 'workspace-a', localState)
}

test('Event単位snapshotはV5を再利用して対象Eventと参照masterだけをround-tripする', () => {
  const state = createDemoData()
  const before = structuredClone(state)
  const eventId = state.events[0].id
  const created = createCloudEventSnapshot(state, eventId)
  assert.equal(created.ok, true)
  if (!created.ok) return

  assert.equal(created.snapshot.format, CLOUD_EVENT_SNAPSHOT_FORMAT)
  assert.equal(created.snapshot.version, CLOUD_EVENT_SNAPSHOT_VERSION)
  assert.equal(created.snapshot.appState.version, CURRENT_STORAGE_VERSION)
  assert.deepEqual(created.snapshot.appState.events.map(event => event.id), [eventId])
  assert.ok(created.snapshot.eventId === undefined)
  assert.ok(created.snapshot.appState.eventDays.every(day => day.eventId === eventId))
  assert.ok(created.snapshot.appState.events.length < state.events.length)
  assert.ok(created.snapshot.appState.members.length <= state.members.length)
  assert.deepEqual(
    parseCloudEventSnapshot(structuredClone(created.snapshot)),
    created.snapshot,
  )
  assert.deepEqual(state, before)
})

test('unsupportedまたはmalformed Cloud Event snapshotを拒否する', () => {
  const snapshot = createSnapshot(createDemoData(), 'event-demo-main')
  assert.equal(parseCloudEventSnapshot({ ...snapshot, version: 999 }), undefined)
  assert.equal(parseCloudEventSnapshot({ ...snapshot, format: 'other' }), undefined)
  assert.equal(parseCloudEventSnapshot({ ...snapshot, appState: { version: 5 } }), undefined)

  const withForeignEvent = structuredClone(snapshot)
  withForeignEvent.appState.events.push({
    ...withForeignEvent.appState.events[0],
    id: 'foreign-event',
  })
  assert.equal(parseCloudEventSnapshot(withForeignEvent), undefined)

  const withDuplicateMember = structuredClone(snapshot)
  assert.ok(withDuplicateMember.appState.members[0])
  withDuplicateMember.appState.members.push(withDuplicateMember.appState.members[0])
  assert.equal(parseCloudEventSnapshot(withDuplicateMember), undefined)
})

test('複数Event snapshotからWorkspace stateを構築しlocal-only masterを維持する', () => {
  const state = createDemoData()
  const snapshots = state.events.slice(0, 2).map(event => createSnapshot(state, event.id))
  const sharedMember = snapshots[0].appState.members.find(member =>
    snapshots[1].appState.members.some(candidate => candidate.id === member.id))
  const firstOnlyMember = snapshots[0].appState.members.find(member =>
    !snapshots[1].appState.members.some(candidate => candidate.id === member.id))
  const firstOnlyBand = snapshots[0].appState.bands.find(band =>
    !snapshots[1].appState.bands.some(candidate => candidate.id === band.id))
  assert.ok(sharedMember)
  assert.ok(firstOnlyMember)
  assert.ok(firstOnlyBand)
  const secondMemberIndex = snapshots[1].appState.members.findIndex(
    member => member.id === sharedMember.id,
  )
  snapshots[1].appState.members[secondMemberIndex] = Object.fromEntries(
    Object.entries(snapshots[1].appState.members[secondMemberIndex]).reverse(),
  )
  const localMember = { id: 'local-member', realName: 'ローカル共通', active: true }
  const assembled = createCloudWorkspaceState({
    ...createEmptyState(),
    members: [localMember],
  }, snapshots)

  assert.equal(assembled.ok, true)
  if (!assembled.ok) return
  assert.deepEqual(
    assembled.state.events.map(event => event.id),
    snapshots.map(snapshot => snapshot.appState.events[0].id),
  )
  assert.ok(assembled.state.members.some(member => member.id === localMember.id))
  assert.equal(
    assembled.state.members.filter(member => member.id === sharedMember.id).length,
    1,
  )
  assert.ok(assembled.state.members.some(member => member.id === firstOnlyMember.id))
  assert.ok(assembled.state.bands.some(band => band.id === firstOnlyBand.id))
  assert.equal(assembled.state.version, CURRENT_STORAGE_VERSION)
})

test('Event snapshotの参照masterは同IDのlocal cacheより優先して復元する', () => {
  const state = createDemoData()
  const snapshot = createSnapshot(state, state.events[0].id)
  const referencedMember = snapshot.appState.members[0]
  assert.ok(referencedMember)
  const assembled = createCloudWorkspaceState({
    ...createEmptyState(),
    members: [{ ...referencedMember, realName: '古いcache名' }],
  }, [snapshot])
  assert.equal(assembled.ok, true)
  if (!assembled.ok) return
  assert.equal(
    assembled.state.members.find(member => member.id === referencedMember.id)?.realName,
    referencedMember.realName,
  )
})

test('異なるshared Member snapshotは取得順・updatedAtに関係なくhydrateを拒否する', async () => {
  const state = createDemoData()
  const first = createSnapshot(state, state.events[0].id)
  const second = structuredClone(createSnapshot(state, state.events[1].id))
  const sharedMemberId = first.appState.members.find(member =>
    second.appState.members.some(candidate => candidate.id === member.id))?.id
  assert.ok(sharedMemberId)
  second.appState.members.find(member => member.id === sharedMemberId).realName = '矛盾した名前'
  const timestamps = ['2026-10-07T00:00:02.000Z', '2026-10-07T00:00:01.000Z']
  const reverseTimestamps = [...timestamps].reverse()
  const staleCache = structuredClone(state)
  staleCache.events[0].name = 'fallback表示してはいけないcache'
  const before = structuredClone(staleCache)
  const results = await Promise.all([
    loadSnapshotsInOrder([first, second], [0, 1], timestamps, staleCache),
    loadSnapshotsInOrder([first, second], [1, 0], timestamps),
    loadSnapshotsInOrder([first, second], [0, 1], reverseTimestamps),
  ])

  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, 'SHARED_MASTER_CONFLICT')
  }
  assert.deepEqual(staleCache, before)
})

test('異なるshared Band snapshotは取得順に関係なくhydrateを拒否する', () => {
  const state = createDemoData()
  const first = createSnapshot(state, state.events[0].id)
  const second = structuredClone(createSnapshot(state, state.events[1].id))
  const sharedBandId = first.appState.bands.find(band =>
    second.appState.bands.some(candidate => candidate.id === band.id))?.id
  assert.ok(sharedBandId)
  second.appState.bands.find(band => band.id === sharedBandId).name = '矛盾したバンド名'

  for (const snapshots of [[first, second], [second, first]]) {
    assert.deepEqual(createCloudWorkspaceState(createEmptyState(), snapshots), {
      ok: false,
      reason: 'SHARED_MASTER_CONFLICT',
    })
  }
})

test('異なるEvent snapshot間のduplicate IDをfail closedする', () => {
  const state = createDemoData()
  const first = createSnapshot(state, state.events[0].id)
  const second = createSnapshot(state, state.events[1].id)
  assert.ok(first.appState.eventDays[0])
  assert.ok(second.appState.eventDays[0])
  second.appState.eventDays[0].id = first.appState.eventDays[0].id
  assert.deepEqual(createCloudWorkspaceState(createEmptyState(), [first, second]), {
    ok: false,
    reason: 'INVALID_SNAPSHOT',
  })
})

test('repositoryでWorkspace Eventを作成・一覧・取得・更新・削除できる', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const state = createDemoData()
  const eventId = state.events[0].id
  const initial = createSnapshot(state, eventId)

  const saved = await repository.saveEvent('workspace-a', initial)
  assert.equal(saved.ok, true)
  if (!saved.ok) return
  assert.equal(saved.value.revision, 1)

  const listed = await repository.listEvents('workspace-a')
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.ok && listed.value.map(event => event.eventId), [eventId])

  const loaded = await repository.loadEvent('workspace-a', eventId)
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.ok && loaded.value.snapshot, initial)

  const updatedState = structuredClone(state)
  updatedState.events[0].name = '更新済みEvent'
  const updated = await repository.saveEvent(
    'workspace-a',
    createSnapshot(updatedState, eventId),
  )
  assert.equal(updated.ok, true)
  assert.equal(updated.ok && updated.value.revision, 2)
  assert.equal(updated.ok && updated.value.eventName, '更新済みEvent')

  const deleted = await repository.deleteEvent('workspace-a', eventId)
  assert.equal(deleted.ok, true)
  assert.equal((await repository.loadEvent('workspace-a', eventId)).ok, false)
})

test('repositoryはWorkspaceを明示的にscopeし越境accessを拒否する', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repositoryA = createCloudEventRepository(gateway)
  const state = createDemoData()
  const snapshot = createSnapshot(state, state.events[0].id)
  assert.equal((await repositoryA.saveEvent('workspace-a', snapshot)).ok, true)

  const repositoryB = createCloudEventRepository({
    ...gateway,
    getWorkspaceRole: gateway.getWorkspaceRole.bind(gateway),
    listRows: gateway.listRows.bind(gateway),
    loadRow: gateway.loadRow.bind(gateway),
    saveRow: gateway.saveRow.bind(gateway),
    deleteRow: gateway.deleteRow.bind(gateway),
  })
  gateway.allowedWorkspaces = new Set(['workspace-b'])

  const savedInB = await repositoryB.saveEvent('workspace-b', snapshot)
  assert.equal(savedInB.ok, true)
  assert.ok(gateway.rows.has(`workspace-a:${state.events[0].id}`))
  assert.ok(gateway.rows.has(`workspace-b:${state.events[0].id}`))

  const attempts = await Promise.all([
    repositoryB.loadEvent('workspace-a', state.events[0].id),
    repositoryB.saveEvent('workspace-a', snapshot),
    repositoryB.deleteEvent('workspace-a', state.events[0].id),
  ])
  assert.ok(attempts.every(result => !result.ok && result.error.code === 'ACCESS_DENIED'))
  const listB = await repositoryB.listEvents('workspace-b')
  assert.equal(listB.ok, true)
  assert.deepEqual(listB.ok && listB.value.map(event => ({
    workspaceId: event.workspaceId,
    eventId: event.eventId,
  })), [{ workspaceId: 'workspace-b', eventId: state.events[0].id }])
  assert.ok(gateway.rows.has(`workspace-a:${state.events[0].id}`))
})

test('repositoryはDB responseのinvalid snapshotとscope mismatchを拒否する', async () => {
  const repository = createCloudEventRepository({
    async getWorkspaceRole() {
      return { data: { role: 'editor' }, error: null }
    },
    async listRows() {
      return { data: [{ workspace_id: 'workspace-b' }], error: null }
    },
    async loadRow() {
      return { data: { workspace_id: 'workspace-a', event_id: 'event-a' }, error: null }
    },
    async saveRow() {
      return { data: null, error: null }
    },
    async deleteRow() {
      return { data: null, error: null }
    },
  })
  assert.equal((await repository.listEvents('workspace-a')).ok, false)
  const loaded = await repository.loadEvent('workspace-a', 'event-a')
  assert.equal(loaded.ok, false)
  assert.equal(!loaded.ok && loaded.error.code, 'INVALID_SNAPSHOT')
  const malformedSave = await repository.saveEvent('workspace-a', null)
  assert.equal(malformedSave.ok, false)
  assert.equal(!malformedSave.ok && malformedSave.error.code, 'INVALID_SNAPSHOT')
})

test('viewerはCloud Eventを参照できるが保存・削除はrepository境界でも拒否する', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  gateway.getWorkspaceRole = async () => ({ data: { role: 'viewer' }, error: null })
  const repository = createCloudEventRepository(gateway)
  const snapshot = createSnapshot(createDemoData(), 'event-demo-main')

  assert.deepEqual(await repository.listEvents('workspace-a'), {
    ok: true,
    value: [],
  })
  const saved = await repository.saveEvent('workspace-a', snapshot)
  const deleted = await repository.deleteEvent('workspace-a', 'event-demo-main')
  assert.equal(saved.ok, false)
  assert.equal(!saved.ok && saved.error.code, 'ACCESS_DENIED')
  assert.equal(deleted.ok, false)
  assert.equal(!deleted.ok && deleted.error.code, 'ACCESS_DENIED')
})

test('Workspace loadはCloud一覧を取得して全EventをV5 domain stateへrehydrateする', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a', 'workspace-b'])
  const repository = createCloudEventRepository(gateway)
  const state = createDemoData()
  const eventA = state.events[0]
  const eventB = state.events[1]
  await saveCloudEventFromState(repository, 'workspace-a', state, eventA.id)
  await saveCloudEventFromState(repository, 'workspace-b', state, eventB.id)

  const loadedA = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    createEmptyState(),
  )
  const loadedB = await loadCloudWorkspaceEvents(
    repository,
    'workspace-b',
    createEmptyState(),
  )
  assert.equal(loadedA.ok, true)
  assert.equal(loadedB.ok, true)
  assert.deepEqual(loadedA.ok && loadedA.value.state.events.map(event => event.id), [eventA.id])
  assert.deepEqual(loadedB.ok && loadedB.value.state.events.map(event => event.id), [eventB.id])
})

test('Cloud hydrateは同scopeの未保存local Event cacheよりCloud snapshotを優先する', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const cloudState = createDemoData()
  const event = cloudState.events[0]
  await saveCloudEventFromState(repository, 'workspace-a', cloudState, event.id)
  const staleCache = structuredClone(cloudState)
  staleCache.events.find(candidate => candidate.id === event.id).name = 'Cloud未保存のcache編集'

  const loaded = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    staleCache,
  )
  assert.equal(loaded.ok, true)
  assert.equal(
    loaded.ok && loaded.value.state.events.find(candidate => candidate.id === event.id)?.name,
    event.name,
  )
})

test('Workspace AからBへ再読込するとAのEvent collectionを残さない', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a', 'workspace-b'])
  const repository = createCloudEventRepository(gateway)
  const state = createDemoData()
  const eventA = state.events[0]
  const eventB = state.events[1]
  await saveCloudEventFromState(repository, 'workspace-a', state, eventA.id)
  await saveCloudEventFromState(repository, 'workspace-b', state, eventB.id)

  const loadedA = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    createEmptyState(),
  )
  assert.equal(loadedA.ok, true)
  if (!loadedA.ok) return
  const loadedB = await loadCloudWorkspaceEvents(
    repository,
    'workspace-b',
    loadedA.value.state,
  )
  assert.equal(loadedB.ok, true)
  if (!loadedB.ok) return
  assert.deepEqual(loadedB.value.state.events.map(event => event.id), [eventB.id])
  assert.ok(!loadedB.value.state.eventDays.some(day => day.eventId === eventA.id))
  assert.ok(!loadedB.value.state.eventBands.some(band => band.eventId === eventA.id))

  const loadedAgainA = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    loadedB.value.state,
  )
  assert.equal(loadedAgainA.ok, true)
  assert.deepEqual(
    loadedAgainA.ok && loadedAgainA.value.state.events.map(event => event.id),
    [eventA.id],
  )
})

test('Cloud local cacheはrequested scopeのrehydrate完了後だけ書き込み可能になる', () => {
  const base = {
    cloudEnabled: true,
    persistenceScopeReady: true,
    requestedScopeKey: 'scope-b',
  }
  assert.equal(isCloudEventCacheWriteReady({
    ...base,
    hydration: { scopeKey: 'scope-a', kind: 'ready' },
  }), false)
  assert.equal(isCloudEventCacheWriteReady({
    ...base,
    hydration: { scopeKey: 'scope-b', kind: 'loading' },
  }), false)
  assert.equal(isCloudEventCacheWriteReady({
    ...base,
    hydration: { scopeKey: 'scope-b', kind: 'error', message: 'failed' },
  }), false)
  assert.equal(isCloudEventCacheWriteReady({
    ...base,
    hydration: { scopeKey: 'scope-b', kind: 'ready' },
  }), true)
  assert.equal(isCloudEventCacheWriteReady({
    ...base,
    cloudEnabled: false,
    hydration: { scopeKey: 'other', kind: 'loading' },
  }), true)
})

test('Cloud load失敗はbase stateを変更せず別Event stateを返さない', async () => {
  const base = createDemoData()
  const before = structuredClone(base)
  const repository = createCloudEventRepository({
    async getWorkspaceRole() {
      return { data: { role: 'editor' }, error: null }
    },
    async listRows() {
      return { data: null, error: { code: 'NETWORK' } }
    },
    async loadRow() {
      throw new Error('not called')
    },
    async saveRow() {
      throw new Error('not called')
    },
    async deleteRow() {
      throw new Error('not called')
    },
  })
  const result = await loadCloudWorkspaceEvents(repository, 'workspace-a', base)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'SUPABASE_ERROR')
  assert.deepEqual(base, before)
})

test('Cloud Event migrationはWorkspace ownership・RLS・revision・移管防止を定義する', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261007120000_cloud_event_persistence.sql',
    import.meta.url,
  ), 'utf8')

  assert.match(sql, /create table public\.cloud_events/i)
  assert.match(sql, /workspace_id uuid not null references public\.workspaces\(id\)/i)
  assert.match(sql, /primary key \(workspace_id, event_id\)/i)
  assert.match(sql, /event_snapshot jsonb not null/i)
  assert.match(sql, /revision bigint not null default 1/i)
  assert.match(sql, /event_snapshot ->> 'format' is not distinct from 'acappella-tt-cloud-event'/i)
  assert.match(sql, /event_snapshot #>> '\{appState,events,0,id\}' is not distinct from event_id/i)
  assert.match(sql, /alter table public\.cloud_events enable row level security/i)
  assert.match(sql, /for select to authenticated[\s\S]*workspace_members\.user_id = \(select auth\.uid\(\)\)/i)
  assert.match(sql, /for insert to authenticated[\s\S]*role in \('owner', 'editor'\)/i)
  assert.match(sql, /for update to authenticated[\s\S]*with check/i)
  assert.match(sql, /for delete to authenticated/i)
  assert.match(sql, /before insert on public\.cloud_events/i)
  assert.match(sql, /new\.revision = 1/i)
  assert.match(sql, /new\.workspace_id is distinct from old\.workspace_id/i)
  assert.match(sql, /new\.event_id is distinct from old\.event_id/i)
  assert.match(sql, /new\.created_at = old\.created_at/i)
  assert.match(sql, /new\.revision = old\.revision \+ 1/i)
})
