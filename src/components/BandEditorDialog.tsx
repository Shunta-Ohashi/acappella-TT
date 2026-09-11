import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Band, Member, MemberId } from '../domain/models'
import { filterCommonMembers } from '../domain/commonMembers'
import {
  createCommonBandDraft,
  validateCommonBandDraft,
  type CommonBandDraft,
  type CommonBandUpdateResult,
  type CommonBandValidationErrors,
} from '../domain/commonBands'

interface BandEditorDialogProps {
  band?: Band
  members: Member[]
  onCancel: () => void
  onSave: (draft: CommonBandDraft) => CommonBandUpdateResult
}

export function BandEditorDialog({
  band,
  members,
  onCancel,
  onSave,
}: BandEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(() => createCommonBandDraft(band))
  const [memberSearchText, setMemberSearchText] = useState('')
  const [errors, setErrors] = useState<CommonBandValidationErrors>({})
  const isEditing = band !== undefined
  const displayedMembers = filterCommonMembers(
    members,
    memberSearchText,
    'all',
  )
  const knownMemberIds = new Set(members.map((member) => member.id))
  const missingMemberIds = draft.defaultMemberIds.filter(
    (memberId) => !knownMemberIds.has(memberId),
  )
  const selectedMemberCount = new Set(draft.defaultMemberIds).size

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const handleToggleMember = (memberId: MemberId) => {
    setDraft((previous) => ({
      ...previous,
      defaultMemberIds: previous.defaultMemberIds.includes(memberId)
        ? previous.defaultMemberIds.filter((id) => id !== memberId)
        : [...previous.defaultMemberIds, memberId],
    }))
    setErrors((previous) => ({
      ...previous,
      defaultMemberIds: undefined,
    }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validationErrors = validateCommonBandDraft(draft, members, band)
    setErrors(validationErrors)
    if (
      validationErrors.name ||
      validationErrors.defaultMemberIds
    ) return

    const result = onSave(draft)
    if (!result.ok) setErrors(result.errors)
  }

  return (
    <dialog
      ref={dialogRef}
      className="band-editor-dialog"
      aria-modal="true"
      aria-labelledby="band-editor-title"
      aria-describedby="band-editor-description"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form className="band-editor-form" noValidate onSubmit={handleSubmit}>
        <header className="band-editor-form__header">
          <p>共通データ</p>
          <h2 id="band-editor-title">
            {isEditing ? '固定バンドを編集' : '固定バンドを追加'}
          </h2>
          <span id="band-editor-description">
            複数のイベントで利用する固定バンドの基本情報を設定します。
          </span>
        </header>

        <div className="band-editor-form__grid">
          <div className="band-editor-field">
            <label htmlFor="band-editor-name">
              バンド名 <span aria-hidden="true">*</span>
            </label>
            <input
              id="band-editor-name"
              type="text"
              autoFocus
              required
              value={draft.name}
              aria-invalid={errors.name ? 'true' : undefined}
              aria-describedby={errors.name ? 'band-editor-name-error' : undefined}
              onChange={(event) => {
                setDraft((previous) => ({
                  ...previous,
                  name: event.target.value,
                }))
                setErrors((previous) => ({ ...previous, name: undefined }))
              }}
            />
            {errors.name && (
              <p id="band-editor-name-error" className="form-error" role="alert">
                {errors.name}
              </p>
            )}
          </div>

          {isEditing && (
            <fieldset className="band-editor-choice">
              <legend>状態</legend>
              <label>
                <input
                  type="radio"
                  name="band-active-status"
                  checked={draft.active}
                  onChange={() => setDraft((previous) => ({
                    ...previous,
                    active: true,
                  }))}
                />
                活動中
              </label>
              <label>
                <input
                  type="radio"
                  name="band-active-status"
                  checked={!draft.active}
                  onChange={() => setDraft((previous) => ({
                    ...previous,
                    active: false,
                  }))}
                />
                活動終了
              </label>
            </fieldset>
          )}
        </div>

        <fieldset
          className="band-editor-members"
          aria-describedby={errors.defaultMemberIds
            ? 'band-editor-members-error'
            : 'band-editor-members-help'}
        >
          <legend>
            メンバー <span aria-hidden="true">*</span>
          </legend>
          <div className="band-editor-members__toolbar">
            <div>
              <label htmlFor="band-editor-member-search">メンバー検索</label>
              <input
                id="band-editor-member-search"
                type="search"
                value={memberSearchText}
                placeholder="本名・アカペラネームで検索"
                onChange={(event) => setMemberSearchText(event.target.value)}
              />
            </div>
            <strong>選択中 {selectedMemberCount}人</strong>
          </div>
          <span id="band-editor-members-help" className="band-editor-field__help">
            非在籍のメンバーも既存の所属情報として選択できます。
          </span>

          {missingMemberIds.length > 0 && (
            <div className="band-editor-members__missing">
              <p>現在の共通メンバーに存在しない所属情報があります。</p>
              {missingMemberIds.map((memberId) => (
                <label key={memberId}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => handleToggleMember(memberId)}
                  />
                  <span>
                    <strong>不明なメンバー</strong>
                    <small>ID: {memberId}</small>
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="band-editor-members__list">
            {displayedMembers.map((member) => (
              <label key={member.id} className="band-editor-members__option">
                <input
                  type="checkbox"
                  checked={draft.defaultMemberIds.includes(member.id)}
                  onChange={() => handleToggleMember(member.id)}
                />
                <span>
                  <strong>{member.realName}</strong>
                  <small>
                    {[member.acaName, member.active ? undefined : '非在籍']
                      .filter((value): value is string => value !== undefined)
                      .join(' / ') || 'アカペラネーム未設定'}
                  </small>
                </span>
              </label>
            ))}
            {displayedMembers.length === 0 && (
              <p className="band-editor-members__empty">
                検索条件に一致するメンバーはいません。
              </p>
            )}
          </div>
          {errors.defaultMemberIds && (
            <p id="band-editor-members-error" className="form-error" role="alert">
              {errors.defaultMemberIds}
            </p>
          )}
        </fieldset>

        <div className="band-editor-field">
          <label htmlFor="band-editor-notes">共通メモ</label>
          <textarea
            id="band-editor-notes"
            rows={4}
            value={draft.notes}
            onChange={(event) => setDraft((previous) => ({
              ...previous,
              notes: event.target.value,
            }))}
          />
        </div>

        {errors.form && (
          <p className="form-error band-editor-form__error" role="alert">
            {errors.form}
          </p>
        )}

        <footer className="band-editor-form__actions">
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
