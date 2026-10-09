import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import {
  createCloudEventRepository,
  createSupabaseCloudEventGateway,
} from '../src/cloud/cloudEventRepository.ts'
import {
  CLOUD_EVENT_SAVE_MAX_REQUEST_BYTES,
  handleCloudEventSaveRequest,
} from '../src/cloud/cloudEventSaveEndpoint.ts'
import {
  createCloudEventOperationRegistry,
  deleteCloudEvent,
  getCloudEventHydrationView,
  getCloudEventOperation,
  isCloudEventCacheWriteReady,
  loadCloudWorkspaceEvents,
  runCloudEventHydrationAttempt,
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
  hasValidCloudEventRelationships,
  parseCloudEventSnapshot,
} from '../src/cloud/cloudEventSnapshot.ts'
import {
  CURRENT_STORAGE_VERSION,
  createCloudScopedStorageKey,
  createPersistedAppState,
  loadPersistedStateForScope,
  savePersistedState,
} from '../src/persistence/localPersistence.ts'

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

const compareUtf8Bytes = (left, right) => Buffer.compare(
  Buffer.from(left, 'utf8'),
  Buffer.from(right, 'utf8'),
)

const createHydrationHarness = (
  initialState,
  scopeKey = 'scope-a',
) => {
  let domainState = structuredClone(initialState)
  let latestDomainState = domainState
  let hydration = { scopeKey: '', kind: 'loading' }
  let storageValue = 'existing-cache'
  let storageSetCalls = 0
  let storageRemoveCalls = 0
  const transitions = []

  const onStateChange = nextHydration => {
    hydration = nextHydration
    transitions.push(structuredClone(nextHydration))
    if (isCloudEventCacheWriteReady({
      cloudEnabled: true,
      persistenceScopeReady: true,
      requestedScopeKey: scopeKey,
      hydration,
    })) {
      storageSetCalls += 1
      storageValue = structuredClone(domainState)
    }
  }

  return {
    run(load, isCurrent = () => true) {
      return runCloudEventHydrationAttempt({
        scopeKey,
        isCurrent,
        load,
        apply: loaded => {
          domainState = structuredClone(loaded.state)
          latestDomainState = domainState
        },
        onStateChange,
      })
    },
    get domainState() { return domainState },
    get latestDomainState() { return latestDomainState },
    get hydration() { return hydration },
    get storageValue() { return storageValue },
    get storageSetCalls() { return storageSetCalls },
    get storageRemoveCalls() { return storageRemoveCalls },
    get transitions() { return transitions },
    removeStorage() {
      storageRemoveCalls += 1
      storageValue = undefined
    },
  }
}

class RawCacheStorage {
  values = new Map()
  setCalls = []
  removeCalls = []
  failSet = false

  seed(key, value) {
    this.values.set(key, value)
  }

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.setCalls.push({ key, value })
    if (this.failSet) throw new Error('quota exceeded')
    this.values.set(key, value)
  }

  removeItem(key) {
    this.removeCalls.push(key)
    this.values.delete(key)
  }
}

const createRawCacheHydrationHarness = ({
  storage,
  scopeKey,
  fallback = createDemoData(),
}) => {
  let domainState = loadPersistedStateForScope({
    createFallback: () => fallback,
    cloudEnabled: true,
    storage,
    storageKey: scopeKey,
  })
  let latestDomainState = domainState
  let hydration = { scopeKey: '', kind: 'loading' }

  return {
    run(load, isCurrent = () => true) {
      return runCloudEventHydrationAttempt({
        scopeKey,
        isCurrent,
        load,
        apply: loaded => {
          domainState = structuredClone(loaded.state)
          latestDomainState = domainState
        },
        onStateChange: nextHydration => {
          hydration = nextHydration
          if (isCloudEventCacheWriteReady({
            cloudEnabled: true,
            persistenceScopeReady: true,
            requestedScopeKey: scopeKey,
            hydration,
          })) {
            savePersistedState(domainState, storage, scopeKey)
          }
        },
      })
    },
    get domainState() { return domainState },
    get latestDomainState() { return latestDomainState },
    get hydration() { return hydration },
  }
}

class MemoryCloudEventGateway {
  rows = new Map()
  allowedWorkspaces = new Set()
  workspaceRoles = new Map()
  authenticated = true
  clock = 0
  accessCalls = 0
  loadRowCalls = 0
  workspacePageCalls = 0
  saveCalls = 0
  deleteCalls = 0
  workspacePageRequests = []

  constructor(allowedWorkspaces) {
    this.allowedWorkspaces = new Set(allowedWorkspaces)
    this.workspaceRoles = new Map(allowedWorkspaces.map(workspaceId => [
      workspaceId,
      'editor',
    ]))
  }

  key(workspaceId, eventId) {
    return `${workspaceId}:${eventId}`
  }

  deny(workspaceId) {
    return this.authenticated &&
      this.allowedWorkspaces.has(workspaceId) &&
      ['owner', 'editor', 'viewer'].includes(
        this.workspaceRoles.get(workspaceId) ?? 'editor',
      )
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
      ? { data: { role: this.workspaceRoles.get(workspaceId) ?? 'editor' }, error: null }
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
    this.loadRowCalls += 1
    const denied = this.deny(workspaceId)
    if (denied) return denied
    return {
      data: structuredClone(this.rows.get(this.key(workspaceId, eventId)) ?? null),
      error: null,
    }
  }

  async loadAuthorizedWorkspacePage(workspaceId, afterEventId, limit) {
    this.workspacePageCalls += 1
    this.workspacePageRequests.push({ workspaceId, afterEventId, limit })
    const denied = this.deny(workspaceId)
    if (denied) return denied
    const candidates = [...this.rows.values()]
      .filter(row => row.workspace_id === workspaceId)
      .sort((left, right) => compareUtf8Bytes(left.event_id, right.event_id))
      .filter(row => afterEventId === null ||
        compareUtf8Bytes(row.event_id, afterEventId) > 0)
    const rows = candidates.slice(0, limit)
    return {
      data: {
        status: 'ok',
        workspace_id: workspaceId,
        rows: rows.map(row => structuredClone(row)),
        next_cursor: candidates.length > limit
          ? rows.at(-1)?.event_id ?? null
          : null,
      },
      error: null,
    }
  }

  async saveRow({ workspaceId, snapshot }) {
    this.saveCalls += 1
    const denied = this.deny(workspaceId)
    if (denied) return denied
    const event = snapshot.appState.events[0]
    const eventId = event.id
    const eventName = event.name
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

  async deleteAuthorizedEvent(workspaceId, eventId) {
    this.deleteCalls += 1
    const denied = this.deny(workspaceId)
    if (denied) return denied
    const key = this.key(workspaceId, eventId)
    const row = this.rows.get(key)
    if (row) this.rows.delete(key)
    return {
      data: {
        status: row ? 'deleted' : 'already_absent',
        workspace_id: workspaceId,
        event_id: eventId,
      },
      error: null,
    }
  }
}

const createSnapshot = (state, eventId) => {
  const result = createCloudEventSnapshot(state, eventId)
  assert.equal(result.ok, true)
  return result.snapshot
}

const createMinimalSnapshot = (eventId, eventName = eventId) => {
  const state = createEmptyState()
  state.events.push({
    id: eventId,
    name: eventName,
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5],
  })
  return createSnapshot(state, eventId)
}

const SAVE_ENDPOINT_WORKSPACE_ID = '10000000-0000-0000-0000-000000000001'

const createSavedRow = (
  snapshot,
  workspaceId = 'workspace-a',
  revision = 1,
) => ({
  workspace_id: workspaceId,
  event_id: snapshot.appState.events[0].id,
  event_name: snapshot.appState.events[0].name,
  event_snapshot: structuredClone(snapshot),
  revision,
  created_at: '2026-10-08T00:00:00.000Z',
  updated_at: '2026-10-08T00:00:01.000Z',
})

const createSaveRequest = (snapshot, overrides = {}) => new Request(
  'https://example.supabase.co/functions/v1/save-cloud-event',
  {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json',
      ...overrides.headers,
    },
    body: JSON.stringify({
      workspaceId: SAVE_ENDPOINT_WORKSPACE_ID,
      snapshot,
      ...overrides.body,
    }),
  },
)

const readEndpointPayload = response => response.json()

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
    async loadWorkspaceEvents() {
      return { ok: true, value: order.map(index => records[index]) }
    },
    async listEvents() { throw new Error('not called') },
    async loadEvent() { throw new Error('not called') },
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

