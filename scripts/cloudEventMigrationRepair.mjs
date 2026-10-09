import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const OLD_CLOUD_EVENT_MIGRATION_VERSION = '20261007120000'
export const NEW_CLOUD_EVENT_MIGRATION_VERSION = '20261008110000'

const AUTH_WORKSPACE_MIGRATION_VERSION = '20261007'
const LATER_MIGRATIONS = {
  authorizedDelete: '20261008120000',
  rpcOnlyDelete: '20261008130000',
  authorizedPage: '20261008140000',
  authorizedSave: '20261008150000',
  rpcOnlySave: '20261008160000',
}

export const REQUIRED_BASE_SCHEMA_CHECKS = [
  'columns',
  'primaryKey',
  'workspaceForeignKey',
  'eventIdCheck',
  'eventNameCheck',
  'revisionCheck',
  'strictSnapshotCheck',
  'updatedAtIndex',
  'initializeFunction',
  'protectFunction',
  'initializeTrigger',
  'protectTrigger',
  'rowLevelSecurity',
  'policies',
]

export const REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS = [
  'authUsersReference',
  'profilesColumns',
  'workspacesColumns',
  'workspaceMembersColumns',
  'profilesPrimaryKey',
  'workspacesPrimaryKey',
  'workspaceMembersPrimaryKey',
  'profilesUserForeignKey',
  'workspaceMemberUserForeignKey',
  'workspaceMemberWorkspaceForeignKey',
  'profileNameCheck',
  'workspaceNameCheck',
  'workspaceMemberRoleCheck',
  'updatedAtFunction',
  'updatedAtTriggers',
  'workspaceMemberUserIndex',
  'rowLevelSecurity',
  'policies',
  'tablePrivileges',
  'columnPrivileges',
]

export const REQUIRED_LATER_SCHEMA_CHECKS = [
  'authorizedDeleteFunction',
  'authorizedPageIndex',
  'authorizedPageFunction',
  'authorizedSaveFunction',
  'authenticatedSelect',
  'authenticatedInsert',
  'authenticatedUpdate',
  'authenticatedDelete',
  'authenticatedColumnInsert',
  'authenticatedColumnUpdate',
  'permissionCatalogReady',
  'anonTableWrite',
  'anonColumnWrite',
  'publicTableWrite',
  'publicColumnWrite',
]

const isRecord = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasBooleanProperties = (value, keys) =>
  isRecord(value) && keys.every(key => typeof value[key] === 'boolean')

const isInspection = value =>
  isRecord(value) &&
  isRecord(value.target) &&
  typeof value.target.database === 'string' &&
  typeof value.target.currentUser === 'string' &&
  typeof value.historyTableExists === 'boolean' &&
  Array.isArray(value.appliedVersions) &&
  value.appliedVersions.every(version => typeof version === 'string') &&
  typeof value.authWorkspaceReady === 'boolean' &&
  hasBooleanProperties(
    value.authWorkspaceChecks,
    REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS,
  ) &&
  value.authWorkspaceReady === REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS.every(
    check => value.authWorkspaceChecks[check],
  ) &&
  typeof value.cloudEventsExists === 'boolean' &&
  hasBooleanProperties(value.baseSchemaChecks, REQUIRED_BASE_SCHEMA_CHECKS) &&
  hasBooleanProperties(value.laterSchema, REQUIRED_LATER_SCHEMA_CHECKS) &&
  isRecord(value.cloudData) &&
  Number.isSafeInteger(value.cloudData.rowCount) &&
  value.cloudData.rowCount >= 0 &&
  typeof value.cloudData.digest === 'string'

const compareExpected = (mismatches, actual, expected, label) => {
  if (actual !== expected) {
    mismatches.push(`${label}: expected ${expected}, received ${actual}`)
  }
}

