import { useEffect, useId, useRef } from 'react'

interface DeleteConfirmationDialogProps {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
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
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <div className="delete-confirmation-dialog__content">
        <header>
          <h2 id={titleId}>{title}</h2>
        </header>
        <p id={descriptionId}>{description}</p>
        <footer className="delete-confirmation-dialog__actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="delete-confirmation-dialog__confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
