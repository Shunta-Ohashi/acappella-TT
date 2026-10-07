import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import {
  createCloudEventRepository,
} from '../src/cloud/cloudEventRepository.ts'
import {
  createCloudEventOperationRegistry,
  deleteCloudEvent,
  getCloudEventOperation,
  isCloudEventCacheWriteReady,
  loadCloudWorkspaceEvents,
  runExclusiveCloudEventDelete,
  runExclusiveCloudEventDeletion,
  runExclusiveCloudEventSave,
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

const createDeferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class MemoryCloudEventGateway {
  rows = new Map()
  allowedWorkspaces = new Set()
  clock = 0
  accessCalls = 0
  saveCalls = 0
  deleteCalls = 0

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
    this.accessCalls += 1
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
    this.saveCalls += 1
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
    this.deleteCalls += 1
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

const createSnapshotContainingEveryEventOwnedCollection = () => {
  const state = createDemoData()
  const eventId = 'event-demo-generation'
  const eventDay = state.eventDays.find(day => day.eventId === eventId)
  const stage = state.stages.find(candidate => candidate.eventDayId === eventDay?.id)
  const eventBands = state.eventBands.filter(band =>
    band.eventId === eventId && band.eventDayId === eventDay?.id)
  assert.ok(eventDay)
  assert.ok(stage)
  assert.ok(eventBands.length >= 2)
  state.timetableOrderConstraints.push({
    id: 'constraint-cloud-duplicate-test',
    eventId,
    eventDayId: eventDay.id,
    stageId: stage.id,
    eventBandIds: eventBands.slice(0, 2).map(band => band.id),
  })
  return { state, eventId, snapshot: createSnapshot(state, eventId) }
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

test('全Event配下collectionの同一ID重複をbuilderとparserでfail closedする', () => {
  const collectionKeys = [
    'events', 'eventDays', 'stages', 'sections', 'eventMembers',
    'eventMemberDays', 'eventBands', 'scheduleItems', 'paAssignments',
    'dutyTypes', 'dutyAssignments', 'timetableLocks',
    'timetableOrderConstraints',
  ]
  const { state, eventId, snapshot } = createSnapshotContainingEveryEventOwnedCollection()

  for (const key of collectionKeys) {
    const source = snapshot.appState[key][0]
    assert.ok(source, `${key} fixture must not be empty`)

    for (const duplicate of [
      structuredClone(source),
      { ...structuredClone(source), duplicateVariant: 'different-content' },
    ]) {
      const malformedSnapshot = structuredClone(snapshot)
      malformedSnapshot.appState[key].push(duplicate)
      assert.equal(
        parseCloudEventSnapshot(malformedSnapshot),
        undefined,
        `${key} parser duplicate`,
      )

      const malformedState = structuredClone(state)
      const stateSource = malformedState[key].find(item => item.id === source.id)
      assert.ok(stateSource, `${key} builder source`)
      malformedState[key].push({ ...stateSource, ...duplicate })
      assert.equal(
        createCloudEventSnapshot(malformedState, eventId).ok,
        false,
        `${key} builder duplicate`,
      )
    }
  }
})

test('repositoryはEvent配下collection重複snapshotをDBアクセス前に拒否する', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const { snapshot } = createSnapshotContainingEveryEventOwnedCollection()
  snapshot.appState.scheduleItems.push(
    structuredClone(snapshot.appState.scheduleItems[0]),
  )

  const result = await repository.saveEvent('workspace-a', snapshot)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'INVALID_SNAPSHOT')
  assert.equal(gateway.accessCalls, 0)
  assert.equal(gateway.saveCalls, 0)
})

test('Cloud Event snapshotは直接参照するMemberとBandを欠落なく要求する', () => {
  const state = createDemoData()
  const snapshot = createSnapshot(state, state.events[0].id)
  const eventMember = snapshot.appState.eventMembers[0]
  const eventBand = snapshot.appState.eventBands.find(candidate => candidate.bandId)
  assert.ok(eventMember)
  assert.ok(eventBand?.bandId)
  assert.ok(snapshot.appState.members.some(member => member.id === eventMember.memberId))
  assert.ok(snapshot.appState.bands.some(band => band.id === eventBand.bandId))
  assert.ok(parseCloudEventSnapshot(snapshot))

  const missingMember = structuredClone(snapshot)
  missingMember.appState.members = missingMember.appState.members.filter(
    member => member.id !== eventMember.memberId,
  )
  assert.equal(parseCloudEventSnapshot(missingMember), undefined)

  const missingBand = structuredClone(snapshot)
  missingBand.appState.bands = missingBand.appState.bands.filter(
    band => band.id !== eventBand.bandId,
  )
  assert.equal(parseCloudEventSnapshot(missingBand), undefined)
})

test('snapshot builderはBandからtransitiveに参照するMemberまでclosureへ含める', () => {
  const state = structuredClone(createDemoData())
  const eventId = state.events[0].id
  const eventBand = state.eventBands.find(candidate =>
    candidate.eventId === eventId && candidate.bandId)
  const band = state.bands.find(candidate => candidate.id === eventBand?.bandId)
  assert.ok(band)
  const transitiveMember = {
    id: 'member-cloud-transitive',
    realName: 'Cloud Closure Member',
    active: true,
  }
  state.members.push(transitiveMember)
  band.defaultMemberIds.push(transitiveMember.id)

  const created = createCloudEventSnapshot(state, eventId)
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.ok(created.snapshot.appState.members.some(
    member => member.id === transitiveMember.id,
  ))
  assert.ok(parseCloudEventSnapshot(created.snapshot))

  const missingTransitiveMember = structuredClone(created.snapshot)
  missingTransitiveMember.appState.members = missingTransitiveMember.appState.members.filter(
    member => member.id !== transitiveMember.id,
  )
  assert.equal(parseCloudEventSnapshot(missingTransitiveMember), undefined)
})

test('snapshotは不要なMember/Bandも従来どおりrejectする', () => {
  const snapshot = createSnapshot(createDemoData(), 'event-demo-main')
  const withExtraMember = structuredClone(snapshot)
  withExtraMember.appState.members.push({
    id: 'unused-member',
    realName: 'Unused Member',
    active: true,
  })
  assert.equal(parseCloudEventSnapshot(withExtraMember), undefined)

  const withExtraBand = structuredClone(snapshot)
  withExtraBand.appState.bands.push({
    id: 'unused-band',
    name: 'Unused Band',
    defaultMemberIds: [],
    active: true,
  })
  assert.equal(parseCloudEventSnapshot(withExtraBand), undefined)
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

test('server commit後のsave応答失敗でもCloud deleteを必ず試行してrowを削除する', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const committedSaveRow = gateway.saveRow.bind(gateway)
  gateway.saveRow = async input => {
    await committedSaveRow(input)
    return { data: null, error: { code: 'NETWORK' } }
  }
  const repository = createCloudEventRepository(gateway)
  const state = createDemoData()
  const eventId = state.events[0].id
  const saved = await saveCloudEventFromState(
    repository,
    'workspace-a',
    state,
    eventId,
  )
  assert.equal(saved.ok, false)
  assert.ok(gateway.rows.has(`workspace-a:${eventId}`))

  const deleted = await deleteCloudEvent(repository, 'workspace-a', eventId)
  assert.deepEqual(deleted, { ok: true, value: { deleted: true } })
  assert.equal(gateway.deleteCalls, 1)
  assert.equal(gateway.rows.has(`workspace-a:${eventId}`), false)
})

test('Cloud deleteはrow不存在だけをidempotent successとして扱う', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const missing = await deleteCloudEvent(repository, 'workspace-a', 'missing-event')
  assert.deepEqual(missing, { ok: true, value: { deleted: false } })
  assert.equal(gateway.deleteCalls, 1)

  gateway.deleteRow = async () => ({
    data: null,
    error: { code: 'NETWORK' },
  })
  const failed = await deleteCloudEvent(repository, 'workspace-a', 'event-a')
  assert.equal(failed.ok, false)
  assert.equal(!failed.ok && failed.error.code, 'SUPABASE_ERROR')

  gateway.getWorkspaceRole = async () => ({
    data: { role: 'viewer' },
    error: null,
  })
  const denied = await deleteCloudEvent(repository, 'workspace-a', 'event-a')
  assert.equal(denied.ok, false)
  assert.equal(!denied.ok && denied.error.code, 'ACCESS_DENIED')
})

test('blank Event ID/nameはCloud DB access前にINVALID_SNAPSHOTとなる', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const validSnapshot = createSnapshot(createDemoData(), 'event-demo-main')
  const invalidSnapshots = [
    ['id', ''],
    ['id', '   '],
    ['name', ''],
    ['name', '   '],
  ].map(([field, value]) => {
    const snapshot = structuredClone(validSnapshot)
    snapshot.appState.events[0][field] = value
    return snapshot
  })

  for (const snapshot of invalidSnapshots) {
    assert.equal(parseCloudEventSnapshot(snapshot), undefined)
    const result = await repository.saveEvent('workspace-a', snapshot)
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, 'INVALID_SNAPSHOT')
  }
  assert.equal(gateway.accessCalls, 0)
  assert.equal(gateway.saveCalls, 0)

  const valid = await repository.saveEvent('workspace-a', validSnapshot)
  assert.equal(valid.ok, true)
  assert.equal(gateway.accessCalls, 1)
  assert.equal(gateway.saveCalls, 1)
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

test('Cloud未保存の新規Eventはreload相当のhydrateで正式Eventとして復元しない', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const localCacheWithUnsavedEvents = createDemoData()
  const loaded = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    localCacheWithUnsavedEvents,
  )

  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.ok && loaded.value.state.events, [])
})

