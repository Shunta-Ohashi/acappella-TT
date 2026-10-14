export const POSTGRES_BIGINT_MAX_GENERATION = '9223372036854775807'

const canonicalGenerationPattern = /^(0|[1-9][0-9]*)$/u

export const isPostgresBigintGeneration = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > POSTGRES_BIGINT_MAX_GENERATION.length ||
    !canonicalGenerationPattern.test(value)
  ) {
    return false
  }

  return value.length < POSTGRES_BIGINT_MAX_GENERATION.length ||
    (
      value.length === POSTGRES_BIGINT_MAX_GENERATION.length &&
      value <= POSTGRES_BIGINT_MAX_GENERATION
    )
}
