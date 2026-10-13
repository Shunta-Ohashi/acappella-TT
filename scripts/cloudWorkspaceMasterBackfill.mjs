import { createClient } from '@supabase/supabase-js'

import {
  createCloudWorkspaceMasterBackfillFingerprint,
  createCloudWorkspaceMasterBackfillPlan,
  parseCloudWorkspaceMasterBackfillSource,
} from '../src/cloud/cloudWorkspaceMasterBackfill.ts'

const getArgument = name => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const workspaceId = getArgument('--workspace-id')?.trim()
const apply = process.argv.includes('--apply')
const confirmedWorkspaceId = getArgument('--confirm-workspace-id')?.trim()
const confirmedTarget = getArgument('--confirm-target')?.trim()
const supabaseUrl = process.env.ACAPPELLA_TT_BACKFILL_SUPABASE_URL?.trim()
const serviceRoleKey = process.env.ACAPPELLA_TT_BACKFILL_SERVICE_ROLE_KEY?.trim()

if (!workspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(workspaceId)) {
  throw new Error('--workspace-id must be an explicit UUID.')
}
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    'ACAPPELLA_TT_BACKFILL_SUPABASE_URL and ' +
    'ACAPPELLA_TT_BACKFILL_SERVICE_ROLE_KEY are required.',
  )
}

const parsedUrl = new URL(supabaseUrl)
const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1']
  .includes(parsedUrl.hostname.toLowerCase())
if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('Backfill target must use HTTPS, except for an explicit loopback environment.')
}

const target = parsedUrl.origin
if (apply && (
  confirmedWorkspaceId !== workspaceId ||
  confirmedTarget !== target
)) {
  throw new Error(
    `Write mode requires --confirm-workspace-id ${workspaceId} ` +
    `and --confirm-target ${target}.`,
  )
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const rpc = async (name, args) => {
  const result = await client.rpc(name, args)
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : ''
    throw new Error(`${name} failed${code}: ${result.error.message}`)
  }
  return result.data
}

const rawSource = await rpc('inspect_workspace_master_backfill_source', {
  p_workspace_id: workspaceId,
})
const source = parseCloudWorkspaceMasterBackfillSource(rawSource)
if (!source) throw new Error('Backfill source RPC returned an invalid response.')

const planned = createCloudWorkspaceMasterBackfillPlan(rawSource)
const report = planned.report
const publicReport = {
  target,
  mode: apply ? 'apply' : 'dry-run',
  workspaceId: report.workspaceId,
  sourceGeneration: source.workspaceGeneration,
  workspaceStatus: source.workspaceStatus,
  eventCount: report.eventCount,
  memberCount: report.memberCount,
  bandCount: report.bandCount,
  bandMemberRelationCount: report.bandMemberRelationCount,
  eventMemberReferenceCount: report.eventMemberReferenceCount,
  eventBandReferenceCount: report.eventBandReferenceCount,
  conflictCount: report.conflictCount,
  conflicts: report.conflicts,
  issues: report.issues,
  canRecoverUnreferencedMasters: report.canRecoverUnreferencedMasters,
}

if (!planned.ok) {
  process.stdout.write(`${JSON.stringify({ ...publicReport, eligible: false }, null, 2)}\n`)
  throw new Error('Workspace Master backfill preflight rejected this Workspace.')
}

const fingerprint = await createCloudWorkspaceMasterBackfillFingerprint(planned.plan)
const callBackfill = applyValue => rpc('backfill_workspace_masters_validated', {
  p_workspace_id: workspaceId,
  p_expected_generation: planned.plan.sourceGeneration,
  p_plan_fingerprint: fingerprint,
  p_plan: planned.plan,
  p_apply: applyValue,
})

const preview = await callBackfill(false)
process.stdout.write(`${JSON.stringify({
  ...publicReport,
  eligible: true,
  planFingerprint: fingerprint,
  databasePreview: preview,
}, null, 2)}\n`)

if (!apply) {
  process.stdout.write(
    'Dry-run only. No normalized Master row, reference row, status, or Event was changed.\n',
  )
} else {
  const result = await callBackfill(true)
  process.stdout.write(`${JSON.stringify({ backfillResult: result }, null, 2)}\n`)
}
