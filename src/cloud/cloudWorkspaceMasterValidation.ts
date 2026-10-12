import type { Band, Member } from '../domain/models.ts'
import { isBand, isMember } from '../persistence/persistenceValidation.ts'

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const isValidCloudWorkspaceMember = (value: unknown): value is Member =>
  isMember(value) &&
  Object.keys(value).every(key => [
    'id', 'realName', 'acaName', 'entryAcademicYear', 'notes', 'active',
  ].includes(key)) &&
  value.id.trim().length > 0 && value.realName.trim().length > 0

export const isValidCloudWorkspaceBand = (value: unknown): value is Band =>
  isBand(value) &&
  Object.keys(value).every(key => [
    'id', 'name', 'defaultMemberIds', 'notes', 'active',
  ].includes(key)) &&
  value.id.trim().length > 0 &&
  value.name.trim().length > 0 &&
  value.defaultMemberIds.every(isNonEmptyString) &&
  new Set(value.defaultMemberIds).size === value.defaultMemberIds.length
