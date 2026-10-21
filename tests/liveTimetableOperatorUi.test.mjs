import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createLiveTimetableRepository,
  parseLiveTimetableDiscovery,
  parseLiveTimetableOperatorCandidates,
} from '../src/live/liveTimetableRepository.ts'
import {
  createLiveTimetableHash,
  resolveLiveTimetableHash,
} from '../src/live/liveTimetableRouting.ts'
import {
  LIVE_TIMETABLE_REALTIME_COLUMNS,
  LIVE_HEALTHY_POLLING_INTERVAL_MS,
  LIVE_STATE_MAX_AGE_MS,
  canApplyLiveRead,
  canRunLiveMutation,
  createLiveTimetableScopeKey,
  getLivePollingDelay,
  isLiveStateStale,
  isLiveTimetableReadAtLeastAsFresh,
  isMatchingLiveRealtimePayload,
} from '../src/live/liveTimetableSync.ts'

const liveId = '10000000-0000-0000-0000-000000000001'
const workspaceId = '20000000-0000-0000-0000-000000000001'
const userId = '30000000-0000-0000-0000-000000000001'

const createLive = ({
  projectionVersion = '1',
  managementRevision = '1',
  stageRevision = '1',
  role = 'viewer',
  canOperate = false,
} = {}) => ({
  liveId,
  publicId: '10000000-0000-0000-0000-000000000002',
  workspaceId,
  eventId: 'event-a',
  eventName: 'Event A',
  timeZone: 'Asia/Tokyo',
  eventDays: [{
    sourceEventDayId: 'day-a', date: '2026-11-01', label: null, position: 0,
  }],
  sourceRevision: 1,
  sourceSnapshotFingerprint: 'a'.repeat(64),
  projectionVersion,
  managementRevision,
  isPublished: true,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  role,
  canManage: role === 'owner',
  operators: [],
  stages: [{
    stageId: '40000000-0000-0000-0000-000000000001',
    sourceEventDayId: 'day-a',
    sourceStageId: 'stage-a',
    eventDayPosition: 0,
    name: 'Main',
    position: 0,
    plannedStartTime: '10:00',
    plannedEndTime: '10:10',
    sections: [],
    revision: stageRevision,
    projectionVersion,
    progressStatus: 'not_started',
    currentEntryPosition: null,
    nextEntryPosition: 0,
    nextPerformancePosition: 0,
    updatedAt: '2026-10-21T00:00:00.000Z',
    canOperate,
    entries: [{
      position: 0,
      kind: 'performance',
      displayName: 'Band A',
      plannedStartMinute: 600,
      plannedEndMinute: 610,
      status: 'pending',
      actualStartedAt: null,
      actualEndedAt: null,
      sourceScheduleItemId: 'item-a',
      sourceSectionId: null,
      afterSectionId: null,
      startedBy: null,
      endedBy: null,
    }],
  }],
})

test('Live routeはEvent IDを安全に往復し#shareと混同しない', () => {
  const hash = createLiveTimetableHash('event/日本語 & live')
  assert.deepEqual(resolveLiveTimetableHash(hash), {
    kind: 'live', eventId: 'event/日本語 & live',
  })
  assert.equal(resolveLiveTimetableHash('#share=payload'), undefined)
  assert.equal(resolveLiveTimetableHash('#live='), undefined)
  assert.equal(resolveLiveTimetableHash('#live=%E0%A4%A'), undefined)
})

test('Live readはscopeとbigint revision vectorで古い応答を破棄する', () => {
  const scopeKey = createLiveTimetableScopeKey({
    userId, workspaceId, workspaceVisitId: 'visit-1', eventId: 'event-a', liveId,
  })
  const current = createLive({
    projectionVersion: '9223372036854775806',
    managementRevision: '9007199254740993',
    stageRevision: '9007199254740995',
  })
  const olderStage = createLive({
    projectionVersion: '9223372036854775806',
    managementRevision: '9007199254740994',
    stageRevision: '9007199254740994',
  })
  const newerProjection = createLive({
    projectionVersion: '9223372036854775807',
    managementRevision: '1',
    stageRevision: '1',
  })
  assert.equal(isLiveTimetableReadAtLeastAsFresh(olderStage, current), false)
  assert.equal(isLiveTimetableReadAtLeastAsFresh(newerProjection, current), true)
  assert.equal(canApplyLiveRead({
    token: { scopeKey, sequence: 4 },
    activeScopeKey: scopeKey,
    latestAppliedSequence: 3,
    incoming: newerProjection,
    current,
  }), true)
  assert.equal(canApplyLiveRead({
    token: { scopeKey: `${scopeKey}-old`, sequence: 5 },
    activeScopeKey: scopeKey,
    latestAppliedSequence: 3,
    incoming: newerProjection,
    current,
  }), false)
})

