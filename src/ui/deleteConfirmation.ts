export type DeleteConfirmationTarget =
  | 'event-day'
  | 'stage'
  | 'section'
  | 'event-member'
  | 'event-band'

export interface DeleteConfirmationCopy {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
}

export const getDeleteConfirmationCopy = (
  target: DeleteConfirmationTarget,
  targetLabel: string,
): DeleteConfirmationCopy => {
  const label = targetLabel.trim() || '名称未設定'
  const labels = {
    confirmLabel: '削除する',
    cancelLabel: 'キャンセル',
  }

  switch (target) {
    case 'event-day':
      return {
        title: '開催日を削除しますか？',
        description: `「${label}」をこのイベントの開催日から削除します。保存すると変更が反映されます。`,
        ...labels,
      }
    case 'stage':
      return {
        title: `「${label}」を削除しますか？`,
        description: 'このStage設定を一覧から削除します。保存すると変更が反映されます。',
        ...labels,
      }
    case 'section':
      return {
        title: `「${label}」を削除しますか？`,
        description: 'このSection設定を一覧から削除します。保存すると変更が反映されます。',
        ...labels,
      }
    case 'event-member':
      return {
        title: '参加メンバーを削除しますか？',
        description: `「${label}」をこのイベントの参加メンバーから削除します。保存すると変更が反映されます。`,
        ...labels,
      }
    case 'event-band':
      return {
        title: '出演バンドを削除しますか？',
        description: `「${label}」をこのイベントの出演バンドから削除します。保存すると変更が反映されます。`,
        ...labels,
      }
  }
}