export const analyzeCloudEventMigrationInspection = inspection => {
  if (!isInspection(inspection)) {
    return {
      kind: 'unknown',
      repairCommands: [],
      mismatches: ['inspection output does not match the expected schema'],
    }
  }

  const applied = new Set(inspection.appliedVersions)
  const oldApplied = applied.has(OLD_CLOUD_EVENT_MIGRATION_VERSION)
  const newApplied = applied.has(NEW_CLOUD_EVENT_MIGRATION_VERSION)
  const laterApplied = Object.fromEntries(Object.entries(LATER_MIGRATIONS).map(
    ([name, version]) => [name, applied.has(version)],
  ))
  const mismatches = []

  if (!inspection.historyTableExists && inspection.appliedVersions.length > 0) {
    mismatches.push('migration history rows were reported without a history table')
  }

  if (!inspection.cloudEventsExists) {
    if (oldApplied || newApplied || Object.values(laterApplied).some(Boolean)) {
      mismatches.push('Cloud Event migration history exists but public.cloud_events is absent')
    }
    if (
      Object.values(inspection.baseSchemaChecks).some(Boolean) ||
      Object.values(inspection.laterSchema).some(Boolean)
    ) {
      mismatches.push('Cloud Event catalog objects exist without public.cloud_events')
    }
  } else {
    for (const check of REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS) {
      if (!inspection.authWorkspaceChecks[check]) {
        mismatches.push(`Auth / Workspace schema check failed: ${check}`)
      }
    }
    for (const check of REQUIRED_BASE_SCHEMA_CHECKS) {
      if (!inspection.baseSchemaChecks[check]) {
        mismatches.push(`base schema check failed: ${check}`)
      }
    }
    compareExpected(
      mismatches,
      inspection.laterSchema.authorizedDeleteFunction,
      laterApplied.authorizedDelete,
      'authorized delete function/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authorizedPageIndex,
      laterApplied.authorizedPage,
      'authorized page index/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authorizedPageFunction,
      laterApplied.authorizedPage,
      'authorized page function/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authorizedSaveFunction,
      laterApplied.authorizedSave,
      'authorized save function/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authenticatedSelect,
      true,
      'authenticated SELECT privilege',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authenticatedDelete,
      !laterApplied.rpcOnlyDelete,
      'authenticated DELETE privilege/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authenticatedInsert,
      !laterApplied.rpcOnlySave,
      'authenticated INSERT privilege/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authenticatedUpdate,
      !laterApplied.rpcOnlySave,
      'authenticated UPDATE privilege/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authenticatedColumnInsert,
      !laterApplied.rpcOnlySave,
      'authenticated column INSERT privilege/history',
    )
    compareExpected(
      mismatches,
      inspection.laterSchema.authenticatedColumnUpdate,
      !laterApplied.rpcOnlySave,
      'authenticated column UPDATE privilege/history',
    )
    compareExpected(mismatches, inspection.laterSchema.permissionCatalogReady,
      true, 'Cloud Event permission catalog readiness')
    for (const check of [
      'anonTableWrite',
      'anonColumnWrite',
      'publicTableWrite',
      'publicColumnWrite',
    ]) {
      compareExpected(
        mismatches,
        inspection.laterSchema[check],
        false,
        `${check} privilege`,
      )
    }
    if (!oldApplied && !newApplied) {
      mismatches.push('public.cloud_events exists without the old or new base history entry')
    }
    if (!applied.has(AUTH_WORKSPACE_MIGRATION_VERSION)) {
      mismatches.push('Auth / Workspace schema exists without its migration history entry')
    }
  }

  if (mismatches.length > 0) {
    return { kind: 'unknown', repairCommands: [], mismatches }
  }
  if (!inspection.cloudEventsExists && !oldApplied && !newApplied) {
    return { kind: 'fresh', repairCommands: [], mismatches: [] }
  }
  if (oldApplied && !newApplied) {
    return {
      kind: 'old-only',
      repairCommands: [
        { version: NEW_CLOUD_EVENT_MIGRATION_VERSION, status: 'applied' },
        { version: OLD_CLOUD_EVENT_MIGRATION_VERSION, status: 'reverted' },
      ],
      mismatches: [],
    }
  }
  if (!oldApplied && newApplied) {
    return { kind: 'new-only', repairCommands: [], mismatches: [] }
  }
  return {
    kind: 'both',
    repairCommands: [
      { version: OLD_CLOUD_EVENT_MIGRATION_VERSION, status: 'reverted' },
    ],
    mismatches: [],
  }
}

const getNonSecretDatabaseTarget = databaseUrl => {
  try {
    const parsed = new URL(databaseUrl)
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return undefined
  }
}

const createTargetFingerprint = (databaseTarget, inspectedTarget) => createHash('sha256')
  .update(`${databaseTarget}\n${inspectedTarget.database}\n${inspectedTarget.currentUser}`)
  .digest('hex')
  .slice(0, 16)

const sameNonHistoryState = (before, after) =>
  JSON.stringify(before.target) === JSON.stringify(after.target) &&
  before.authWorkspaceReady === after.authWorkspaceReady &&
  JSON.stringify(before.authWorkspaceChecks) ===
    JSON.stringify(after.authWorkspaceChecks) &&
  before.cloudEventsExists === after.cloudEventsExists &&
  JSON.stringify(before.baseSchemaChecks) === JSON.stringify(after.baseSchemaChecks) &&
  JSON.stringify(before.laterSchema) === JSON.stringify(after.laterSchema) &&
  JSON.stringify(before.cloudData) === JSON.stringify(after.cloudData)

