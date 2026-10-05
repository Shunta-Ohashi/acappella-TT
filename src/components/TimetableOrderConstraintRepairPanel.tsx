import { useState } from 'react'
import type {
  Event,
  EventBand,
  EventDay,
  Section,
  Stage,
  TimetableOrderConstraint,
} from '../domain/models'
import {
  deleteTimetableOrderConstraint,
  evaluateTimetableOrderConstraints,
  type TimetableOrderConstraintViolation,
} from '../domain/timetableOrderConstraints'
import { isTimetableOrderConstraintScopeReachable } from '../ui/timetableOrderConstraintPresentation'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'

interface TimetableOrderConstraintRepairPanelProps {
  event: Event
  eventDays: EventDay[]
  stages: Stage[]
  sections: Section[]
  eventBands: EventBand[]
  timetableOrderConstraints: TimetableOrderConstraint[]
  semanticViolations?: TimetableOrderConstraintViolation[]
  onCommit: (constraints: TimetableOrderConstraint[]) => void
}

export function TimetableOrderConstraintRepairPanel({
  event,
  eventDays,
  stages,
  sections,
  eventBands,
  timetableOrderConstraints,
  semanticViolations,
  onCommit,
}: TimetableOrderConstraintRepairPanelProps) {
  const [pendingDeletion, setPendingDeletion] = useState<TimetableOrderConstraint | null>(null)
  const [actionError, setActionError] = useState('')
  const currentEventConstraints = timetableOrderConstraints.filter(
    constraint => constraint.eventId === event.id,
  )
  const violations = semanticViolations ?? evaluateTimetableOrderConstraints({
    eventId: event.id,
    timetableOrderConstraints: currentEventConstraints,
    eventDays,
    stages,
    sections,
    eventBands,
  }).violations
  const unreachableConstraints = currentEventConstraints
    .filter(constraint => !isTimetableOrderConstraintScopeReachable({
      constraint,
      eventId: event.id,
      eventDays,
      stages,
    }))
    .sort((left, right) =>
      left.eventDayId.localeCompare(right.eventDayId) ||
      left.stageId.localeCompare(right.stageId) ||
      left.id.localeCompare(right.id))
  const currentEventDayIds = new Set(eventDays
    .filter(candidate => candidate.eventId === event.id)
    .map(candidate => candidate.id))

  const getConstraintBandById = (constraint: TimetableOrderConstraint) => {
    if (!currentEventDayIds.has(constraint.eventDayId)) return new Map<string, EventBand>()
    return new Map(eventBands
      .filter(band => band.eventId === event.id &&
        band.eventDayId === constraint.eventDayId)
      .map(band => [band.id, band]))
  }

  const formatBandOrder = (constraint: TimetableOrderConstraint): string => {
    const bandById = getConstraintBandById(constraint)
    return constraint.eventBandIds.map(eventBandId =>
      bandById.get(eventBandId)?.name ?? `参照先不明（${eventBandId}）`,
    ).join(' → ')
  }

  const getSemanticMessages = (constraint: TimetableOrderConstraint): string[] =>
    [...new Set(violations
      .filter(violation => violation.constraintIds.includes(constraint.id))
      .map(violation => violation.message))]

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

  if (unreachableConstraints.length === 0) return null

  return (
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
          const bandOrder = formatBandOrder(constraint)
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

      {actionError && <p className="form-error" role="alert">{actionError}</p>}

      {pendingDeletion && (
        <DeleteConfirmationDialog
          title="出演順制約を削除しますか？"
          description={`scopeを確認できない出演順制約（ID: ${pendingDeletion.id}、出演順: ${
            formatBandOrder(pendingDeletion)
          }）を削除します。この操作は取り消せません。`}
          confirmLabel="削除する"
          cancelLabel="キャンセル"
          onConfirm={confirmDeletion}
          onCancel={() => setPendingDeletion(null)}
        />
      )}
    </section>
  )
}
