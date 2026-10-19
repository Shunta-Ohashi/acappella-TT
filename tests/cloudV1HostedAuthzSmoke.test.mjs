import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCloudV1HostedAuthzSmokeArguments,
  parseCloudV1MagicLink,
  runCloudV1HostedAuthzSmoke,
  runCloudV1HostedAuthzSmokeCli,
  validateCloudV1HostedAuthzSmokeTarget,
} from '../scripts/cloudV1HostedAuthzSmoke.mjs'

const origin = 'https://abcdefghijklmnopqrst.supabase.co'
const projectRef = 'abcdefghijklmnopqrst'
const workspaceId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const publishableKey = 'sb_publishable_hosted_smoke_test'
const accessToken = 'private-access-token-for-test'
const refreshToken = 'private-refresh-token-for-test'
const magicToken = 'private-magic-token-for-test'
const existingEventId = 'existing-event'
const probeUuid = '99999999-9999-4999-8999-999999999999'

const environment = {
  ACAPPELLA_TT_CLOUD_V1_SMOKE_SUPABASE_URL: origin,
  ACAPPELLA_TT_CLOUD_V1_SMOKE_PUBLISHABLE_KEY: publishableKey,
}

const createTarget = (run = true) => validateCloudV1HostedAuthzSmokeTarget({
  run,
  workspaceId,
  confirmWorkspaceId: workspaceId.toUpperCase(),
  confirmProjectRef: projectRef,
}, environment)

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const readRequestBody = init => JSON.parse(init.body)

const createHostedFetchStub = ({
  unauthenticatedStatus = 401,
  invalidJwtStatus = 401,
  pageWorkspaceId = workspaceId,
  visibleWorkspaceId = workspaceId,
  membershipRole = 'viewer',
  emptyEvents = false,
  afterEventId = existingEventId,
  afterRevision = 3,
  afterGeneration = '7',
  deleteStatus = 403,
  deleteBody = { code: '42501', message: 'permission denied' },
  verifyError,
} = {}) => {
  const calls = []
  let authorizedPageReadCount = 0
  let visibleEventReadCount = 0
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const headers = new Headers(init.headers)
    const authorization = headers.get('authorization')
    calls.push({ url, init, authorization })
    assert.equal(headers.get('apikey'), publishableKey)

    if (url.pathname === '/rest/v1/rpc/load_cloud_events_page_authorized') {
      const body = readRequestBody(init)
      assert.equal(body.p_workspace_id, workspaceId)
      if (authorization === null) {
        return jsonResponse({ code: 'PGRST301' }, unauthenticatedStatus)
      }
      if (authorization === 'Bearer invalid.invalid.invalid') {
        return jsonResponse({ code: 'PGRST301' }, invalidJwtStatus)
      }
      assert.equal(authorization, `Bearer ${accessToken}`)
      const isAfter = authorizedPageReadCount > 0
      authorizedPageReadCount += 1
      return jsonResponse({
        status: 'ok',
        workspace_id: pageWorkspaceId,
        workspace_generation: isAfter ? afterGeneration : '7',
        rows: emptyEvents ? [] : [{
          workspace_id: pageWorkspaceId,
          event_id: isAfter ? afterEventId : existingEventId,
          revision: isAfter ? afterRevision : 3,
        }],
        next_cursor: null,
      })
    }

    if (url.pathname === '/auth/v1/verify') {
      if (verifyError) throw verifyError
      assert.equal(authorization, null)
      assert.deepEqual(readRequestBody(init), {
        token_hash: magicToken,
        type: 'magiclink',
      })
      return jsonResponse({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: { id: userId, email: 'private@example.invalid' },
      })
    }

    if (url.pathname === '/auth/v1/user') {
      assert.equal(authorization, `Bearer ${accessToken}`)
      return jsonResponse({ id: userId, email: 'private@example.invalid' })
    }

    if (url.pathname === '/rest/v1/workspace_members') {
      assert.equal(authorization, `Bearer ${accessToken}`)
      assert.equal(url.searchParams.get('user_id'), `eq.${userId}`)
      return jsonResponse([{ workspace_id: workspaceId, role: membershipRole }])
    }

    if (url.pathname === '/rest/v1/cloud_events') {
      assert.equal(authorization, `Bearer ${accessToken}`)
      const isAfter = visibleEventReadCount > 0
      visibleEventReadCount += 1
      return jsonResponse(emptyEvents ? [] : [{
        workspace_id: visibleWorkspaceId,
        event_id: isAfter ? afterEventId : existingEventId,
        revision: isAfter ? afterRevision : 3,
      }])
    }

    if (url.pathname === '/rest/v1/rpc/delete_cloud_event_authorized') {
      assert.equal(authorization, `Bearer ${accessToken}`)
      assert.deepEqual(readRequestBody(init), {
        p_workspace_id: workspaceId,
        p_event_id: `hosted-authz-smoke-${probeUuid}`,
      })
      return jsonResponse(deleteBody, deleteStatus)
    }

    throw new Error('Unexpected stub request.')
  }
  return { fetchImpl, calls }
}

