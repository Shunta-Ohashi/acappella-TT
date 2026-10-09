import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const regressionSqlPath = fileURLToPath(new URL(
  '../supabase/tests/cloud_event_migration_history_catalog_regression.sql',
  import.meta.url,
))

const scenarios = [
  ['cloud_anon_table_insert', result => result.laterSchema.anonTableWrite],
  ['cloud_anon_column_insert', result => result.laterSchema.anonColumnWrite],
  ['cloud_anon_column_update', result => result.laterSchema.anonColumnWrite],
  ['cloud_public_table_update', result => result.laterSchema.publicTableWrite],
  ['cloud_public_column_insert', result => result.laterSchema.publicColumnWrite],
  ['cloud_public_column_update', result => result.laterSchema.publicColumnWrite],
  ['cloud_anon_inherited_delete', result => result.laterSchema.anonTableWrite],
  ['cloud_authenticated_inherited_delete', result => result.laterSchema.authenticatedDelete],
  ['cloud_anon_inherited_table_insert', result => result.laterSchema.anonTableWrite],
  ['cloud_anon_inherited_table_update', result => result.laterSchema.anonTableWrite],
  ['cloud_authenticated_inherited_table_insert', result => result.laterSchema.authenticatedInsert],
  ['cloud_authenticated_inherited_table_update', result => result.laterSchema.authenticatedUpdate],
  ['cloud_anon_inherited_column_write', result => result.laterSchema.anonColumnWrite],
  ['cloud_authenticated_inherited_column_write', result => result.laterSchema.authenticatedColumnUpdate],
  ['cloud_anon_column_grant_option', result => result.laterSchema.anonColumnWrite],
  ['delete_function_security_invoker', result => !result.laterSchema.authorizedDeleteSecurityDefiner],
  ['delete_authenticated_execute_missing', result => !result.laterSchema.authenticatedDeleteExecute],
  ['delete_public_execute', result => result.laterSchema.publicDeleteExecute],
  ['delete_anon_execute', result => result.laterSchema.anonDeleteExecute],
  ['delete_service_role_execute', result => result.laterSchema.serviceRoleDeleteExecute],
  ['delete_anon_inherited_execute', result => result.laterSchema.anonDeleteExecute],
  ['page_function_security_invoker', result => !result.laterSchema.authorizedPageSecurityDefiner],
  ['page_authenticated_execute_missing', result => !result.laterSchema.authenticatedPageExecute],
  ['page_public_execute', result => result.laterSchema.publicPageExecute],
  ['page_anon_execute', result => result.laterSchema.anonPageExecute],
  ['page_service_role_execute', result => result.laterSchema.serviceRolePageExecute],
  ['page_anon_inherited_execute', result => result.laterSchema.anonPageExecute],
  ['save_function_security_invoker', result => !result.laterSchema.authorizedSaveSecurityDefiner],
  ['save_public_execute', result => result.laterSchema.publicSaveExecute],
  ['save_anon_execute', result => result.laterSchema.anonSaveExecute],
  ['save_authenticated_execute', result => result.laterSchema.authenticatedSaveExecute],
  ['save_anon_inherited_execute', result => result.laterSchema.anonSaveExecute],
  ['save_authenticated_inherited_execute', result =>
    result.laterSchema.authenticatedSaveExecute],
  ['save_service_role_execute_missing', result => !result.laterSchema.serviceRoleSaveExecute],
  ['save_service_role_missing', result => !result.laterSchema.saveFunctionPermissionCatalogReady],
  ['required_role_missing', result => !result.laterSchema.permissionCatalogReady],
  ['profiles_missing', result => !result.authWorkspaceChecks.profilesColumns],
  ['profiles_column_missing', result => !result.authWorkspaceChecks.profilesColumns],
  ['profiles_column_type', result => !result.authWorkspaceChecks.profilesColumns],
  ['membership_primary_key_missing', result => !result.authWorkspaceChecks.workspaceMembersPrimaryKey],
  ['membership_role_check_missing', result => !result.authWorkspaceChecks.workspaceMemberRoleCheck],
  ['membership_role_check_broad', result => !result.authWorkspaceChecks.workspaceMemberRoleCheck],
  ['membership_foreign_key_missing', result => !result.authWorkspaceChecks.workspaceMemberWorkspaceForeignKey],
  ['membership_foreign_key_wrong_target', result => !result.authWorkspaceChecks.workspaceMemberWorkspaceForeignKey],
  ['workspace_rls_disabled', result => !result.authWorkspaceChecks.rowLevelSecurity],
  ['workspace_policy_missing', result => !result.authWorkspaceChecks.policies],
  ['workspace_policy_broad', result => !result.authWorkspaceChecks.policies],
  ['workspace_policy_extra', result => !result.authWorkspaceChecks.policies],
  ['updated_at_function_invalid', result => !result.authWorkspaceChecks.updatedAtFunction],
  ['updated_at_trigger_missing', result => !result.authWorkspaceChecks.updatedAtTriggers],
  ['auth_workspace_anon_column_write', result => !result.authWorkspaceChecks.columnPrivileges],
]

