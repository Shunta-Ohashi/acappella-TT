import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import {
  CURRENT_STORAGE_VERSION,
  STORAGE_KEY,
  clearPersistedState,
  createPersistedAppState,
  isPersistedAppStateV1,
  loadPersistedState,
  loadPersistedStateOrFallback,
  parsePersistedState,
  savePersistedState,
  serializePersistedState,
} from '../src/persistence/localPersistence.ts'

class MemoryStorage {
  values = new Map()

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.values.set(key, value)
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

const createEmptyState = () => ({
  members: [],
  bands: [],
  events: [],
  eventDays: [],
  stages: [],
  sections: [],
  eventMembers: [],
  eventMemberDays: [],
  eventBands: [],
  scheduleItems: [],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
})

test('主要domain collectionをversion付き単一snapshotでround-tripする', () => {
  const demo = createDemoData()
  const serialized = serializePersistedState(demo)
  const parsed = parsePersistedState(serialized)

  assert.ok(parsed)
  assert.equal(parsed.version, CURRENT_STORAGE_VERSION)
  assert.deepEqual(parsed, createPersistedAppState(demo))
})

test('ScheduleBoundaryを含む全IDをround-trip後も維持する', () => {
  const demo = createDemoData()
  const parsed = parsePersistedState(serializePersistedState(demo))

  assert.ok(parsed)
  assert.deepEqual(
    parsed.scheduleItems.map((item) => item.id),
    demo.scheduleItems.map((item) => item.id),
  )
  assert.deepEqual(parsed.paAssignments, demo.paAssignments)
  assert.deepEqual(parsed.dutyAssignments, demo.dutyAssignments)
})

test('version 1だけを受理し未知versionを拒否する', () => {
  const valid = createPersistedAppState(createEmptyState())

  assert.equal(isPersistedAppStateV1(valid), true)
  assert.equal(parsePersistedState(JSON.stringify(valid))?.version, 1)
  assert.equal(parsePersistedState(JSON.stringify({ ...valid, version: 2 })), undefined)
})

test('壊れたJSONを例外なく拒否しstorage entryを削除する', () => {
  const storage = new MemoryStorage()
  storage.setItem(STORAGE_KEY, '{broken json')

  assert.doesNotThrow(() => loadPersistedState(storage))
  assert.equal(loadPersistedState(storage), undefined)
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('必須collection不足とtop-level不正を拒否する', () => {
  assert.equal(parsePersistedState(JSON.stringify({ version: 1 })), undefined)
  assert.equal(parsePersistedState(JSON.stringify([])), undefined)
  assert.equal(parsePersistedState(JSON.stringify(null)), undefined)
  assert.equal(parsePersistedState(JSON.stringify({
    ...createPersistedAppState(createEmptyState()),
    members: {},
  })), undefined)
})

test('全collectionが空でも有効な保存状態として復元する', () => {
  const storage = new MemoryStorage()
  const emptyState = createEmptyState()

  assert.equal(savePersistedState(emptyState, storage), true)
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, storage),
    createPersistedAppState(emptyState),
  )
})

test('broken referenceをcleanupせずそのまま保存・復元する', () => {
  const state = {
    ...createEmptyState(),
    paAssignments: [{
      id: 'pa-broken',
      eventId: 'missing-event',
      eventDayId: 'missing-day',
      stageId: 'missing-stage',
      memberId: 'missing-member',
      role: 'main',
      from: { scheduleItemId: 'missing-from', edge: 'start' },
      until: { scheduleItemId: 'missing-until', edge: 'end' },
    }],
    dutyAssignments: [{
      id: 'duty-broken',
      dutyTypeId: 'missing-duty-type',
      eventDayId: 'missing-day',
      stageId: 'missing-stage',
      memberId: 'missing-member',
      from: { scheduleItemId: 'missing-from', edge: 'start' },
      until: { scheduleItemId: 'missing-until', edge: 'end' },
    }],
  }
  const parsed = parsePersistedState(serializePersistedState(state))

  assert.ok(parsed)
  assert.deepEqual(parsed.paAssignments, state.paAssignments)
  assert.deepEqual(parsed.dutyAssignments, state.dutyAssignments)
})

test('storageなし・invalidならdemoData、validなら保存値を初期値にする', () => {
  const missingStorage = new MemoryStorage()
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, missingStorage),
    createPersistedAppState(createDemoData()),
  )

  const invalidStorage = new MemoryStorage()
  invalidStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 999 }))
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, invalidStorage),
    createPersistedAppState(createDemoData()),
  )
  assert.equal(invalidStorage.getItem(STORAGE_KEY), null)

  const validStorage = new MemoryStorage()
  const persisted = {
    ...createEmptyState(),
    members: [{ id: 'saved-member', realName: '保存済み', active: true }],
  }
  savePersistedState(persisted, validStorage)
  assert.deepEqual(
    loadPersistedStateOrFallback(createDemoData, validStorage),
    createPersistedAppState(persisted),
  )
})

test('saveは1つのkeyへatomic snapshotを書きclearで削除する', () => {
  const storage = new MemoryStorage()
  const state = createEmptyState()

  assert.equal(savePersistedState(state, storage), true)
  assert.deepEqual([...storage.values.keys()], [STORAGE_KEY])
  assert.equal(clearPersistedState(storage), true)
  assert.equal(storage.getItem(STORAGE_KEY), null)
})

test('localStorageへの保存失敗を外へ投げずstate更新を継続できる', () => {
  const storage = new MemoryStorage()
  storage.setItem = () => {
    throw new Error('quota exceeded')
  }
  const originalWarn = console.warn
  console.warn = () => {}

  try {
    assert.doesNotThrow(() => savePersistedState(createEmptyState(), storage))
    assert.equal(savePersistedState(createEmptyState(), storage), false)
  } finally {
    console.warn = originalWarn
  }
})