const readMagicLink = async () =>
  `${origin}/auth/v1/verify?token=${magicToken}&type=magiclink&redirect_to=https%3A%2F%2Fapp.example`

test('CLI引数は先頭separatorを許容し途中separator・重複・不足を拒否する', () => {
  assert.deepEqual(parseCloudV1HostedAuthzSmokeArguments([
    '--',
    '--run',
    '--workspace-id', workspaceId,
    '--confirm-workspace-id', workspaceId,
    '--confirm-project-ref', projectRef,
  ]), {
    run: true,
    workspaceId,
    confirmWorkspaceId: workspaceId,
    confirmProjectRef: projectRef,
  })
  assert.throws(
    () => parseCloudV1HostedAuthzSmokeArguments(['--workspace-id', workspaceId, '--']),
    /Unexpected argument separator/u,
  )
  assert.throws(
    () => parseCloudV1HostedAuthzSmokeArguments(['--run', '--run']),
    /Duplicate smoke test option/u,
  )
  assert.throws(
    () => parseCloudV1HostedAuthzSmokeArguments(['--workspace-id']),
    /option value is missing/u,
  )
})

test('Hosted対象は確認済みHTTPS Project origin・Publishable Key・Workspaceだけを許可する', () => {
  assert.deepEqual(createTarget(false), {
    run: false,
    origin,
    projectRef,
    workspaceId,
    publishableKey,
  })

  for (const invalidUrl of [
    'http://abcdefghijklmnopqrst.supabase.co',
    'https://abcdefghijklmnopqrst.supabase.co.evil.example',
    'https://user:password@abcdefghijklmnopqrst.supabase.co',
    'https://abcdefghijklmnopqrst.supabase.co/rest/v1',
    'https://abcdefghijklmnopqrst.supabase.co?host=evil.example',
    'https://abcdefghijklmnopqrst.supabase.co#fragment',
    'https://127.0.0.1',
  ]) {
    assert.throws(() => validateCloudV1HostedAuthzSmokeTarget({
      run: false,
      workspaceId,
      confirmWorkspaceId: workspaceId,
      confirmProjectRef: projectRef,
    }, {
      ...environment,
      ACAPPELLA_TT_CLOUD_V1_SMOKE_SUPABASE_URL: invalidUrl,
    }), undefined, invalidUrl)
  }

  assert.throws(() => validateCloudV1HostedAuthzSmokeTarget({
    run: false,
    workspaceId,
    confirmWorkspaceId: '33333333-3333-4333-8333-333333333333',
    confirmProjectRef: projectRef,
  }, environment), /Workspace confirmation/u)
  assert.throws(() => validateCloudV1HostedAuthzSmokeTarget({
    run: false,
    workspaceId,
    confirmWorkspaceId: workspaceId,
    confirmProjectRef: 'zzzzzzzzzzzzzzzzzzzz',
  }, environment), /project confirmation/u)
  assert.throws(() => validateCloudV1HostedAuthzSmokeTarget({
    run: false,
    workspaceId,
    confirmWorkspaceId: workspaceId,
    confirmProjectRef: projectRef,
  }, {
    ...environment,
    ACAPPELLA_TT_CLOUD_V1_SMOKE_PUBLISHABLE_KEY: 'service-role-secret',
  }), /Publishable Key/u)
})

test('Magic Linkは確認済みAuth endpointの単一magiclink tokenだけを受理する', () => {
  assert.deepEqual(parseCloudV1MagicLink(
    `${origin}/auth/v1/verify?token=${magicToken}&type=magiclink`,
    createTarget(),
  ), { tokenHash: magicToken, type: 'magiclink' })

  for (const invalidLink of [
    `https://otherprojectref00000.supabase.co/auth/v1/verify?token=${magicToken}&type=magiclink`,
    `${origin}/auth/v1/verify?token=${magicToken}&type=recovery`,
    `${origin}/auth/v1/verify?token=${magicToken}&token=other&type=magiclink`,
    `${origin}/auth/v1/verify?token=${magicToken}&type=magiclink&unexpected=value`,
    `${origin}/auth/v1/verify?token=${magicToken}&type=magiclink#secret`,
  ]) {
    assert.throws(() => parseCloudV1MagicLink(invalidLink, createTarget()))
  }
})

