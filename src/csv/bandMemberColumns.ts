import type { CsvImportError, CsvTableRow } from './csv.ts'

export const MIN_BAND_MEMBER_COLUMN_COUNT = 7
export const MEMBER_ID_LIST_HEADER = 'メンバーID一覧'

export const createBandMemberHeaders = (count: number): string[] =>
  Array.from({ length: Math.max(MIN_BAND_MEMBER_COLUMN_COUNT, count) }, (_, index) =>
    `メンバー${index + 1}`,
  )

export const getBandMemberHeaders = (
  headers: readonly string[],
): { ok: true; headers: string[] } | { ok: false; errors: CsvImportError[] } => {
  const memberHeaders = headers.filter((header) =>
    header.startsWith('メンバー') && header !== MEMBER_ID_LIST_HEADER,
  )
  const numbered = memberHeaders.map((header) => {
    const match = /^メンバー([1-9]\d*)$/.exec(header)
    const number = match ? Number(match[1]) : Number.NaN
    return { header, number }
  })
  const invalid = numbered.filter(({ number }) => !Number.isSafeInteger(number))
  if (invalid.length > 0) {
    return {
      ok: false,
      errors: invalid.map(({ header }) => ({
        rowNumber: 1,
        column: header,
        message: 'メンバー列は「メンバー1」のように1以上の連番で指定してください。',
      })),
    }
  }
  numbered.sort((left, right) => left.number - right.number)
  const discontinuous = numbered.find(({ number }, index) => number !== index + 1)
  if (discontinuous) {
    return {
      ok: false,
      errors: [{
        rowNumber: 1,
        column: discontinuous.header,
        message: 'メンバー列はメンバー1から番号を飛ばさず指定してください。',
      }],
    }
  }
  return { ok: true, headers: numbered.map(({ header }) => header) }
}

export const getMemberNamesFromRow = (
  row: CsvTableRow,
  memberHeaders: readonly string[],
): string[] => memberHeaders
  .map((header) => row.values[header]?.trim() ?? '')
  .filter(Boolean)
