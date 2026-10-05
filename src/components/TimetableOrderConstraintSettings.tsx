import { useState } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  ScheduleItem,
  Section,
  Stage,
  TimetableOrderConstraint,
} from '../domain/models'
import {
  createTimetableOrderConstraintUpdate,
  deleteTimetableOrderConstraint,
  evaluateTimetableOrderConstraints,
  updateTimetableOrderConstraint,
  type TimetableOrderConstraintDraft,
  type TimetableOrderConstraintMutationResult,
} from '../domain/timetableOrderConstraints'
import {
  getTimetableOrderConstraintScheduleStatus,
  isTimetableOrderConstraintScopeReachable,
} from '../ui/timetableOrderConstraintPresentation'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'
import { TimetableOrderConstraintDialog } from './TimetableOrderConstraintDialog'

interface TimetableOrderConstraintSettingsProps {
  event: Event
  eventDay: EventDay
  stage: Stage
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  timetableOrderConstraints: TimetableOrderConstraint[]
  createConstraintId: () => string
  onCommit: (constraints: TimetableOrderConstraint[]) => void
}

type EditorState =
  | { mode: 'add'; constraintId: string }
  | { mode: 'edit'; constraint: TimetableOrderConstraint }

export function TimetableOrderConstraintSettings({
  event,
  eventDay,
  stage,
  eventDays,
  stages,
  sections,
  eventBands,
  scheduleItems,
  timetableOrderConstraints,
  createConstraintId,
  onCommit,
}: TimetableOrderConstraintSettingsProps) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pendingDeletion, setPendingDeletion] = useState<TimetableOrderConstraint | null>(null)
  const [actionError, setActionError] = useState('')
  const stageSections = sections
    .filter(section => section.stageId === stage.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const sectionOrderById = new Map(stageSections.map((section, index) => [section.id, index]))
  const sectionById = new Map(stageSections.map(section => [section.id, section]))
  const currentDayBands = eventBands
    .filter(band => band.eventId === event.id && band.eventDayId === eventDay.id)
    .sort((left, right) => left.name.localeCompare(right.name, 'ja') ||
      left.id.localeCompare(right.id))
  const bandById = new Map(currentDayBands.map(band => [band.id, band]))
  const currentEventConstraints = timetableOrderConstraints.filter(
    constraint => constraint.eventId === event.id,
  )
  const semanticEvaluation = evaluateTimetableOrderConstraints({
    eventId: event.id,
    timetableOrderConstraints: currentEventConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
  })
  const isScopeReachable = (constraint: TimetableOrderConstraint): boolean =>
    isTimetableOrderConstraintScopeReachable({
      constraint,
      eventId: event.id,
      eventDays,
      stages,
    })
  const constraints = currentEventConstraints
    .filter(constraint => isScopeReachable(constraint) &&
      constraint.eventDayId === eventDay.id && constraint.stageId === stage.id)
    .sort((left, right) =>
      (sectionOrderById.get(left.sectionId ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (sectionOrderById.get(right.sectionId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id))
  const unreachableConstraints = currentEventConstraints
    .filter(constraint => !isScopeReachable(constraint))
    .sort((left, right) =>
      left.eventDayId.localeCompare(right.eventDayId) ||
      left.stageId.localeCompare(right.stageId) ||
      left.id.localeCompare(right.id))
  const currentEventDayIds = new Set(eventDays
    .filter(candidate => candidate.eventId === event.id)
    .map(candidate => candidate.id))

  const formatBandOrder = (
    constraint: TimetableOrderConstraint,
    scopedBandById: ReadonlyMap<string, EventBand> = bandById,
  ): string =>
    constraint.eventBandIds.map(eventBandId =>
      scopedBandById.get(eventBandId)?.name ?? `参照先不明（${eventBandId}）`,
    ).join(' → ')

  const getConstraintBandById = (constraint: TimetableOrderConstraint) => {
    if (!currentEventDayIds.has(constraint.eventDayId)) return new Map<string, EventBand>()
    return new Map(eventBands
      .filter(band => band.eventId === event.id &&
        band.eventDayId === constraint.eventDayId)
      .map(band => [band.id, band]))
  }

  const getSemanticMessages = (constraint: TimetableOrderConstraint): string[] =>
    [...new Set(semanticEvaluation.violations
      .filter(violation => violation.constraintIds.includes(constraint.id))
      .map(violation => violation.message))]

  const applyResult = (
    result: TimetableOrderConstraintMutationResult,
  ): TimetableOrderConstraintMutationResult => {
    if (!result.ok) return result
    onCommit(result.timetableOrderConstraints)
    setActionError('')
    setEditor(null)
    return result
  }

  const saveDraft = (draft: TimetableOrderConstraintDraft) => {
    const references = { eventDays, stages, sections, eventBands }
    if (editor?.mode === 'edit') {
      return applyResult(updateTimetableOrderConstraint({
        timetableOrderConstraints,
        constraintId: editor.constraint.id,
        eventId: event.id,
        eventDayId: eventDay.id,
        stageId: stage.id,
        draft,
        ...references,
      }))
    }
    if (editor?.mode === 'add') {
      return applyResult(createTimetableOrderConstraintUpdate({
        timetableOrderConstraints,
        constraintId: editor.constraintId,
        event,
        eventDay,
        stage,
        draft,
        ...references,
      }))
    }
    return { ok: false as const, errors: ['編集対象の出演順制約がありません。'] }
  }

  const confirmDeletion = () => {
    if (!pendingDeletion) return
    const result = deleteTimetableOrderConstraint({
      timetableOrderConstraints,
      constraintId: pendingDeletion.id,
    })
    if (!result.ok) {
      setActionError(result.errors.join(' '))
      setPendingDeletion(null)
      return
    }
    onCommit(result.timetableOrderConstraints)
    setActionError('')
    setPendingDeletion(null)
  }

  return (
    <section className="timetable-order-settings" aria-label="出演順制約設定">
      <p className="timetable-order-settings__description">
        指定したバンドを同じStage / Section内で、この順に連続して配置します。
        休憩は間に入れられますが、別の出演バンドは間に入りません。
      </p>

      <button
        type="button"
        className="primary-button timetable-order-settings__add"
        disabled={currentDayBands.length < 2}
        onClick={() => {
          setActionError('')
          setEditor({ mode: 'add', constraintId: createConstraintId() })
        }}
      >
        出演順制約を追加
      </button>
      {currentDayBands.length < 2 && (
        <p className="timetable-order-settings__guide">
          出演順制約を追加するには、この開催日に出演バンドが2組以上必要です。
        </p>
      )}

      {constraints.length === 0 ? (
        <p className="timetable-order-settings__empty">
          このStageには出演順制約がありません。
        </p>
      ) : (
        <ul className="timetable-order-settings__list">
          {constraints.map((constraint, index) => {
            const bandOrder = formatBandOrder(constraint)
            const laneLabel = constraint.sectionId
              ? sectionById.get(constraint.sectionId)?.name ??
                `不明なSection（${constraint.sectionId}）`
              : 'Stage全体'
            const semanticViolations = semanticEvaluation.violations.filter(
              violation => violation.constraintIds.includes(constraint.id),
            )
            const semanticMessages = getSemanticMessages(constraint)
            const status = getTimetableOrderConstraintScheduleStatus({
              constraint,
              scheduleItems,
              semanticViolations,
            })
            return (
              <li key={`${constraint.id}:${index}`} className="timetable-order-settings__item">
                <div>
                  <strong>{laneLabel}</strong>
                  <p>{bandOrder}</p>
                  <small className={`timetable-order-settings__status timetable-order-settings__status--${status.kind}`}>
                    {status.label}
                  </small>
                  {semanticMessages.length > 0 && (
                    <ul className="timetable-order-settings__validation-messages">
                      {semanticMessages.map(message => <li key={message}>{message}</li>)}
                    </ul>
                  )}
                </div>
                <div className="timetable-order-settings__actions">
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`${bandOrder}の出演順制約を編集`}
                    onClick={() => {
                      setActionError('')
                      setEditor({ mode: 'edit', constraint })
                    }}
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    className="timetable-order-settings__delete"
                    aria-label={`${bandOrder}の出演順制約を削除`}
                    onClick={() => {
                      setActionError('')
                      setPendingDeletion(constraint)
                    }}
                  >
                    削除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {unreachableConstraints.length > 0 && (
        <section
          className="timetable-order-settings__repair"
          aria-label="修復が必要な出演順制約"
        >
          <h3>修復が必要な出演順制約 {unreachableConstraints.length}件</h3>
          <p className="timetable-order-settings__guide">
            開催日またはStageの参照を確認できません。内容を確認して削除してください。
          </p>
          <ul className="timetable-order-settings__list">
            {unreachableConstraints.map((constraint, index) => {
              const referencedDay = eventDays.find(candidate =>
                candidate.id === constraint.eventDayId && candidate.eventId === event.id)
              const referencedStage = stages.find(candidate =>
                candidate.id === constraint.stageId)
              const dayLabel = referencedDay
                ? referencedDay.label?.trim() || referencedDay.date
                : `参照先不明（${constraint.eventDayId}）`
              const stageLabel = referencedStage && referencedDay &&
                referencedStage.eventDayId === constraint.eventDayId
                ? referencedStage.name
                : referencedStage
                  ? `${referencedStage.name}（開催日不一致）`
                  : `参照先不明（${constraint.stageId}）`
              const bandOrder = formatBandOrder(
                constraint,
                getConstraintBandById(constraint),
              )
              const semanticMessages = getSemanticMessages(constraint)
              return (
                <li
                  key={`repair:${constraint.id}:${index}`}
                  className="timetable-order-settings__item"
                >
                  <div>
                    <strong>{dayLabel} / {stageLabel}</strong>
                    <small className="timetable-order-settings__constraint-id">
                      制約ID: {constraint.id}
                    </small>
                    <p>{bandOrder}</p>
                    <small className="timetable-order-settings__status timetable-order-settings__status--invalid">
                      出演順制約：要修正
                    </small>
                    <ul className="timetable-order-settings__validation-messages">
                      {semanticMessages.map(message => <li key={message}>{message}</li>)}
                    </ul>
                  </div>
                  <div className="timetable-order-settings__actions">
                    <button
                      type="button"
                      className="timetable-order-settings__delete"
                      aria-label={`scopeを確認できない出演順制約 ${constraint.id} を削除`}
                      onClick={() => {
                        setActionError('')
                        setPendingDeletion(constraint)
                      }}
                    >
                      削除
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {actionError && <p className="form-error" role="alert">{actionError}</p>}

      {editor && (
        <TimetableOrderConstraintDialog
          event={event}
          eventDay={eventDay}
          stage={stage}
          sections={stageSections}
          eventBands={currentDayBands}
          constraint={editor.mode === 'edit' ? editor.constraint : undefined}
          onCancel={() => setEditor(null)}
          onSave={saveDraft}
        />
      )}

      {pendingDeletion && (
        <DeleteConfirmationDialog
          title="出演順制約を削除しますか？"
          description={!isScopeReachable(pendingDeletion)
            ? `scopeを確認できない出演順制約（ID: ${pendingDeletion.id}、出演順: ${
              formatBandOrder(pendingDeletion, getConstraintBandById(pendingDeletion))
            }）を削除します。この操作は取り消せません。`
            : `「${formatBandOrder(pendingDeletion)}」の出演順制約を削除します。この操作は取り消せません。`}
          confirmLabel="削除する"
          cancelLabel="キャンセル"
          onConfirm={confirmDeletion}
          onCancel={() => setPendingDeletion(null)}
        />
      )}
    </section>
  )
}
