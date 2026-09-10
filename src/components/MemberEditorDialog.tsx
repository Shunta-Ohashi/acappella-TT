import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Member } from '../domain/models'
import {
  createCommonMemberDraft,
  validateCommonMemberDraft,
  type CommonMemberDraft,
  type CommonMemberUpdateResult,
  type CommonMemberValidationErrors,
} from '../domain/commonMembers'

interface MemberEditorDialogProps {
  member?: Member
  onCancel: () => void
  onSave: (draft: CommonMemberDraft) => CommonMemberUpdateResult
}

export function MemberEditorDialog({
  member,
  onCancel,
  onSave,
}: MemberEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(() => createCommonMemberDraft(member))
  const [errors, setErrors] = useState<CommonMemberValidationErrors>({})
  const isEditing = member !== undefined

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validationErrors = validateCommonMemberDraft(draft)
    setErrors(validationErrors)
    if (validationErrors.realName || validationErrors.entryAcademicYear) return

    const result = onSave(draft)
    if (!result.ok) setErrors(result.errors)
  }

  return (
    <dialog
      ref={dialogRef}
      className="member-editor-dialog"
      aria-modal="true"
      aria-labelledby="member-editor-title"
      aria-describedby="member-editor-description"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form className="member-editor-form" noValidate onSubmit={handleSubmit}>
        <header className="member-editor-form__header">
          <p>共通データ</p>
          <h2 id="member-editor-title">
            {isEditing ? 'メンバーを編集' : 'メンバーを追加'}
          </h2>
          <span id="member-editor-description">
            イベントをまたいで使用するメンバー情報を設定します。
          </span>
        </header>

        <div className="member-editor-form__grid">
          <div className="member-editor-field">
            <label htmlFor="member-editor-real-name">
              本名 <span aria-hidden="true">*</span>
            </label>
            <input
              id="member-editor-real-name"
              type="text"
              autoFocus
              required
              value={draft.realName}
              aria-invalid={errors.realName ? 'true' : undefined}
              aria-describedby={errors.realName
                ? 'member-editor-real-name-error'
                : undefined}
              onChange={(event) => {
                setDraft((previous) => ({
                  ...previous,
                  realName: event.target.value,
                }))
                setErrors((previous) => ({
                  ...previous,
                  realName: undefined,
                }))
              }}
            />
            {errors.realName && (
              <p id="member-editor-real-name-error" className="form-error" role="alert">
                {errors.realName}
              </p>
            )}
          </div>

          <div className="member-editor-field">
            <label htmlFor="member-editor-aca-name">アカペラネーム</label>
            <input
              id="member-editor-aca-name"
              type="text"
              value={draft.acaName}
              onChange={(event) => setDraft((previous) => ({
                ...previous,
                acaName: event.target.value,
              }))}
            />
          </div>

          <div className="member-editor-field">
            <label htmlFor="member-editor-entry-year">入学年度</label>
            <input
              id="member-editor-entry-year"
              type="text"
              inputMode="numeric"
              placeholder="例: 2024"
              value={draft.entryAcademicYear}
              aria-invalid={errors.entryAcademicYear ? 'true' : undefined}
              aria-describedby={errors.entryAcademicYear
                ? 'member-editor-entry-year-error'
                : 'member-editor-entry-year-help'}
              onChange={(event) => {
                setDraft((previous) => ({
                  ...previous,
                  entryAcademicYear: event.target.value,
                }))
                setErrors((previous) => ({
                  ...previous,
                  entryAcademicYear: undefined,
                }))
              }}
            />
            <span id="member-editor-entry-year-help" className="member-editor-field__help">
              西暦を整数で入力します。
            </span>
            {errors.entryAcademicYear && (
              <p id="member-editor-entry-year-error" className="form-error" role="alert">
                {errors.entryAcademicYear}
              </p>
            )}
          </div>

          {isEditing && (
            <fieldset className="member-editor-choice">
              <legend>状態</legend>
              <label>
                <input
                  type="radio"
                  name="member-active-status"
                  checked={draft.active}
                  onChange={() => setDraft((previous) => ({
                    ...previous,
                    active: true,
                  }))}
                />
                在籍中
              </label>
              <label>
                <input
                  type="radio"
                  name="member-active-status"
                  checked={!draft.active}
                  onChange={() => setDraft((previous) => ({
                    ...previous,
                    active: false,
                  }))}
                />
                非在籍
              </label>
            </fieldset>
          )}
        </div>

        <fieldset className="member-editor-choice member-editor-choice--pa">
          <legend>PA対応</legend>
          <label>
            <input
              type="checkbox"
              checked={draft.paCapabilities.main}
              onChange={(event) => setDraft((previous) => ({
                ...previous,
                paCapabilities: {
                  ...previous.paCapabilities,
                  main: event.target.checked,
                },
              }))}
            />
            メインPA対応可
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.paCapabilities.sub}
              onChange={(event) => setDraft((previous) => ({
                ...previous,
                paCapabilities: {
                  ...previous.paCapabilities,
                  sub: event.target.checked,
                },
              }))}
            />
            サブPA対応可
          </label>
        </fieldset>

        <div className="member-editor-field">
          <label htmlFor="member-editor-notes">共通メモ</label>
          <textarea
            id="member-editor-notes"
            rows={4}
            value={draft.notes}
            onChange={(event) => setDraft((previous) => ({
              ...previous,
              notes: event.target.value,
            }))}
          />
          <span className="member-editor-field__help">
            イベント固有の参加条件は、イベント側で設定します。
          </span>
        </div>

        {errors.form && (
          <p className="form-error member-editor-form__error" role="alert">
            {errors.form}
          </p>
        )}

        <footer className="member-editor-form__actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">
            {isEditing ? '保存' : '追加'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
