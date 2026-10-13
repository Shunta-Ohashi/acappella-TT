import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
  parseCloudWorkspaceMasterBackfillSource,
} from '../src/cloud/cloudWorkspaceMasterBackfill.ts'
import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'

const workspaceId = '71000000-0000-0000-0000-000000000001'
const emptyExisting = {
  members: 0,
  bands: 0,
  bandMembers: 0,
  eventMemberReferences: 0,
  eventBandReferences: 0,
  completedBackfills: 0,
  completedBackfill: null,
}

const createState = ({
  eventId = 'event-a',
  member = { id: 'member-a', realName: 'Alice', active: true },
  band = {
    id: 'band-a', name: 'Alpha', defaultMemberIds: ['member-b', 'member-a'], active: true,
  },
} = {}) => ({
  members: [member, { id: 'member-b', realName: 'Bob', active: true }],
  bands: [band],
  events: [{
    id: eventId,
    name: `Event ${eventId}`,
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5],
  }],
  eventDays: [{ id: `day-${eventId}`, eventId, date: '2026-10-13', order: 0 }],
  stages: [{
    id: `stage-${eventId}`,
    eventDayId: `day-${eventId}`,
    name: 'Main',
    order: 0,
    plannedStartTime: '10:00',
  }],
  sections: [],
  eventMembers: [{
    id: `event-member-${eventId}`,
    eventId,
    memberId: 'member-a',
    paCapabilities: { main: true, sub: true },
  }],
  eventMemberDays: [],
  eventBands: [{
    id: `event-band-${eventId}`,
    eventId,
    eventDayId: `day-${eventId}`,
    bandId: 'band-a',
    name: 'Alpha live',
    memberIds: ['member-a'],
    durationMinutes: 5,
  }],
  scheduleItems: [],
  paAssignments: [{
    id: `pa-${eventId}`,
    eventId,
    eventDayId: `day-${eventId}`,
    stageId: `stage-${eventId}`,
    memberId: 'member-a',
    role: 'main',
    from: { kind: 'time', time: '10:00' },
    until: { kind: 'time', time: '10:05' },
  }],
  dutyTypes: [{ id: `duty-${eventId}`, eventId, name: 'Reception', order: 0 }],
  dutyAssignments: [{
    id: `assignment-${eventId}`,
    dutyTypeId: `duty-${eventId}`,
    eventDayId: `day-${eventId}`,
    stageId: `stage-${eventId}`,
    memberId: 'member-a',
    from: { kind: 'time', time: '10:00' },
    until: { kind: 'time', time: '10:05' },
  }],
  timetableLocks: [],
  timetableOrderConstraints: [],
})

const createSourceEvent = (eventId, state = createState({ eventId }), revision = 1) => {
  const created = createCloudEventSnapshot(state, eventId)
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('fixture snapshot failed')
  return {
    workspaceId,
    eventId,
    eventName: state.events[0].name,
    snapshot: created.snapshot,
    snapshotFingerprint: eventId === 'event-a' ? 'a'.repeat(64) : 'b'.repeat(64),
    revision,
  }
}

const createSource = (events, overrides = {}) => ({
  status: 'ok',
  workspaceId,
  workspaceStatus: 'legacy',
  workspaceGeneration: '7',
  events,
  existing: { ...emptyExisting },
  ...overrides,
})

