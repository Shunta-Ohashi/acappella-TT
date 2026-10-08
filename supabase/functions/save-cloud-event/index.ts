import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { handleCloudEventSaveRequest } from '../../../src/cloud/cloudEventSaveEndpoint.ts'

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

runtime.serve(request => handleCloudEventSaveRequest(request, {
  async authenticate(accessToken) {
    if (!authClient) return configurationError()
    const { data, error } = await authClient.auth.getUser(accessToken)
    if (error || !data.user) return undefined
    return { id: data.user.id }
  },

  async saveValidatedSnapshot({ actorId, workspaceId, snapshot }) {
    if (!backendClient) return configurationError()
    const result = await backendClient.rpc('save_cloud_event_validated', {
      p_actor_id: actorId,
      p_workspace_id: workspaceId,
      p_event_snapshot: snapshot,
    })
    return { data: result.data, error: result.error }
  },
}))
