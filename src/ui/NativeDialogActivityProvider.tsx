import type { PropsWithChildren } from 'react'
import { NativeDialogActivityContext } from './nativeDialogActivityContext'

export function NativeDialogActivityProvider({
  active,
  children,
}: PropsWithChildren<{ active: boolean }>) {
  return (
    <NativeDialogActivityContext.Provider value={active}>
      {children}
    </NativeDialogActivityContext.Provider>
  )
}
