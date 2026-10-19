import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const PROJECT_HOST_PATTERN = /^([a-z0-9]{20})\.supabase\.co$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const GENERATION_PATTERN = /^(0|[1-9][0-9]*)$/u
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9._-]+$/u
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const REST_PAGE_SIZE = 1_000
const RPC_PAGE_SIZE = 100

class HostedSmokeError extends Error {}

const fail = message => {
  throw new HostedSmokeError(message)
}

const isRecord = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = value =>
  typeof value === 'string' && value.trim().length > 0

const normalize = value => typeof value === 'string' ? value.trim() : ''

const normalizeUuid = value => {
  const normalized = normalize(value)
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined
}

export const parseCloudV1HostedAuthzSmokeArguments = (inputArguments) => {
  const arguments_ = [...inputArguments]
  if (arguments_[0] === '--') arguments_.shift()

  const parsed = {
    run: false,
    workspaceId: undefined,
    confirmWorkspaceId: undefined,
    confirmProjectRef: undefined,
  }
  const seen = new Set()
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--run') {
      if (seen.has(argument)) fail('Duplicate smoke test option.')
      seen.add(argument)
      parsed.run = true
      continue
    }
    if (argument === '--') fail('Unexpected argument separator.')
    if (!['--workspace-id', '--confirm-workspace-id', '--confirm-project-ref'].includes(argument)) {
      fail('Unknown smoke test option.')
    }
    if (seen.has(argument)) fail('Duplicate smoke test option.')
    seen.add(argument)
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) fail('Smoke test option value is missing.')
    index += 1
    if (argument === '--workspace-id') parsed.workspaceId = value
    if (argument === '--confirm-workspace-id') parsed.confirmWorkspaceId = value
    if (argument === '--confirm-project-ref') parsed.confirmProjectRef = value
  }
  return parsed
}

export const validateCloudV1HostedAuthzSmokeTarget = (arguments_, environment) => {
  const rawUrl = normalize(environment.ACAPPELLA_TT_CLOUD_V1_SMOKE_SUPABASE_URL)
  const publishableKey = normalize(
    environment.ACAPPELLA_TT_CLOUD_V1_SMOKE_PUBLISHABLE_KEY,
  )
  if (!rawUrl || !publishableKey) {
    fail('Hosted smoke URL and Publishable Key are required.')
  }

  let parsedUrl
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    fail('Hosted smoke URL is invalid.')
  }
  const projectMatch = parsedUrl.hostname.match(PROJECT_HOST_PATTERN)
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') ||
    !projectMatch
  ) {
    fail('Hosted smoke requires an exact HTTPS Supabase project origin.')
  }
  if (!PUBLISHABLE_KEY_PATTERN.test(publishableKey)) {
    fail('Hosted smoke requires a Supabase Publishable Key.')
  }

  const projectRef = projectMatch[1]
  const confirmedProjectRef = normalize(arguments_.confirmProjectRef).toLowerCase()
  if (!PROJECT_HOST_PATTERN.test(`${confirmedProjectRef}.supabase.co`) ||
      confirmedProjectRef !== projectRef) {
    fail('Hosted smoke project confirmation does not match the target.')
  }

  const workspaceId = normalizeUuid(arguments_.workspaceId)
  const confirmedWorkspaceId = normalizeUuid(arguments_.confirmWorkspaceId)
  if (!workspaceId || !confirmedWorkspaceId || workspaceId !== confirmedWorkspaceId) {
    fail('Hosted smoke Workspace confirmation does not match the target.')
  }

  return {
    run: arguments_.run,
    origin: parsedUrl.origin,
    projectRef,
    workspaceId,
    publishableKey,
  }
}

