import { createClient } from '@supabase/supabase-js'

import {
  createCloudV2CutoverInspectionReport,
} from '../src/cloud/cloudV2CutoverInspection.ts'

const allowedArguments = new Set([
  '--workspace-id', '--confirm-target', '--confirm-workspace-id',
])
const rawArguments = process.argv.slice(2)
const argumentsToParse = rawArguments[0] === '--'
  ? rawArguments.slice(1)
  : rawArguments
const parsedArguments = new Map()
for (let index = 0; index < argumentsToParse.length; index += 1) {
  const argument = argumentsToParse[index]
  if (!allowedArguments.has(argument)) {
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (parsedArguments.has(argument)) {
    throw new Error(`Duplicate argument: ${argument}`)
  }
  if (
    index + 1 >= argumentsToParse.length ||
    argumentsToParse[index + 1].startsWith('--') ||
    argumentsToParse[index + 1].trim() === ''
  ) {
    throw new Error(`${argument} requires a value.`)
  }
  parsedArguments.set(argument, argumentsToParse[index + 1])
  index += 1
}

const getArgument = name => parsedArguments.get(name)

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const normalizeUuidArgument = (name, required = false) => {
  const value = getArgument(name)?.trim()
  if (!value) {
    if (required) throw new Error(`${name} must be an explicit UUID.`)
    return undefined
  }
  if (!uuidPattern.test(value)) {
    throw new Error(`${name} must be an explicit UUID.`)
  }
  return value.toLowerCase()
}

const workspaceId = normalizeUuidArgument('--workspace-id', true)
const confirmedWorkspaceId = normalizeUuidArgument('--confirm-workspace-id')
const confirmedTarget = getArgument('--confirm-target')?.trim()
const supabaseUrl = process.env.ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL?.trim()
const serviceRoleKey =
  process.env.ACAPPELLA_TT_CUTOVER_INSPECTION_SERVICE_ROLE_KEY?.trim()

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    'ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL and ' +
    'ACAPPELLA_TT_CUTOVER_INSPECTION_SERVICE_ROLE_KEY are required.',
  )
}

let parsedUrl
try {
  parsedUrl = new URL(supabaseUrl)
} catch {
  throw new Error(
    'ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL must be a valid URL.',
  )
}
if (parsedUrl.username || parsedUrl.password) {
  throw new Error('Inspection target URL must not contain user information.')
}
const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1']
  .includes(parsedUrl.hostname.toLowerCase())
if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('Inspection target must use HTTPS, except for loopback HTTP.')
}

const target = parsedUrl.origin
if (!isLoopback && (
  confirmedWorkspaceId !== workspaceId || confirmedTarget !== target
)) {
  throw new Error(
    `Remote inspection requires --confirm-workspace-id ${workspaceId} ` +
    `and --confirm-target ${target}.`,
  )
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const result = await client.rpc('inspect_cloud_v2_cutover_state', {
  p_workspace_id: workspaceId,
})
if (result.error) {
  const code = result.error.code ? ` (${result.error.code})` : ''
  throw new Error(`Cutover inspection RPC failed${code}.`)
}

const report = await createCloudV2CutoverInspectionReport(result.data, workspaceId)
if (!report) throw new Error('Cutover inspection RPC returned an invalid response.')

const output = {
  target,
  mode: 'read-only',
  workspaceId: report.preflight.workspaceId,
  workspaceStatus: report.preflight.workspaceStatus,
  generation: report.preflight.generation,
  summary: report.preflight.summary,
  structuralStatus: report.preflight.structuralStatus,
  cutoverReadiness: report.preflight.cutoverReadiness,
  safeToCutover: report.preflight.safeToCutover,
  referenceEvidence: report.referenceEvidence,
  issues: report.preflight.issues,
  invalidEventIds: report.preflight.invalidEventIds,
  unverifiedRequirements: report.preflight.unverifiedRequirements,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(
  'Read-only evidence only. This runner cannot backfill, change status, or perform cutover.\n',
)

if (
  report.preflight.structuralStatus !== 'convertible' ||
  report.referenceEvidence.status !== 'consistent' ||
  report.preflight.cutoverReadiness === 'blocked' ||
  report.preflight.issues.length > 0
) {
  process.exitCode = 2
}
