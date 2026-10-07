export type CloudConfig =
  | { status: 'disabled' }
  | { status: 'invalid'; message: string }
  | {
      status: 'enabled'
      supabaseUrl: string
      supabasePublishableKey: string
    }

export interface CloudConfigInput {
  supabaseUrl?: unknown
  supabasePublishableKey?: unknown
}

const normalizeEnvValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const LOOPBACK_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

const isAllowedCloudUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HTTP_HOSTNAMES.has(url.hostname))
  } catch {
    return false
  }
}

export const resolveCloudConfig = ({
  supabaseUrl,
  supabasePublishableKey,
}: CloudConfigInput): CloudConfig => {
  const normalizedUrl = normalizeEnvValue(supabaseUrl)
  const normalizedKey = normalizeEnvValue(supabasePublishableKey)

  if (!normalizedUrl && !normalizedKey) return { status: 'disabled' }
  if (!normalizedUrl || !normalizedKey) {
    return {
      status: 'invalid',
      message: 'SupabaseのURLとPublishable Keyを両方設定してください。',
    }
  }
  if (!isAllowedCloudUrl(normalizedUrl)) {
    return {
      status: 'invalid',
      message: 'VITE_SUPABASE_URLにHTTPS URL（ローカル開発ではloopback HTTP）を設定してください。',
    }
  }

  return {
    status: 'enabled',
    supabaseUrl: normalizedUrl,
    supabasePublishableKey: normalizedKey,
  }
}

const runtimeEnv = (import.meta as ImportMeta & {
  env?: Record<string, unknown>
}).env

export const cloudConfig = resolveCloudConfig({
  supabaseUrl: runtimeEnv?.VITE_SUPABASE_URL,
  supabasePublishableKey: runtimeEnv?.VITE_SUPABASE_PUBLISHABLE_KEY,
})
