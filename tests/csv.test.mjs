import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCsv,
  parseCsvTable,
  serializeCsv,
} from '../src/csv/csv.ts'

test('simple CSVをparseする', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), {
    ok: true,
    rows: [
      { rowNumber: 1, cells: ['a', 'b'] },
      { rowNumber: 2, cells: ['1', '2'] },
    ],
  })
})

test('quoted fieldのcommaとescaped quoteをparseする', () => {
  const result = parseCsv('name,note\r\n"A,B","say ""hello"""')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.rows[1].cells, ['A,B', 'say "hello"'])
})

test('quoted field内の改行を保持する', () => {
  const result = parseCsv('name,note\nA,"line 1\nline 2"')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.rows[1], { rowNumber: 2, cells: ['A', 'line 1\nline 2'] })
})

test('CRLFとUTF-8 BOMを処理する', () => {
  const result = parseCsv('\uFEFFa,b\r\n1,2\r\n')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[1].rowNumber, 2)
})

test('empty fieldとtrailing empty fieldを保持する', () => {
  const result = parseCsv('a,b,c\n1,,')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.rows[1].cells, ['1', '', ''])
})

test('空行を安全に無視し、CSV行番号を維持する', () => {
  const result = parseCsv('a,b\n\n1,2\n   \n3,4')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.rows.map((row) => row.rowNumber), [1, 3, 5])
})

test('閉じていないquoteをrejectする', () => {
  const result = parseCsv('a,b\n1,"broken')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].rowNumber, 2)
})

test('quoted fieldを閉じた後の不正文字をrejectする', () => {
  assert.equal(parseCsv('a\n"value"x').ok, false)
})

test('serializerはBOMとCRLFを使い特殊文字をescapeする', () => {
  const csv = serializeCsv([
    ['name', 'note'],
    ['A,B', 'quote " and\nnewline'],
  ])
  assert.equal(csv.startsWith('\uFEFF'), true)
  assert.equal(csv.endsWith('\r\n'), true)
  assert.equal(csv.includes('"A,B","quote "" and\nnewline"'), true)
})

test('serializeからparseへ内容をround-tripする', () => {
  const rows = [['=LOVE', 'comma,value', ''], ['改行', 'one\r\ntwo', '"quote"']]
  const result = parseCsv(serializeCsv(rows))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.rows.map((row) => row.cells), rows)
})

test('header順序変更と未知columnを許可する', () => {
  const result = parseCsvTable('unknown,b,a\nx,2,1', ['a', 'b'])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.rows[0].values, { unknown: 'x', b: '2', a: '1' })
})

test('不足headerと重複headerをrejectする', () => {
  const result = parseCsvTable('a,a\n1,2', ['a', 'b'])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors.length, 2)
})
