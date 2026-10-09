import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  PaRole,
  ParticipationStatus,
} from '../domain/models'
import {
  addEventMembersToDraft,
  canDeleteEventMember,
  createEventMemberSettingsDraft,
  EVENT_MEMBER_DELETE_BLOCKED_MESSAGE,
  getEventBandCountByMember,
  getEventMemberDayDraftErrorKey,
  getFirstEventMemberDayErrorTarget,
  hasEventMemberSettingsErrors,
  validateEventMemberSettingsDraft,
  type EventMemberSettingsDraft,
  type EventMemberSettingsUpdateResult,
  type EventMemberSettingsValidationErrors,
} from '../domain/eventMemberSettings'
import { getEventMemberDayConditionSummary } from '../domain/eventMemberDayDetails'
import { getDeleteConfirmationCopy } from '../ui/deleteConfirmation'
import { AddEventMembersDialog } from './AddEventMembersDialog'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'
import { EventMemberDayDetailsDialog } from './EventMemberDayDetailsDialog'
import { createEventMemberCsv, planEventMemberCsvImport } from '../csv/eventMemberCsv'
import { downloadCsv } from '../csv/csvBrowser'
import { CsvFileButton } from './CsvFileButton'
import { CsvImportPreviewDialog, type CsvImportPreview } from './CsvImportPreviewDialog'
import { EVENT_MEMBER_CSV_HELP } from '../csv/csvHelp'
import { CsvImportHelpPopover } from './CsvImportHelpPopover'
import {
  hasSemanticDraftChanges,
  type EventEditorDraftHandle,
} from '../ui/eventEditorDraftGuard'

