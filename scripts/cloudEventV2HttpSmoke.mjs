import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

const execFileAsync = promisify(execFile)

const API_PORT = '55721'
const DATABASE_PORT = '55722'
const READY_WORKSPACE_ID = '76000000-0000-0000-0000-000000000001'
const LEGACY_WORKSPACE_ID = '76000000-0000-0000-0000-000000000002'
const V1_WORKSPACE_ID = '76000000-0000-0000-0000-000000000003'
const EVENT_ID = 'v2-http-event'
const V1_EVENT_ID = 'v1-http-event'
const MEMBER_A_ID = 'v2-http-member-a'
const MEMBER_B_ID = 'v2-http-member-b'
const BAND_ID = 'v2-http-band-a'
const MAX_REQUEST_BYTES = 5 * 1024 * 1024
const TEST_EMAILS = {
  owner: 'cloud-event-v2-http-smoke-owner@example.invalid',
  editor: 'cloud-event-v2-http-smoke-editor@example.invalid',
  viewer: 'cloud-event-v2-http-smoke-viewer@example.invalid',
  outsider: 'cloud-event-v2-http-smoke-outsider@example.invalid',
}
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const setupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_event_v2_http_smoke_setup.sql',
  import.meta.url,
))
const cleanupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_event_v2_http_smoke_cleanup.sql',
  import.meta.url,
))
const verifySqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_event_v2_http_smoke_verify.sql',
  import.meta.url,
))

const getRequiredEnvironment = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const parseLoopbackUrl = (value, label, protocols) => {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL.`)
  }
  if (!protocols.has(parsed.protocol) ||
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${label} must target the disposable loopback environment.`)
  }
  return parsed
}

const allowedArguments = new Set(['--confirm-disposable', '--cleanup-only'])
for (const argument of process.argv.slice(2)) {
  if (!allowedArguments.has(argument)) throw new Error(`Unknown argument: ${argument}`)
}
if (!process.argv.includes('--confirm-disposable')) {
  throw new Error('--confirm-disposable is required.')
}
const cleanupOnly = process.argv.includes('--cleanup-only')

const supabaseUrl = getRequiredEnvironment('ACAPPELLA_TT_EVENT_V2_SMOKE_SUPABASE_URL')
const anonKey = getRequiredEnvironment('ACAPPELLA_TT_EVENT_V2_SMOKE_ANON_KEY')
const serviceRoleKey = getRequiredEnvironment(
  'ACAPPELLA_TT_EVENT_V2_SMOKE_SERVICE_ROLE_KEY',
)
const databaseUrl = getRequiredEnvironment('ACAPPELLA_TT_EVENT_V2_SMOKE_DATABASE_URL')
const configuredFunctionUrl =
  process.env.ACAPPELLA_TT_EVENT_V2_SMOKE_FUNCTION_URL?.trim()
const functionUrl = configuredFunctionUrl ||
  `${supabaseUrl.replace(/\/$/u, '')}/functions/v1/save-cloud-event-v2`

const parsedSupabaseUrl = parseLoopbackUrl(
  supabaseUrl,
  'Supabase URL',
  new Set(['http:', 'https:']),
)
const parsedFunctionUrl = parseLoopbackUrl(
  functionUrl,
  'Cloud Event V2 Function URL',
  new Set(['http:', 'https:']),
)
const parsedDatabaseUrl = parseLoopbackUrl(
  databaseUrl,
  'Database URL',
  new Set(['postgres:', 'postgresql:']),
)
if (parsedSupabaseUrl.port !== API_PORT || parsedDatabaseUrl.port !== DATABASE_PORT) {
  throw new Error(`Only the disposable API ${API_PORT} / DB ${DATABASE_PORT} pair is allowed.`)
}
if (parsedSupabaseUrl.pathname !== '/' || parsedSupabaseUrl.search || parsedSupabaseUrl.hash) {
  throw new Error('Supabase URL must be the disposable API origin.')
}
if (
  parsedFunctionUrl.origin !== parsedSupabaseUrl.origin ||
  parsedFunctionUrl.pathname !== '/functions/v1/save-cloud-event-v2' ||
  parsedFunctionUrl.search ||
  parsedFunctionUrl.hash
) {
  throw new Error('Function URL must be the save-cloud-event-v2 route on the same API origin.')
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const runPsqlFixture = async (path, variables = {}) => {
  const args = [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1']
  for (const [name, value] of Object.entries(variables)) {
    args.push('-v', `${name}=${value}`)
  }
  args.push('-f', path)
  try {
    await execFileAsync('psql', args, { windowsHide: true })
  } catch {
    throw new Error(`psql fixture failed: ${path}`)
  }
}

const listSmokeUsers = async () => {
  const matchingUsers = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 100 })
    if (error) throw new Error(`Unable to inspect dedicated smoke users: ${error.message}`)
    matchingUsers.push(...data.users.filter(user =>
      user.email && Object.values(TEST_EMAILS).includes(user.email)))
    if (data.users.length < 100) break
  }
  return matchingUsers
}

