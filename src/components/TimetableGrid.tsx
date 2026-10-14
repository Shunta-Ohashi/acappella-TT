import { Draggable, Droppable, type DraggableProvided } from '@hello-pangea/dnd'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import type { IssueSeverity, ScheduleIssue } from '../domain/issues'
import type {
  DutyType,
  EventBand,
  Member,
  MemberId,
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
import {
  formatMinuteAsLocalTime,
  type CalculatedScheduleItem,
} from '../domain/timeline'
import type {
  OffGridPaAssignment,
  OffGridDutyAssignment,
  TimetableWorkspaceDutyCoverage,
  TimetableWorkspacePaCoverage,
  TimetableWorkspaceRow,
  UnresolvedPaAssignment,
  UnresolvedDutyAssignment,
} from '../ui/timetableWorkspaceRows'
import {
  createTimetableGridColumns,
  createTimetableMemberMatrixColumns,
  type TimetableGridColumn,
} from '../ui/timetableGridColumns'
import {
  countTimetableMemberAppearances,
  getTimetableMemberColumnCount,
  getTimetableMemberCellAccessibleLabel,
  type TimetableViewMode,
} from '../ui/timetableMemberMatrixPresentation'
import {
  createTimetableMemberColorMap,
  type TimetableMemberColor,
  type TimetableMemberColorAssignment,
  type TimetableMemberColorCandidate,
} from '../ui/timetableMemberColorSettings'
import { TimetableMemberColorSettings } from './TimetableMemberColorSettings'
import { getInterSectionBreakPresentation } from '../ui/interSectionBreakPresentation'
import {
  getInterSectionDroppableId,
  getSectionDroppableId,
  getStageDroppableId,
} from '../ui/timetableDnd'
import {
  areTimetableGridAssignmentTargetsEqual,
  getTimetableGridAssignmentTargetLabel,
  resolveTimetableGridSelection,
  selectTimetableGridCell,
  updateTimetableGridDragFocus,
  type TimetableGridAssignmentTarget,
  type TimetableGridRangeSelection,
} from '../ui/timetableGridSelection'
import { getTimetableGridSelectionAssignmentTargets } from '../ui/timetableGridAssignment'
import {
  getTimetableOrderConstraintBlockMember,
  type TimetableOrderConstraintBlockMemberPresentation,
  type TimetableOrderConstraintBlockPresentation,
} from '../ui/timetableOrderConstraintLinkPresentation'
import {
  createScheduleIssueDetailPresentation,
} from '../ui/issuePresentation'
import {
  createTimetableGridOverlayRevision,
  formatTimetableTimeCondition,
  getIssueBadgeTooltip,
  getScheduleItemIssuesBySeverity,
} from '../ui/timetableGridDetailsPresentation'
import {
  TimetableGridDetailsPopover,
  TimetableGridRowActionsMenu,
  TimetableGridTooltip,
} from './TimetableGridDetailsPopover'

interface TimetableGridProps {
  stage: Stage
  sections: Section[]
  rows: TimetableWorkspaceRow[]
  issues: ScheduleIssue[]
  issueStages: Stage[]
  issueSections: Section[]
  issueCalculatedItems: CalculatedScheduleItem[]
  unresolvedPaAssignments: UnresolvedPaAssignment[]
  offGridPaAssignments: OffGridPaAssignment[]
  dutyTypes: DutyType[]
  unresolvedDutyAssignments: UnresolvedDutyAssignment[]
  offGridDutyAssignments: OffGridDutyAssignment[]
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
  orderConstraintFeedback: string
  orderConstraintBlocks: TimetableOrderConstraintBlockPresentation[]
  activeOrderConstraintBlockKey: string | null
  onOrderConstraintBlockHighlightChange: (blockKey: string | null) => void
  onSetTimetableLock: (
    scheduleItemId: ScheduleItemId,
    mode: TimetableLockMode,
  ) => void
  onUnlockTimetableLock: (lockId: TimetableLockId) => void
  onUnlockAllTimetableLocks: () => void
  selection: TimetableGridRangeSelection | null
  onSelectionChange: (selection: TimetableGridRangeSelection | null) => void
  assignmentFeedback: { kind: 'success' | 'error'; message: string } | null
  onAssignSelection: () => void
  onAutoAssignSelection: () => void
  onDeleteSelectionAssignments: () => void
  viewMode: TimetableViewMode
  highlightedMemberId: MemberId | null
  highlightedMemberName?: string
  onHighlightedMemberChange: (memberId: MemberId | null) => void
  members: readonly Member[]
  memberColorCandidates: readonly TimetableMemberColorCandidate[]
  memberColorAssignments: readonly TimetableMemberColorAssignment[]
  memberColorEventDayLabel?: string
  memberColorPersistenceWarning?: string
  onAddMemberColor: (memberId: MemberId) => void
  onChangeMemberColor: (memberId: MemberId, colorId: string) => void
  onRemoveMemberColor: (memberId: MemberId) => void
  onClearMemberColors: () => void
  readOnly?: boolean
}

type TimetableGridRowDetailKind =
  | 'issue-error'
  | 'issue-warning'
  | 'issue-info'
  | 'available-time'
  | 'preferred-time'

interface TimetableGridActiveDetails {
  rowId: ScheduleItemId
  kind: TimetableGridRowDetailKind
  anchor: HTMLElement
  epoch: number
}

interface TimetableGridActiveTooltip {
  key: string
  anchor: HTMLElement
  text: string
  epoch?: number
}

interface TimetableGridActiveRowActions {
  rowId: ScheduleItemId
  anchor: HTMLElement
  epoch: number
}

const severityByDetailKind: Partial<
  Record<TimetableGridRowDetailKind, IssueSeverity>
> = {
  'issue-error': 'ERROR',
  'issue-warning': 'WARNING',
  'issue-info': 'INFO',
}

const getRowDetailKey = (
  rowId: ScheduleItemId,
  kind: TimetableGridRowDetailKind,
): string => `${rowId}:${kind}`

const getMemberColorStyle = (
  color: TimetableMemberColor | undefined,
): CSSProperties | undefined => color ? {
  '--timetable-member-color-background': color.background,
  '--timetable-member-color-border': color.border,
  '--timetable-member-color-text': color.text,
} as CSSProperties : undefined

export function TimetableLockRepairPanel({
  violations,
  timetableLocks,
  scheduleItems,
  eventBands,
  onUnlockTimetableLock,
  readOnly = false,
}: {
  violations: TimetableLockViolation[]
  timetableLocks: TimetableLock[]
  scheduleItems: ScheduleItem[]
  eventBands: EventBand[]
  onUnlockTimetableLock: (lockId: TimetableLockId) => void
  readOnly?: boolean
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
            {!readOnly && getUniqueLockIdsForViolation(violation).map((lockId) => (
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

interface TimetableGridIssueBadge {
  severity: IssueSeverity
  count: number
  label: string
  detailKind: TimetableGridRowDetailKind
}

const issueBadges = (row: TimetableWorkspaceRow): TimetableGridIssueBadge[] =>
  (['ERROR', 'WARNING', 'INFO'] as const).flatMap((severity) => {
    const count = row.issueCounts[severity]
    if (count === 0) return []
    return [{
      severity,
      count,
      label: `${severity} ${count}`,
      detailKind: `issue-${severity.toLowerCase()}` as TimetableGridRowDetailKind,
    }]
  })

interface TimetableGridDetailTriggerProps {
  detailKey: string
  compactLabel: string
  accessibleLabel: string
  tooltip: string
  className: string
  tooltipId: string
  activeTooltipKey?: string
  onOpen: (anchor: HTMLElement) => void
  onShowTooltip: (tooltip: TimetableGridActiveTooltip) => void
  onHideTooltip: (detailKey: string) => void
}

const TimetableGridDetailTrigger = ({
  detailKey,
  compactLabel,
  accessibleLabel,
  tooltip,
  className,
  tooltipId,
  activeTooltipKey,
  onOpen,
  onShowTooltip,
  onHideTooltip,
}: TimetableGridDetailTriggerProps) => {
  const showTooltip = (anchor: HTMLElement) => onShowTooltip({
    key: detailKey,
    anchor,
    text: tooltip,
  })

  return (
    <button
      type="button"
      className={className}
      aria-label={accessibleLabel}
      aria-haspopup="dialog"
      aria-describedby={activeTooltipKey === detailKey ? tooltipId : undefined}
      onPointerDown={event => event.stopPropagation()}
      onMouseEnter={event => showTooltip(event.currentTarget)}
      onMouseLeave={() => onHideTooltip(detailKey)}
      onFocus={event => showTooltip(event.currentTarget)}
      onBlur={() => onHideTooltip(detailKey)}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onHideTooltip(detailKey)
        onOpen(event.currentTarget)
      }}
    >
      {compactLabel}
    </button>
  )
}

interface AssignmentCellInteractionProps {
  row: TimetableWorkspaceRow
  target: TimetableGridAssignmentTarget
  targetLabel: string
  currentAssignmentLabel?: string
  selected: boolean
  rangeStart: boolean
  rangeEnd: boolean
  onPointerDown: (
    event: PointerEvent<HTMLDivElement>,
    row: TimetableWorkspaceRow,
    target: TimetableGridAssignmentTarget,
  ) => void
  onPointerEnter: (
    event: PointerEvent<HTMLDivElement>,
    row: TimetableWorkspaceRow,
  ) => void
  onPointerUp: () => void
  onKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    row: TimetableWorkspaceRow,
    target: TimetableGridAssignmentTarget,
  ) => void
  readOnly: boolean
}

const getAssignmentCellProps = (
  className: string,
  interaction: AssignmentCellInteractionProps,
) => ({
  className: [
    className,
    'timetable-grid__assignment-cell',
    interaction.selected ? 'timetable-grid__assignment-cell--selected' : '',
    interaction.rangeStart ? 'timetable-grid__assignment-cell--range-start' : '',
    interaction.rangeEnd ? 'timetable-grid__assignment-cell--range-end' : '',
  ].filter(Boolean).join(' '),
  role: 'cell',
  tabIndex: interaction.readOnly ? undefined : 0,
  'aria-label': `${interaction.targetLabel} ${formatMinuteAsLocalTime(interaction.row.calculatedItem.plannedStartMinute)}〜${formatMinuteAsLocalTime(interaction.row.calculatedItem.plannedEndMinute)}を選択${interaction.selected ? '（選択中）' : ''}${interaction.currentAssignmentLabel ? `。現在の担当: ${interaction.currentAssignmentLabel}` : ''}`,
  onPointerDown: interaction.readOnly ? undefined : (event: PointerEvent<HTMLDivElement>) =>
    interaction.onPointerDown(event, interaction.row, interaction.target),
  onPointerEnter: interaction.readOnly ? undefined : (event: PointerEvent<HTMLDivElement>) =>
    interaction.onPointerEnter(event, interaction.row),
  onPointerUp: interaction.readOnly ? undefined : interaction.onPointerUp,
  onKeyDown: interaction.readOnly ? undefined : (event: KeyboardEvent<HTMLDivElement>) =>
    interaction.onKeyDown(event, interaction.row, interaction.target),
})

const PaTimelineCell = ({
  role,
  coverage,
  interaction,
  highlightedMemberId,
  memberColorByMemberId,
}: {
  role: PaRole
  coverage: TimetableWorkspacePaCoverage[]
  interaction: AssignmentCellInteractionProps
  highlightedMemberId: MemberId | null
  memberColorByMemberId: ReadonlyMap<MemberId, TimetableMemberColor>
}) => (
  <div {...getAssignmentCellProps('timetable-grid__pa-cell', interaction)}>
    {coverage.length === 0 ? (
      <span className="timetable-grid__pa-empty" aria-label={`${role} PA担当なし`}>
        —
      </span>
    ) : coverage.map((item) => {
      const memberColor = memberColorByMemberId.get(item.memberId)
      return (
        <div
          key={item.assignmentId}
          className={[
            'timetable-grid__pa-coverage',
            item.startsHere ? 'timetable-grid__pa-coverage--start' : '',
            item.endsHere ? 'timetable-grid__pa-coverage--end' : '',
            memberColor ? 'timetable-grid__coverage--member-colored' : '',
            item.memberId === highlightedMemberId
              ? 'timetable-grid__coverage--member-highlight'
              : '',
          ].filter(Boolean).join(' ')}
          style={getMemberColorStyle(memberColor)}
          title={`${role === 'main' ? 'Main' : 'Sub'} PA: ${item.memberName}`}
        >
          <strong>{item.memberName}</strong>
          {memberColor && (
            <span className="visually-hidden">設定色あり</span>
          )}
          {item.memberId === highlightedMemberId && (
            <span className="visually-hidden">選択中のメンバー担当</span>
          )}
        </div>
      )
    })}
  </div>
)

const DutyTimelineCell = ({
  dutyType,
  coverage,
  interaction,
  highlightedMemberId,
  memberColorByMemberId,
}: {
  dutyType: DutyType
  coverage: TimetableWorkspaceDutyCoverage[]
  interaction: AssignmentCellInteractionProps
  highlightedMemberId: MemberId | null
  memberColorByMemberId: ReadonlyMap<MemberId, TimetableMemberColor>
}) => (
  <div {...getAssignmentCellProps('timetable-grid__duty-cell', interaction)}>
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
      const memberColor = memberColorByMemberId.get(item.memberId)
      return (
        <div
          key={item.assignmentId}
          className={[
            'timetable-grid__duty-coverage',
            item.startsHere ? 'timetable-grid__duty-coverage--start' : '',
            item.endsHere ? 'timetable-grid__duty-coverage--end' : '',
            hasError ? 'timetable-grid__duty-coverage--error' : '',
            memberColor ? 'timetable-grid__coverage--member-colored' : '',
            item.memberId === highlightedMemberId
              ? 'timetable-grid__coverage--member-highlight'
              : '',
          ].filter(Boolean).join(' ')}
          style={getMemberColorStyle(memberColor)}
          title={`${dutyType.name}: ${item.memberName}`}
        >
          <strong>{item.memberName}</strong>
          {memberColor && (
            <span className="visually-hidden">設定色あり</span>
          )}
          {item.memberId === highlightedMemberId && (
            <span className="visually-hidden">選択中のメンバー担当</span>
          )}
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
  assignmentCells,
  timetableLock,
  orderConstraintMember,
  activeOrderConstraintBlockKey,
  onOrderConstraintBlockHighlightChange,
  onSetTimetableLock,
  onUnlockTimetableLock,
  viewMode,
  memberColumnCount,
  highlightedMemberId,
  memberColorByMemberId,
  onHighlightedMemberChange,
  rowIssues,
  activeTooltipKey,
  tooltipId,
  onOpenDetails,
  onShowTooltip,
  onHideTooltip,
  rowActionsAnchor,
  onToggleRowActions,
  onCloseRowActions,
  getIssueMessage,
  readOnly,
}: {
  row: TimetableWorkspaceRow
  index: number
  onRemoveScheduleItem: (scheduleItemId: ScheduleItemId) => void
  assignmentCells: ReactNode
  timetableLock?: TimetableLock
  orderConstraintMember?: TimetableOrderConstraintBlockMemberPresentation
  activeOrderConstraintBlockKey: string | null
  onOrderConstraintBlockHighlightChange: (blockKey: string | null) => void
  onSetTimetableLock: (
    scheduleItemId: ScheduleItemId,
    mode: TimetableLockMode,
  ) => void
  onUnlockTimetableLock: (lockId: TimetableLockId) => void
  viewMode: TimetableViewMode
  memberColumnCount: number
  highlightedMemberId: MemberId | null
  memberColorByMemberId: ReadonlyMap<MemberId, TimetableMemberColor>
  onHighlightedMemberChange: (memberId: MemberId | null) => void
  rowIssues: ScheduleIssue[]
  activeTooltipKey?: string
  tooltipId: string
  onOpenDetails: (
    rowId: ScheduleItemId,
    kind: TimetableGridRowDetailKind,
    anchor: HTMLElement,
  ) => void
  onShowTooltip: (tooltip: TimetableGridActiveTooltip) => void
  onHideTooltip: (detailKey: string) => void
  rowActionsAnchor?: HTMLElement
  onToggleRowActions: (rowId: ScheduleItemId, anchor: HTMLElement) => void
  onCloseRowActions: (restoreFocus: boolean) => void
  getIssueMessage: (issue: ScheduleIssue) => string
  readOnly: boolean
}) => {
  const badges = issueBadges(row)
  const isBreak = row.scheduleItem.kind === 'break'
  const isMemberMatrix = viewMode === 'member-matrix'
  const containsHighlightedMember = isMemberMatrix &&
    highlightedMemberId !== null &&
    row.memberCells.some(member => member.memberId === highlightedMemberId)
  const itemLabel = row.scheduleItem.kind === 'break'
    ? row.scheduleItem.title
    : row.eventBand?.name ?? '不明なバンド'
  const issueMessagesBySeverity = new Map<IssueSeverity, string[]>(
    (['ERROR', 'WARNING', 'INFO'] as const).map(severity => [
      severity,
      rowIssues
        .filter(issue => issue.severity === severity)
        .map(getIssueMessage),
    ]),
  )
  const renderRemoveButton = () => (
    <button
      type="button"
      className="timetable-grid__remove"
      aria-label={isBreak
        ? `${itemLabel}を削除`
        : `${itemLabel}を未配置バンドへ戻す`}
      disabled={readOnly || timetableLock !== undefined}
      title={timetableLock ? '先にTT固定を解除してください。' : undefined}
      onClick={() => onRemoveScheduleItem(row.scheduleItem.id)}
    >
      {isBreak ? '削除' : 'プールへ戻す'}
    </button>
  )
  const renderMetaControls = () => row.scheduleItem.kind === 'break' ? (
    <span className="timetable-grid__meta">
      {itemLabel}・{row.scheduleItem.durationMinutes}分
    </span>
  ) : (
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
          disabled={readOnly}
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
  )

  return (
    <Draggable
      draggableId={row.scheduleItem.id}
      index={index}
      isDragDisabled={readOnly || timetableLock !== undefined}
    >
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={[
            'timetable-grid__row',
            isMemberMatrix ? 'timetable-grid__row--member-matrix' : '',
            snapshot.isDragging ? 'timetable-grid__row--dragging' : '',
            containsHighlightedMember
              ? 'timetable-grid__row--member-highlight'
              : '',
            isBreak ? 'timetable-grid__row--break' : '',
            row.issueCounts.ERROR > 0 ? 'timetable-grid__row--error' : '',
            row.issueCounts.ERROR === 0 && row.issueCounts.WARNING > 0
              ? 'timetable-grid__row--warning'
              : '',
            orderConstraintMember?.blockKey === activeOrderConstraintBlockKey
              ? 'timetable-grid__row--order-highlight'
              : '',
          ].filter(Boolean).join(' ')}
          role="row"
          style={provided.draggableProps.style}
        >
          <div
            className="timetable-grid__time"
            role="rowheader"
          >
            <strong>
              {formatMinuteAsLocalTime(row.calculatedItem.plannedStartMinute)}
            </strong>
            <span>
              〜{formatMinuteAsLocalTime(row.calculatedItem.plannedEndMinute)}
            </span>
          </div>

          <div
            className={[
              'timetable-grid__item',
              isMemberMatrix ? 'timetable-grid__item--matrix' : '',
            ].filter(Boolean).join(' ')}
            role="cell"
          >
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
              <strong title={itemLabel}>{isBreak ? '休憩' : itemLabel}</strong>
              {isMemberMatrix && !isBreak && row.eventBand && (
                <span
                  className="timetable-grid__compact-condition-indicators"
                  aria-label="配置条件"
                >
                  {row.fixedPlacementLabels.length > 0 && (
                    <span title={`必須条件: ${row.fixedPlacementLabels.join('、')}`}>📌</span>
                  )}
                  {row.eventBand.availableTimeRange && (
                    <TimetableGridDetailTrigger
                      detailKey={getRowDetailKey(row.scheduleItem.id, 'available-time')}
                      compactLabel="必"
                      accessibleLabel={`${itemLabel}の必須時間条件を表示`}
                      tooltip={formatTimetableTimeCondition(
                        row.eventBand.availableTimeRange,
                        'available',
                      ).summary}
                      className="timetable-grid__condition-trigger timetable-grid__condition-trigger--hard"
                      tooltipId={tooltipId}
                      activeTooltipKey={activeTooltipKey}
                      onOpen={anchor => onOpenDetails(
                        row.scheduleItem.id,
                        'available-time',
                        anchor,
                      )}
                      onShowTooltip={onShowTooltip}
                      onHideTooltip={onHideTooltip}
                    />
                  )}
                  {row.eventBand.preferredTimeRange && (
                    <TimetableGridDetailTrigger
                      detailKey={getRowDetailKey(row.scheduleItem.id, 'preferred-time')}
                      compactLabel="希"
                      accessibleLabel={`${itemLabel}の希望時間条件を表示`}
                      tooltip={formatTimetableTimeCondition(
                        row.eventBand.preferredTimeRange,
                        'preferred',
                      ).summary}
                      className="timetable-grid__condition-trigger timetable-grid__condition-trigger--preferred"
                      tooltipId={tooltipId}
                      activeTooltipKey={activeTooltipKey}
                      onOpen={anchor => onOpenDetails(
                        row.scheduleItem.id,
                        'preferred-time',
                        anchor,
                      )}
                      onShowTooltip={onShowTooltip}
                      onHideTooltip={onHideTooltip}
                    />
                  )}
                </span>
              )}
              {orderConstraintMember && (
                <span
                  className="timetable-order-block-badge"
                  title={orderConstraintMember.title}
                  aria-label={orderConstraintMember.title}
                  tabIndex={0}
                  onMouseEnter={() => onOrderConstraintBlockHighlightChange(
                    orderConstraintMember.blockKey,
                  )}
                  onMouseLeave={() => onOrderConstraintBlockHighlightChange(null)}
                  onFocus={() => onOrderConstraintBlockHighlightChange(
                    orderConstraintMember.blockKey,
                  )}
                  onBlur={() => onOrderConstraintBlockHighlightChange(null)}
                >
                  {isMemberMatrix ? '🔗' : `🔗 ${orderConstraintMember.badgeLabel}`}
                </span>
              )}
              {badges.map((badge) => isMemberMatrix ? (
                <TimetableGridDetailTrigger
                  key={badge.severity}
                  detailKey={getRowDetailKey(row.scheduleItem.id, badge.detailKind)}
                  compactLabel={`${badge.severity[0]}${badge.count}`}
                  accessibleLabel={`${itemLabel}の${badge.severity}を${badge.count}件表示`}
                  tooltip={getIssueBadgeTooltip(
                    badge.severity,
                    issueMessagesBySeverity.get(badge.severity) ?? [],
                  )}
                  className={`timetable-grid__issue timetable-grid__issue--${badge.severity.toLowerCase()}`}
                  tooltipId={tooltipId}
                  activeTooltipKey={activeTooltipKey}
                  onOpen={anchor => onOpenDetails(
                    row.scheduleItem.id,
                    badge.detailKind,
                    anchor,
                  )}
                  onShowTooltip={onShowTooltip}
                  onHideTooltip={onHideTooltip}
                />
              ) : (
                <span
                  key={badge.severity}
                  className={`timetable-grid__issue timetable-grid__issue--${badge.severity.toLowerCase()}`}
                  aria-label={badge.label}
                  title={badge.label}
                >
                  {badge.label}
                </span>
              ))}
              {!isMemberMatrix && renderRemoveButton()}
              {isMemberMatrix && (
                <div
                  className="timetable-grid__row-actions"
                >
                  <button
                    type="button"
                    aria-label={`${itemLabel}の詳細操作`}
                    aria-haspopup="dialog"
                    aria-expanded={rowActionsAnchor !== undefined}
                    title="詳細操作"
                    onPointerDown={event => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onToggleRowActions(row.scheduleItem.id, event.currentTarget)
                    }}
                  >
                    ⋯
                  </button>
                  {rowActionsAnchor && (
                    <TimetableGridRowActionsMenu
                      anchor={rowActionsAnchor}
                      accessibleLabel={`${itemLabel}の詳細操作`}
                      onClose={onCloseRowActions}
                    >
                      {renderMetaControls()}
                      {renderRemoveButton()}
                    </TimetableGridRowActionsMenu>
                  )}
                </div>
              )}
            </div>

            {!isMemberMatrix && (row.scheduleItem.kind === 'break' ? (
              renderMetaControls()
            ) : (
              <>
                <span className="timetable-grid__members">
                  {row.memberNames.length > 0
                    ? row.memberNames.join(' / ')
                    : 'メンバー未登録'}
                </span>
                {renderMetaControls()}
              </>
            ))}
          </div>

          {isMemberMatrix && Array.from(
            { length: memberColumnCount },
            (_, memberIndex) => {
              const member = row.memberCells[memberIndex]
              if (!member) {
                return (
                  <span
                    key={`empty-member-${memberIndex}`}
                    className="timetable-grid__member-cell timetable-grid__member-empty"
                    role="cell"
                    aria-label={`メンバー${memberIndex + 1} 未登録`}
                  />
                )
              }
              const isHighlighted = member.memberId === highlightedMemberId
              const memberColor = memberColorByMemberId.get(member.memberId)
              return (
                <div
                  key={`${member.memberId}:${memberIndex}`}
                  className="timetable-grid__member-cell"
                  role="cell"
                >
                  <button
                    type="button"
                    className={[
                      'timetable-grid__member-button',
                      memberColor ? 'timetable-grid__member-button--colored' : '',
                      isHighlighted ? 'timetable-grid__member-button--active' : '',
                      member.resolved ? '' : 'timetable-grid__member-button--unresolved',
                    ].filter(Boolean).join(' ')}
                    style={getMemberColorStyle(memberColor)}
                    aria-pressed={isHighlighted}
                    aria-label={getTimetableMemberCellAccessibleLabel({
                      displayName: member.displayName,
                      memberId: member.memberId,
                      resolved: member.resolved,
                      selected: isHighlighted,
                      ...(memberColor ? { colorLabel: memberColor.label } : {}),
                    })}
                    title={member.displayName}
                    disabled={!member.resolved}
                    onClick={() => onHighlightedMemberChange(member.memberId)}
                  >
                    {member.displayName}
                    {memberColor && (
                      <span className="visually-hidden">設定色あり</span>
                    )}
                  </button>
                </div>
              )
            },
          )}

          {assignmentCells}
        </div>
      )}
    </Draggable>
  )
}

