import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { handleCloudWorkspaceMasterRequest } from '../../../src/cloud/cloudWorkspaceMasterEndpoint.ts'
import type { CloudWorkspaceMasterMutation } from '../../../src/cloud/cloudWorkspaceMasterRepository.ts'

interface EdgeRuntime {
  env: { get: (name: string) => string | undefined }
  serve: (handler: (request: Request) => Response | Promise<Response>) => void
}

const runtime = (globalThis as unknown as { Deno: EdgeRuntime }).Deno
const supabaseUrl = runtime.env.get('SUPABASE_URL')
const supabaseAnonKey = runtime.env.get('SUPABASE_ANON_KEY')
const supabaseServiceRoleKey = runtime.env.get('SUPABASE_SERVICE_ROLE_KEY')

const configurationError = (): never => {
  const error = new Error('Missing server-only Supabase configuration.') as Error & {
    code: string
  }
  error.code = 'CONFIGURATION_ERROR'
  throw error
}

const authClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : undefined
const backendClient = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : undefined

const toRpcArguments = (mutation: CloudWorkspaceMasterMutation): {
  operation: 'create' | 'update' | 'delete'
  kind: 'member' | 'band'
  payload: unknown
  expectedRevision: number | null
} => {
  switch (mutation.operation) {
    case 'create-member':
      return {
        operation: 'create', kind: 'member', payload: mutation.member,
        expectedRevision: null,
      }
    case 'update-member':
      return {
        operation: 'update', kind: 'member', payload: mutation.member,
        expectedRevision: mutation.expectedRevision,
      }
    case 'delete-member':
      return {
        operation: 'delete', kind: 'member', payload: { id: mutation.memberId },
        expectedRevision: mutation.expectedRevision,
      }
    case 'create-band':
      return {
        operation: 'create', kind: 'band', payload: mutation.band,
        expectedRevision: null,
      }
    case 'update-band':
      return {
        operation: 'update', kind: 'band', payload: mutation.band,
        expectedRevision: mutation.expectedRevision,
      }
    case 'delete-band':
      return {
        operation: 'delete', kind: 'band', payload: { id: mutation.bandId },
        expectedRevision: mutation.expectedRevision,
      }
  }
}

runtime.serve(request => handleCloudWorkspaceMasterRequest(request, {
  async authenticate(accessToken) {
    if (!authClient) return configurationError()
    const { data, error } = await authClient.auth.getUser(accessToken)
    if (error || !data.user) return undefined
    return { id: data.user.id }
  },

  async mutateValidatedMaster({ actorId, workspaceId, mutation }) {
    if (!backendClient) return configurationError()
    const args = toRpcArguments(mutation)
    const result = await backendClient.rpc('mutate_workspace_master_validated', {
      p_actor_id: actorId,
      p_workspace_id: workspaceId,
      p_operation: args.operation,
      p_master_kind: args.kind,
      p_payload: args.payload,
      p_expected_revision: args.expectedRevision,
    })
    return { data: result.data, error: result.error }
  },
}))