export const runCloudEventMigrationRepair = async ({
  databaseUrl,
  apply = false,
  resume = false,
  confirmTarget,
  inspectTarget,
  repairMigration,
}) => {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    return { ok: false, code: 'TARGET_REQUIRED' }
  }
  const databaseTarget = getNonSecretDatabaseTarget(databaseUrl)
  if (!databaseTarget) return { ok: false, code: 'INVALID_TARGET' }
  let before
  try {
    before = await inspectTarget(databaseUrl)
  } catch {
    return { ok: false, code: 'INSPECTION_FAILED' }
  }
  if (!isInspection(before)) return { ok: false, code: 'INVALID_INSPECTION' }
  const targetFingerprint = createTargetFingerprint(databaseTarget, before.target)
  const analysis = analyzeCloudEventMigrationInspection(before)
  const plan = {
    targetFingerprint,
    target: before.target,
    state: analysis.kind,
    repairCommands: analysis.repairCommands,
    mismatches: analysis.mismatches,
  }
  if (analysis.kind === 'unknown') {
    return { ok: false, code: 'UNKNOWN_STATE', plan }
  }
  if (!apply || analysis.repairCommands.length === 0) {
    return { ok: true, applied: false, plan }
  }
  if (confirmTarget !== targetFingerprint) {
    return { ok: false, code: 'TARGET_CONFIRMATION_REQUIRED', plan }
  }
  if (analysis.kind === 'both' && !resume) {
    return { ok: false, code: 'EXPLICIT_RESUME_REQUIRED', plan }
  }

  let currentInspection = before
  for (let index = 0; index < analysis.repairCommands.length; index += 1) {
    const command = analysis.repairCommands[index]
    let repaired
    try {
      repaired = await repairMigration(databaseUrl, command)
    } catch {
      repaired = { ok: false }
    }
    if (!repaired.ok) {
      return {
        ok: false,
        code: 'REPAIR_FAILED',
        failedCommand: command,
        completedCommands: analysis.repairCommands.slice(0, index),
        plan,
      }
    }

    let nextInspection
    try {
      nextInspection = await inspectTarget(databaseUrl)
    } catch {
      return {
        ok: false,
        code: 'POST_REPAIR_INSPECTION_FAILED',
        completedCommands: analysis.repairCommands.slice(0, index + 1),
        plan,
      }
    }
    if (!isInspection(nextInspection)) {
      return {
        ok: false,
        code: 'POST_REPAIR_INSPECTION_FAILED',
        completedCommands: analysis.repairCommands.slice(0, index + 1),
        plan,
      }
    }
    if (!sameNonHistoryState(before, nextInspection)) {
      return {
        ok: false,
        code: 'NON_HISTORY_STATE_CHANGED',
        completedCommands: analysis.repairCommands.slice(0, index + 1),
        plan,
      }
    }
    const nextAnalysis = analyzeCloudEventMigrationInspection(nextInspection)
    const expectedKind = index === analysis.repairCommands.length - 1
      ? 'new-only'
      : 'both'
    if (nextAnalysis.kind !== expectedKind) {
      return {
        ok: false,
        code: 'UNEXPECTED_POST_REPAIR_STATE',
        completedCommands: analysis.repairCommands.slice(0, index + 1),
        plan,
      }
    }
    currentInspection = nextInspection
  }

  return {
    ok: true,
    applied: true,
    completedCommands: analysis.repairCommands,
    plan,
    finalState: analyzeCloudEventMigrationInspection(currentInspection).kind,
  }
}

const execFileAsync = promisify(execFile)

const runExternalCommand = async (command, args) => {
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    }
  }
}

const preflightSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_event_migration_history_preflight.sql',
  import.meta.url,
))

const inspectWithOfficialTools = async databaseUrl => {
  const listed = await runExternalCommand('supabase', [
    'migration', 'list', '--db-url', databaseUrl,
  ])
  if (!listed.ok) throw new Error('Supabase migration list failed')
  const inspected = await runExternalCommand('psql', [
    '--no-psqlrc', '--quiet', '--no-align', '--tuples-only',
    '--set', 'ON_ERROR_STOP=1', '--dbname', databaseUrl, '--file', preflightSqlPath,
  ])
  if (!inspected.ok) throw new Error('Read-only catalog inspection failed')
  return JSON.parse(inspected.stdout.trim())
}

const repairWithOfficialCli = async (databaseUrl, command) => {
  const result = await runExternalCommand('supabase', [
    'migration', 'repair', command.version,
    '--status', command.status,
    '--db-url', databaseUrl,
  ])
  return { ok: result.ok }
}

const parseArguments = args => {
  const parsed = { apply: false, resume: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--apply') parsed.apply = true
    else if (argument === '--resume') parsed.resume = true
    else if (argument === '--db-url-env') parsed.dbUrlEnv = args[++index]
    else if (argument === '--confirm-target') parsed.confirmTarget = args[++index]
    else throw new Error(`Unknown or incomplete argument: ${argument}`)
  }
  return parsed
}

const main = async () => {
  let argumentsValue
  try {
    argumentsValue = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments')
    process.exitCode = 2
    return
  }
  const databaseUrl = argumentsValue.dbUrlEnv
    ? process.env[argumentsValue.dbUrlEnv]
    : undefined
  const result = await runCloudEventMigrationRepair({
    databaseUrl,
    apply: argumentsValue.apply,
    resume: argumentsValue.resume,
    confirmTarget: argumentsValue.confirmTarget,
    inspectTarget: inspectWithOfficialTools,
    repairMigration: repairWithOfficialCli,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
