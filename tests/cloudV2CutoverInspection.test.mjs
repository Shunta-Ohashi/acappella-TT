import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createCloudV2CutoverInspectionReport,
  parseCloudV2CutoverInspection,
} from '../src/cloud/cloudV2CutoverInspection.ts'
import {
  createCloudV2AtomicCutoverPlan,
} from '../src/cloud/cloudV2AtomicCutover.ts'
import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'
import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
} from '../src/cloud/cloudWorkspaceMasterBackfill.ts'
import {
  createPostgresJsonbSha256Fingerprint,
  serializePostgresJsonbText,
} from '../src/cloud/postgresJsonbFingerprint.ts'
import {
  sanitizePsqlDiagnostic,
  validateDatabaseUrl as validateCleanupConcurrencyDatabaseUrl,
} from '../scripts/cloudV2CutoverInspectionCleanupConcurrency.mjs'
import {
  validateDatabaseUrl as validateBackfillIntegrationDatabaseUrl,
} from '../scripts/cloudV2CutoverInspectionBackfillIntegration.mjs'

const workspaceId = '78000000-0000-4000-8000-000000000001'
const timestamp = '2026-10-14T00:00:00.000Z'
const inspectionRunnerPath = fileURLToPath(new URL(
  '../scripts/cloudV2CutoverInspection.mjs',
  import.meta.url,
))
const backfillIntegrationRunnerPath = fileURLToPath(new URL(
  '../scripts/cloudV2CutoverInspectionBackfillIntegration.mjs',
  import.meta.url,
))
const cleanupConcurrencyRunnerPath = fileURLToPath(new URL(
  '../scripts/cloudV2CutoverInspectionCleanupConcurrency.mjs',
  import.meta.url,
))

const runInspectionCli = (args, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    inspectionRunnerPath,
    ...args,
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: '',
      ACAPPELLA_TT_CUTOVER_INSPECTION_SERVICE_ROLE_KEY: 'test-service-role-key',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error('Cutover inspection CLI test timed out.'))
  }, 10_000)
  child.once('error', error => {
    clearTimeout(timeout)
    reject(error)
  })
  child.once('close', code => {
    clearTimeout(timeout)
    resolve({ code, stdout, stderr })
  })
})

const runBackfillIntegrationCli = (args, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    backfillIntegrationRunnerPath,
    ...args,
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error('Backfill integration CLI test timed out.'))
  }, 10_000)
  child.once('error', error => {
    clearTimeout(timeout)
    reject(error)
  })
  child.once('close', code => {
    clearTimeout(timeout)
    resolve({ code, stdout, stderr })
  })
})

const runCleanupConcurrencyCli = (args, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    cleanupConcurrencyRunnerPath,
    ...args,
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error('Cleanup concurrency CLI test timed out.'))
  }, 10_000)
  child.once('error', error => {
    clearTimeout(timeout)
    reject(error)
  })
  child.once('close', code => {
    clearTimeout(timeout)
    resolve({ code, stdout, stderr })
  })
})

