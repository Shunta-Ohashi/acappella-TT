import { Draggable, Droppable } from '@hello-pangea/dnd'
import type { FormEvent } from 'react'
import type {
  PaRole,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
} from '../domain/models'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import type {
  TimetableWorkspacePaCoverage,
  TimetableWorkspaceRow,
  UnresolvedPaAssignment,
} from '../ui/timetableWorkspaceRows'
import {
  getSectionDroppableId,
  getStageDroppableId,
} from '../ui/timetableDnd'

interface TimetableGridProps {
  stage: Stage
  sections: Section[]
  rows: TimetableWorkspaceRow[]
  unresolvedPaAssignments: UnresolvedPaAssignment[]
  transitionMinutes: number
  breakDuration: number
  onBreakDurationChange: (durationMinutes: number) => void
  onAddBreak: (sectionId?: SectionId) => void
  onRemoveScheduleItem: (scheduleItemId: ScheduleItemId) => void
}

const timetableGridColumns = [
  { id: 'time', label: '時刻' },
  { id: 'performance', label: '出演' },
  { id: 'main-pa', label: 'Main PA' },
  { id: 'sub-pa', label: 'Sub PA' },
] as const

const issueLabels = (row: TimetableWorkspaceRow): string[] => [
  row.issueCounts.ERROR > 0 ? `ERROR ${row.issueCounts.ERROR}` : undefined,
  row.issueCounts.WARNING > 0
    ? `WARNING ${row.issueCounts.WARNING}`
    : undefined,
  row.issueCounts.INFO > 0 ? `INFO ${row.issueCounts.INFO}` : undefined,
].filter((label): label is string => label !== undefined)

const PaTimelineCell = ({
  role,
  coverage,
}: {
  role: PaRole
  coverage: TimetableWorkspacePaCoverage[]
}) => (
  <div className="timetable-grid__pa-cell" role="cell">
    {coverage.length === 0 ? (
      <span className="timetable-grid__pa-empty" aria-label={`${role} PA担当なし`}>
        —
      </span>
    ) : coverage.map((item) => (
      <div
        key={item.assignmentId}
        className={[
          'timetable-grid__pa-coverage',
          item.startsHere ? 'timetable-grid__pa-coverage--start' : '',
          item.endsHere ? 'timetable-grid__pa-coverage--end' : '',
        ].filter(Boolean).join(' ')}
        title={`${role === 'main' ? 'Main' : 'Sub'} PA: ${item.memberName}`}
      >
        <strong>{item.memberName}</strong>
        <small>{role === 'main' ? 'Main PA' : 'Sub PA'}</small>
      </div>
    ))}
  </div>
)

const TimetableRow = ({
  row,
  index,
  onRemoveScheduleItem,
}: {
  row: TimetableWorkspaceRow
  index: number
  onRemoveScheduleItem: (scheduleItemId: ScheduleItemId) => void
}) => {
  const labels = issueLabels(row)
  const isBreak = row.scheduleItem.kind === 'break'
  const itemLabel = row.scheduleItem.kind === 'break'
    ? row.scheduleItem.title
    : row.eventBand?.name ?? '不明なバンド'

  return (
    <Draggable draggableId={row.scheduleItem.id} index={index}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={[
            'timetable-grid__row',
            isBreak ? 'timetable-grid__row--break' : '',
            row.issueCounts.ERROR > 0 ? 'timetable-grid__row--error' : '',
            row.issueCounts.ERROR === 0 && row.issueCounts.WARNING > 0
              ? 'timetable-grid__row--warning'
              : '',
          ].filter(Boolean).join(' ')}
          role="row"
          style={provided.draggableProps.style}
        >
          <div className="timetable-grid__time" role="rowheader">
            <strong>
              {formatMinuteAsLocalTime(row.calculatedItem.plannedStartMinute)}
            </strong>
            <span>
              〜{formatMinuteAsLocalTime(row.calculatedItem.plannedEndMinute)}
            </span>
          </div>

          <div className="timetable-grid__item" role="cell">
            <div className="timetable-grid__item-heading">
              <span
                {...provided.dragHandleProps}
                className="timetable-grid__drag-handle"
                aria-label={`${itemLabel}を並べ替える`}
              >
                ⠿
              </span>
              <strong>{isBreak ? '休憩' : itemLabel}</strong>
              {labels.map((label) => (
                <span
                  key={label}
                  className={`timetable-grid__issue timetable-grid__issue--${label.split(' ')[0].toLowerCase()}`}
                >
                  {label}
                </span>
              ))}
            </div>

            {row.scheduleItem.kind === 'break' ? (
              <span className="timetable-grid__meta">
                {itemLabel}・{row.scheduleItem.durationMinutes}分
              </span>
            ) : (
              <>
                <span className="timetable-grid__members">
                  {row.memberNames.length > 0
                    ? row.memberNames.join(' / ')
                    : 'メンバー未登録'}
                </span>
                <div className="timetable-grid__meta-line">
                  <span>{row.eventBand?.durationMinutes ?? 0}分枠</span>
                  <span>{row.eventBand?.bandId ? '固定バンド' : '企画バンド'}</span>
                  {row.hasHardTimeCondition && <span>必須時間あり</span>}
                  {row.hasPreferredTimeCondition && <span>希望あり</span>}
                  {row.fixedPlacementLabels.map((label) => (
                    <span className="timetable-grid__fixed" key={label}>🔒 {label}</span>
                  ))}
                </div>
              </>
            )}

            <button
              type="button"
              className="timetable-grid__remove"
              aria-label={isBreak
                ? `${itemLabel}を削除`
                : `${itemLabel}を未配置バンドへ戻す`}
            onClick={() => onRemoveScheduleItem(row.scheduleItem.id)}
          >
              {isBreak ? '削除' : '戻す'}
            </button>
          </div>

          <PaTimelineCell role="main" coverage={row.paCoverage.main} />
          <PaTimelineCell role="sub" coverage={row.paCoverage.sub} />
        </div>
      )}
    </Draggable>
  )
}

