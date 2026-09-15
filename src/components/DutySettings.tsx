import {
  forwardRef,
  useImperativeHandle,
  useState,
  type FormEvent,
} from 'react'
import type {
  DutyAssignment,
  DutyType,
  Event,
  EventBand,
  EventDay,
  EventDayId,
  EventMember,
  EventMemberDay,
  Member,
  PaAssignment,
  ScheduleItem,
  Stage,
  StageId,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import {
  canDeleteDutyType,
  createDutyAssignmentDraftItem,
  createDutySettingsDraft,
  getDutyAssignmentScopeStatus,
  hasDutySettingsErrors,
  moveDutyTypeDraft,
  resolveDutyAssignmentInterval,
  validateDutySettingsDraft,
  validateDutyTypeDrafts,
  type DutyAssignmentDraftItem,
  type DutySettingsDraft,
  type DutySettingsUpdateResult,
  type DutyTypeDraftItem,
  type DutySettingsValidationErrors,
} from '../domain/dutyAssignments'
import { getMemberDisplayName } from '../ui/eventBandPresentation'
import { DutyAssignmentEditorDialog } from './DutyAssignmentEditorDialog'

export interface DutySettingsHandle {
  prepareDraft: (
    paAssignmentsOverride?: PaAssignment[],
  ) => DutySettingsUpdateResult
  commitPrepared: (
    result: Extract<DutySettingsUpdateResult, { ok: true }>,
  ) => void
}

interface DutySettingsProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  members: Member[]
  eventMembers: EventMember[]
  eventMemberDays: EventMemberDay[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  calculatedItems: CalculatedScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  selectedEventDayId?: EventDayId
  selectedStageId?: StageId
  onSelectScope: (eventDayId: EventDayId, stageId: StageId) => void
  onValidationFailed: () => void
  createDraftId: () => string
  onCreateUpdate: (
    draft: DutySettingsDraft,
    paAssignmentsOverride?: PaAssignment[],
  ) => DutySettingsUpdateResult
  onCommit: (result: Extract<DutySettingsUpdateResult, { ok: true }>) => void
}

interface AssignmentEditorState {
  item: DutyAssignmentDraftItem
  isNew: boolean
  isScopeRepair?: boolean
}

interface TypeEditorState {
  draftId: string
  name: string
}

const emptyErrors = (): DutySettingsValidationErrors => ({
  dutyTypes: {},
  assignments: {},
})

export const DutySettings = forwardRef<DutySettingsHandle, DutySettingsProps>(
  function DutySettings({
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
    dutyTypes,
    dutyAssignments,
    selectedEventDayId,
    selectedStageId,
    onSelectScope,
    onValidationFailed,
    createDraftId,
    onCreateUpdate,
    onCommit,
  }, ref) {
    const [draft, setDraft] = useState(() =>
      createDutySettingsDraft(event, stages, dutyTypes, dutyAssignments),
    )
    const [assignmentEditor, setAssignmentEditor] =
      useState<AssignmentEditorState>()
    const [typeEditor, setTypeEditor] = useState<TypeEditorState>()
    const [newTypeName, setNewTypeName] = useState('')
    const [typeActionError, setTypeActionError] = useState('')
    const [errors, setErrors] = useState<DutySettingsValidationErrors>(
      emptyErrors,
    )
    const [isDirty, setIsDirty] = useState(false)
    const [saveMessage, setSaveMessage] = useState('')
    const memberById = new Map(members.map((member) => [member.id, member]))
    const scheduleItemById = new Map(
      scheduleItems.map((scheduleItem) => [scheduleItem.id, scheduleItem]),
    )
    const eventBandById = new Map(
      eventBands.map((eventBand) => [eventBand.id, eventBand]),
    )
    const dutyTypeByDraftId = new Map(
      draft.dutyTypes.map((dutyType) => [dutyType.draftId, dutyType]),
    )
    const selectedStage = stages.find((stage) =>
      stage.id === selectedStageId && stage.eventDayId === selectedEventDayId,
    )
    const assignmentsWithScopeStatus = draft.assignments.map((assignment) => ({
      assignment,
      scopeStatus: getDutyAssignmentScopeStatus({
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

    const markChanged = () => {
      setIsDirty(true)
      setSaveMessage('')
      setErrors(emptyErrors())
      setTypeActionError('')
    }

    const getBoundaryLabel = (item: DutyAssignmentDraftItem) => {
      const describe = (boundary: DutyAssignmentDraftItem['from']) => {
        const scheduleItem = scheduleItemById.get(boundary.scheduleItemId)
        if (!scheduleItem) return '参照先なし'
        const name = scheduleItem.kind === 'break'
          ? scheduleItem.title
          : eventBandById.get(scheduleItem.eventBandId)?.name ?? '不明なバンド'
        return `${name} ${boundary.edge === 'start' ? '開始' : '終了'}`
      }
      return `${describe(item.from)} → ${describe(item.until)}`
    }

    const getTimeLabel = (item: DutyAssignmentDraftItem) => {
      const resolution = resolveDutyAssignmentInterval(item, calculatedItems)
      return resolution.ok
        ? `${formatMinuteAsLocalTime(resolution.interval.fromMinute)}〜${formatMinuteAsLocalTime(resolution.interval.untilMinute)}`
        : '参照エラー'
    }

    const presentErrors = (validationErrors: DutySettingsValidationErrors) => {
      setErrors(validationErrors)
      onValidationFailed()
      const firstInvalid = draft.assignments.find((assignment) =>
        validationErrors.assignments[assignment.draftId],
      )
      if (firstInvalid && getDutyAssignmentScopeStatus({
        assignment: firstInvalid,
        event,
        eventDays,
        stages,
      }).valid) {
        onSelectScope(firstInvalid.eventDayId, firstInvalid.stageId)
      }
    }

    const prepareDraft = (
      paAssignmentsOverride: PaAssignment[] = paAssignments,
    ): DutySettingsUpdateResult => {
      const validationErrors = validateDutySettingsDraft({
        draft,
        event,
        eventDays,
        stages,
        members,
        eventMembers,
        eventMemberDays,
        eventBands,
        paAssignments: paAssignmentsOverride,
        calculatedItems,
      })
      setSaveMessage('')
      if (hasDutySettingsErrors(validationErrors)) {
        presentErrors(validationErrors)
        return { ok: false, errors: validationErrors }
      }
      setErrors(emptyErrors())
      const result = onCreateUpdate(draft, paAssignmentsOverride)
      if (!result.ok) presentErrors(result.errors)
      return result
    }

    const commitPrepared = (
      result: Extract<DutySettingsUpdateResult, { ok: true }>,
    ) => {
      onCommit(result)
      setDraft(createDutySettingsDraft(
        event,
        stages,
        result.dutyTypes,
        result.dutyAssignments,
      ))
      setErrors(emptyErrors())
      setIsDirty(false)
      setSaveMessage('✓ 保存しました')
    }

    useImperativeHandle(ref, () => ({ prepareDraft, commitPrepared }))

    const handleSubmit = (submitEvent: FormEvent<HTMLFormElement>) => {
      submitEvent.preventDefault()
      const result = prepareDraft()
      if (result.ok) commitPrepared(result)
    }

    const addDutyType = () => {
      const newItem: DutyTypeDraftItem = {
        draftId: createDraftId(),
        name: newTypeName,
      }
      const nextTypes = [...draft.dutyTypes, newItem]
      const nextErrors = validateDutyTypeDrafts(nextTypes)
      if (nextErrors[newItem.draftId]?.name) {
        setTypeActionError(nextErrors[newItem.draftId].name ?? '')
        return
      }
      setDraft((previous) => ({ ...previous, dutyTypes: nextTypes }))
      setNewTypeName('')
      markChanged()
    }

    const applyTypeRename = () => {
      if (!typeEditor) return
      const nextTypes = draft.dutyTypes.map((dutyType) =>
        dutyType.draftId === typeEditor.draftId
          ? { ...dutyType, name: typeEditor.name }
          : dutyType,
      )
      const nextErrors = validateDutyTypeDrafts(nextTypes)
      if (nextErrors[typeEditor.draftId]?.name) {
        setTypeActionError(nextErrors[typeEditor.draftId].name ?? '')
        return
      }
      setDraft((previous) => ({ ...previous, dutyTypes: nextTypes }))
      setTypeEditor(undefined)
      markChanged()
    }

    const openNewAssignment = () => {
      if (!selectedStage || draft.dutyTypes.length === 0) return
      const item = createDutyAssignmentDraftItem({
        draftId: createDraftId(),
        dutyTypeDraftId: draft.dutyTypes[0].draftId,
        eventDayId: selectedStage.eventDayId,
        stageId: selectedStage.id,
        calculatedItems,
      })
      if (item) setAssignmentEditor({ item, isNew: true })
    }

    const applyAssignmentEditor = (item: DutyAssignmentDraftItem) => {
      setDraft((previous) => ({
        ...previous,
        assignments: assignmentEditor?.isNew
          ? [...previous.assignments, item]
          : previous.assignments.map((candidate) =>
              candidate.draftId === item.draftId ? item : candidate,
            ),
      }))
      setAssignmentEditor(undefined)
      markChanged()
    }

    const removeAssignment = (draftId: string) => {
      setDraft((previous) => ({
        ...previous,
        assignments: previous.assignments.filter((candidate) =>
          candidate.draftId !== draftId,
        ),
      }))
      markChanged()
    }

    const getDutyTypeName = (item: DutyAssignmentDraftItem) =>
      item.dutyTypeDraftId
        ? dutyTypeByDraftId.get(item.dutyTypeDraftId)?.name ?? '不明な仕事'
        : '不明な仕事'

    const getMemberName = (item: DutyAssignmentDraftItem) => {
      const member = memberById.get(item.memberId)
      return member ? getMemberDisplayName(member) : '不明なメンバー'
    }

    return (
      <section className="duty-settings" aria-label="当日運営設定">
        <form noValidate onSubmit={handleSubmit}>
          <section className="duty-settings__types" aria-labelledby="duty-types-title">
            <h3 id="duty-types-title">仕事の種類</h3>
            {draft.dutyTypes.length === 0 ? (
              <p className="duty-settings__empty">仕事はまだ登録されていません。</p>
            ) : (
              <ul className="duty-type-list">
                {draft.dutyTypes.map((dutyType, index) => (
                  <li key={dutyType.draftId}>
                    <strong>{dutyType.name}</strong>
                    <div>
                      <button
                        type="button"
                        aria-label={`${dutyType.name}を上へ移動`}
                        disabled={index === 0}
                        onClick={() => {
                          setDraft((previous) => ({
                            ...previous,
                            dutyTypes: moveDutyTypeDraft(
                              previous.dutyTypes,
                              dutyType.draftId,
                              -1,
                            ),
                          }))
                          markChanged()
                        }}
                      >↑</button>
                      <button
                        type="button"
                        aria-label={`${dutyType.name}を下へ移動`}
                        disabled={index === draft.dutyTypes.length - 1}
                        onClick={() => {
                          setDraft((previous) => ({
                            ...previous,
                            dutyTypes: moveDutyTypeDraft(
                              previous.dutyTypes,
                              dutyType.draftId,
                              1,
                            ),
                          }))
                          markChanged()
                        }}
                      >↓</button>
                      <button
                        type="button"
                        aria-label={`${dutyType.name}の名前を変更`}
                        onClick={() => setTypeEditor({
                          draftId: dutyType.draftId,
                          name: dutyType.name,
                        })}
                      >編集</button>
                      <button
                        type="button"
                        aria-label={`${dutyType.name}を削除`}
                        onClick={() => {
                          if (!canDeleteDutyType(
                            dutyType,
                            draft.assignments,
                            dutyAssignments,
                          )) {
                            setTypeActionError(
                              'この仕事には担当設定があります。先に担当を削除して保存してください。',
                            )
                            return
                          }
                          setDraft((previous) => ({
                            ...previous,
                            dutyTypes: previous.dutyTypes.filter((candidate) =>
                              candidate.draftId !== dutyType.draftId,
                            ),
                          }))
                          markChanged()
                        }}
                      >削除</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {typeEditor ? (
              <div className="duty-type-input">
                <label htmlFor="duty-type-rename">仕事名</label>
                <input
                  id="duty-type-rename"
                  value={typeEditor.name}
                  onChange={(event) => setTypeEditor((previous) => previous
                    ? { ...previous, name: event.target.value }
                    : previous)}
                />
                <button type="button" onClick={applyTypeRename}>名前を保存</button>
                <button type="button" onClick={() => setTypeEditor(undefined)}>取消</button>
              </div>
            ) : (
              <div className="duty-type-input">
                <label htmlFor="new-duty-type-name">新しい仕事名</label>
                <input
                  id="new-duty-type-name"
                  value={newTypeName}
                  onChange={(event) => {
                    setNewTypeName(event.target.value)
                    setTypeActionError('')
                  }}
                />
                <button type="button" onClick={addDutyType}>＋ 仕事を追加</button>
              </div>
            )}
            {typeActionError && (
              <p className="form-error" role="alert">{typeActionError}</p>
            )}
          </section>

          <section className="duty-settings__assignments" aria-labelledby="duty-assignments-title">
            <div className="duty-settings__section-heading">
              <h3 id="duty-assignments-title">担当設定</h3>
              <button
                type="button"
                className="secondary-button"
                aria-label={`${selectedStage?.name ?? '選択中のStage'}に一般業務担当を追加`}
                disabled={
                  !selectedStage ||
                  draft.dutyTypes.length === 0 ||
                  calculatedItems.every((item) => item.stageId !== selectedStage.id)
                }
                onClick={openNewAssignment}
              >＋ 担当を追加</button>
            </div>
            {invalidScopeAssignments.length > 0 && (
              <section
                className="duty-settings__repair"
                aria-labelledby="duty-assignment-repair-title"
              >
                <h4 id="duty-assignment-repair-title">修復が必要な担当</h4>
                <ul className="duty-assignment-list">
                  {invalidScopeAssignments.map(({ assignment, scopeStatus }) => {
                    const dutyTypeName = getDutyTypeName(assignment)
                    const memberName = getMemberName(assignment)
                    return (
                      <li key={assignment.draftId}>
                        <header>
                          <strong>{dutyTypeName}</strong>
                          <span>{memberName}</span>
                        </header>
                        {!scopeStatus.valid && (
                          <p className="form-error" role="status">
                            {scopeStatus.message} 修正または削除してください。
                          </p>
                        )}
                        {assignment.missingDutyTypeId && (
                          <p className="form-error" role="status">
                            仕事の参照も切れています。
                          </p>
                        )}
                        <div className="pa-settings__row-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={!selectedStage}
                            aria-label={`${memberName}の${dutyTypeName}担当を修正`}
                            onClick={() => {
                              if (!selectedStage) return
                              setAssignmentEditor({
                                item: {
                                  ...assignment,
                                  eventDayId: selectedStage.eventDayId,
                                  stageId: selectedStage.id,
                                  from: { ...assignment.from },
                                  until: { ...assignment.until },
                                },
                                isNew: false,
                                isScopeRepair: true,
                              })
                            }}
                          >修正</button>
                          <button
                            type="button"
                            className="danger-button"
                            aria-label={`${memberName}の${dutyTypeName}担当を削除`}
                            onClick={() => removeAssignment(assignment.draftId)}
                          >削除</button>
                        </div>
                        {errors.assignments[assignment.draftId] && (
                          <p className="form-error" role="alert">
                            {Object.values(errors.assignments[assignment.draftId])
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
            {!selectedStage ? (
              <p className="duty-settings__empty">選択中のStageがありません。</p>
            ) : selectedAssignments.length === 0 ? (
              <p className="duty-settings__empty">このStageの担当はまだ設定されていません。</p>
            ) : (
              <ul className="duty-assignment-list">
                {selectedAssignments.map((item) => {
                  const dutyTypeName = getDutyTypeName(item)
                  const memberName = getMemberName(item)
                  return (
                    <li key={item.draftId}>
                      <header>
                        <strong>{item.missingDutyTypeId ? '参照切れの担当' : dutyTypeName}</strong>
                        <span>{memberName}</span>
                      </header>
                      {item.missingDutyTypeId && (
                        <p className="form-error" role="status">
                          仕事：参照切れ（修正または削除してください）
                        </p>
                      )}
                      <dl>
                        <div><dt>担当範囲</dt><dd>{getBoundaryLabel(item)}</dd></div>
                        <div><dt>実時間</dt><dd>{getTimeLabel(item)}</dd></div>
                      </dl>
                      <div className="pa-settings__row-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          aria-label={`${memberName}の${dutyTypeName}担当を編集`}
                          onClick={() => setAssignmentEditor({
                            item: { ...item, from: { ...item.from }, until: { ...item.until } },
                            isNew: false,
                          })}
                        >編集</button>
                        <button
                          type="button"
                          className="danger-button"
                          aria-label={`${memberName}の${dutyTypeName}担当を削除`}
                          onClick={() => removeAssignment(item.draftId)}
                        >削除</button>
                      </div>
                      {errors.assignments[item.draftId] && (
                        <p className="form-error" role="alert">
                          {Object.values(errors.assignments[item.draftId])
                            .filter(Boolean)
                            .join(' ')}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          {Object.entries(errors.dutyTypes).map(([draftId, itemErrors]) => (
            <p className="form-error" role="alert" key={draftId}>
              {Object.values(itemErrors).filter(Boolean).join(' ')}
            </p>
          ))}
          <footer className="duty-settings__footer">
            <span role="status">
              {isDirty ? '未保存の変更あり' : saveMessage || '保存済み'}
            </span>
            <button type="submit" className="secondary-button">
              当日運営設定を保存
            </button>
          </footer>
        </form>

        {assignmentEditor && (
          <DutyAssignmentEditorDialog
            event={event}
            eventDays={eventDays}
            stages={stages}
            members={members}
            eventMembers={eventMembers}
            eventMemberDays={eventMemberDays}
            eventBands={eventBands}
            paAssignments={paAssignments}
            scheduleItems={scheduleItems}
            calculatedItems={calculatedItems}
            dutyTypes={draft.dutyTypes}
            item={assignmentEditor.item}
            isScopeRepair={assignmentEditor.isScopeRepair}
            onCancel={() => setAssignmentEditor(undefined)}
            onApply={applyAssignmentEditor}
          />
        )}
      </section>
    )
  },
)