const withInspectionServer = async (response, run) => {
  let requestBody = ''
  const server = createServer((request, result) => {
    request.setEncoding('utf8')
    request.on('data', chunk => { requestBody += chunk })
    request.on('end', () => {
      result.writeHead(200, { 'content-type': 'application/json' })
      result.end(JSON.stringify(response))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return await run(`http://127.0.0.1:${address.port}`, () => requestBody)
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

const createState = (eventId = 'event-a', suffix = 'a') => ({
  members: [{ id: `member-${suffix}`, realName: 'Alice Private', active: true }],
  bands: [{
    id: `band-${suffix}`, name: 'Private Band',
    defaultMemberIds: [`member-${suffix}`], active: true,
  }],
  events: [{
    id: eventId, name: `Event ${eventId}`, timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5, 10],
  }],
  eventDays: [{ id: `day-${eventId}`, eventId, date: '2026-10-14', order: 0 }],
  stages: [{
    id: `stage-${eventId}`, eventDayId: `day-${eventId}`,
    name: 'Main', order: 0, plannedStartTime: '10:00',
  }],
  sections: [{
    id: `section-${eventId}`, stageId: `stage-${eventId}`,
    name: 'Part 1', order: 0, plannedStartTime: '10:00', plannedEndTime: '12:00',
  }],
  eventMembers: [{
    id: `event-member-${eventId}`, eventId, memberId: `member-${suffix}`,
    paCapabilities: { main: true, sub: true },
  }],
  eventMemberDays: [],
  eventBands: [{
    id: `event-band-${eventId}`, eventId, eventDayId: `day-${eventId}`,
    bandId: `band-${suffix}`, name: 'Live',
    memberIds: [`member-${suffix}`], durationMinutes: 5,
  }],
  scheduleItems: [{
    id: `item-${eventId}`, stageId: `stage-${eventId}`,
    sectionId: `section-${eventId}`, kind: 'performance',
    eventBandId: `event-band-${eventId}`, order: 0,
  }],
  paAssignments: [], dutyTypes: [], dutyAssignments: [],
  timetableLocks: [], timetableOrderConstraints: [],
})

const createSourceEvent = async (eventId = 'event-a', suffix = 'a') => {
  const state = createState(eventId, suffix)
  const created = createCloudEventSnapshot(state, eventId)
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('fixture snapshot failed')
  const snapshotFingerprint = await createPostgresJsonbSha256Fingerprint(created.snapshot)
  assert.ok(snapshotFingerprint)
  return {
    workspaceId, eventId, eventName: state.events[0].name,
    snapshot: created.snapshot, snapshotFingerprint, revision: 1,
  }
}

const refreshSnapshotFingerprint = async event => {
  const snapshotFingerprint = await createPostgresJsonbSha256Fingerprint(event.snapshot)
  assert.ok(snapshotFingerprint)
  event.snapshotFingerprint = snapshotFingerprint
}

const emptyExisting = {
  members: 0, bands: 0, bandMembers: 0,
  eventMemberReferences: 0, eventBandReferences: 0,
  completedBackfills: 0, completedBackfill: null,
}

const createRawInspection = async ({
  backfilled = true,
  workspaceStatus = 'legacy',
  events,
} = {}) => {
  const sourceEvents = events ?? [await createSourceEvent()]
  const source = {
    status: 'ok', workspaceId, workspaceStatus: 'legacy',
    workspaceGeneration: '7', events: sourceEvents, existing: emptyExisting,
  }
  const planned = createCloudWorkspaceMasterBackfillPlan(source)
  assert.equal(planned.ok, true)
  if (!planned.ok) throw new Error('fixture plan failed')
  const fingerprint = await createCloudWorkspaceMasterBackfillFingerprint(planned.plan)
  const members = backfilled ? planned.plan.members.map(value => ({
    kind: 'member', workspaceId, value, revision: 1,
    createdAt: timestamp, updatedAt: timestamp,
  })) : []
  const bands = backfilled ? planned.plan.bands.map(value => ({
    kind: 'band', workspaceId, value, revision: 1,
    createdAt: timestamp, updatedAt: timestamp,
  })) : []
  const bandMembers = backfilled
    ? planned.plan.bandMembers.map(relation => ({ workspaceId, ...relation })) : []
  const eventMemberReferences = backfilled
    ? planned.plan.eventMemberReferences.map(relation => ({ workspaceId, ...relation })) : []
  const eventBandReferences = backfilled
    ? planned.plan.eventBandReferences.map(relation => ({ workspaceId, ...relation })) : []
  const existing = backfilled ? {
    members: members.length, bands: bands.length, bandMembers: bandMembers.length,
    eventMemberReferences: eventMemberReferences.length,
    eventBandReferences: eventBandReferences.length,
    completedBackfills: 1,
    completedBackfill: {
      planFingerprint: fingerprint, sourceGeneration: '7', resultGeneration: '7',
      eventCount: sourceEvents.length, memberCount: members.length, bandCount: bands.length,
      bandMemberRelationCount: bandMembers.length,
      eventMemberReferenceCount: eventMemberReferences.length,
      eventBandReferenceCount: eventBandReferences.length,
    },
  } : { ...emptyExisting }
  return {
    status: 'ok', workspaceId, workspaceStatus, workspaceGeneration: '7',
    events: sourceEvents.map(event => ({ ...event, snapshotVersion: event.snapshot.version })),
    existing,
    masters: { members, bands },
    relations: { bandMembers, eventMemberReferences, eventBandReferences },
    counts: {
      events: sourceEvents.length, members: members.length, bands: bands.length,
      bandMembers: bandMembers.length,
      eventMemberReferences: eventMemberReferences.length,
      eventBandReferences: eventBandReferences.length,
    },
  }
}

const clone = value => structuredClone(value)

test('PostgreSQL 17 jsonb text and SHA-256 vector covers ordering and escaping', async () => {
  const value = {
    nested: { longer: 0, x: 'tab\t' },
    z: '雪😀',
    a: [1, true, null, { bb: 2, c: 'quote"\\\n' }],
  }
  const expectedText = '{"a": [1, true, null, {"c": "quote\\"\\\\\\n", "bb": 2}], "z": "雪😀", "nested": {"x": "tab\\t", "longer": 0}}'
  assert.equal(serializePostgresJsonbText(value), expectedText)
  assert.equal(
    await createPostgresJsonbSha256Fingerprint(value),
    'edd018adc71fa0af7c3d41d4aa8813092b1e74ab0fe7398f598afad545008565',
  )
  assert.equal(serializePostgresJsonbText({ value: 1.5 }), undefined)
  assert.equal(serializePostgresJsonbText({ value: '\ud800' }), undefined)
})

test('inspection verifies every Snapshot body against its PostgreSQL fingerprint', async () => {
  const valid = await createRawInspection()
  assert.ok(await parseCloudV2CutoverInspection(valid, workspaceId))

  const changedBody = clone(valid)
  changedBody.events[0].snapshot.appState.events[0].name = 'Changed body'
  assert.equal(await parseCloudV2CutoverInspection(changedBody, workspaceId), undefined)

  const changedFingerprint = clone(valid)
  changedFingerprint.events[0].snapshotFingerprint = '0'.repeat(64)
  assert.equal(await parseCloudV2CutoverInspection(changedFingerprint, workspaceId), undefined)

  const changedEventOwnedCollection = clone(valid)
  changedEventOwnedCollection.events[0].snapshot.appState.sections[0].name = 'Changed section'
  assert.equal(
    await parseCloudV2CutoverInspection(changedEventOwnedCollection, workspaceId),
    undefined,
  )

  const multiple = await createRawInspection({
    events: [await createSourceEvent('event-a', 'a'), await createSourceEvent('event-b', 'b')],
  })
  multiple.events[1].snapshot.appState.scheduleItems[0].order = 1
  assert.equal(await parseCloudV2CutoverInspection(multiple, workspaceId), undefined)
})

test('inspection accepts verified Unicode, escapes, nesting, and integer numbers', async () => {
  const sourceEvent = await createSourceEvent()
  const eventName = '雪😀 "quote" \\ line\nnext'
  sourceEvent.eventName = eventName
  sourceEvent.snapshot.appState.events[0].name = eventName
  sourceEvent.snapshot.appState.members[0].realName = '奏者\t雪😀'
  sourceEvent.snapshot.appState.bands[0].name = 'Band \\ "A"'
  await refreshSnapshotFingerprint(sourceEvent)

  const raw = await createRawInspection({ events: [sourceEvent] })
  const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
  assert.ok(report)
  assert.equal(report.referenceEvidence.status, 'consistent')
  assert.equal(report.preflight.structuralStatus, 'convertible')
})

test('cutover inspection accepts complete evidence and keeps cutover disabled', async () => {
  const raw = await createRawInspection()
  const before = clone(raw)
  const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
  assert.ok(report)
  assert.equal(report.referenceEvidence.status, 'consistent')
  assert.equal(report.preflight.structuralStatus, 'convertible')
  assert.equal(report.preflight.cutoverReadiness, 'indeterminate')
  assert.equal(report.preflight.safeToCutover, false)
  assert.equal(report.preflight.unverifiedRequirements.includes(
    'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED'), false)
  assert.deepEqual(raw, before)
})

test('atomic cutover helper builds one complete V2 plan without changing inspection safety', async () => {
  const raw = await createRawInspection({
    events: [
      await createSourceEvent('event-a', 'a'),
      await createSourceEvent('event-b', 'a'),
    ],
  })
  const before = clone(raw)
  const result = await createCloudV2AtomicCutoverPlan(raw, workspaceId)
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error(result.reason)

  assert.equal(result.plan.version, 1)
  assert.equal(result.plan.workspaceId, workspaceId)
  assert.equal(result.plan.expectedGeneration, '7')
  assert.equal(
    result.plan.expectedBackfillPlanFingerprint,
    raw.existing.completedBackfill.planFingerprint,
  )
  assert.deepEqual(result.plan.events.map(event => event.eventId), ['event-a', 'event-b'])
  for (const plannedEvent of result.plan.events) {
    const source = raw.events.find(event => event.eventId === plannedEvent.eventId)
    assert.ok(source)
    assert.equal(plannedEvent.expectedRevision, source.revision)
    assert.equal(
      plannedEvent.expectedSnapshotFingerprint,
      source.snapshotFingerprint,
    )
    const expectedEventState = clone(source.snapshot.appState)
    delete expectedEventState.members
    delete expectedEventState.bands
    assert.deepEqual(plannedEvent.snapshotV2.eventState, expectedEventState)
    assert.equal('members' in plannedEvent.snapshotV2.eventState, false)
    assert.equal('bands' in plannedEvent.snapshotV2.eventState, false)
    assert.deepEqual(plannedEvent.snapshotV2.masterReferences, {
      memberIds: ['member-a'],
      bandIds: ['band-a'],
    })
  }
  assert.deepEqual(result.summary, {
    eventCount: 2,
    memberCount: 1,
    bandCount: 1,
    eventMemberReferenceCount: 2,
    eventBandReferenceCount: 2,
  })
  assert.deepEqual(raw, before)

  const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
  assert.ok(report)
  assert.equal(report.preflight.safeToCutover, false)
  assert.equal(report.preflight.cutoverReadiness, 'indeterminate')
})

test('atomic cutover helper rejects incomplete, non-legacy, or inconsistent evidence', async () => {
  const empty = await createCloudV2AtomicCutoverPlan(
    await createRawInspection({ events: [] }),
    workspaceId,
  )
  assert.equal(empty.ok, true)
  if (empty.ok) assert.deepEqual(empty.plan.events, [])

  const unbackfilled = await createCloudV2AtomicCutoverPlan(
    await createRawInspection({ backfilled: false }),
    workspaceId,
  )
  assert.deepEqual(unbackfilled, { ok: false, reason: 'BACKFILL_NOT_COMPLETED' })

  const ready = await createCloudV2AtomicCutoverPlan(
    await createRawInspection({ workspaceStatus: 'ready' }),
    workspaceId,
  )
  assert.deepEqual(ready, { ok: false, reason: 'WORKSPACE_NOT_LEGACY' })

  const conflict = await createCloudV2AtomicCutoverPlan(
    await createRawInspection({ workspaceStatus: 'conflict' }),
    workspaceId,
  )
  assert.deepEqual(conflict, { ok: false, reason: 'WORKSPACE_NOT_LEGACY' })

  const partialReference = await createRawInspection()
  partialReference.relations.eventMemberReferences = []
  partialReference.existing.eventMemberReferences = 0
  partialReference.counts.eventMemberReferences = 0
  const inconsistent = await createCloudV2AtomicCutoverPlan(
    partialReference,
    workspaceId,
  )
  assert.deepEqual(inconsistent, {
    ok: false,
    reason: 'EVIDENCE_NOT_CONSISTENT',
  })

  const changedSnapshot = await createRawInspection()
  changedSnapshot.events[0].snapshot.appState.sections[0].name = 'stale body'
  assert.deepEqual(
    await createCloudV2AtomicCutoverPlan(changedSnapshot, workspaceId),
    { ok: false, reason: 'INVALID_INSPECTION' },
  )
})

test('cutover inspection distinguishes an unbackfilled Workspace', async () => {
  const report = await createCloudV2CutoverInspectionReport(
    await createRawInspection({ backfilled: false }), workspaceId,
  )
  assert.ok(report)
  assert.equal(report.referenceEvidence.status, 'not-backfilled')
  assert.ok(report.preflight.issues.some(issue =>
    issue.code === 'REFERENCE_INDEX_NOT_BACKFILLED'))
  assert.ok(report.preflight.unverifiedRequirements.includes('BACKFILL_NOT_COMPLETED'))
})

test('cutover inspection detects a partial reference index by exact key', async () => {
  const raw = await createRawInspection({ backfilled: false })
  raw.masters.members = [{
    kind: 'member', workspaceId,
    value: { id: 'member-a', realName: 'Alice Private', active: true },
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  }]
  raw.existing.members = 1
  raw.counts.members = 1
  raw.relations.eventMemberReferences = [{ workspaceId, eventId: 'event-a', memberId: 'member-a' }]
  raw.existing.eventMemberReferences = 1
  raw.counts.eventMemberReferences = 1
  const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
  assert.ok(report)
  assert.equal(report.referenceEvidence.status, 'partial')
  assert.ok(report.referenceEvidence.mismatchedRelations.includes('eventBandReferences'))
  assert.deepEqual(report.referenceEvidence.affectedEventIds, ['event-a'])
  assert.ok(report.preflight.issues.some(issue => issue.code === 'REFERENCE_INDEX_MISMATCH'))
  assert.equal(report.preflight.unverifiedRequirements.includes(
    'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED'), false)
})

test('plan construction failures keep reference evidence indeterminate and unobserved', async () => {
  const sharedConflict = await createRawInspection({
    backfilled: false,
    events: [await createSourceEvent('event-a', 'a'), await createSourceEvent('event-b', 'b')],
  })
  const conflictingState = sharedConflict.events[1].snapshot.appState
  conflictingState.members[0].id = 'member-a'
  conflictingState.members[0].realName = 'Conflicting Alice'
  conflictingState.eventMembers[0].memberId = 'member-a'
  conflictingState.bands[0].defaultMemberIds = ['member-a']
  conflictingState.eventBands[0].memberIds = ['member-a']
  await refreshSnapshotFingerprint(sharedConflict.events[1])

  const invalidMember = await createRawInspection({ backfilled: false })
  invalidMember.events[0].snapshot.appState.members[0].realName = ''
  await refreshSnapshotFingerprint(invalidMember.events[0])

  const invalidBand = await createRawInspection({ backfilled: false })
  invalidBand.events[0].snapshot.appState.bands[0].name = ''
  await refreshSnapshotFingerprint(invalidBand.events[0])

  for (const [raw, issueCode] of [
    [sharedConflict, 'SHARED_MASTER_CONFLICT'],
    [invalidMember, 'INVALID_MEMBER'],
    [invalidBand, 'INVALID_BAND'],
  ]) {
    const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
    assert.ok(report)
    assert.equal(report.referenceEvidence.status, 'indeterminate')
    assert.equal(report.referenceEvidence.expectedCounts, undefined)
    assert.ok(report.preflight.issues.some(issue => issue.code === issueCode))
    assert.ok(report.preflight.unverifiedRequirements.includes(
      'REFERENCE_INDEX_CONTENTS_NOT_OBSERVED',
    ))
    assert.equal(report.preflight.safeToCutover, false)
  }
})

test('multiple Events compare exact relation combinations, not counts alone', async () => {
  const raw = await createRawInspection({
    events: [await createSourceEvent('event-a', 'a'), await createSourceEvent('event-b', 'b')],
  })
  const valid = await createCloudV2CutoverInspectionReport(raw, workspaceId)
  assert.ok(valid)
  assert.equal(valid.referenceEvidence.status, 'consistent')

  const wrongPairs = clone(raw)
  wrongPairs.relations.eventMemberReferences = [
    { workspaceId, eventId: 'event-a', memberId: 'member-b' },
    { workspaceId, eventId: 'event-b', memberId: 'member-a' },
  ]
  const wrongPairReport = await createCloudV2CutoverInspectionReport(wrongPairs, workspaceId)
  assert.ok(wrongPairReport)
  assert.equal(wrongPairReport.referenceEvidence.status, 'inconsistent')
  assert.deepEqual(wrongPairReport.referenceEvidence.mismatchedRelations,
    ['eventMemberReferences'])
  assert.deepEqual(wrongPairReport.referenceEvidence.affectedEventIds, ['event-a', 'event-b'])

  const extra = clone(raw)
  extra.relations.eventMemberReferences.splice(1, 0, {
    workspaceId, eventId: 'event-a', memberId: 'member-b',
  })
  extra.counts.eventMemberReferences += 1
  extra.existing.eventMemberReferences += 1
  const extraReport = await createCloudV2CutoverInspectionReport(extra, workspaceId)
  assert.ok(extraReport)
  assert.equal(extraReport.referenceEvidence.status, 'inconsistent')
})

test('normalized Master mismatch is independent from exact reference evidence', async () => {
  const raw = await createRawInspection()
  raw.masters.members[0].value.realName = 'Changed Private Name'
  const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
  assert.ok(report)
  assert.equal(report.referenceEvidence.status, 'consistent')
  assert.ok(report.preflight.issues.some(issue => issue.code === 'NORMALIZED_MASTER_MISMATCH'))
  assert.equal(report.preflight.safeToCutover, false)
})

test('empty Workspace and expected-generation mismatch remain fail closed', async () => {
  const raw = await createRawInspection({ events: [] })
  const report = await createCloudV2CutoverInspectionReport(raw, workspaceId, '6')
  assert.ok(report)
  assert.equal(report.referenceEvidence.status, 'consistent')
  assert.equal(report.preflight.structuralStatus, 'convertible')
  assert.ok(report.preflight.issues.some(issue => issue.code === 'GENERATION_EVIDENCE_MISMATCH'))
  assert.equal(report.preflight.cutoverReadiness, 'blocked')
  assert.equal(report.preflight.safeToCutover, false)
})

test('inspection rejects count, duplicate, cross-Workspace, dangling, and missing evidence', async () => {
  const base = await createRawInspection()
  const wrongCount = clone(base)
  wrongCount.counts.members += 1
  const duplicate = clone(base)
  duplicate.relations.eventMemberReferences.push(clone(duplicate.relations.eventMemberReferences[0]))
  duplicate.counts.eventMemberReferences += 1
  duplicate.existing.eventMemberReferences += 1
  const crossWorkspace = clone(base)
  crossWorkspace.masters.members[0].workspaceId = '78000000-0000-4000-8000-000000000002'
  const dangling = clone(base)
  dangling.relations.eventMemberReferences[0].memberId = 'missing-member'
  const missingField = clone(base)
  delete missingField.relations
  for (const value of [wrongCount, duplicate, crossWorkspace, dangling, missingField]) {
    assert.equal(await parseCloudV2CutoverInspection(value, workspaceId), undefined)
  }
})

test('inspection validates snapshot version, bigint generation, and Band member order', async () => {
  const base = await createRawInspection()
  const wrongVersion = clone(base)
  wrongVersion.events[0].snapshotVersion = 2
  const wrongGeneration = clone(base)
  wrongGeneration.workspaceGeneration = '9223372036854775808'
  const positionGap = clone(base)
  positionGap.relations.bandMembers[0].position = 1
  for (const value of [wrongVersion, wrongGeneration, positionGap]) {
    assert.equal(await parseCloudV2CutoverInspection(value, workspaceId), undefined)
  }
})

test('conflict and ready statuses retain status blockers while validating evidence', async () => {
  for (const workspaceStatus of ['conflict', 'ready']) {
    const report = await createCloudV2CutoverInspectionReport(
      await createRawInspection({ workspaceStatus }), workspaceId,
    )
    assert.ok(report)
    assert.equal(report.referenceEvidence.status, 'consistent')
    assert.ok(report.preflight.issues.some(issue => issue.code === (
      workspaceStatus === 'conflict' ? 'WORKSPACE_CONFLICT' : 'WORKSPACE_ALREADY_READY'
    )))
    assert.equal(report.preflight.safeToCutover, false)
  }
})

test('all completed backfill counts independently block otherwise consistent evidence', async () => {
  const countKeys = [
    'eventCount',
    'memberCount',
    'bandCount',
    'bandMemberRelationCount',
    'eventMemberReferenceCount',
    'eventBandReferenceCount',
  ]
  for (const key of countKeys) {
    const raw = await createRawInspection()
    raw.existing.completedBackfill[key] += 1
    const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)

    assert.ok(report, key)
    assert.equal(report.referenceEvidence.status, 'consistent', key)
    assert.ok(report.preflight.issues.some(
      issue => issue.code === 'BACKFILL_STATE_INCONSISTENT',
    ), key)
    assert.equal(report.preflight.cutoverReadiness, 'blocked', key)
    assert.equal(report.preflight.safeToCutover, false, key)
  }
})

test('operator runner exits 2 for every inconsistent completed backfill count', async () => {
  const countKeys = [
    'eventCount',
    'memberCount',
    'bandCount',
    'bandMemberRelationCount',
    'eventMemberReferenceCount',
    'eventBandReferenceCount',
  ]
  for (const key of countKeys) {
    const raw = await createRawInspection()
    raw.existing.completedBackfill[key] += 1
    const result = await withInspectionServer(raw, url => runInspectionCli([
      '--workspace-id', workspaceId,
    ], {
      ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: url,
    }))

    assert.equal(result.code, 2, `${key}: ${result.stderr}`)
    assert.match(result.stdout, /"cutoverReadiness": "blocked"/u, key)
    assert.match(result.stdout, /"code": "BACKFILL_STATE_INCONSISTENT"/u, key)
    assert.match(result.stdout, /"status": "consistent"/u, key)
    assert.match(result.stdout, /"safeToCutover": false/u, key)
  }
})

test('completed backfill record presence and count contradictions stay blocked', async () => {
  const fixtures = []
  for (const completedBackfills of [0, 2]) {
    const raw = await createRawInspection()
    raw.existing.completedBackfills = completedBackfills
    fixtures.push(raw)
  }
  const missingRecord = await createRawInspection()
  missingRecord.existing.completedBackfill = null
  fixtures.push(missingRecord)

  for (const raw of fixtures) {
    const report = await createCloudV2CutoverInspectionReport(raw, workspaceId)
    assert.ok(report)
    assert.equal(report.referenceEvidence.status, 'consistent')
    assert.ok(report.preflight.issues.some(
      issue => issue.code === 'BACKFILL_STATE_INCONSISTENT',
    ))
    assert.equal(report.preflight.cutoverReadiness, 'blocked')
    assert.equal(report.preflight.safeToCutover, false)
  }
})

test('inspection diagnostics omit Snapshot and Master display values', async () => {
  const report = await createCloudV2CutoverInspectionReport(
    await createRawInspection({ backfilled: false }), workspaceId,
  )
  assert.ok(report)
  const diagnostics = JSON.stringify({
    preflight: report.preflight,
    referenceEvidence: report.referenceEvidence,
  })
  assert.doesNotMatch(diagnostics, /Alice Private|Private Band|event_snapshot|snapshot/i)
})

test('inspection migration is atomic, read-only, and service-role-only', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261014100000_cloud_v2_cutover_inspection.sql', import.meta.url,
  ), 'utf8')
  assert.match(sql, /^\s*--[\s\S]*?\bbegin;/i)
  assert.match(sql, /commit;\s*$/i)
  assert.match(sql, /security definer/i)
  assert.match(sql, /set search_path = ''/i)
  assert.match(sql, /cloud_workspace_master_states[\s\S]*for share;[\s\S]*cloud_event_workspace_generations[\s\S]*for share;/i)
  assert.match(sql, /grant execute[\s\S]*to service_role;/i)
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated, service_role;/i)
  const start = sql.indexOf('as $$')
  const functionBody = sql.slice(start, sql.indexOf('$$;', start))
  assert.doesNotMatch(functionBody, /\b(insert into|update public\.|delete from|truncate)\b/i)
})

