import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { createCloudEventSnapshot } from '../src/cloud/cloudEventSnapshot.ts'
import { createCloudV2CutoverInspectionReport } from '../src/cloud/cloudV2CutoverInspection.ts'
import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
} from '../src/cloud/cloudWorkspaceMasterBackfill.ts'
import { createPostgresJsonbSha256Fingerprint } from '../src/cloud/postgresJsonbFingerprint.ts'

const expectedDatabasePort = '55822'
const allowedDatabaseUrlParameter = 'connect_timeout'
const commandTimeoutMs = 30_000
const diagnosticBufferLimit = 16_000
const diagnosticOutputLimit = 4_000

const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
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
    throw new Error('Unknown command-line argument.')
  }
  ensure(
    confirmDisposable && dbUrlEnv,
    'A disposable --db-url-env and --confirm-disposable are required.',
  )
  return { dbUrlEnv }
}

const decodeUrlComponent = value => {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('The disposable PostgreSQL URL contains invalid percent-encoding.')
  }
}

export const validateDatabaseUrl = value => {
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
    'The integration runner accepts loopback databases only.',
  )
  ensure(
    url.port === expectedDatabasePort,
    `The integration runner only accepts the confirmed disposable port ${expectedDatabasePort}.`,
  )
  ensure(
    decodeUrlComponent(url.pathname) === '/postgres',
    'The integration runner only accepts the disposable postgres database.',
  )
  ensure(
    url.hash === '' && !value.includes('#'),
    'The disposable PostgreSQL URL must not contain a fragment.',
  )

  // Validate the encoded userinfo and complete raw query before URLSearchParams
  // normalizes them. This makes malformed percent escapes fail closed.
  decodeUrlComponent(url.username)
  decodeUrlComponent(url.password)
  if (url.search) decodeUrlComponent(url.search.slice(1))

  const queryEntries = [...url.searchParams.entries()]
  ensure(
    queryEntries.every(([name]) => name === allowedDatabaseUrlParameter),
    'The disposable PostgreSQL URL contains an unsupported query parameter.',
  )
  const timeoutValues = url.searchParams.getAll(allowedDatabaseUrlParameter)
  ensure(
    timeoutValues.length <= 1,
    'The disposable PostgreSQL URL contains duplicate connect_timeout parameters.',
  )
  if (timeoutValues.length === 1) {
    ensure(
      /^(?:[1-9]|[12][0-9]|30)$/u.test(timeoutValues[0]),
      'connect_timeout must be an integer from 1 through 30 seconds.',
    )
  }
}

const sanitizePsqlDiagnostic = (diagnostic, databaseUrl) => {
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
        // The encoded password is still redacted.
      }
    }
  } catch {
    // validateDatabaseUrl() rejects malformed values before psql is started.
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

const psqlArguments = databaseUrl => [
  '--no-psqlrc',
  '--quiet',
  '--no-align',
  '--tuples-only',
  '--set=ON_ERROR_STOP=1',
  '--set=VERBOSITY=verbose',
  '--dbname',
  databaseUrl,
]

class InteractivePsql {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl
    this.outputBuffer = ''
    this.diagnosticBuffer = ''
    this.pending = undefined
    this.exited = false
    this.markerCounter = 0
    this.child = spawn('psql', psqlArguments(databaseUrl), {
      windowsHide: true,
      env: {
        ...process.env,
        PGAPPNAME: 'cloud-v2-backfill-inspection-integration',
        PGCLIENTENCODING: 'UTF8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this.outputBuffer += chunk
      this.resolvePending()
    })
    this.child.stderr.on('data', chunk => {
      this.diagnosticBuffer = `${this.diagnosticBuffer}${chunk}`.slice(-diagnosticBufferLimit)
    })
    this.exitPromise = new Promise(resolve => {
      this.child.once('close', code => {
        this.exited = true
        if (this.pending) {
          clearTimeout(this.pending.timeout)
          const diagnostic = sanitizePsqlDiagnostic(
            this.diagnosticBuffer,
            this.databaseUrl,
          )
          const detail = diagnostic ? `\npsql diagnostic:\n${diagnostic}` : ''
          this.pending.reject(new Error(
            `PostgreSQL session exited early (code ${code ?? 'unknown'}).${detail}`,
          ))
          this.pending = undefined
        }
        resolve(code)
      })
      this.child.once('error', () => {
        if (this.pending) {
          clearTimeout(this.pending.timeout)
          this.pending.reject(new Error('psql could not be started.'))
          this.pending = undefined
        }
      })
    })
  }

  resolvePending() {
    if (!this.pending) return
    const markerIndex = this.outputBuffer.indexOf(this.pending.marker)
    if (markerIndex < 0) return
    const output = this.outputBuffer.slice(0, markerIndex).trim()
    this.outputBuffer = this.outputBuffer.slice(markerIndex + this.pending.marker.length)
    clearTimeout(this.pending.timeout)
    const { resolve } = this.pending
    this.pending = undefined
    this.diagnosticBuffer = ''
    resolve(output)
  }

  command(sql) {
    ensure(!this.exited, 'PostgreSQL session already exited.')
    ensure(!this.pending, 'Another PostgreSQL command is pending.')
    const marker = `__ACAPPELLA_INTEGRATION_${++this.markerCounter}_${randomUUID()}__`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending || this.pending.marker !== marker) return
        this.pending = undefined
        reject(new Error('PostgreSQL integration command timed out.'))
        this.child.kill()
      }, commandTimeoutMs)
      this.pending = { marker, resolve, reject, timeout }
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