test('V1 backfill planは複数Eventの同一Masterを統合し順序付きclosureを決定的に生成する', async () => {
  const eventA = createSourceEvent('event-a')
  const eventB = createSourceEvent('event-b', createState({ eventId: 'event-b' }), 3)
  const forwardSource = createSource([eventA, eventB])
  const before = structuredClone(forwardSource)
  const forward = createCloudWorkspaceMasterBackfillPlan(forwardSource)
  const reverse = createCloudWorkspaceMasterBackfillPlan(createSource([eventB, eventA]))

  assert.equal(forward.ok, true)
  assert.equal(reverse.ok, true)
  assert.deepEqual(forwardSource, before)
  if (!forward.ok || !reverse.ok) return
  assert.deepEqual(reverse.plan, forward.plan)
  assert.deepEqual(forward.plan.members.map(member => member.id), ['member-a', 'member-b'])
  assert.deepEqual(forward.plan.bands.map(band => band.id), ['band-a'])
  assert.deepEqual(forward.plan.bandMembers, [
    { bandId: 'band-a', memberId: 'member-b', position: 0 },
    { bandId: 'band-a', memberId: 'member-a', position: 1 },
  ])
  assert.deepEqual(forward.plan.eventMemberReferences, [
    { eventId: 'event-a', memberId: 'member-a' },
    { eventId: 'event-a', memberId: 'member-b' },
    { eventId: 'event-b', memberId: 'member-a' },
    { eventId: 'event-b', memberId: 'member-b' },
  ])
  assert.deepEqual(forward.report, {
    workspaceId,
    eventCount: 2,
    memberCount: 2,
    bandCount: 1,
    bandMemberRelationCount: 2,
    eventMemberReferenceCount: 4,
    eventBandReferenceCount: 2,
    conflictCount: 0,
    conflicts: [],
    eligible: true,
    issues: [],
    canRecoverUnreferencedMasters: false,
  })
  assert.equal(
    await createCloudWorkspaceMasterBackfillFingerprint(forward.plan),
    await createCloudWorkspaceMasterBackfillFingerprint(reverse.plan),
  )
})

test('Member/Band内容とdefaultMemberIds順序の競合を値を漏らさずfail closedにする', () => {
  const eventA = createSourceEvent('event-a')
  const changedState = createState({
    eventId: 'event-b',
    member: { id: 'member-a', realName: 'Alice Updated', active: true },
    band: {
      id: 'band-a', name: 'Alpha Updated',
      defaultMemberIds: ['member-a', 'member-b'], active: true,
    },
  })
  const result = createCloudWorkspaceMasterBackfillPlan(createSource([
    eventA,
    createSourceEvent('event-b', changedState),
    createSourceEvent('event-c', createState({ eventId: 'event-c' })),
  ]))
  assert.equal(result.ok, false)
  assert.deepEqual(result.report.conflicts, [
    { kind: 'band', id: 'band-a', eventIds: ['event-a', 'event-b', 'event-c'] },
    { kind: 'member', id: 'member-a', eventIds: ['event-a', 'event-b', 'event-c'] },
  ])
  assert.equal(result.report.conflictCount, 2)
  assert.equal(JSON.stringify(result.report).includes('Alice Updated'), false)
})

test('Cloud Master validator違反とPostgreSQL integer範囲外をplan前に拒否する', () => {
  const state = createState({
    member: {
      id: 'member-a', realName: 'Alice', entryAcademicYear: 2_147_483_648, active: true,
    },
  })
  const result = createCloudWorkspaceMasterBackfillPlan(createSource([
    createSourceEvent('event-a', state),
  ]))
  assert.equal(result.ok, false)
  assert.deepEqual(result.report.issues, [{
    code: 'INVALID_MEMBER',
    eventId: 'event-a',
    kind: 'member',
    masterId: 'member-a',
  }])
})

test('空のdefaultMemberIdsを保持し、欠落Master closureとmalformed V1はfail closedにする', () => {
  const emptyBandState = createState({
    band: { id: 'band-a', name: 'Alpha', defaultMemberIds: [], active: true },
  })
  const valid = createCloudWorkspaceMasterBackfillPlan(createSource([
    createSourceEvent('event-a', emptyBandState),
  ]))
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.deepEqual(valid.plan.bandMembers, [])
    assert.deepEqual(valid.plan.members.map(member => member.id), ['member-a'])
  }

  const missingMember = structuredClone(createSourceEvent('event-a'))
  missingMember.snapshot.appState.members = missingMember.snapshot.appState.members
    .filter(member => member.id !== 'member-b')
  assert.equal(parseCloudWorkspaceMasterBackfillSource(
    createSource([missingMember]),
  ), undefined)
  assert.deepEqual(
    createCloudWorkspaceMasterBackfillPlan(createSource([missingMember])).report.issues,
    [{ code: 'INVALID_SOURCE' }],
  )

  const missingBand = structuredClone(createSourceEvent('event-a'))
  missingBand.snapshot.appState.bands = []
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource([missingBand])), undefined)

  const malformed = structuredClone(createSourceEvent('event-a'))
  malformed.snapshot.appState.eventMembers = null
  assert.doesNotThrow(() => parseCloudWorkspaceMasterBackfillSource(
    createSource([malformed]),
  ))
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource([malformed])), undefined)
})

