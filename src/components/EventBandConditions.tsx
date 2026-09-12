import { useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  Section,
  Stage,
} from '../domain/models'
import {
  createEventBandConditionsDraft,
  getEventBandConditionDraftSummary,
  getEventBandConditionFeasibility,
  hasEventBandConditionsErrors,
  validateEventBandConditionsDraft,
  type EventBandConditionItemDraft,
  type EventBandConditionsDraft,
  type EventBandConditionsUpdateResult,
  type EventBandConditionsValidationErrors,
} from '../domain/eventBandConditions'
import { EventBandConditionDialog } from './EventBandConditionDialog'

interface EventBandConditionsProps {
  event: Event
  eventDays: EventDay[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  onSave: (draft: EventBandConditionsDraft) => EventBandConditionsUpdateResult
  onSaveAndNext: () => void
}

const emptyErrors = (): EventBandConditionsValidationErrors => ({ items: {} })

const formatEventDay = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function EventBandConditions({
  event,
  eventDays,
  eventBands,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
  onSave,
  onSaveAndNext,
}: EventBandConditionsProps) {
  const orderedEventDays = [...eventDays].sort((first, second) =>
    first.order - second.order ||
    first.date.localeCompare(second.date) ||
    first.id.localeCompare(second.id),
  )
  const [draft, setDraft] = useState(() =>
    createEventBandConditionsDraft(event, eventBands),
  )
  const [selectedEventDayId, setSelectedEventDayId] = useState<EventDayId | undefined>(
    orderedEventDays[0]?.id,
  )
  const [editingEventBandId, setEditingEventBandId] = useState<string>()
  const [errors, setErrors] = useState<EventBandConditionsValidationErrors>(
    emptyErrors,
  )
  const [saveMessage, setSaveMessage] = useState('')
  const eventBandById = new Map(eventBands.map((eventBand) => [
    eventBand.id,
    eventBand,
  ]))
  const selectedItems = selectedEventDayId
    ? draft.items.filter((item) => item.eventDayId === selectedEventDayId)
    : []
  const editingItem = draft.items.find((item) =>
    item.eventBandId === editingEventBandId,
  )
  const editingEventBand = editingItem
    ? eventBandById.get(editingItem.eventBandId)
    : undefined
  const errorDayIds = new Set(
    draft.items.flatMap((item) => errors.items[item.eventBandId]
      ? [item.eventDayId]
      : []),
  )

  const clearFeedback = () => {
    setErrors(emptyErrors())
    setSaveMessage('')
  }

  const presentErrors = (validationErrors: EventBandConditionsValidationErrors) => {
    setErrors(validationErrors)
    const firstInvalidItem = draft.items.find((item) =>
      validationErrors.items[item.eventBandId],
    )
    if (firstInvalidItem) setSelectedEventDayId(firstInvalidItem.eventDayId)
  }

  const save = (moveToNext: boolean) => {
    const validationErrors = validateEventBandConditionsDraft({
      draft,
      event,
      eventDays,
      eventBands,
      stages,
      sections,
      members,
      eventMembers,
      eventMemberDays,
    })
    setSaveMessage('')
    if (hasEventBandConditionsErrors(validationErrors)) {
      presentErrors(validationErrors)
      return
    }

    const result = onSave(draft)
    if (!result.ok) {
      presentErrors(result.errors)
      return
    }

    setDraft(createEventBandConditionsDraft(event, result.eventBands))
    setErrors(emptyErrors())
    if (moveToNext) onSaveAndNext()
    else setSaveMessage('✓ 保存しました')
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    save(false)
  }

  const handleApply = (updatedItem: EventBandConditionItemDraft) => {
    setDraft((previous) => ({
      items: previous.items.map((item) =>
        item.eventBandId === updatedItem.eventBandId ? updatedItem : item,
      ),
    }))
    clearFeedback()
    setEditingEventBandId(undefined)
  }

  return (
    <section className="event-band-conditions" aria-label="出演条件設定">
      <form noValidate onSubmit={handleSubmit}>
        <div className="event-band-conditions__toolbar">
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
          <p className="event-band-conditions__guide">
            必須条件は必ず守る配置条件、希望条件は可能であれば叶えたい条件です。
          </p>
        </div>

        {selectedItems.length === 0 ? (
          <div className="event-band-conditions__empty">
            <p>この開催日には出演条件を設定するバンドがありません。</p>
            <span>先にStep 4で出演バンドを登録してください。</span>
          </div>
        ) : (
          <div className="event-band-conditions__table-wrap">
            <table className="event-band-conditions__table">
              <thead>
                <tr>
                  <th scope="col">バンド名</th>
                  <th scope="col">出演枠</th>
                  <th scope="col">必須条件</th>
                  <th scope="col">希望条件</th>
                  <th scope="col">固定配置</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {selectedItems.map((item) => {
                  const eventBand = eventBandById.get(item.eventBandId)
                  if (!eventBand) return null
                  const summary = getEventBandConditionDraftSummary(
                    item,
                    eventBand,
                    stages,
                    sections,
                  )
                  const feasibility = getEventBandConditionFeasibility({
                    event,
                    item,
                    eventBand,
                    members,
                    eventMembers,
                    eventMemberDays,
                  })
                  const itemErrors = errors.items[item.eventBandId]

                  return (
                    <tr key={eventBand.id}>
                      <th scope="row">{eventBand.name}</th>
                      <td>{eventBand.durationMinutes}分</td>
                      <td>{summary.hard}</td>
                      <td>{summary.preference}</td>
                      <td>{summary.fixedPlacement}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary-button"
                          aria-label={`${eventBand.name}の出演条件を編集`}
                          onClick={() => {
                            clearFeedback()
                            setEditingEventBandId(eventBand.id)
                          }}
                        >
                          出演条件を編集
                        </button>
                        {feasibility.warnings.length > 0 && (
                          <small className="event-band-conditions__warning">
                            注意：{feasibility.warnings.join(' ')}
                          </small>
                        )}
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
        <footer className="event-band-conditions__footer">
          <span role="status">{saveMessage}</span>
          <div>
            <button type="submit" className="secondary-button">保存</button>
            <button type="button" className="primary-button" onClick={() => save(true)}>
              保存して次へ <span aria-hidden="true">→</span>
            </button>
          </div>
        </footer>
      </form>

      {editingItem && editingEventBand && (
        <EventBandConditionDialog
          key={editingEventBand.id}
          event={event}
          eventBand={editingEventBand}
          item={editingItem}
          eventDays={eventDays}
          stages={stages}
          sections={sections}
          members={members}
          eventMembers={eventMembers}
          eventMemberDays={eventMemberDays}
          eventBands={eventBands}
          onCancel={() => setEditingEventBandId(undefined)}
          onApply={handleApply}
        />
      )}
    </section>
  )
}
