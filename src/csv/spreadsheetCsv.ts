import {
  parseCsvTable,
  serializeCsv,
  type CsvTableResult,
} from './csv.ts'

const SPREADSHEET_TEXT_PREFIX = "'"
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/

export const protectSpreadsheetCell = (value: string): string =>
  FORMULA_PREFIX_PATTERN.test(value) || value.startsWith(SPREADSHEET_TEXT_PREFIX)
    ? `${SPREADSHEET_TEXT_PREFIX}${value}`
    : value

export const restoreSpreadsheetCell = (value: string): string => {
  if (value.startsWith(`${SPREADSHEET_TEXT_PREFIX}${SPREADSHEET_TEXT_PREFIX}`)) {
    return value.slice(1)
  }
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value
}

export const serializeSpreadsheetCsv = (
  rows: readonly (readonly string[])[],
): string => serializeCsv(rows.map((row) => row.map(protectSpreadsheetCell)))

export const parseSpreadsheetCsvTable = (
  source: string,
  requiredHeaders: readonly string[],
): CsvTableResult => {
  const table = parseCsvTable(source, requiredHeaders)
  if (!table.ok) return table
  return {
    ok: true,
    rows: table.rows.map((row) => ({
      ...row,
      values: Object.fromEntries(
        Object.entries(row.values).map(([header, value]) => [
          header,
          restoreSpreadsheetCell(value),
        ]),
      ),
    })),
  }
}
