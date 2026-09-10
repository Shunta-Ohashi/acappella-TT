import { useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
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
import { AddEventMembersDialog } from './AddEventMembersDialog'
import { EventMemberDayDetailsDialog } from './EventMemberDayDetailsDialog'

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

export function EventMemberSettings({
  event,
  eventDays,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  createDraftId,
  onSave,
  onSaveAndNext,
}: EventMemberSettingsProps) {
  const [draft, setDraft] = useState(() => createEventMemberSettingsDraft(
    event,
    eventDays,
    eventMembers,
    eventMemberDays,
  ))
  const [searchText, setSearchText] = useState('')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [detailsEditor, setDetailsEditor] =
    useState<MemberDetailsEditorState>()
  const [errors, setErrors] = useState<EventMemberSettingsValidationErrors>(
    emptyErrors,
  )
  const [saveMessage, setSaveMessage] = useState('')
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

  const handleRemoveMember = (memberId: MemberId, draftId: string) => {
    if (!canDeleteEventMember(memberId, event.id, eventBands)) {
      setErrors((previous) => ({
        ...previous,
        form: EVENT_MEMBER_DELETE_BLOCKED_MESSAGE,
      }))
      setSaveMessage('')
      return
    }

    setDraft((previous) => ({
      members: previous.members.filter(
        (memberDraft) => memberDraft.draftId !== draftId,
      ),
    }))
    setErrors(emptyErrors())
    setSaveMessage('')
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

    setDraft(createEventMemberSettingsDraft(
      event,
      orderedEventDays,
      result.eventMembers,
      result.eventMemberDays,
    ))
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
        </div>

        <div className="event-member-settings__table-card">
          <div className="event-member-settings__table-scroll">
            <table className="event-member-settings__table">
              <thead>
                <tr>
                  <th scope="col">名前</th>
                  <th scope="col">アカペラネーム</th>
                  <th scope="col">出演予定</th>
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
      </form>

      {isAddDialogOpen && (
        <AddEventMembersDialog
          members={addableMembers}
          onCancel={() => setIsAddDialogOpen(false)}
          onAdd={handleAddMembers}
        />
      )}
      {detailsEditor && detailsMemberDraft && detailsMember && (
        <EventMemberDayDetailsDialog
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
    </section>
  )
}
