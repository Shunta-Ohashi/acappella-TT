import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv, serializeCsv } from '../src/csv/csv.ts'
import {
  parseSpreadsheetCsvTable,
  protectSpreadsheetCell,
  restoreSpreadsheetCell,
  serializeSpreadsheetCsv,
} from '../src/csv/spreadsheetCsv.ts'

test('Spreadsheet exportはformula prefixを実行されないtextへ変換する', () => {
  for (const value of ['=LOVE', '+TEST', '-NAME', '@USER']) {
    assert.equal(protectSpreadsheetCell(value), `'${value}`)
  }
  assert.equal(protectSpreadsheetCell('通常値'), '通常値')
})

test('Spreadsheet-safe ExportからImportするとformula-likeな正当値を復元する', () => {
  const values = ['=LOVE', '+TEST', '-NAME', '@USER', '通常値', "'=先頭apostrophe"]
  const exported = serializeSpreadsheetCsv([['名前'], ...values.map((value) => [value])])
  const raw = parseCsv(exported)
  assert.equal(raw.ok, true)
  if (!raw.ok) return
  assert.deepEqual(raw.rows.slice(1, 5).map((row) => row.cells[0]), [
    "'=LOVE", "'+TEST", "'-NAME", "'@USER",
  ])
  const imported = parseSpreadsheetCsvTable(exported, ['名前'])
  assert.equal(imported.ok, true)
  if (imported.ok) assert.deepEqual(imported.rows.map((row) => row.values['名前']), values)
})

test('Spreadsheet markerは可逆でraw CSV serializerのcontractを変更しない', () => {
  assert.equal(restoreSpreadsheetCell("''literal"), "'literal")
  const raw = serializeCsv([['=LOVE', '+TEST', '-NAME', '@USER']])
  const parsed = parseCsv(raw)
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.rows[0].cells, ['=LOVE', '+TEST', '-NAME', '@USER'])
})