test('Event作成はCloudへ自動保存せず明示保存操作だけがsaveを開始する', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const createHandler = appSource.slice(
    appSource.indexOf('const handleCreateEvent'),
    appSource.indexOf('const getEventDeletionInput'),
  )
  const explicitSaveHandler = appSource.slice(
    appSource.indexOf('const handleSaveSelectedEventToCloud'),
    appSource.indexOf('const blockUnsavedOperationsNavigation'),
  )
  const deleteHandler = appSource.slice(
    appSource.indexOf('const handleDeleteEvent'),
    appSource.indexOf('const handleSaveEventBasicInfo'),
  )

  assert.doesNotMatch(createHandler, /persistEventToCloud|saveCloudEventFromState/)
  assert.match(explicitSaveHandler, /persistEventToCloud\(domainState, selectedEvent\.id\)/)
  assert.match(explicitSaveHandler, /eventBasicInfoRef\.current\?\.hasUnsavedChanges\(\)/)
  assert.match(deleteHandler, /runExclusiveCloudEventDeletion\(/)
  assert.match(deleteHandler, /latestDomainStateRef\.current/)
  assert.match(
    deleteHandler,
    /getLatestState: \(\) => latestDomainStateRef\.current,[\s\S]*commit: commitEventDeletion/,
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

test('Event別の並行操作は一方の完了で他方の占有を解除しない', async () => {
  const registry = createCloudEventOperationRegistry()
  const eventA = createDeferred()
  const eventB = createDeferred()
  let visibleOperations = new Map()
  const onChange = operations => {
    visibleOperations = new Map(operations)
  }

  const savingA = runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-a',
    operation: () => eventA.promise,
    onChange,
  })
  const savingB = runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-b',
    operation: () => eventB.promise,
    onChange,
  })

  assert.equal(getCloudEventOperation(
    visibleOperations, 'scope-a', 'event-a'), 'save')
  assert.equal(getCloudEventOperation(
    visibleOperations, 'scope-a', 'event-b'), 'save')

  eventB.resolve('saved-b')
  assert.deepEqual(await savingB, { started: true, value: 'saved-b' })
  assert.equal(registry.get('scope-a', 'event-a'), 'save')
  assert.equal(registry.get('scope-a', 'event-b'), undefined)

  eventA.resolve('saved-a')
  assert.deepEqual(await savingA, { started: true, value: 'saved-a' })
  assert.equal(registry.get('scope-a', 'event-a'), undefined)
})

