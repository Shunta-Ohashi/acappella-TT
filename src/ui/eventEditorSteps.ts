export type EventEditorStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface EventEditorStep {
  id: EventEditorStepId
  label: string
  description: string
}

export const eventEditorSteps: EventEditorStep[] = [
  { id: 1, label: '基本情報', description: 'イベントの基本情報を設定します。' },
  { id: 2, label: '会場・Stage', description: '開催日ごとのStageや時間構成を設定します。' },
  { id: 3, label: 'メンバー', description: '今回のイベントに参加するメンバーを設定します。' },
  { id: 4, label: '出演バンド', description: '今回出演するバンドを設定します。' },
  { id: 5, label: '出演条件', description: 'バンドごとの出演条件や希望を設定します。' },
  { id: 6, label: 'タイムテーブル・運営', description: '出演順を調整し、PAや当日運営の設定を確認します。' },
  { id: 7, label: '最終チェック', description: '出演・PA・当日運営などの問題をまとめて確認します。' },
  { id: 8, label: '公開・出力', description: 'タイムテーブルの公開やデータ出力を設定します。' },
]
