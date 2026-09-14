import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  ScheduleItem,
  Stage,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import {
  getDutyAssignmentParticipationWarning,
  getDutyMemberCandidates,
  hasDutyAssignmentItemErrors,
  validateDutyAssignmentDraftItem,
  type DutyAssignmentDraftItem,
  type DutyAssignmentItemErrors,
  type DutyTypeDraftItem,
} from '../domain/dutyAssignments'

interface DutyAssignmentEditorDialogProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  paAssignments: PaAssignment[]
  scheduleItems: ScheduleItem[]
  calculatedItems: CalculatedScheduleItem[]
  dutyTypes: DutyTypeDraftItem[]
  item: DutyAssignmentDraftItem
  onCancel: () => void
  onApply: (item: DutyAssignmentDraftItem) => void
}

export function DutyAssignmentEditorDialog({
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  paAssignments,
  scheduleItems,
  calculatedItems,
  dutyTypes,
  item,
  onCancel,
  onApply,
}: DutyAssignmentEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<DutyAssignmentDraftItem>(() => ({
    ...item,
    from: { ...item.from },
    until: { ...item.until },
  }))
  const [errors, setErrors] = useState<DutyAssignmentItemErrors>({})
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
  const candidates = getDutyMemberCandidates({
    event,
    eventDayId: draft.eventDayId,
    members,
    eventMembers,
    eventMemberDays,
  })
  const candidateIds = new Set(candidates.map((candidate) => candidate.member.id))
  const participationWarning = getDutyAssignmentParticipationWarning({
    item: draft,
    event,
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

  const getItemLabel = (calculatedItem: CalculatedScheduleItem) => {
    const scheduleItem = scheduleItemById.get(calculatedItem.scheduleItemId)
    if (!scheduleItem) return '参照先不明'
    if (scheduleItem.kind === 'break') return scheduleItem.title
    return eventBandById.get(scheduleItem.eventBandId)?.name ?? '不明なバンド'
  }
  const boundaryOptions = stageCalculatedItems.flatMap((calculatedItem) => [
    {
      value: `${calculatedItem.scheduleItemId}|start`,
      label: `${getItemLabel(calculatedItem)} 開始（${formatMinuteAsLocalTime(calculatedItem.plannedStartMinute)}）`,
    },
    {
      value: `${calculatedItem.scheduleItemId}|end`,
      label: `${getItemLabel(calculatedItem)} 終了（${formatMinuteAsLocalTime(calculatedItem.plannedEndMinute)}）`,
    },
  ])

  const updateBoundary = (field: 'from' | 'until', value: string) => {
    const separatorIndex = value.lastIndexOf('|')
    setDraft((previous) => ({
      ...previous,
      [field]: {
        scheduleItemId: value.slice(0, separatorIndex),
        edge: value.slice(separatorIndex + 1) as 'start' | 'end',
      },
    }))
    setErrors({})
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    const validationErrors = validateDutyAssignmentDraftItem({
      item: draft,
      dutyTypes,
      event,
      eventDays,
      stages,
      members,
      eventMembers,
      eventMemberDays,
      eventBands,
      paAssignments,
      calculatedItems,
    })
    setErrors(validationErrors)
    if (hasDutyAssignmentItemErrors(validationErrors)) return
    onApply(draft)
  }

  return (
    <dialog
      ref={dialogRef}
      className="pa-assignment-dialog"
      aria-labelledby="duty-assignment-dialog-title"
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault()
        onCancel()
      }}
    >
      <form noValidate onSubmit={handleSubmit}>
        <header>
          <p>STEP 6</p>
          <h2 id="duty-assignment-dialog-title">一般業務担当を設定</h2>
          <span>{stage?.name ?? '不明なStage'}</span>
        </header>

        <div className="pa-assignment-dialog__fields">
          <label htmlFor="duty-assignment-type">
            仕事
            <select
              id="duty-assignment-type"
              value={draft.dutyTypeDraftId}
              aria-invalid={errors.dutyTypeId ? 'true' : undefined}
              onChange={(event) => {
                setDraft((previous) => ({
                  ...previous,
                  dutyTypeDraftId: event.target.value,
                }))
                setErrors({})
              }}
            >
              {dutyTypes.map((dutyType) => (
                <option key={dutyType.draftId} value={dutyType.draftId}>
                  {dutyType.name}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="duty-assignment-member">
            担当メンバー
            <select
              id="duty-assignment-member"
              value={draft.memberId}
              aria-invalid={errors.memberId ? 'true' : undefined}
              onChange={(event) => {
                setDraft((previous) => ({ ...previous, memberId: event.target.value }))
                setErrors({})
              }}
            >
              <option value="">選択してください</option>
              {draft.memberId && !candidateIds.has(draft.memberId) && (
                <option value={draft.memberId} disabled>現在は選択できないメンバー</option>
              )}
              {candidates.map((candidate) => (
                <option key={candidate.member.id} value={candidate.member.id}>
                  {candidate.member.realName}
                  {candidate.participationStatus === 'undecided' ? '（参加未定）' : ''}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="duty-assignment-from">
            担当開始
            <select
              id="duty-assignment-from"
              value={`${draft.from.scheduleItemId}|${draft.from.edge}`}
              aria-invalid={errors.interval ? 'true' : undefined}
              onChange={(event) => updateBoundary('from', event.target.value)}
            >
              {boundaryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label htmlFor="duty-assignment-until">
            担当終了
            <select
              id="duty-assignment-until"
              value={`${draft.until.scheduleItemId}|${draft.until.edge}`}
              aria-invalid={errors.interval ? 'true' : undefined}
              onChange={(event) => updateBoundary('until', event.target.value)}
            >
              {boundaryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

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