test('A/B save中にAだけ完了してもBのsaving状態を維持する', async () => {
  const registry = createCloudEventOperationRegistry()
  const eventA = createDeferred()
  const eventB = createDeferred()
  const savingA = runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-a',
    operation: () => eventA.promise,
  })
  const savingB = runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-b',
    operation: () => eventB.promise,
  })

  eventA.resolve('saved-a')
  await savingA
  assert.equal(registry.get('scope-a', 'event-a'), undefined)
  assert.equal(registry.get('scope-a', 'event-b'), 'save')

  eventB.resolve('saved-b')
  await savingB
  assert.equal(registry.get('scope-a', 'event-b'), undefined)
})

test('同一Eventの重複saveを開始せずfailureでも必ずregistryを解除する', async () => {
  const registry = createCloudEventOperationRegistry()
  const deferred = createDeferred()
  let duplicateRequestCount = 0
  const first = runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-a',
    operation: () => deferred.promise,
  })
  const duplicate = await runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-a',
    operation: async () => {
      duplicateRequestCount += 1
      return 'duplicate'
    },
  })

  assert.deepEqual(duplicate, { started: false })
  assert.equal(duplicateRequestCount, 0)
  assert.equal(registry.get('scope-a', 'event-a'), 'save')

  deferred.reject(new Error('save failed'))
  await assert.rejects(first, /save failed/)
  assert.equal(registry.get('scope-a', 'event-a'), undefined)
})