const deleteSmokeUsersById = async (userIds) => {
  for (const userId of userIds) {
    const { error } = await adminClient.auth.admin.deleteUser(userId)
    if (error) throw new Error(`Unable to delete dedicated smoke user ${userId}.`)
  }
}

const createSmokeUsers = async (password, createdUserIds) => {
  const users = {}
  for (const [role, email] of Object.entries(TEST_EMAILS)) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error || !data.user) {
      throw new Error(`Unable to create ${role} smoke user: ${error?.message ?? 'no user'}`)
    }
    if (!/^[0-9a-f-]{36}$/iu.test(data.user.id)) {
      throw new Error(`Unable to validate ${role} smoke user ID.`)
    }
    createdUserIds.push(data.user.id)
    users[role] = data.user
  }
  return users
}

const signInSmokeUser = async (email, password) => {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    throw new Error(`Unable to sign in smoke user: ${error?.message ?? 'no session'}`)
  }
  return { client, accessToken: data.session.access_token }
}

const parseResponseBody = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

const invokeRaw = async (accessToken, serializedBody) => {
  const headers = {
    apikey: anonKey,
    'content-type': 'application/json',
  }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  const response = await fetch(functionUrl, {
    method: 'POST',
    headers,
    body: serializedBody,
  })
  return { status: response.status, body: await parseResponseBody(response) }
}

const invokeSave = (accessToken, payload) =>
  invokeRaw(accessToken, JSON.stringify(payload))

const expectError = async (accessToken, payload, status, code) => {
  const response = await invokeSave(accessToken, payload)
  assert.equal(response.status, status)
  assert.equal(response.body?.status, 'error')
  assert.equal(response.body?.error?.code, code)
}

const expectAuthenticationRejected = async (accessToken, payload) => {
  const response = await invokeSave(accessToken, payload)
  // Hosted/local gateway verification may reject before the handler. Both
  // paths must remain an HTTP 401 and must never expose a token in logs.
  assert.equal(response.status, 401)
}

const createSnapshot = (
  eventId,
  eventName,
  {
    directMemberId = MEMBER_A_ID,
    eventBandId = BAND_ID,
    eventBandMemberIds = [MEMBER_A_ID],
    referenceMemberIds = [MEMBER_A_ID, MEMBER_B_ID],
    referenceBandIds = [BAND_ID],
  } = {},
) => ({
  format: 'acappella-tt-cloud-event',
  version: 2,
  eventState: {
    version: 5,
    events: [{
      id: eventId,
      name: eventName,
      timeZone: 'Asia/Tokyo',
      validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
      performanceSlotMinutes: [5],
    }],
    eventDays: [{
      id: `${eventId}-day`,
      eventId,
      date: '2026-10-14',
      order: 0,
    }],
    stages: [],
    sections: [],
    eventMembers: [{
      id: `${eventId}-member`,
      eventId,
      memberId: directMemberId,
      paCapabilities: { main: true, sub: false },
    }],
    eventMemberDays: [],
    eventBands: [{
      id: `${eventId}-band`,
      eventId,
      eventDayId: `${eventId}-day`,
      bandId: eventBandId,
      name: `${eventName} Band`,
      memberIds: eventBandMemberIds,
      durationMinutes: 5,
    }],
    scheduleItems: [],
    paAssignments: [],
    dutyTypes: [],
    dutyAssignments: [],
    timetableLocks: [],
    timetableOrderConstraints: [],
  },
  masterReferences: {
    memberIds: referenceMemberIds,
    bandIds: referenceBandIds,
  },
})