export const parseCloudV1MagicLink = (value, target) => {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('Magic Link is invalid.')
  }
  if (
    url.origin !== target.origin ||
    url.pathname !== '/auth/v1/verify' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    fail('Magic Link does not belong to the confirmed Supabase Auth endpoint.')
  }
  const allowedParameters = new Set(['token', 'type', 'redirect_to'])
  for (const parameter of url.searchParams.keys()) {
    if (!allowedParameters.has(parameter)) fail('Magic Link contains an unexpected parameter.')
  }
  const tokens = url.searchParams.getAll('token')
  const types = url.searchParams.getAll('type')
  if (
    tokens.length !== 1 ||
    !isNonEmptyString(tokens[0]) ||
    types.length !== 1 ||
    types[0] !== 'magiclink'
  ) {
    fail('Magic Link does not contain one valid magic-link token.')
  }
  if (url.searchParams.getAll('redirect_to').length > 1) {
    fail('Magic Link contains duplicate redirect information.')
  }
  return { tokenHash: tokens[0], type: types[0] }
}

const readLimitedJson = async (response) => {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_RESPONSE_BYTES) fail('Hosted response exceeds the safe size limit.')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (byteLength === 0) return undefined
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    fail('Hosted endpoint returned an invalid JSON response.')
  }
}

const requestJson = async (fetchImpl, url, init) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    })
    return {
      status: response.status,
      body: await readLimitedJson(response),
    }
  } catch (error) {
    if (error instanceof HostedSmokeError) throw error
    fail('Hosted HTTP request failed or timed out.')
  } finally {
    clearTimeout(timeout)
  }
}

const createHeaders = (target, accessToken) => ({
  apikey: target.publishableKey,
  ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  'content-type': 'application/json',
})

const pageRpcUrl = target =>
  `${target.origin}/rest/v1/rpc/load_cloud_events_page_authorized`

const postPageRpc = (fetchImpl, target, accessToken, body) => requestJson(
  fetchImpl,
  pageRpcUrl(target),
  {
    method: 'POST',
    headers: createHeaders(target, accessToken),
    body: JSON.stringify(body),
  },
)

const exchangeMagicLink = async (fetchImpl, target, magicLink) => {
  const parsedLink = parseCloudV1MagicLink(magicLink, target)
  const response = await requestJson(
    fetchImpl,
    `${target.origin}/auth/v1/verify`,
    {
      method: 'POST',
      headers: createHeaders(target),
      body: JSON.stringify({
        token_hash: parsedLink.tokenHash,
        type: parsedLink.type,
      }),
    },
  )
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    !isNonEmptyString(response.body.access_token)
  ) fail('Magic Link could not be exchanged for an authenticated session.')
  return response.body.access_token
}

const getAuthenticatedUserId = async (fetchImpl, target, accessToken) => {
  const response = await requestJson(
    fetchImpl,
    `${target.origin}/auth/v1/user`,
    {
      method: 'GET',
      headers: createHeaders(target, accessToken),
    },
  )
  const userId = isRecord(response.body) ? normalizeUuid(response.body.id) : undefined
  if (response.status !== 200 || !userId) fail('Authenticated user could not be verified.')
  return userId
}

const readMemberships = async (fetchImpl, target, accessToken, userId) => {
  const memberships = []
  for (let offset = 0; offset < 100_000; offset += REST_PAGE_SIZE) {
    const query = new URLSearchParams({
      select: 'workspace_id,role',
      user_id: `eq.${userId}`,
      order: 'workspace_id.asc',
      limit: String(REST_PAGE_SIZE),
      offset: String(offset),
    })
    const response = await requestJson(
      fetchImpl,
      `${target.origin}/rest/v1/workspace_members?${query}`,
      {
        method: 'GET',
        headers: createHeaders(target, accessToken),
      },
    )
    if (response.status !== 200 || !Array.isArray(response.body)) {
      fail('Viewer Workspace memberships could not be read.')
    }
    const page = response.body.map((entry) => {
      if (!isRecord(entry)) fail('Membership response is invalid.')
      const workspaceId = normalizeUuid(entry.workspace_id)
      if (!workspaceId || !['owner', 'editor', 'viewer'].includes(entry.role)) {
        fail('Membership response is invalid.')
      }
      return { workspaceId, role: entry.role }
    })
    memberships.push(...page)
    if (page.length < REST_PAGE_SIZE) break
    if (offset + REST_PAGE_SIZE >= 100_000) {
      fail('Viewer Workspace memberships exceed the smoke test safety limit.')
    }
  }
  const targetMembership = memberships.find(entry => entry.workspaceId === target.workspaceId)
  if (targetMembership?.role !== 'viewer') {
    fail('The authenticated user is not a viewer of the confirmed Workspace.')
  }
  return memberships
}

