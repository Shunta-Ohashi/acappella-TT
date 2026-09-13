import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  Band,
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  ScheduleItem,
  TimeRange,
} from '../domain/models'
import {
  canChangeEventBandDay,
  createEventOnlyBandDraft,
  createFixedBandDraft,
  getEventBandDayFeasibility,
  getEventBandDayChangeBlockReason,
  getEventBandSourceLabel,
  hasEventBandSettingsItemErrors,
  validateEventBandSettingsItem,
  type EventBandSettingsItemDraft,
  type EventBandSettingsItemErrors,
  type EventBandDayFeasibility,
} from '../domain/eventBandSettings'

interface EventBandEditorDialogProps {
  event: Event
  eventDays: EventDay[]
  bands: Band[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  scheduleItems: ScheduleItem[]
  initialEventDayId: EventDayId
  item?: EventBandSettingsItemDraft
  existingEventBand?: EventBand
  performanceSlotMinutes: number[]
  createDraftId: () => string
  onCancel: () => void
  onApply: (
    items: EventBandSettingsItemDraft[],
  ) => void
}

type AddMode = 'fixed' | 'event-only'

const participationLabels = {
  participating: '参加',
  absent: '不参加',
  undecided: '未定',
} as const

const formatEventDay = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

const matchesSearch = (values: string[], searchText: string): boolean => {
  const query = searchText.trim().toLocaleLowerCase()
  return !query || values.some((value) =>
    value.toLocaleLowerCase().includes(query),
  )
}

const formatTimeRange = (range: TimeRange): string => {
  if (range.from && range.until) return `${range.from}〜${range.until}`
  if (range.from) return `${range.from}以降`
  return `${range.until}まで`
}

const formatCommonAvailability = (
  windows: TimeRange[] | undefined,
): string => windows === undefined
  ? '終日'
  : windows.length === 0
    ? 'なし'
    : windows.map(formatTimeRange).join(' / ')

function EventBandFeasibilityFeedback({
  feasibility,
}: {
  feasibility: EventBandDayFeasibility
}) {
  return (
    <span
      className={`event-band-form__feasibility event-band-form__feasibility--${feasibility.status}`}
    >
      <b>
        {feasibility.status === 'blocked'
          ? '出演不可'
          : feasibility.status === 'warning'
            ? '注意'
            : '出演可能'}
      </b>
      {feasibility.blockingReasons.map((reason) => (
        <small key={reason}>{reason}</small>
      ))}
      {feasibility.warnings.map((warning) => (
        <small key={warning}>{warning}</small>
      ))}
      {(feasibility.commonAvailabilityWindows === undefined ||
        feasibility.commonAvailabilityWindows.length > 0) && (
        <small>
          共通時間：{formatCommonAvailability(
            feasibility.commonAvailabilityWindows,
          )}
        </small>
      )}
    </span>
  )
}

export function EventBandEditorDialog({
  event,
  eventDays,
  bands,
  members,
  eventMembers,
  eventMemberDays,
  scheduleItems,
  initialEventDayId,
  item,
  existingEventBand,
  performanceSlotMinutes,
  createDraftId,
  onCancel,
  onApply,
}: EventBandEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const draftIdRef = useRef(item?.draftId ?? createDraftId())
  const [addMode, setAddMode] = useState<AddMode>('fixed')
  const [draft, setDraft] = useState<EventBandSettingsItemDraft | undefined>(
    item,
  )
  const [selectedEventDayId, setSelectedEventDayId] = useState(
    item?.eventDayId ?? initialEventDayId,
  )
  const [selectedEventDayIds, setSelectedEventDayIds] = useState<EventDayId[]>(
    [initialEventDayId],
  )
  const [bandSearch, setBandSearch] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [unregisteredDefaultMemberIds, setUnregisteredDefaultMemberIds] =
    useState<MemberId[]>([])
  const [errors, setErrors] = useState<EventBandSettingsItemErrors>({})
  const memberById = new Map(members.map((member) => [member.id, member]))
  const selectedEventMembers = eventMembers.filter((eventMember) =>
    eventMember.eventId === event.id,
  )
  const eventMemberByMemberId = new Map(selectedEventMembers.map(
    (eventMember) => [eventMember.memberId, eventMember],
  ))
  const selectableMembers = selectedEventMembers.flatMap((eventMember) => {
    const member = memberById.get(eventMember.memberId)
    return member ? [member] : []
  })
  const filteredMembers = selectableMembers.filter((member) =>
    matchesSearch([member.realName, member.acaName ?? ''], memberSearch),
  )
  const filteredBands = bands.filter((band) =>
    matchesSearch([band.name], bandSearch),
  )
  const isEditing = Boolean(item)
  const eventDayChangeBlockReason = existingEventBand
    ? getEventBandDayChangeBlockReason(existingEventBand, scheduleItems)
    : undefined
  const mayChangeEventDay = !item?.eventBandId || (
    existingEventBand !== undefined &&
    canChangeEventBandDay(existingEventBand, scheduleItems)
  )
  const durationMinutes = Number(draft?.durationMinutes)
  const canShowFeasibility = Boolean(
    draft &&
    draft.memberIds.length > 0 &&
    Number.isSafeInteger(durationMinutes) &&
    durationMinutes > 0,
  )
  const feasibilityEventDayIds = isEditing
    ? [selectedEventDayId]
    : selectedEventDayIds
  const feasibilityByEventDayId = new Map<EventDayId, EventBandDayFeasibility>(
    feasibilityEventDayIds.map((eventDayId) => [
      eventDayId,
      getEventBandDayFeasibility({
        event,
        eventDayId,
        memberIds: draft?.memberIds ?? [],
        durationMinutes,
        members,
        eventMembers,
        eventMemberDays,
      }),
    ]),
  )
  const editingFeasibility = isEditing
    ? feasibilityByEventDayId.get(selectedEventDayId)
    : undefined
  const editingEventDay = isEditing
    ? eventDays.find((eventDay) => eventDay.id === selectedEventDayId)
    : undefined

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const clearError = (field: keyof EventBandSettingsItemErrors) => {
    setErrors((previous) => ({ ...previous, [field]: undefined, form: undefined }))
  }

  const selectFixedBand = (band: Band) => {
    const result = createFixedBandDraft({
      draftId: draftIdRef.current,
      event,
      eventDayId: selectedEventDayId,
      band,
      eventMembers,
    })
    setDraft(result.draft)
    setUnregisteredDefaultMemberIds(result.unregisteredDefaultMemberIds)
    setErrors({})
  }

  const selectAddMode = (mode: AddMode) => {
    setAddMode(mode)
    setErrors({})
    setUnregisteredDefaultMemberIds([])
    setDraft(mode === 'event-only'
      ? createEventOnlyBandDraft({
          draftId: draftIdRef.current,
          event,
          eventDayId: selectedEventDayId,
        })
      : undefined)
  }

  const updateDraft = (
    update: (current: EventBandSettingsItemDraft) => EventBandSettingsItemDraft,
  ) => {
    setDraft((current) => current ? update(current) : current)
  }

  const handleEventDayChange = (eventDayId: EventDayId) => {
    if (!mayChangeEventDay) return
    setSelectedEventDayId(eventDayId)
    updateDraft((current) => ({ ...current, eventDayId }))
    clearError('eventDayId')
  }

  const toggleEventDay = (eventDayId: EventDayId) => {
    const next = selectedEventDayIds.includes(eventDayId)
      ? selectedEventDayIds.filter((candidate) => candidate !== eventDayId)
      : eventDays
          .filter((eventDay) => (
            selectedEventDayIds.includes(eventDay.id) ||
            eventDay.id === eventDayId
          ))
          .map((eventDay) => eventDay.id)
    const nextPrimaryDayId = next[0] ?? eventDayId
    setSelectedEventDayIds(next)
    setSelectedEventDayId(nextPrimaryDayId)
    updateDraft((current) => ({
      ...current,
      eventDayId: nextPrimaryDayId,
    }))
    setErrors((previous) => ({ ...previous, form: undefined }))
  }

  const toggleMember = (memberId: MemberId) => {
    updateDraft((current) => ({
      ...current,
      memberIds: current.memberIds.includes(memberId)
        ? current.memberIds.filter((candidate) => candidate !== memberId)
        : [...current.memberIds, memberId],
    }))
    clearError('memberIds')
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    if (!draft) {
      setErrors({ form: '追加する固定バンドを選択してください。' })
      return
    }

    if (!isEditing && selectedEventDayIds.length === 0) {
      setErrors({ form: '出演日を1日以上選択してください。' })
      return
    }

    const targetEventDayIds = isEditing
      ? [draft.eventDayId]
      : selectedEventDayIds
    const validationErrors = validateEventBandSettingsItem({
      item: { ...draft, eventDayId: targetEventDayIds[0] },
      event,
      eventDays,
      members,
      bands,
      performanceSlotMinutes,
    })
    const blockingDays = targetEventDayIds.filter((eventDayId) =>
      getEventBandDayFeasibility({
        event,
        eventDayId,
        memberIds: draft.memberIds,
        durationMinutes,
        members,
        eventMembers,
        eventMemberDays,
      }).status === 'blocked'
    )
    if (blockingDays.length > 0) {
      validationErrors.form = '出演できない開催日があります。日付選択またはメンバー構成を確認してください。'
    }
    setErrors(validationErrors)
    if (hasEventBandSettingsItemErrors(validationErrors)) return
    onApply(targetEventDayIds.map((eventDayId, index) => ({
      ...draft,
      draftId: index === 0 ? draft.draftId : createDraftId(),
      eventDayId,
    })))
  }

  const getParticipationLabel = (memberId: MemberId): string => {
    const eventMember = eventMemberByMemberId.get(memberId)
    const eventMemberDay = eventMemberDays.find((day) =>
      day.eventMemberId === eventMember?.id &&
      day.eventDayId === selectedEventDayId,
    )
    return eventMemberDay
      ? participationLabels[eventMemberDay.participationStatus]
      : '日別設定なし'
  }

  return (
    <dialog
      ref={dialogRef}
      className="event-band-dialog"
      aria-modal="true"
      aria-labelledby="event-band-dialog-title"
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault()
        onCancel()
      }}
    >
      <form className="event-band-form" noValidate onSubmit={handleSubmit}>
        <header className="event-band-form__header">
          <p>出演バンド</p>
          <h2 id="event-band-dialog-title">
            {isEditing ? `${item?.name}を編集` : '出演バンドを追加'}
          </h2>
          {isEditing && item && (
            <span>{getEventBandSourceLabel(item)}</span>
          )}
        </header>