const readEventPage = async (client, workspaceId) => {
  const { data, error } = await client.rpc('load_cloud_events_page_authorized', {
    p_workspace_id: workspaceId,
    p_after_event_id: null,
    p_page_size: 100,
    p_expected_generation: null,
  })
  if (error) throw new Error(`Unable to read Cloud Event page: ${error.message}`)
  assert.equal(data?.status, 'ok')
  assert.equal(data?.workspace_id, workspaceId)
  assert.match(data?.workspace_generation, /^(0|[1-9][0-9]*)$/u)
  assert.ok(Array.isArray(data?.rows))
  assert.equal(data?.next_cursor, null)
  return data
}

const expectSaved = async (
  accessToken,
  payload,
  expectedRevision,
) => {
  const response = await invokeSave(accessToken, payload)
  assert.equal(response.status, 200)
  assert.equal(response.body?.status, 'ok')
  assert.equal(response.body?.workspaceId, payload.workspaceId)
  assert.equal(response.body?.record?.workspace_id, payload.workspaceId)
  assert.equal(response.body?.record?.event_id, payload.snapshot.eventState.events[0].id)
  assert.equal(response.body?.record?.event_name, payload.snapshot.eventState.events[0].name)
  assert.equal(response.body?.record?.revision, expectedRevision)
  assert.deepEqual(response.body?.record?.event_snapshot, payload.snapshot)
  assert.equal(
    BigInt(response.body.workspaceGeneration),
    BigInt(payload.expectedGeneration) + 1n,
  )
  return response.body
}

const verifyDatabaseState = async (
  generation,
  legacyGeneration,
  v1Generation,
  revision,
  eventName,
) => {
  await runPsqlFixture(verifySqlPath, {
    expected_generation: generation,
    expected_legacy_generation: legacyGeneration,
    expected_v1_generation: v1Generation,
    expected_revision: revision,
    expected_event_name: eventName,
  })
}

