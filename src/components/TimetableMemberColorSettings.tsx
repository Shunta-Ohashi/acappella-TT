import { useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Member, MemberId } from '../domain/models'
import { getMemberDisplayName } from '../ui/eventBandPresentation'
import {
  getTimetableMemberColor,
  TIMETABLE_MEMBER_COLOR_PALETTE,
  type TimetableMemberColorAssignment,
  type TimetableMemberColorCandidate,
} from '../ui/timetableMemberColorSettings'

interface TimetableMemberColorSettingsProps {
  members: readonly Member[]
  candidates: readonly TimetableMemberColorCandidate[]
  assignments: readonly TimetableMemberColorAssignment[]
  selectedEventDayLabel?: string
  persistenceWarning?: string
  onAdd: (memberId: MemberId) => void
  onColorChange: (memberId: MemberId, colorId: string) => void
  onRemove: (memberId: MemberId) => void
  onClear: () => void
}

type CandidateSort = 'event' | 'day'

const colorStyle = (colorId: string): CSSProperties | undefined => {
  const color = getTimetableMemberColor(colorId)
  return color ? {
    '--member-color-background': color.background,
    '--member-color-border': color.border,
    '--member-color-text': color.text,
  } as CSSProperties : undefined
}

function TimetableMemberColorPicker({
  memberId,
  displayName,
  colorId,
  onChange,
}: {
  memberId: MemberId
  displayName: string
  colorId: string
  onChange: (colorId: string) => void
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const selectedColor = getTimetableMemberColor(colorId) ??
    TIMETABLE_MEMBER_COLOR_PALETTE[0]
  const closeAndFocusTrigger = () => {
    if (!detailsRef.current) return
    detailsRef.current.open = false
    detailsRef.current.querySelector('summary')?.focus()
  }

  return (
    <details
      ref={detailsRef}
      className="timetable-member-color-picker"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        closeAndFocusTrigger()
      }}
    >
      <summary
        aria-label={`${displayName}（${memberId}）の色を変更`}
        title={`現在の色: ${selectedColor.label}`}
      >
        <span
          className="timetable-member-color-picker__current"
          style={colorStyle(selectedColor.id)}
          aria-hidden="true"
        />
        <span>{selectedColor.label}</span>
      </summary>
      <div
        className="timetable-member-color-picker__palette"
        role="group"
        aria-label={`${displayName}の色パレット`}
      >
        {TIMETABLE_MEMBER_COLOR_PALETTE.map(color => {
          const selected = color.id === colorId
          return (
            <button
              key={color.id}
              type="button"
              className="timetable-member-color-picker__swatch"
              style={colorStyle(color.id)}
              aria-label={`${color.label}${selected ? '（選択中）' : ''}`}
              aria-pressed={selected}
              title={color.label}
              onClick={() => {
                onChange(color.id)
                closeAndFocusTrigger()
              }}
            >
              {selected && <span aria-hidden="true">✓</span>}
            </button>
          )
        })}
      </div>
    </details>
  )
}

