import { isPostgresBigintGeneration } from '../cloud/cloudGeneration.ts'

/**
 * Keeps a Cloud Event revision exact across JSON boundaries used by Live TT.
 * Safe legacy numbers are normalized for compatibility; unsafe numbers are
 * never accepted because their original PostgreSQL bigint value is unknowable.
 */
export const parseLiveTimetableSourceRevision = (
  value: unknown,
): string | undefined => {
  if (isPostgresBigintGeneration(value) && value !== '0') return value
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : undefined
}
