export type EventEditorCloudOperation = 'save' | 'delete'

export interface EventEditorInteractionState {
  contentInert: boolean
  navigationDisabled: boolean
  statusLabel: '下書き' | '閲覧のみ' | 'Cloud保存中' | 'Cloud削除中'
}

export const isEventEditorCloudNavigationLocked = (
  isEventEditorActive: boolean,
  cloudOperation?: EventEditorCloudOperation,
): boolean => isEventEditorActive && cloudOperation !== undefined

export const getEventEditorInteractionState = ({
  readOnly,
  cloudOperation,
}: {
  readOnly: boolean
  cloudOperation?: EventEditorCloudOperation
}): EventEditorInteractionState => {
  const cloudSavePending = cloudOperation === 'save'
  return {
    // Event deletion uses a modal confirmation dialog rendered inside the
    // content subtree. Keep that dialog operable while its own pending state
    // blocks dismissal; only a save lease needs the draft-mutation barrier.
    contentInert: cloudSavePending,
    navigationDisabled: cloudOperation !== undefined,
    statusLabel: readOnly
      ? '閲覧のみ'
      : cloudOperation === 'save'
        ? 'Cloud保存中'
        : cloudOperation === 'delete'
          ? 'Cloud削除中'
          : '下書き',
  }
}