test('statusと既存の部分backfill dataを明示検査し無断上書きしない', () => {
  const sourceEvent = createSourceEvent('event-a')
  const ready = createCloudWorkspaceMasterBackfillPlan(createSource([sourceEvent], {
    workspaceStatus: 'ready',
  }))
  assert.equal(ready.ok, false)
  assert.deepEqual(ready.report.issues, [{ code: 'WORKSPACE_NOT_LEGACY' }])

  const partial = createCloudWorkspaceMasterBackfillPlan(createSource([sourceEvent], {
    existing: { ...emptyExisting, members: 1 },
  }))
  assert.equal(partial.ok, false)
  assert.deepEqual(partial.report.issues, [{ code: 'EXISTING_NORMALIZED_DATA' }])
})

test('完了応答を失った後も同一計画だけをidempotent retryとして再構成する', async () => {
  const event = createSourceEvent('event-a')
  const initial = createCloudWorkspaceMasterBackfillPlan(createSource([event]))
  assert.equal(initial.ok, true)
  if (!initial.ok) return
  const fingerprint = await createCloudWorkspaceMasterBackfillFingerprint(initial.plan)
  const completed = createCloudWorkspaceMasterBackfillPlan(createSource([event], {
    workspaceGeneration: '13',
    existing: {
      members: 2,
      bands: 1,
      bandMembers: 2,
      eventMemberReferences: 2,
      eventBandReferences: 1,
      completedBackfills: 1,
      completedBackfill: {
        planFingerprint: fingerprint,
        sourceGeneration: '7',
        resultGeneration: '13',
        eventCount: 1,
        memberCount: 2,
        bandCount: 1,
        bandMemberRelationCount: 2,
        eventMemberReferenceCount: 2,
        eventBandReferenceCount: 1,
      },
    },
  }))
  assert.equal(completed.ok, true)
  if (!completed.ok) return
  assert.equal(completed.plan.sourceGeneration, '7')
  assert.equal(
    await createCloudWorkspaceMasterBackfillFingerprint(completed.plan),
    fingerprint,
  )

  const changedAfterCompletion = createCloudWorkspaceMasterBackfillPlan(createSource([event], {
    workspaceGeneration: '14',
    existing: completed.ok ? {
      members: 2,
      bands: 1,
      bandMembers: 2,
      eventMemberReferences: 2,
      eventBandReferences: 1,
      completedBackfills: 1,
      completedBackfill: {
        planFingerprint: fingerprint,
        sourceGeneration: '7',
        resultGeneration: '13',
        eventCount: 1,
        memberCount: 2,
        bandCount: 1,
        bandMemberRelationCount: 2,
        eventMemberReferenceCount: 2,
        eventBandReferenceCount: 1,
      },
    } : emptyExisting,
  }))
  assert.equal(changedAfterCompletion.ok, false)
  assert.ok(changedAfterCompletion.report.issues.some(
    issue => issue.code === 'EXISTING_NORMALIZED_DATA',
  ))
})

test('malformed source・Event ID不一致・revision不正を境界で拒否する', () => {
  const event = createSourceEvent('event-a')
  assert.ok(parseCloudWorkspaceMasterBackfillSource(createSource([event])))
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource([
    { ...event, eventId: 'wrong-event' },
  ])), undefined)
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource([
    { ...event, revision: 0 },
  ])), undefined)
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource([event], {
    workspaceGeneration: '01',
  })), undefined)
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource([
    { ...event, snapshotFingerprint: 'invalid' },
  ])), undefined)
  const sparse = new Array(1)
  assert.equal(parseCloudWorkspaceMasterBackfillSource(createSource(sparse)), undefined)
})

test('CLI境界と同じraw応答からparseとplanを独立して成功させる', () => {
  const rawSource = createSource([createSourceEvent('event-a')])
  const parsedSource = parseCloudWorkspaceMasterBackfillSource(rawSource)

  assert.ok(parsedSource)
  const planned = createCloudWorkspaceMasterBackfillPlan(rawSource)
  assert.equal(planned.ok, true)
  assert.deepEqual({
    events: planned.report.eventCount,
    members: planned.report.memberCount,
    bands: planned.report.bandCount,
  }, { events: 1, members: 2, bands: 1 })

  // The parser intentionally removes the RPC-only `status` envelope field.
  // The planner owns its own raw-response validation and therefore must not
  // receive this already-normalized value from the CLI.
  const reparsed = createCloudWorkspaceMasterBackfillPlan(parsedSource)
  assert.equal(reparsed.ok, false)
  assert.deepEqual(reparsed.report.issues, [{ code: 'INVALID_SOURCE' }])
})