const parseEventMetadata = (value) => {
  if (!isRecord(value)) fail('Cloud Event metadata response is invalid.')
  const workspaceId = normalizeUuid(value.workspace_id)
  if (
    !workspaceId ||
    !isNonEmptyString(value.event_id) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision <= 0
  ) fail('Cloud Event metadata response is invalid.')
  return { workspaceId, eventId: value.event_id, revision: value.revision }
}

const readVisibleEventMetadata = async (
  fetchImpl,
  target,
  accessToken,
  allowedWorkspaceIds,
) => {
  const records = []
  for (let offset = 0; offset < 100_000; offset += REST_PAGE_SIZE) {
    const query = new URLSearchParams({
      select: 'workspace_id,event_id,revision',
      order: 'workspace_id.asc,event_id.asc',
      limit: String(REST_PAGE_SIZE),
      offset: String(offset),
    })
    const response = await requestJson(
      fetchImpl,
      `${target.origin}/rest/v1/cloud_events?${query}`,
      {
        method: 'GET',
        headers: createHeaders(target, accessToken),
      },
    )
    if (response.status !== 200 || !Array.isArray(response.body)) {
      fail('Visible Cloud Event metadata could not be read.')
    }
    const page = response.body.map(parseEventMetadata)
    if (page.some(record => !allowedWorkspaceIds.has(record.workspaceId))) {
      fail('Cloud Event read exposed a Workspace without viewer membership.')
    }
    records.push(...page)
    if (page.length < REST_PAGE_SIZE) return records
  }
  fail('Visible Cloud Event metadata exceeds the smoke test safety limit.')
}

const parseWorkspacePage = (value, target, expectedGeneration) => {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.workspace_id !== target.workspaceId ||
    !GENERATION_PATTERN.test(value.workspace_generation) ||
    !Array.isArray(value.rows) ||
    ('error' in value) ||
    value.rows.length > RPC_PAGE_SIZE ||
    (value.next_cursor !== null && !isNonEmptyString(value.next_cursor))
  ) fail('Authorized page RPC response is invalid.')
  if (
    (value.rows.length === 0 && value.next_cursor !== null) ||
    (value.next_cursor !== null && value.rows.length !== RPC_PAGE_SIZE)
  ) fail('Authorized page RPC response is invalid.')
  if (expectedGeneration !== null && value.workspace_generation !== expectedGeneration) {
    fail('Authorized page RPC generation changed during the read.')
  }
  const records = value.rows.map(parseEventMetadata)
  if (records.some(record => record.workspaceId !== target.workspaceId)) {
    fail('Authorized page RPC returned a different Workspace.')
  }
  return {
    generation: value.workspace_generation,
    records,
    nextCursor: value.next_cursor,
  }
}

const readAuthorizedWorkspace = async (fetchImpl, target, accessToken) => {
  const records = []
  const cursors = new Set()
  let afterEventId = null
  let generation = null
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const response = await postPageRpc(fetchImpl, target, accessToken, {
      p_workspace_id: target.workspaceId,
      p_after_event_id: afterEventId,
      p_page_size: RPC_PAGE_SIZE,
      p_expected_generation: generation,
    })
    if (response.status !== 200) fail('Authorized page RPC did not permit viewer read access.')
    const page = parseWorkspacePage(response.body, target, generation)
    generation = page.generation
    records.push(...page.records)
    if (page.nextCursor === null) return { generation, records }
    if (cursors.has(page.nextCursor) || page.nextCursor === afterEventId) {
      fail('Authorized page RPC returned an invalid cursor sequence.')
    }
    cursors.add(page.nextCursor)
    afterEventId = page.nextCursor
  }
  fail('Authorized page RPC exceeds the smoke test page limit.')
}