test('Cloud Event snapshotはEvent-owned参照を内部解決しcross ownershipを拒否する', () => {
  const { state, eventId, snapshot } = createSnapshotContainingEveryEventOwnedCollection()
  assert.equal(hasValidCloudEventRelationships(snapshot.appState), true)

  const cases = [
    ['EventBand missing EventDay', appState => {
      appState.eventBands[0].eventDayId = 'missing-event-day'
    }],
    ['EventBand foreign EventDay ownership', appState => {
      const day = appState.eventDays.find(candidate =>
        candidate.id === appState.eventBands[0].eventDayId)
      assert.ok(day)
      day.eventId = 'foreign-event'
    }],
    ['fixedPlacement missing Stage', appState => {
      appState.eventBands[0].fixedPlacement = { stageId: 'missing-stage' }
    }],
    ['fixedPlacement missing Section', appState => {
      const eventBand = appState.eventBands[0]
      const stage = appState.stages.find(candidate =>
        candidate.eventDayId === eventBand.eventDayId)
      assert.ok(stage)
      eventBand.fixedPlacement = { stageId: stage.id, sectionId: 'missing-section' }
    }],
    ['fixedPlacement cross EventDay', appState => {
      const eventBand = appState.eventBands[0]
      const foreignStage = appState.stages.find(candidate =>
        candidate.eventDayId !== eventBand.eventDayId)
      assert.ok(foreignStage)
      eventBand.fixedPlacement = { stageId: foreignStage.id }
    }],
    ['Stage missing EventDay', appState => {
      appState.stages[0].eventDayId = 'missing-event-day'
    }],
    ['Section missing Stage', appState => {
      appState.sections[0].stageId = 'missing-stage'
    }],
    ['Section foreign Stage', appState => {
      const section = appState.sections[0]
      const foreignStage = appState.stages.find(candidate =>
        candidate.id !== section.stageId)
      assert.ok(foreignStage)
      section.stageId = foreignStage.id
    }],
    ['EventMemberDay missing EventMember', appState => {
      appState.eventMemberDays[0].eventMemberId = 'missing-event-member'
    }],
    ['EventMemberDay missing EventDay', appState => {
      appState.eventMemberDays[0].eventDayId = 'missing-event-day'
    }],
    ['ScheduleItem missing Stage', appState => {
      appState.scheduleItems[0].stageId = 'missing-stage'
    }],
    ['Performance invalid Section lane', appState => {
      const performance = appState.scheduleItems.find(item => item.kind === 'performance')
      assert.ok(performance)
      performance.sectionId = 'missing-section'
    }],
    ['Performance missing EventBand', appState => {
      const performance = appState.scheduleItems.find(item => item.kind === 'performance')
      assert.ok(performance)
      performance.eventBandId = 'missing-event-band'
    }],
    ['Performance cross EventDay', appState => {
      const performance = appState.scheduleItems.find(item => item.kind === 'performance')
      assert.ok(performance)
      const stage = appState.stages.find(candidate => candidate.id === performance.stageId)
      const foreignBand = appState.eventBands.find(candidate =>
        candidate.eventDayId !== stage?.eventDayId)
      assert.ok(foreignBand)
      performance.eventBandId = foreignBand.id
    }],
    ['PA missing EventDay', appState => {
      appState.paAssignments[0].eventDayId = 'missing-event-day'
    }],
    ['PA missing Boundary ScheduleItem', appState => {
      appState.paAssignments[0].from = {
        kind: 'schedule-item', scheduleItemId: 'missing-schedule-item', edge: 'start',
      }
    }],
    ['PA cross EventDay Stage', appState => {
      const assignment = appState.paAssignments[0]
      const foreignStage = appState.stages.find(candidate =>
        candidate.eventDayId !== assignment.eventDayId)
      assert.ok(foreignStage)
      assignment.stageId = foreignStage.id
    }],
    ['Duty missing DutyType', appState => {
      appState.dutyAssignments[0].dutyTypeId = 'missing-duty-type'
    }],
    ['Duty missing Boundary Section', appState => {
      appState.dutyAssignments[0].until = {
        kind: 'section', sectionId: 'missing-section', edge: 'end',
      }
    }],
    ['Duty cross EventDay Stage', appState => {
      const assignment = appState.dutyAssignments[0]
      const foreignStage = appState.stages.find(candidate =>
        candidate.eventDayId !== assignment.eventDayId)
      assert.ok(foreignStage)
      assignment.stageId = foreignStage.id
    }],
    ['Lock missing ScheduleItem', appState => {
      appState.timetableLocks[0].scheduleItemId = 'missing-schedule-item'
    }],
    ['Lock references Break', appState => {
      const lock = appState.timetableLocks[0]
      const breakItem = appState.scheduleItems.find(item => item.kind === 'break')
      assert.ok(breakItem)
      lock.scheduleItemId = breakItem.id
      lock.stageId = breakItem.stageId
      lock.sectionId = breakItem.sectionId
    }],
    ['Lock Stage mismatch', appState => {
      const lock = appState.timetableLocks[0]
      const item = appState.scheduleItems.find(candidate =>
        candidate.id === lock.scheduleItemId)
      const foreignStage = appState.stages.find(candidate =>
        candidate.id !== item?.stageId)
      assert.ok(item)
      assert.ok(foreignStage)
      lock.stageId = foreignStage.id
    }],
    ['Lock Section mismatch', appState => {
      const lock = appState.timetableLocks[0]
      const item = appState.scheduleItems.find(candidate =>
        candidate.id === lock.scheduleItemId)
      const foreignSection = appState.sections.find(candidate =>
        candidate.stageId === item?.stageId && candidate.id !== item?.sectionId)
      assert.ok(item)
      assert.ok(foreignSection)
      lock.sectionId = foreignSection.id
    }],
    ['OrderConstraint missing EventBand', appState => {
      appState.timetableOrderConstraints[0].eventBandIds[0] = 'missing-event-band'
    }],
    ['OrderConstraint cross EventDay EventBand', appState => {
      const constraint = appState.timetableOrderConstraints[0]
      const foreignBand = appState.eventBands.find(candidate =>
        candidate.eventDayId !== constraint.eventDayId)
      assert.ok(foreignBand)
      constraint.eventBandIds[0] = foreignBand.id
    }],
  ]

  for (const [label, mutate] of cases) {
    const malformed = structuredClone(snapshot)
    mutate(malformed.appState)
    assert.equal(hasValidCloudEventRelationships(malformed.appState), false, label)
    assert.equal(parseCloudEventSnapshot(malformed), undefined, label)
  }

  const malformedState = structuredClone(state)
  const eventBand = malformedState.eventBands.find(candidate => candidate.eventId === eventId)
  assert.ok(eventBand)
  eventBand.eventDayId = 'missing-event-day'
  assert.equal(createCloudEventSnapshot(malformedState, eventId).ok, false)
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

test('clientと保存Endpointは同じCloud snapshot validator/fixture判定を共有する', async () => {
  const minimal = createMinimalSnapshot('event-endpoint-minimal', 'Endpoint Minimal')
  const complex = createSnapshot(createDemoData(), 'event-demo-main')
  const incomplete = {
    format: CLOUD_EVENT_SNAPSHOT_FORMAT,
    version: CLOUD_EVENT_SNAPSHOT_VERSION,
    appState: { version: CURRENT_STORAGE_VERSION, events: minimal.appState.events },
  }
  const invalidTime = structuredClone(complex)
  invalidTime.appState.eventDays[0].date = 'bad'
  const missingMaster = structuredClone(complex)
  const referencedMemberId = missingMaster.appState.eventMembers[0].memberId
  missingMaster.appState.members = missingMaster.appState.members.filter(
    member => member.id !== referencedMemberId,
  )
  const extraMaster = structuredClone(complex)
  extraMaster.appState.members.push({
    id: 'endpoint-extra-member',
    realName: 'Extra',
    active: true,
  })
  const duplicateOwnedId = structuredClone(complex)
  duplicateOwnedId.appState.scheduleItems.push(
    structuredClone(duplicateOwnedId.appState.scheduleItems[0]),
  )
  const duplicateMember = structuredClone(complex)
  duplicateMember.appState.members.push(
    structuredClone(duplicateMember.appState.members[0]),
  )
  const duplicateBand = structuredClone(complex)
  duplicateBand.appState.bands.push(
    structuredClone(duplicateBand.appState.bands[0]),
  )
  const foreignOwnership = structuredClone(complex)
  foreignOwnership.appState.eventDays[0].eventId = 'foreign-event'

  const transitiveState = structuredClone(createDemoData())
  const transitiveEventId = transitiveState.events[0].id
  const transitiveEventBand = transitiveState.eventBands.find(candidate =>
    candidate.eventId === transitiveEventId && candidate.bandId)
  const transitiveBand = transitiveState.bands.find(candidate =>
    candidate.id === transitiveEventBand?.bandId)
  assert.ok(transitiveBand)
  transitiveState.members.push({
    id: 'endpoint-transitive-member',
    realName: 'Endpoint Transitive',
    active: true,
  })
  transitiveBand.defaultMemberIds.push('endpoint-transitive-member')
  const missingTransitiveMaster = createSnapshot(transitiveState, transitiveEventId)
  missingTransitiveMaster.appState.members =
    missingTransitiveMaster.appState.members.filter(
      member => member.id !== 'endpoint-transitive-member',
    )

  const cases = [
    { name: 'empty Event', snapshot: minimal, valid: true },
    { name: 'complex Event', snapshot: complex, valid: true },
    { name: 'events-only V5', snapshot: incomplete, valid: false },
    { name: 'invalid wrapper', snapshot: { ...minimal, version: 2 }, valid: false },
    { name: 'invalid collection value', snapshot: {
      ...minimal,
      appState: { ...minimal.appState, members: [null] },
    }, valid: false },
    { name: 'blank Event ID', snapshot: {
      ...minimal,
      appState: {
        ...minimal.appState,
        events: [{ ...minimal.appState.events[0], id: '   ' }],
      },
    }, valid: false },
    { name: 'missing master', snapshot: missingMaster, valid: false },
    { name: 'extra master', snapshot: extraMaster, valid: false },
    { name: 'missing transitive Band Member', snapshot: missingTransitiveMaster, valid: false },
    { name: 'duplicate Member ID', snapshot: duplicateMember, valid: false },
    { name: 'duplicate Band ID', snapshot: duplicateBand, valid: false },
    { name: 'duplicate Event-owned ID', snapshot: duplicateOwnedId, valid: false },
    { name: 'foreign Event ownership', snapshot: foreignOwnership, valid: false },
    { name: 'invalid date invariant', snapshot: invalidTime, valid: false },
  ]

  for (const fixture of cases) {
    let saveCalls = 0
    const response = await handleCloudEventSaveRequest(
      createSaveRequest(fixture.snapshot),
      {
        async authenticate() { return { id: 'user-a' } },
        async saveValidatedSnapshot({ workspaceId, snapshot }) {
          saveCalls += 1
          return { data: createSavedRow(snapshot, workspaceId), error: null }
        },
      },
    )
    assert.equal(Boolean(parseCloudEventSnapshot(fixture.snapshot)), fixture.valid, fixture.name)
    assert.equal(response.ok, fixture.valid, fixture.name)
    assert.equal(saveCalls, fixture.valid ? 1 : 0, fixture.name)
  }

  for (const key of Object.keys(minimal.appState)) {
    if (key === 'version') continue
    const missingCollection = structuredClone(minimal)
    delete missingCollection.appState[key]
    let saveCalls = 0
    const response = await handleCloudEventSaveRequest(
      createSaveRequest(missingCollection),
      {
        async authenticate() { return { id: 'user-a' } },
        async saveValidatedSnapshot() {
          saveCalls += 1
          return { data: null, error: null }
        },
      },
    )
    assert.equal(parseCloudEventSnapshot(missingCollection), undefined, key)
    assert.equal(response.status, 400, key)
    assert.equal(saveCalls, 0, key)
  }
})

test('保存Endpointは正式認証identityだけを使いmethod・JSON・sizeをfail closedする', async () => {
  const snapshot = createMinimalSnapshot('event-endpoint-auth', 'Endpoint Auth')
  const savedInputs = []
  const dependencies = {
    async authenticate(token) {
      return token === 'valid-token' ? { id: 'authenticated-user' } : undefined
    },
    async saveValidatedSnapshot(input) {
      savedInputs.push(input)
      return { data: createSavedRow(input.snapshot, input.workspaceId), error: null }
    },
  }

  for (const request of [
    new Request('https://example.invalid', { method: 'POST', headers: {
      'content-type': 'application/json',
    }, body: '{}' }),
    new Request('https://example.invalid', { method: 'POST', headers: {
      authorization: 'Bearer fake-token',
      'content-type': 'application/json',
    }, body: '{}' }),
    new Request('https://example.invalid', { method: 'POST', headers: {
      authorization: 'Bearer expired-token',
      'content-type': 'application/json',
    }, body: '{}' }),
  ]) {
    const response = await handleCloudEventSaveRequest(request, dependencies)
    assert.equal(response.status, 401)
  }

  const forged = await handleCloudEventSaveRequest(createSaveRequest(snapshot, {
    body: { userId: 'forged-user', role: 'owner' },
  }), dependencies)
  assert.equal(forged.status, 200)
  assert.equal(savedInputs[0].actorId, 'authenticated-user')
  assert.equal(savedInputs[0].workspaceId, SAVE_ENDPOINT_WORKSPACE_ID)

  const preflight = await handleCloudEventSaveRequest(
    new Request('https://example.invalid', { method: 'OPTIONS' }),
    dependencies,
  )
  assert.equal(preflight.status, 204)
  assert.equal(savedInputs.length, 1)

  const wrongMethod = await handleCloudEventSaveRequest(
    new Request('https://example.invalid', { method: 'GET' }),
    dependencies,
  )
  assert.equal(wrongMethod.status, 405)

  const configurationFailure = await handleCloudEventSaveRequest(
    createSaveRequest(snapshot),
    {
      async authenticate() {
        const error = new Error('configuration')
        error.code = 'CONFIGURATION_ERROR'
        throw error
      },
      async saveValidatedSnapshot() { throw new Error('not called') },
    },
  )
  assert.equal(configurationFailure.status, 500)
  assert.equal(
    (await readEndpointPayload(configurationFailure)).error.code,
    'CONFIGURATION_ERROR',
  )

  const oversized = await handleCloudEventSaveRequest(new Request(
    'https://example.invalid',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: 'x'.repeat(CLOUD_EVENT_SAVE_MAX_REQUEST_BYTES + 1),
    },
  ), dependencies)
  assert.equal(oversized.status, 413)
  assert.equal(savedInputs.length, 1)
})

test('保存EndpointはWorkspace IDを標準UUIDとして検証し大文字表記を正規化する', async () => {
  const snapshot = createMinimalSnapshot('event-endpoint-workspace', 'Endpoint Workspace')
  const savedInputs = []
  const dependencies = {
    async authenticate() { return { id: 'user-a' } },
    async saveValidatedSnapshot(input) {
      savedInputs.push(input)
      return {
        data: createSavedRow(input.snapshot, input.workspaceId.toLowerCase()),
        error: null,
      }
    },
  }

  const lowercase = await handleCloudEventSaveRequest(
    createSaveRequest(snapshot),
    dependencies,
  )
  assert.equal(lowercase.status, 200)
  assert.equal(savedInputs[0].workspaceId, SAVE_ENDPOINT_WORKSPACE_ID)

  const uppercaseWorkspaceId = 'ABCDEF01-2345-6789-ABCD-EF0123456789'
  const uppercase = await handleCloudEventSaveRequest(
    createSaveRequest(snapshot, { body: { workspaceId: uppercaseWorkspaceId } }),
    dependencies,
  )
  assert.equal(uppercase.status, 200)
  assert.equal(savedInputs[1].workspaceId, uppercaseWorkspaceId.toLowerCase())

  const invalidWorkspaceIds = [
    '',
    '   ',
    'workspace-a',
    '10000000-0000-0000-0000-00000000001',
    'g0000000-0000-0000-0000-000000000001',
    '100000000000-0000-0000-000000000001',
    null,
    42,
    [],
    {},
  ]
  for (const workspaceId of invalidWorkspaceIds) {
    const saveCallsBefore = savedInputs.length
    const response = await handleCloudEventSaveRequest(
      createSaveRequest(snapshot, { body: { workspaceId } }),
      dependencies,
    )
    assert.equal(response.status, 400, JSON.stringify(workspaceId))
    assert.equal(
      (await readEndpointPayload(response)).error.code,
      'INVALID_REQUEST',
      JSON.stringify(workspaceId),
    )
    assert.equal(savedInputs.length, saveCallsBefore, JSON.stringify(workspaceId))
  }
})

test('保存EndpointはContent-Typeのmedia typeを厳密に検証する', async () => {
  const snapshot = createMinimalSnapshot('event-endpoint-media-type', 'Endpoint Media Type')
  let authenticationCalls = 0
  let saveCalls = 0
  const dependencies = {
    async authenticate() {
      authenticationCalls += 1
      return { id: 'user-a' }
    },
    async saveValidatedSnapshot({ workspaceId, snapshot: validated }) {
      saveCalls += 1
      return { data: createSavedRow(validated, workspaceId), error: null }
    },
  }

  for (const contentType of [
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON; Charset=UTF-8',
  ]) {
    const response = await handleCloudEventSaveRequest(
      createSaveRequest(snapshot, { headers: { 'content-type': contentType } }),
      dependencies,
    )
    assert.equal(response.status, 200, contentType)
  }
  assert.equal(saveCalls, 3)

  for (const contentType of [
    'application/jsonp',
    'application/json-seq',
    'application/json-invalid',
    'text/plain',
  ]) {
    const response = await handleCloudEventSaveRequest(
      createSaveRequest(snapshot, { headers: { 'content-type': contentType } }),
      dependencies,
    )
    assert.equal(response.status, 415, contentType)
    assert.equal(
      (await readEndpointPayload(response)).error.code,
      'UNSUPPORTED_MEDIA_TYPE',
      contentType,
    )
    assert.equal(saveCalls, 3, contentType)
  }

  const missingContentType = await handleCloudEventSaveRequest(new Request(
    'https://example.supabase.co/functions/v1/save-cloud-event',
    {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ workspaceId: SAVE_ENDPOINT_WORKSPACE_ID, snapshot }),
    },
  ), dependencies)
  assert.equal(missingContentType.status, 415)
  assert.equal(saveCalls, 3)

  const callsBeforePreflight = { authenticationCalls, saveCalls }
  const preflight = await handleCloudEventSaveRequest(
    new Request('https://example.invalid', { method: 'OPTIONS' }),
    dependencies,
  )
  assert.equal(preflight.status, 204)
  assert.deepEqual(
    { authenticationCalls, saveCalls },
    callsBeforePreflight,
  )
})

