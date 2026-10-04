import type {
  ScheduleBoundary,
  Section,
  Stage,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import {
  createDefaultAssignmentRange,
  getAssignmentRangeMode,
  type AssignmentRangeMode,
} from '../domain/assignmentRanges.ts'
import {
  isScheduleItemBoundary,
  isSectionBoundary,
  isTimeBoundary,
} from '../domain/scheduleBoundaries.ts'

interface AssignmentRangeFieldsProps {
  idPrefix: string
  stage?: Stage
  sections: Section[]
  calculatedItems: CalculatedScheduleItem[]
  boundaryOptions: Array<{ value: string; label: string }>
  from: ScheduleBoundary
  until: ScheduleBoundary
  invalid?: boolean
  onChange: (range: { from: ScheduleBoundary; until: ScheduleBoundary }) => void
}

const parseScheduleBoundary = (value: string): ScheduleBoundary | undefined => {
  const separatorIndex = value.lastIndexOf('|')
  if (separatorIndex < 1) return undefined
  const edge = value.slice(separatorIndex + 1)
  if (edge !== 'start' && edge !== 'end') return undefined
  return {
    kind: 'schedule-item',
    scheduleItemId: value.slice(0, separatorIndex),
    edge,
  }
}

export function AssignmentRangeFields({
  idPrefix,
  stage,
  sections,
  calculatedItems,
  boundaryOptions,
  from,
  until,
  invalid,
  onChange,
}: AssignmentRangeFieldsProps) {
  const mode = getAssignmentRangeMode(from, until)
  const boundaryOptionValues = new Set(boundaryOptions.map((option) => option.value))
  const fromBoundaryValue = isScheduleItemBoundary(from)
    ? `${from.scheduleItemId}|${from.edge}`
    : ''
  const untilBoundaryValue = isScheduleItemBoundary(until)
    ? `${until.scheduleItemId}|${until.edge}`
    : ''
  const hasValidFromBoundary = boundaryOptionValues.has(fromBoundaryValue)
  const hasValidUntilBoundary = boundaryOptionValues.has(untilBoundaryValue)
  const stageSections = sections
    .filter((section) => section.stageId === stage?.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const sectionId = isSectionBoundary(from) && isSectionBoundary(until) &&
    from.sectionId === until.sectionId ? from.sectionId : ''
  const hasValidSection = stageSections.some((section) => section.id === sectionId)

  const changeMode = (nextMode: AssignmentRangeMode) => {
    if (!stage) return
    const range = createDefaultAssignmentRange({
      mode: nextMode,
      stage,
      sections,
      calculatedItems,
    })
    if (range) onChange(range)
  }

  const changeSection = (nextSectionId: string, partial: boolean) => onChange({
    from: {
      kind: 'section', sectionId: nextSectionId, edge: 'start',
      ...(partial ? { offsetMinutes: 0 } : {}),
    },
    until: {
      kind: 'section', sectionId: nextSectionId, edge: 'end',
      ...(partial ? { offsetMinutes: 0 } : {}),
    },
  })

  return (
    <fieldset className="assignment-range-fields">
      <legend>担当範囲</legend>
      <label htmlFor={`${idPrefix}-range-mode`}>
        指定方法
        <select
          id={`${idPrefix}-range-mode`}
          value={mode ?? ''}
          aria-invalid={invalid ? 'true' : undefined}
          onChange={(event) => changeMode(event.target.value as AssignmentRangeMode)}
        >
          {!mode && <option value="" disabled>指定方法を選択してください</option>}
          <option value="schedule-item" disabled={boundaryOptions.length === 0}>
            タイムテーブル項目
          </option>
          <option value="section-whole" disabled={stageSections.length === 0}>セクション全体</option>
          <option value="section-partial" disabled={stageSections.length === 0}>セクション内の一部</option>
          <option value="time">時刻指定</option>
        </select>
      </label>

      {mode === 'schedule-item' && (
        <>
          <label htmlFor={`${idPrefix}-from`}>
            担当開始
            <select
              id={`${idPrefix}-from`}
              value={hasValidFromBoundary ? fromBoundaryValue : ''}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(event) => {
                const boundary = parseScheduleBoundary(event.target.value)
                if (boundary) onChange({ from: boundary, until })
              }}
            >
              {!hasValidFromBoundary && (
                <option value="" disabled>開始位置を選択してください（現在は参照切れ）</option>
              )}
              {boundaryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label htmlFor={`${idPrefix}-until`}>
            担当終了
            <select
              id={`${idPrefix}-until`}
              value={hasValidUntilBoundary ? untilBoundaryValue : ''}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(event) => {
                const boundary = parseScheduleBoundary(event.target.value)
                if (boundary) onChange({ from, until: boundary })
              }}
            >
              {!hasValidUntilBoundary && (
                <option value="" disabled>終了位置を選択してください（現在は参照切れ）</option>
              )}
              {boundaryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </>
      )}

      {(mode === 'section-whole' || mode === 'section-partial') && (
        <label htmlFor={`${idPrefix}-section`}>
          セクション
          <select
            id={`${idPrefix}-section`}
            value={hasValidSection ? sectionId : ''}
            aria-invalid={invalid ? 'true' : undefined}
            onChange={(event) => changeSection(
              event.target.value,
              mode === 'section-partial',
            )}
          >
            {!hasValidSection && (
              <option value="" disabled>セクションを選択してください（現在は参照切れ）</option>
            )}
            {stageSections.map((section) => (
              <option key={section.id} value={section.id}>{section.name}</option>
            ))}
          </select>
        </label>
      )}

      {mode === 'section-partial' && isSectionBoundary(from) &&
        isSectionBoundary(until) && (
        <>
          <label htmlFor={`${idPrefix}-start-offset`}>
            セクション開始から（分）
            <input
              id={`${idPrefix}-start-offset`}
              type="number"
              min="0"
              step="1"
              value={from.offsetMinutes ?? 0}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(event) => onChange({
                from: { ...from, offsetMinutes: Number(event.target.value) },
                until,
              })}
            />
          </label>
          <label htmlFor={`${idPrefix}-end-offset`}>
            セクション終了の（分前）
            <input
              id={`${idPrefix}-end-offset`}
              type="number"
              min="0"
              step="1"
              value={until.offsetMinutes ?? 0}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(event) => onChange({
                from,
                until: { ...until, offsetMinutes: Number(event.target.value) },
              })}
            />
          </label>
        </>
      )}

      {mode === 'time' && isTimeBoundary(from) && isTimeBoundary(until) && (
        <>
          <label htmlFor={`${idPrefix}-from-time`}>
            開始時刻
            <input
              id={`${idPrefix}-from-time`}
              type="time"
              value={from.time}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(event) => onChange({
                from: { kind: 'time', time: event.target.value }, until,
              })}
            />
          </label>
          <label htmlFor={`${idPrefix}-until-time`}>
            終了時刻
            <input
              id={`${idPrefix}-until-time`}
              type="time"
              value={until.time}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(event) => onChange({
                from, until: { kind: 'time', time: event.target.value },
              })}
            />
          </label>
        </>
      )}
    </fieldset>
  )
}