const canonicalEventMetadata = records => records
  .map(record => `${record.workspaceId}\u0000${record.eventId}\u0000${record.revision}`)
  .sort()

const valuesEqual = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right)

const createReporter = writeLine => ({
  pass: label => writeLine(`PASS ${label}`),
  skip: (label, reason) => writeLine(`SKIP ${label}: ${reason}`),
})

export const runCloudV1HostedAuthzSmoke = async (target, dependencies = {}) => {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const readMagicLink = dependencies.readMagicLink
  const reporter = dependencies.reporter ?? createReporter(console.log)
  const randomUuid = dependencies.randomUuid ?? randomUUID
  if (typeof readMagicLink !== 'function') fail('Secure Magic Link input is unavailable.')

  const unauthenticated = await postPageRpc(fetchImpl, target, undefined, {
    p_workspace_id: target.workspaceId,
    p_after_event_id: null,
    p_page_size: 1,
    p_expected_generation: null,
  })
  if (unauthenticated.status !== 401) fail('Missing Authorization was not rejected with HTTP 401.')
  reporter.pass('missing Authorization rejected with HTTP 401')

  const invalidJwt = await postPageRpc(fetchImpl, target, 'invalid.invalid.invalid', {
    p_workspace_id: target.workspaceId,
    p_after_event_id: null,
    p_page_size: 1,
    p_expected_generation: null,
  })
  if (invalidJwt.status !== 401) fail('Invalid JWT was not rejected with HTTP 401.')
  reporter.pass('invalid JWT rejected with HTTP 401')

  const accessToken = await exchangeMagicLink(
    fetchImpl,
    target,
    await readMagicLink(),
  )
  const userId = await getAuthenticatedUserId(fetchImpl, target, accessToken)
  reporter.pass('one-time Magic Link exchanged and user verified')

  const memberships = await readMemberships(fetchImpl, target, accessToken, userId)
  const allowedWorkspaceIds = new Set(memberships.map(entry => entry.workspaceId))
  reporter.pass('confirmed Workspace membership is viewer')

  const visibleBefore = await readVisibleEventMetadata(
    fetchImpl,
    target,
    accessToken,
    allowedWorkspaceIds,
  )
  reporter.pass('direct read exposes only member Workspaces')

  const workspaceBefore = await readAuthorizedWorkspace(fetchImpl, target, accessToken)
  const targetVisibleBefore = visibleBefore.filter(
    record => record.workspaceId === target.workspaceId,
  )
  if (targetVisibleBefore.length === 0 || workspaceBefore.records.length === 0) {
    fail('The confirmed Workspace has no observable saved Cloud Event; authorization verification is inconclusive.')
  }
  if (!valuesEqual(
    canonicalEventMetadata(targetVisibleBefore),
    canonicalEventMetadata(workspaceBefore.records),
  )) fail('Authorized page RPC and visible Event metadata do not match.')
  reporter.pass('viewer authorized page RPC read succeeded')

  const probeEventId = `hosted-authz-smoke-${randomUuid()}`
  if (workspaceBefore.records.some(record => record.eventId === probeEventId)) {
    fail('Random delete probe Event ID unexpectedly exists.')
  }
  reporter.pass('random delete probe ID is absent from the confirmed Workspace')

  const deleteResponse = await requestJson(
    fetchImpl,
    `${target.origin}/rest/v1/rpc/delete_cloud_event_authorized`,
    {
      method: 'POST',
      headers: createHeaders(target, accessToken),
      body: JSON.stringify({
        p_workspace_id: target.workspaceId,
        p_event_id: probeEventId,
      }),
    },
  )

  const visibleAfter = await readVisibleEventMetadata(
    fetchImpl,
    target,
    accessToken,
    allowedWorkspaceIds,
  )
  const workspaceAfter = await readAuthorizedWorkspace(fetchImpl, target, accessToken)
  if (
    !valuesEqual(
      canonicalEventMetadata(visibleBefore),
      canonicalEventMetadata(visibleAfter),
    ) ||
    workspaceBefore.generation !== workspaceAfter.generation ||
    !valuesEqual(
      canonicalEventMetadata(workspaceBefore.records),
      canonicalEventMetadata(workspaceAfter.records),
    )
  ) fail('Cloud Event metadata, revisions, or generation changed during the smoke test.')
  reporter.pass('Cloud Event IDs, revisions, and generation remained unchanged')

  if (
    deleteResponse.status !== 403 ||
    !isRecord(deleteResponse.body) ||
    deleteResponse.body.code !== '42501'
  ) fail('Viewer delete was not rejected with HTTP 403 and SQLSTATE 42501.')
  reporter.pass('viewer delete rejected with HTTP 403 and SQLSTATE 42501')

  const hostedSaveSkipReason =
    'a save authorization regression could create a row and Hosted HTTP has no rollback boundary'
  reporter.skip('viewer save authorization', hostedSaveSkipReason)
  reporter.skip('non-member save authorization', hostedSaveSkipReason)

  return {
    passed: 9,
    skipped: 2,
  }
}