const InterSectionBreakRow = ({
  row,
  index,
  previousSection,
  nextSection,
  columns,
  addBreakForm,
  onRemoveScheduleItem,
  timetableLock,
  assignmentCells,
  viewMode,
  memberColumnCount,
  rowIssues = [],
  activeTooltipKey,
  tooltipId,
  onOpenDetails,
  onShowTooltip,
  onHideTooltip,
  getIssueMessage,
  readOnly,
}: {
  row?: TimetableWorkspaceRow
  index: number
  previousSection: Section
  nextSection: Section
  columns: TimetableGridColumn[]
  addBreakForm?: ReactNode
  onRemoveScheduleItem: (scheduleItemId: ScheduleItemId) => void
  timetableLock?: TimetableLock
  assignmentCells?: ReactNode
  viewMode: TimetableViewMode
  memberColumnCount: number
  rowIssues?: ScheduleIssue[]
  activeTooltipKey?: string
  tooltipId: string
  onOpenDetails: (
    rowId: ScheduleItemId,
    kind: TimetableGridRowDetailKind,
    anchor: HTMLElement,
  ) => void
  onShowTooltip: (tooltip: TimetableGridActiveTooltip) => void
  onHideTooltip: (detailKey: string) => void
  getIssueMessage: (issue: ScheduleIssue) => string
  readOnly: boolean
}) => {
  const isMemberMatrix = viewMode === 'member-matrix'
  const item = row?.scheduleItem.kind === 'break' ? row.scheduleItem : undefined
  const presentation = getInterSectionBreakPresentation(previousSection, nextSection, columns, item)
  const badges = row ? issueBadges(row) : []
  const renderRow = (
    provided?: DraggableProvided,
    isDragging = false,
  ) => (
    <div
      ref={provided?.innerRef}
      {...provided?.draggableProps}
      role="row"
      className={[
        'timetable-grid__row', 'timetable-grid__row--break', 'timetable-grid__inter-section-row',
        isMemberMatrix ? 'timetable-grid__row--member-matrix' : '',
        isDragging ? 'timetable-grid__row--dragging' : '',
        row && row.issueCounts.ERROR > 0 ? 'timetable-grid__row--error' : '',
        row && row.issueCounts.ERROR === 0 && row.issueCounts.WARNING > 0
          ? 'timetable-grid__row--warning' : '',
      ].filter(Boolean).join(' ')}
      style={provided?.draggableProps.style}
    >
      <div
        className="timetable-grid__time"
        role="rowheader"
      >
        {row ? <>
          <strong>{formatMinuteAsLocalTime(row.calculatedItem.plannedStartMinute)}</strong>
          <span>〜{formatMinuteAsLocalTime(row.calculatedItem.plannedEndMinute)}</span>
        </> : <span aria-label="部間休憩の時刻未設定">—</span>}
      </div>
      <div
        className={row
          ? [
              'timetable-grid__item',
              'timetable-grid__inter-section-item',
              isMemberMatrix ? 'timetable-grid__item--matrix' : '',
            ].filter(Boolean).join(' ')
          : 'timetable-grid__inter-section-cell'}
        role="cell"
        {...(!row ? { 'aria-colspan': presentation.contentColumnSpan } : {})}
      >
        <div className="timetable-grid__inter-section-content">
          <div className="timetable-grid__inter-section-summary">
            {provided && <span
              {...provided.dragHandleProps}
              className="timetable-grid__drag-handle"
              aria-label={timetableLock
                ? `${presentation.sectionLabel}の休憩「${presentation.title}」はTT固定中です`
                : `${presentation.sectionLabel}の休憩「${presentation.title}」を並べ替える`}
            >{timetableLock ? '🔒' : '⠿'}</span>}
            <strong><span aria-hidden="true">☕ </span>部間休憩</strong>
            <span>{presentation.sectionLabel}</span>
            {presentation.title && <span className="timetable-grid__inter-section-title">{presentation.title}</span>}
            <span>{presentation.durationLabel}</span>
            {badges.map(badge => row && isMemberMatrix ? (
              <TimetableGridDetailTrigger
                key={badge.severity}
                detailKey={getRowDetailKey(row.scheduleItem.id, badge.detailKind)}
                compactLabel={`${badge.severity[0]}${badge.count}`}
                accessibleLabel={`${presentation.title}の${badge.severity}を${badge.count}件表示`}
                tooltip={getIssueBadgeTooltip(
                  badge.severity,
                  rowIssues
                    .filter(issue => issue.severity === badge.severity)
                    .map(getIssueMessage),
                )}
                className={`timetable-grid__issue timetable-grid__issue--${badge.severity.toLowerCase()}`}
                tooltipId={tooltipId}
                activeTooltipKey={activeTooltipKey}
                onOpen={anchor => onOpenDetails(
                  row.scheduleItem.id,
                  badge.detailKind,
                  anchor,
                )}
                onShowTooltip={onShowTooltip}
                onHideTooltip={onHideTooltip}
              />
            ) : (
              <span
                key={badge.severity}
                className={`timetable-grid__issue timetable-grid__issue--${badge.severity.toLowerCase()}`}
              >
                {badge.label}
              </span>
            ))}
            {item && <button
              type="button"
              className="timetable-grid__remove"
              aria-label={presentation.removeAccessibleName}
              disabled={readOnly || timetableLock !== undefined}
              title={timetableLock ? '先にTT固定を解除してください。' : undefined}
              onClick={() => onRemoveScheduleItem(item.id)}
            >削除</button>}
          </div>
          {addBreakForm && <div className="timetable-grid__inter-section-actions">{addBreakForm}</div>}
        </div>
      </div>
      {row && isMemberMatrix && Array.from(
        { length: memberColumnCount },
        (_, memberIndex) => (
          <span
            key={`inter-section-empty-member-${memberIndex}`}
            className="timetable-grid__member-cell timetable-grid__member-empty"
            role="cell"
            aria-label={`メンバー${memberIndex + 1} 対象外`}
          />
        ),
      )}
      {row && assignmentCells}
    </div>
  )
  return item ? (
    <Draggable draggableId={item.id} index={index} isDragDisabled={readOnly || timetableLock !== undefined}>
      {(provided, snapshot) => renderRow(provided, snapshot.isDragging)}
    </Draggable>
  ) : renderRow()
}

