import {
  forwardRef,
  useImperativeHandle,
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
  PaRole,
  ScheduleItem,
  Stage,
  StageId,
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
  formId: string
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
  selectedEventDayId?: EventDayId
  selectedStageId?: StageId
  onSelectScope: (eventDayId: EventDayId, stageId: StageId) => void
  onValidationFailed: () => void
  createDraftId: () => string
  onCreateUpdate: (draft: PaAssignmentsDraft) => PaAssignmentsUpdateResult
  onCommit: (result: Extract<PaAssignmentsUpdateResult, { ok: true }>) => void
  onSaveAndNext: () => void
}

export interface PaSettingsHandle {
  prepareDraft: () => PaAssignmentsUpdateResult
  commitPrepared: (
    result: Extract<PaAssignmentsUpdateResult, { ok: true }>,
  ) => void
}

interface EditorState {
  item: PaAssignmentDraftItem
  isNew: boolean
}

const emptyErrors = (): PaAssignmentsValidationErrors => ({ items: {} })
const roleLabel = (role: PaRole) => role === 'main' ? 'Main PA' : 'Sub PA'

export const PaSettings = forwardRef<PaSettingsHandle, PaSettingsProps>(
  function PaSettings({
  formId,
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
  selectedEventDayId,
  selectedStageId,
  onSelectScope,
  onValidationFailed,
  createDraftId,
  onCreateUpdate,
  onCommit,
  onSaveAndNext,
  }: PaSettingsProps, ref) {
  const [draft, setDraft] = useState(() =>
    createPaAssignmentsDraft(event, paAssignments),
  )
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
    .filter((stage) =>
      stage.eventDayId === selectedEventDayId && stage.id === selectedStageId,
    )
    .sort((first, second) => first.order - second.order)

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
    onValidationFailed()
    const firstInvalid = draft.items.find((item) =>
      validationErrors.items[item.draftId],
    )
    if (firstInvalid) {
      onSelectScope(firstInvalid.eventDayId, firstInvalid.stageId)
    }
  }

  const prepareDraft = (): PaAssignmentsUpdateResult => {
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
      return { ok: false, errors: validationErrors }
    }
    setErrors(emptyErrors())
    const result = onCreateUpdate(draft)
    if (!result.ok) presentErrors(result.errors)
    return result
  }

  const commitPrepared = (
    result: Extract<PaAssignmentsUpdateResult, { ok: true }>,
  ) => {
    onCommit(result)
    setDraft(createPaAssignmentsDraft(event, result.paAssignments))
    setErrors(emptyErrors())
    setSaveMessage('✓ 保存しました')
  }

  useImperativeHandle(ref, () => ({ prepareDraft, commitPrepared }))

  const save = (moveToNext: boolean) => {
    if (moveToNext) {
      onSaveAndNext()
      return
    }
    const result = prepareDraft()
    if (result.ok) commitPrepared(result)
  }

  const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault()
    const submitter = (submitEvent.nativeEvent as SubmitEvent).submitter
    save(
      submitter instanceof HTMLButtonElement &&
        submitter.value === 'save-and-next',
    )
  }

  return (
    <section className="pa-settings" aria-label="PA設定">
      <form id={formId} noValidate onSubmit={handleSubmit}>
        {selectedStages.length === 0 ? (
          <div className="pa-settings__empty">
            <p>選択中のStageがありません。</p>
            <span>共通のStage選択から設定対象を選んでください。</span>
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
                    aria-label={`${stage.name}にMain PAを追加`}
                    disabled={stageItems.length === 0}
                    onClick={() => openNew(stage, 'main')}
                  >
                    ＋ Main PA
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`${stage.name}にSub PAを追加`}
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
                <ul className="pa-assignment-list">
                  {assignments.map((item) => (
                    <li className="pa-assignment-card" key={item.draftId}>
                      <header>
                        <strong>{roleLabel(item.role)}</strong>
                        <span>
                          {memberById.get(item.memberId)?.realName ?? '未設定'}
                        </span>
                      </header>
                      <dl>
                        <div>
                          <dt>担当範囲</dt>
                          <dd>{getBoundaryLabel(item)}</dd>
                        </div>
                        <div>
                          <dt>実時間</dt>
                          <dd>{getTimeLabel(item)}</dd>
                        </div>
                      </dl>
                      <div className="pa-settings__row-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          aria-label={`${stage.name}の${roleLabel(item.role)}担当を編集`}
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
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}

        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
        <footer className="pa-settings__footer">
          <span role="status">{saveMessage}</span>
          <div>
            <button
              type="submit"
              className="secondary-button"
              value="save"
            >
              PA設定を保存
            </button>
            <button
              type="submit"
              className="primary-button"
              value="save-and-next"
            >
              PA設定を保存して次へ <span aria-hidden="true">→</span>
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
  },
)
