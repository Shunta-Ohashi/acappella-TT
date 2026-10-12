import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

const execFileAsync = promisify(execFile)

const READY_WORKSPACE_ID = '68000000-0000-0000-0000-000000000001'
const OTHER_WORKSPACE_ID = '68000000-0000-0000-0000-000000000002'
const LEGACY_WORKSPACE_ID = '68000000-0000-0000-0000-000000000003'
const TEST_EMAILS = {
  owner: 'workspace-master-http-smoke-owner@example.invalid',
  editor: 'workspace-master-http-smoke-editor@example.invalid',
  viewer: 'workspace-master-http-smoke-viewer@example.invalid',
  outsider: 'workspace-master-http-smoke-outsider@example.invalid',
}
const PROTECTED_DATABASE_PORTS = new Set([
  '54322', '54422', '54522', '54622', '54722',
  '54822', '54922', '55022', '55122',
])

const setupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_workspace_master_http_smoke_setup.sql',
  import.meta.url,
))
const cleanupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_workspace_master_http_smoke_cleanup.sql',
  import.meta.url,
))

const getRequiredEnvironment = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const assertLoopbackUrl = (value, label) => {
  const parsed = new URL(value)
  const hostname = parsed.hostname.toLowerCase()
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new Error(`${label} must target a disposable loopback environment.`)
  }
  return parsed
}

if (!process.argv.includes('--confirm-disposable')) {
  throw new Error('--confirm-disposable is required.')
}

const supabaseUrl = getRequiredEnvironment('ACAPPELLA_TT_SMOKE_SUPABASE_URL')
const anonKey = getRequiredEnvironment('ACAPPELLA_TT_SMOKE_SUPABASE_ANON_KEY')
const serviceRoleKey = getRequiredEnvironment(
  'ACAPPELLA_TT_SMOKE_SUPABASE_SERVICE_ROLE_KEY',
)
const databaseUrl = getRequiredEnvironment('ACAPPELLA_TT_SMOKE_DATABASE_URL')
const configuredFunctionUrl = process.env.ACAPPELLA_TT_SMOKE_FUNCTION_URL?.trim()
const functionUrl = configuredFunctionUrl ||
  `${supabaseUrl.replace(/\/$/u, '')}/functions/v1/workspace-masters`

assertLoopbackUrl(supabaseUrl, 'Supabase URL')
assertLoopbackUrl(functionUrl, 'Workspace Master Function URL')
const parsedDatabaseUrl = assertLoopbackUrl(databaseUrl, 'Database URL')
if (PROTECTED_DATABASE_PORTS.has(parsedDatabaseUrl.port)) {
  throw new Error(`Database port ${parsedDatabaseUrl.port} is protected; use a new disposable DB.`)
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const runPsqlFixture = async (path, variables = {}) => {
  const args = [databaseUrl, '-v', 'ON_ERROR_STOP=1']
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
    if (error) throw new Error(`Unable to list smoke users: ${error.message}`)
    matchingUsers.push(...data.users.filter(user =>
      user.email && Object.values(TEST_EMAILS).includes(user.email)))
    if (data.users.length < 100) break
  }
  return matchingUsers
}

const deleteSmokeUsers = async () => {
  for (const user of await listSmokeUsers()) {
    const { error } = await adminClient.auth.admin.deleteUser(user.id)
    if (error) throw new Error(`Unable to delete smoke user ${user.id}: ${error.message}`)
  }
}

