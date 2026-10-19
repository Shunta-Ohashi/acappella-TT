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
  cloudRequired?: unknown
}

const normalizeEnvValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const isLoopbackHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/u, '')
  if (
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalizedHostname)
  ) return true

  const ipv6Address = normalizedHostname.startsWith('[') &&
      normalizedHostname.endsWith(']')
    ? normalizedHostname.slice(1, -1)
    : normalizedHostname
  return ipv6Address === '::1' ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(ipv6Address)
}

const isServiceRoleKey = (value: string): boolean => {
  if (value.startsWith('sb_secret_')) return true
  const payload = value.split('.')[1]
  if (!payload) return false
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = JSON.parse(atob(normalized)) as unknown
    return typeof decoded === 'object' && decoded !== null &&
      'role' in decoded && decoded.role === 'service_role'
  } catch {
    return false
  }
}

const isAllowedCloudUrl = (value: string, cloudRequired: boolean): boolean => {
  try {
    const url = new URL(value)
    if (
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) return false
    if (cloudRequired) {
      return url.protocol === 'https:' && !isLoopbackHostname(url.hostname)
    }
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  } catch {
    return false
  }
}

export const resolveCloudConfig = ({
  supabaseUrl,
  supabasePublishableKey,
  cloudRequired,
}: CloudConfigInput): CloudConfig => {
  const normalizedUrl = normalizeEnvValue(supabaseUrl)
  const normalizedKey = normalizeEnvValue(supabasePublishableKey)
  const normalizedCloudRequired = normalizeEnvValue(cloudRequired)
  const requiresCloud = normalizedCloudRequired === 'true'

  if (normalizedCloudRequired && !['true', 'false'].includes(normalizedCloudRequired)) {
    return {
      status: 'invalid',
      message: 'VITE_CLOUD_REQUIREDはtrueまたはfalseで設定してください。',
    }
  }

  if (!normalizedUrl && !normalizedKey && !requiresCloud) return { status: 'disabled' }
  if (!normalizedUrl || !normalizedKey) {
    return {
      status: 'invalid',
      message: 'SupabaseのURLとPublishable Keyを両方設定してください。',
    }
  }
  if (!isAllowedCloudUrl(normalizedUrl, requiresCloud)) {
    return {
      status: 'invalid',
      message: requiresCloud
        ? '公開用Supabase URLにはloopbackではないHTTPS originを設定してください。'
        : 'VITE_SUPABASE_URLにHTTPS URL（ローカル開発ではloopback HTTP）を設定してください。',
    }
  }
  if (isServiceRoleKey(normalizedKey)) {
    return {
      status: 'invalid',
      message: 'ブラウザにはSupabase Publishable Keyだけを設定してください。',
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
  cloudRequired: runtimeEnv?.VITE_CLOUD_REQUIRED,
})