const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`

const parseJsonOutput = (output, description) => {
  const line = output.split(/\r?\n/u).map(value => value.trim()).find(value => value.startsWith('{'))
  ensure(line, `${description} did not return JSON.`)
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`${description} returned invalid JSON.`)
  }
}

const runQuery = async (databaseUrl, sql) => {
  const session = new InteractivePsql(databaseUrl)
  try {
    return await session.command(sql)
  } finally {
    await session.close()
  }
}

const createFixtureState = eventId => ({
  members: [
    { id: 'member-a', realName: 'Backfill Member A 雪', active: true },
    { id: 'member-b', realName: 'Backfill Member B', active: true },
  ],
  bands: [{
    id: 'band-a',
    name: 'Backfill Band',
    defaultMemberIds: ['member-b', 'member-a'],
    active: true,
  }],
  events: [{
    id: eventId,
    name: 'Backfill inspection Event',
    timeZone: 'Asia/Tokyo',
    validationPolicy: { minimumGapBands: 1, minimumRestMinutes: 10 },
    performanceSlotMinutes: [5, 10],
  }],
  eventDays: [{ id: 'day-a', eventId, date: '2026-10-16', order: 0 }],
  stages: [{
    id: 'stage-a', eventDayId: 'day-a', name: 'Main', order: 0,
    plannedStartTime: '10:00',
  }],
  sections: [{
    id: 'section-a', stageId: 'stage-a', name: 'Part 1', order: 0,
    plannedStartTime: '10:00', plannedEndTime: '12:00',
  }],
  eventMembers: [
    {
      id: 'event-member-a', eventId, memberId: 'member-a',
      paCapabilities: { main: true, sub: true },
    },
    {
      id: 'event-member-b', eventId, memberId: 'member-b',
      paCapabilities: { main: false, sub: true },
    },
  ],
  eventMemberDays: [],
  eventBands: [{
    id: 'event-band-a', eventId, eventDayId: 'day-a', bandId: 'band-a',
    name: 'Backfill Live', memberIds: ['member-b', 'member-a'], durationMinutes: 5,
  }],
  scheduleItems: [{
    id: 'item-a', stageId: 'stage-a', sectionId: 'section-a',
    kind: 'performance', eventBandId: 'event-band-a', order: 0,
  }],
  paAssignments: [],
  dutyTypes: [],
  dutyAssignments: [],
  timetableLocks: [],
  timetableOrderConstraints: [],
})

const emptyExisting = {
  members: 0,
  bands: 0,
  bandMembers: 0,
  eventMemberReferences: 0,
  eventBandReferences: 0,
  completedBackfills: 0,
  completedBackfill: null,
}

const countFields = [
  ['eventCount', 'events'],
  ['memberCount', 'members'],
  ['bandCount', 'bands'],
  ['bandMemberRelationCount', 'bandMembers'],
  ['eventMemberReferenceCount', 'eventMemberReferences'],
  ['eventBandReferenceCount', 'eventBandReferences'],
]

const assertDatabaseContract = async databaseUrl => {
  const output = await runQuery(databaseUrl, `
    select pg_catalog.jsonb_build_object(
      'serverVersionNum', pg_catalog.current_setting('server_version_num'),
      'serverEncoding', pg_catalog.current_setting('server_encoding'),
      'databaseName', pg_catalog.current_database(),
      'backfillFunction', pg_catalog.to_regprocedure(
        'public.backfill_workspace_masters_validated(uuid,text,text,jsonb,boolean)'
      ) is not null,
      'inspectionFunction', pg_catalog.to_regprocedure(
        'public.inspect_cloud_v2_cutover_state(uuid)'
      ) is not null
    )::text;
  `)
  const contract = parseJsonOutput(output, 'Database contract check')
  const version = Number(contract.serverVersionNum)
  ensure(Number.isInteger(version) && version >= 170000 && version < 180000, (
    'The integration runner requires PostgreSQL 17.'
  ))
  ensure(contract.serverEncoding === 'UTF8', 'The integration runner requires UTF8.')
  ensure(contract.databaseName === 'postgres', 'The disposable database must be postgres.')
  ensure(contract.backfillFunction === true, 'The backfill RPC is unavailable.')
  ensure(contract.inspectionFunction === true, 'The inspection RPC is unavailable.')
}

const assertNoFixtureRows = async (databaseUrl, workspaceId) => {
  const id = sqlLiteral(workspaceId)
  const output = await runQuery(databaseUrl, `
    select pg_catalog.jsonb_build_object(
      'workspaces', (select count(*) from public.workspaces where id = ${id}::uuid),
      'memberships', (select count(*) from public.workspace_members where workspace_id = ${id}::uuid),
      'events', (select count(*) from public.cloud_events where workspace_id = ${id}::uuid),
      'masterStates', (select count(*) from public.cloud_workspace_master_states where workspace_id = ${id}::uuid),
      'generations', (select count(*) from public.cloud_event_workspace_generations where workspace_id = ${id}::uuid),
      'members', (select count(*) from public.workspace_master_members where workspace_id = ${id}::uuid),
      'bands', (select count(*) from public.workspace_master_bands where workspace_id = ${id}::uuid),
      'bandMembers', (select count(*) from public.workspace_master_band_members where workspace_id = ${id}::uuid),
      'eventMemberReferences', (select count(*) from public.cloud_event_member_references where workspace_id = ${id}::uuid),
      'eventBandReferences', (select count(*) from public.cloud_event_band_references where workspace_id = ${id}::uuid),
      'completedBackfills', (select count(*) from public.cloud_workspace_master_backfills where workspace_id = ${id}::uuid)
    )::text;
  `)
  const counts = parseJsonOutput(output, 'Fixture residue check')
  const remaining = Object.entries(counts).filter(([, count]) => count !== 0)
  ensure(remaining.length === 0, `Fixture residue remains in: ${remaining.map(([name]) => name).join(', ')}.`)
}

const runIntegration = async databaseUrl => {
  const workspaceId = randomUUID()
  const eventId = `event-${randomUUID()}`
  const state = createFixtureState(eventId)
  const snapshotResult = createCloudEventSnapshot(state, eventId)
  ensure(snapshotResult.ok, 'Could not create the valid Snapshot V1 fixture.')
  const snapshot = snapshotResult.snapshot
  const snapshotFingerprint = await createPostgresJsonbSha256Fingerprint(snapshot)
  ensure(snapshotFingerprint, 'Could not fingerprint the Snapshot V1 fixture.')

  await assertDatabaseContract(databaseUrl)
  await assertNoFixtureRows(databaseUrl, workspaceId)

  const session = new InteractivePsql(databaseUrl)
  let failure
  let successSummary
  try {
    const initialOutput = await session.command(`
      begin;
      set local client_encoding = 'UTF8';
      insert into public.workspaces (id, name)
      values (${sqlLiteral(workspaceId)}::uuid, 'Backfill inspection integration');
      insert into public.cloud_events (
        workspace_id, event_id, event_name, event_snapshot
      ) values (
        ${sqlLiteral(workspaceId)}::uuid,
        ${sqlLiteral(eventId)},
        ${sqlLiteral(state.events[0].name)},
        ${sqlLiteral(JSON.stringify(snapshot))}::jsonb
      );
      select pg_catalog.jsonb_build_object(
        'generation', g.generation::text,
        'workspaceStatus', s.status,
        'eventRevision', e.revision,
        'snapshotFingerprint', pg_catalog.encode(
          extensions.digest(e.event_snapshot::text, 'sha256'), 'hex'
        )
      )::text
      from public.cloud_event_workspace_generations as g
      join public.cloud_workspace_master_states as s
        on s.workspace_id = g.workspace_id
      join public.cloud_events as e
        on e.workspace_id = g.workspace_id and e.event_id = ${sqlLiteral(eventId)}
      where g.workspace_id = ${sqlLiteral(workspaceId)}::uuid;
    `)
    const initial = parseJsonOutput(initialOutput, 'Initial fixture evidence')
    ensure(initial.workspaceStatus === 'legacy', 'Workspace did not start in legacy status.')
    ensure(initial.eventRevision === 1, 'Cloud Event did not start at revision 1.')
    ensure(
      initial.snapshotFingerprint === snapshotFingerprint,
      'PostgreSQL Snapshot fingerprint differs from the client calculation.',
    )

    const source = {
      status: 'ok',
      workspaceId,
      workspaceStatus: 'legacy',
      workspaceGeneration: initial.generation,
      events: [{
        workspaceId,
        eventId,
        eventName: state.events[0].name,
        snapshot,
        snapshotFingerprint,
        revision: 1,
      }],
      existing: emptyExisting,
    }
    const planned = createCloudWorkspaceMasterBackfillPlan(source)
    ensure(planned.ok, 'Could not create the official Workspace Master backfill plan.')
    const planFingerprint = await createCloudWorkspaceMasterBackfillFingerprint(planned.plan)

    const appliedOutput = await session.command(`
      select public.backfill_workspace_masters_validated(
        ${sqlLiteral(workspaceId)}::uuid,
        ${sqlLiteral(initial.generation)},
        ${sqlLiteral(planFingerprint)},
        ${sqlLiteral(JSON.stringify(planned.plan))}::jsonb,
        true
      )::text;
    `)
    const applied = parseJsonOutput(appliedOutput, 'Backfill apply')
    ensure(applied.status === 'applied', 'Backfill RPC did not apply the plan.')
    ensure(applied.workspaceStatus === 'legacy', 'Backfill changed Workspace status.')
    ensure(applied.sourceGeneration === initial.generation, 'Backfill source generation changed.')

    const inspectionOutput = await session.command(`
      select public.inspect_cloud_v2_cutover_state(
        ${sqlLiteral(workspaceId)}::uuid
      )::text;
    `)
    const inspection = parseJsonOutput(inspectionOutput, 'Cutover inspection RPC')
    const report = await createCloudV2CutoverInspectionReport(inspection, workspaceId)
    ensure(report, 'The asynchronous inspection parser rejected valid RPC evidence.')
    ensure(report.preflight.structuralStatus === 'convertible', 'Snapshot was not convertible.')
    ensure(report.referenceEvidence.status === 'consistent', 'Reference evidence was not consistent.')
    ensure(report.preflight.cutoverReadiness === 'indeterminate', 'Readiness was not indeterminate.')
    ensure(report.preflight.issues.length === 0, 'Inspection returned unexpected issues.')
    ensure(report.preflight.safeToCutover === false, 'Read-only inspection enabled cutover.')
    ensure(inspection.workspaceStatus === 'legacy', 'Inspection did not preserve legacy status.')
    ensure(inspection.events.length === 1, 'Inspection returned an unexpected Event count.')
    ensure(
      inspection.events[0].snapshotFingerprint === snapshotFingerprint,
      'Inspection returned an unexpected Snapshot fingerprint.',
    )

    const completed = inspection.existing.completedBackfill
    ensure(completed, 'Inspection omitted the completed backfill record.')
    ensure(completed.planFingerprint === planFingerprint, 'Plan fingerprint changed.')
    ensure(completed.sourceGeneration === initial.generation, 'Source generation changed.')
    ensure(completed.resultGeneration === inspection.workspaceGeneration, (
      'Completed backfill result generation differs from inspection generation.'
    ))
    ensure(applied.resultGeneration === inspection.workspaceGeneration, (
      'Backfill result generation differs from inspection generation.'
    ))
    for (const [recordField, inspectionField] of countFields) {
      const expected = planned.report[recordField]
      ensure(applied[recordField] === expected, `Backfill ${recordField} is inconsistent.`)
      ensure(completed[recordField] === expected, `Completed ${recordField} is inconsistent.`)
      ensure(inspection.counts[inspectionField] === expected, (
        `Inspection ${inspectionField} count is inconsistent.`
      ))
    }

    successSummary = {
      ok: true,
      workspaceId,
      eventId,
      sourceGeneration: initial.generation,
      resultGeneration: inspection.workspaceGeneration,
      counts: inspection.counts,
      structuralStatus: report.preflight.structuralStatus,
      referenceStatus: report.referenceEvidence.status,
      cutoverReadiness: report.preflight.cutoverReadiness,
      safeToCutover: report.preflight.safeToCutover,
    }
  } catch (error) {
    failure = error
  } finally {
    if (!session.exited) {
      try {
        await session.command('rollback;')
        await session.close()
      } catch (error) {
        failure ??= error
        await session.kill()
      }
    }
    try {
      await assertNoFixtureRows(databaseUrl, workspaceId)
    } catch (error) {
      failure = error
    }
  }
  if (failure) throw failure
  process.stdout.write(`${JSON.stringify(successSummary, null, 2)}\n`)
}

const main = async () => {
  let activeDatabaseUrl
  try {
    const { dbUrlEnv } = parseArguments(process.argv.slice(2))
    activeDatabaseUrl = process.env[dbUrlEnv]?.trim()
    ensure(activeDatabaseUrl, 'The database URL environment variable is required.')
    validateDatabaseUrl(activeDatabaseUrl)
    await runIntegration(activeDatabaseUrl)
  } catch (error) {
    const message = error instanceof Error
      ? sanitizePsqlDiagnostic(error.message, activeDatabaseUrl ?? '')
      : 'Cloud V2 backfill inspection integration failed.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
