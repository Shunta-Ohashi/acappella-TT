import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  Event,
  EventBand,
  EventMember,
  EventMemberDay,
  Member,
  Section,
  Stage,
  TimeRange,
} from '../domain/models'
import {
  formatConditionTimeRange,
  getEventBandConditionFeasibility,
  hasEventBandConditionItemErrors,
  validateEventBandConditionItem,
  type EventBandConditionItemDraft,
  type EventBandConditionItemErrors,
  type FixedPositionMode,
} from '../domain/eventBandConditions'
import { getEventBandDayFeasibility } from '../domain/eventBandSettings'

interface EventBandConditionDialogProps {
  event: Event
  eventBand: EventBand
  item: EventBandConditionItemDraft
  eventDays: Parameters<typeof validateEventBandConditionItem>[0]['eventDays']
  stages: Stage[]
  sections: Section[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  onCancel: () => void
  onApply: (item: EventBandConditionItemDraft) => void
}

const formatAvailabilityWindows = (
  windows: TimeRange[] | undefined,
  emptyLabel = '出演可能な共通時間がありません',
): string => windows === undefined
  ? '終日'
  : windows.length === 0
    ? emptyLabel
    : windows.map((window) => formatConditionTimeRange(window)).join(' / ')

export function EventBandConditionDialog({
  event,
  eventBand,
  item,
  eventDays,
  stages,
  sections,
  members,
  eventMembers,
  eventMemberDays,
  eventBands,
  onCancel,
  onApply,
}: EventBandConditionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<EventBandConditionItemDraft>(() => ({
    ...item,
    availableTimeRange: { ...item.availableTimeRange },
    preferredTimeRange: { ...item.preferredTimeRange },
    fixedPlacement: { ...item.fixedPlacement },
  }))
  const [errors, setErrors] = useState<EventBandConditionItemErrors>({})
  const availableStages = stages.filter((stage) =>
    stage.eventDayId === eventBand.eventDayId,
  )
  const selectedStage = availableStages.find((stage) =>
    stage.id === draft.fixedPlacement.stageId,
  )
  const availableSections = selectedStage
    ? sections.filter((section) => section.stageId === selectedStage.id)
    : []
  const previewErrors = validateEventBandConditionItem({
    item: draft,
    event,
    eventDays,
    eventBands,
    stages,
    sections,
    members,
    eventMembers,
    eventMemberDays,
  })
  const memberFeasibility = getEventBandDayFeasibility({
    event,
    eventDayId: eventBand.eventDayId,
    memberIds: eventBand.memberIds,
    durationMinutes: eventBand.durationMinutes,
    members,
    eventMembers,
    eventMemberDays,
  })
  const feasibility = !previewErrors.availableTimeRange &&
    !previewErrors.preferredTimeRange
    ? getEventBandConditionFeasibility({
        event,
        item: draft,
        eventBand,
        members,
        eventMembers,
        eventMemberDays,
      })
    : undefined

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const clearError = (field: keyof EventBandConditionItemErrors) => {
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  const updateRange = (
    field: 'availableTimeRange' | 'preferredTimeRange',
    boundary: 'from' | 'until',
    value: string,
  ) => {
    setDraft((previous) => ({
      ...previous,
      [field]: { ...previous[field], [boundary]: value },
    }))
    clearError(field)
  }

  const handleStageChange = (stageId: string) => {
    setDraft((previous) => ({
      ...previous,
      fixedPlacement: stageId
        ? {
            ...previous.fixedPlacement,
            stageId,
            sectionId: '',
          }
        : {
            stageId: '',
            sectionId: '',
            positionMode: 'none',
            plannedStartTime: '',
          },
    }))
    clearError('fixedPlacement')
  }

  const handlePositionChange = (positionMode: FixedPositionMode) => {
    setDraft((previous) => ({
      ...previous,
      fixedPlacement: {
        ...previous.fixedPlacement,
        positionMode,
        ...(positionMode === 'index' && previous.fixedPlacement.positionIndex !== undefined
          ? { positionIndex: previous.fixedPlacement.positionIndex }
          : {}),
      },
    }))
    clearError('fixedPlacement')
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    const validationErrors = validateEventBandConditionItem({
      item: draft,
      event,
      eventDays,
      eventBands,
      stages,
      sections,
      members,
      eventMembers,
      eventMemberDays,
    })
    setErrors(validationErrors)
    if (hasEventBandConditionItemErrors(validationErrors)) return
    onApply(draft)
  }

  return (
    <dialog
      ref={dialogRef}
      className="event-band-condition-dialog"
      aria-labelledby="event-band-condition-title"
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault()
        onCancel()
      }}
    >
      <form className="event-band-condition-form" noValidate onSubmit={handleSubmit}>
        <header>
          <p>STEP 5</p>
          <h2 id="event-band-condition-title">出演条件を編集</h2>
          <strong>{eventBand.name}</strong>
          <span>{eventBand.durationMinutes}分枠</span>
        </header>

        <fieldset className="event-band-condition-form__group">
          <legend>必須条件</legend>
          <p>タイムテーブル配置時に必ず守る条件です。</p>

          <section className="event-band-condition-form__availability-card">
            <span>メンバーから決まる出演可能時間</span>
            <strong>
              {formatAvailabilityWindows(
                memberFeasibility.commonAvailabilityWindows,
              )}
            </strong>
            <p>
              Step 3で設定された各メンバーの参加可能時間から自動計算されます。
            </p>
            {memberFeasibility.blockingReasons.map((reason) => (
              <small className="is-blocked" key={reason}>{reason}</small>
            ))}
            {memberFeasibility.warnings.map((warning) => (
              <small className="has-warning" key={warning}>{warning}</small>
            ))}
          </section>

          <div className="event-band-condition-form__range">
            <span>必須条件としてさらに制限</span>
            <label htmlFor="event-band-available-from">
              開始
              <input
                id="event-band-available-from"
                type="time"
                value={draft.availableTimeRange.from}
                aria-invalid={errors.availableTimeRange ? 'true' : undefined}
                onChange={(changeEvent) => updateRange(
                  'availableTimeRange',
                  'from',
                  changeEvent.target.value,
                )}
              />
            </label>
            <label htmlFor="event-band-available-until">
              終了
              <input
                id="event-band-available-until"
                type="time"
                value={draft.availableTimeRange.until}
                aria-invalid={errors.availableTimeRange ? 'true' : undefined}
                onChange={(changeEvent) => updateRange(
                  'availableTimeRange',
                  'until',
                  changeEvent.target.value,
                )}
              />
            </label>
          </div>
          {errors.availableTimeRange && (
            <p className="form-error" role="alert">{errors.availableTimeRange}</p>
          )}

          <section
            className="event-band-condition-form__availability-card"
            aria-live="polite"
          >
            <span>実際に配置可能な時間</span>
            <strong>
              {feasibility
                ? formatAvailabilityWindows(
                    feasibility.effectiveAvailabilityWindows,
                    '配置可能な時間がありません',
                  )
                : '入力した時刻を確認してください'}
            </strong>
            <p>
              メンバーの共通時間を、上のバンド条件でさらに絞った結果です。
            </p>
          </section>

          <div className="event-band-condition-form__placement-grid">
            <div>
              <label htmlFor="event-band-fixed-stage">固定Stage</label>
              <select
                id="event-band-fixed-stage"
                value={draft.fixedPlacement.stageId}
                aria-invalid={errors.fixedPlacement ? 'true' : undefined}
                onChange={(changeEvent) => handleStageChange(changeEvent.target.value)}
              >
                <option value="">未指定</option>
                {availableStages.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="event-band-fixed-section">固定Section</label>
              <select
                id="event-band-fixed-section"
                value={draft.fixedPlacement.sectionId}
                disabled={!selectedStage || availableSections.length === 0}
                aria-invalid={errors.fixedPlacement ? 'true' : undefined}
                onChange={(changeEvent) => {
                  setDraft((previous) => ({
                    ...previous,
                    fixedPlacement: {
                      ...previous.fixedPlacement,
                      sectionId: changeEvent.target.value,
                    },
                  }))
                  clearError('fixedPlacement')
                }}
              >
                <option value="">
                  {selectedStage && availableSections.length === 0
                    ? 'Sectionなし'
                    : '未指定'}
                </option>
                {availableSections.map((section) => (
                  <option key={section.id} value={section.id}>{section.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="event-band-fixed-position">出演位置</label>
              <select
                id="event-band-fixed-position"
                value={draft.fixedPlacement.positionMode}
                disabled={!selectedStage}
                aria-invalid={errors.fixedPlacement ? 'true' : undefined}
                onChange={(changeEvent) => handlePositionChange(
                  changeEvent.target.value as FixedPositionMode,
                )}
              >
                <option value="none">指定なし</option>
                <option value="first">最初</option>
                <option value="last">最後</option>
                {draft.fixedPlacement.positionMode === 'index' && (
                  <option value="index">
                    既存の{(draft.fixedPlacement.positionIndex ?? 0) + 1}番目固定
                  </option>
                )}
              </select>
            </div>

            <div>
              <label htmlFor="event-band-fixed-start">固定開始時刻</label>
              <input
                id="event-band-fixed-start"
                type="time"
                value={draft.fixedPlacement.plannedStartTime}
                disabled={!selectedStage}
                aria-invalid={errors.fixedPlacement ? 'true' : undefined}
                onChange={(changeEvent) => {
                  setDraft((previous) => ({
                    ...previous,
                    fixedPlacement: {
                      ...previous.fixedPlacement,
                      plannedStartTime: changeEvent.target.value,
                    },
                  }))
                  clearError('fixedPlacement')
                }}
              />
            </div>
          </div>
          {errors.fixedPlacement && (
            <p className="form-error" role="alert">{errors.fixedPlacement}</p>
          )}
        </fieldset>

        <fieldset className="event-band-condition-form__group event-band-condition-form__group--soft">
          <legend>希望条件</legend>
          <p>可能であれば叶えたい希望です。希望だけを理由に保存は止めません。</p>
          <div className="event-band-condition-form__range">
            <span>出演希望時間</span>
            <label htmlFor="event-band-preferred-from">
              開始
              <input
                id="event-band-preferred-from"
                type="time"
                value={draft.preferredTimeRange.from}
                aria-invalid={errors.preferredTimeRange ? 'true' : undefined}
                onChange={(changeEvent) => updateRange(
                  'preferredTimeRange',
                  'from',
                  changeEvent.target.value,
                )}
              />
            </label>
            <label htmlFor="event-band-preferred-until">
              終了
              <input
                id="event-band-preferred-until"
                type="time"
                value={draft.preferredTimeRange.until}
                aria-invalid={errors.preferredTimeRange ? 'true' : undefined}
                onChange={(changeEvent) => updateRange(
                  'preferredTimeRange',
                  'until',
                  changeEvent.target.value,
                )}
              />
            </label>
          </div>
          {errors.preferredTimeRange && (
            <p className="form-error" role="alert">{errors.preferredTimeRange}</p>
          )}
        </fieldset>

        {feasibility && (
          <section
            className={`event-band-condition-form__feasibility event-band-condition-form__feasibility--${feasibility.status}`}
            aria-live="polite"
          >
            <strong>
              {feasibility.status === 'blocked'
                ? '出演不可'
                : feasibility.status === 'warning'
                  ? '注意'
                  : '出演可能'}
            </strong>
            {feasibility.blockingReasons.map((reason) => (
              <small key={reason}>{reason}</small>
            ))}
            {feasibility.warnings.map((warning) => (
              <small key={warning}>{warning}</small>
            ))}
          </section>
        )}
        {errors.feasibility && (
          <p className="form-error" role="alert">{errors.feasibility}</p>
        )}
        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}

        <footer className="event-band-condition-form__actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="primary-button">draftへ反映</button>
        </footer>
      </form>
    </dialog>
  )
}