export function TimetableGrid({
  stage,
  sections,
  rows,
  issues,
  issueStages,
  issueSections,
  issueCalculatedItems,
  unresolvedPaAssignments,
  offGridPaAssignments,
  dutyTypes,
  unresolvedDutyAssignments,
  offGridDutyAssignments,
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
  orderConstraintFeedback,
  orderConstraintBlocks,
  activeOrderConstraintBlockKey,
  onOrderConstraintBlockHighlightChange,
  onSetTimetableLock,
  onUnlockTimetableLock,
  onUnlockAllTimetableLocks,
  selection,
  onSelectionChange,
  assignmentFeedback,
  onAssignSelection,
  onAutoAssignSelection,
  onDeleteSelectionAssignments,
  viewMode,
  highlightedMemberId,
  highlightedMemberName,
  onHighlightedMemberChange,
  members,
  memberColorCandidates,
  memberColorAssignments,
  memberColorEventDayLabel,
  memberColorPersistenceWarning,
  onAddMemberColor,
  onChangeMemberColor,
  onRemoveMemberColor,
  onClearMemberColors,
  readOnly = false,
}: TimetableGridProps) {
  const tooltipId = 'timetable-grid-row-detail-tooltip'
  const [activeDetails, setActiveDetails] = useState<
    TimetableGridActiveDetails | null
  >(null)
  const [activeTooltip, setActiveTooltip] = useState<
    TimetableGridActiveTooltip | null
  >(null)
  const [activeRowActions, setActiveRowActions] = useState<
    TimetableGridActiveRowActions | null
  >(null)
  const memberColumnCount = getTimetableMemberColumnCount(rows)
  const currentEventDayId = rows[0]?.calculatedItem.eventDayId
  const detailsDataRevision = createTimetableGridOverlayRevision({
    eventDayId: currentEventDayId,
    stageId: stage.id,
    viewMode,
    issues,
    rows: rows.map(row => ({
      id: row.scheduleItem.id,
      plannedStartMinute: row.calculatedItem.plannedStartMinute,
      plannedEndMinute: row.calculatedItem.plannedEndMinute,
      ...(row.eventBand?.availableTimeRange
        ? { availableTimeRange: row.eventBand.availableTimeRange }
        : {}),
      ...(row.eventBand?.preferredTimeRange
        ? { preferredTimeRange: row.eventBand.preferredTimeRange }
        : {}),
    })),
  })
  const [detailsRevisionState, setDetailsRevisionState] = useState({
    value: detailsDataRevision,
    epoch: 0,
  })
  let currentDetailsEpoch = detailsRevisionState.epoch
  if (detailsRevisionState.value !== detailsDataRevision) {
    currentDetailsEpoch += 1
    setDetailsRevisionState({
      value: detailsDataRevision,
      epoch: currentDetailsEpoch,
    })
    if (activeDetails !== null) setActiveDetails(null)
    if (activeTooltip !== null) setActiveTooltip(null)
    if (activeRowActions !== null) setActiveRowActions(null)
  }
  const timetableGridColumns = viewMode === 'member-matrix'
    ? createTimetableMemberMatrixColumns(dutyTypes, memberColumnCount)
    : createTimetableGridColumns(dutyTypes)
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
  const resolvedSelection = !readOnly && selection
    ? resolveTimetableGridSelection(selection, rows)
    : undefined
  const selectionAssignmentTargets = resolvedSelection
    ? getTimetableGridSelectionAssignmentTargets(resolvedSelection, rows)
    : []
  const hasInvalidSelection = selection !== null &&
    resolvedSelection === undefined
  const pointerSelectionRef = useRef<TimetableGridRangeSelection | null>(null)
  const highlightedAppearanceCount = highlightedMemberId
    ? countTimetableMemberAppearances(rows, highlightedMemberId)
    : 0
  const memberColorByMemberId = createTimetableMemberColorMap(
    viewMode === 'member-matrix' ? memberColorAssignments : [],
  )
  const issueContext = {
    members,
    eventBands,
    dutyTypes,
    stages: issueStages,
    sections: issueSections,
  }
  const activeDetailsRow = activeDetails
    ? rows.find(row => row.scheduleItem.id === activeDetails.rowId)
    : undefined
  const activeDetailsSeverity = activeDetails
    ? severityByDetailKind[activeDetails.kind]
    : undefined
  const activeDetailsIssues = activeDetailsRow && activeDetailsSeverity
    ? getScheduleItemIssuesBySeverity(
        issues,
        activeDetailsRow.scheduleItem.id,
        activeDetailsSeverity,
      )
    : []
  const activeTimeCondition = activeDetailsRow?.eventBand && activeDetails
    ? activeDetails.kind === 'available-time' &&
      activeDetailsRow.eventBand.availableTimeRange
      ? formatTimetableTimeCondition(
          activeDetailsRow.eventBand.availableTimeRange,
          'available',
        )
      : activeDetails.kind === 'preferred-time' &&
        activeDetailsRow.eventBand.preferredTimeRange
        ? formatTimetableTimeCondition(
            activeDetailsRow.eventBand.preferredTimeRange,
            'preferred',
          )
        : undefined
    : undefined
  const activeDetailsValid = activeDetails !== null &&
    activeDetails.epoch === currentDetailsEpoch && (
    activeDetailsSeverity
      ? activeDetailsIssues.length > 0
      : activeTimeCondition !== undefined
  )

  useEffect(() => {
    const finishPointerSelection = () => {
      pointerSelectionRef.current = null
    }
    window.addEventListener('pointerup', finishPointerSelection)
    window.addEventListener('pointercancel', finishPointerSelection)
    return () => {
      window.removeEventListener('pointerup', finishPointerSelection)
      window.removeEventListener('pointercancel', finishPointerSelection)
    }
  }, [])

  useEffect(() => {
    if (hasInvalidSelection) onSelectionChange(null)
  }, [hasInvalidSelection, onSelectionChange])

  const handleGridKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      viewMode !== 'member-matrix' ||
      highlightedMemberId === null ||
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) return

    const target = event.target
    if (target instanceof HTMLElement && (
      target.isContentEditable ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) ||
      target.closest('[role="dialog"]') !== null
    )) return

    event.preventDefault()
    onHighlightedMemberChange(null)
  }

  const handleOpenDetails = (
    rowId: ScheduleItemId,
    kind: TimetableGridRowDetailKind,
    anchor: HTMLElement,
  ) => {
    setActiveRowActions(null)
    setActiveTooltip(null)
    setActiveDetails({ rowId, kind, anchor, epoch: currentDetailsEpoch })
  }

  const handleCloseDetails = (restoreFocus = false) => {
    const anchor = activeDetails?.anchor
    setActiveDetails(null)
    if (restoreFocus) anchor?.focus()
  }

  const handleHideTooltip = (detailKey: string) => {
    setActiveTooltip(current => current?.key === detailKey ? null : current)
  }

  const handleShowTooltip = (tooltip: TimetableGridActiveTooltip) => {
    setActiveTooltip({ ...tooltip, epoch: currentDetailsEpoch })
  }

  const handleToggleRowActions = (
    rowId: ScheduleItemId,
    anchor: HTMLElement,
  ) => {
    setActiveDetails(null)
    setActiveTooltip(null)
    setActiveRowActions(current =>
      current?.rowId === rowId && current.epoch === currentDetailsEpoch
        ? null
        : { rowId, anchor, epoch: currentDetailsEpoch },
    )
  }

  const handleCloseRowActions = (restoreFocus = false) => {
    const anchor = activeRowActions?.anchor
    setActiveRowActions(null)
    if (restoreFocus) anchor?.focus()
  }

  const getRowIssues = (row: TimetableWorkspaceRow): ScheduleIssue[] =>
    issues.filter(issue =>
      issue.scheduleItemIds?.includes(row.scheduleItem.id) === true,
    )
  const getIssueMessage = (issue: ScheduleIssue): string =>
    createScheduleIssueDetailPresentation(
      issue,
      issueContext,
      issueCalculatedItems,
    ).message

  const updateSelection = (
    row: TimetableWorkspaceRow,
    target: TimetableGridAssignmentTarget,
    extend: boolean,
  ) => {
    onSelectionChange(selectTimetableGridCell({
      selection,
      eventDayId: row.calculatedItem.eventDayId,
      stageId: row.calculatedItem.stageId,
      target,
      scheduleItemId: row.scheduleItem.id,
      extend,
    }))
  }

  const handleAssignmentPointerDown = (
    event: PointerEvent<HTMLDivElement>,
    row: TimetableWorkspaceRow,
    target: TimetableGridAssignmentTarget,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    const nextSelection = selectTimetableGridCell({
      selection,
      eventDayId: row.calculatedItem.eventDayId,
      stageId: row.calculatedItem.stageId,
      target,
      scheduleItemId: row.scheduleItem.id,
      extend: event.shiftKey,
    })
    pointerSelectionRef.current = nextSelection
    onSelectionChange(nextSelection)
  }

  const handleAssignmentPointerEnter = (
    event: PointerEvent<HTMLDivElement>,
    row: TimetableWorkspaceRow,
  ) => {
    const pointerSelection = pointerSelectionRef.current
    if (!pointerSelection || (event.buttons & 1) === 0) return
    onSelectionChange(updateTimetableGridDragFocus(
      pointerSelection,
      row.scheduleItem.id,
    ))
  }

  const handleAssignmentKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    row: TimetableWorkspaceRow,
    target: TimetableGridAssignmentTarget,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onSelectionChange(null)
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    updateSelection(row, target, event.shiftKey)
  }

  const renderAssignmentCells = (row: TimetableWorkspaceRow) => {
    const selectedIndex = resolvedSelection?.scheduleItemIds.indexOf(
      row.scheduleItem.id,
    ) ?? -1
    const interactionFor = (
      target: TimetableGridAssignmentTarget,
      currentAssignmentLabel?: string,
    ): AssignmentCellInteractionProps => {
      const selected = selectedIndex >= 0 && selection !== null &&
        areTimetableGridAssignmentTargetsEqual(selection.target, target)
      return {
        row,
        target,
        targetLabel: getTimetableGridAssignmentTargetLabel(target, dutyTypes),
        ...(currentAssignmentLabel ? { currentAssignmentLabel } : {}),
        selected,
        rangeStart: selected && selectedIndex === 0,
        rangeEnd: selected && selectedIndex ===
          (resolvedSelection?.scheduleItemIds.length ?? 0) - 1,
        readOnly,
        onPointerDown: handleAssignmentPointerDown,
        onPointerEnter: handleAssignmentPointerEnter,
        onPointerUp: () => {
          pointerSelectionRef.current = null
        },
        onKeyDown: handleAssignmentKeyDown,
      }
    }

    return <>
      <PaTimelineCell
        role="main"
        coverage={row.paCoverage.main}
        memberColorByMemberId={memberColorByMemberId}
        highlightedMemberId={viewMode === 'member-matrix'
          ? highlightedMemberId
          : null}
        interaction={interactionFor(
          { kind: 'pa', role: 'main' },
          row.paCoverage.main.map((coverage) => coverage.memberName).join('、'),
        )}
      />
      <PaTimelineCell
        role="sub"
        coverage={row.paCoverage.sub}
        memberColorByMemberId={memberColorByMemberId}
        highlightedMemberId={viewMode === 'member-matrix'
          ? highlightedMemberId
          : null}
        interaction={interactionFor(
          { kind: 'pa', role: 'sub' },
          row.paCoverage.sub.map((coverage) => coverage.memberName).join('、'),
        )}
      />
      {dutyTypes.map((dutyType) => (
        <DutyTimelineCell
          key={dutyType.id}
          dutyType={dutyType}
          coverage={row.dutyCoverage[dutyType.id] ?? []}
          memberColorByMemberId={memberColorByMemberId}
          highlightedMemberId={viewMode === 'member-matrix'
            ? highlightedMemberId
            : null}
          interaction={interactionFor({
            kind: 'duty',
            dutyTypeId: dutyType.id,
          }, (row.dutyCoverage[dutyType.id] ?? [])
            .map((coverage) => coverage.memberName)
            .join('、'))}
        />
      ))}
    </>
  }

  const renderBreakForm = (
    targetName: string,
    sectionId?: SectionId,
  ) => readOnly ? null : (
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
  ) => readOnly ? null : (
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
    interSection?: { previousSection: Section; nextSection: Section },
  ) => (
    <Droppable droppableId={droppableId}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className="timetable-grid__body"
          role="rowgroup"
        >
          {laneRows.map((row, index) => interSection ? (
            <InterSectionBreakRow
              key={row.scheduleItem.id}
              row={row}
              index={index}
              {...interSection}
              columns={timetableGridColumns}
              addBreakForm={index === 0
                ? renderInterSectionBreakForm(interSection.previousSection, interSection.nextSection)
                : undefined}
              onRemoveScheduleItem={onRemoveScheduleItem}
              timetableLock={timetableLockByScheduleItemId.get(row.scheduleItem.id)}
              assignmentCells={renderAssignmentCells(row)}
              viewMode={viewMode}
              memberColumnCount={memberColumnCount}
              rowIssues={getRowIssues(row)}
              activeTooltipKey={activeTooltip?.key}
              tooltipId={tooltipId}
              onOpenDetails={handleOpenDetails}
              onShowTooltip={handleShowTooltip}
              onHideTooltip={handleHideTooltip}
              getIssueMessage={getIssueMessage}
              readOnly={readOnly}
            />
          ) : (
            <TimetableRow
              key={row.scheduleItem.id}
              row={row}
              index={index}
              onRemoveScheduleItem={onRemoveScheduleItem}
              assignmentCells={renderAssignmentCells(row)}
              timetableLock={timetableLockByScheduleItemId.get(row.scheduleItem.id)}
              orderConstraintMember={row.scheduleItem.kind === 'performance'
                ? getTimetableOrderConstraintBlockMember(
                    orderConstraintBlocks,
                    row.scheduleItem.eventBandId,
                  )
                : undefined}
              activeOrderConstraintBlockKey={activeOrderConstraintBlockKey}
              onOrderConstraintBlockHighlightChange={onOrderConstraintBlockHighlightChange}
              onSetTimetableLock={onSetTimetableLock}
              onUnlockTimetableLock={onUnlockTimetableLock}
              viewMode={viewMode}
              memberColumnCount={memberColumnCount}
              highlightedMemberId={highlightedMemberId}
              memberColorByMemberId={memberColorByMemberId}
              onHighlightedMemberChange={onHighlightedMemberChange}
              rowIssues={getRowIssues(row)}
              activeTooltipKey={activeTooltip?.key}
              tooltipId={tooltipId}
              onOpenDetails={handleOpenDetails}
              onShowTooltip={handleShowTooltip}
              onHideTooltip={handleHideTooltip}
              rowActionsAnchor={activeRowActions?.rowId === row.scheduleItem.id &&
                activeRowActions.epoch === currentDetailsEpoch
                ? activeRowActions.anchor
                : undefined}
              onToggleRowActions={handleToggleRowActions}
              onCloseRowActions={handleCloseRowActions}
              getIssueMessage={getIssueMessage}
              readOnly={readOnly}
            />
          ))}
          {laneRows.length === 0 && (interSection ? (
            <InterSectionBreakRow
              index={0}
              {...interSection}
              columns={timetableGridColumns}
              addBreakForm={renderInterSectionBreakForm(interSection.previousSection, interSection.nextSection)}
              onRemoveScheduleItem={onRemoveScheduleItem}
              viewMode={viewMode}
              memberColumnCount={memberColumnCount}
              activeTooltipKey={activeTooltip?.key}
              tooltipId={tooltipId}
              onOpenDetails={handleOpenDetails}
              onShowTooltip={handleShowTooltip}
              onHideTooltip={handleHideTooltip}
              getIssueMessage={getIssueMessage}
              readOnly={readOnly}
            />
          ) : (
            <div className="timetable-grid__empty" role="row">
              <span role="cell">{emptyMessage}</span>
            </div>
          ))}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  )

  return (
    <section
      className={[
        'timetable-grid-wrap',
        viewMode === 'member-matrix'
          ? 'timetable-grid-wrap--member-matrix'
          : '',
      ].filter(Boolean).join(' ')}
      aria-labelledby="timetable-grid-title"
      style={gridStyle}
      onKeyDown={handleGridKeyDown}
    >
      <header className="timetable-grid-titlebar">
        <div>
          <h3 id="timetable-grid-title">{stage.name}</h3>
        </div>
        {orderedSections.length === 0 && renderBreakForm(stage.name)}
        {!readOnly && timetableLocks.length > 0 && (
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

      {orderConstraintFeedback && (
        <p
          className="timetable-grid__order-constraint-feedback"
          role="alert"
          aria-live="polite"
        >
          {orderConstraintFeedback}
        </p>
      )}

      <TimetableLockRepairPanel
        violations={lockViolations}
        timetableLocks={timetableLocks}
        scheduleItems={scheduleItems}
        eventBands={eventBands}
        onUnlockTimetableLock={onUnlockTimetableLock}
        readOnly={readOnly}
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

      {!readOnly && <p className="timetable-grid__selection-hint">
        PA・当日運営のセルをドラッグ、またはShift+クリックすると担当範囲を選択できます。
      </p>}

      {assignmentFeedback && (
        <p
          className={`timetable-grid__assignment-feedback timetable-grid__assignment-feedback--${assignmentFeedback.kind}`}
          role={assignmentFeedback.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {assignmentFeedback.message}
        </p>
      )}

      {viewMode === 'member-matrix' && (
        <TimetableMemberColorSettings
          members={members}
          candidates={memberColorCandidates}
          assignments={memberColorAssignments}
          selectedEventDayLabel={memberColorEventDayLabel}
          persistenceWarning={memberColorPersistenceWarning}
          onAdd={onAddMemberColor}
          onColorChange={onChangeMemberColor}
          onRemove={onRemoveMemberColor}
          onClear={onClearMemberColors}
        />
      )}

      {viewMode === 'member-matrix' && highlightedMemberId && (
        <div
          className="timetable-grid__member-highlight-summary"
          aria-live="polite"
          role="status"
        >
          <span>
            <strong>強調中:</strong>{' '}
            {highlightedMemberName ?? '不明なメンバー'} / 出演
            {highlightedAppearanceCount}箇所
          </span>
          <button
            type="button"
            onClick={() => onHighlightedMemberChange(null)}
          >
            選択解除
          </button>
        </div>
      )}

      {resolvedSelection && (
        <div
          className="timetable-grid__selection-summary"
          aria-live="polite"
          role="status"
        >
          <span>
            <strong>選択中:</strong>{' '}
            {getTimetableGridAssignmentTargetLabel(
              resolvedSelection.target,
              dutyTypes,
            )}{' / '}
            {formatMinuteAsLocalTime(resolvedSelection.fromMinute)}〜
            {formatMinuteAsLocalTime(resolvedSelection.untilMinute)}{' / '}
            {resolvedSelection.rowCount}枠
          </span>
          <div className="timetable-grid__selection-actions">
            <button
              type="button"
              className="primary-button"
              onClick={onAssignSelection}
            >
              担当を設定
            </button>
            {resolvedSelection.target.kind === 'duty' && (
              <button
                type="button"
                className="secondary-button"
                onClick={onAutoAssignSelection}
              >
                自動割り当て
              </button>
            )}
            {selectionAssignmentTargets.length > 0 && (
              <button
                type="button"
                className="danger-button"
                onClick={onDeleteSelectionAssignments}
              >
                {selectionAssignmentTargets.length === 1
                  ? '現在の担当を削除'
                  : `選択範囲の担当を削除（${selectionAssignmentTargets.length}件）`}
              </button>
            )}
            <button type="button" onClick={() => onSelectionChange(null)}>
              選択解除
            </button>
          </div>
        </div>
      )}

      <div className="timetable-grid-scroll">
        <div
          className={[
            'timetable-grid',
            viewMode === 'member-matrix'
              ? 'timetable-grid--member-matrix'
              : '',
          ].filter(Boolean).join(' ')}
          role="table"
          aria-colcount={timetableGridColumns.length}
          aria-label={viewMode === 'member-matrix'
            ? `${stage.name}のメンバー一覧タイムテーブル`
            : `${stage.name}のタイムテーブル`}
        >
          <div className="timetable-grid__header" role="row">
            {timetableGridColumns.map((column) => (
              <span
                key={column.id}
                className={[
                  'timetable-grid__header-cell',
                  column.id.startsWith('member-')
                    ? 'timetable-grid__header-cell--member'
                    : '',
                ].filter(Boolean).join(' ')}
                role="columnheader"
                title={column.label}
              >
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
                    {renderLane(
                      interSectionRows,
                      getInterSectionDroppableId(section.id),
                      '部間休憩はありません。',
                      { previousSection: section, nextSection },
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
      </div>

      {activeTooltip &&
        activeTooltip.epoch === currentDetailsEpoch &&
        !activeDetailsValid && (
        <TimetableGridTooltip
          id={tooltipId}
          anchor={activeTooltip.anchor}
          text={activeTooltip.text}
          onDismiss={() => handleHideTooltip(activeTooltip.key)}
        />
      )}

      {activeDetails && activeDetailsValid && activeDetailsRow && (
        <TimetableGridDetailsPopover
          anchor={activeDetails.anchor}
          title={activeDetailsSeverity
            ? `${activeDetailsSeverity}の問題（${activeDetailsIssues.length}件）`
            : activeTimeCondition?.title ?? '詳細'}
          onClose={handleCloseDetails}
        >
          <p className="timetable-grid-details-popover__row-label">
            対象行:{' '}
            <strong>
              {activeDetailsRow.scheduleItem.kind === 'break'
                ? activeDetailsRow.scheduleItem.title
                : activeDetailsRow.eventBand?.name ?? '不明なバンド'}
            </strong>
          </p>
          {activeDetailsSeverity ? (
            <ul className="timetable-grid-details-popover__issue-list">
              {activeDetailsIssues.map((issue, index) => {
                const details = createScheduleIssueDetailPresentation(
                  issue,
                  issueContext,
                  issueCalculatedItems,
                )
                return (
                  <li
                    key={[
                      issue.code,
                      issue.memberIds?.join('-'),
                      issue.eventBandIds?.join('-'),
                      issue.scheduleItemIds?.join('-'),
                      index,
                    ].join('|')}
                  >
                    <div className="timetable-grid-details-popover__issue-heading">
                      <code>{issue.code}</code>
                      <strong>{details.message}</strong>
                    </div>
                    {details.targets.length > 0 && (
                      <p>対象: {details.targets.join(' / ')}</p>
                    )}
                    {details.metrics.length > 0 && (
                      <p>{details.metrics.join(' / ')}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : activeTimeCondition ? (
            <p className="timetable-grid-details-popover__time-condition">
              {activeTimeCondition.summary}
            </p>
          ) : null}
        </TimetableGridDetailsPopover>
      )}
    </section>
  )
}
