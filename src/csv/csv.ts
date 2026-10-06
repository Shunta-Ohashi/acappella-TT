export const CSV_IMPORT_MAX_BYTES = 5 * 1024 * 1024

export interface CsvRow {
  rowNumber: number
  cells: string[]
}

export interface CsvImportError {
  rowNumber?: number
  column?: string
  message: string
}

export type CsvParseResult =
  | { ok: true; rows: CsvRow[] }
  | { ok: false; errors: CsvImportError[] }

export interface CsvTableRow {
  rowNumber: number
  values: Record<string, string>
}

export type CsvTableResult =
  | { ok: true; rows: CsvTableRow[] }
  | { ok: false; errors: CsvImportError[] }

export type CsvImportPlan<T> =
  | {
      ok: true
      candidate: T
      rowCount: number
      createdCount: number
      updatedCount: number
    }
  | { ok: false; errors: CsvImportError[] }

const isBlankRow = (cells: string[]): boolean =>
  cells.every((cell) => cell.trim() === '')

export const parseCsv = (source: string): CsvParseResult => {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const rows: CsvRow[] = []
  let cells: string[] = []
  let field = ''
  let rowNumber = 1
  let rowStart = 1
  let quoted = false
  let closedQuote = false

  const finishRow = () => {
    cells.push(field)
    if (!isBlankRow(cells)) rows.push({ rowNumber: rowStart, cells })
    cells = []
    field = ''
    closedQuote = false
    rowStart = rowNumber + 1
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          closedQuote = true
        }
      } else {
        field += character
        if (character === '\n') rowNumber += 1
        else if (character === '\r' && text[index + 1] !== '\n') rowNumber += 1
      }
      continue
    }

    if (closedQuote && character !== ',' && character !== '\r' && character !== '\n') {
      return {
        ok: false,
        errors: [{ rowNumber, message: '引用符を閉じた後に不正な文字があります。' }],
      }
    }
    if (character === '"') {
      if (field.length > 0) {
        return {
          ok: false,
          errors: [{ rowNumber, message: '引用符の位置が正しくありません。' }],
        }
      }
      quoted = true
      continue
    }
    if (character === ',') {
      cells.push(field)
      field = ''
      closedQuote = false
      continue
    }
    if (character === '\r' || character === '\n') {
      finishRow()
      if (character === '\r' && text[index + 1] === '\n') index += 1
      rowNumber += 1
      rowStart = rowNumber
      continue
    }
    field += character
  }

  if (quoted) {
    return {
      ok: false,
      errors: [{ rowNumber: rowStart, message: '引用符が閉じられていません。' }],
    }
  }
  if (field.length > 0 || cells.length > 0 || closedQuote) finishRow()
  return { ok: true, rows }
}

export const parseCsvTable = (
  source: string,
  requiredHeaders: readonly string[],
): CsvTableResult => {
  const parsed = parseCsv(source)
  if (!parsed.ok) return parsed
  const [headerRow, ...dataRows] = parsed.rows
  if (!headerRow) {
    return { ok: false, errors: [{ message: 'CSVヘッダーがありません。' }] }
  }
  const headers = headerRow.cells.map((header) => header.trim())
  const duplicateHeaders = headers.filter((header, index) =>
    header && headers.indexOf(header) !== index,
  )
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header))
  const errors: CsvImportError[] = [
    ...[...new Set(duplicateHeaders)].map((header) => ({
      rowNumber: headerRow.rowNumber,
      column: header,
      message: '同じ列名が重複しています。',
    })),
    ...missingHeaders.map((header) => ({
      rowNumber: headerRow.rowNumber,
      column: header,
      message: '必須列がありません。',
    })),
    ...dataRows.flatMap((row): CsvImportError[] =>
      row.cells.length > headers.length
        ? [{
            rowNumber: row.rowNumber,
            column: '列数',
            message: 'データ列がヘッダーより多くあります。',
          }]
        : [],
    ),
  ]
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    rows: dataRows.map((row) => ({
      rowNumber: row.rowNumber,
      values: Object.fromEntries(headers.map((header, index) => [
        header,
        row.cells[index] ?? '',
      ])),
    })),
  }
}

const escapeCsvCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value

export const serializeCsv = (rows: readonly (readonly string[])[]): string =>
  `\uFEFF${rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\r\n')}\r\n`

export const formatCsvImportError = (error: CsvImportError): string => [
  error.rowNumber ? `${error.rowNumber}行目` : undefined,
  error.column ? `「${error.column}」` : undefined,
  error.message,
].filter(Boolean).join('')

export const splitListCell = (value: string): string[] => value.trim()
  ? value.split('|').map((item) => item.trim()).filter(Boolean)
  : []

