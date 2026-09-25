import { Draggable, Droppable } from '@hello-pangea/dnd'
import { Fragment, type CSSProperties, type FormEvent } from 'react'
import type {
  DutyType,
  EventBand,
  PaRole,
  ScheduleItem,
  ScheduleItemId,
  Section,
  SectionId,
  Stage,
  TimetableLock,
  TimetableLockId,
} from '../domain/models'
import {
  getTimetableLockLabel,
  type TimetableLockMode,
  type TimetableLockViolation,
} from '../domain/timetableLocks'
import {
  getTimetableLockControlAccessibleName,
  getTimetableLockRepairSummary,
  getTimetableLockUnlockAccessibleName,
  getUniqueLockIdsForViolation,
  TIMETABLE_LOCK_UNLOCK_VISIBLE_TEXT,
} from '../ui/timetableLockPresentation'
import { formatMinuteAsLocalTime } from '../domain/timeline'
import type {
  OffGridPaAssignment,
  OffGridDutyAssignment,
  TimetableWorkspaceDutyCoverage,
  TimetableWorkspacePaCoverage,
  TimetableWorkspaceRow,
  UnresolvedPaAssignment,
  UnresolvedDutyAssignment,
} from '../ui/timetableWorkspaceRows'
import { createTimetableGridColumns } from '../ui/timetableGridColumns'
import {
  getInterSectionDroppableId,
  getSectionDroppableId,
  getStageDroppableId,
} from '../ui/timetableDnd'