        {!isEditing && (
          <fieldset className="event-band-form__source-choice">
            <legend>バンド種別</legend>
            <label>
              <input
                type="radio"
                name="event-band-source"
                checked={addMode === 'fixed'}
                onChange={() => selectAddMode('fixed')}
              />
              固定バンド（共通データに登録されているバンド）
            </label>
            <label>
              <input
                type="radio"
                name="event-band-source"
                checked={addMode === 'event-only'}
                onChange={() => selectAddMode('event-only')}
              />
              企画バンド（このイベント内でのみ使用するバンド）
            </label>
          </fieldset>
        )}

        {!isEditing && (
          <fieldset className="event-band-form__day-choice">
            <legend>出演日 *</legend>
            <div className="event-band-form__day-list">
              {eventDays.map((eventDay) => {
                const isSelected = selectedEventDayIds.includes(eventDay.id)
                const feasibility = feasibilityByEventDayId.get(eventDay.id)
                return (
                  <label key={eventDay.id}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleEventDay(eventDay.id)}
                    />
                    <span className="event-band-form__day-content">
                      <strong>{formatEventDay(eventDay)}</strong>
                      {isSelected && canShowFeasibility && feasibility && (
                        <EventBandFeasibilityFeedback feasibility={feasibility} />
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        )}

        {!isEditing && addMode === 'fixed' && (
          <section className="event-band-form__fixed-bands">
            <label htmlFor="event-band-fixed-search">固定バンドを検索</label>
            <input
              id="event-band-fixed-search"
              type="search"
              value={bandSearch}
              placeholder="バンド名で検索"
              onChange={(changeEvent) => setBandSearch(changeEvent.target.value)}
            />
            <div className="event-band-form__fixed-list" role="group" aria-label="追加する固定バンド">
              {filteredBands.length === 0 ? (
                <p>固定バンドが見つかりません。</p>
              ) : filteredBands.map((band) => (
                <label key={band.id}>
                  <input
                    type="radio"
                    name="fixed-band"
                    checked={draft?.bandId === band.id}
                    onChange={() => selectFixedBand(band)}
                  />
                  <span>
                    <strong>{band.name}</strong>
                    <small>
                      {band.active ? '活動中' : '活動終了'}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {draft && (
          <>
            <div className="event-band-form__fields">
              <div>
                <label htmlFor="event-band-name">バンド名 *</label>
                <input
                  id="event-band-name"
                  type="text"
                  required
                  value={draft.name}
                  aria-invalid={errors.name ? 'true' : undefined}
                  onChange={(changeEvent) => {
                    updateDraft((current) => ({
                      ...current,
                      name: changeEvent.target.value,
                    }))
                    clearError('name')
                  }}
                />
                {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
              </div>
              {isEditing && (
                <div>
                  <label htmlFor="event-band-day">出演日 *</label>
                  <select
                    id="event-band-day"
                    value={draft.eventDayId}
                    disabled={!mayChangeEventDay}
                    aria-invalid={errors.eventDayId ? 'true' : undefined}
                    onChange={(changeEvent) => handleEventDayChange(changeEvent.target.value)}
                  >
                    {eventDays.map((eventDay) => (
                      <option key={eventDay.id} value={eventDay.id}>
                        {formatEventDay(eventDay)}
                      </option>
                    ))}
                  </select>
                  {!mayChangeEventDay && (
                    <p className="event-band-form__help">
                      {eventDayChangeBlockReason === 'fixed-placement'
                        ? '固定配置が設定されているため出演日を変更できません。先にStep 5の出演条件で固定配置を解除してください。'
                        : 'タイムテーブルに配置済みのため出演日を変更できません。先にStep 7でPoolへ戻してください。'}
                    </p>
                  )}
                  {errors.eventDayId && <p className="form-error" role="alert">{errors.eventDayId}</p>}
                </div>
              )}
              <div>
                <label htmlFor="event-band-duration">出演枠 *</label>
                <select
                    id="event-band-duration"
                    required
                    value={draft.durationMinutes}
                    aria-invalid={errors.durationMinutes ? 'true' : undefined}
                    onChange={(changeEvent) => {
                      updateDraft((current) => ({
                        ...current,
                        durationMinutes: changeEvent.target.value,
                      }))
                      clearError('durationMinutes')
                    }}
                  >
                  <option value="">出演枠を選択</option>
                  {performanceSlotMinutes.map((minutes) => (
                    <option key={minutes} value={minutes}>{minutes}分枠</option>
                  ))}
                </select>
                <p className="event-band-form__help">
                  必要な出演枠がない場合はStep 2で追加してください。
                </p>
                {errors.durationMinutes && (
                  <p className="form-error" role="alert">{errors.durationMinutes}</p>
                )}
              </div>
            </div>

            {isEditing && canShowFeasibility && editingFeasibility && (
              <section
                className="event-band-form__edit-feasibility"
                aria-label="出演可否"
                aria-live="polite"
              >
                <strong>
                  {editingEventDay
                    ? `${formatEventDay(editingEventDay)}の出演可否`
                    : '選択中の開催日の出演可否'}
                </strong>
                <EventBandFeasibilityFeedback feasibility={editingFeasibility} />
              </section>
            )}

            {unregisteredDefaultMemberIds.length > 0 && (
              <p className="event-band-form__notice" role="status">
                この固定バンドには、このイベントに未登録のメンバーが
                {unregisteredDefaultMemberIds.length}名います（
                {unregisteredDefaultMemberIds.map((memberId) =>
                  memberById.get(memberId)?.realName ?? '不明なメンバー'
                ).join('、')}）。必要な場合はStep 3で追加してください。
              </p>
            )}

            <section className="event-band-form__members">
              <header>
                <div>
                  <h3>出演メンバー *</h3>
                  <span>{draft.memberIds.length}人を選択中</span>
                </div>
                <label htmlFor="event-band-member-search">メンバーを検索</label>
                <input
                  id="event-band-member-search"
                  type="search"
                  value={memberSearch}
                  placeholder="本名・アカペラネームで検索"
                  onChange={(changeEvent) => setMemberSearch(changeEvent.target.value)}
                />
              </header>
              <div className="event-band-form__member-list" role="group" aria-label="出演メンバー">
                {filteredMembers.length === 0 ? (
                  <p>選択できるイベントメンバーが見つかりません。</p>
                ) : filteredMembers.map((member) => (
                  <label key={member.id}>
                    <input
                      type="checkbox"
                      checked={draft.memberIds.includes(member.id)}
                      onChange={() => toggleMember(member.id)}
                    />
                    <span>
                      <strong>{member.realName}</strong>
                      <small>
                        {member.acaName || 'アカペラネーム未登録'} / {getParticipationLabel(member.id)}
                        {!member.active ? ' / 非在籍' : ''}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              {errors.memberIds && (
                <p className="form-error" role="alert">{errors.memberIds}</p>
              )}
            </section>
          </>
        )}

        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}

        <footer className="event-band-form__actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">
            {isEditing ? '変更を適用' : '追加'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
