import { strFromU8, strToU8, Unzlib, zlibSync } from 'fflate'
import {
  parseTimetablePreShareSnapshot,
  type TimetablePreShareSnapshotV1,
} from './timetablePreShare.ts'

export const MAX_TIMETABLE_PRE_SHARE_URL_LENGTH = 65_536
export const MAX_TIMETABLE_PRE_SHARE_DECOMPRESSED_BYTES = 2 * 1024 * 1024
const DECOMPRESSION_INPUT_CHUNK_BYTES = 1024

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array => {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url')
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const canonical = bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
  if (canonical !== value) throw new Error('Non-canonical base64url')
  return bytes
}

type LimitedDecompressionResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'MALFORMED' | 'TOO_LARGE' }

const decompressWithLimit = (compressed: Uint8Array): LimitedDecompressionResult => {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let failed = false
  let tooLarge = false
  let completed = false
  const decoder = new Unzlib((chunk, final) => {
    byteLength += chunk.byteLength
    if (byteLength > MAX_TIMETABLE_PRE_SHARE_DECOMPRESSED_BYTES) {
      tooLarge = true
      return
    }
    chunks.push(chunk)
    completed = final
  })

  try {
    for (let offset = 0; offset < compressed.length && !failed && !tooLarge;
      offset += DECOMPRESSION_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + DECOMPRESSION_INPUT_CHUNK_BYTES, compressed.length)
      decoder.push(compressed.subarray(offset, end), end === compressed.length)
    }
  } catch {
    failed = true
  }
  if (tooLarge) return { ok: false, reason: 'TOO_LARGE' }
  if (failed || !completed) return { ok: false, reason: 'MALFORMED' }

  const bytes = new Uint8Array(byteLength)
  let outputOffset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, outputOffset)
    outputOffset += chunk.byteLength
  }
  return { ok: true, bytes }
}

export const encodeTimetablePreShareSnapshot = (
  snapshot: TimetablePreShareSnapshotV1,
): string => {
  const validated = parseTimetablePreShareSnapshot(snapshot)
  if (!validated) throw new RangeError('Invalid timetable pre-share snapshot')
  return bytesToBase64(zlibSync(strToU8(JSON.stringify(validated)), { level: 9 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

export type DecodeTimetablePreShareResult =
  | { ok: true; snapshot: TimetablePreShareSnapshotV1 }
  | { ok: false; reason: 'MALFORMED' | 'TOO_LARGE' }

export const decodeTimetablePreSharePayload = (
  payload: string,
): DecodeTimetablePreShareResult => {
  if (payload.length > MAX_TIMETABLE_PRE_SHARE_URL_LENGTH) {
    return { ok: false, reason: 'TOO_LARGE' }
  }
  try {
    const decompressed = decompressWithLimit(base64ToBytes(payload))
    if (!decompressed.ok) return decompressed
    const snapshot = parseTimetablePreShareSnapshot(JSON.parse(strFromU8(decompressed.bytes)))
    return snapshot ? { ok: true, snapshot } : { ok: false, reason: 'MALFORMED' }
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }
}

export type TimetablePreShareRoute =
  | { kind: 'app' }
  | { kind: 'share'; snapshot: TimetablePreShareSnapshotV1 }
  | { kind: 'error' }

export const resolveTimetablePreShareRoute = (hash: string): TimetablePreShareRoute => {
  if (!hash.startsWith('#share=')) return { kind: 'app' }
  const decoded = decodeTimetablePreSharePayload(hash.slice('#share='.length))
  return decoded.ok ? { kind: 'share', snapshot: decoded.snapshot } : { kind: 'error' }
}

export type CreateTimetablePreShareUrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string }

export const createTimetablePreShareUrl = (
  snapshot: TimetablePreShareSnapshotV1,
  currentHref: string,
): CreateTimetablePreShareUrlResult => {
  try {
    const url = new URL(currentHref)
    url.hash = `share=${encodeTimetablePreShareSnapshot(snapshot)}`
    const serialized = url.toString()
    return serialized.length <= MAX_TIMETABLE_PRE_SHARE_URL_LENGTH
      ? { ok: true, url: serialized }
      : {
          ok: false,
          message: '共有リンクが大きすぎるため作成できません。Excel出力を利用してください。',
        }
  } catch {
    return { ok: false, message: '共有リンクを作成できませんでした。' }
  }
}

export const createNormalAppUrl = (currentHref: string): string => {
  const url = new URL(currentHref)
  url.hash = ''
  return url.toString()
}