interface TimetableGridProps {
  stage: Stage
  sections: Section[]
  rows: TimetableWorkspaceRow[]
  unresolvedPaAssignments: UnresolvedPaAssignment[]
  offGridPaAssignments: OffGridPaAssignment[]
  dutyTypes: DutyType[]
  unresolvedDutyAssignments: UnresolvedDutyAssignment[]
  offGridDutyAssignments: OffGridDutyAssignment[]
  transitionMinutes: number
  breakDuration: number
  onBreakDurationChange: (durationMinutes: number) => void
  onAddBreak: (sectionId?: SectionId) => void
  onAddInterSectionBreak: (afterSectionId: SectionId) => void
  onRemoveScheduleItem: (scheduleItemId: ScheduleItemId) => void
  timetableLocks: TimetableLock[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
  lockViolations: TimetableLockViolation[]
  lockFeedback: string
  onSetTimetableLock: (
    scheduleItemId: ScheduleItemId,
    mode: TimetableLockMode,
  ) => void
  onUnlockTimetableLock: (lockId: TimetableLockId) => void
  onUnlockAllTimetableLocks: () => void
}

export function TimetableLockRepairPanel({
  violations,
  timetableLocks,
  scheduleItems,
  eventBands,
  onUnlockTimetableLock,
}: {
  violations: TimetableLockViolation[]
  timetableLocks: TimetableLock[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
  onUnlockTimetableLock: (lockId: TimetableLockId) => void
}) {
  const repairSummary = getTimetableLockRepairSummary(violations)
  if (!repairSummary.visible) return null

  return (
    <section className="timetable-grid__broken-locks" role="alert">
      <strong>修復が必要なTT固定 {repairSummary.affectedLockIds.length}件</strong>
      <ul>
        {violations.map((violation, index) => (
          <li key={`${violation.code}-${violation.lockIds.join('-')}-${index}`}>
            <span>{violation.message}</span>
            {getUniqueLockIdsForViolation(violation).map((lockId) => (
              <button
                type="button"
                key={lockId}
                aria-label={getTimetableLockUnlockAccessibleName({
                  lockId,
                  timetableLocks,
                  scheduleItems,
                  eventBands,
                })}
                onClick={() => onUnlockTimetableLock(lockId)}
              >
                {TIMETABLE_LOCK_UNLOCK_VISIBLE_TEXT}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </section>
  )
}

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
      </div>
    ))}
  </div>
)

const DutyTimelineCell = ({
  dutyType,
  coverage,
}: {
  dutyType: DutyType
  coverage: TimetableWorkspaceDutyCoverage[]
}) => (
  <div className="timetable-grid__duty-cell" role="cell">
    {coverage.length === 0 ? (
      <span
        className="timetable-grid__duty-empty"
        aria-label={`${dutyType.name}担当なし`}
      >
        —
      </span>
    ) : coverage.map((item) => {
      const hasError = item.issueCounts.ERROR > 0
      const hasWarning = item.issueCounts.WARNING > 0
      return (
        <div
          key={item.assignmentId}
          className={[
            'timetable-grid__duty-coverage',
            item.startsHere ? 'timetable-grid__duty-coverage--start' : '',
            item.endsHere ? 'timetable-grid__duty-coverage--end' : '',
            hasError ? 'timetable-grid__duty-coverage--error' : '',
          ].filter(Boolean).join(' ')}
          title={`${dutyType.name}: ${item.memberName}`}
        >
          <strong>{item.memberName}</strong>
          {(hasError || hasWarning) && (
            <small>{hasError ? 'ERROR' : 'WARNING'}</small>
          )}
        </div>
      )
    })}
  </div>
)

const TimetableRow = ({
  row,
  index,
  onRemoveScheduleItem,
  dutyTypes,
  timetableLock,
  onSetTimetableLock,
  onUnlockTimetableLock,
}: {
  row: TimetableWorkspaceRow
  index: number
  onRemoveScheduleItem: (scheduleItemId: ScheduleItemId) => void
  dutyTypes: DutyType[]
  timetableLock?: TimetableLock
  onSetTimetableLock: (
    scheduleItemId: ScheduleItemId,
    mode: TimetableLockMode,
  ) => void
  onUnlockTimetableLock: (lockId: TimetableLockId) => void
}) => {
  const labels = issueLabels(row)
  const isBreak = row.scheduleItem.kind === 'break'
  const itemLabel = row.scheduleItem.kind === 'break'
    ? row.scheduleItem.title
    : row.eventBand?.name ?? '不明なバンド'

  return (
    <Draggable
      draggableId={row.scheduleItem.id}
      index={index}
      isDragDisabled={timetableLock !== undefined}
    >
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
                aria-label={timetableLock
                  ? `${itemLabel}はTT固定中です`
                  : `${itemLabel}を並べ替える`}
              >
                {timetableLock ? '🔒' : '⠿'}
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
              <button
                type="button"
                className="timetable-grid__remove"
                aria-label={isBreak
                  ? `${itemLabel}を削除`
                  : `${itemLabel}を未配置バンドへ戻す`}
                disabled={timetableLock !== undefined}
                title={timetableLock ? '先にTT固定を解除してください。' : undefined}
                onClick={() => onRemoveScheduleItem(row.scheduleItem.id)}
              >
                {isBreak ? '削除' : '戻す'}
              </button>
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
                    <span className="timetable-grid__fixed" key={label}>
                      📌 必須条件：{label}
                    </span>
                  ))}
                  {timetableLock && (
                    <span className="timetable-grid__lock-badge">
                      🔒 TT固定：{getTimetableLockLabel(timetableLock)}
                    </span>
                  )}
                  <label className="timetable-grid__lock-control">
                    <span aria-hidden="true">{timetableLock ? '🔒' : '🔓'}</span>
                    <span className="visually-hidden">TT固定</span>
                    <select
                      aria-label={getTimetableLockControlAccessibleName(itemLabel)}
                      value={timetableLock
                        ? timetableLock.position.kind === 'index'
                          ? 'current'
                          : timetableLock.position.kind
                        : ''}
                      onChange={(event) => {
                        const mode = event.target.value
                        if (!mode && timetableLock) {
                          onUnlockTimetableLock(timetableLock.id)
                        } else if (mode === 'current' || mode === 'first' || mode === 'last') {
                          onSetTimetableLock(row.scheduleItem.id, mode)
                        }
                      }}
                    >
                      <option value="">
                        {timetableLock ? 'TT固定を解除' : '固定なし'}
                      </option>
                      <option value="current">現在の並び順を固定</option>
                      <option value="first">トッパーにして固定</option>
                      <option value="last">トリにして固定</option>
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>

          <PaTimelineCell role="main" coverage={row.paCoverage.main} />
          <PaTimelineCell role="sub" coverage={row.paCoverage.sub} />
          {dutyTypes.map((dutyType) => (
            <DutyTimelineCell
              key={dutyType.id}
              dutyType={dutyType}
              coverage={row.dutyCoverage[dutyType.id] ?? []}
            />
          ))}
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
  offGridPaAssignments,
  dutyTypes,
  unresolvedDutyAssignments,
  offGridDutyAssignments,
  transitionMinutes,
  breakDuration,
  onBreakDurationChange,
  onAddBreak,
  onAddInterSectionBreak,
  onRemoveScheduleItem,
  timetableLocks,
  scheduleItems,
  eventBands,
  lockViolations,
  lockFeedback,
  onSetTimetableLock,
  onUnlockTimetableLock,
  onUnlockAllTimetableLocks,
}: TimetableGridProps) {
  const timetableGridColumns = createTimetableGridColumns(dutyTypes)
  const gridTemplateColumns = timetableGridColumns
    .map((column) => `${column.width}px`)
    .join(' ')
  const gridMinWidth = timetableGridColumns
    .reduce((total, column) => total + column.width, 0)
  const gridStyle = {
    '--timetable-grid-columns': gridTemplateColumns,
    '--timetable-grid-min-width': `${gridMinWidth}px`,
  } as CSSProperties
  const orderedSections = [...sections].sort((first, second) =>
    first.order - second.order,
  )
  const timetableLockByScheduleItemId = new Map(
    timetableLocks.map((lock) => [lock.scheduleItemId, lock]),
  )

  const renderBreakForm = (
    targetName: string,
    sectionId?: SectionId,
  ) => (
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
      <button type="submit" aria-label={`${targetName}に休憩を追加`}>
        ＋ 休憩
      </button>
    </form>
  )

  const renderInterSectionBreakForm = (
    previousSection: Section,
    nextSection: Section,
  ) => (
    <form
      className="timetable-grid__break-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        onAddInterSectionBreak(previousSection.id)
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
      <button
        type="submit"
        aria-label={`${previousSection.name}と${nextSection.name}の間に休憩を追加`}
      >
        ＋ 休憩を追加
      </button>
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
              dutyTypes={dutyTypes}
              timetableLock={timetableLockByScheduleItemId.get(row.scheduleItem.id)}
              onSetTimetableLock={onSetTimetableLock}
              onUnlockTimetableLock={onUnlockTimetableLock}
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
    <section
      className="timetable-grid-wrap"
      aria-labelledby="timetable-grid-title"
      style={gridStyle}
    >
      <header className="timetable-grid-titlebar">
        <div>
          <h3 id="timetable-grid-title">{stage.name}</h3>
          <span>転換 {transitionMinutes}分</span>
        </div>
        {orderedSections.length === 0 && renderBreakForm(stage.name)}
        {timetableLocks.length > 0 && (
          <button
            type="button"
            className="secondary-button"
            onClick={onUnlockAllTimetableLocks}
          >
            すべてのTT固定を解除
          </button>
        )}
      </header>

      {lockFeedback && (
        <p className="timetable-grid__lock-feedback" role="status">
          {lockFeedback}
        </p>
      )}

      <TimetableLockRepairPanel
        violations={lockViolations}
        timetableLocks={timetableLocks}
        scheduleItems={scheduleItems}
        eventBands={eventBands}
        onUnlockTimetableLock={onUnlockTimetableLock}
      />

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

      {offGridPaAssignments.length > 0 && (
        <div className="timetable-grid__off-grid-pa" role="status">
          <strong>Grid外PA担当 {offGridPaAssignments.length}件</strong>
          <ul>
            {offGridPaAssignments.map((assignment) => (
              <li key={assignment.assignmentId}>
                {assignment.role === 'main' ? 'Main PA' : 'Sub PA'}{' '}
                {assignment.memberName}{' '}
                {formatMinuteAsLocalTime(assignment.fromMinute)}〜
                {formatMinuteAsLocalTime(assignment.untilMinute)}
                （ScheduleItem間の時間帯）
              </li>
            ))}
          </ul>
          <span>詳細の確認・編集は右のPA設定を利用してください。</span>
        </div>
      )}

      {unresolvedDutyAssignments.length > 0 && (
        <div className="timetable-grid__broken-duty" role="status">
          <strong>一般業務の参照切れ {unresolvedDutyAssignments.length}件</strong>
          <span>
            {unresolvedDutyAssignments.map((assignment) =>
              `${assignment.dutyTypeName} ${assignment.memberName}: ${assignment.reason}`,
            ).join(' / ')}
            {' '}当日運営パネルで担当範囲を修正または削除してください。
          </span>
        </div>
      )}

      {offGridDutyAssignments.length > 0 && (
        <div className="timetable-grid__off-grid-duty" role="status">
          <strong>Grid外の一般業務担当 {offGridDutyAssignments.length}件</strong>
          <ul>
            {offGridDutyAssignments.map((assignment) => (
              <li key={assignment.assignmentId}>
                {assignment.dutyTypeName}・{assignment.memberName}{' '}
                {formatMinuteAsLocalTime(assignment.fromMinute)}〜
                {formatMinuteAsLocalTime(assignment.untilMinute)}
                （ScheduleItem間の時間帯）
              </li>
            ))}
          </ul>
          <span>詳細の確認・編集は右の当日運営を利用してください。</span>
        </div>
      )}

      <div className="timetable-grid" role="table" aria-label={`${stage.name}のタイムテーブル`}>
        <div className="timetable-grid__header" role="row">
          {timetableGridColumns.map((column) => (
            <span key={column.id} role="columnheader" title={column.label}>
              {column.label}
            </span>
          ))}
        </div>

        {orderedSections.length > 0 ? orderedSections.map((section, index) => {
          const sectionRows = rows.filter((row) =>
            row.scheduleItem.sectionId === section.id,
          )
          const nextSection = orderedSections[index + 1]
          const interSectionRows = rows.filter((row) =>
            row.scheduleItem.kind === 'break' &&
            row.scheduleItem.afterSectionId === section.id,
          )
          return (
            <Fragment key={section.id}>
              <section className="timetable-grid__section">
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
                  {renderBreakForm(section.name, section.id)}
                </header>
                {renderLane(
                  sectionRows,
                  getSectionDroppableId(section.id),
                  'このSectionにはまだ項目がありません。',
                )}
              </section>
              {nextSection && (
                <section className="timetable-grid__inter-section-breaks">
                  <header className="timetable-grid__inter-section-heading">
                    <div>
                      <strong>部間休憩</strong>
                      <span>{section.name} と {nextSection.name} の間</span>
                    </div>
                    {renderInterSectionBreakForm(section, nextSection)}
                  </header>
                  {renderLane(
                    interSectionRows,
                    getInterSectionDroppableId(section.id),
                    '部間休憩はありません。',
                  )}
                </section>
              )}
            </Fragment>
          )
        }) : renderLane(
          rows.filter((row) =>
            row.scheduleItem.sectionId === undefined &&
            (row.scheduleItem.kind !== 'break' ||
              row.scheduleItem.afterSectionId === undefined),
          ),
          getStageDroppableId(stage.id),
          'タイムテーブルに項目を配置してください。',
        )}
      </div>
    </section>
  )
}