test('operator runner is read-only, redacts raw evidence, and rejects unknown options', async () => {
  const runner = await readFile(new URL('../scripts/cloudV2CutoverInspection.mjs', import.meta.url), 'utf8')
  assert.match(runner, /inspect_cloud_v2_cutover_state/)
  assert.doesNotMatch(runner, /--apply|backfill_workspace_masters_validated/)
  assert.match(runner, /Unknown argument/)
  assert.match(runner, /confirmedWorkspaceId !== workspaceId/)
  assert.match(runner, /confirmedTarget !== target/)
  assert.doesNotMatch(runner, /report\.inspection/)
})

test('operator runner rejects malformed target URLs without exposing environment values', async () => {
  const secret = 'url-password-must-not-leak'
  const malformedUrl = `http://operator:${secret}@[`
  const malformed = await runInspectionCli([
    '--workspace-id', workspaceId,
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: malformedUrl,
  })
  assert.equal(malformed.code, 1)
  assert.match(malformed.stderr, /SUPABASE_URL must be a valid URL/iu)
  assert.doesNotMatch(malformed.stderr, new RegExp(secret, 'u'))
  assert.doesNotMatch(malformed.stderr, /operator:/u)

  const userInfo = await runInspectionCli([
    '--workspace-id', workspaceId,
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL:
      `http://operator:${secret}@127.0.0.1:1`,
  })
  assert.equal(userInfo.code, 1)
  assert.match(userInfo.stderr, /must not contain user information/iu)
  assert.doesNotMatch(userInfo.stderr, new RegExp(secret, 'u'))

  const empty = await runInspectionCli([
    '--workspace-id', workspaceId,
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: '',
  })
  assert.equal(empty.code, 1)
  assert.match(empty.stderr, /SUPABASE_URL.*SERVICE_ROLE_KEY.*required/isu)
  assert.doesNotMatch(empty.stderr, /test-service-role-key/u)

  const wrongScheme = await runInspectionCli([
    '--workspace-id', workspaceId,
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: 'ftp://inspection.invalid',
  })
  assert.equal(wrongScheme.code, 1)
  assert.match(wrongScheme.stderr, /must use HTTPS/iu)
})

