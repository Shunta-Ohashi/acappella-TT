const activitySuspendedDialogs = new WeakSet<object>()

export interface ManagedNativeDialog {
  open: boolean
  isConnected?: boolean
  showModal: () => void
  close: () => void
}

export const synchronizeNativeDialogActivity = (
  dialog: ManagedNativeDialog,
  active: boolean,
  trackSuspendedClose = false,
): 'opened' | 'suspended' | 'unchanged' => {
  if (active) {
    if (!dialog.open && dialog.isConnected !== false) {
      dialog.showModal()
      return 'opened'
    }
    return 'unchanged'
  }
  if (dialog.open) {
    if (trackSuspendedClose) activitySuspendedDialogs.add(dialog)
    dialog.close()
    return 'suspended'
  }
  return 'unchanged'
}

export const consumeNativeDialogActivityClose = (
  dialog: ManagedNativeDialog,
): boolean => {
  if (!activitySuspendedDialogs.has(dialog)) return false
  activitySuspendedDialogs.delete(dialog)
  return true
}
