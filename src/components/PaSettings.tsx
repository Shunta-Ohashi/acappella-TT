import { useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
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
  createPaAssignmentDraftItem,
  createPaAssignmentsDraft,
  hasPaAssignmentsErrors,
  resolvePaAssignmentInterval,
  validatePaAssignmentsDraft,
  type PaAssignmentDraftItem,
  type PaAssignmentsDraft,
  type PaAssignmentsUpdateResult,
  type PaAssignmentsValidationErrors,
} from '../domain/paAssignments'
import { PaAssignmentEditorDialog } from './PaAssignmentEditorDialog'

interface PaSettingsProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  calculatedItems: CalculatedScheduleItem[]
  paAssignments: Parameters<typeof createPaAssignmentsDraft>[1]
  createDraftId: () => string
  onSave: (draft: PaAssignmentsDraft) => PaAssignmentsUpdateResult
  onSaveAndNext: () => void
}

interface EditorState {
  item: PaAssignmentDraftItem
  isNew: boolean
}

const emptyErrors = (): PaAssignmentsValidationErrors => ({ items: {} })
const roleLabel = (role: PaRole) => role === 'main' ? 'Main PA' : 'Sub PA'

const formatEventDay = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function PaSettings({
  event,
  eventDays,
  stages,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  scheduleItems,
  calculatedItems,
  paAssignments,
  createDraftId,
  onSave,
  onSaveAndNext,
}: PaSettingsProps) {
  const orderedEventDays = [...eventDays].sort((first, second) =>
    first.order - second.order || first.date.localeCompare(second.date),
  )
  const [draft, setDraft] = useState(() =>
    createPaAssignmentsDraft(event, paAssignments),
  )
  const [selectedEventDayId, setSelectedEventDayId] =
    useState<EventDayId | undefined>(orderedEventDays[0]?.id)
  const [editor, setEditor] = useState<EditorState>()
  const [errors, setErrors] = useState<PaAssignmentsValidationErrors>(
    emptyErrors,
  )
  const [saveMessage, setSaveMessage] = useState('')
  const memberById = new Map(members.map((member) => [member.id, member]))
  const scheduleItemById = new Map(
    scheduleItems.map((scheduleItem) => [scheduleItem.id, scheduleItem]),
  )
  const eventBandById = new Map(
    eventBands.map((eventBand) => [eventBand.id, eventBand]),
  )
  const selectedStages = stages
    .filter((stage) => stage.eventDayId === selectedEventDayId)
    .sort((first, second) => first.order - second.order)
  const errorDayIds = new Set(
    draft.items.flatMap((item) =>
      errors.items[item.draftId] ? [item.eventDayId] : [],
    ),
  )

  const getBoundaryLabel = (item: PaAssignmentDraftItem) => {
    const describe = (boundary: PaAssignmentDraftItem['from']) => {
      const scheduleItem = scheduleItemById.get(boundary.scheduleItemId)
      if (!scheduleItem) return '参照先なし'
      const name = scheduleItem.kind === 'break'
        ? scheduleItem.title
        : eventBandById.get(scheduleItem.eventBandId)?.name ?? '不明なバンド'
      return `${name} ${boundary.edge === 'start' ? '開始' : '終了'}`
    }
    return `${describe(item.from)} → ${describe(item.until)}`
  }

  const getTimeLabel = (item: PaAssignmentDraftItem) => {
    const resolution = resolvePaAssignmentInterval(item, calculatedItems)
    return resolution.ok
      ? `${formatMinuteAsLocalTime(resolution.interval.fromMinute)}〜${formatMinuteAsLocalTime(resolution.interval.untilMinute)}`
      : '参照エラー'
  }

  const openNew = (stage: Stage, role: PaRole) => {
    const item = createPaAssignmentDraftItem({
      draftId: createDraftId(),
      event,
      eventDayId: stage.eventDayId,
      stageId: stage.id,
      role,
      calculatedItems,
    })
    if (item) setEditor({ item, isNew: true })
  }

  const applyEditor = (item: PaAssignmentDraftItem) => {
    setDraft((previous) => ({
      items: editor?.isNew
        ? [...previous.items, item]
        : previous.items.map((candidate) =>
            candidate.draftId === item.draftId ? item : candidate,
          ),
    }))
    setEditor(undefined)
    setErrors(emptyErrors())
    setSaveMessage('')
  }

  const presentErrors = (validationErrors: PaAssignmentsValidationErrors) => {
    setErrors(validationErrors)
    const firstInvalid = draft.items.find((item) =>
      validationErrors.items[item.draftId],
    )
    if (firstInvalid) setSelectedEventDayId(firstInvalid.eventDayId)
  }

  const save = (moveToNext: boolean) => {
    const validationErrors = validatePaAssignmentsDraft({
      draft,
      event,
      eventDays,
      stages,
      members,
      eventMembers,
      eventMemberDays,
      eventBands,
      calculatedItems,
    })
    setSaveMessage('')
    if (hasPaAssignmentsErrors(validationErrors)) {
      presentErrors(validationErrors)
      return
    }
    const result = onSave(draft)
    if (!result.ok) {
      presentErrors(result.errors)
      return
    }
    setDraft(createPaAssignmentsDraft(event, result.paAssignments))
    setErrors(emptyErrors())
    if (moveToNext) onSaveAndNext()
    else setSaveMessage('✓ 保存しました')
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    save(false)
  }

  return (
    <section className="pa-settings" aria-label="PA設定">
      <form noValidate onSubmit={handleSubmit}>
        <div className="pa-settings__days">
          <p>開催日</p>
          <div className="event-day-tabs">
            {orderedEventDays.map((eventDay) => {
              const isSelected = eventDay.id === selectedEventDayId
              return (
                <button
                  key={eventDay.id}
                  type="button"
                  className={isSelected
                    ? 'event-day-tabs__button event-day-tabs__button--active'
                    : 'event-day-tabs__button'}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedEventDayId(eventDay.id)}
                >
                  <span>{formatEventDay(eventDay)}</span>
                  {isSelected && <small>選択中</small>}
                  {errorDayIds.has(eventDay.id) && (
                    <small className="event-day-tabs__error">エラーあり</small>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {selectedStages.length === 0 ? (
          <div className="pa-settings__empty">
            <p>この開催日にはStageがありません。</p>
            <span>先にStep 2で会場・Stageを設定してください。</span>
          </div>
        ) : selectedStages.map((stage) => {
          const stageItems = calculatedItems.filter((item) =>
            item.stageId === stage.id && item.eventDayId === stage.eventDayId,
          )
          const assignments = draft.items.filter((item) =>
            item.stageId === stage.id && item.eventDayId === stage.eventDayId,
          )
          return (
            <section className="pa-stage-card" key={stage.id}>
              <header>
                <div>
                  <p>Stage</p>
                  <h3>{stage.name}</h3>
                  {stage.location && <span>{stage.location}</span>}
                </div>
                <div className="pa-stage-card__actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={stageItems.length === 0}
                    onClick={() => openNew(stage, 'main')}
                  >
                    ＋ Main PA
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={stageItems.length === 0}
                    onClick={() => openNew(stage, 'sub')}
                  >
                    ＋ Sub PA
                  </button>
                </div>
              </header>

              {stageItems.length === 0 && (
                <p className="pa-stage-card__empty">
                  タイムテーブルに項目がないため担当範囲を設定できません。
                </p>
              )}
              {stageItems.length > 0 && assignments.length === 0 && (
                <p className="pa-stage-card__empty">PA担当はまだ設定されていません。</p>
              )}
              {assignments.length > 0 && (
                <div className="pa-settings__table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Role</th>
                        <th scope="col">Member</th>
                        <th scope="col">担当範囲</th>
                        <th scope="col">実時間</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map((item) => (
                        <tr key={item.draftId}>
                          <th scope="row">{roleLabel(item.role)}</th>
                          <td>{memberById.get(item.memberId)?.realName ?? '未設定'}</td>
                          <td>{getBoundaryLabel(item)}</td>
                          <td>{getTimeLabel(item)}</td>
                          <td>
                            <div className="pa-settings__row-actions">
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => setEditor({
                                  item: {
                                    ...item,
                                    from: { ...item.from },
                                    until: { ...item.until },
                                  },
                                  isNew: false,
                                })}
                              >
                                編集
                              </button>
                              <button
                                type="button"
                                className="danger-button"
                                aria-label={`${stage.name}の${roleLabel(item.role)}担当を削除`}
                                onClick={() => {
                                  setDraft((previous) => ({
                                    items: previous.items.filter((candidate) =>
                                      candidate.draftId !== item.draftId,
                                    ),
                                  }))
                                  setErrors(emptyErrors())
                                  setSaveMessage('')
                                }}
                              >
                                削除
                              </button>
                            </div>
                            {errors.items[item.draftId] && (
                              <p className="form-error" role="alert">
                                {Object.values(errors.items[item.draftId])
                                  .filter(Boolean)
                                  .join(' ')}
                              </p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })}

        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
        <footer className="pa-settings__footer">
          <span role="status">{saveMessage}</span>
          <div>
            <button type="submit" className="secondary-button">保存</button>
            <button type="button" className="primary-button" onClick={() => save(true)}>
              保存して次へ <span aria-hidden="true">→</span>
            </button>
          </div>
        </footer>
      </form>

      {editor && (
        <PaAssignmentEditorDialog
          event={event}
          eventDays={eventDays}
          stages={stages}
          members={members}
          eventMembers={eventMembers}
          eventMemberDays={eventMemberDays}
          eventBands={eventBands}
          scheduleItems={scheduleItems}
          calculatedItems={calculatedItems}
          item={editor.item}
          onCancel={() => setEditor(undefined)}
          onApply={applyEditor}
        />
      )}
    </section>
  )
}