test('実HTTPフローは401・Viewer read・RLS範囲・42501拒否・前後不変を検証する', async () => {
  const { fetchImpl, calls } = createHostedFetchStub()
  const lines = []
  const result = await runCloudV1HostedAuthzSmoke(createTarget(), {
    fetchImpl,
    readMagicLink,
    randomUuid: () => probeUuid,
    reporter: {
      pass: label => lines.push(`PASS ${label}`),
      skip: (label, reason) => lines.push(`SKIP ${label}: ${reason}`),
    },
  })

  assert.deepEqual(result, { passed: 9, skipped: 2 })
  assert.equal(lines.filter(line => line.startsWith('PASS ')).length, 9)
  assert.equal(lines.filter(line => line.startsWith('SKIP ')).length, 2)
  assert.equal(calls.filter(call =>
    call.url.pathname === '/rest/v1/rpc/delete_cloud_event_authorized').length, 1)
  assert.equal(calls.some(call => call.url.pathname.includes('save-cloud-event')), false)
  const output = lines.join('\n')
  for (const secret of [accessToken, refreshToken, magicToken, publishableKey, 'private@example.invalid']) {
    assert.doesNotMatch(output, new RegExp(secret))
  }
})

test('CLI実行は個別PASS/SKIPと完了件数を表示して成功終了する', async () => {
  const { fetchImpl } = createHostedFetchStub()
  const output = []
  const status = await runCloudV1HostedAuthzSmokeCli({
    argv: [
      '--run',
      '--workspace-id', workspaceId,
      '--confirm-workspace-id', workspaceId,
      '--confirm-project-ref', projectRef,
    ],
    environment,
    fetchImpl,
    readMagicLink,
    randomUuid: () => probeUuid,
    writeLine: line => output.push(line),
    writeError: line => output.push(line),
  })
  assert.equal(status, 0)
  assert.equal(output.filter(line => line.startsWith('PASS ')).length, 9)
  assert.equal(output.filter(line => line.startsWith('SKIP ')).length, 2)
  assert.match(
    output.at(-1),
    /no save\/create request was sent; one delete-denial RPC was sent for a confirmed-absent random Event ID/u,
  )
  assert.doesNotMatch(output.at(-1), /no write scenario/u)
})

test('保存済みEventが0件なら削除RPC前に検証不能として失敗する', async () => {
  const { fetchImpl, calls } = createHostedFetchStub({ emptyEvents: true })
  const output = []
  const status = await runCloudV1HostedAuthzSmokeCli({
    argv: [
      '--run',
      '--workspace-id', workspaceId,
      '--confirm-workspace-id', workspaceId,
      '--confirm-project-ref', projectRef,
    ],
    environment,
    fetchImpl,
    readMagicLink,
    randomUuid: () => probeUuid,
    writeLine: line => output.push(line),
    writeError: line => output.push(line),
  })
  assert.equal(status, 1)
  assert.match(
    output.at(-1),
    /no observable saved Cloud Event; authorization verification is inconclusive/u,
  )
  assert.equal(calls.some(call =>
    call.url.pathname === '/rest/v1/rpc/delete_cloud_event_authorized'), false)
})

test('対象membershipがViewer以外なら認可smokeを続行しない', async () => {
  for (const membershipRole of ['owner', 'editor']) {
    const { fetchImpl, calls } = createHostedFetchStub({ membershipRole })
    await assert.rejects(
      runCloudV1HostedAuthzSmoke(createTarget(), {
        fetchImpl,
        readMagicLink,
        randomUuid: () => probeUuid,
        reporter: { pass() {}, skip() {} },
      }),
      /authenticated user is not a viewer/u,
    )
    assert.equal(calls.some(call =>
      call.url.pathname === '/rest/v1/rpc/delete_cloud_event_authorized'), false)
  }
})

test('認証拒否が401でない場合はMagic Link交換前に失敗する', async () => {
  const { fetchImpl } = createHostedFetchStub({ unauthenticatedStatus: 200 })
  let prompted = false
  await assert.rejects(
    runCloudV1HostedAuthzSmoke(createTarget(), {
      fetchImpl,
      readMagicLink: async () => {
        prompted = true
        return await readMagicLink()
      },
      randomUuid: () => probeUuid,
      reporter: { pass() {}, skip() {} },
    }),
    /Missing Authorization was not rejected/u,
  )
  assert.equal(prompted, false)
})

test('想定外のdelete応答は既存状態が不変でも失敗する', async () => {
  for (const response of [
    { deleteStatus: 200, deleteBody: { status: 'already_absent' } },
    { deleteStatus: 403, deleteBody: { code: 'PGRST301', message: 'unexpected' } },
  ]) {
    const { fetchImpl } = createHostedFetchStub(response)
    await assert.rejects(
      runCloudV1HostedAuthzSmoke(createTarget(), {
        fetchImpl,
        readMagicLink,
        randomUuid: () => probeUuid,
        reporter: { pass() {}, skip() {} },
      }),
      /Viewer delete was not rejected with HTTP 403 and SQLSTATE 42501/u,
    )
  }
})