test('保存EndpointはDB再認可とresponseを検証し失敗を成功扱いしない', async () => {
  const snapshot = createMinimalSnapshot('event-endpoint-db', 'Endpoint DB')
  const request = () => createSaveRequest(snapshot)
  const authenticate = async () => ({ id: 'user-a' })

  for (const code of ['42501', 'ACCESS_DENIED']) {
    const response = await handleCloudEventSaveRequest(request(), {
      authenticate,
      async saveValidatedSnapshot() {
        return { data: null, error: { code } }
      },
    })
    assert.equal(response.status, 403)
    assert.equal((await readEndpointPayload(response)).error.code, 'ACCESS_DENIED')
  }

  const malformed = await handleCloudEventSaveRequest(request(), {
    authenticate,
    async saveValidatedSnapshot() { return { data: { revision: 1 }, error: null } },
  })
  assert.equal(malformed.status, 502)
  assert.equal((await readEndpointPayload(malformed)).error.code, 'INVALID_RESPONSE')

  const networkFailure = await handleCloudEventSaveRequest(request(), {
    authenticate,
    async saveValidatedSnapshot() { throw new Error('network') },
  })
  assert.equal(networkFailure.status, 502)
  assert.equal((await readEndpointPayload(networkFailure)).error.code, 'SAVE_FAILED')

  for (const revision of [1, 2]) {
    const success = await handleCloudEventSaveRequest(request(), {
      authenticate,
      async saveValidatedSnapshot({ workspaceId, snapshot: validated }) {
        return { data: createSavedRow(validated, workspaceId, revision), error: null }
      },
    })
    assert.equal(success.status, 200)
    assert.equal((await readEndpointPayload(success)).record.revision, revision)
  }
})

test('保存Endpointは返却snapshotと要求snapshotの永続内容が一致する場合だけ成功する', async () => {
  const snapshot = createMinimalSnapshot('event-endpoint-response', 'Endpoint Response')
  const authenticate = async () => ({ id: 'user-a' })
  const reverseObjectKeys = value => {
    if (Array.isArray(value)) return value.map(reverseObjectKeys)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).reverse().map(
      ([key, nested]) => [key, reverseObjectKeys(nested)],
    ))
  }

  const reorderedRow = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  reorderedRow.event_snapshot = reverseObjectKeys(snapshot)
  const reordered = await handleCloudEventSaveRequest(createSaveRequest(snapshot), {
    authenticate,
    async saveValidatedSnapshot() { return { data: reorderedRow, error: null } },
  })
  assert.equal(reordered.status, 200)

  const assertInvalidResponse = async (data, label) => {
    let saveCalls = 0
    const response = await handleCloudEventSaveRequest(createSaveRequest(snapshot), {
      authenticate,
      async saveValidatedSnapshot() {
        saveCalls += 1
        return { data, error: null }
      },
    })
    assert.equal(response.status, 502, label)
    assert.equal((await readEndpointPayload(response)).error.code, 'INVALID_RESPONSE', label)
    assert.equal(saveCalls, 1, label)
  }

  const returnedNameMismatch = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  returnedNameMismatch.event_snapshot.appState.events[0].name = 'Unexpected Name'
  await assertInvalidResponse(returnedNameMismatch, 'metadata/snapshot Event name mismatch')

  const changedEvent = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  changedEvent.event_snapshot.appState.events[0].description = 'Unexpected description'
  await assertInvalidResponse(changedEvent, 'changed Event field')

  const changedOrderedArray = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  changedOrderedArray.event_snapshot.appState.events[0].performanceSlotMinutes = [10]
  await assertInvalidResponse(changedOrderedArray, 'changed ordered Event array')

  const complexSnapshot = createSnapshot(createDemoData(), 'event-demo-main')
  const changedCollection = createSavedRow(complexSnapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  changedCollection.event_snapshot.appState.members[0].realName += ' changed'
  let collectionSaveCalls = 0
  const changedCollectionResponse = await handleCloudEventSaveRequest(
    createSaveRequest(complexSnapshot),
    {
      authenticate,
      async saveValidatedSnapshot() {
        collectionSaveCalls += 1
        return { data: changedCollection, error: null }
      },
    },
  )
  assert.equal(changedCollectionResponse.status, 502)
  assert.equal(
    (await readEndpointPayload(changedCollectionResponse)).error.code,
    'INVALID_RESPONSE',
  )
  assert.equal(collectionSaveCalls, 1)

  const missingRequiredField = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  delete missingRequiredField.event_snapshot.appState.events
  const wrongWorkspace = createSavedRow(snapshot, '20000000-0000-0000-0000-000000000002')
  const wrongEvent = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  wrongEvent.event_id = 'other-event'
  const errorPayload = {
    ...createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID),
    error: { code: 'unexpected' },
  }
  const invalidRevision = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID, 0)
  const invalidTimestamp = createSavedRow(snapshot, SAVE_ENDPOINT_WORKSPACE_ID)
  invalidTimestamp.updated_at = 'not-a-timestamp'

  for (const [label, data] of [
    ['missing required snapshot field', missingRequiredField],
    ['Workspace mismatch', wrongWorkspace],
    ['Event mismatch', wrongEvent],
    ['null payload', null],
    ['unknown payload', { status: 'ok' }],
    ['error-bearing success payload', errorPayload],
    ['invalid revision', invalidRevision],
    ['invalid timestamp', invalidTimestamp],
  ]) {
    await assertInvalidResponse(data, label)
  }
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