test('operator runner accepts one leading separator and normalizes Workspace UUIDs', async () => {
  const raw = await createRawInspection()
  const result = await withInspectionServer(raw, async (url, getRequestBody) => {
    const executed = await runInspectionCli([
      '--', '--workspace-id', workspaceId.toUpperCase(),
    ], {
      ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: url,
    })
    return { ...executed, requestBody: getRequestBody() }
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.requestBody).p_workspace_id, workspaceId)
  assert.match(result.stdout, new RegExp(`"workspaceId": "${workspaceId}"`, 'u'))

  for (const args of [
    ['--workspace-id', workspaceId, '--workspace-id', workspaceId],
    ['--workspace-id', workspaceId, '--', '--confirm-target', 'https://example.invalid'],
    ['--workspace-id'],
    ['--workspace-id', '   '],
    ['--workspace-id', workspaceId, '--confirm-workspace-id', '   '],
    ['--workspace-id', workspaceId, '--confirm-target', '   '],
    ['--workspace-id', 'not-a-uuid'],
  ]) {
    const rejected = await runInspectionCli(args, {})
    assert.equal(rejected.code, 1)
  }

  const differentConfirmation = await runInspectionCli([
    '--workspace-id', workspaceId.toUpperCase(),
    '--confirm-workspace-id', '78000000-0000-4000-8000-000000000002',
    '--confirm-target', 'https://inspection.invalid',
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: 'https://inspection.invalid',
  })
  assert.equal(differentConfirmation.code, 1)
  assert.match(differentConfirmation.stderr, /Remote inspection requires/iu)
})

