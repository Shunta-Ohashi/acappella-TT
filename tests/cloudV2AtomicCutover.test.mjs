import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../supabase/migrations/20261015100000_cloud_v2_atomic_cutover.sql',
  import.meta.url,
)
const fixtureUrl = new URL(
  '../supabase/tests/cloud_v2_atomic_cutover.sql',
  import.meta.url,
)
const concurrencyUrl = new URL(
  '../supabase/tests/cloud_v2_atomic_cutover_concurrency.sql',
  import.meta.url,
)

test('atomic cutover migration installs one transactional backend-only contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const executableSql = sql.replace(/^\s*--.*$/gmu, '').trim()
  assert.match(executableSql, /^begin;/iu)
  assert.match(executableSql, /commit;$/iu)
  assert.equal(executableSql.match(/\bbegin;/giu)?.length, 1)
  assert.equal(executableSql.match(/\bcommit;/giu)?.length, 1)
  assert.match(sql, /create function public\.cutover_cloud_v2_validated\([\s\S]*returns jsonb[\s\S]*security definer[\s\S]*set search_path = ''/iu)
  assert.match(sql, /create or replace function public\.guard_ready_workspace_from_v1_event_write\(\)[\s\S]*tg_op = 'INSERT'[\s\S]*from public\.workspaces[\s\S]*for key share/iu)
  assert.match(sql, /revoke all on function public\.cutover_cloud_v2_validated\([\s\S]*from public, anon, authenticated, service_role/iu)
  assert.match(sql, /grant execute on function public\.cutover_cloud_v2_validated\([\s\S]*to service_role/iu)
  assert.match(sql, /has_function_privilege\(authenticated_role_oid, function_oid, 'EXECUTE'\)/iu)
  assert.match(sql, /has_function_privilege\(anon_role_oid, function_oid, 'EXECUTE'\)/iu)
  assert.match(sql, /function_acl\.grantee = 0[\s\S]*privilege_type = 'EXECUTE'/iu)
})

test('atomic cutover validates complete CAS evidence before conversion', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /p_expected_generation !~ '\^\(0\|\[1-9\]\[0-9\]\*\)\$'/u)
  assert.match(sql, /9223372036854775807/u)
  assert.match(sql, /count\(\*\) <> count\(distinct planned_event\.value ->> 'eventId'\)/iu)
  assert.match(sql, /planned_event_count <> \([\s\S]*count\(\*\) from public\.cloud_events/iu)
  assert.match(sql, /cloud_events\.revision is distinct from[\s\S]*expectedRevision/iu)
  assert.match(sql, /extensions\.digest\(cloud_events\.event_snapshot::text, 'sha256'\)/iu)
  assert.match(sql, /completed_backfill\.plan_fingerprint[\s\S]*p_expected_backfill_plan_fingerprint/iu)
  for (const count of [
    'event_count',
    'member_count',
    'band_count',
    'band_member_relation_count',
    'event_member_reference_count',
    'event_band_reference_count',
  ]) assert.match(sql, new RegExp(`completed_backfill\\.${count}`, 'iu'), count)
})

test('atomic cutover lock order freezes inserts, rows, generation, and evidence', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const workspaceLock = sql.indexOf('from public.workspaces')
  const statusShare = sql.indexOf('from public.cloud_workspace_master_states')
  const eventLock = sql.indexOf('from public.cloud_events', statusShare)
  const generationLock = sql.indexOf('from public.cloud_event_workspace_generations')
  const backfillLock = sql.indexOf('from public.cloud_workspace_master_backfills')
  const memberLock = sql.indexOf('perform 1 from public.workspace_master_members')
  const conversion = sql.indexOf('update public.cloud_events')
  const stateUpgrade = sql.lastIndexOf('for update nowait')
  const readyUpdate = sql.indexOf("set status = 'ready'")
  assert.ok(workspaceLock >= 0)
  assert.ok(statusShare > workspaceLock)
  assert.ok(eventLock > statusShare)
  assert.ok(generationLock > eventLock)
  assert.ok(backfillLock > generationLock)
  assert.ok(memberLock > backfillLock)
  assert.ok(conversion > memberLock)
  assert.ok(stateUpgrade > conversion)
  assert.ok(readyUpdate > stateUpgrade)
  assert.match(sql, /Workspace parent[\s\S]*new FK child INSERTs/iu)
  assert.match(sql, /lock_not_available[\s\S]*55P03/iu)
})