test('Cloud hydrateはMap変換前にlocal Member/Bandのduplicate IDをfail closedする', async () => {
  const base = createDemoData()
  const duplicateCases = [
    ['members', structuredClone(base.members[0])],
    ['members', { ...structuredClone(base.members[0]), realName: '異なる重複Member' }],
    ['bands', structuredClone(base.bands[0])],
    ['bands', { ...structuredClone(base.bands[0]), name: '異なる重複Band' }],
  ]

  for (const [collection, duplicate] of duplicateCases) {
    const localState = structuredClone(base)
    localState[collection].push(duplicate)
    const before = structuredClone(localState)

    assert.deepEqual(createCloudWorkspaceState(localState, []), {
      ok: false,
      reason: 'INVALID_SNAPSHOT',
    })

    const loaded = await loadCloudWorkspaceEvents({
      async loadWorkspaceEvents() { return { ok: true, value: [] } },
      async listEvents() { throw new Error('not called') },
      async loadEvent() { throw new Error('not called') },
      async saveEvent() { throw new Error('not called') },
      async deleteEvent() { throw new Error('not called') },
    }, 'workspace-a', localState)
    assert.equal(loaded.ok, false)
    assert.equal(!loaded.ok && loaded.error.code, 'INVALID_SNAPSHOT')
    assert.deepEqual(localState, before)
    assert.equal(isCloudEventCacheWriteReady({
      cloudEnabled: true,
      persistenceScopeReady: true,
      requestedScopeKey: 'scope-a',
      hydration: {
        scopeKey: 'scope-a',
        kind: 'error',
        message: !loaded.ok ? loaded.error.message : '',
      },
    }), false)
  }
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

test('listEventsはDBが返したmetadata順をlocaleで再ソートせず維持する', async () => {
  const rows = [
    ['Z-event', 'Z'],
    ['a-event', 'a'],
    ['_event', '_'],
    ['日本-event', '日本'],
    ['😀-event', '😀'],
  ].map(([eventId, eventName]) => ({
    workspace_id: 'workspace-a',
    event_id: eventId,
    event_name: eventName,
    revision: 1,
    created_at: '2026-10-08T00:00:00.000Z',
    updated_at: '2026-10-08T00:00:01.000Z',
  }))
  const originalRows = structuredClone(rows)
  const repository = createCloudEventRepository({
    async getWorkspaceRole() {
      return { data: { role: 'editor' }, error: null }
    },
    async listRows() { return { data: rows, error: null } },
    async loadRow() { throw new Error('not called') },
    async loadAuthorizedWorkspacePage() { throw new Error('not called') },
    async saveRow() { throw new Error('not called') },
    async deleteAuthorizedEvent() { throw new Error('not called') },
  })

  const listed = await repository.listEvents('workspace-a')
  assert.equal(listed.ok, true)
  assert.deepEqual(
    listed.ok && listed.value.map(summary => summary.eventId),
    rows.map(row => row.event_id),
  )
  assert.deepEqual(rows, originalRows)
})

test('Supabase metadata一覧はcreated_atからevent_idの順でDBへORDER BYを委ねる', async () => {
  const orders = []
  const terminal = { data: [], error: null }
  const query = {
    select() { return this },
    eq() { return this },
    order(column, options) {
      orders.push({ column, options })
      return orders.length === 2 ? terminal : this
    },
  }
  const gateway = createSupabaseCloudEventGateway({
    from(table) {
      assert.equal(table, 'cloud_events')
      return query
    },
  })

  assert.deepEqual(await gateway.listRows('workspace-a'), terminal)
  assert.deepEqual(orders, [
    { column: 'created_at', options: { ascending: true } },
    { column: 'event_id', options: { ascending: true } },
  ])
})

test('browser gatewayは保存専用Functionだけを呼び構造化errorを分類する', async () => {
  const snapshot = createMinimalSnapshot('event-function-gateway', 'Function Gateway')
  const calls = []
  const client = {
    functions: {
      async invoke(name, options) {
        calls.push({ name, options })
        return {
          data: { status: 'ok', record: createSavedRow(snapshot) },
          error: null,
        }
      },
    },
  }
  const gateway = createSupabaseCloudEventGateway(client)
  const saved = await gateway.saveRow({ workspaceId: 'workspace-a', snapshot })
  assert.equal(saved.error, null)
  assert.equal(saved.data.event_id, 'event-function-gateway')
  assert.deepEqual(calls, [{
    name: 'save-cloud-event',
    options: { body: { workspaceId: 'workspace-a', snapshot } },
  }])
  assert.equal('eventId' in calls[0].options.body, false)
  assert.equal('eventName' in calls[0].options.body, false)

  const deniedGateway = createSupabaseCloudEventGateway({
    functions: {
      async invoke() {
        return {
          data: null,
          error: {
            context: new Response(JSON.stringify({
              status: 'error',
              error: { code: 'ACCESS_DENIED', message: 'denied' },
            }), { status: 403, headers: { 'content-type': 'application/json' } }),
          },
        }
      },
    },
  })
  assert.equal(
    (await deniedGateway.saveRow({ workspaceId: 'workspace-a', snapshot })).error.code,
    'ACCESS_DENIED',
  )

  const malformedGateway = createSupabaseCloudEventGateway({
    functions: {
      async invoke() { return { data: { status: 'ok' }, error: null } },
    },
  })
  assert.equal(
    (await malformedGateway.saveRow({ workspaceId: 'workspace-a', snapshot })).error.code,
    'INVALID_RESPONSE',
  )
})

test('Workspace bulk loadは認可済みkeyset pageを読みEvent単位loadを行わない', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway, { workspacePageSize: 1 })
  const state = createDemoData()
  for (const event of state.events.slice(0, 3)) {
    assert.equal((await repository.saveEvent(
      'workspace-a',
      createSnapshot(state, event.id),
    )).ok, true)
  }
  gateway.accessCalls = 0
  gateway.workspacePageCalls = 0
  gateway.loadRowCalls = 0

  const loaded = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    createEmptyState(),
  )

  assert.equal(loaded.ok, true)
  assert.equal(gateway.accessCalls, 0)
  assert.equal(gateway.workspacePageCalls, 3)
  assert.equal(gateway.loadRowCalls, 0)
  assert.deepEqual(
    loaded.ok && loaded.value.records.map(record => record.eventId),
    state.events.slice(0, 3).map(event => event.id).sort(),
  )
})

test('Workspace bulk loadは認可済みの0件とpage size同件数を明示cursorで終端にする', async () => {
  const emptyGateway = new MemoryCloudEventGateway(['workspace-a'])
  const emptyRepository = createCloudEventRepository(
    emptyGateway,
    { workspacePageSize: 2 },
  )
  assert.deepEqual(await emptyRepository.loadWorkspaceEvents('workspace-a'), {
    ok: true,
    value: [],
  })
  assert.equal(emptyGateway.workspacePageCalls, 1)

  assert.equal((await emptyRepository.saveEvent(
    'workspace-a',
    createMinimalSnapshot('only-event'),
  )).ok, true)
  emptyGateway.workspacePageCalls = 0
  const single = await emptyRepository.loadWorkspaceEvents('workspace-a')
  assert.deepEqual(single.ok && single.value.map(record => record.eventId), [
    'only-event',
  ])
  assert.equal(emptyGateway.workspacePageCalls, 1)

  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway, { workspacePageSize: 2 })
  const state = createDemoData()
  for (const event of state.events.slice(0, 2)) {
    assert.equal((await repository.saveEvent(
      'workspace-a',
      createSnapshot(state, event.id),
    )).ok, true)
  }
  gateway.workspacePageCalls = 0
  const loaded = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(loaded.ok, true)
  assert.equal(loaded.ok && loaded.value.length, 2)
  assert.equal(gateway.workspacePageCalls, 1)
})

test('Workspace bulk loadは不正page・scope越境・重複・cursor進行不良を拒否する', async () => {
  const createRow = (eventId, workspaceId = 'workspace-a') => ({
    workspace_id: workspaceId,
    event_id: eventId,
    event_name: eventId,
    event_snapshot: createMinimalSnapshot(eventId),
    revision: 1,
    created_at: '2026-10-08T00:00:00.000Z',
    updated_at: '2026-10-08T00:00:00.000Z',
  })
  const row = createRow('event-a')
  const otherRow = createRow('event-b')
  const page = (rows, nextCursor = null, overrides = {}) => ({
    status: 'ok',
    workspace_id: 'workspace-a',
    rows,
    next_cursor: nextCursor,
    ...overrides,
  })
  const cases = [
    { pages: [null], code: 'INVALID_RESPONSE' },
    { pages: [undefined], code: 'INVALID_RESPONSE' },
    { pages: [[]], code: 'INVALID_RESPONSE' },
    {
      pages: [{ status: 'ok', workspace_id: 'workspace-a', rows: [] }],
      code: 'INVALID_RESPONSE',
    },
    { pages: [page([], null, { status: 'unknown' })], code: 'INVALID_RESPONSE' },
    { pages: [page([], null, { workspace_id: 'workspace-b' })], code: 'INVALID_RESPONSE' },
    { pages: [page([], null, { error: 'ambiguous' })], code: 'INVALID_RESPONSE' },
    { pages: [page([{ ...row, workspace_id: 'workspace-b' }])], code: 'INVALID_SNAPSHOT' },
    { pages: [page([row, row])], code: 'INVALID_SNAPSHOT', pageSize: 2 },
    { pages: [page([row], 'wrong-cursor')], code: 'INVALID_RESPONSE', pageSize: 1 },
    { pages: [page([row], '   ')], code: 'INVALID_RESPONSE', pageSize: 1 },
    {
      pages: [page([row], row.event_id), page([row])],
      code: 'INVALID_SNAPSHOT',
      pageSize: 1,
    },
    {
      pages: [page([row], row.event_id), page([otherRow], row.event_id)],
      code: 'INVALID_RESPONSE',
      pageSize: 1,
    },
    {
      pages: [page([])],
      code: 'SUPABASE_ERROR',
      databaseError: { code: 'NETWORK' },
    },
    { pages: [], code: 'SUPABASE_ERROR', throws: true },
  ]

  for (const fixture of cases) {
    let pageIndex = 0
    const repository = createCloudEventRepository({
      async getWorkspaceRole() {
        return { data: { role: 'editor' }, error: null }
      },
      async listRows() { throw new Error('not called') },
      async loadRow() { throw new Error('not called') },
      async loadAuthorizedWorkspacePage() {
        if (fixture.throws) throw new Error('network')
        const data = pageIndex < fixture.pages.length
          ? fixture.pages[pageIndex]
          : page([])
        pageIndex += 1
        return { data, error: fixture.databaseError ?? null }
      },
      async saveRow() { throw new Error('not called') },
      async deleteAuthorizedEvent() { throw new Error('not called') },
    }, { workspacePageSize: fixture.pageSize ?? 2 })
    const result = await repository.loadWorkspaceEvents('workspace-a')
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, fixture.code)
  }
})

test('Workspace pageは各requestでowner・editor・viewerを許可し権限消失を部分成功にしない', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway, { workspacePageSize: 1 })
  for (const eventId of ['event-a', 'event-b', 'event-c']) {
    assert.equal((await repository.saveEvent(
      'workspace-a',
      createMinimalSnapshot(eventId),
    )).ok, true)
  }

  for (const role of ['owner', 'editor', 'viewer']) {
    gateway.workspaceRoles.set('workspace-a', role)
    const result = await repository.loadWorkspaceEvents('workspace-a')
    assert.equal(result.ok, true, role)
    assert.deepEqual(result.ok && result.value.map(record => record.eventId), [
      'event-a', 'event-b', 'event-c',
    ])
  }

  gateway.allowedWorkspaces.delete('workspace-a')
  const nonMember = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(nonMember.ok, false)
  assert.equal(!nonMember.ok && nonMember.error.code, 'ACCESS_DENIED')
  const deniedHarness = createHydrationHarness(createDemoData())
  const deniedBefore = structuredClone(deniedHarness.domainState)
  const deniedCompletion = await deniedHarness.run(() => loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    deniedHarness.domainState,
  ))
  assert.equal(deniedCompletion.kind, 'error')
  assert.deepEqual(deniedHarness.domainState, deniedBefore)
  assert.deepEqual(deniedHarness.latestDomainState, deniedBefore)
  assert.equal(deniedHarness.hydration.kind, 'error')
  assert.equal(deniedHarness.storageSetCalls, 0)
  assert.equal(deniedHarness.storageRemoveCalls, 0)

  gateway.allowedWorkspaces.add('workspace-a')
  gateway.workspaceRoles.set('workspace-a', 'editor')
  gateway.authenticated = false
  const unauthenticated = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(unauthenticated.ok, false)
  assert.equal(!unauthenticated.ok && unauthenticated.error.code, 'ACCESS_DENIED')
  gateway.authenticated = true

  gateway.workspaceRoles.set('workspace-a', 'unknown')
  const unknownRole = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(unknownRole.ok, false)
  assert.equal(!unknownRole.ok && unknownRole.error.code, 'ACCESS_DENIED')
  gateway.workspaceRoles.set('workspace-a', 'editor')

  const loadPage = gateway.loadAuthorizedWorkspacePage.bind(gateway)
  let pageCalls = 0
  gateway.loadAuthorizedWorkspacePage = async (...args) => {
    pageCalls += 1
    const result = await loadPage(...args)
    if (pageCalls === 1) gateway.allowedWorkspaces.delete('workspace-a')
    return result
  }
  const revoked = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(revoked.ok, false)
  assert.equal(!revoked.ok && revoked.error.code, 'ACCESS_DENIED')
  assert.equal(pageCalls, 2)

  gateway.allowedWorkspaces.add('workspace-a')
  gateway.workspaceRoles.set('workspace-a', 'editor')
  assert.equal(revoked.ok, false)
  assert.equal(!revoked.ok && revoked.error.code, 'ACCESS_DENIED')
  pageCalls = 0
  gateway.loadAuthorizedWorkspacePage = async (...args) => {
    pageCalls += 1
    const result = await loadPage(...args)
    if (pageCalls === 2) gateway.allowedWorkspaces.delete('workspace-a')
    return result
  }
  const revokedBeforeTerminal = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(revokedBeforeTerminal.ok, false)
  assert.equal(
    !revokedBeforeTerminal.ok && revokedBeforeTerminal.error.code,
    'ACCESS_DENIED',
  )
  assert.equal(pageCalls, 3)

  gateway.allowedWorkspaces.add('workspace-a')
  gateway.workspaceRoles.set('workspace-a', 'editor')
  gateway.loadAuthorizedWorkspacePage = loadPage
  gateway.workspacePageRequests = []
  const retried = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(retried.ok, true)
  assert.equal(gateway.workspacePageRequests[0]?.afterEventId, null)

  pageCalls = 0
  gateway.workspaceRoles.set('workspace-a', 'editor')
  gateway.loadAuthorizedWorkspacePage = async (...args) => {
    pageCalls += 1
    const result = await loadPage(...args)
    if (pageCalls === 1) gateway.workspaceRoles.set('workspace-a', 'viewer')
    return result
  }
  const downgraded = await repository.loadWorkspaceEvents('workspace-a')
  assert.equal(downgraded.ok, true)
  assert.equal(gateway.workspaceRoles.get('workspace-a'), 'viewer')
})