test('operator runner returns exit code 2 for blocked readiness without issues', async () => {
  const raw = await createRawInspection({ events: [], backfilled: false })
  const result = await withInspectionServer(raw, url => runInspectionCli([
    '--workspace-id', workspaceId,
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: url,
  }))
  assert.equal(result.code, 2, result.stderr)
  assert.match(result.stdout, /"cutoverReadiness": "blocked"/u)
  assert.match(result.stdout, /"issues": \[\]/u)
  assert.match(result.stdout, /"safeToCutover": false/u)
})

test('operator runner exit codes distinguish consistent evidence from blocked evidence', async () => {
  const runRaw = raw => withInspectionServer(raw, url => runInspectionCli([
    '--workspace-id', workspaceId,
  ], {
    ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL: url,
  }))

  const emptyBackfilled = await runRaw(await createRawInspection({ events: [] }))
  assert.equal(emptyBackfilled.code, 0, emptyBackfilled.stderr)

  const multipleEvents = [
    await createSourceEvent('event-a', 'a'),
    await createSourceEvent('event-b', 'b'),
  ]
  const consistentMultiple = await runRaw(await createRawInspection({
    events: multipleEvents,
  }))
  assert.equal(consistentMultiple.code, 0, consistentMultiple.stderr)

  const mismatchedReferences = await createRawInspection({ events: multipleEvents })
  mismatchedReferences.relations.eventMemberReferences[0].memberId = 'member-b'
  const referenceMismatch = await runRaw(mismatchedReferences)
  assert.equal(referenceMismatch.code, 2, referenceMismatch.stderr)
  assert.match(referenceMismatch.stdout, /"status": "inconsistent"/u)

  const conflictingMasterEvidence = await createRawInspection({ events: multipleEvents })
  const conflictingState = conflictingMasterEvidence.events[1].snapshot.appState
  conflictingState.members[0].id = 'member-a'
  conflictingState.members[0].realName = 'Conflicting private value'
  conflictingState.bands[0].defaultMemberIds = ['member-a']
  conflictingState.eventMembers[0].memberId = 'member-a'
  conflictingState.eventBands[0].memberIds = ['member-a']
  await refreshSnapshotFingerprint(conflictingMasterEvidence.events[1])
  const structuralFailure = await runRaw(conflictingMasterEvidence)
  assert.equal(structuralFailure.code, 2, structuralFailure.stderr)
  assert.match(structuralFailure.stdout, /"structuralStatus": "not-convertible"/u)
})

