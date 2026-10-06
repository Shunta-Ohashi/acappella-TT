import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv } from '../src/csv/csv.ts'
import { COMMON_MEMBER_CSV_HEADERS } from '../src/csv/commonMemberCsv.ts'
import { COMMON_BAND_CSV_HEADERS } from '../src/csv/commonBandCsv.ts'
import { EVENT_MEMBER_CSV_HEADERS } from '../src/csv/eventMemberCsv.ts'
import { EVENT_BAND_CSV_HEADERS } from '../src/csv/eventBandCsv.ts'
import {
  COMMON_BAND_CSV_HELP,
  COMMON_MEMBER_CSV_HELP,
  EVENT_BAND_CSV_HELP,
  EVENT_MEMBER_CSV_HELP,
} from '../src/csv/csvHelp.ts'

const cases = [
  ['共通メンバー', COMMON_MEMBER_CSV_HELP, COMMON_MEMBER_CSV_HEADERS],
  ['固定バンド', COMMON_BAND_CSV_HELP, COMMON_BAND_CSV_HEADERS],
  ['イベントメンバー', EVENT_MEMBER_CSV_HELP, EVENT_MEMBER_CSV_HEADERS],
  ['出演バンド', EVENT_BAND_CSV_HELP, EVENT_BAND_CSV_HEADERS],
]

for (const [label, help, headers] of cases) {
  test(`${label}CSV helpは人間向け列と技術列を合わせて実装headerをsource of truthにする`, () => {
    assert.deepEqual([
      ...help.columns.map((column) => column.name),
      ...help.technicalColumns.map((column) => column.name),
    ], [...headers])
    const parsed = parseCsv(help.example)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(parsed.rows[0].cells, [...headers])
    assert.equal(parsed.rows.length >= 3, true)
  })
}

test('全HelpはID列が通常不要で書き出しtemplateを利用できる構成にする', () => {
  for (const [, help] of cases) {
    assert.match(help.description, /ID列は通常入力不要/)
    assert.equal(help.technicalColumns.length > 0, true)
  }
})

test('固定バンドHelpはA列からの簡単入力とメンバー1〜N方式を説明する', () => {
  assert.match(COMMON_BAND_CSV_HELP.description, /A列にバンド名.*B列以降/)
  assert.equal(COMMON_BAND_CSV_HELP.columns.some((column) => column.name === 'メンバー7'), true)
  assert.match(COMMON_BAND_CSV_HELP.notes.join(' '), /メンバー8.*メンバー9/)
  assert.equal(COMMON_BAND_CSV_HELP.technicalColumns.some((column) => column.name === 'メンバーID一覧'), true)
})

test('Event Member Helpは簡略形式・行モデル・PA・時間帯syntaxを説明する', () => {
  assert.deepEqual(EVENT_MEMBER_CSV_HELP.columns.slice(0, 3).map((column) => column.name), [
    'メンバー', '開催日', '参加状態',
  ])
  assert.match(EVENT_MEMBER_CSV_HELP.description, /1 Member × 1 EventDay/)
  const descriptions = EVENT_MEMBER_CSV_HELP.columns.map((column) => column.description).join(' ')
  assert.match(descriptions, /可.*不可/)
  assert.match(descriptions, /09:00-11:00\|13:00-17:00/)
  assert.match(descriptions, /空欄は制限なし/)
})

test('Event Band Helpは簡略形式・固定バンド名・動的メンバー列を説明する', () => {
  assert.deepEqual(EVENT_BAND_CSV_HELP.columns.slice(0, 2).map((column) => column.name), ['バンド名', '開催日'])
  assert.equal(EVENT_BAND_CSV_HELP.columns.some((column) => column.name === '固定バンド名'), true)
  assert.match(EVENT_BAND_CSV_HELP.notes.join(' '), /8人以上/)
  assert.deepEqual(EVENT_BAND_CSV_HELP.technicalColumns.map((column) => column.name), [
    '出演バンドID', '開催日ID', '固定バンドID', 'メンバーID一覧', '下書きID',
  ])
  assert.match(
    EVENT_BAND_CSV_HELP.technicalColumns.find((column) => column.name === '下書きID')?.description ?? '',
    /保存前.*再読み込み.*空欄.*省略/,
  )
})
