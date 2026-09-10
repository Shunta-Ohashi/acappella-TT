import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Member, MemberId } from '../domain/models'

interface AddEventMembersDialogProps {
  members: Member[]
  onCancel: () => void
  onAdd: (memberIds: MemberId[]) => void
}

const matchesMemberSearch = (member: Member, searchText: string): boolean => {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase()
  if (!normalizedSearchText) return true

  return [member.realName, member.acaName ?? ''].some((value) =>
    value.toLocaleLowerCase().includes(normalizedSearchText),
  )
}

export function AddEventMembersDialog({
  members,
  onCancel,
  onAdd,
}: AddEventMembersDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [searchText, setSearchText] = useState('')
  const [selectedMemberIds, setSelectedMemberIds] = useState<MemberId[]>([])
  const filteredMembers = members.filter((member) =>
    matchesMemberSearch(member, searchText),
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const toggleMember = (memberId: MemberId) => {
    setSelectedMemberIds((previous) => previous.includes(memberId)
      ? previous.filter((candidate) => candidate !== memberId)
      : [...previous, memberId])
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (selectedMemberIds.length === 0) return
    onAdd(selectedMemberIds)
  }

  return (
    <dialog
      ref={dialogRef}
      className="add-event-members-dialog"
      aria-modal="true"
      aria-labelledby="add-event-members-title"
      aria-describedby="add-event-members-description"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form className="add-event-members-form" onSubmit={handleSubmit}>
        <header className="add-event-members-form__header">
          <p>共通データ</p>
          <h2 id="add-event-members-title">メンバーを追加</h2>
          <span id="add-event-members-description">
            今回のイベントへ追加するメンバーを選択してください。
          </span>
        </header>

        <div className="add-event-members-form__search">
          <label htmlFor="add-event-members-search">検索</label>
          <input
            id="add-event-members-search"
            type="search"
            autoFocus
            value={searchText}
            placeholder="名前・アカペラネームで検索"
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>

        <div className="add-event-members-form__list" role="group" aria-label="追加するメンバー">
          {filteredMembers.length === 0 ? (
            <p className="add-event-members-form__empty">
              追加できるメンバーが見つかりません。
            </p>
          ) : filteredMembers.map((member) => (
            <label key={member.id} className="add-event-members-form__member">
              <input
                type="checkbox"
                checked={selectedMemberIds.includes(member.id)}
                onChange={() => toggleMember(member.id)}
              />
              <span>
                <strong>{member.realName}</strong>
                <small>{member.acaName || 'アカペラネーム未登録'}</small>
              </span>
            </label>
          ))}
        </div>

        <footer className="add-event-members-form__actions">
          <span role="status">{selectedMemberIds.length}人を選択中</span>
          <div>
            <button type="button" className="secondary-button" onClick={onCancel}>
              キャンセル
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={selectedMemberIds.length === 0}
            >
              {selectedMemberIds.length}人を追加
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