test('save/deleteは同じEventで両方向に排他し、別Event・別scopeをblockしない', async () => {
  for (const firstKind of ['save', 'delete']) {
    const registry = createCloudEventOperationRegistry()
    const pending = createDeferred()
    const runFirst = firstKind === 'save'
      ? runExclusiveCloudEventSave
      : runExclusiveCloudEventDelete
    const first = runFirst({
      registry,
      scopeKey: 'scope-a',
      eventId: 'event-a',
      operation: () => pending.promise,
    })
    let sameEventCalls = 0
    const blockedSave = await runExclusiveCloudEventSave({
      registry,
      scopeKey: 'scope-a',
      eventId: 'event-a',
      operation: async () => { sameEventCalls += 1 },
    })
    const blockedDelete = await runExclusiveCloudEventDelete({
      registry,
      scopeKey: 'scope-a',
      eventId: 'event-a',
      operation: async () => { sameEventCalls += 1 },
    })
    assert.deepEqual(blockedSave, { started: false })
    assert.deepEqual(blockedDelete, { started: false })
    assert.equal(sameEventCalls, 0)

    assert.equal((await runExclusiveCloudEventDelete({
      registry,
      scopeKey: 'scope-a',
      eventId: 'event-b',
      operation: async () => 'deleted-b',
    })).started, true)
    assert.equal((await runExclusiveCloudEventSave({
      registry,
      scopeKey: 'scope-b',
      eventId: 'event-a',
      operation: async () => 'saved-other-scope',
    })).started, true)

    pending.resolve('completed')
    await first
    assert.equal(registry.get('scope-a', 'event-a'), undefined)
  }
})

test('operation leaseはsuccess・failure result・throwで解除され再試行できる', async () => {
  const registry = createCloudEventOperationRegistry()
  for (const operation of [
    async () => ({ ok: true }),
    async () => ({ ok: false, error: 'NOT_FOUND' }),
  ]) {
    const result = await runExclusiveCloudEventDelete({
      registry,
      scopeKey: 'scope-a',
      eventId: 'event-a',
      operation,
    })
    assert.equal(result.started, true)
    assert.equal(registry.get('scope-a', 'event-a'), undefined)
  }
  await assert.rejects(runExclusiveCloudEventDelete({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-a',
    operation: async () => { throw new Error('network') },
  }), /network/)
  assert.equal(registry.get('scope-a', 'event-a'), undefined)
  assert.equal((await runExclusiveCloudEventDelete({
    registry,
    scopeKey: 'scope-a',
    eventId: 'event-a',
    operation: async () => 'retry succeeded',
  })).started, true)
})

test('token付きleaseは古いcleanupで新しい占有や別scopeを解除しない', () => {
  const registry = createCloudEventOperationRegistry()
  const oldLease = registry.tryStart('scope-a', 'event-a', 'delete')
  assert.ok(oldLease)
  registry.finish(oldLease)
  const currentLease = registry.tryStart('scope-a', 'event-a', 'save')
  const otherScopeLease = registry.tryStart('scope-b', 'event-a', 'delete')
  assert.ok(currentLease)
  assert.ok(otherScopeLease)

  registry.finish(oldLease)
  assert.equal(registry.get('scope-a', 'event-a'), 'save')
  assert.equal(registry.get('scope-b', 'event-a'), 'delete')
  registry.finish(currentLease)
  assert.equal(registry.get('scope-b', 'event-a'), 'delete')
  registry.finish(otherScopeLease)
})

