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
  updateTimetableOrderConstraint,
  type TimetableOrderConstraintDraft,
  type TimetableOrderConstraintMutationResult,
} from '../domain/timetableOrderConstraints'
import {
  evaluateTimetableOrderConstraintOccurrences,
  getTimetableOrderConstraintScheduleStatus,
  isTimetableOrderConstraintScopeReachable,
} from '../ui/timetableOrderConstraintPresentation'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'
import { TimetableOrderConstraintDialog } from './TimetableOrderConstraintDialog'
import { TimetableOrderConstraintRepairPanel } from './TimetableOrderConstraintRepairPanel'

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
  const constraintOccurrences = evaluateTimetableOrderConstraintOccurrences({
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
  const constraints = constraintOccurrences
    .filter(({ constraint }) => isScopeReachable(constraint) &&
      constraint.eventDayId === eventDay.id && constraint.stageId === stage.id)
    .sort((left, right) =>
      (sectionOrderById.get(left.constraint.sectionId ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (sectionOrderById.get(right.constraint.sectionId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
      left.constraint.id.localeCompare(right.constraint.id) ||
      left.occurrenceIndex - right.occurrenceIndex)
  const formatBandOrder = (constraint: TimetableOrderConstraint): string =>
    constraint.eventBandIds.map(eventBandId =>
      bandById.get(eventBandId)?.name ?? `参照先不明（${eventBandId}）`,
    ).join(' → ')

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
          {constraints.map(({ constraint, occurrenceIndex, semanticViolations }) => {
            const bandOrder = formatBandOrder(constraint)
            const laneLabel = constraint.sectionId
              ? sectionById.get(constraint.sectionId)?.name ??
                `不明なSection（${constraint.sectionId}）`
              : 'Stage全体'
            const semanticMessages = [...new Set(
              semanticViolations.map(violation => violation.message),
            )]
            const status = getTimetableOrderConstraintScheduleStatus({
              constraint,
              scheduleItems,
              semanticViolations,
            })
            return (
              <li
                key={`${constraint.id}:${occurrenceIndex}`}
                className="timetable-order-settings__item"
              >
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

      <TimetableOrderConstraintRepairPanel
        event={event}
        eventDays={eventDays}
        stages={stages}
        sections={sections}
        eventBands={eventBands}
        timetableOrderConstraints={timetableOrderConstraints}
        constraintOccurrences={constraintOccurrences}
        onCommit={onCommit}
      />

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
          description={`「${formatBandOrder(pendingDeletion)}」の出演順制約を削除します。この操作は取り消せません。`}
          confirmLabel="削除する"
          cancelLabel="キャンセル"
          onConfirm={confirmDeletion}
          onCancel={() => setPendingDeletion(null)}
        />
      )}
    </section>
  )
}