interface EventMemberSettingsProps {
  event: Event
  eventDays: EventDay[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  createDraftId: () => string
  onSave: (draft: EventMemberSettingsDraft) => EventMemberSettingsUpdateResult
  onSaveAndNext: () => void
  readOnly?: boolean
}

const participationStatusOptions: Array<{
  value: ParticipationStatus
  label: string
}> = [
  { value: 'participating', label: '参加' },
  { value: 'absent', label: '不参加' },
  { value: 'undecided', label: '未定' },
]

const emptyErrors = (): EventMemberSettingsValidationErrors => ({
  members: {},
  days: {},
})

interface MemberDetailsEditorState {
  memberDraftId: string
  initialEventDayId: EventDayId
}

interface PendingMemberDeletion {
  memberId: MemberId
  draftId: string
  label: string
}

const formatEventDay = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}/${Number(day)}`
}

const matchesMemberSearch = (member: Member, searchText: string): boolean => {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase()
  if (!normalizedSearchText) return true

  return [member.realName, member.acaName ?? ''].some((value) =>
    value.toLocaleLowerCase().includes(normalizedSearchText),
  )
}

export type EventMemberSettingsHandle = EventEditorDraftHandle

export const EventMemberSettings = forwardRef<
EventMemberSettingsHandle,
EventMemberSettingsProps
>(function EventMemberSettings({
  event,
  eventDays,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  createDraftId,
  onSave,
  onSaveAndNext,
  readOnly = false,
}: EventMemberSettingsProps, ref) {
  const initialDraft = createEventMemberSettingsDraft(
    event,
    eventDays,
    eventMembers,
    eventMemberDays,
  )
  const [draft, setDraft] = useState(initialDraft)
  const [savedDraft, setSavedDraft] = useState(initialDraft)
  const [searchText, setSearchText] = useState('')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [detailsEditor, setDetailsEditor] =
    useState<MemberDetailsEditorState>()
  const [errors, setErrors] = useState<EventMemberSettingsValidationErrors>(
    emptyErrors,
  )
  const [saveMessage, setSaveMessage] = useState('')
  const [pendingDeletion, setPendingDeletion] = useState<PendingMemberDeletion>()
  const [csvImport, setCsvImport] = useState<{
    preview: CsvImportPreview
    candidate?: EventMemberSettingsDraft
  }>()
  const addMembersDialogRef = useRef<EventEditorDraftHandle>(null)
  const memberDetailsDialogRef = useRef<EventEditorDraftHandle>(null)
  const memberById = new Map(members.map((member) => [member.id, member]))
  const orderedEventDays = eventDays
    .filter((eventDay) => eventDay.eventId === event.id)
    .sort((first, second) =>
      first.order - second.order ||
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
    )
  const eventBandCountByMember = getEventBandCountByMember(
    event.id,
    eventBands,
  )
  const displayedMemberDrafts = draft.members.filter((memberDraft) => {
    const member = memberById.get(memberDraft.memberId)
    return member ? matchesMemberSearch(member, searchText) : true
  })
  const savedEventMemberIds = new Set(
    eventMembers
      .filter((eventMember) => eventMember.eventId === event.id)
      .map((eventMember) => eventMember.memberId),
  )
  const draftMemberIds = new Set(
    draft.members.map((memberDraft) => memberDraft.memberId),
  )
  const addableMembers = members.filter(
    (member) =>
      !savedEventMemberIds.has(member.id) && !draftMemberIds.has(member.id),
  )
  const detailsMemberDraft = detailsEditor
    ? draft.members.find(
        (memberDraft) => memberDraft.draftId === detailsEditor.memberDraftId,
      )
    : undefined
  const detailsMember = detailsMemberDraft
    ? memberById.get(detailsMemberDraft.memberId)
    : undefined

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => hasSemanticDraftChanges(draft, savedDraft) ||
      Boolean(addMembersDialogRef.current?.hasUnsavedChanges()) ||
      Boolean(memberDetailsDialogRef.current?.hasUnsavedChanges()) ||
      Boolean(csvImport?.candidate),
    reportUnsavedChanges: () => {
      setErrors((previous) => ({
        ...previous,
        form: 'イベントメンバーに未保存の変更があります。先にこの画面を保存してください。',
      }))
      setSaveMessage('')
    },
  }), [csvImport?.candidate, draft, savedDraft])

  const clearFeedback = () => {
    setSaveMessage('')
    setErrors((previous) => ({ ...previous, form: undefined }))
  }

  const presentValidationErrors = (
    validationErrors: EventMemberSettingsValidationErrors,
  ) => {
    const target = getFirstEventMemberDayErrorTarget(
      validationErrors,
      draft,
      orderedEventDays,
    )
    if (!target) {
      setErrors(validationErrors)
      return
    }

    const memberDraft = draft.members.find(
      (candidate) => candidate.draftId === target.memberDraftId,
    )
    const member = memberDraft
      ? memberById.get(memberDraft.memberId)
      : undefined
    const eventDay = orderedEventDays.find(
      (candidate) => candidate.id === target.eventDayId,
    )
    setErrors({
      ...validationErrors,
      form: `${member?.realName ?? '不明なメンバー'} / ${
        eventDay ? formatEventDay(eventDay) : '不明な開催日'
      }：${target.message}`,
    })

    if (memberDraft?.days.some(
      (day) => day.eventDayId === target.eventDayId,
    )) {
      setDetailsEditor({
        memberDraftId: target.memberDraftId,
        initialEventDayId: target.eventDayId,
      })
    }
  }

  const updateParticipationStatus = (
    memberDraftId: string,
    eventDayId: EventDayId,
    participationStatus: ParticipationStatus,
  ) => {
    setDraft((previous) => ({
      members: previous.members.map((memberDraft) =>
        memberDraft.draftId === memberDraftId
          ? {
              ...memberDraft,
              days: memberDraft.days.map((dayDraft) =>
                dayDraft.eventDayId === eventDayId
                  ? { ...dayDraft, participationStatus }
                  : dayDraft,
              ),
            }
          : memberDraft,
      ),
    }))
    const errorKey = getEventMemberDayDraftErrorKey(
      memberDraftId,
      eventDayId,
    )
    setErrors((previous) => {
      const nextDayErrors = { ...previous.days }
      delete nextDayErrors[errorKey]
      return { ...previous, days: nextDayErrors, form: undefined }
    })
    setSaveMessage('')
  }

  const updatePaCapability = (
    memberDraftId: string,
    role: PaRole,
    enabled: boolean,
  ) => {
    setDraft((previous) => ({
      members: previous.members.map((memberDraft) =>
        memberDraft.draftId === memberDraftId
          ? {
              ...memberDraft,
              paCapabilities: { ...memberDraft.paCapabilities, [role]: enabled },
            }
          : memberDraft,
      ),
    }))
    clearFeedback()
  }

  const setAllParticipationStatuses = (
    eventDayId: EventDayId,
    participationStatus: ParticipationStatus,
  ) => {
    setDraft((previous) => ({
      members: previous.members.map((memberDraft) => ({
        ...memberDraft,
        days: memberDraft.days.map((dayDraft) =>
          dayDraft.eventDayId === eventDayId
            ? { ...dayDraft, participationStatus }
            : dayDraft,
        ),
      })),
    }))
    setErrors(emptyErrors())
    setSaveMessage('')
  }

  const handleAddMembers = (memberIds: MemberId[]) => {
    setDraft((previous) => addEventMembersToDraft({
      draft: previous,
      event,
      eventDays: orderedEventDays,
      memberIds,
      newDraftIds: memberIds.map(() => createDraftId()),
    }))
    setIsAddDialogOpen(false)
    setErrors(emptyErrors())
    setSaveMessage('')
  }

  const handleRemoveMember = (
    memberId: MemberId,
    draftId: string,
    label: string,
  ) => {
    if (!canDeleteEventMember(memberId, event.id, eventBands)) {
      setErrors((previous) => ({
        ...previous,
        form: EVENT_MEMBER_DELETE_BLOCKED_MESSAGE,
      }))
      setSaveMessage('')
      return
    }

    setPendingDeletion({ memberId, draftId, label })
  }

  const confirmRemoveMember = () => {
    if (!pendingDeletion) return

    setDraft((previous) => ({
      members: previous.members.filter(
        (memberDraft) => memberDraft.draftId !== pendingDeletion.draftId,
      ),
    }))
    setErrors(emptyErrors())
    setSaveMessage('')
    setPendingDeletion(undefined)
  }

  const handleApplyMemberDayDetails = (
    memberDraftId: string,
    days: EventMemberSettingsDraft['members'][number]['days'],
  ) => {
    setDraft((previous) => ({
      members: previous.members.map((memberDraft) =>
        memberDraft.draftId === memberDraftId
          ? { ...memberDraft, days }
          : memberDraft,
      ),
    }))
    setErrors((previous) => {
      const nextDayErrors = { ...previous.days }
      Object.keys(nextDayErrors).forEach((errorKey) => {
        if (errorKey.startsWith(`${memberDraftId}:`)) {
          delete nextDayErrors[errorKey]
        }
      })
      return { ...previous, days: nextDayErrors, form: undefined }
    })
    setSaveMessage('')
    setDetailsEditor(undefined)
  }

  const save = (moveToNext: boolean) => {
    const validationErrors = validateEventMemberSettingsDraft({
      event,
      eventDays: orderedEventDays,
      members,
      eventMembers,
      eventMemberDays,
      draft,
    })
    setSaveMessage('')
    if (hasEventMemberSettingsErrors(validationErrors)) {
      presentValidationErrors(validationErrors)
      return
    }

    const result = onSave(draft)
    if (!result.ok) {
      presentValidationErrors(result.errors)
      return
    }

    const normalizedSavedDraft = createEventMemberSettingsDraft(
      event,
      orderedEventDays,
      result.eventMembers,
      result.eventMemberDays,
    )
    setDraft(normalizedSavedDraft)
    setSavedDraft(normalizedSavedDraft)
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
    <section className="event-member-settings" aria-label="イベントメンバー設定フォーム">
      <form noValidate onSubmit={handleSubmit}>
        <div className="event-member-settings__toolbar">
          <div className="event-member-settings__search">
            <label htmlFor="event-member-search">検索</label>
            <input
              id="event-member-search"
              type="search"
              value={searchText}
              placeholder="名前・アカペラネームで検索"
              onChange={(event) => setSearchText(event.target.value)}
            />
          </div>
          <div className="csv-action-buttons">
            {!readOnly && (
              <div className="csv-import-control">
                <CsvFileButton
                  onRead={(fileName, text) => {
                    const plan = planEventMemberCsvImport({
                      csv: text, event, eventDays, members, eventMembers, eventMemberDays,
                      draft, createDraftId,
                    })
                    setCsvImport(plan.ok
                      ? { candidate: plan.candidate, preview: {
                          datasetName: 'イベントメンバー', eventName: event.name,
                          fileName, errors: [], draftOnly: true, ...plan,
                        } }
                      : { preview: {
                          datasetName: 'イベントメンバー', eventName: event.name,
                          fileName, errors: plan.errors,
                        } })
                  }}
                  onError={(fileName, csvErrors) => setCsvImport({ preview: {
                    datasetName: 'イベントメンバー', eventName: event.name,
                    fileName, errors: csvErrors,
                  } })}
                />
                <CsvImportHelpPopover content={EVENT_MEMBER_CSV_HELP} />
              </div>
            )}
            <button type="button" className="secondary-button"
              onClick={() => downloadCsv(
                createEventMemberCsv({ event, eventDays, members, draft }),
                `acappella-tt-${event.id}-members.csv`,
              )}>
              CSV書き出し
            </button>
            {!readOnly && (
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  clearFeedback()
                  setIsAddDialogOpen(true)
                }}
              >
                <span aria-hidden="true">＋</span> メンバーを追加
              </button>
            )}
          </div>
        </div>
        <p className="csv-id-help">
          ID列は既存データの特定に使用します。CSV取り込み後は内容を確認して保存してください。
        </p>

        <fieldset className="read-only-form-controls" disabled={readOnly}>
        <div className="event-member-settings__table-card">
          <div className="event-member-settings__table-scroll">
            <table className="event-member-settings__table">
              <thead>
                <tr>
                  <th scope="col">名前</th>
                  <th scope="col">アカペラネーム</th>
                  <th scope="col">出演予定</th>
                  <th scope="col">Main PA</th>
                  <th scope="col">Sub PA</th>
                  {orderedEventDays.map((eventDay) => (
                    <th key={eventDay.id} scope="col">
                      {formatEventDay(eventDay)}
                    </th>
                  ))}
                  <th scope="col"><span className="visually-hidden">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {displayedMemberDrafts.map((memberDraft) => {
                  const member = memberById.get(memberDraft.memberId)
                  const memberName = member?.realName ?? '不明なメンバー'
                  const memberError = errors.members[memberDraft.draftId]

                  return (
                    <tr key={memberDraft.draftId}>
                      <th scope="row">
                        {memberName}
                        {memberError && (
                          <span className="event-member-settings__cell-error" role="alert">
                            {memberError}
                          </span>
                        )}
                      </th>
                      <td>{member?.acaName || '—'}</td>
                      <td>
                        <strong>{eventBandCountByMember.get(memberDraft.memberId) ?? 0}</strong>枠
                      </td>
                      {(['main', 'sub'] as const).map((role) => (
                        <td key={role}>
                          <input
                            type="checkbox"
                            aria-label={`${memberName}（${memberDraft.memberId}）を${role === 'main' ? 'Main' : 'Sub'} PA担当可にする`}
                            checked={memberDraft.paCapabilities[role]}
                            onChange={(event) => updatePaCapability(
                              memberDraft.draftId,
                              role,
                              event.target.checked,
                            )}
                          />
                        </td>
                      ))}
                      {orderedEventDays.map((eventDay) => {
                        const dayDraft = memberDraft.days.find(
                          (candidate) => candidate.eventDayId === eventDay.id,
                        )
                        const errorKey = getEventMemberDayDraftErrorKey(
                          memberDraft.draftId,
                          eventDay.id,
                        )
                        const dayError = errors.days[errorKey]
                        const conditionSummary = dayDraft
                          ? getEventMemberDayConditionSummary(dayDraft)
                          : undefined

                        return (
                          <td key={eventDay.id}>
                            {dayDraft ? (
                              <>
                                <select
                                  aria-label={`${memberName}の${formatEventDay(eventDay)}の参加状況`}
                                  aria-invalid={dayError ? 'true' : undefined}
                                  value={dayDraft.participationStatus}
                                  onChange={(changeEvent) =>
                                    updateParticipationStatus(
                                      memberDraft.draftId,
                                      eventDay.id,
                                      changeEvent.target.value as ParticipationStatus,
                                    )}
                                >
                                  {participationStatusOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                {conditionSummary && (
                                  <div className="event-member-settings__day-summary">
                                    <span>
                                      {dayDraft.participationStatus === 'absent'
                                        ? '時間条件は不使用'
                                        : conditionSummary.availabilityLabel}
                                    </span>
                                    {conditionSummary.hasDetails && (
                                      <strong>条件あり</strong>
                                    )}
                                    {conditionSummary.supplementaryLabel && (
                                      <small>{conditionSummary.supplementaryLabel}</small>
                                    )}
                                  </div>
                                )}
                                {dayError && (
                                  <span className="event-member-settings__cell-error" role="alert">
                                    {dayError}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="event-member-settings__cell-error" role="alert">
                                参加状況がありません
                              </span>
                            )}
                          </td>
                        )
                      })}
                      <td>
                        <div className="event-member-settings__row-actions">
                          <button
                            type="button"
                            className="event-member-settings__details"
                            disabled={memberDraft.days.length === 0 || !member}
                            aria-label={`${memberName}の日別詳細を設定`}
                            onClick={() => {
                              clearFeedback()
                              setDetailsEditor({
                                memberDraftId: memberDraft.draftId,
                                initialEventDayId: memberDraft.days[0].eventDayId,
                              })
                            }}
                          >
                            詳細設定
                          </button>
                          <button
                            type="button"
                            className="event-member-settings__delete"
                            aria-label={`${memberName}をイベントから削除`}
                            onClick={() => handleRemoveMember(
                              memberDraft.memberId,
                              memberDraft.draftId,
                              memberName,
                            )}
                          >
                            削除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {displayedMemberDrafts.length === 0 && (
            <div className="event-member-settings__empty">
              {draft.members.length === 0
                ? 'イベントにメンバーが追加されていません。'
                : '検索条件に一致するメンバーはいません。'}
            </div>
          )}
        </div>

        <div className="event-member-settings__bulk-list">
          {orderedEventDays.map((eventDay) => (
            <section key={eventDay.id} className="event-member-settings__bulk-card">
              <h3>{formatEventDay(eventDay)}</h3>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={draft.members.length === 0}
                  onClick={() => setAllParticipationStatuses(
                    eventDay.id,
                    'participating',
                  )}
                >
                  全員を参加にする
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={draft.members.length === 0}
                  onClick={() => setAllParticipationStatuses(
                    eventDay.id,
                    'undecided',
                  )}
                >
                  全員を未定にする
                </button>
              </div>
            </section>
          ))}
        </div>

        {errors.form && (
          <p className="form-error event-member-settings__form-error" role="alert">
            {errors.form}
          </p>
        )}

        <footer className="event-member-settings__actions">
          <span className="event-member-settings__save-status" role="status">
            {saveMessage}
          </span>
          <div>
            <button type="submit" className="secondary-button">保存</button>
            <button
              type="button"
              className="primary-button"
              onClick={() => save(true)}
            >
              保存して次へ <span aria-hidden="true">→</span>
            </button>
          </div>
        </footer>
        </fieldset>
      </form>

      {!readOnly && isAddDialogOpen && (
        <AddEventMembersDialog
          ref={addMembersDialogRef}
          members={addableMembers}
          onCancel={() => setIsAddDialogOpen(false)}
          onAdd={handleAddMembers}
        />
      )}
      {!readOnly && detailsEditor && detailsMemberDraft && detailsMember && (
        <EventMemberDayDetailsDialog
          ref={memberDetailsDialogRef}
          key={`${detailsEditor.memberDraftId}:${detailsEditor.initialEventDayId}`}
          member={detailsMember}
          memberDraft={detailsMemberDraft}
          eventDays={orderedEventDays}
          initialEventDayId={detailsEditor.initialEventDayId}
          dayErrors={Object.fromEntries(orderedEventDays.map((eventDay) => [
            eventDay.id,
            errors.days[getEventMemberDayDraftErrorKey(
              detailsMemberDraft.draftId,
              eventDay.id,
            )],
          ]))}
          onCancel={() => setDetailsEditor(undefined)}
          onApply={(days) => handleApplyMemberDayDetails(
            detailsMemberDraft.draftId,
            days,
          )}
        />
      )}
      {!readOnly && csvImport && (
        <CsvImportPreviewDialog
          preview={csvImport.preview}
          onCancel={() => setCsvImport(undefined)}
          onConfirm={csvImport.candidate ? () => {
            setDraft(csvImport.candidate as EventMemberSettingsDraft)
            setErrors(emptyErrors())
            setSaveMessage('CSVを下書きへ取り込みました。内容を確認して保存してください。')
            setCsvImport(undefined)
          } : undefined}
        />
      )}
      {!readOnly && pendingDeletion && (() => {
        const copy = getDeleteConfirmationCopy(
          'event-member',
          pendingDeletion.label,
        )
        return (
          <DeleteConfirmationDialog
            {...copy}
            onCancel={() => setPendingDeletion(undefined)}
            onConfirm={confirmRemoveMember}
          />
        )
      })()}
    </section>
  )
})