test('atomic cutover re-derives V2 Event state and exact Master/reference evidence', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /\(source_row\.event_snapshot -> 'appState'\) - 'members' - 'bands'/iu)
  assert.match(sql, /public\.is_cloud_event_v2_snapshot_shape/iu)
  assert.match(sql, /public\.cloud_event_member_references/iu)
  assert.match(sql, /public\.cloud_event_band_references/iu)
  assert.match(sql, /public\.cloud_event_v2_direct_member_ids/iu)
  assert.match(sql, /public\.cloud_event_v2_direct_band_ids/iu)
  assert.match(sql, /direct_band_ids is distinct from referenced_band_ids/iu)
  assert.match(sql, /not direct_member_ids <@ referenced_member_ids/iu)
  assert.match(sql, /required_member_ids is distinct from referenced_member_ids/iu)
  assert.match(sql, /jsonb_strip_nulls\(jsonb_build_object\([\s\S]*realName/iu)
  assert.match(sql, /defaultMemberIds[\s\S]*order by workspace_master_band_members\.position/iu)
  for (const collection of [
    'events', 'eventDays', 'stages', 'sections', 'eventMembers',
    'eventMemberDays', 'eventBands', 'scheduleItems', 'paAssignments',
    'dutyTypes', 'dutyAssignments', 'timetableLocks',
    'timetableOrderConstraints',
  ]) assert.match(sql, new RegExp(`'${collection}'`, 'u'), collection)
})

test('disposable SQL exercises real RPC success, fail-closed CAS, and mid-loop rollback', async () => {
  const sql = await readFile(fixtureUrl, 'utf8')
  assert.match(sql, /^\\set ON_ERROR_STOP on/mu)
  assert.match(sql, /^begin;/mu)
  assert.match(sql, /rollback;\s*$/iu)
  assert.match(sql, /public\.backfill_workspace_masters_validated/iu)
  assert.match(sql, /public\.cutover_cloud_v2_validated/giu)
  assert.match(sql, /set local role authenticated/iu)
  assert.match(sql, /stale Event Snapshot fingerprint was accepted/iu)
  assert.match(sql, /duplicate Event ID was accepted/iu)
  for (const count of [
    'event_count',
    'member_count',
    'band_count',
    'band_member_relation_count',
    'event_member_reference_count',
    'event_band_reference_count',
  ]) assert.match(sql, new RegExp(`'${count}'`, 'u'), count)
  assert.match(sql, /mismatched normalized Member was accepted/iu)
  assert.match(sql, /mismatched ordered Band members were accepted/iu)
  assert.match(sql, /mismatched Event-Member reference combination was accepted/iu)
  assert.match(sql, /cross-Event duplicate Event-owned ID was accepted/iu)
  assert.match(sql, /conflict Workspace was accepted/iu)
  assert.match(sql, /cloud_v2_atomic_cutover_test_failure/iu)
  assert.match(sql, /old\.event_id = 'event-b'/iu)
  assert.match(sql, /Mid-cutover error did not roll back the complete transaction/iu)
  assert.match(sql, /event_snapshot -> 'version' is distinct from '2'/iu)
  assert.match(sql, /event_snapshot is distinct from[\s\S]*atomic_cutover_snapshot_v2/iu)
  assert.match(sql, /revision is distinct from 2/iu)
  assert.match(sql, /v_master_evidence_before/iu)
  assert.match(sql, /ready Workspace accepted a resumed Snapshot V1 writer/iu)
  assert.match(sql, /changed another Workspace/iu)
})

test('disposable concurrency fixture executes the real cutover RPC in all races', async () => {
  const sql = await readFile(concurrencyUrl, 'utf8')
  assert.match(sql, /public\.cutover_cloud_v2_validated/giu)
  assert.match(sql, /writer-first/iu)
  assert.match(sql, /cutover-first/iu)
  assert.match(sql, /double-cutover/iu)
  assert.match(sql, /cutover-first V1 INSERT unexpectedly succeeded/iu)
  assert.match(sql, /cloud-v2-atomic-inserter/iu)
  assert.match(sql, /V1 INSERT did not wait for the Workspace parent lock/iu)
  assert.match(sql, /wait_event_type = 'Lock'/iu)
  assert.match(sql, /dblink_send_query/iu)
  assert.match(sql, /dblink_get_result/giu)
  assert.match(sql, /remaining_results/iu)
  assert.match(sql, /delete from public\.workspaces[\s\S]*79100000/iu)
})
