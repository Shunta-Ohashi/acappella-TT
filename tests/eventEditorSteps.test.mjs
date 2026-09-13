import assert from 'node:assert/strict'
import test from 'node:test'

import { eventEditorSteps } from '../src/ui/eventEditorSteps.ts'

test('イベント編集は統合後の8Stepを正しい順序で定義する', () => {
  assert.deepEqual(
    eventEditorSteps.map(({ id, label }) => ({ id, label })),
    [
      { id: 1, label: '基本情報' },
      { id: 2, label: '会場・Stage' },
      { id: 3, label: 'メンバー' },
      { id: 4, label: '出演バンド' },
      { id: 5, label: '出演条件' },
      { id: 6, label: 'タイムテーブル・運営' },
      { id: 7, label: '最終チェック' },
      { id: 8, label: '公開・出力' },
    ],
  )
})
