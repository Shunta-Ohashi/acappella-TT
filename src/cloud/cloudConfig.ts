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

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
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
  if (!isHttpUrl(normalizedUrl)) {
    return {
      status: 'invalid',
      message: 'VITE_SUPABASE_URLに有効なHTTP(S) URLを設定してください。',
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
