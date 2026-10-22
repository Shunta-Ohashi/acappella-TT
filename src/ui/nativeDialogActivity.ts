import {
  useContext,
  useLayoutEffect,
  type RefObject,
} from 'react'
import { NativeDialogActivityContext } from './nativeDialogActivityContext'
import { synchronizeNativeDialogActivity } from './nativeDialogActivityState'

export { consumeNativeDialogActivityClose } from './nativeDialogActivityState'

export const useNativeDialogActivity = (
  dialogRef: RefObject<HTMLDialogElement | null>,
  trackSuspendedClose = false,
) => {
  const active = useContext(NativeDialogActivityContext)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    synchronizeNativeDialogActivity(dialog, active, trackSuspendedClose)

    return () => {
      if (dialog.open) {
        synchronizeNativeDialogActivity(dialog, false, trackSuspendedClose)
      }
    }
  }, [active, dialogRef, trackSuspendedClose])
}
