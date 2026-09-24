import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import {
  createBackupFilename,
  createBackupJson,
  parseBackupJson,
} from '../src/persistence/dataBackup.ts'
import {
  CURRENT_STORAGE_VERSION,
  STORAGE_KEY,
  createPersistedAppState,
  savePersistedState,
} from '../src/persistence/localPersistence.ts'

const emptyState = () => ({
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
  timetableLocks: [],
})

test('14 collectionのバックアップは既存version付きsnapshotと同じ内容でround-tripする', () => {
  const demo = createDemoData()
  const json = createBackupJson(demo)
  const restored = parseBackupJson(json)

  assert.ok(json.includes('\n  "version": 1,'))
  assert.deepEqual(restored, createPersistedAppState(demo))
  assert.equal(restored.version, CURRENT_STORAGE_VERSION)
  assert.deepEqual(restored.scheduleItems.map((item) => item.id), demo.scheduleItems.map((item) => item.id))
  assert.deepEqual(restored.eventBands, demo.eventBands)
  assert.deepEqual(restored.paAssignments, demo.paAssignments)
  assert.deepEqual(restored.dutyAssignments, demo.dutyAssignments)
  assert.deepEqual(restored.timetableLocks, demo.timetableLocks)
  assert.deepEqual(Object.keys(restored).sort(), ['version', ...Object.keys(emptyState())].sort())
  assert.equal('selectedEventId' in restored, false)
})

test('TimetableLockをバックアップでround-tripし、旧backupでは空配列にする', () => {
  const state = {
    ...emptyState(),
    timetableLocks: [{
      id: 'lock-1', eventId: 'event-1', scheduleItemId: 'item-1',
      stageId: 'stage-1', sectionId: 'section-1',
      position: { kind: 'first' },
    }],
  }
  assert.deepEqual(
    parseBackupJson(createBackupJson(state))?.timetableLocks,
    state.timetableLocks,
  )

  const current = createPersistedAppState(emptyState())
  const { timetableLocks: _omitted, ...legacy } = current
  assert.deepEqual(parseBackupJson(JSON.stringify(legacy))?.timetableLocks, [])
})

test('Section間Breakの配置情報をJSON export/importで維持する', () => {
  const state = {
    ...emptyState(),
    scheduleItems: [{
      id: 'between-break',
      stageId: 'stage-1',
      afterSectionId: 'section-1',
      order: 0,
      kind: 'break',
      title: '部間休憩',
      durationMinutes: 15,
    }],
  }

  const restored = parseBackupJson(createBackupJson(state))
  assert.equal(restored.scheduleItems[0].afterSectionId, 'section-1')
})

test('不正JSON、未知version、必須collection不足、malformed elementを拒否する', () => {
  const valid = createPersistedAppState(emptyState())

  assert.equal(parseBackupJson('{broken'), undefined)
  assert.equal(parseBackupJson(JSON.stringify({ ...valid, version: 2 })), undefined)
  assert.equal(parseBackupJson(JSON.stringify({ version: 1 })), undefined)
  assert.equal(parseBackupJson(JSON.stringify({ ...valid, events: [null] })), undefined)
})

test('既存の起動時invariantをバックアップ復元でも適用する', () => {
  const demo = createDemoData()
  const valid = createPersistedAppState(demo)
  const invalidDate = {
    ...valid,
    eventDays: demo.eventDays.map((day, index) =>
      index === 0 ? { ...day, date: '2026-02-31' } : day),
  }

  assert.equal(parseBackupJson(JSON.stringify(invalidDate)), undefined)
})

test('不正ファイルのparseでは現在snapshotとlocalStorageを変更しない', () => {
  const demo = createDemoData()
  const original = createPersistedAppState(demo)
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  assert.equal(savePersistedState(demo, storage), true)
  const storedBefore = storage.getItem(STORAGE_KEY)

  assert.equal(parseBackupJson(JSON.stringify({ ...original, events: [null] })), undefined)
  assert.deepEqual(createPersistedAppState(demo), original)
  assert.equal(storage.getItem(STORAGE_KEY), storedBefore)
})

test('有効なバックアップを保存するとlocalStorageも同じ全snapshotになる', () => {
  const restored = parseBackupJson(createBackupJson(createDemoData()))
  assert.ok(restored)
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }

  assert.equal(savePersistedState(restored, storage), true)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), restored)
  assert.deepEqual([...values.keys()], [STORAGE_KEY])
})

test('空の14 collectionも有効でdemoDataに置換されない', () => {
  const empty = emptyState()
  assert.deepEqual(parseBackupJson(createBackupJson(empty)), createPersistedAppState(empty))
})

test('修復可能な参照切れとIDをバックアップで維持する', () => {
  const state = {
    ...emptyState(),
    paAssignments: [{
      id: 'pa-broken', eventId: 'missing-event', eventDayId: 'missing-day',
      stageId: 'missing-stage', memberId: 'missing-member', role: 'main',
      from: { scheduleItemId: 'missing-from', edge: 'start' },
      until: { scheduleItemId: 'missing-until', edge: 'end' },
    }],
    dutyAssignments: [{
      id: 'duty-broken', dutyTypeId: 'missing-duty-type', eventDayId: 'missing-day',
      stageId: 'missing-stage', memberId: 'missing-member',
      from: { scheduleItemId: 'missing-from', edge: 'start' },
      until: { scheduleItemId: 'missing-until', edge: 'end' },
    }],
  }

  assert.deepEqual(parseBackupJson(createBackupJson(state)), createPersistedAppState(state))
})

test('バックアップファイル名は渡されたローカル時刻から生成する', () => {
  const date = new Date(2026, 8, 22, 19, 15, 0)
  assert.equal(createBackupFilename(date), 'acappella-tt-backup-20260922-191500.json')
})