const cleanupDedicatedResources = async ({ fixtureWasCreated, userIds }) => {
  const errors = []
  if (fixtureWasCreated) {
    try {
      await runPsqlFixture(cleanupSqlPath)
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await deleteSmokeUsersById(userIds)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new Error(errors
      .map(error => error instanceof Error ? error.message : 'unknown cleanup error')
      .join('; '))
  }
}

const runCleanupOnly = async () => {
  const existingUsers = await listSmokeUsers()
  const errors = []
  try {
    await runPsqlFixture(cleanupSqlPath)
  } catch (error) {
    errors.push(error)
  }
  try {
    await deleteSmokeUsersById(existingUsers.map(user => user.id))
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new Error(errors
      .map(error => error instanceof Error ? error.message : 'unknown cleanup error')
      .join('; '))
  }
  console.log('Cloud Event V2 HTTP smoke cleanup: PASS')
}

const runSmoke = async () => {
  const existingUsers = await listSmokeUsers()
  if (existingUsers.length > 0) {
    throw new Error(
      'Dedicated smoke Auth users already exist. Inspect the target, then run --cleanup-only explicitly.',
    )
  }

  const password = `Smoke-${randomUUID()}-Aa1!`
  const createdUserIds = []
  let fixtureWasCreated = false
  let primaryError

  try {
    const users = await createSmokeUsers(password, createdUserIds)
    await runPsqlFixture(setupSqlPath, {
      owner_user_id: users.owner.id,
      editor_user_id: users.editor.id,
      viewer_user_id: users.viewer.id,
    })
    fixtureWasCreated = true

    const sessions = {}
    for (const [role, email] of Object.entries(TEST_EMAILS)) {
      sessions[role] = await signInSmokeUser(email, password)
    }

    const initialPage = await readEventPage(sessions.owner.client, READY_WORKSPACE_ID)
    const legacyPage = await readEventPage(sessions.owner.client, LEGACY_WORKSPACE_ID)
    const v1Page = await readEventPage(sessions.owner.client, V1_WORKSPACE_ID)
    assert.deepEqual(initialPage.rows, [])
    assert.deepEqual(legacyPage.rows, [])
    assert.equal(v1Page.rows[0]?.event_snapshot?.version, 1)

    const ownerSnapshot = createSnapshot(EVENT_ID, 'Owner V2 Event')
    const created = await expectSaved(sessions.owner.accessToken, {
      workspaceId: READY_WORKSPACE_ID,
      snapshot: ownerSnapshot,
      expectedRevision: null,
      expectedGeneration: initialPage.workspace_generation,
    }, 1)
    const createdPage = await readEventPage(sessions.owner.client, READY_WORKSPACE_ID)
    assert.equal(createdPage.workspace_generation, created.workspaceGeneration)
    assert.equal(createdPage.rows.length, 1)
    assert.deepEqual(createdPage.rows[0].event_snapshot, ownerSnapshot)
    await verifyDatabaseState(
      created.workspaceGeneration,
      legacyPage.workspace_generation,
      v1Page.workspace_generation,
      1,
      'Owner V2 Event',
    )

    const editorSnapshot = createSnapshot(EVENT_ID, 'Editor Updated V2 Event')
    const updated = await expectSaved(sessions.editor.accessToken, {
      workspaceId: READY_WORKSPACE_ID,
      snapshot: editorSnapshot,
      expectedRevision: 1,
      expectedGeneration: created.workspaceGeneration,
    }, 2)
    const updatedPage = await readEventPage(sessions.owner.client, READY_WORKSPACE_ID)
    assert.equal(updatedPage.workspace_generation, updated.workspaceGeneration)
    assert.equal(updatedPage.rows[0].revision, 2)
    assert.deepEqual(updatedPage.rows[0].event_snapshot, editorSnapshot)
    await verifyDatabaseState(
      updated.workspaceGeneration,
      legacyPage.workspace_generation,
      v1Page.workspace_generation,
      2,
      'Editor Updated V2 Event',
    )

    const assertFailureLeavesDatabaseUnchanged = async (operation) => {
      const before = await readEventPage(sessions.owner.client, READY_WORKSPACE_ID)
      await operation()
      const after = await readEventPage(sessions.owner.client, READY_WORKSPACE_ID)
      assert.deepEqual(after, before)
      await verifyDatabaseState(
        updated.workspaceGeneration,
        legacyPage.workspace_generation,
        v1Page.workspace_generation,
        2,
        'Editor Updated V2 Event',
      )
    }

    const deniedPayload = {
      workspaceId: READY_WORKSPACE_ID,
      snapshot: createSnapshot('denied-v2-event', 'Denied V2 Event'),
      expectedRevision: null,
      expectedGeneration: updated.workspaceGeneration,
    }
    await assertFailureLeavesDatabaseUnchanged(() =>
      expectError(sessions.viewer.accessToken, deniedPayload, 403, 'ACCESS_DENIED'))
    await assertFailureLeavesDatabaseUnchanged(() =>
      expectError(sessions.outsider.accessToken, deniedPayload, 403, 'ACCESS_DENIED'))
    await assertFailureLeavesDatabaseUnchanged(() =>
      expectAuthenticationRejected('', deniedPayload))
    await assertFailureLeavesDatabaseUnchanged(() =>
      expectAuthenticationRejected('not-a-real-jwt', deniedPayload))

    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: LEGACY_WORKSPACE_ID,
        snapshot: createSnapshot('legacy-v2-event', 'Legacy V2 Event'),
        expectedRevision: null,
        expectedGeneration: legacyPage.workspace_generation,
      },
      409,
      'WORKSPACE_NOT_READY',
    ))

    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: READY_WORKSPACE_ID,
        snapshot: createSnapshot(EVENT_ID, 'Stale Revision'),
        expectedRevision: 1,
        expectedGeneration: updated.workspaceGeneration,
      },
      409,
      'REVISION_CONFLICT',
    ))
    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: READY_WORKSPACE_ID,
        snapshot: createSnapshot(EVENT_ID, 'Stale Generation'),
        expectedRevision: 2,
        expectedGeneration: (BigInt(updated.workspaceGeneration) - 1n).toString(),
      },
      409,
      'WORKSPACE_SNAPSHOT_CHANGED',
    ))

    const malformedSnapshot = createSnapshot(EVENT_ID, 'Malformed V2 Event')
    malformedSnapshot.eventState.eventMembers = null
    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: READY_WORKSPACE_ID,
        snapshot: malformedSnapshot,
        expectedRevision: 2,
        expectedGeneration: updated.workspaceGeneration,
      },
      400,
      'INVALID_SNAPSHOT',
    ))

    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: READY_WORKSPACE_ID,
        snapshot: createSnapshot(EVENT_ID, 'Missing Member', {
          directMemberId: 'missing-v2-http-member',
          referenceMemberIds: [
            MEMBER_A_ID,
            MEMBER_B_ID,
            'missing-v2-http-member',
          ],
        }),
        expectedRevision: 2,
        expectedGeneration: updated.workspaceGeneration,
      },
      409,
      'MASTER_REFERENCE_INVALID',
    ))
    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: READY_WORKSPACE_ID,
        snapshot: createSnapshot(EVENT_ID, 'Missing Band', {
          eventBandId: 'missing-v2-http-band',
          referenceMemberIds: [MEMBER_A_ID],
          referenceBandIds: ['missing-v2-http-band'],
        }),
        expectedRevision: 2,
        expectedGeneration: updated.workspaceGeneration,
      },
      409,
      'MASTER_REFERENCE_INVALID',
    ))

    await assertFailureLeavesDatabaseUnchanged(() => expectError(
      sessions.owner.accessToken,
      {
        workspaceId: V1_WORKSPACE_ID,
        snapshot: createSnapshot(V1_EVENT_ID, 'Forbidden V2 overwrite'),
        expectedRevision: 1,
        expectedGeneration: v1Page.workspace_generation,
      },
      409,
      'SNAPSHOT_VERSION_CONFLICT',
    ))

    await assertFailureLeavesDatabaseUnchanged(async () => {
      const { error } = await sessions.owner.client.rpc(
        'save_cloud_event_v2_validated',
        {
          p_actor_id: users.owner.id,
          p_workspace_id: READY_WORKSPACE_ID,
          p_event_snapshot: createSnapshot(EVENT_ID, 'Direct RPC Attempt'),
          p_expected_revision: 2,
          p_expected_generation: updated.workspaceGeneration,
        },
      )
      assert.ok(error, 'authenticated browser role executed backend-only V2 RPC')
      assert.equal(error.code, '42501')
    })

    await assertFailureLeavesDatabaseUnchanged(async () => {
      const oversizedBody = JSON.stringify({ padding: 'x'.repeat(MAX_REQUEST_BYTES) })
      assert.ok(Buffer.byteLength(oversizedBody, 'utf8') > MAX_REQUEST_BYTES)
      const response = await invokeRaw(sessions.owner.accessToken, oversizedBody)
      assert.equal(response.status, 413)
      if (response.body?.status === 'error') {
        assert.equal(response.body.error?.code, 'REQUEST_TOO_LARGE')
      }
    })

    console.log('Cloud Event V2 HTTP smoke: PASS')
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await cleanupDedicatedResources({
        fixtureWasCreated,
        userIds: createdUserIds,
      })
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error
        ? cleanupError.message
        : 'unknown cleanup error'
      primaryError = primaryError
        ? new Error(`${primaryError instanceof Error ? primaryError.message : 'HTTP smoke failed.'} Cleanup also failed: ${cleanupMessage}`)
        : new Error(cleanupMessage)
    }
  }

  if (primaryError) throw primaryError
}

try {
  if (cleanupOnly) {
    await runCleanupOnly()
  } else {
    await runSmoke()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cloud Event V2 HTTP smoke failed.')
  process.exitCode = 1
}
