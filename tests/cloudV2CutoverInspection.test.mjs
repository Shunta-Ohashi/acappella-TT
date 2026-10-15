import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createCloudV2CutoverInspectionReport,
  parseCloudV2CutoverInspection,
} from '../src/cloud/cloudV2CutoverInspection.ts'
import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'
import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
} from '../src/cloud/cloudWorkspaceMasterBackfill.ts'

const workspaceId = '78000000-0000-4000-8000-000000000001'
const timestamp = '2026-10-14T00:00:00.000Z'

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

const createSourceEvent = (eventId = 'event-a', suffix = 'a') => {
  const state = createState(eventId, suffix)
  const created = createCloudEventSnapshot(state, eventId)
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('fixture snapshot failed')
  return {
    workspaceId, eventId, eventName: state.events[0].name,
    snapshot: created.snapshot, snapshotFingerprint: 'a'.repeat(64), revision: 1,
  }
}

const emptyExisting = {
  members: 0, bands: 0, bandMembers: 0,
  eventMemberReferences: 0, eventBandReferences: 0,
  completedBackfills: 0, completedBackfill: null,
}

const createRawInspection = async ({
  backfilled = true,
  workspaceStatus = 'legacy',
  events = [createSourceEvent()],
} = {}) => {
  const source = {
    status: 'ok', workspaceId, workspaceStatus: 'legacy',
    workspaceGeneration: '7', events, existing: emptyExisting,
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
      eventCount: events.length, memberCount: members.length, bandCount: bands.length,
      bandMemberRelationCount: bandMembers.length,
      eventMemberReferenceCount: eventMemberReferences.length,
      eventBandReferenceCount: eventBandReferences.length,
    },
  } : { ...emptyExisting }
  return {
    status: 'ok', workspaceId, workspaceStatus, workspaceGeneration: '7',
    events: events.map(event => ({ ...event, snapshotVersion: event.snapshot.version })),
    existing,
    masters: { members, bands },
    relations: { bandMembers, eventMemberReferences, eventBandReferences },
    counts: {
      events: events.length, members: members.length, bands: bands.length,
      bandMembers: bandMembers.length,
      eventMemberReferences: eventMemberReferences.length,
      eventBandReferences: eventBandReferences.length,
    },
  }
}

const clone = value => structuredClone(value)

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
})

test('multiple Events compare exact relation combinations, not counts alone', async () => {
  const raw = await createRawInspection({
    events: [createSourceEvent('event-a', 'a'), createSourceEvent('event-b', 'b')],
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
    assert.equal(parseCloudV2CutoverInspection(value, workspaceId), undefined)
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
    assert.equal(parseCloudV2CutoverInspection(value, workspaceId), undefined)
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

test('disposable SQL fixtures verify isolation, ACL, generation locking, and async drain', async () => {
  const [contractSql, concurrencySql] = await Promise.all([
    readFile(new URL('../supabase/tests/cloud_v2_cutover_inspection.sql', import.meta.url), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_v2_cutover_inspection_concurrency.sql', import.meta.url,
    ), 'utf8'),
  ])
  assert.match(contractSql, /has_function_privilege\('service_role'/i)
  assert.match(contractSql, /has_function_privilege\('authenticated'/i)
  assert.match(contractSql, /has_function_privilege\('anon'/i)
  assert.match(contractSql, /other_workspace_id/i)
  assert.match(contractSql, /generation_after is distinct from generation_before/i)
  assert.match(contractSql, /rollback;\s*$/i)

  assert.match(concurrencySql, /lock table public\.cloud_workspace_master_backfills/i)
  assert.match(concurrencySql, /wait_event_type = 'Lock'/i)
  assert.equal((concurrencySql.match(/dblink_send_query/gu) ?? []).length, 2)
  assert.equal((concurrencySql.match(/dblink_get_result/gu) ?? []).length, 4)
  assert.match(concurrencySql, /inspection generation FOR SHARE/i)
  assert.match(concurrencySql, /where id = '79500000-0000-4000-8000-000000000001'/i)
  assert.doesNotMatch(concurrencySql, /truncate|delete\s+from\s+auth\.users/iu)
})