const readHiddenMagicLink = async () => {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    fail('Magic Link input requires an interactive terminal.')
  }
  return await new Promise((resolve, reject) => {
    let value = ''
    let completed = false
    const cleanup = () => {
      if (completed) return
      completed = true
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write('\n')
    }
    const finish = () => {
      cleanup()
      if (!value) reject(new HostedSmokeError('Magic Link input was empty.'))
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          reject(new HostedSmokeError('Magic Link input was cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        if (character >= ' ') value += character
        if (value.length > 8_192) {
          cleanup()
          reject(new HostedSmokeError('Magic Link input is too long.'))
          return
        }
      }
    }
    process.stderr.write('Paste the one-time Magic Link (input hidden): ')
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

const safeErrorMessage = error => error instanceof HostedSmokeError
  ? error.message
  : 'Hosted Cloud V1 authorization smoke failed safely.'

export const runCloudV1HostedAuthzSmokeCli = async ({
  argv,
  environment,
  fetchImpl = fetch,
  readMagicLink = readHiddenMagicLink,
  randomUuid = randomUUID,
  writeLine = console.log,
  writeError = console.error,
}) => {
  let target
  try {
    const arguments_ = parseCloudV1HostedAuthzSmokeArguments(argv)
    target = validateCloudV1HostedAuthzSmokeTarget(arguments_, environment)
  } catch (error) {
    writeError(`FAIL configuration: ${safeErrorMessage(error)}`)
    return 1
  }

  if (!target.run) {
    writeLine('DRY-RUN target confirmations passed; no HTTP request was sent.')
    writeLine('Use --run only after verifying the confirmed Hosted project and viewer Workspace.')
    return 0
  }

  try {
    const result = await runCloudV1HostedAuthzSmoke(target, {
      fetchImpl,
      readMagicLink,
      randomUuid,
      reporter: createReporter(writeLine),
    })
    writeLine(
      `COMPLETED ${result.passed} PASS, ${result.skipped} SKIP; ` +
      'no save/create request was sent; one delete-denial RPC was sent for a confirmed-absent random Event ID.',
    )
    return 0
  } catch (error) {
    writeError(`FAIL hosted authorization smoke: ${safeErrorMessage(error)}`)
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  process.exitCode = await runCloudV1HostedAuthzSmokeCli({
    argv: process.argv.slice(2),
    environment: process.env,
  })
}
