import { useEffect, useId, useRef } from 'react'
import { canDismissDeleteConfirmation } from '../ui/deleteConfirmation'

interface DeleteConfirmationDialogProps {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  isPending?: boolean
  pendingLabel?: string
  errorMessage?: string
}

export function DeleteConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  isPending = false,
  pendingLabel = confirmLabel,
  errorMessage,
}: DeleteConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()

    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="delete-confirmation-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={isPending || undefined}
      onCancel={(event) => {
        event.preventDefault()
        if (canDismissDeleteConfirmation(isPending)) onCancel()
      }}
    >
      <div className="delete-confirmation-dialog__content">
        <header>
          <h2 id={titleId}>{title}</h2>
        </header>
        <p id={descriptionId}>{description}</p>
        {errorMessage && (
          <p className="form-error" role="alert">{errorMessage}</p>
        )}
        <footer className="delete-confirmation-dialog__actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus
            disabled={isPending}
            onClick={() => {
              if (canDismissDeleteConfirmation(isPending)) onCancel()
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="delete-confirmation-dialog__confirm"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? pendingLabel : confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
