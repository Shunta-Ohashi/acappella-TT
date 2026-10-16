import { pathToFileURL } from 'node:url'

const normalize = value => typeof value === 'string' ? value.trim() : ''

const isLoopbackHostname = hostname =>
  hostname === 'localhost' || hostname.endsWith('.localhost') ||
  hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)

const isServiceRoleKey = (value) => {
  if (value.startsWith('sb_secret_')) return true
  const payload = value.split('.')[1]
  if (!payload) return false
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8'))
    return decoded?.role === 'service_role'
  } catch {
    return false
  }
}

export const validateCloudDeploymentEnvironment = (environment, { forceCloud = false } = {}) => {
  const isVercelBuild = forceCloud || normalize(environment.VERCEL) === '1'
  const cloudRequired = normalize(environment.VITE_CLOUD_REQUIRED)

  if (!isVercelBuild && !cloudRequired) return { cloudRequired: false }
  if (cloudRequired !== 'true') {
    throw new Error('Cloud deployment requires VITE_CLOUD_REQUIRED=true.')
  }

  const supabaseUrl = normalize(environment.VITE_SUPABASE_URL)
  const publishableKey = normalize(environment.VITE_SUPABASE_PUBLISHABLE_KEY)
  if (!supabaseUrl || !publishableKey) {
    throw new Error('Cloud deployment requires a Supabase URL and Publishable Key.')
  }

  let parsedUrl
  try {
    parsedUrl = new URL(supabaseUrl)
  } catch {
    throw new Error('Cloud deployment has an invalid Supabase URL.')
  }

  if (
    parsedUrl.protocol !== 'https:' || isLoopbackHostname(parsedUrl.hostname) ||
    parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash ||
    (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/')
  ) {
    throw new Error('Cloud deployment requires a non-loopback HTTPS Supabase origin.')
  }
  if (isServiceRoleKey(publishableKey)) {
    throw new Error('Cloud deployment must use a Supabase Publishable Key, not a server key.')
  }

  return { cloudRequired: true }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const arguments_ = process.argv.slice(2)
    if (arguments_.some(argument => argument !== '--require-cloud') || arguments_.length > 1) {
      throw new Error('Unknown deployment validation option.')
    }
    const result = validateCloudDeploymentEnvironment(process.env, {
      forceCloud: arguments_[0] === '--require-cloud',
    })
    if (result.cloudRequired) console.log('Cloud deployment environment: OK')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloud deployment configuration is invalid.')
    process.exitCode = 1
  }
}
