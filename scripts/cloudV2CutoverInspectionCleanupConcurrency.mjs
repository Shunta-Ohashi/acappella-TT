import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspaceId = '79500000-0000-4000-8000-000000000001'
const authUserId = '00000000-0000-4000-8000-000000000075'
const authEmail = 'cloud-v2-cleanup-race@example.invalid'
const cleanupGateKey = '7950000075000001'
const processTimeoutMs = 30_000
const pollLimit = 200
const diagnosticBufferLimit = 16_000
const diagnosticOutputLimit = 4_000

const fixtureSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_v2_cutover_inspection_cleanup_concurrency.sql',
  import.meta.url,
))
const cleanupSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_v2_cutover_inspection_concurrency_cleanup.sql',
  import.meta.url,
))

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}

export const sanitizePsqlDiagnostic = (diagnostic, databaseUrl) => {
  let sanitized = String(diagnostic ?? '')
  const secrets = new Set([databaseUrl])
  try {
    const parsedUrl = new URL(databaseUrl)
    secrets.add(parsedUrl.toString())
    if (parsedUrl.password) {
      secrets.add(parsedUrl.password)
      try {
        secrets.add(decodeURIComponent(parsedUrl.password))
      } catch {
        // The original password is still redacted when percent-decoding fails.
      }
    }
  } catch {
    // validateDatabaseUrl() rejects this before an InteractivePsql is created.
  }
  sanitized = sanitized.replace(
    /postgres(?:ql)?:\/\/[^\s"']+/giu,
    '[REDACTED_DATABASE_URL]',
  )
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(secret).join('[REDACTED]')
  }
  const trimmed = sanitized.trim()
  return trimmed.length > diagnosticOutputLimit
    ? `...[diagnostic truncated]\n${trimmed.slice(-diagnosticOutputLimit)}`
    : trimmed
}

const parseArguments = rawArguments => {
  const args = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments
  let dbUrlEnv
  let confirmDisposable = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--confirm-disposable') {
      ensure(!confirmDisposable, 'Duplicate --confirm-disposable argument.')
      confirmDisposable = true
      continue
    }
    if (argument === '--db-url-env') {
      ensure(!dbUrlEnv, 'Duplicate --db-url-env argument.')
      const value = args[++index]?.trim()
      ensure(value && !value.startsWith('--'), '--db-url-env requires a value.')
      dbUrlEnv = value
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  ensure(confirmDisposable && dbUrlEnv, (
    'A disposable --db-url-env and --confirm-disposable are required.'
  ))
  return { dbUrlEnv }
}

const validateDatabaseUrl = value => {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('The disposable PostgreSQL URL is invalid.')
  }
  ensure(
    ['postgres:', 'postgresql:'].includes(url.protocol),
    'The disposable database must use PostgreSQL.',
  )
  ensure(
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase()),
    'The cleanup concurrency runner accepts loopback databases only.',
  )
}

const psqlBaseArguments = databaseUrl => [
  '--no-psqlrc',
  '--quiet',
  '--no-align',
  '--tuples-only',
  '--set=ON_ERROR_STOP=1',
  '--set=VERBOSITY=verbose',
  '--dbname',
  databaseUrl,
]

const runPsql = (databaseUrl, extraArguments, applicationName, timeoutMs = processTimeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('psql', [
      ...psqlBaseArguments(databaseUrl),
      ...extraArguments,
    ], {
      windowsHide: true,
      env: { ...process.env, PGAPPNAME: applicationName },
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
      reject(new Error(`${applicationName}: psql timed out.`))
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new Error(`${applicationName}: psql could not be started.`))
    })
    child.once('close', code => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })

const runCommand = async (databaseUrl, sql, applicationName) => {
  const result = await runPsql(databaseUrl, ['--command', sql], applicationName)
  ensure(result.code === 0, `${applicationName}: PostgreSQL command failed.`)
  return result.stdout.trim()
}

const runCleanup = (databaseUrl, options = {}) => runPsql(databaseUrl, [
  ...(options.gateKey ? ['--set', `cleanup_test_gate_key=${options.gateKey}`] : []),
  '--file',
  cleanupSqlPath,
], options.applicationName ?? 'cloud-v2-cleanup-actual')