test('削除試験前後のEvent ID・revision・generation変化をそれぞれ拒否する', async () => {
  for (const changedState of [
    { afterEventId: 'changed-event' },
    { afterRevision: 4 },
    { afterGeneration: '8' },
  ]) {
    const { fetchImpl } = createHostedFetchStub(changedState)
    await assert.rejects(
      runCloudV1HostedAuthzSmoke(createTarget(), {
        fetchImpl,
        readMagicLink,
        randomUuid: () => probeUuid,
        reporter: { pass() {}, skip() {} },
      }),
      /Cloud Event metadata, revisions, or generation changed/u,
    )
  }
})

test('不正なAuthorized page応答を正常なViewer readとして扱わない', async () => {
  const { fetchImpl } = createHostedFetchStub({
    pageWorkspaceId: '33333333-3333-4333-8333-333333333333',
  })
  await assert.rejects(
    runCloudV1HostedAuthzSmoke(createTarget(), {
      fetchImpl,
      readMagicLink,
      randomUuid: () => probeUuid,
      reporter: { pass() {}, skip() {} },
    }),
    /Authorized page RPC response is invalid/u,
  )
})

test('membership外WorkspaceのEventが見えた場合はRLS範囲不正として拒否する', async () => {
  const { fetchImpl } = createHostedFetchStub({
    visibleWorkspaceId: '33333333-3333-4333-8333-333333333333',
  })
  await assert.rejects(
    runCloudV1HostedAuthzSmoke(createTarget(), {
      fetchImpl,
      readMagicLink,
      randomUuid: () => probeUuid,
      reporter: { pass() {}, skip() {} },
    }),
    /exposed a Workspace without viewer membership/u,
  )
})

test('dry-runは確認だけを行いHTTP送信もMagic Link入力も開始しない', async () => {
  let fetchCount = 0
  let promptCount = 0
  const output = []
  const status = await runCloudV1HostedAuthzSmokeCli({
    argv: [
      '--workspace-id', workspaceId,
      '--confirm-workspace-id', workspaceId,
      '--confirm-project-ref', projectRef,
    ],
    environment,
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error('must not run')
    },
    readMagicLink: async () => {
      promptCount += 1
      throw new Error('must not run')
    },
    writeLine: line => output.push(line),
    writeError: line => output.push(line),
  })
  assert.equal(status, 0)
  assert.equal(fetchCount, 0)
  assert.equal(promptCount, 0)
  assert.match(output.join('\n'), /DRY-RUN/u)
})

test('HTTP・Magic Link交換失敗でもURL・token・key・個人情報を出力しない', async () => {
  const secretError = new Error(
    `unsafe ${magicToken} ${accessToken} ${refreshToken} ${publishableKey} private@example.invalid`,
  )
  const { fetchImpl } = createHostedFetchStub({ verifyError: secretError })
  const output = []
  const status = await runCloudV1HostedAuthzSmokeCli({
    argv: [
      '--run',
      '--workspace-id', workspaceId,
      '--confirm-workspace-id', workspaceId,
      '--confirm-project-ref', projectRef,
    ],
    environment,
    fetchImpl,
    readMagicLink,
    randomUuid: () => probeUuid,
    writeLine: line => output.push(line),
    writeError: line => output.push(line),
  })
  assert.equal(status, 1)
  const rendered = output.join('\n')
  assert.match(rendered, /Hosted HTTP request failed or timed out/u)
  for (const secret of [
    origin,
    magicToken,
    accessToken,
    refreshToken,
    publishableKey,
    'private@example.invalid',
  ]) {
    assert.doesNotMatch(rendered, new RegExp(secret))
  }
})

test('対象URL誤指定は最初のHTTP requestより前に固定文言で拒否する', async () => {
  const secret = 'do-not-print-this-password'
  let fetchCount = 0
  const output = []
  const status = await runCloudV1HostedAuthzSmokeCli({
    argv: [
      '--run',
      '--workspace-id', workspaceId,
      '--confirm-workspace-id', workspaceId,
      '--confirm-project-ref', projectRef,
    ],
    environment: {
      ...environment,
      ACAPPELLA_TT_CLOUD_V1_SMOKE_SUPABASE_URL: `not-a-url-${secret}`,
    },
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error('must not run')
    },
    readMagicLink,
    writeLine: line => output.push(line),
    writeError: line => output.push(line),
  })
  assert.equal(status, 1)
  assert.equal(fetchCount, 0)
  assert.match(output.join('\n'), /Hosted smoke URL is invalid/u)
  assert.doesNotMatch(output.join('\n'), new RegExp(secret))
})
