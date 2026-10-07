import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { CloudConfig } from './cloudConfig.ts'

export type EnabledCloudConfig = Extract<CloudConfig, { status: 'enabled' }>

let cachedClient: {
  config: EnabledCloudConfig
  client: SupabaseClient
} | undefined

export const createSupabaseBrowserClient = (
  config: EnabledCloudConfig,
): SupabaseClient => {
  // React StrictMode can invoke initializers twice. Reuse the client so its
  // auth subscriptions, refresh timers and browser storage have one owner.
  if (cachedClient?.config.supabaseUrl === config.supabaseUrl &&
    cachedClient.config.supabasePublishableKey === config.supabasePublishableKey) {
    return cachedClient.client
  }
  const client = createClient(config.supabaseUrl, config.supabasePublishableKey)
  cachedClient = { config: { ...config }, client }
  return client
}