test('backfilled inspection integration runner is isolated, rollback-only, and secret-safe', async () => {
  const runner = await readFile(new URL(
    '../scripts/cloudV2CutoverInspectionBackfillIntegration.mjs', import.meta.url,
  ), 'utf8')
  assert.match(runner, /--confirm-disposable/u)
  assert.match(runner, /expectedDatabasePort = '55822'/u)
  assert.match(runner, /randomUUID\(\)/u)
  assert.match(runner, /createCloudEventSnapshot/u)
  assert.match(runner, /createCloudWorkspaceMasterBackfillPlan/u)
  assert.match(runner, /createCloudWorkspaceMasterBackfillFingerprint/u)
  assert.match(runner, /backfill_workspace_masters_validated/u)
  assert.match(runner, /inspect_cloud_v2_cutover_state/u)
  assert.match(runner, /createCloudV2CutoverInspectionReport/u)
  assert.match(runner, /begin;/u)
  assert.match(runner, /rollback;/u)
  assert.doesNotMatch(runner, /\bcommit\s*;/iu)
  assert.doesNotMatch(runner, /\b(delete\s+from|truncate|db\s+reset)\b/iu)
  for (const relation of [
    'workspaces', 'workspace_members', 'cloud_events',
    'cloud_workspace_master_states', 'cloud_event_workspace_generations',
    'workspace_master_members', 'workspace_master_bands',
    'workspace_master_band_members', 'cloud_event_member_references',
    'cloud_event_band_references', 'cloud_workspace_master_backfills',
  ]) assert.match(runner, new RegExp(relation, 'u'))

  const missingConfirmation = await runBackfillIntegrationCli([
    '--db-url-env', 'ACAPPELLA_TT_INTEGRATION_TEST_URL',
  ], {
    ACAPPELLA_TT_INTEGRATION_TEST_URL:
      'postgresql://postgres:secret@127.0.0.1:55822/postgres',
  })
  assert.equal(missingConfirmation.code, 1)
  assert.match(missingConfirmation.stderr, /--confirm-disposable/u)
  assert.doesNotMatch(missingConfirmation.stderr, /secret/u)

  const password = 'integration-password-must-not-leak'
  const malformed = await runBackfillIntegrationCli([
    '--db-url-env', 'ACAPPELLA_TT_INTEGRATION_TEST_URL',
    '--confirm-disposable',
  ], {
    ACAPPELLA_TT_INTEGRATION_TEST_URL: `postgresql://postgres:${password}@[`,
  })
  assert.equal(malformed.code, 1)
  assert.match(malformed.stderr, /URL is invalid/u)
  assert.doesNotMatch(malformed.stderr, new RegExp(password, 'u'))

  const wrongPort = await runBackfillIntegrationCli([
    '--db-url-env', 'ACAPPELLA_TT_INTEGRATION_TEST_URL',
    '--confirm-disposable',
  ], {
    ACAPPELLA_TT_INTEGRATION_TEST_URL:
      'postgresql://postgres:secret@127.0.0.1:54322/postgres',
  })
  assert.equal(wrongPort.code, 1)
  assert.match(wrongPort.stderr, /port 55822/u)
  assert.doesNotMatch(wrongPort.stderr, /secret/u)

  const unsafeQueryPassword = 'query-password-must-not-leak'
  const unsafeQuery = await runBackfillIntegrationCli([
    '--db-url-env', 'ACAPPELLA_TT_INTEGRATION_TEST_URL',
    '--confirm-disposable',
  ], {
    ACAPPELLA_TT_INTEGRATION_TEST_URL:
      `postgresql://postgres:${unsafeQueryPassword}@127.0.0.1:55822/postgres?host=elsewhere`,
  })
  assert.equal(unsafeQuery.code, 1)
  assert.match(unsafeQuery.stderr, /unsupported query parameter/u)
  assert.doesNotMatch(unsafeQuery.stderr, new RegExp(unsafeQueryPassword, 'u'))
  assert.doesNotMatch(unsafeQuery.stderr, /psql could not be started/u)
})

test('backfill integration database URL accepts only a bounded connect_timeout', () => {
  for (const url of [
    'postgresql://postgres:secret@127.0.0.1:55822/postgres',
    'postgres://postgres:secret@localhost:55822/postgres?connect_timeout=1',
    'postgresql://postgres:secret@[::1]:55822/postgres?connect_timeout=30',
    'postgresql://postgres:secret@127.0.0.1:55822/postgres?connect%5Ftimeout=15',
  ]) assert.doesNotThrow(() => validateBackfillIntegrationDatabaseUrl(url), url)

  for (const value of ['0', '31', '01', '-1', '1.5', '1e1', '', ' 5']) {
    const url = `postgresql://postgres:secret@127.0.0.1:55822/postgres?connect_timeout=${value}`
    assert.throws(
      () => validateBackfillIntegrationDatabaseUrl(url),
      /connect_timeout must be an integer from 1 through 30/u,
      value,
    )
  }
  assert.throws(
    () => validateBackfillIntegrationDatabaseUrl(
      'postgresql://postgres:secret@127.0.0.1:55822/postgres' +
      '?connect_timeout=5&connect%5Ftimeout=6',
    ),
    /duplicate connect_timeout/u,
  )
})

test('backfill integration database URL rejects overrides, fragments, and malformed escapes', () => {
  for (const parameter of [
    'host=elsewhere',
    'hostaddr=127.0.0.2',
    'port=5432',
    'dbname=elsewhere',
    'service=production',
    'options=-csearch_path%3Dpublic',
    'sslmode=disable',
  ]) {
    assert.throws(
      () => validateBackfillIntegrationDatabaseUrl(
        `postgresql://postgres:secret@127.0.0.1:55822/postgres?${parameter}`,
      ),
      /unsupported query parameter/u,
      parameter,
    )
  }
  for (const fragment of ['#remote', '#']) {
    assert.throws(
      () => validateBackfillIntegrationDatabaseUrl(
        `postgresql://postgres:secret@127.0.0.1:55822/postgres${fragment}`,
      ),
      /must not contain a fragment/u,
      fragment,
    )
  }

  const secret = 'percent-secret-must-not-leak'
  for (const url of [
    `postgresql://postgres:${secret}%ZZ@127.0.0.1:55822/postgres`,
    `postgresql://postgres:${secret}@127.0.0.1:55822/post%ZZgres`,
    `postgresql://postgres:${secret}@127.0.0.1:55822/postgres?connect_timeout=%ZZ`,
  ]) {
    let caught
    try {
      validateBackfillIntegrationDatabaseUrl(url)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof Error)
    assert.match(caught.message, /invalid percent-encoding/u)
    assert.equal(caught.message.includes(secret), false)
    assert.equal(caught.message.includes(url), false)
    assert.equal(caught.cause, undefined)
  }
})

