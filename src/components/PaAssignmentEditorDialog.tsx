import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  PaRole,
  ScheduleItem,
  Stage,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import {
  getPaAssignmentParticipationWarning,
  getPaMemberCandidates,
  hasPaAssignmentItemErrors,
  validatePaAssignmentDraftItem,
  type PaAssignmentDraftItem,
  type PaAssignmentItemErrors,
} from '../domain/paAssignments'

interface PaAssignmentEditorDialogProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  calculatedItems: CalculatedScheduleItem[]
  item: PaAssignmentDraftItem
  onCancel: () => void
  onApply: (item: PaAssignmentDraftItem) => void
}

const roleLabel = (role: PaRole) => role === 'main' ? 'Main PA' : 'Sub PA'

export function PaAssignmentEditorDialog({
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  scheduleItems,
  calculatedItems,
  item,
  onCancel,
  onApply,
}: PaAssignmentEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<PaAssignmentDraftItem>(() => ({
    ...item,
    from: { ...item.from },
    until: { ...item.until },
  }))
  const [errors, setErrors] = useState<PaAssignmentItemErrors>({})
  const stage = stages.find((candidate) => candidate.id === draft.stageId)
  const stageCalculatedItems = calculatedItems.filter((calculatedItem) =>
    calculatedItem.eventDayId === draft.eventDayId &&
    calculatedItem.stageId === draft.stageId,
  )
  const scheduleItemById = new Map(
    scheduleItems.map((scheduleItem) => [scheduleItem.id, scheduleItem]),
  )
  const eventBandById = new Map(
    eventBands.map((eventBand) => [eventBand.id, eventBand]),
  )
  const candidates = getPaMemberCandidates({
    event,
    eventDayId: draft.eventDayId,
    role: draft.role,
    members,
    eventMembers,
    eventMemberDays,
  })
  const candidateIds = new Set(candidates.map((candidate) => candidate.member.id))
  const participationWarning = getPaAssignmentParticipationWarning({
    item: draft,
    eventMembers,
    eventMemberDays,
  })

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const clearErrors = () => setErrors({})

  const getItemLabel = (calculatedItem: CalculatedScheduleItem) => {
    const scheduleItem = scheduleItemById.get(calculatedItem.scheduleItemId)
    if (!scheduleItem) return '参照先不明'
    if (scheduleItem.kind === 'break') return scheduleItem.title
    return eventBandById.get(scheduleItem.eventBandId)?.name ?? '不明なバンド'
  }

  const boundaryOptions = stageCalculatedItems.flatMap((calculatedItem) => [
    {
      value: `${calculatedItem.scheduleItemId}|start`,
      label: `${getItemLabel(calculatedItem)} - 開始（${formatMinuteAsLocalTime(calculatedItem.plannedStartMinute)}）`,
    },
    {
      value: `${calculatedItem.scheduleItemId}|end`,
      label: `${getItemLabel(calculatedItem)} - 終了（${formatMinuteAsLocalTime(calculatedItem.plannedEndMinute)}）`,
    },
  ])

  const updateBoundary = (
    field: 'from' | 'until',
    value: string,
  ) => {
    const separatorIndex = value.lastIndexOf('|')
    const scheduleItemId = value.slice(0, separatorIndex)
    const edge = value.slice(separatorIndex + 1) as 'start' | 'end'
    setDraft((previous) => ({
      ...previous,
      [field]: { scheduleItemId, edge },
    }))
    clearErrors()
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    const validationErrors = validatePaAssignmentDraftItem({
      item: draft,
      event,
      eventDays,
      stages,
      members,
      eventMembers,
      eventMemberDays,
      eventBands,
      calculatedItems,
    })
    setErrors(validationErrors)
    if (hasPaAssignmentItemErrors(validationErrors)) return
    onApply(draft)
  }

  return (
    <dialog
      ref={dialogRef}
      className="pa-assignment-dialog"
      aria-labelledby="pa-assignment-dialog-title"
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault()
        onCancel()
      }}
    >
      <form noValidate onSubmit={handleSubmit}>
        <header>
          <p>STEP 6</p>
          <h2 id="pa-assignment-dialog-title">PA担当を設定</h2>
          <span>{stage?.name ?? '不明なStage'}</span>
        </header>

        <div className="pa-assignment-dialog__fields">
          <label htmlFor="pa-assignment-role">
            PA区分
            <select
              id="pa-assignment-role"
              value={draft.role}
              onChange={(changeEvent) => {
                const role = changeEvent.target.value as PaRole
                setDraft((previous) => ({
                  ...previous,
                  role,
                  memberId: '',
                }))
                clearErrors()
              }}
            >
              <option value="main">Main PA</option>
              <option value="sub">Sub PA</option>
            </select>
          </label>

          <label htmlFor="pa-assignment-member">
            担当メンバー
            <select
              id="pa-assignment-member"
              value={draft.memberId}
              aria-invalid={errors.memberId ? 'true' : undefined}
              onChange={(changeEvent) => {
                setDraft((previous) => ({
                  ...previous,
                  memberId: changeEvent.target.value,
                }))
                clearErrors()
              }}
            >
              <option value="">選択してください</option>
              {draft.memberId && !candidateIds.has(draft.memberId) && (
                <option value={draft.memberId} disabled>
                  現在は選択できないメンバー
                </option>
              )}
              {candidates.map((candidate) => (
                <option key={candidate.member.id} value={candidate.member.id}>
                  {candidate.member.realName}
                  {candidate.participationStatus === 'undecided' ? '（参加未定）' : ''}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="pa-assignment-from">
            担当開始
            <select
              id="pa-assignment-from"
              value={`${draft.from.scheduleItemId}|${draft.from.edge}`}
              aria-invalid={errors.interval ? 'true' : undefined}
              onChange={(changeEvent) => updateBoundary('from', changeEvent.target.value)}
            >
              {boundaryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label htmlFor="pa-assignment-until">
            担当終了
            <select
              id="pa-assignment-until"
              value={`${draft.until.scheduleItemId}|${draft.until.edge}`}
              aria-invalid={errors.interval ? 'true' : undefined}
              onChange={(changeEvent) => updateBoundary('until', changeEvent.target.value)}
            >
              {boundaryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <p className="pa-assignment-dialog__hint">
          {roleLabel(draft.role)}を担当する範囲を、タイムテーブル項目の境界で指定します。
        </p>
        {participationWarning && (
          <p className="pa-assignment-dialog__warning" role="status">
            注意：{participationWarning}
          </p>
        )}
        {Object.values(errors).filter(Boolean).map((message) => (
          <p className="form-error" role="alert" key={message}>{message}</p>
        ))}

        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">draftへ反映</button>
        </footer>
      </form>
    </dialog>
  )
}