test('polling backoff・stale・offline mutation gateはfail closed', () => {
  assert.equal(getLivePollingDelay(0, false), 1_000)
  assert.equal(getLivePollingDelay(4, false), 15_000)
  assert.equal(getLivePollingDelay(99, false), 15_000)
  assert.equal(getLivePollingDelay(0, true), 30_000)
  assert.ok(LIVE_HEALTHY_POLLING_INTERVAL_MS < LIVE_STATE_MAX_AGE_MS)
  assert.equal(isLiveStateStale(undefined, 100), true)
  assert.equal(isLiveStateStale(1_000, 45_000), false)
  assert.equal(isLiveStateStale(1_000, 46_001), true)
  assert.equal(canRunLiveMutation({
    online: true, stale: false, pending: false,
    canOperate: true, progressEnabled: true,
  }), true)
  for (const override of [
    { online: false }, { stale: true }, { pending: true },
    { canOperate: false }, { progressEnabled: false },
  ]) {
    assert.equal(canRunLiveMutation({
      online: true, stale: false, pending: false,
      canOperate: true, progressEnabled: true,
      ...override,
    }), false)
  }
})

test('Realtime更新がない正常な長時間進行でも補助readによりstaleにならない', () => {
  let lastSuccessfulAuthorizedRead = 0
  for (let now = 0; now <= 5 * 60_000; now += 1_000) {
    if (now > 0 && now % LIVE_HEALTHY_POLLING_INTERVAL_MS === 0) {
      lastSuccessfulAuthorizedRead = now
    }
    assert.equal(
      isLiveStateStale(lastSuccessfulAuthorizedRead, now),
      false,
      `normal authorized polling should keep the state fresh at ${now}ms`,
    )
  }
})

test('authorized readが失敗し続ける通信断ではstale後のmutationを停止する', () => {
  const lastSuccessfulAuthorizedRead = 0
  assert.equal(isLiveStateStale(
    lastSuccessfulAuthorizedRead,
    LIVE_STATE_MAX_AGE_MS,
  ), false)
  const stale = isLiveStateStale(
    lastSuccessfulAuthorizedRead,
    LIVE_STATE_MAX_AGE_MS + 1,
  )
  assert.equal(stale, true)
  assert.equal(canRunLiveMutation({
    online: true,
    stale,
    pending: false,
    canOperate: true,
    progressEnabled: true,
  }), false)
})

test('Realtime通知は7列・現在scopeだけを再取得トリガーにする', () => {
  const row = {
    id: '40000000-0000-0000-0000-000000000001',
    workspace_id: workspaceId,
    live_timetable_id: liveId,
    projection_version: 1,
    revision: 2,
    progress_status: 'in_progress',
    updated_at: '2026-10-21T00:00:00.000Z',
  }
  assert.deepEqual(Object.keys(row).sort(), [...LIVE_TIMETABLE_REALTIME_COLUMNS].sort())
  assert.equal(isMatchingLiveRealtimePayload(row, workspaceId, liveId), true)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, name: 'leak' }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, workspace_id: 'other' }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, revision: Number.MAX_SAFE_INTEGER + 1 }, workspaceId, liveId,
  ), false)
  assert.equal(isMatchingLiveRealtimePayload(
    { ...row, progress_status: 'unknown' }, workspaceId, liveId,
  ), false)
})

test('discovery/candidate parserはexact responseとID一意性を要求する', () => {
  assert.deepEqual(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId: null,
  }, workspaceId, 'event-a'), {
    workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId: null,
  })
  assert.equal(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 3, liveId, extra: true,
  }, workspaceId, 'event-a'), undefined)
  assert.equal(parseLiveTimetableDiscovery({
    status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
    sourceRevision: 0, liveId,
  }, workspaceId, 'event-a'), undefined)
  assert.deepEqual(parseLiveTimetableOperatorCandidates({
    status: 'ok', liveId, candidates: [
      { userId, displayName: 'Viewer A' },
    ],
  }, liveId), [{ userId, displayName: 'Viewer A' }])
  assert.equal(parseLiveTimetableOperatorCandidates({
    status: 'ok', liveId, candidates: [
      { userId, displayName: 'Viewer A', email: 'must-not-leak@example.invalid' },
    ],
  }, liveId), undefined)
  assert.equal(parseLiveTimetableOperatorCandidates({
    status: 'ok', liveId, candidates: [
      { userId, displayName: 'A' }, { userId, displayName: 'B' },
    ],
  }, liveId), undefined)
})

