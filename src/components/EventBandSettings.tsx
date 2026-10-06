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
  TimetableOrderConstraint,
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
import { getDeleteConfirmationCopy } from '../ui/deleteConfirmation'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'
import { EventBandEditorDialog } from './EventBandEditorDialog'
import { createEventBandCsv, planEventBandCsvImport } from '../csv/eventBandCsv'
import { downloadCsv } from '../csv/csvBrowser'
import { CsvFileButton } from './CsvFileButton'
import { CsvImportPreviewDialog, type CsvImportPreview } from './CsvImportPreviewDialog'

interface EventBandSettingsProps {
  event: Event
  eventDays: EventDay[]
  bands: Band[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  timetableOrderConstraints: TimetableOrderConstraint[]
  createDraftId: () => string
  onSave: (draft: EventBandSettingsDraft) => EventBandSettingsUpdateResult
  onSaveAndNext: () => void
}

type EditorState =
  | { mode: 'add'; eventDayId: EventDayId }
  | { mode: 'edit'; draftId: string }

interface PendingBandDeletion {
  draftId: string
  label: string
}

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
  timetableOrderConstraints,
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
  const [pendingDeletion, setPendingDeletion] = useState<PendingBandDeletion>()
  const [csvImport, setCsvImport] = useState<{
    preview: CsvImportPreview
    candidate?: EventBandSettingsDraft
  }>()
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
    if (item.eventBandId && !canDeleteEventBand(
      item.eventBandId,
      scheduleItems,
      timetableOrderConstraints,
    )) {
      setErrors((previous) => ({
        ...previous,
        items: {
          ...previous.items,
          [item.draftId]: {
            form: 'タイムテーブルまたは出演順制約から参照されているため削除できません。関連する設定を先に解除してください。',
          },
        },
      }))
      setSaveMessage('')
      return
    }

    setPendingDeletion({
      draftId: item.draftId,
      label: item.name.trim() || '名称未入力の出演バンド',
    })
  }

  const confirmDelete = () => {
    if (!pendingDeletion) return

    setDraft((previous) => ({
      ...previous,
      items: previous.items.filter(
        (candidate) => candidate.draftId !== pendingDeletion.draftId,
      ),
    }))
    clearFeedback()
    setPendingDeletion(undefined)
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
          <div className="csv-action-buttons">
            <CsvFileButton
              onRead={(fileName, text) => {
                const plan = planEventBandCsvImport({
                  csv: text, event, eventDays, bands, members, eventMembers,
                  eventMemberDays, eventBands, draft, createDraftId,
                })
                setCsvImport(plan.ok
                  ? { candidate: plan.candidate, preview: {
                      datasetName: '出演バンド', eventName: event.name,
                      fileName, errors: [], draftOnly: true, ...plan,
                    } }
                  : { preview: {
                      datasetName: '出演バンド', eventName: event.name,
                      fileName, errors: plan.errors,
                    } })
              }}
              onError={(fileName, csvErrors) => setCsvImport({ preview: {
                datasetName: '出演バンド', eventName: event.name,
                fileName, errors: csvErrors,
              } })}
            />
            <button type="button" className="secondary-button"
              onClick={() => downloadCsv(
                createEventBandCsv({ event, eventDays, members, draft }),
                `acappella-tt-${event.id}-bands.csv`,
              )}>
              CSV書き出し
            </button>
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
        </div>
        <p className="csv-id-help">
          出演バンドIDは既存データの更新に使用します。新規追加する行では空欄にしてください。
        </p>

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
          timetableOrderConstraints={timetableOrderConstraints}
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
      {csvImport && (
        <CsvImportPreviewDialog
          preview={csvImport.preview}
          onCancel={() => setCsvImport(undefined)}
          onConfirm={csvImport.candidate ? () => {
            const candidate = csvImport.candidate as EventBandSettingsDraft
            setDraft(candidate)
            setSelectedEventDayId(candidate.items[0]?.eventDayId ?? selectedEventDayId)
            setErrors(emptyErrors())
            setSaveMessage('CSVを下書きへ取り込みました。内容を確認して保存してください。')
            setCsvImport(undefined)
          } : undefined}
        />
      )}
      {pendingDeletion && (() => {
        const copy = getDeleteConfirmationCopy(
          'event-band',
          pendingDeletion.label,
        )
        return (
          <DeleteConfirmationDialog
            {...copy}
            onCancel={() => setPendingDeletion(undefined)}
            onConfirm={confirmDelete}
          />
        )
      })()}
    </section>
  )
}
