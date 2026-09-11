import { useState, type FormEvent } from 'react'
import type {
  Band,
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  ScheduleItem,
} from '../domain/models'
import {
  canDeleteEventBand,
  createEventBandSettingsDraft,
  getEventBandSourceLabel,
  hasEventBandSettingsErrors,
  validateEventBandSettingsDraft,
  type EventBandSettingsDraft,
  type EventBandSettingsItemDraft,
  type EventBandSettingsUpdateResult,
  type EventBandSettingsValidationErrors,
} from '../domain/eventBandSettings'
import { EventBandEditorDialog } from './EventBandEditorDialog'

interface EventBandSettingsProps {
  event: Event
  eventDays: EventDay[]
  bands: Band[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  createDraftId: () => string
  onSave: (draft: EventBandSettingsDraft) => EventBandSettingsUpdateResult
  onSaveAndNext: () => void
}

type EditorState =
  | { mode: 'add'; eventDayId: EventDayId }
  | { mode: 'edit'; draftId: string }

const emptyErrors = (): EventBandSettingsValidationErrors => ({ items: {} })

const formatEventDay = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function EventBandSettings({
  event,
  eventDays,
  bands,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  scheduleItems,
  createDraftId,
  onSave,
  onSaveAndNext,
}: EventBandSettingsProps) {
  const orderedEventDays = [...eventDays].sort((first, second) =>
    first.order - second.order ||
    first.date.localeCompare(second.date) ||
    first.id.localeCompare(second.id),
  )
  const [draft, setDraft] = useState(() =>
    createEventBandSettingsDraft(event, eventBands),
  )
  const [selectedEventDayId, setSelectedEventDayId] = useState<EventDayId | undefined>(
    orderedEventDays[0]?.id,
  )
  const [editor, setEditor] = useState<EditorState>()
  const [errors, setErrors] = useState<EventBandSettingsValidationErrors>(
    emptyErrors,
  )
  const [saveMessage, setSaveMessage] = useState('')
  const memberById = new Map(members.map((member) => [member.id, member]))
  const selectedItems = selectedEventDayId
    ? draft.items.filter((item) => item.eventDayId === selectedEventDayId)
    : []
  const editorItem = editor?.mode === 'edit'
    ? draft.items.find((item) => item.draftId === editor.draftId)
    : undefined
  const editorEventBand = editorItem?.eventBandId
    ? eventBands.find((eventBand) => eventBand.id === editorItem.eventBandId)
    : undefined
  const errorDayIds = new Set(
    draft.items.flatMap((item) => errors.items[item.draftId]
      ? [item.eventDayId]
      : []),
  )

  const clearFeedback = () => {
    setErrors(emptyErrors())
    setSaveMessage('')
  }

  const handleApplyItems = (items: EventBandSettingsItemDraft[]) => {
    setDraft((previous) => ({
      items: items.length === 1 && previous.items.some(
        (candidate) => candidate.draftId === items[0].draftId,
      )
        ? previous.items.map((candidate) =>
            candidate.draftId === items[0].draftId ? items[0] : candidate)
        : [...previous.items, ...items],
    }))
    setSelectedEventDayId(items[0].eventDayId)
    clearFeedback()
    setEditor(undefined)
  }

  const handleDelete = (item: EventBandSettingsItemDraft) => {
    if (item.eventBandId && !canDeleteEventBand(item.eventBandId, scheduleItems)) {
      setErrors((previous) => ({
        ...previous,
        items: {
          ...previous.items,
          [item.draftId]: {
            form: 'タイムテーブルに配置されているため削除できません。先にStep 7でPoolへ戻してください。',
          },
        },
      }))
      setSaveMessage('')
      return
    }

    setDraft((previous) => ({
      ...previous,
      items: previous.items.filter((candidate) => candidate.draftId !== item.draftId),
    }))
    clearFeedback()
  }

  const presentErrors = (validationErrors: EventBandSettingsValidationErrors) => {
    setErrors(validationErrors)
    const firstInvalidItem = draft.items.find((item) =>
      validationErrors.items[item.draftId],
    )
    if (firstInvalidItem) setSelectedEventDayId(firstInvalidItem.eventDayId)
  }

  const save = (moveToNext: boolean) => {
    const validationErrors = validateEventBandSettingsDraft({
      draft,
      event,
      eventDays,
      members,
      bands,
      eventMembers,
      eventMemberDays,
    })
    setSaveMessage('')
    if (hasEventBandSettingsErrors(validationErrors)) {
      presentErrors(validationErrors)
      return
    }

    const result = onSave(draft)
    if (!result.ok) {
      presentErrors(result.errors)
      return
    }

    setDraft(createEventBandSettingsDraft(event, result.eventBands))
    setErrors(emptyErrors())
    if (moveToNext) {
      onSaveAndNext()
    } else {
      setSaveMessage('✓ 保存しました')
    }
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    save(false)
  }

  return (
    <section className="event-band-settings" aria-label="出演バンド設定">
      <form noValidate onSubmit={handleSubmit}>
        <div className="event-band-settings__toolbar">
          <div>
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
          {selectedEventDayId && (
            <button
              type="button"
              className="primary-button"
              aria-label={`${formatEventDay(orderedEventDays.find((day) => day.id === selectedEventDayId) ?? orderedEventDays[0])}に出演バンドを追加`}
              onClick={() => {
                clearFeedback()
                setEditor({ mode: 'add', eventDayId: selectedEventDayId })
              }}
            >
              <span aria-hidden="true">＋</span> 出演バンドを追加
            </button>
          )}
        </div>

        {selectedItems.length === 0 ? (
          <div className="event-band-settings__empty">
            <p>この開催日には出演バンドがまだ登録されていません。</p>
          </div>
        ) : (
          <div className="event-band-settings__table-wrap">
            <table className="event-band-settings__table">
              <thead>
                <tr>
                  <th scope="col">バンド名</th>
                  <th scope="col">種別</th>
                  <th scope="col">メンバー</th>
                  <th scope="col">出演枠</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {selectedItems.map((item) => {
                  const itemErrors = errors.items[item.draftId]
                  return (
                    <tr key={item.draftId}>
                      <th scope="row"><strong>{item.name || '名称未入力'}</strong></th>
                      <td>{getEventBandSourceLabel(item)}</td>
                      <td>
                        <span>{item.memberIds.length}人</span>
                        <small>
                          {item.memberIds.map((memberId) =>
                            memberById.get(memberId)?.realName ?? '不明なメンバー'
                          ).join('、') || '未選択'}
                        </small>
                      </td>
                      <td>{item.durationMinutes}分</td>
                      <td>
                        <div className="event-band-settings__actions-cell">
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={`${item.name || '名称未入力の出演バンド'}を編集`}
                            onClick={() => {
                              clearFeedback()
                              setEditor({ mode: 'edit', draftId: item.draftId })
                            }}
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            className="event-band-settings__delete"
                            aria-label={`${item.name || '名称未入力の出演バンド'}を削除`}
                            onClick={() => handleDelete(item)}
                          >
                            削除
                          </button>
                        </div>
                        {itemErrors && (
                          <p className="form-error" role="alert">
                            {Object.values(itemErrors).filter(Boolean).join(' ')}
                          </p>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
        <footer className="event-band-settings__footer">
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
        <EventBandEditorDialog
          key={editor.mode === 'edit' ? editor.draftId : `new-${editor.eventDayId}`}
          event={event}
          eventDays={orderedEventDays}
          bands={bands}
          members={members}
          eventMembers={eventMembers}
          eventMemberDays={eventMemberDays}
          scheduleItems={scheduleItems}
          initialEventDayId={editor.mode === 'edit'
            ? editorItem?.eventDayId ?? orderedEventDays[0].id
            : editor.eventDayId}
          item={editorItem}
          existingEventBand={editorEventBand}
          performanceSlotMinutes={event.performanceSlotMinutes}
          createDraftId={createDraftId}
          onCancel={() => setEditor(undefined)}
          onApply={handleApplyItems}
        />
      )}
    </section>
  )
}
