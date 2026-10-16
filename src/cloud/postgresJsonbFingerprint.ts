const utf8Encoder = new TextEncoder()

const hasValidPostgresJsonbText = (value: string): boolean => {
  if (value.includes('\u0000')) return false
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

const comparePostgresJsonbKeys = (left: string, right: string): number => {
  const leftBytes = utf8Encoder.encode(left)
  const rightBytes = utf8Encoder.encode(right)
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length
  for (let index = 0; index < leftBytes.length; index += 1) {
    const difference = Number(leftBytes[index]) - Number(rightBytes[index])
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Reproduces PostgreSQL 17 jsonb::text for the JSON subset accepted by Cloud
 * Event snapshots. Snapshot numbers are safe integers; values whose original
 * PostgreSQL numeric spelling cannot be represented losslessly in JavaScript
 * are deliberately rejected rather than guessed.
 */
export const serializePostgresJsonbText = (value: unknown): string | undefined => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(Object.is(value, -0) ? 0 : value) : undefined
  }
  if (typeof value === 'string') {
    return hasValidPostgresJsonbText(value) ? JSON.stringify(value) : undefined
  }
  if (Array.isArray(value)) {
    const elements: string[] = []
    for (const element of value) {
      const serialized = serializePostgresJsonbText(element)
      if (serialized === undefined) return undefined
      elements.push(serialized)
    }
    return `[${elements.join(', ')}]`
  }
  if (typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const entries: string[] = []
  for (const key of Object.keys(record).sort(comparePostgresJsonbKeys)) {
    if (!hasValidPostgresJsonbText(key)) return undefined
    const serialized = serializePostgresJsonbText(record[key])
    if (serialized === undefined) return undefined
    entries.push(`${JSON.stringify(key)}: ${serialized}`)
  }
  return `{${entries.join(', ')}}`
}

export const createPostgresJsonbSha256Fingerprint = async (
  value: unknown,
): Promise<string | undefined> => {
  const serialized = serializePostgresJsonbText(value)
  if (serialized === undefined) return undefined
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    utf8Encoder.encode(serialized),
  )
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