export function TimetableGrid({
  stage,
  sections,
  rows,
  unresolvedPaAssignments,
  transitionMinutes,
  breakDuration,
  onBreakDurationChange,
  onAddBreak,
  onRemoveScheduleItem,
}: TimetableGridProps) {
  const orderedSections = [...sections].sort((first, second) =>
    first.order - second.order,
  )

  const renderBreakForm = (sectionId?: SectionId) => (
    <form
      className="timetable-grid__break-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        onAddBreak(sectionId)
      }}
    >
      <label>
        休憩（分）
        <input
          type="number"
          min="1"
          value={breakDuration}
          onChange={(event) => onBreakDurationChange(Number(event.target.value))}
        />
      </label>
      <button type="submit">＋ 休憩</button>
    </form>
  )

  const renderLane = (
    laneRows: TimetableWorkspaceRow[],
    droppableId: string,
    emptyMessage: string,
  ) => (
    <Droppable droppableId={droppableId}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className="timetable-grid__body"
          role="rowgroup"
        >
          {laneRows.map((row, index) => (
            <TimetableRow
              key={row.scheduleItem.id}
              row={row}
              index={index}
              onRemoveScheduleItem={onRemoveScheduleItem}
            />
          ))}
          {laneRows.length === 0 && (
            <div className="timetable-grid__empty" role="row">
              <span role="cell">{emptyMessage}</span>
            </div>
          )}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  )

  return (
    <section className="timetable-grid-wrap" aria-labelledby="timetable-grid-title">
      <header className="timetable-grid-titlebar">
        <div>
          <h3 id="timetable-grid-title">{stage.name}</h3>
          <span>転換 {transitionMinutes}分</span>
        </div>
        {orderedSections.length === 0 && renderBreakForm()}
      </header>

      {unresolvedPaAssignments.length > 0 && (
        <div className="timetable-grid__broken-pa" role="status">
          <strong>PA参照切れ {unresolvedPaAssignments.length}件</strong>
          <span>
            {unresolvedPaAssignments.map((assignment) =>
              `${assignment.role === 'main' ? 'Main' : 'Sub'} PA ${assignment.memberName}: ${assignment.reason}`,
            ).join(' / ')}
            {' '}PAパネルで担当範囲を修正または削除してください。
          </span>
        </div>
      )}

      <div className="timetable-grid" role="table" aria-label={`${stage.name}のタイムテーブル`}>
        <div className="timetable-grid__header" role="row">
          {timetableGridColumns.map((column) => (
            <span key={column.id} role="columnheader">{column.label}</span>
          ))}
        </div>

        {orderedSections.length > 0 ? orderedSections.map((section) => {
          const sectionRows = rows.filter((row) =>
            row.scheduleItem.sectionId === section.id,
          )
          return (
            <section className="timetable-grid__section" key={section.id}>
              <header className="timetable-grid__section-heading">
                <div>
                  <strong>{section.name}</strong>
                  {(section.plannedStartTime || section.plannedEndTime) && (
                    <span>
                      {section.plannedStartTime
                        ? `開始 ${section.plannedStartTime}`
                        : '前Sectionから継続'}
                      {section.plannedEndTime
                        ? ` / 終了 ${section.plannedEndTime}`
                        : ''}
                    </span>
                  )}
                </div>
                {renderBreakForm(section.id)}
              </header>
              {renderLane(
                sectionRows,
                getSectionDroppableId(section.id),
                'このSectionにはまだ項目がありません。',
              )}
            </section>
          )
        }) : renderLane(
          rows.filter((row) => row.scheduleItem.sectionId === undefined),
          getStageDroppableId(stage.id),
          'タイムテーブルに項目を配置してください。',
        )}
      </div>
    </section>
  )
}