test('App利用delete経路は待機中saveを防ぎ、最新stateへcascadeして別Event更新を保持する', async () => {
  const registry = createCloudEventOperationRegistry()
  const deferredDelete = createDeferred()
  const initialState = createDemoData()
  const deletedEventId = initialState.events[0].id
  const retainedEventId = initialState.events[1].id
  let latestState = structuredClone(initialState)
  let saveCalls = 0
  const deletion = runExclusiveCloudEventDeletion({
    registry,
    scopeKey: 'scope-a',
    workspaceId: 'workspace-a',
    eventId: deletedEventId,
    repository: {
      async deleteEvent() { return deferredDelete.promise },
    },
    isScopeCurrent: () => true,
    getLatestState: () => latestState,
    commit: result => {
      latestState = {
        members: latestState.members,
        bands: latestState.bands,
        ...result,
      }
    },
  })
  assert.equal(registry.get('scope-a', deletedEventId), 'delete')

  const saveDuringDelete = await runExclusiveCloudEventSave({
    registry,
    scopeKey: 'scope-a',
    eventId: deletedEventId,
    operation: async () => { saveCalls += 1 },
  })
  assert.deepEqual(saveDuringDelete, { started: false })
  assert.equal(saveCalls, 0)

  latestState = {
    ...latestState,
    events: latestState.events.map(event => event.id === retainedEventId
      ? { ...event, name: 'DELETE待機中に更新したEvent B' }
      : event),
  }
  deferredDelete.resolve({ ok: true, value: { eventId: deletedEventId } })
  const completed = await deletion
  assert.equal(completed.started, true)
  assert.equal(completed.started && completed.value.ok, true)
  assert.equal(latestState.events.some(event => event.id === deletedEventId), false)
  assert.equal(
    latestState.events.find(event => event.id === retainedEventId)?.name,
    'DELETE待機中に更新したEvent B',
  )
  assert.equal(registry.get('scope-a', deletedEventId), undefined)
  assert.equal(latestState.events.some(event => event.id === deletedEventId), false)
})

test('scope切替後の遅延delete結果はcommitせず別scopeの占有も解除しない', async () => {
  const registry = createCloudEventOperationRegistry()
  const deferredDelete = createDeferred()
  const state = createDemoData()
  const eventId = state.events[0].id
  let activeScope = 'scope-a'
  let commitCalls = 0
  const deletion = runExclusiveCloudEventDeletion({
    registry,
    scopeKey: 'scope-a',
    workspaceId: 'workspace-a',
    eventId,
    repository: {
      async deleteEvent() { return deferredDelete.promise },
    },
    isScopeCurrent: () => activeScope === 'scope-a',
    getLatestState: () => state,
    commit: () => { commitCalls += 1 },
  })
  activeScope = 'scope-b'
  const scopeBLease = registry.tryStart('scope-b', eventId, 'save')
  assert.ok(scopeBLease)
  deferredDelete.resolve({ ok: true, value: { eventId } })

  const completed = await deletion
  assert.deepEqual(completed, {
    started: true,
    value: { ok: false, reason: 'CLOUD_DELETE_FAILED' },
  })
  assert.equal(commitCalls, 0)
  assert.equal(registry.get('scope-a', eventId), undefined)
  assert.equal(registry.get('scope-b', eventId), 'save')
  registry.finish(scopeBLease)
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
  assert.match(sql, /event_id text not null check \(btrim\(event_id\) <> ''\)/i)
  assert.match(sql, /event_name text not null check \(btrim\(event_name\) <> ''\)/i)
  assert.match(sql, /primary key \(workspace_id, event_id\)/i)
  assert.match(sql, /event_snapshot jsonb not null/i)
  assert.match(sql, /revision bigint not null default 1/i)
  assert.match(sql, /\(event_snapshot -> 'format'\) is not distinct from\s+to_jsonb\('acappella-tt-cloud-event'::text\)/i)
  assert.match(sql, /\(event_snapshot -> 'version'\) is not distinct from '1'::jsonb/i)
  assert.match(sql, /\(event_snapshot #> '\{appState,version\}'\) is not distinct from '5'::jsonb/i)
  assert.match(sql, /jsonb_typeof\(event_snapshot -> 'appState'\) = 'object'/i)
  assert.match(sql, /case\s+when jsonb_typeof\(event_snapshot #> '\{appState,events\}'\) = 'array'/i)
  assert.match(sql, /jsonb_array_length\(event_snapshot #> '\{appState,events\}'\) = 1/i)
  assert.match(sql, /jsonb_typeof\(event_snapshot #> '\{appState,events,0\}'\) = 'object'/i)
  assert.match(sql, /jsonb_typeof\(event_snapshot #> '\{appState,events,0,id\}'\) = 'string'/i)
  assert.match(sql, /\(event_snapshot #> '\{appState,events,0,id\}'\) is not distinct from\s+to_jsonb\(event_id\)/i)
  assert.match(sql, /jsonb_typeof\(event_snapshot #> '\{appState,events,0,name\}'\) = 'string'/i)
  assert.match(sql, /\(event_snapshot #> '\{appState,events,0,name\}'\) is not distinct from\s+to_jsonb\(event_name\)/i)
  assert.match(sql, /else false\s+end\s+\) is true/i)
  assert.doesNotMatch(sql, /event_snapshot\s*->>\s*'version'/i)
  assert.doesNotMatch(sql, /event_snapshot\s*#>>\s*'\{appState,version\}'/i)
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
