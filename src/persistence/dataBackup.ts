import {
  createPersistedAppState,
  parsePersistedState,
  type PersistedAppStateV2,
  type PersistedDomainState,
} from './localPersistence.ts'

export const createBackupJson = (state: PersistedDomainState): string =>
  JSON.stringify(createPersistedAppState(state), null, 2)

export const parseBackupJson = (json: string): PersistedAppStateV2 | undefined =>
  parsePersistedState(json)

export const createBackupFilename = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `acappella-tt-backup-${day}-${time}.json`
}