test('backfill migrationはpreview/applyをbackend-only transactionで分離する', async () => {
  const [migration, runner, packageJson, sqlFixture, concurrencyFixture] = await Promise.all([
    readFile(new URL(
      '../supabase/migrations/20261013100000_cloud_workspace_master_backfill.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../scripts/cloudWorkspaceMasterBackfill.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_workspace_master_backfill.sql', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_workspace_master_backfill_concurrency.sql', import.meta.url,
    ), 'utf8'),
  ])
  assert.match(migration, /^\s*--[\s\S]*\nbegin;/i)
  assert.match(migration, /commit;\s*$/i)
  assert.match(migration, /inspect_workspace_master_backfill_source/i)
  assert.match(migration, /backfill_workspace_masters_validated/i)
  assert.match(migration, /order by cloud_events\.event_id collate "C"[\s\S]*for share/i)
  assert.match(migration, /cloud_event_workspace_generations[\s\S]*for update/i)
  assert.match(migration, /digest\(cloud_events\.event_snapshot::text, 'sha256'\)[\s\S]*snapshotFingerprint/i)
  assert.match(migration, /master_status is distinct from 'legacy'/i)
  assert.match(migration, /reference\.value - array\['eventId', 'memberId'\]/i)
  assert.match(migration, /reference\.value - array\['eventId', 'bandId'\]/i)
  assert.match(migration, /count\(distinct \([\s\S]*relation\.value ->> 'position'/i)
  assert.doesNotMatch(migration, /update\s+public\.cloud_events/i)
  assert.doesNotMatch(migration, /update\s+public\.cloud_workspace_master_states/i)
  assert.match(migration, /grant execute[\s\S]*to service_role/i)
  assert.match(migration, /has_function_privilege\('authenticated'/i)
  assert.match(runner, /const apply = process\.argv\.includes\('--apply'\)/)
  assert.match(runner, /--confirm-workspace-id/)
  assert.match(runner, /--confirm-target/)
  assert.match(
    runner,
    /const source = parseCloudWorkspaceMasterBackfillSource\(rawSource\)[\s\S]*const planned = createCloudWorkspaceMasterBackfillPlan\(rawSource\)/,
  )
  assert.doesNotMatch(runner, /createCloudWorkspaceMasterBackfillPlan\(source\)/)
  assert.match(runner, /callBackfill\(false\)[\s\S]*if \(!apply\)/)
  assert.match(runner, /if \(!apply\)[\s\S]*} else {[\s\S]*callBackfill\(true\)/)
  assert.match(packageJson, /cloud:workspace-master-backfill/)
  assert.match(sqlFixture, /begin;[\s\S]*rollback;/i)
  assert.match(sqlFixture, /SQLSTATE 40001/i)
  assert.match(sqlFixture, /workspace Master status changed/i)
  assert.match(sqlFixture, /v_workspace_id constant uuid/i)
  assert.match(
    sqlFixture,
    /select g\.generation into v_source_generation[\s\S]*where g\.workspace_id = v_workspace_id/i,
  )
  assert.doesNotMatch(sqlFixture, /\bworkspace_id constant uuid/i)
  assert.doesNotMatch(
    sqlFixture,
    /cloud_event_workspace_generations\.workspace_id\s*=\s*workspace_id/i,
  )
  assert.match(concurrencyFixture, /dblink_send_query\('backfill_apply'/i)
  assert.match(concurrencyFixture, /wait_event_type = 'Lock'/i)
  assert.match(concurrencyFixture, /exception when sqlstate '40001'/i)
  assert.match(concurrencyFixture, /dblink_get_result\('backfill_apply'\)[\s\S]*dblink_get_result\('backfill_apply'\)/i)
  assert.match(concurrencyFixture, /delete from public\.workspaces[\s\S]*73000000-0000-0000-0000-000000000001/i)
})