test('Workspace pageのC照合順cursorをclientは変更せずUnicode IDも欠落なく取得する', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway, { workspacePageSize: 2 })
  const eventIds = ['a', 'A', '!mark', 'あ', '😀', '𠮷']
  for (const eventId of eventIds) {
    assert.equal((await repository.saveEvent(
      'workspace-a',
      createMinimalSnapshot(eventId),
    )).ok, true)
  }

  gateway.workspacePageRequests = []
  const loaded = await repository.loadWorkspaceEvents('workspace-a')
  const expected = [...eventIds].sort(compareUtf8Bytes)
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.ok && loaded.value.map(record => record.eventId), expected)
  assert.deepEqual(
    gateway.workspacePageRequests.map(request => request.afterEventId),
    [null, expected[1], expected[3]],
  )
})

test('Workspace bulk loadの途中失敗はhydrate stateを部分commitしない', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway, { workspacePageSize: 1 })
  const state = createDemoData()
  for (const event of state.events.slice(0, 2)) {
    assert.equal((await repository.saveEvent(
      'workspace-a',
      createSnapshot(state, event.id),
    )).ok, true)
  }
  const loadPage = gateway.loadAuthorizedWorkspacePage.bind(gateway)
  let pageCalls = 0
  gateway.loadAuthorizedWorkspacePage = async (...args) => {
    pageCalls += 1
    return pageCalls === 2
      ? { data: null, error: { code: 'NETWORK' } }
      : loadPage(...args)
  }
  const localState = structuredClone(state)
  const before = structuredClone(localState)
  const result = await loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    localState,
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'SUPABASE_ERROR')
  assert.deepEqual(localState, before)

  pageCalls = 0
  const harness = createHydrationHarness(localState)
  const completed = await harness.run(() => loadCloudWorkspaceEvents(
    repository,
    'workspace-a',
    harness.domainState,
  ))
  assert.equal(completed.kind, 'error')
  assert.deepEqual(harness.domainState, before)
  assert.deepEqual(harness.latestDomainState, before)
  assert.equal(harness.hydration.kind, 'error')
  assert.equal(harness.storageSetCalls, 0)
  assert.equal(harness.storageRemoveCalls, 0)
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
  assert.deepEqual(deleted, {
    ok: true,
    value: { deleted: true, status: 'deleted' },
  })
  assert.equal(gateway.deleteCalls, 1)
  assert.equal(gateway.rows.has(`workspace-a:${eventId}`), false)
})

