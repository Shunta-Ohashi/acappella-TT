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
  Section,
  Stage,
  StageId,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import {
  createPaAssignmentDraftItem,
  createPaAssignmentsDraft,
  getPaAssignmentScopeStatus,
  hasPaAssignmentsErrors,
  resolvePaAssignmentInterval,
  validatePaAssignmentsDraft,
  type PaAssignmentDraftItem,
  type PaAssignmentsDraft,
  type PaAssignmentsUpdateResult,
  type PaAssignmentsValidationErrors,
} from '../domain/paAssignments'
import { describeScheduleBoundary } from '../domain/scheduleBoundaries.ts'
import { PaAssignmentEditorDialog } from './PaAssignmentEditorDialog'
import { hasPaDraftChanges } from '../ui/operationsDraftChanges'

interface PaSettingsProps {
  formId: string
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
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
  hasUnsavedChanges: () => boolean
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
  sections,
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
  const [savedDraft, setSavedDraft] = useState(() => draft)
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
  const assignmentsWithScopeStatus = draft.items.map((assignment) => ({
    assignment,
    scopeStatus: getPaAssignmentScopeStatus({
      assignment,
      event,
      eventDays,
      stages,
    }),
  }))
  const selectedAssignments = assignmentsWithScopeStatus
    .filter(({ assignment, scopeStatus }) =>
      scopeStatus.valid &&
      assignment.eventDayId === selectedEventDayId &&
      assignment.stageId === selectedStageId,
    )
    .map(({ assignment }) => assignment)
  const invalidScopeAssignments = assignmentsWithScopeStatus.filter(
    ({ scopeStatus }) => !scopeStatus.valid,
  )

  const getBoundaryLabel = (item: PaAssignmentDraftItem) => {
    const describe = (boundary: PaAssignmentDraftItem['from']) =>
      describeScheduleBoundary(boundary, {
        scheduleItemLabel: (id) => {
          const scheduleItem = scheduleItemById.get(id)
          if (!scheduleItem) return undefined
          return scheduleItem.kind === 'break'
        ? scheduleItem.title
        : eventBandById.get(scheduleItem.eventBandId)?.name ?? '不明なバンド'
        },
        sectionLabel: (id) => sections.find((section) => section.id === id)?.name,
      })
    return `${describe(item.from)} → ${describe(item.until)}`
  }

  const getTimeLabel = (item: PaAssignmentDraftItem) => {
    const resolution = resolvePaAssignmentInterval(
      item, calculatedItems, { stages, sections },
    )
    return resolution.ok
      ? `${formatMinuteAsLocalTime(resolution.interval.fromMinute)}〜${formatMinuteAsLocalTime(resolution.interval.untilMinute)}`
      : '参照エラー'
  }

  const openNew = (stage: Stage, role: PaRole) => {
    const item = createPaAssignmentDraftItem({
      draftId: createDraftId(),
      event,
      stage,
      sections,
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

  const removeAssignment = (draftId: string) => {
    setDraft((previous) => ({
      items: previous.items.filter(candidate => candidate.draftId !== draftId),
    }))
    setErrors(emptyErrors())
    setSaveMessage('')
  }

  const presentErrors = (validationErrors: PaAssignmentsValidationErrors) => {
    setErrors(validationErrors)
    onValidationFailed()
    const firstInvalid = draft.items.find((item) =>
      validationErrors.items[item.draftId],
    )
    if (firstInvalid && getPaAssignmentScopeStatus({
      assignment: firstInvalid,
      event,
      eventDays,
      stages,
    }).valid) {
      onSelectScope(firstInvalid.eventDayId, firstInvalid.stageId)
    }
  }

  const prepareDraft = (): PaAssignmentsUpdateResult => {
    const validationErrors = validatePaAssignmentsDraft({
      draft,
      event,
      eventDays,
      stages,
      sections,
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
    const saved = createPaAssignmentsDraft(event, result.paAssignments)
    setDraft(saved)
    setSavedDraft(saved)
    setErrors(emptyErrors())
    setSaveMessage('✓ 保存しました')
  }

  useImperativeHandle(ref, () => ({ prepareDraft, commitPrepared,
    hasUnsavedChanges: () => hasPaDraftChanges(draft, savedDraft) || editor !== undefined,
  }))

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
        {invalidScopeAssignments.length > 0 && (
          <section
            className="pa-settings__repair"
            aria-labelledby="pa-assignment-repair-title"
          >
            <h4 id="pa-assignment-repair-title">修復が必要なPA担当</h4>
            <ul className="operations-assignment-list">
              {invalidScopeAssignments.map(({ assignment, scopeStatus }) => {
                const memberName = memberById.get(assignment.memberId)?.realName ?? '未設定'
                const repairStage = selectedStages[0]
                return (
                  <li className="operations-assignment-card" key={assignment.draftId}>
                    <header>
                      <strong>{roleLabel(assignment.role)}</strong>
                      <span>{memberName}</span>
                    </header>
                    {!scopeStatus.valid && (
                      <p className="form-error" role="status">
                        {scopeStatus.message} 修正または削除してください。
                      </p>
                    )}
                    <dl>
                      <div><dt>担当範囲</dt><dd>{getBoundaryLabel(assignment)}</dd></div>
                      <div><dt>実時間</dt><dd>{getTimeLabel(assignment)}</dd></div>
                    </dl>
                    <div className="operations-assignment-card__actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!repairStage}
                        aria-label={`${memberName}の${roleLabel(assignment.role)}担当を修正`}
                        onClick={() => {
                          if (!repairStage) return
                          setEditor({
                            item: {
                              ...assignment,
                              eventDayId: repairStage.eventDayId,
                              stageId: repairStage.id,
                              from: { ...assignment.from },
                              until: { ...assignment.until },
                            },
                            isNew: false,
                          })
                        }}
                      >
                        修正
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        aria-label={`${memberName}の${roleLabel(assignment.role)}担当を削除`}
                        onClick={() => removeAssignment(assignment.draftId)}
                      >
                        削除
                      </button>
                    </div>
                    {errors.items[assignment.draftId] && (
                      <p className="form-error" role="alert">
                        {Object.values(errors.items[assignment.draftId])
                          .filter(Boolean)
                          .join(' ')}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {selectedStages.length === 0 ? (
          <div className="pa-settings__empty">
            <p>選択中のStageがありません。</p>
            <span>共通のStage選択から設定対象を選んでください。</span>
          </div>
        ) : selectedStages.map((stage) => {
          const stageItems = calculatedItems.filter((item) =>
            item.stageId === stage.id && item.eventDayId === stage.eventDayId,
          )
          const assignments = selectedAssignments.filter((item) =>
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
                    onClick={() => openNew(stage, 'main')}
                  >
                    ＋ Main PA
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`${stage.name}にSub PAを追加`}
                    onClick={() => openNew(stage, 'sub')}
                  >
                    ＋ Sub PA
                  </button>
                </div>
              </header>

              {stageItems.length === 0 && (
                <p className="pa-stage-card__empty">
                  タイムテーブル項目はありません。Sectionまたは時刻で担当範囲を指定できます。
                </p>
              )}
              {stageItems.length > 0 && assignments.length === 0 && (
                <p className="pa-stage-card__empty">PA担当はまだ設定されていません。</p>
              )}
              {assignments.length > 0 && (
                <ul className="operations-assignment-list">
                  {assignments.map((item) => (
                    <li className="operations-assignment-card" key={item.draftId}>
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
                      <div className="operations-assignment-card__actions">
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
                          onClick={() => removeAssignment(item.draftId)}
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
          sections={sections}
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