class InteractivePsql {
  constructor(databaseUrl, applicationName) {
    this.databaseUrl = databaseUrl
    this.applicationName = applicationName
    this.buffer = ''
    this.stderrBuffer = ''
    this.pending = undefined
    this.exited = false
    this.markerCounter = 0
    this.child = spawn('psql', psqlBaseArguments(databaseUrl), {
      windowsHide: true,
      env: { ...process.env, PGAPPNAME: applicationName },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-diagnosticBufferLimit)
    })
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk
      this.resolvePending()
    })
    this.exitPromise = new Promise(resolve => {
      this.child.once('close', code => {
        this.exited = true
        if (this.pending) {
          const diagnostic = sanitizePsqlDiagnostic(this.stderrBuffer, this.databaseUrl)
          const detail = diagnostic ? `\npsql diagnostic:\n${diagnostic}` : ''
          this.pending.reject(new Error(
            `${this.applicationName}: psql exited early (code ${code ?? 'unknown'}).${detail}`,
          ))
          this.pending = undefined
        }
        resolve(code)
      })
      this.child.once('error', () => {
        if (this.pending) {
          this.pending.reject(new Error(`${this.applicationName}: psql could not be started.`))
          this.pending = undefined
        }
      })
    })
  }

  resolvePending() {
    if (!this.pending) return
    const markerIndex = this.buffer.indexOf(this.pending.marker)
    if (markerIndex < 0) return
    const output = this.buffer.slice(0, markerIndex).trim()
    this.buffer = this.buffer.slice(markerIndex + this.pending.marker.length)
    const { resolve } = this.pending
    this.pending = undefined
    this.stderrBuffer = ''
    resolve(output)
  }

  command(sql) {
    ensure(!this.exited, `${this.applicationName}: psql already exited.`)
    ensure(!this.pending, `${this.applicationName}: another command is pending.`)
    const marker = `__ACAPPELLA_STEP_${++this.markerCounter}__`
    return new Promise((resolve, reject) => {
      this.pending = { marker, resolve, reject }
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`)
    })
  }

  async close() {
    if (this.exited) return
    this.child.stdin.end('\\q\n')
    await this.exitPromise
  }

  async kill() {
    if (!this.exited) this.child.kill()
    await this.exitPromise
  }
}

const waitForLock = async (databaseUrl, applicationName, expectedWaitEvent) => {
  for (let attempt = 0; attempt < pollLimit; attempt += 1) {
    const observed = await runCommand(
      databaseUrl,
      `select concat_ws(':', wait_event_type, wait_event)
       from pg_catalog.pg_stat_activity
       where application_name = '${applicationName}'
       order by pid
       limit 1`,
      'cloud-v2-cleanup-observer',
    )
    if (
      observed.startsWith('Lock:') &&
      (!expectedWaitEvent || observed === `Lock:${expectedWaitEvent}`)
    ) return
    await delay(10)
  }
  throw new Error(`${applicationName}: expected lock wait was not observed.`)
}

const getFixtureState = async databaseUrl => {
  const json = await runCommand(databaseUrl, `
    select jsonb_build_object(
      'workspaceCount', (select count(*) from public.workspaces
        where id = '${workspaceId}'),
      'eventCount', (select count(*) from public.cloud_events
        where workspace_id = '${workspaceId}'),
      'eventName', (select event_name from public.cloud_events
        where workspace_id = '${workspaceId}' and event_id = 'event-a'),
      'snapshotEventName', (select event_snapshot -> 'appState' -> 'events' -> 0 ->> 'name'
        from public.cloud_events
        where workspace_id = '${workspaceId}' and event_id = 'event-a'),
      'revision', (select revision::text from public.cloud_events
        where workspace_id = '${workspaceId}' and event_id = 'event-a'),
      'generation', (select generation::text
        from public.cloud_event_workspace_generations
        where workspace_id = '${workspaceId}'),
      'membershipCount', (select count(*) from public.workspace_members
        where workspace_id = '${workspaceId}'),
      'authUserCount', (select count(*) from auth.users where id = '${authUserId}')
    )::text
  `, 'cloud-v2-cleanup-state-check')
  return JSON.parse(json)
}

const assertFixtureUnchanged = async databaseUrl => {
  const state = await getFixtureState(databaseUrl)
  ensure(state.workspaceCount === 1, 'Fixture Workspace was deleted unexpectedly.')
  ensure(state.eventCount === 1, 'Fixture Event was deleted unexpectedly.')
  ensure(state.eventName === 'Before inspection race', 'Fixture Event name changed.')
  ensure(state.snapshotEventName === 'Before inspection race', 'Fixture Snapshot changed.')
  ensure(state.revision === '1', 'Fixture Event revision changed.')
  ensure(state.generation === '1', 'Fixture generation changed.')
  ensure(state.membershipCount === 0, 'Fixture membership changed.')
  ensure(state.authUserCount === 1, 'Fixture Auth user changed.')
}

const assertCleanupRejected = result => {
  ensure(result.code !== 0, 'Actual cleanup unexpectedly succeeded during a writer lock.')
  ensure(
    /\b55000\b/u.test(`${result.stdout}\n${result.stderr}`),
    'Actual cleanup did not report SQLSTATE 55000.',
  )
}

const removeDedicatedAuthUser = databaseUrl => runCommand(databaseUrl, `
  begin;
  do $$
  begin
    if not exists (
      select 1 from auth.users
      where id = '${authUserId}'
        and email = '${authEmail}'
        and aud = 'authenticated'
        and role = 'authenticated'
    ) or exists (
      select 1 from public.workspace_members where user_id = '${authUserId}'
    ) or exists (
      select 1 from public.profiles where user_id = '${authUserId}'
    ) or exists (
      select 1 from public.workspaces where id = '${workspaceId}'
    ) then
      raise exception using
        errcode = '55000',
        message = 'Dedicated cleanup concurrency Auth fixture is not safe to remove';
    end if;
    delete from auth.users where id = '${authUserId}' and email = '${authEmail}';
    if not found then raise exception 'Dedicated Auth fixture was not removed'; end if;
  end;
  $$;
  commit;
`, 'cloud-v2-cleanup-auth-removal')

const assertFinalStateIsEmpty = async databaseUrl => {
  const remaining = await runCommand(databaseUrl, `
    select (
      (select count(*) from public.workspaces where id = '${workspaceId}') +
      (select count(*) from public.workspace_members where workspace_id = '${workspaceId}') +
      (select count(*) from public.cloud_events where workspace_id = '${workspaceId}') +
      (select count(*) from public.workspace_master_members where workspace_id = '${workspaceId}') +
      (select count(*) from public.workspace_master_bands where workspace_id = '${workspaceId}') +
      (select count(*) from public.workspace_master_band_members where workspace_id = '${workspaceId}') +
      (select count(*) from public.cloud_event_member_references where workspace_id = '${workspaceId}') +
      (select count(*) from public.cloud_event_band_references where workspace_id = '${workspaceId}') +
      (select count(*) from public.cloud_workspace_master_backfills where workspace_id = '${workspaceId}') +
      (select count(*) from public.cloud_workspace_master_states where workspace_id = '${workspaceId}') +
      (select count(*) from public.cloud_event_workspace_generations where workspace_id = '${workspaceId}') +
      (select count(*) from auth.users where id = '${authUserId}')
    )::text
  `, 'cloud-v2-cleanup-final-check')
  ensure(remaining === '0', 'Dedicated cleanup concurrency fixture remains after the test.')
}

const rollbackAndClose = async session => {
  if (!session) return
  try {
    if (!session.pending && !session.exited) await session.command('rollback;')
  } catch {
    // Killing the client below also rolls its transaction back.
  }
  await session.kill()
}

const run = async databaseUrl => {
  const setup = await runPsql(databaseUrl, [
    '--set=confirm_cleanup_concurrency_fixture=1',
    '--file',
    fixtureSqlPath,
  ], 'cloud-v2-cleanup-fixture-setup')
  ensure(setup.code === 0, 'Dedicated cleanup concurrency fixture setup failed.')

  let fixtureExists = true
  let eventWriter
  let membershipWriter
  let gateHolder
  let cleanupInFlight
  try {
    eventWriter = new InteractivePsql(databaseUrl, 'cloud-v2-cleanup-event-first')
    await eventWriter.command(`
      begin;
      update public.cloud_events
      set event_name = 'Uncommitted Event writer',
          event_snapshot = jsonb_set(
            event_snapshot,
            '{appState,events,0,name}',
            to_jsonb('Uncommitted Event writer'::text),
            false
          )
      where workspace_id = '${workspaceId}' and event_id = 'event-a';
    `)
    assertCleanupRejected(await runCleanup(databaseUrl, {
      applicationName: 'cloud-v2-cleanup-against-event-writer',
    }))
    await assertFixtureUnchanged(databaseUrl)
    await eventWriter.command('rollback;')
    await eventWriter.close()
    eventWriter = undefined
    await assertFixtureUnchanged(databaseUrl)

    membershipWriter = new InteractivePsql(databaseUrl, 'cloud-v2-cleanup-membership-first')
    await membershipWriter.command(`
      begin;
      insert into public.workspace_members (workspace_id, user_id, role) values (
        '${workspaceId}', '${authUserId}', 'viewer'
      );
    `)
    assertCleanupRejected(await runCleanup(databaseUrl, {
      applicationName: 'cloud-v2-cleanup-against-membership-writer',
    }))
    await assertFixtureUnchanged(databaseUrl)
    await membershipWriter.command('rollback;')
    await membershipWriter.close()
    membershipWriter = undefined
    await assertFixtureUnchanged(databaseUrl)

    gateHolder = new InteractivePsql(databaseUrl, 'cloud-v2-cleanup-gate-holder')
    await gateHolder.command(`begin; select pg_advisory_xact_lock(${cleanupGateKey});`)
    cleanupInFlight = runCleanup(databaseUrl, {
      applicationName: 'cloud-v2-cleanup-actual-gated',
      gateKey: cleanupGateKey,
    })
    cleanupInFlight.catch(() => {})
    await waitForLock(databaseUrl, 'cloud-v2-cleanup-actual-gated', 'advisory')

    eventWriter = new InteractivePsql(databaseUrl, 'cloud-v2-cleanup-event-behind')
    const eventWriterResult = eventWriter.command(`
      begin;
      do $$
      begin
        update public.cloud_events
        set event_name = 'Unexpected concurrent write',
            event_snapshot = jsonb_set(
              event_snapshot,
              '{appState,events,0,name}',
              to_jsonb('Unexpected concurrent write'::text),
              false
            )
        where workspace_id = '${workspaceId}' and event_id = 'event-a';
        if found then raise exception 'Event writer changed a cleanup-owned row'; end if;
      end;
      $$;
    `)
    eventWriterResult.catch(() => {})

    membershipWriter = new InteractivePsql(databaseUrl, 'cloud-v2-cleanup-membership-behind')
    const membershipWriterResult = membershipWriter.command(`
      begin;
      do $$
      begin
        begin
          insert into public.workspace_members (workspace_id, user_id, role) values (
            '${workspaceId}', '${authUserId}', 'viewer'
          );
          raise exception 'membership insert unexpectedly succeeded';
        exception when foreign_key_violation then
          null;
        end;
      end;
      $$;
    `)
    membershipWriterResult.catch(() => {})

    await waitForLock(databaseUrl, 'cloud-v2-cleanup-event-behind')
    await waitForLock(databaseUrl, 'cloud-v2-cleanup-membership-behind')
    await gateHolder.command('commit;')
    await gateHolder.close()
    gateHolder = undefined

    const cleanup = await cleanupInFlight
    cleanupInFlight = undefined
    ensure(cleanup.code === 0, 'Actual cleanup failed after winning every required lock.')
    await eventWriterResult
    await membershipWriterResult
    await eventWriter.command('rollback;')
    await membershipWriter.command('rollback;')
    await eventWriter.close()
    await membershipWriter.close()
    eventWriter = undefined
    membershipWriter = undefined

    await removeDedicatedAuthUser(databaseUrl)
    await assertFinalStateIsEmpty(databaseUrl)
    fixtureExists = false
    process.stdout.write(JSON.stringify({
      ok: true,
      scenarios: [
        'event-writer-first-rejected-55000',
        'membership-writer-first-rejected-55000',
        'cleanup-first-writers-blocked',
        'actual-cleanup-removed-fixture',
      ],
    }) + '\n')
  } finally {
    await rollbackAndClose(gateHolder)
    await rollbackAndClose(eventWriter)
    await rollbackAndClose(membershipWriter)
    if (cleanupInFlight) {
      try {
        await cleanupInFlight
      } catch {
        // The strict recovery below is the authoritative final safety check.
      }
    }
    if (fixtureExists) {
      const cleanup = await runCleanup(databaseUrl, {
        applicationName: 'cloud-v2-cleanup-failure-recovery',
      })
      if (cleanup.code === 0) {
        try {
          await removeDedicatedAuthUser(databaseUrl)
          await assertFinalStateIsEmpty(databaseUrl)
        } catch {
          process.stderr.write('Explicit Auth fixture cleanup is still required.\n')
        }
      } else {
        try {
          const state = await getFixtureState(databaseUrl)
          if (state.workspaceCount === 0 && state.authUserCount === 1) {
            await removeDedicatedAuthUser(databaseUrl)
            await assertFinalStateIsEmpty(databaseUrl)
          } else {
            throw new Error('Workspace fixture still exists.')
          }
        } catch {
          process.stderr.write(
            'Strict cleanup refused the remaining fixture; inspect fixed IDs before recovery.\n',
          )
        }
      }
    }
  }
}

const main = async () => {
  try {
    const { dbUrlEnv } = parseArguments(process.argv.slice(2))
    const databaseUrl = process.env[dbUrlEnv]?.trim()
    ensure(databaseUrl, `Environment variable ${dbUrlEnv} is required.`)
    validateDatabaseUrl(databaseUrl)
    await run(databaseUrl)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cleanup concurrency test failed.'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