const createSmokeUsers = async (password) => {
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

const invokeMutation = async (accessToken, payload) => {
  const headers = {
    apikey: anonKey,
    'content-type': 'application/json',
  }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  const response = await fetch(functionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

const expectError = async (accessToken, payload, status, code) => {
  const response = await invokeMutation(accessToken, payload)
  assert.equal(response.status, status)
  assert.equal(response.body?.status, 'error')
  assert.equal(response.body?.error?.code, code)
}

const expectAuthenticationRejected = async (accessToken, payload) => {
  const response = await invokeMutation(accessToken, payload)
  // Deployed JWT verification may reject before the handler; local serving
  // may instead return the handler's structured authentication error.
  assert.equal(response.status, 401)
}

const expectRecord = async (accessToken, payload, kind, id, revision) => {
  const response = await invokeMutation(accessToken, payload)
  assert.equal(response.status, 200)
  assert.equal(response.body?.status, 'ok')
  assert.equal(response.body?.workspaceId, payload.workspaceId)
  assert.equal(response.body?.record?.kind, kind)
  assert.equal(response.body?.record?.value?.id, id)
  assert.equal(response.body?.record?.revision, revision)
  return response.body.record
}

const readMasters = async (client, workspaceId) => {
  const { data, error } = await client.rpc('load_workspace_masters_page_authorized', {
    p_workspace_id: workspaceId,
    p_after_kind: null,
    p_after_master_id: null,
    p_page_size: 100,
    p_expected_generation: null,
  })
  if (error) throw new Error(`Unable to read Workspace masters: ${error.message}`)
  assert.equal(data?.status, 'ok')
  assert.equal(data?.workspaceId, workspaceId)
  assert.ok(Array.isArray(data?.rows))
  return data.rows
}

const password = `Smoke-${randomUUID()}-Aa1!`
let users = {}
let primaryError

try {
  await runPsqlFixture(cleanupSqlPath)
  await deleteSmokeUsers()
  users = await createSmokeUsers(password)
  await runPsqlFixture(setupSqlPath, {
    owner_user_id: users.owner.id,
    editor_user_id: users.editor.id,
    viewer_user_id: users.viewer.id,
    outsider_user_id: users.outsider.id,
  })

  const sessions = {}
  for (const [role, email] of Object.entries(TEST_EMAILS)) {
    sessions[role] = await signInSmokeUser(email, password)
  }

  await expectRecord(sessions.owner.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'create-member',
    member: { id: 'smoke-member-a', realName: 'Owner Created', active: true },
  }, 'member', 'smoke-member-a', 1)
  await expectRecord(sessions.editor.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'update-member',
    member: { id: 'smoke-member-a', realName: 'Editor Updated', active: true },
    expectedRevision: 1,
  }, 'member', 'smoke-member-a', 2)

  const deniedMember = {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'create-member',
    member: { id: 'must-not-exist', realName: 'Denied', active: true },
  }
  await expectError(sessions.viewer.accessToken, deniedMember, 403, 'ACCESS_DENIED')
  await expectError(sessions.outsider.accessToken, deniedMember, 403, 'ACCESS_DENIED')
  await expectAuthenticationRejected('', deniedMember)
  await expectAuthenticationRejected('not-a-real-jwt', deniedMember)
  await expectError(sessions.owner.accessToken, {
    ...deniedMember,
    workspaceId: LEGACY_WORKSPACE_ID,
  }, 409, 'WORKSPACE_NOT_READY')
  await expectError(sessions.owner.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'update-member',
    member: { id: 'smoke-member-a', realName: 'Stale', active: true },
    expectedRevision: 1,
  }, 409, 'REVISION_CONFLICT')
  await expectError(sessions.owner.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'create-band',
    band: {
      id: 'missing-member-band',
      name: 'Missing Member',
      defaultMemberIds: ['unknown-member'],
      active: true,
    },
  }, 409, 'MASTER_MEMBER_NOT_FOUND')

  await expectRecord(sessions.owner.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'create-member',
    member: { id: 'smoke-member-b', realName: 'Second Member', active: true },
  }, 'member', 'smoke-member-b', 1)
  await expectRecord(sessions.owner.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'create-band',
    band: {
      id: 'smoke-band-a',
      name: 'Smoke Band',
      defaultMemberIds: ['smoke-member-a', 'smoke-member-b'],
      active: true,
    },
  }, 'band', 'smoke-band-a', 1)
  const updatedBand = await expectRecord(sessions.editor.accessToken, {
    workspaceId: READY_WORKSPACE_ID,
    operation: 'update-band',
    band: {
      id: 'smoke-band-a',
      name: 'Editor Updated Band',
      defaultMemberIds: ['smoke-member-b', 'smoke-member-a'],
      active: true,
    },
    expectedRevision: 1,
  }, 'band', 'smoke-band-a', 2)
  assert.deepEqual(updatedBand.value.defaultMemberIds, ['smoke-member-b', 'smoke-member-a'])

  const readyRows = await readMasters(sessions.owner.client, READY_WORKSPACE_ID)
  assert.equal(readyRows.find(row => row.value.id === 'smoke-member-a')?.revision, 2)
  assert.equal(readyRows.find(row => row.value.id === 'smoke-band-a')?.revision, 2)
  assert.equal(readyRows.some(row => row.value.id === 'must-not-exist'), false)
  assert.equal(readyRows.some(row => row.value.id === 'missing-member-band'), false)
  assert.deepEqual(await readMasters(sessions.outsider.client, OTHER_WORKSPACE_ID), [])

  const directMutation = await sessions.owner.client.rpc('mutate_workspace_master_validated', {
    p_actor_id: users.owner.id,
    p_workspace_id: READY_WORKSPACE_ID,
    p_operation: 'create',
    p_master_kind: 'member',
    p_payload: { id: 'direct-browser-member', realName: 'Forbidden', active: true },
    p_expected_revision: null,
  })
  assert.ok(directMutation.error, 'authenticated browser role executed backend-only RPC')
  const rowsAfterDirectAttempt = await readMasters(
    sessions.owner.client,
    READY_WORKSPACE_ID,
  )
  assert.equal(
    rowsAfterDirectAttempt.some(row => row.value.id === 'direct-browser-member'),
    false,
  )

  console.log('Workspace Master HTTP smoke: PASS')
} catch (error) {
  primaryError = error
} finally {
  const cleanupErrors = []
  try {
    await runPsqlFixture(cleanupSqlPath)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await deleteSmokeUsers()
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    const cleanupMessage = cleanupErrors
      .map(error => error instanceof Error ? error.message : 'unknown cleanup error')
      .join('; ')
    primaryError = primaryError
      ? new Error(`${primaryError instanceof Error ? primaryError.message : 'HTTP smoke failed.'} Cleanup also failed: ${cleanupMessage}`)
      : new Error(cleanupMessage)
  }
}

if (primaryError) {
  console.error(primaryError instanceof Error ? primaryError.message : 'HTTP smoke failed.')
  process.exitCode = 1
}