test('cleanup concurrency database URL is restricted before psql starts', async () => {
  for (const url of [
    'postgresql://postgres:secret@127.0.0.1:55822/postgres',
    'postgres://postgres:secret@localhost:55822/postgres?connect_timeout=10',
  ]) assert.doesNotThrow(() => validateCleanupConcurrencyDatabaseUrl(url), url)

  for (const [url, pattern] of [
    ['postgresql://postgres:secret@127.0.0.1:54322/postgres', /port 55822/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/other', /postgres database/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?host=elsewhere', /unsupported/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?hostaddr=127.0.0.2', /unsupported/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?port=5432', /unsupported/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?dbname=other', /unsupported/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?service=other', /unsupported/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?options=-cstatement_timeout%3D0', /unsupported/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?connect_timeout=0', /1 through 30/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?connect_timeout=31', /1 through 30/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?connect_timeout=5&connect_timeout=6', /duplicate/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres#other', /fragment/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres#', /fragment/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/post%ZZgres', /percent-encoding/u],
    ['postgresql://postgres:secret%ZZ@127.0.0.1:55822/postgres', /percent-encoding/u],
    ['postgresql://postgres:secret@127.0.0.1:55822/postgres?connect_timeout=%ZZ', /percent-encoding/u],
  ]) assert.throws(() => validateCleanupConcurrencyDatabaseUrl(url), pattern, url)

  const password = 'cleanup-url-password-must-not-leak'
  const rejected = await runCleanupConcurrencyCli([
    '--db-url-env', 'ACAPPELLA_TT_CLEANUP_TEST_URL',
    '--confirm-disposable',
  ], {
    ACAPPELLA_TT_CLEANUP_TEST_URL:
      `postgresql://postgres:${password}@127.0.0.1:55822/postgres?host=elsewhere`,
  })
  assert.equal(rejected.code, 1)
  assert.match(rejected.stderr, /unsupported query parameter/u)
  assert.doesNotMatch(rejected.stderr, new RegExp(password, 'u'))
  assert.doesNotMatch(rejected.stderr, /psql could not be started/u)
})

test('disposable SQL fixtures verify isolation, ACL, generation locking, and async drain', async () => {
  const [
    contractSql,
    concurrencySql,
    cleanupSql,
    cleanupConcurrencySql,
    cleanupConcurrencyRunner,
    fingerprintSql,
    packageJson,
  ] = await Promise.all([
    readFile(new URL('../supabase/tests/cloud_v2_cutover_inspection.sql', import.meta.url), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_v2_cutover_inspection_concurrency.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_v2_cutover_inspection_concurrency_cleanup.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_v2_cutover_inspection_cleanup_concurrency.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../scripts/cloudV2CutoverInspectionCleanupConcurrency.mjs', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_v2_cutover_inspection_fingerprint.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  assert.match(fingerprintSql, /payload::text is distinct from expected_text/i)
  assert.match(fingerprintSql, /extensions\.digest\(payload::text, 'sha256'\)/i)
  assert.match(
    fingerprintSql,
    /edd018adc71fa0af7c3d41d4aa8813092b1e74ab0fe7398f598afad545008565/i,
  )
  assert.match(contractSql, /has_function_privilege\('service_role'/i)
  assert.match(contractSql, /has_function_privilege\('authenticated'/i)
  assert.match(contractSql, /has_function_privilege\('anon'/i)
  assert.match(contractSql, /other_workspace_id/i)
  assert.match(contractSql, /generation_after is distinct from generation_before/i)
  for (const arrayPath of [
    "result -> 'events'",
    "result -> 'masters' -> 'members'",
    "result -> 'masters' -> 'bands'",
    "result -> 'relations' -> 'bandMembers'",
    "result -> 'relations' -> 'eventMemberReferences'",
    "result -> 'relations' -> 'eventBandReferences'",
  ]) {
    assert.ok(contractSql.includes(`jsonb_typeof(${arrayPath})`))
    assert.ok(contractSql.includes(`jsonb_array_length(${arrayPath})`))
  }
  for (const countField of [
    'events', 'members', 'bands', 'bandMembers',
    'eventMemberReferences', 'eventBandReferences',
  ]) {
    assert.ok(contractSql.includes(
      `jsonb_typeof(result -> 'counts' -> '${countField}')`,
    ))
    assert.ok(contractSql.includes(
      `result -> 'counts' ->> '${countField}' is distinct from '0'`,
    ))
  }
  assert.doesNotMatch(contractSql, /jsonb_array_length\([^\n]+\) <> 0/iu)
  assert.match(contractSql, /rollback;\s*$/i)

  assert.match(concurrencySql, /lock table public\.cloud_workspace_master_backfills/i)
  assert.match(concurrencySql, /wait_event_type = 'Lock'/i)
  assert.equal((concurrencySql.match(/dblink_send_query/gu) ?? []).length, 2)
  assert.equal((concurrencySql.match(/dblink_get_result/gu) ?? []).length, 4)
  assert.equal((concurrencySql.match(/statement_timeout/gu) ?? []).length, 2)
  assert.equal((concurrencySql.match(/lock_timeout/gu) ?? []).length, 2)
  assert.doesNotMatch(concurrencySql, /deadlock_timeout/iu)
  assert.match(concurrencySql, /perform pg_catalog\.pg_stat_clear_snapshot\(\)/iu)
  assert.match(concurrencySql, /inspection generation FOR SHARE/i)
  assert.match(
    concurrencySql,
    /jsonb_typeof\(inspected -> 'workspaceGeneration'\) is distinct from 'string'/iu,
  )
  assert.match(
    concurrencySql,
    /inspected ->> 'workspaceGeneration' is distinct from '1'/iu,
  )
  assert.match(concurrencySql, /current_generation is distinct from 2/iu)
  assert.doesNotMatch(
    concurrencySql,
    /workspaceGeneration'\)::bigint (?:>= current_generation|is distinct from 1)/iu,
  )
  assert.match(concurrencySql, /where id = '79500000-0000-4000-8000-000000000001'/i)
  assert.doesNotMatch(concurrencySql, /truncate|delete\s+from\s+auth\.users/iu)

  const fixtureSetup = concurrencySql.slice(
    0,
    concurrencySql.indexOf('insert into public.workspaces'),
  )
  assert.doesNotMatch(fixtureSetup, /delete\s+from\s+public\.workspaces/iu)
  assert.match(fixtureSetup, /Dedicated cutover inspection concurrency fixture already exists/iu)
  assert.match(concurrencySql, /fixture cleanup was incomplete/iu)

  assert.match(cleanupSql, /begin;[\s\S]*commit;/iu)
  assert.match(cleanupSql, /name is distinct from fixture_workspace_name/iu)
  assert.match(cleanupSql, /expected_before_snapshot := jsonb_build_object/iu)
  assert.match(cleanupSql, /expected_after_snapshot := jsonb_set/iu)
  for (const collection of [
    'members',
    'bands',
    'eventDays',
    'stages',
    'sections',
    'eventMembers',
    'eventMemberDays',
    'eventBands',
    'scheduleItems',
    'paAssignments',
    'dutyTypes',
    'dutyAssignments',
    'timetableLocks',
    'timetableOrderConstraints',
  ]) {
    assert.ok(cleanupSql.includes(`'${collection}', '[]'::jsonb`))
  }
  assert.match(cleanupSql, /fixture_event_count not in \(0, 1\)/iu)
  assert.match(cleanupSql, /fixture_master_status is distinct from 'legacy'/iu)
  assert.match(cleanupSql, /fixture_event_snapshot is not distinct from expected_before_snapshot/iu)
  assert.match(cleanupSql, /fixture_event_snapshot is not distinct from expected_after_snapshot/iu)
  assert.match(cleanupSql, /fixture_event_revision is not distinct from 1[\s\S]*fixture_generation is not distinct from 1/iu)
  assert.match(cleanupSql, /fixture_event_revision is not distinct from 2[\s\S]*fixture_generation is not distinct from 2/iu)
  assert.match(cleanupSql, /fixture_event_count = 0[\s\S]*fixture_generation is distinct from 0/iu)
  assert.doesNotMatch(cleanupSql, /generation between 0 and 2/iu)
  assert.match(cleanupSql, /refusing automatic cleanup/iu)
  assert.match(
    cleanupSql,
    /begin;[\s\S]*set transaction isolation level read committed;/iu,
  )
  const lockPhase = cleanupSql.slice(
    cleanupSql.indexOf('-- Freeze every writable edge'),
    cleanupSql.indexOf('select count(*)'),
  )
  assert.equal((lockPhase.match(/for update nowait/giu) ?? []).length, 20)
  assert.equal((lockPhase.match(/from public\.workspace_members/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.cloud_events/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.workspace_master_members/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.workspace_master_bands/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.workspace_master_band_members/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.cloud_event_member_references/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.cloud_event_band_references/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.cloud_workspace_master_backfills/giu) ?? []).length, 2)
  assert.equal((lockPhase.match(/from public\.workspaces/giu) ?? []).length, 1)
  assert.equal(
    (lockPhase.match(/from public\.cloud_event_workspace_generations/giu) ?? []).length,
    1,
  )
  assert.match(lockPhase, /when lock_not_available[\s\S]*errcode = '55000'/iu)
  assert.doesNotMatch(lockPhase, /lock table/iu)
  const cleanupGateIndex = lockPhase.indexOf(
    'pg_catalog.pg_advisory_xact_lock(cleanup_test_gate_key::bigint)',
  )
  assert.ok(cleanupGateIndex > lockPhase.indexOf('cloud_event_workspace_generations'))
  const cleanupGuard = cleanupSql.slice(
    cleanupSql.indexOf('select count(*)'),
    cleanupSql.indexOf('delete from public.workspaces'),
  )
  for (const guardedTable of [
    'workspace_members',
    'workspace_master_members',
    'workspace_master_bands',
    'workspace_master_band_members',
    'cloud_event_member_references',
    'cloud_event_band_references',
    'cloud_workspace_master_backfills',
  ]) {
    assert.match(cleanupGuard, new RegExp(`public\\.${guardedTable}`, 'u'))
  }
  assert.equal(
    (cleanupSql.match(/errcode = '55000'/giu) ?? []).length,
    (cleanupSql.match(/raise exception/giu) ?? []).length,
  )
  const cleanupDeleteIndex = cleanupSql.indexOf('delete from public.workspaces')
  assert.ok(cleanupDeleteIndex > cleanupSql.indexOf('expected_after_snapshot'))
  assert.doesNotMatch(
    cleanupSql.slice(0, cleanupDeleteIndex),
    /\b(insert into|update public\.|delete from|truncate)\b/iu,
  )
  const postDeleteChecks = cleanupSql.slice(cleanupDeleteIndex)
  for (const cleanedTable of [
    'workspaces',
    'workspace_members',
    'cloud_events',
    'workspace_master_members',
    'workspace_master_bands',
    'workspace_master_band_members',
    'cloud_event_member_references',
    'cloud_event_band_references',
    'cloud_workspace_master_backfills',
    'cloud_workspace_master_states',
    'cloud_event_workspace_generations',
  ]) {
    assert.match(postDeleteChecks, new RegExp(`public\\.${cleanedTable}`, 'u'))
  }
  assert.doesNotMatch(cleanupSql, /truncate|delete\s+from\s+auth\.users/iu)

  assert.match(cleanupConcurrencySql, /Setup only/iu)
  assert.match(cleanupConcurrencySql, /confirm_cleanup_concurrency_fixture/iu)
  assert.match(cleanupConcurrencySql, /fixture already exists; inspect it/iu)
  const setupBeforeInsert = cleanupConcurrencySql.slice(
    0,
    cleanupConcurrencySql.indexOf('insert into auth.users'),
  )
  assert.doesNotMatch(setupBeforeInsert, /delete\s+from/iu)
  assert.doesNotMatch(cleanupConcurrencySql, /dblink_|pg_advisory_xact_lock/iu)

  assert.match(cleanupConcurrencyRunner, /cleanupSqlPath/iu)
  assert.match(cleanupConcurrencyRunner, /runCleanup\(databaseUrl/iu)
  assert.equal(
    (cleanupConcurrencyRunner.match(/assertCleanupRejected\(await runCleanup/gu) ?? []).length,
    2,
  )
  assert.match(cleanupConcurrencyRunner, /Actual cleanup did not report SQLSTATE 55000/iu)
  assert.match(cleanupConcurrencyRunner, /cloud-v2-cleanup-event-first/iu)
  assert.match(cleanupConcurrencyRunner, /cloud-v2-cleanup-membership-first/iu)
  assert.match(cleanupConcurrencyRunner, /cloud-v2-cleanup-actual-gated/iu)
  assert.equal(
    (cleanupConcurrencyRunner.match(/event_snapshot = jsonb_set/gu) ?? []).length,
    2,
  )
  assert.match(
    cleanupConcurrencyRunner,
    /set event_name = 'Uncommitted Event writer',[\s\S]*to_jsonb\('Uncommitted Event writer'::text\)/u,
  )
  assert.match(
    cleanupConcurrencyRunner,
    /set event_name = 'Unexpected concurrent write',[\s\S]*to_jsonb\('Unexpected concurrent write'::text\)/u,
  )
  assert.match(cleanupConcurrencyRunner, /stderrBuffer[\s\S]*sanitizePsqlDiagnostic/iu)
  assert.match(cleanupConcurrencyRunner, /waitForLock[\s\S]*expectedWaitEvent/iu)
  assert.match(cleanupConcurrencyRunner, /eventWriterResult[\s\S]*membershipWriterResult/iu)
  assert.match(cleanupConcurrencyRunner, /assertFixtureUnchanged/iu)
  assert.match(cleanupConcurrencyRunner, /assertFinalStateIsEmpty/iu)
  assert.match(cleanupConcurrencyRunner, /loopback databases only/iu)
  assert.match(packageJson, /test:cloud-v2-cutover-cleanup-concurrency/iu)
})

test('cleanup concurrency psql diagnostics preserve causes without exposing credentials', () => {
  const databaseUrl = 'postgresql://fixture-user:p%40ss-secret@127.0.0.1:55822/postgres'
  const diagnostic = sanitizePsqlDiagnostic(
    `ERROR: cloud_events_snapshot_shape_check failed\n` +
      `connection=${databaseUrl}\npassword=p@ss-secret`,
    databaseUrl,
  )

  assert.match(diagnostic, /cloud_events_snapshot_shape_check failed/u)
  assert.match(diagnostic, /\[REDACTED/u)
  assert.doesNotMatch(diagnostic, /p%40ss-secret|p@ss-secret|fixture-user/iu)
  assert.doesNotMatch(diagnostic, /postgres(?:ql)?:\/\//iu)
})

test('inspection runbook distinguishes rollback, committed concurrency cleanup, and measured limits', async () => {
  const [runbook, setupGuide, sqlGuide] = await Promise.all([
    readFile(new URL('../docs/cloud-v2-cutover-preflight.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/cloud-setup.md', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/tests/README.md', import.meta.url), 'utf8'),
  ])
  for (const document of [runbook, setupGuide, sqlGuide]) {
    assert.match(document, /55822/iu)
    assert.match(document, /require_auth=scram-sha-256,md5/iu)
    assert.match(document, /dblink_connect_u/iu)
  }
  assert.match(runbook, /終了code 2/iu)
  assert.match(runbook, /終了code 0/iu)
  assert.match(runbook, /全98/iu)
  assert.match(runbook, /通常fixture[\s\S]*ROLLBACK/iu)
  assert.match(runbook, /並行fixture[\s\S]*正常終了時だけ専用Workspaceを削除/iu)
  assert.match(runbook, /Event作成前（generation 0）[\s\S]*Snapshot JSONB全体/iu)
  assert.match(runbook, /test:cloud-v2-cutover-cleanup-concurrency/iu)
  assert.match(runbook, /親Workspaceをlockした後に同じ子行を再走査/iu)
  assert.match(runbook, /writerがgeneration更新lockを先に取得/iu)
  assert.match(runbook, /大規模Workspace/iu)
  assert.match(sqlGuide, /concurrency_cleanup\.sql/iu)
  assert.match(sqlGuide, /test:cloud-v2-cutover-cleanup-concurrency/iu)
  assert.match(sqlGuide, /full Snapshot JSONB/iu)
})