export function TimetableMemberColorSettings({
  members,
  candidates,
  assignments,
  selectedEventDayLabel,
  persistenceWarning,
  onAdd,
  onColorChange,
  onRemove,
  onClear,
}: TimetableMemberColorSettingsProps) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CandidateSort>('event')
  const assignedMemberIds = new Set(
    assignments.map(assignment => assignment.memberId),
  )
  const candidateByMemberId = new Map(
    candidates.map(candidate => [candidate.memberId, candidate]),
  )
  const memberNameById = new Map(
    members.map(member => [member.id, getMemberDisplayName(member)]),
  )
  const visibleCandidates = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ja')
    return [...candidates]
      .filter(candidate => !normalizedQuery ||
        candidate.displayName.toLocaleLowerCase('ja').includes(normalizedQuery),
      )
      .sort((first, second) => {
        const primary = sort === 'event'
          ? second.eventBandCount - first.eventBandCount
          : second.selectedEventDayBandCount - first.selectedEventDayBandCount
        return primary ||
          second.eventBandCount - first.eventBandCount ||
          first.displayName.localeCompare(second.displayName, 'ja') ||
          first.memberId.localeCompare(second.memberId)
      })
  }, [candidates, query, sort])

  return (
    <details className="timetable-member-colors">
      <summary>
        <span>メンバー色分け設定</span>
        <span className="timetable-member-colors__count">
          {assignments.length}人設定中
        </span>
      </summary>
      <div className="timetable-member-colors__body">
        <p className="timetable-member-colors__description">
          個人用の表示設定です。色は出演位置とPA・当日運営へMember IDで追従します。
        </p>
        {persistenceWarning && (
          <p className="timetable-member-colors__warning" role="status">
            {persistenceWarning}
          </p>
        )}

        <section aria-labelledby="timetable-member-colors-current-title">
          <div className="timetable-member-colors__section-heading">
            <h4 id="timetable-member-colors-current-title">現在の色設定</h4>
            <button
              type="button"
              className="secondary-button"
              disabled={assignments.length === 0}
              onClick={onClear}
            >
              すべて解除
            </button>
          </div>
          {assignments.length === 0 ? (
            <p className="timetable-member-colors__empty">
              まだ色分けするメンバーが選ばれていません。
            </p>
          ) : (
            <ul className="timetable-member-colors__assigned-list">
              {assignments.map((assignment) => {
                const candidate = candidateByMemberId.get(assignment.memberId)
                const displayName = memberNameById.get(assignment.memberId) ??
                  '不明なメンバー'
                return (
                  <li key={assignment.memberId} style={colorStyle(assignment.colorId)}>
                    <span
                      className="timetable-member-colors__swatch"
                      aria-hidden="true"
                    />
                    <span className="timetable-member-colors__assigned-name">
                      <strong>{displayName}</strong>
                      <small>Member ID: {assignment.memberId}</small>
                      {candidate && (
                        <small>Event {candidate.eventBandCount}バンド</small>
                      )}
                    </span>
                    <TimetableMemberColorPicker
                      memberId={assignment.memberId}
                      displayName={displayName}
                      colorId={assignment.colorId}
                      onChange={(colorId) => onColorChange(
                        assignment.memberId,
                        colorId,
                      )}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`${displayName}（${assignment.memberId}）の色設定を解除`}
                      onClick={() => onRemove(assignment.memberId)}
                    >
                      解除
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="timetable-member-colors-candidates-title">
          <div className="timetable-member-colors__section-heading">
            <h4 id="timetable-member-colors-candidates-title">
              出演メンバーから追加
            </h4>
            <div
              className="timetable-member-colors__sort"
              role="group"
              aria-label="出演バンド数の並べ替え"
            >
              <button
                type="button"
                aria-pressed={sort === 'event'}
                onClick={() => setSort('event')}
              >
                Event順
              </button>
              <button
                type="button"
                aria-pressed={sort === 'day'}
                onClick={() => setSort('day')}
              >
                開催日順
              </button>
            </div>
          </div>
          <label className="timetable-member-colors__search">
            <span>出演メンバーを検索</span>
            <input
              type="search"
              value={query}
              placeholder="名前で検索"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ul className="timetable-member-colors__candidate-list">
            {visibleCandidates.map((candidate) => {
              const isAssigned = assignedMemberIds.has(candidate.memberId)
              return (
                <li key={candidate.memberId}>
                  <span>
                    <strong>{candidate.displayName}</strong>
                    <small>Member ID: {candidate.memberId}</small>
                    <small>
                      Event {candidate.eventBandCount}バンド
                      {selectedEventDayLabel
                        ? ` / ${selectedEventDayLabel} ${candidate.selectedEventDayBandCount}バンド`
                        : ''}
                    </small>
                  </span>
                  <button
                    type="button"
                    disabled={isAssigned}
                    aria-label={`${candidate.displayName}（${candidate.memberId}）${
                      isAssigned ? 'は色設定済み' : 'へ色を設定'
                    }`}
                    onClick={() => onAdd(candidate.memberId)}
                  >
                    {isAssigned ? '設定済み' : '色を設定'}
                  </button>
                </li>
              )
            })}
          </ul>
          {visibleCandidates.length === 0 && (
            <p className="timetable-member-colors__empty">
              条件に一致する出演メンバーはいません。
            </p>
          )}
        </section>
      </div>
    </details>
  )
}
