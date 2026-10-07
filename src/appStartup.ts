import type { CloudConfig } from './cloud/cloudConfig.ts'

export type AppStartupMode = 'share' | 'local' | 'cloud-invalid' | 'cloud-enabled'

export const resolveAppStartupMode = ({
  isShare,
  cloudStatus,
}: {
  isShare: boolean
  cloudStatus: CloudConfig['status']
}): AppStartupMode => {
  if (isShare) return 'share'
  if (cloudStatus === 'disabled') return 'local'
  if (cloudStatus === 'invalid') return 'cloud-invalid'
  return 'cloud-enabled'
}