const parseArguments = (args) => {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--db-url-env') parsed.dbUrlEnv = args[++index]
    else if (argument === '--confirm-disposable') parsed.confirmDisposable = true
    else throw new Error(`Unknown or incomplete argument: ${argument}`)
  }
  return parsed
}

const inspectScenario = async (databaseUrl, scenario) => {
  const result = await execFileAsync('psql', [
    '--no-psqlrc',
    '--quiet',
    '--no-align',
    '--tuples-only',
    '--set',
    'ON_ERROR_STOP=1',
    '--set',
    `catalog_scenario=${scenario}`,
    '--dbname',
    databaseUrl,
    '--file',
    regressionSqlPath,
  ], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  const jsonLine = result.stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.startsWith('{'))
  if (!jsonLine) throw new Error(`${scenario}: preflight JSON was not returned`)
  return JSON.parse(jsonLine)
}

const main = async () => {
  let args
  try {
    args = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments')
    process.exitCode = 2
    return
  }
  const databaseUrl = args.dbUrlEnv ? process.env[args.dbUrlEnv] : undefined
  if (!args.confirmDisposable || !databaseUrl) {
    console.error('A disposable --db-url-env and --confirm-disposable are required.')
    process.exitCode = 2
    return
  }

  try {
    const baseline = await inspectScenario(databaseUrl, 'baseline')
    if (
      !baseline.authWorkspaceReady ||
      !baseline.laterSchema.permissionCatalogReady ||
      !baseline.laterSchema.authorizedDeleteSecurityDefiner ||
      !baseline.laterSchema.deleteFunctionPermissionCatalogReady ||
      !baseline.laterSchema.authenticatedDeleteExecute ||
      baseline.laterSchema.publicDeleteExecute ||
      baseline.laterSchema.anonDeleteExecute ||
      baseline.laterSchema.serviceRoleDeleteExecute ||
      !baseline.laterSchema.authorizedPageSecurityDefiner ||
      !baseline.laterSchema.pageFunctionPermissionCatalogReady ||
      !baseline.laterSchema.authenticatedPageExecute ||
      baseline.laterSchema.publicPageExecute ||
      baseline.laterSchema.anonPageExecute ||
      baseline.laterSchema.serviceRolePageExecute ||
      !baseline.laterSchema.authorizedSaveSecurityDefiner ||
      !baseline.laterSchema.saveFunctionPermissionCatalogReady ||
      !baseline.laterSchema.serviceRoleSaveExecute ||
      baseline.laterSchema.publicSaveExecute ||
      baseline.laterSchema.anonSaveExecute ||
      baseline.laterSchema.authenticatedSaveExecute ||
      baseline.laterSchema.anonTableWrite ||
      baseline.laterSchema.anonColumnWrite ||
      baseline.laterSchema.publicTableWrite ||
      baseline.laterSchema.publicColumnWrite
    ) {
      throw new Error('baseline: expected known safe catalog')
    }

    for (const [scenario, detected] of scenarios) {
      const inspection = await inspectScenario(databaseUrl, scenario)
      if (!detected(inspection)) {
        throw new Error(`${scenario}: unsafe catalog mutation was not detected`)
      }
    }
    console.log(JSON.stringify({ ok: true, scenarios: scenarios.length + 1 }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Catalog regression failed')
    process.exitCode = 1
  }
}

await main()