test('Cloud deleteはRPCが認可済みと明示したrow不存在だけをidempotent successとして扱う', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const missing = await deleteCloudEvent(repository, 'workspace-a', 'missing-event')
  assert.deepEqual(missing, {
    ok: true,
    value: { deleted: false, status: 'already_absent' },
  })
  assert.equal(gateway.deleteCalls, 1)

  gateway.deleteAuthorizedEvent = async () => ({
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

test('Cloud deleteは曖昧・不一致・未知のRPC responseを成功へ変換しない', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  const repository = createCloudEventRepository(gateway)
  const invalidResponses = [
    null,
    undefined,
    {},
    { status: 'unknown', workspace_id: 'workspace-a', event_id: 'event-a' },
    { status: 'deleted', workspace_id: 'workspace-b', event_id: 'event-a' },
    { status: 'deleted', workspace_id: 'workspace-a', event_id: 'event-b' },
  ]

  for (const data of invalidResponses) {
    gateway.deleteAuthorizedEvent = async () => ({ data, error: null })
    const result = await deleteCloudEvent(repository, 'workspace-a', 'event-a')
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, 'INVALID_RESPONSE')
  }

  gateway.deleteAuthorizedEvent = async () => ({
    data: {
      status: 'deleted',
      workspace_id: 'workspace-a',
      event_id: 'event-a',
    },
    error: { code: 'NETWORK' },
  })
  const ambiguous = await deleteCloudEvent(repository, 'workspace-a', 'event-a')
  assert.equal(ambiguous.ok, false)
  assert.equal(!ambiguous.ok && ambiguous.error.code, 'SUPABASE_ERROR')

  gateway.deleteAuthorizedEvent = async () => { throw new Error('network') }
  const thrown = await deleteCloudEvent(repository, 'workspace-a', 'event-a')
  assert.equal(thrown.ok, false)
  assert.equal(!thrown.ok && thrown.error.code, 'SUPABASE_ERROR')
})

test('client事前確認後にRPCで権限取消されたCloud deleteはACCESS_DENIEDとなる', async () => {
  const gateway = new MemoryCloudEventGateway(['workspace-a'])
  let rpcCalls = 0
  gateway.deleteAuthorizedEvent = async () => {
    rpcCalls += 1
    return { data: null, error: { code: '42501' } }
  }
  const result = await deleteCloudEvent(
    createCloudEventRepository(gateway),
    'workspace-a',
    'event-a',
  )
  assert.equal(rpcCalls, 1)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'ACCESS_DENIED')
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
    loadAuthorizedWorkspacePage: gateway.loadAuthorizedWorkspacePage.bind(gateway),
    saveRow: gateway.saveRow.bind(gateway),
    deleteAuthorizedEvent: gateway.deleteAuthorizedEvent.bind(gateway),
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
    async loadAuthorizedWorkspacePage() {
      return { data: [{ workspace_id: 'workspace-b' }], error: null }
    },
    async saveRow() {
      return { data: null, error: null }
    },
    async deleteAuthorizedEvent() {
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
  gateway.workspaceRoles.set('workspace-a', 'viewer')
  const repository = createCloudEventRepository(gateway)
  const snapshot = createSnapshot(createDemoData(), 'event-demo-main')

  assert.deepEqual(await repository.listEvents('workspace-a'), {
    ok: true,
    value: [],
  })
  assert.deepEqual(await repository.loadWorkspaceEvents('workspace-a'), {
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

test('viewer read-only判定はmutationを塞ぎ閲覧・検索・出力入口を維持する', async () => {
  const [
    appSource,
    shellSource,
    eventListSource,
    commonDataSource,
    backupSource,
    memberSettingsSource,
    bandSettingsSource,
    stageSettingsSource,
    orderConstraintSettingsSource,
    orderConstraintRepairSource,
  ] =
    await Promise.all([
      readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventEditorShell.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventList.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/CommonDataPage.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/DataBackupSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventMemberSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventBandSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventStageSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL(
        '../src/components/TimetableOrderConstraintSettings.tsx',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL(
        '../src/components/TimetableOrderConstraintRepairPanel.tsx',
        import.meta.url,
      ), 'utf8'),
    ])

  assert.match(appSource, /const canEditWorkspace = cloudWorkspace === null \|\|[\s\S]*canEditCloudWorkspace/)
  for (const handler of [
    'handleCreateEvent',
    'handleDeleteEvent',
    'handleSaveEventBasicInfo',
    'handleSaveEventStageSettings',
    'handleOnDragEnd',
    'handleApplyGeneratedTimetable',
    'handleResetTimetable',
    'handleSubmitGridAssignment',
    'handleApplyDutyAutoAssignment',
    'handleSaveCommonMember',
    'handleSaveSelectedEventToCloud',
  ]) {
    const start = appSource.indexOf(`const ${handler}`)
    assert.notEqual(start, -1, handler)
    assert.match(appSource.slice(start, start + 700), /!canEditWorkspace/, handler)
  }
  assert.match(appSource, /readOnly=\{!canEditWorkspace\}/)
  assert.match(shellSource, /cloudSave && !readOnly/)
  assert.match(eventListSource, /!readOnly && <div className="event-list-page__create">/)
  assert.match(commonDataSource, /!readOnly && <div className="csv-import-control">/)
  assert.match(backupSource, /!readOnly && <button/)
  assert.ok(
    memberSettingsSource.indexOf('id="event-member-search"') <
      memberSettingsSource.indexOf('<fieldset className="read-only-form-controls"'),
  )
  assert.ok(
    bandSettingsSource.indexOf('className="event-day-tabs"') <
      bandSettingsSource.indexOf('<fieldset className="read-only-form-controls"'),
  )
  assert.match(memberSettingsSource, /CSV書き出し/)
  assert.match(bandSettingsSource, /CSV書き出し/)
  assert.match(stageSettingsSource, /if \(readOnly\)[\s\S]*setSelectedEventDayId/)
  assert.match(appSource, /TimetableOrderConstraintRepairPanel[\s\S]*readOnly=\{!canEditWorkspace\}/)
  assert.match(appSource,
    /key=\{`\$\{selectedEvent\.id\}:\$\{canEditWorkspace \? 'editable' : 'read-only'\}`\}/)
  assert.match(orderConstraintSettingsSource,
    /TimetableOrderConstraintRepairPanel[\s\S]*readOnly=\{readOnly\}/)
  assert.match(orderConstraintSettingsSource,
    /key=\{readOnly \? 'read-only' : 'editable'\}/)
  assert.match(orderConstraintRepairSource,
    /!readOnly && <div className="timetable-order-settings__actions">/)
  assert.match(orderConstraintRepairSource, /!readOnly && pendingDeletion/)
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
  assert.match(explicitSaveHandler, /runEventEditorCloudSaveGuarded\(/)
  assert.match(explicitSaveHandler, /handles: getEventEditorDraftHandles\(\)/)
  assert.match(deleteHandler, /runExclusiveCloudEventDeletion\(/)
  assert.match(deleteHandler, /latestDomainStateRef\.current/)
  assert.match(
    deleteHandler,
    /getLatestState: \(\) => latestDomainStateRef\.current,[\s\S]*commit: commitEventDeletion/,
  )
})

test('Cloud delete権限エラー後はDialogを残してpendingを解除しCancel/retry可能にする', async () => {
  const source = await readFile(new URL(
    '../src/components/EventBasicInfo.tsx',
    import.meta.url,
  ), 'utf8')
  const confirmHandler = source.slice(
    source.indexOf('const confirmEventDeletion'),
    source.indexOf('const save ='),
  )

  assert.match(confirmHandler, /if \(!result\.ok\) \{[\s\S]*setEventDeletionError[\s\S]*return/)
  assert.match(confirmHandler, /setPendingEventDeletion\(undefined\)/)
  assert.match(confirmHandler, /finally \{[\s\S]*setIsDeletingEvent\(false\)/)
  assert.ok(
    confirmHandler.indexOf('setPendingEventDeletion(undefined)') >
      confirmHandler.indexOf('if (!result.ok)'),
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

test('Cloud hydrate表示はcurrent scopeの成功時だけdomain contentを表示する', () => {
  const base = {
    cloudEnabled: true,
    persistenceScopeReady: true,
    requestedScopeKey: 'scope-b',
  }

  assert.equal(getCloudEventHydrationView({
    ...base,
    hydration: { scopeKey: 'scope-a', kind: 'ready' },
  }), 'loading')
  assert.equal(getCloudEventHydrationView({
    ...base,
    hydration: { scopeKey: 'scope-b', kind: 'loading' },
  }), 'loading')
  assert.equal(getCloudEventHydrationView({
    ...base,
    hydration: { scopeKey: 'scope-b', kind: 'error', message: 'failed' },
  }), 'error')
  assert.equal(getCloudEventHydrationView({
    ...base,
    hydration: { scopeKey: 'scope-b', kind: 'ready' },
  }), 'content')
  assert.equal(getCloudEventHydrationView({
    ...base,
    persistenceScopeReady: false,
    hydration: { scopeKey: 'scope-b', kind: 'ready' },
  }), 'loading')
  assert.equal(getCloudEventHydrationView({
    ...base,
    cloudEnabled: false,
    hydration: { scopeKey: 'other', kind: 'loading' },
  }), 'content')
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

test('認可済みdeleted/already_absentだけがlocal cascadeし、失敗時はleaseを解除して再試行できる', async () => {
  for (const status of ['deleted', 'already_absent']) {
    const registry = createCloudEventOperationRegistry()
    let state = createDemoData()
    const eventId = state.events[0].id
    let commitCalls = 0
    let saveCalls = 0
    const completed = await runExclusiveCloudEventDeletion({
      registry,
      scopeKey: 'scope-a',
      workspaceId: 'workspace-a',
      eventId,
      repository: {
        async deleteEvent() {
          return {
            ok: true,
            value: { status, workspaceId: 'workspace-a', eventId },
          }
        },
        async saveEvent() { saveCalls += 1 },
      },
      isScopeCurrent: () => true,
      getLatestState: () => state,
      commit: result => {
        commitCalls += 1
        state = { members: state.members, bands: state.bands, ...result }
      },
    })
    assert.equal(completed.started, true)
    assert.equal(completed.started && completed.value.ok, true)
    assert.equal(commitCalls, 1)
    assert.equal(saveCalls, 0)
    assert.equal(state.events.some(event => event.id === eventId), false)
    assert.equal(registry.get('scope-a', eventId), undefined)
  }

  for (const code of ['ACCESS_DENIED', 'SUPABASE_ERROR', 'INVALID_RESPONSE']) {
    const registry = createCloudEventOperationRegistry()
    const state = createDemoData()
    const before = structuredClone(state)
    const eventId = state.events[0].id
    let commitCalls = 0
    const failed = await runExclusiveCloudEventDeletion({
      registry,
      scopeKey: 'scope-a',
      workspaceId: 'workspace-a',
      eventId,
      repository: {
        async deleteEvent() {
          return { ok: false, error: { code, message: code } }
        },
      },
      isScopeCurrent: () => true,
      getLatestState: () => state,
      commit: () => { commitCalls += 1 },
    })
    assert.deepEqual(failed, {
      started: true,
      value: { ok: false, reason: 'CLOUD_DELETE_FAILED' },
    })
    assert.equal(commitCalls, 0)
    assert.deepEqual(state, before)
    assert.equal(registry.get('scope-a', eventId), undefined)

    const retry = await runExclusiveCloudEventDeletion({
      registry,
      scopeKey: 'scope-a',
      workspaceId: 'workspace-a',
      eventId,
      repository: {
        async deleteEvent() {
          return {
            ok: true,
            value: {
              status: 'already_absent',
              workspaceId: 'workspace-a',
              eventId,
            },
          }
        },
      },
      isScopeCurrent: () => true,
      getLatestState: () => state,
      commit: () => { commitCalls += 1 },
    })
    assert.equal(retry.started, true)
    assert.equal(retry.started && retry.value.ok, true)
    assert.equal(commitCalls, 1)
  }
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
  deferredDelete.resolve({
    ok: true,
    value: {
      status: 'deleted',
      workspaceId: 'workspace-a',
      eventId: deletedEventId,
    },
  })
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
  deferredDelete.resolve({
    ok: true,
    value: {
      status: 'deleted',
      workspaceId: 'workspace-a',
      eventId,
    },
  })

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
    async loadAuthorizedWorkspacePage() {
      return { data: null, error: { code: 'NETWORK' } }
    },
    async saveRow() {
      throw new Error('not called')
    },
    async deleteAuthorizedEvent() {
      throw new Error('not called')
    },
  })
  const result = await loadCloudWorkspaceEvents(repository, 'workspace-a', base)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'SUPABASE_ERROR')
  assert.deepEqual(base, before)
})

test('Appの初回起動とscope切替は同じCloud非破壊loaderへ接続する', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.equal(source.match(/loadPersistedStateForScope\(\{/g)?.length, 2)
  assert.match(source,
    /const \[initialAppState\][\s\S]*loadPersistedStateForScope\(\{[\s\S]*cloudEnabled: Boolean\(cloudWorkspace\)/)
  assert.match(source,
    /rehydratePersistenceScope\(loadPersistedStateForScope\(\{[\s\S]*cloudEnabled: Boolean\(cloudWorkspace\)/)
  assert.doesNotMatch(source, /loadPersistedStateOrFallback/)

  const rehydrateScope = source.slice(
    source.indexOf('const rehydratePersistenceScope'),
    source.indexOf('const persistenceScopeReady'),
  )
  assert.match(rehydrateScope,
    /setCloudEventLoadState\(\{ scopeKey: storageKey, kind: 'loading' \}\)/)
  assert.ok(
    rehydrateScope.indexOf("kind: 'loading'") <
      rehydrateScope.indexOf('setActivePersistenceStorageKey(storageKey)'),
  )
})

test('malformed raw Cloud cacheはhydrate失敗・例外でも元文字列を保持する', async () => {
  const raw = '{broken cloud cache\n'
  const failures = [
    { code: 'ACCESS_DENIED', message: 'denied' },
    { code: 'SUPABASE_ERROR', message: 'network' },
    { code: 'INVALID_SNAPSHOT', message: 'invalid snapshot' },
    { code: 'SHARED_MASTER_CONFLICT', message: 'shared master conflict' },
    { code: 'INVALID_SNAPSHOT', message: 'duplicate local master' },
  ]

  for (const failure of failures) {
    const storage = new RawCacheStorage()
    const scopeKey = createCloudScopedStorageKey({
      userId: `user-${failure.message}`,
      workspaceId: 'workspace-a',
    })
    storage.seed(scopeKey, raw)
    const harness = createRawCacheHydrationHarness({ storage, scopeKey })
    const before = structuredClone(harness.domainState)

    const result = await harness.run(async () => ({ ok: false, error: failure }))
    assert.equal(result.kind, 'error')
    assert.deepEqual(harness.domainState, before)
    assert.deepEqual(harness.latestDomainState, before)
    assert.equal(storage.values.get(scopeKey), raw)
    assert.deepEqual(storage.setCalls, [])
    assert.deepEqual(storage.removeCalls, [])
    assert.equal(getCloudEventHydrationView({
      cloudEnabled: true,
      persistenceScopeReady: true,
      requestedScopeKey: scopeKey,
      hydration: harness.hydration,
    }), 'error')
  }

  const storage = new RawCacheStorage()
  const scopeKey = createCloudScopedStorageKey({
    userId: 'user-rejection',
    workspaceId: 'workspace-a',
  })
  storage.seed(scopeKey, raw)
  const harness = createRawCacheHydrationHarness({ storage, scopeKey })
  const rejected = await harness.run(async () => {
    throw new Error('unexpected')
  })
  assert.equal(rejected.kind, 'error')
  assert.equal(storage.values.get(scopeKey), raw)
  assert.deepEqual(storage.setCalls, [])
  assert.deepEqual(storage.removeCalls, [])
})

test('Cloud scope切替・cancel・retryは成功前のcacheを変更せず成功後だけcurrent scopeを更新する', async () => {
  const storage = new RawCacheStorage()
  const keyA = createCloudScopedStorageKey({
    userId: 'user-a',
    workspaceId: 'workspace-a',
  })
  const keyB = createCloudScopedStorageKey({
    userId: 'user-a',
    workspaceId: 'workspace-b',
  })
  const stateA = {
    ...createEmptyState(),
    members: [{ id: 'member-a', realName: 'Workspace A', active: true }],
  }
  const rawA = JSON.stringify(createPersistedAppState(stateA))
  const rawB = '{malformed workspace b'
  storage.seed(keyA, rawA)
  storage.seed(keyB, rawB)

  assert.deepEqual(loadPersistedStateForScope({
    createFallback: createDemoData,
    cloudEnabled: true,
    storage,
    storageKey: keyA,
  }), createPersistedAppState(stateA))
  assert.deepEqual(loadPersistedStateForScope({
    createFallback: createDemoData,
    cloudEnabled: true,
    storage,
    storageKey: keyB,
  }), createPersistedAppState(createDemoData()))
  assert.equal(storage.values.get(keyA), rawA)
  assert.equal(storage.values.get(keyB), rawB)

  const harnessB = createRawCacheHydrationHarness({ storage, scopeKey: keyB })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = await harnessB.run(async () => ({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'network' },
    }))
    assert.equal(failed.kind, 'error')
    assert.equal(storage.values.get(keyB), rawB)
  }

  const staleAttempt = createDeferred()
  const harnessA = createRawCacheHydrationHarness({ storage, scopeKey: keyA })
  let activeScopeKey = keyA
  const pendingA = harnessA.run(
    () => staleAttempt.promise,
    () => activeScopeKey === keyA,
  )
  activeScopeKey = keyB
  staleAttempt.resolve({
    ok: true,
    value: { state: createPersistedAppState(createEmptyState()), records: [] },
  })
  assert.deepEqual(await pendingA, { kind: 'ignored' })
  assert.equal(storage.values.get(keyA), rawA)
  assert.equal(storage.values.get(keyB), rawB)
  assert.deepEqual(storage.setCalls, [])
  assert.deepEqual(storage.removeCalls, [])

  const successfulRetry = createDeferred()
  const pendingB = harnessB.run(() => successfulRetry.promise)
  assert.equal(storage.values.get(keyB), rawB)
  assert.deepEqual(storage.setCalls, [])
  const emptyCloudState = createPersistedAppState(createEmptyState())
  successfulRetry.resolve({
    ok: true,
    value: { state: emptyCloudState, records: [] },
  })
  assert.deepEqual(await pendingB, { kind: 'ready' })
  assert.equal(storage.values.get(keyA), rawA)
  assert.equal(storage.values.get(keyB), JSON.stringify(emptyCloudState))
  assert.deepEqual(storage.removeCalls, [])
  assert.equal(storage.setCalls.length, 1)
  assert.equal(storage.setCalls[0].key, keyB)
})

test('Cloud成功後のcache setItem失敗でも元のmalformed文字列を先行削除しない', async () => {
  const storage = new RawCacheStorage()
  const scopeKey = createCloudScopedStorageKey({
    userId: 'user-a',
    workspaceId: 'workspace-a',
  })
  const raw = '{malformed but retained'
  storage.seed(scopeKey, raw)
  storage.failSet = true
  const harness = createRawCacheHydrationHarness({ storage, scopeKey })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const result = await harness.run(async () => ({
      ok: true,
      value: { state: createPersistedAppState(createEmptyState()), records: [] },
    }))
    assert.deepEqual(result, { kind: 'ready' })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(storage.values.get(scopeKey), raw)
  assert.equal(storage.setCalls.length, 1)
  assert.deepEqual(storage.removeCalls, [])
})

test('App hydration完了処理は全failureでdomain・latest ref・storageを保持する', async () => {
  const cases = [
    {
      code: 'ACCESS_DENIED',
      message: 'ワークスペースのEventへアクセスできません。',
      createState: createDemoData,
    },
    {
      code: 'SUPABASE_ERROR',
      message: 'Cloud Eventの通信に失敗しました。',
      createState: createDemoData,
    },
    {
      code: 'INVALID_SNAPSHOT',
      message: 'Cloud Eventのデータ形式が正しくありません。',
      createState: createDemoData,
    },
    {
      code: 'SHARED_MASTER_CONFLICT',
      message: 'Cloud Event間で共有masterが競合しています。',
      createState: createDemoData,
    },
    {
      code: 'INVALID_SNAPSHOT',
      message: 'local master IDが重複しています。',
      createState: () => {
        const state = createDemoData()
        state.members.push(structuredClone(state.members[0]))
        return state
      },
    },
  ]

  for (const failure of cases) {
    const initialState = failure.createState()
    const before = structuredClone(initialState)
    const harness = createHydrationHarness(initialState)
    const result = await harness.run(async () => ({
      ok: false,
      error: { code: failure.code, message: failure.message },
    }))

    assert.deepEqual(result, {
      kind: 'error',
      error: { code: failure.code, message: failure.message },
    })
    assert.deepEqual(harness.domainState, before)
    assert.deepEqual(harness.latestDomainState, before)
    assert.deepEqual(harness.hydration, {
      scopeKey: 'scope-a',
      kind: 'error',
      message: failure.message,
    })
    assert.equal(harness.storageValue, 'existing-cache')
    assert.equal(harness.storageSetCalls, 0)
    assert.equal(harness.storageRemoveCalls, 0)
    assert.equal(isCloudEventCacheWriteReady({
      cloudEnabled: true,
      persistenceScopeReady: true,
      requestedScopeKey: 'scope-a',
      hydration: harness.hydration,
    }), false)
  }
})

test('App hydration完了処理はunexpected rejectionをerrorへ変換しcancel済み結果を無視する', async () => {
  const initialState = createDemoData()
  const before = structuredClone(initialState)
  const rejectedHarness = createHydrationHarness(initialState)
  const rejected = await rejectedHarness.run(async () => {
    throw new Error('unexpected')
  })
  assert.equal(rejected.kind, 'error')
  assert.equal(rejected.kind === 'error' && rejected.error.code, 'SUPABASE_ERROR')
  assert.deepEqual(rejectedHarness.domainState, before)
  assert.deepEqual(rejectedHarness.latestDomainState, before)
  assert.equal(rejectedHarness.hydration.kind, 'error')
  assert.equal(rejectedHarness.storageSetCalls, 0)
  assert.equal(rejectedHarness.storageRemoveCalls, 0)

  for (const settle of ['resolve', 'reject']) {
    const deferred = createDeferred()
    let visibleHydration = { scopeKey: 'scope-b', kind: 'loading' }
    let applyCalls = 0
    let current = true
    const pending = runCloudEventHydrationAttempt({
      scopeKey: 'scope-a',
      isCurrent: () => current,
      load: () => deferred.promise,
      apply: () => { applyCalls += 1 },
      onStateChange: state => { visibleHydration = state },
    })
    assert.deepEqual(visibleHydration, { scopeKey: 'scope-a', kind: 'loading' })
    current = false
    visibleHydration = { scopeKey: 'scope-b', kind: 'ready' }
    if (settle === 'resolve') {
      deferred.resolve({ ok: true, value: { state: createEmptyState(), records: [] } })
    } else {
      deferred.reject(new Error('late failure'))
    }
    assert.deepEqual(await pending, { kind: 'ignored' })
    assert.equal(applyCalls, 0)
    assert.deepEqual(visibleHydration, { scopeKey: 'scope-b', kind: 'ready' })
  }
})

test('App hydration retryは失敗前stateを再利用し、成功した空Workspaceだけを適用する', async () => {
  const initialState = createDemoData()
  const before = structuredClone(initialState)
  const harness = createHydrationHarness(initialState)
  const inputs = []
  const failingRepository = {
    async loadWorkspaceEvents() {
      return {
        ok: false,
        error: { code: 'SUPABASE_ERROR', message: 'network failure' },
      }
    },
  }
  const emptyRepository = {
    async loadWorkspaceEvents() {
      return { ok: true, value: [] }
    },
  }
  const load = repository => {
    inputs.push(structuredClone(harness.domainState))
    return loadCloudWorkspaceEvents(repository, 'workspace-a', harness.domainState)
  }

  assert.equal((await harness.run(() => load(failingRepository))).kind, 'error')
  assert.deepEqual(harness.domainState, before)
  assert.equal(harness.storageSetCalls, 0)
  assert.equal(harness.storageValue, 'existing-cache')

  assert.equal((await harness.run(() => load(failingRepository))).kind, 'error')
  assert.deepEqual(harness.domainState, before)
  assert.equal(harness.storageSetCalls, 0)

  assert.equal((await harness.run(() => load(emptyRepository))).kind, 'ready')
  assert.deepEqual(inputs[0], before)
  assert.deepEqual(inputs[1], before)
  assert.deepEqual(inputs[2], before)
  assert.equal(harness.hydration.kind, 'ready')
  assert.deepEqual(harness.domainState.events, [])
  assert.deepEqual(harness.domainState.eventDays, [])
  assert.deepEqual(harness.domainState.scheduleItems, [])
  assert.equal(harness.storageSetCalls, 1)
  assert.notEqual(harness.storageValue, 'existing-cache')
  assert.equal(harness.storageRemoveCalls, 0)
})

test('Cloud Event migrationはWorkspace ownership・RLS・revision・移管防止を定義する', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261008110000_cloud_event_persistence.sql',
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

test('migration実ファイルはAuth→Cloud Event→RPC/権限変更の依存順でversion重複がない', async () => {
  const migrations = (await readdir(new URL(
    '../supabase/migrations/',
    import.meta.url,
  ))).filter(name => name.endsWith('.sql')).sort()
  const versions = migrations.map(name => name.split('_', 1)[0])

  assert.equal(new Set(versions).size, versions.length)
  assert.ok(migrations.indexOf('20261007_auth_workspace.sql') <
    migrations.indexOf('20261008110000_cloud_event_persistence.sql'))
  assert.ok(migrations.indexOf('20261008110000_cloud_event_persistence.sql') <
    migrations.indexOf('20261008120000_cloud_event_authorized_delete.sql'))
  assert.ok(migrations.indexOf('20261008140000_cloud_event_authorized_page.sql') <
    migrations.indexOf('20261008150000_cloud_event_authorized_save.sql'))
  assert.ok(migrations.indexOf('20261008150000_cloud_event_authorized_save.sql') <
    migrations.indexOf('20261008160000_cloud_event_rpc_only_save.sql'))
  assert.equal(migrations.includes('20261007120000_cloud_event_persistence.sql'), false)
})

test('authorized save migrationはbackend専用RPCとclient直接write取消しを定義する', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261008150000_cloud_event_authorized_save.sql',
    import.meta.url,
  ), 'utf8')
  const revokeSql = await readFile(new URL(
    '../supabase/migrations/20261008160000_cloud_event_rpc_only_save.sql',
    import.meta.url,
  ), 'utf8')
  const repositorySource = await readFile(new URL(
    '../src/cloud/cloudEventRepository.ts',
    import.meta.url,
  ), 'utf8')
  const endpointSource = await readFile(new URL(
    '../src/cloud/cloudEventSaveEndpoint.ts',
    import.meta.url,
  ), 'utf8')
  const edgeSource = await readFile(new URL(
    '../supabase/functions/save-cloud-event/index.ts',
    import.meta.url,
  ), 'utf8')

  assert.match(sql, /create function public\.save_cloud_event_validated\s*\(/i)
  assert.match(sql, /language plpgsql\s+volatile\s+security definer\s+set search_path = ''/i)
  assert.match(sql, /p_actor_id uuid/i)
  assert.match(sql, /workspace_members\.workspace_id = p_workspace_id/i)
  assert.match(sql, /workspace_members\.user_id = p_actor_id/i)
  assert.match(sql, /for share/i)
  assert.match(sql, /membership_role not in \('owner', 'editor'\)/i)
  assert.match(sql, /insert into public\.cloud_events[\s\S]*on conflict \(workspace_id, event_id\) do update/i)
  assert.match(sql, /snapshot_event_id := p_event_snapshot #>> '\{appState,events,0,id\}'/i)
  assert.match(sql, /snapshot_event_name := p_event_snapshot #>> '\{appState,events,0,name\}'/i)
  assert.match(sql, /revoke all on function public\.save_cloud_event_validated\(uuid, uuid, jsonb\)[\s\S]*from authenticated/i)
  assert.match(sql, /grant execute on function public\.save_cloud_event_validated\(uuid, uuid, jsonb\)[\s\S]*to service_role/i)
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(revokeSql, new RegExp(
      `revoke insert, update on table public\\.cloud_events from ${role}`,
      'i',
    ))
  }
  assert.match(revokeSql, /revoke insert \([\s\S]*\) on public\.cloud_events from authenticated/i)
  assert.match(revokeSql, /revoke update \([\s\S]*\) on public\.cloud_events from authenticated/i)
  for (const role of ['anon', 'authenticated']) {
    assert.match(revokeSql, new RegExp(
      `has_table_privilege\\('${role}', 'public\\.cloud_events', 'INSERT'\\)`,
      'i',
    ))
    assert.match(revokeSql, new RegExp(
      `has_table_privilege\\('${role}', 'public\\.cloud_events', 'UPDATE'\\)`,
      'i',
    ))
    assert.match(revokeSql, new RegExp(
      `has_any_column_privilege\\(\\s*'${role}',\\s*'public\\.cloud_events',\\s*'INSERT,UPDATE'`,
      'i',
    ))
  }
  assert.match(revokeSql, /raise exception[\s\S]*effective table write privilege/i)
  assert.match(revokeSql, /raise exception[\s\S]*effective column write privilege/i)
  assert.match(revokeSql, /inherited INSERT\/UPDATE grants or role memberships/i)
  assert.ok(
    revokeSql.lastIndexOf('revoke update (') <
      revokeSql.indexOf('do $cloud_event_write_privilege_guard$'),
  )

  const saveGateway = repositorySource.slice(
    repositorySource.indexOf('async saveRow'),
    repositorySource.indexOf('async deleteAuthorizedEvent'),
  )
  assert.match(saveGateway, /client\.functions\.invoke\('save-cloud-event'/)
  assert.doesNotMatch(saveGateway, /\.from\('cloud_events'\)/)
  assert.doesNotMatch(saveGateway, /\.upsert\(/)
  assert.match(endpointSource, /parseCloudEventSnapshot\(body\.snapshot\)/)
  assert.match(endpointSource, /CLOUD_EVENT_SAVE_MAX_REQUEST_BYTES/)
  assert.match(edgeSource, /authClient\.auth\.getUser\(accessToken\)/)
  assert.match(edgeSource, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.match(edgeSource, /save_cloud_event_validated/)
  assert.doesNotMatch(repositorySource, /SUPABASE_SERVICE_ROLE_KEY|service_role/i)
})

test('authorized delete migrationはMembershipをlockして認可済み結果だけを返す', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261008120000_cloud_event_authorized_delete.sql',
    import.meta.url,
  ), 'utf8')
  const repositorySource = await readFile(new URL(
    '../src/cloud/cloudEventRepository.ts',
    import.meta.url,
  ), 'utf8')

  assert.match(sql, /create function public\.delete_cloud_event_authorized\s*\(/i)
  assert.match(sql, /language plpgsql\s+security definer\s+set search_path = ''/i)
  assert.match(sql, /caller_id uuid := auth\.uid\(\)/i)
  assert.match(sql, /from public\.workspace_members/i)
  assert.match(sql, /workspace_members\.workspace_id = p_workspace_id/i)
  assert.match(sql, /workspace_members\.user_id = caller_id/i)
  assert.match(sql, /for share/i)
  assert.match(sql, /membership_role not in \('owner', 'editor'\)/i)
  assert.match(sql, /using errcode = '42501'/i)
  assert.match(sql, /p_workspace_id is null/i)
  assert.match(sql, /p_event_id is null or btrim\(p_event_id\) = ''/i)
  assert.match(sql, /delete from public\.cloud_events/i)
  assert.match(sql, /cloud_events\.workspace_id = p_workspace_id/i)
  assert.match(sql, /cloud_events\.event_id = p_event_id/i)
  assert.match(sql, /'deleted' else 'already_absent'/i)
  assert.match(sql, /'workspace_id', p_workspace_id/i)
  assert.match(sql, /'event_id', p_event_id/i)
  assert.match(sql, /revoke all on function public\.delete_cloud_event_authorized\(uuid, text\) from public/i)
  assert.match(sql, /revoke all on function public\.delete_cloud_event_authorized\(uuid, text\) from anon/i)
  assert.match(sql, /revoke all on function public\.delete_cloud_event_authorized\(uuid, text\) from service_role/i)
  assert.match(sql, /grant execute on function public\.delete_cloud_event_authorized\(uuid, text\) to authenticated/i)

  assert.match(repositorySource, /\.rpc\('delete_cloud_event_authorized'/)
  const gatewayDelete = repositorySource.slice(
    repositorySource.indexOf('async deleteAuthorizedEvent'),
    repositorySource.indexOf('export const createSupabaseCloudEventRepository'),
  )
  assert.doesNotMatch(gatewayDelete, /\.from\('cloud_events'\)/)
  assert.doesNotMatch(gatewayDelete, /\.delete\(\)/)
})

test('authorized page migrationは各pageでMembershipをlockしC照合順envelopeを返す', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261008140000_cloud_event_authorized_page.sql',
    import.meta.url,
  ), 'utf8')
  const repositorySource = await readFile(new URL(
    '../src/cloud/cloudEventRepository.ts',
    import.meta.url,
  ), 'utf8')

  assert.match(sql, /create function public\.load_cloud_events_page_authorized\s*\(/i)
  assert.match(sql,
    /create index cloud_events_workspace_event_id_c_idx[\s\S]*workspace_id, event_id collate "C"/i)
  assert.match(sql, /language plpgsql\s+volatile\s+security definer\s+set search_path = ''/i)
  assert.match(sql, /caller_id uuid := auth\.uid\(\)/i)
  assert.match(sql, /from public\.workspace_members/i)
  assert.match(sql, /workspace_members\.workspace_id = p_workspace_id/i)
  assert.match(sql, /workspace_members\.user_id = caller_id/i)
  assert.match(sql, /for share/i)
  assert.match(sql, /membership_role not in \('owner', 'editor', 'viewer'\)/i)
  assert.match(sql, /using errcode = '42501'/i)
  assert.match(sql, /p_page_size < 1/i)
  assert.match(sql, /p_page_size > 100/i)
  assert.match(sql, /btrim\(p_after_event_id\) = ''/i)
  assert.match(sql, /event_id collate "C"\) >/i)
  assert.match(sql, /order by cloud_events\.event_id collate "C"/i)
  assert.match(sql, /limit \(p_page_size \+ 1\)/i)
  assert.match(sql, /'status', 'ok'/i)
  assert.match(sql, /'workspace_id', p_workspace_id/i)
  assert.match(sql, /'rows', page_rows/i)
  assert.match(sql, /'next_cursor', next_cursor/i)
  assert.match(sql,
    /revoke all on function public\.load_cloud_events_page_authorized\(uuid, text, integer\)[\s\S]*from public/i)
  assert.match(sql,
    /revoke all on function public\.load_cloud_events_page_authorized\(uuid, text, integer\)[\s\S]*from anon/i)
  assert.match(sql,
    /revoke all on function public\.load_cloud_events_page_authorized\(uuid, text, integer\)[\s\S]*from service_role/i)
  assert.match(sql,
    /grant execute on function public\.load_cloud_events_page_authorized\(uuid, text, integer\)[\s\S]*to authenticated/i)

  const gatewayPageRead = repositorySource.slice(
    repositorySource.indexOf('async loadAuthorizedWorkspacePage'),
    repositorySource.indexOf('async loadRow'),
  )
  assert.match(gatewayPageRead, /\.rpc\('load_cloud_events_page_authorized'/)
  assert.match(gatewayPageRead, /p_after_event_id: afterEventId/)
  assert.doesNotMatch(gatewayPageRead, /\.from\('cloud_events'\)/)
  assert.doesNotMatch(gatewayPageRead, /\.order\(/)
  const repositoryWorkspaceLoad = repositorySource.slice(
    repositorySource.indexOf('async loadWorkspaceEvents'),
    repositorySource.indexOf('async saveEvent'),
  )
  assert.doesNotMatch(repositoryWorkspaceLoad, /localeCompare/)
  assert.doesNotMatch(repositoryWorkspaceLoad, /\.sort\(/)
})

test('upgrade migrationは直接DELETEを取り消し継承実効権限をfail closedにする', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261008130000_cloud_event_rpc_only_delete.sql',
    import.meta.url,
  ), 'utf8')

  assert.match(sql, /revoke delete on table public\.cloud_events from public/i)
  assert.match(sql, /revoke delete on table public\.cloud_events from anon/i)
  assert.match(sql, /revoke delete on table public\.cloud_events from authenticated/i)
  assert.match(sql, /has_table_privilege\('anon', 'public\.cloud_events', 'DELETE'\)/i)
  assert.match(sql, /has_table_privilege\('authenticated', 'public\.cloud_events', 'DELETE'\)/i)
  assert.match(sql, /raise exception[\s\S]*effective DELETE privilege/i)
  assert.match(sql, /inherited DELETE grants or role memberships/i)
  assert.ok(
    sql.lastIndexOf('revoke delete on table') <
      sql.indexOf('do $cloud_event_delete_privilege_guard$'),
  )
  assert.doesNotMatch(sql, /revoke all/i)
  assert.doesNotMatch(sql, /service_role/i)
})

test('実DB regression scriptは実role・RLS・RPC・2接続のlock順序を検証する', async () => {
  const coreSql = await readFile(new URL(
    '../supabase/tests/cloud_event_authorized_delete.sql',
    import.meta.url,
  ), 'utf8')
  const concurrencySql = await readFile(new URL(
    '../supabase/tests/cloud_event_authorized_delete_concurrency.sql',
    import.meta.url,
  ), 'utf8')
  const pageConcurrencySql = await readFile(new URL(
    '../supabase/tests/cloud_event_authorized_page_concurrency.sql',
    import.meta.url,
  ), 'utf8')
  const instructions = await readFile(new URL(
    '../supabase/tests/README.md',
    import.meta.url,
  ), 'utf8')

  assert.match(coreSql, /set local role authenticated/i)
  assert.match(coreSql, /set local role anon/i)
  assert.match(coreSql, /request\.jwt\.claim\.sub/i)
  assert.match(coreSql, /has_function_privilege/i)
  assert.match(coreSql, /has_table_privilege\('authenticated', 'public\.cloud_events', 'delete'\)/i)
  assert.match(coreSql, /owner direct DELETE unexpectedly succeeded/i)
  assert.match(coreSql, /owner direct INSERT unexpectedly succeeded/i)
  assert.match(coreSql, /owner incomplete direct INSERT unexpectedly succeeded/i)
  assert.match(coreSql, /owner direct UPDATE unexpectedly succeeded/i)
  assert.match(coreSql, /owner direct UPSERT unexpectedly succeeded/i)
  assert.match(coreSql, /editor direct DELETE unexpectedly succeeded/i)
  assert.match(coreSql, /viewer direct DELETE unexpectedly succeeded/i)
  assert.match(coreSql, /viewer UPDATE unexpectedly succeeded/i)
  assert.match(coreSql, /authenticated direct internal save RPC unexpectedly succeeded/i)
  assert.match(coreSql, /backend INSERT response is invalid/i)
  assert.match(coreSql, /backend UPDATE\/revision response is invalid/i)
  assert.match(coreSql, /viewer backend save unexpectedly succeeded/i)
  assert.match(coreSql, /non-member backend save unexpectedly succeeded/i)
  assert.match(coreSql, /cross-workspace backend save unexpectedly succeeded/i)
  assert.match(coreSql, /non-member delete unexpectedly succeeded/i)
  assert.match(coreSql, /cross-workspace delete unexpectedly succeeded/i)
  assert.match(coreSql, /revoked membership delete unexpectedly succeeded/i)
  assert.match(coreSql, /downgraded membership delete unexpectedly succeeded/i)
  assert.match(coreSql, /authenticated must be able to execute page RPC/i)
  assert.match(coreSql, /editor could not read an authorized page/i)
  assert.match(coreSql, /viewer could not read an authorized page/i)
  assert.match(coreSql, /downgraded viewer could not read an authorized empty page/i)
  assert.match(coreSql, /non-member page read unexpectedly succeeded/i)
  assert.match(coreSql, /cross-workspace page read unexpectedly succeeded/i)
  assert.match(coreSql, /anonymous page read unexpectedly succeeded/i)
  assert.match(coreSql, /C-collated page order is unexpected/i)
  assert.match(coreSql, /invalid-version-string/i)
  assert.match(coreSql, /invalid-app-version-string/i)
  assert.match(coreSql, /missing-version/i)
  assert.match(coreSql, /null-version/i)
  assert.match(coreSql, /rollback;/i)

  assert.match(concurrencySql, /extensions\.dblink_send_query/i)
  assert.match(concurrencySql, /wait_event_type = 'Lock'/i)
  assert.match(concurrencySql, /membership role UPDATE did not wait/i)
  assert.match(concurrencySql, /membership DELETE did not wait/i)
  assert.match(concurrencySql, /RPC succeeded after committed downgrade/i)
  assert.match(pageConcurrencySql, /extensions\.dblink_send_query/i)
  assert.match(pageConcurrencySql, /wait_event_type = 'Lock'/i)
  assert.match(pageConcurrencySql, /revocation did not wait for page RPC FOR SHARE lock/i)
  assert.match(pageConcurrencySql, /page RPC succeeded after committed membership revocation/i)
  assert.match(instructions, /disposable/i)
  assert.match(instructions, /psql/i)
  assert.match(instructions, /cloud_event_authorized_page_concurrency\.sql/i)
  assert.match(instructions, /20261008110000_cloud_event_persistence\.sql/i)
  assert.match(instructions, /20261008150000_cloud_event_authorized_save\.sql/i)
  assert.match(instructions, /not a passing database test/i)
})