test('repositoryは不正discovery/candidate引数でRPCを呼ばない', async () => {
  let calls = 0
  const gateway = {
    async createProjection() { return { data: null, error: null } },
    async loadAuthorized() { return { data: null, error: null } },
    async loadPublic() { return { data: null, error: null } },
    async findForEvent() { calls += 1; return { data: null, error: null } },
    async listOperatorCandidates() { calls += 1; return { data: null, error: null } },
    async setPublication() { return { data: null, error: null } },
    async setStageOperator() { return { data: null, error: null } },
    async transitionEntry() { return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  assert.equal((await repository.findForEvent('bad', 'event-a')).error.code,
    'INVALID_ARGUMENT')
  assert.equal((await repository.findForEvent(workspaceId, '')).error.code,
    'INVALID_ARGUMENT')
  assert.equal((await repository.listOperatorCandidates('bad')).error.code,
    'INVALID_ARGUMENT')
  assert.equal(calls, 0)
})

test('repositoryはdiscovery/candidateのscopeとexact応答を維持する', async () => {
  const calls = []
  const gateway = {
    async createProjection() { return { data: null, error: null } },
    async loadAuthorized() { return { data: null, error: null } },
    async loadPublic() { return { data: null, error: null } },
    async findForEvent(input) {
      calls.push(['find', input])
      return {
        data: {
          status: 'ok', workspaceId, eventId: 'event-a', eventName: 'Event A',
          sourceRevision: 7, liveId,
        },
        error: null,
      }
    },
    async listOperatorCandidates(inputLiveId) {
      calls.push(['candidates', inputLiveId])
      return {
        data: {
          status: 'ok', liveId,
          candidates: [{ userId, displayName: 'Viewer A' }],
        },
        error: null,
      }
    },
    async setPublication() { return { data: null, error: null } },
    async setStageOperator() { return { data: null, error: null } },
    async transitionEntry() { return { data: null, error: null } },
  }
  const repository = createLiveTimetableRepository(gateway)
  assert.deepEqual(await repository.findForEvent(workspaceId, 'event-a'), {
    ok: true,
    value: {
      workspaceId, eventId: 'event-a', eventName: 'Event A',
      sourceRevision: 7, liveId,
    },
  })
  assert.deepEqual(await repository.listOperatorCandidates(liveId), {
    ok: true,
    value: [{ userId, displayName: 'Viewer A' }],
  })
  assert.deepEqual(calls, [
    ['find', { workspaceId, eventId: 'event-a' }],
    ['candidates', liveId],
  ])
})

test('migration #16はviewer grant snapshot・public分離・RPC ACLを追加する', async () => {
  const sql = await readFile(new URL(
    '../supabase/migrations/20261021050414_live_timetable_operator_ui.sql',
    import.meta.url,
  ), 'utf8')
  assert.equal((sql.match(/^begin;$/gmi) ?? []).length, 1)
  assert.equal((sql.match(/^commit;$/gmi) ?? []).length, 1)
  assert.match(sql, /add column granted_role text/i)
  assert.match(sql, /set granted_role = 'editor'/i)
  assert.match(sql, /granted_role in \('editor', 'viewer'\)/i)
  assert.match(sql, /assignment\.granted_role = membership_role/i)
  assert.ok(
    sql.indexOf('assignment.granted_role = membership_role') <
      sql.indexOf('if not live_row.is_published'),
    'Stage authorization must be checked before progress enablement',
  )
  assert.match(sql, /operator_role not in \('editor', 'viewer'\)/i)
  assert.match(sql, /on conflict \(stage_id, user_id\) do update[\s\S]*granted_role/i)
  assert.match(sql, /add column public_view_enabled boolean not null default false/i)
  assert.match(sql, /is_published[\s\S]*public_view_enabled/i)
  assert.match(sql, /create function public\.find_live_timetable_for_event_authorized/i)
  assert.match(sql, /create function public\.list_live_timetable_operator_candidates/i)
  assert.match(sql, /workspace_members\.role in \('editor', 'viewer'\)/i)
  assert.doesNotMatch(sql, /auth\.users[\s\S]*email/i)
  assert.match(sql, /revoke all on function public\.find_live_timetable_for_event_authorized[\s\S]*grant execute[\s\S]*to authenticated/i)
})

test('Live UIは独立route・再read・確認・非永続scopeを維持する', async () => {
  const [page, routeApp, main, eventList] = await Promise.all([
    readFile(new URL('../src/components/LiveTimetableOperatorPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/cloud/CloudRouteApp.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EventList.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(routeApp, /resolveLiveTimetableHash/)
  assert.match(main, /CloudRouteApp/)
  assert.match(eventList, /運営向けLive TTを開く/)
  assert.match(page, /未保存の変更は反映されません/)
  assert.match(page, /mode: 'create'/)
  assert.doesNotMatch(page, /mode: 'replace'/)
  assert.match(page, /LIVE_TIMETABLE_REALTIME_COLUMNS/)
  assert.match(page, /loadAuthorized/)
  assert.doesNotMatch(page, /loadEvent|createSupabaseCloudEventRepository/)
  assert.match(page, /post-mutation/)
  assert.match(page, /if \(mutationPendingRef\.current\) return/)
  assert.match(page, /mutationPendingRef\.current = true/)
  assert.match(page, /mutationPendingRef\.current = false/)
  assert.match(page, /navigator\.onLine/)
  assert.match(page, /document\.visibilityState/)
  assert.match(page, /setFreshnessVerificationPending\(true\)/)
  assert.match(page, /setFreshnessVerificationPending\(false\)/)
  assert.doesNotMatch(page, /localStorage|sessionStorage/)
})

