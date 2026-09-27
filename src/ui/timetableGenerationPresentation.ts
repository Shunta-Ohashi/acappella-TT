import type { EventBand, EventDay, Member, PaAssignment, ScheduleItem, Section, Stage } from '../domain/models'
import type { TimetableGenerationFailure, TimetableGenerationFailureCode, TimetableGenerationPlan } from '../domain/timetableGeneration'
import type { TimetableGenerationScore } from '../domain/timetableGenerationScore'
import type { CalculatedScheduleItem } from '../domain/timeline'
import type { ScheduleIssue } from '../domain/issues'
import { formatMinuteAsLocalTime } from '../domain/timeline.ts'
import { getSectionsForStage, getStagesForEventDay } from '../domain/schedule.ts'
import { resolvePaAssignmentInterval } from '../domain/paAssignments.ts'
import { getMemberDisplayName } from './eventBandPresentation.ts'
import { countIssuesBySeverity } from './issuePresentation.ts'

const failureMessages: Record<TimetableGenerationFailureCode, string> = {
  INVALID_INPUT: '自動生成に必要な設定に不整合があります。Step 1〜5の設定を確認してください。',
  INVALID_LOCK_CONSTRAINTS: 'TT固定または必須配置条件が競合しています。',
  BROKEN_DUTY_ASSIGNMENT: '当日運営の担当範囲に壊れた参照があります。',
  NO_MAIN_PA_CANDIDATE: 'Main PAを担当できるメンバーが見つかりません。',
  NO_SUB_PA_CANDIDATE: 'Sub PAを担当できるメンバーが見つかりません。',
  NO_FEASIBLE_PA_PLAN: '出演・Dutyとの間隔を守れるPA配置が見つかりませんでした。',
  NO_FEASIBLE_SCHEDULE: '現在の必須条件では実行可能なタイムテーブルを見つけられませんでした。',
  SEARCH_LIMIT_REACHED: '探索上限に達しました。条件や固定配置を見直してください。',
}

export const presentTimetableGenerationFailure = (
  failure: TimetableGenerationFailure,
  references: { stages: Stage[]; sections: Section[]; eventBands: EventBand[] },
): string => {
  const details = [
    failure.stageId ? `Stage: ${references.stages.find(s => s.id === failure.stageId)?.name ?? failure.stageId}` : undefined,
    failure.sectionId ? `Section: ${references.sections.find(s => s.id === failure.sectionId)?.name ?? failure.sectionId}` : undefined,
    failure.eventBandId ? `バンド: ${references.eventBands.find(b => b.id === failure.eventBandId)?.name ?? failure.eventBandId}` : undefined,
    `Schedule候補評価数: ${failure.attemptedSchedules}`,
  ].filter(Boolean)
  return `${failureMessages[failure.code]}（${details.join(' / ')}）`
}

export const GENERATION_SCORE_LABELS: Record<keyof TimetableGenerationScore, string> = {
  lastResortActivityCount: '最終手段の活動間隔件数',
  schedulingSoftPenalty: '出演希望条件ペナルティ',
  activitySpacingPenalty: '活動間隔ペナルティ',
  sectionDurationImbalance: '部の所要時間の偏り',
  paMainWorkloadImbalance: 'Main PA担当時間の偏り',
  paSubWorkloadImbalance: 'Sub PA担当時間の偏り',
  sectionBandCountImbalance: '部の出演バンド数の偏り',
  undecidedPaShiftCount: '参加未定のPA担当件数',
}

export const formatGenerationDay = (eventDay: EventDay): string => {
  const [year, month, day] = eventDay.date.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

export const createTimetableGenerationPreview = ({
  eventDay, stages, sections, members, eventBands, scheduleItems, paAssignments,
  plan, calculatedItems, issues,
}: {
  eventDay: EventDay; stages: Stage[]; sections: Section[]; members: Member[]
  eventBands: EventBand[]; scheduleItems: ScheduleItem[]; paAssignments: PaAssignment[]
  plan: TimetableGenerationPlan; calculatedItems: CalculatedScheduleItem[]; issues: ScheduleIssue[]
}) => {
  const itemById = new Map(scheduleItems.map(item => [item.id, item]))
  const bandById = new Map(eventBands.map(band => [band.id, band]))
  const memberById = new Map(members.map(member => [member.id, member]))
  const timeLabel = (from: number, until: number) => `${formatMinuteAsLocalTime(from)}〜${formatMinuteAsLocalTime(until)}`
  const stageRows = getStagesForEventDay(stages, eventDay.id).map(stage => {
    const stageSections = getSectionsForStage(sections, stage.id)
    return {
      id: stage.id, name: stage.name,
      rows: calculatedItems.filter(item => item.stageId === stage.id && item.eventDayId === eventDay.id).map(item => {
        const original = itemById.get(item.scheduleItemId)
        const afterIndex = stageSections.findIndex(section => section.id === item.afterSectionId)
        const sectionLabel = item.afterSectionId !== undefined && afterIndex >= 0
          ? `${stageSections[afterIndex].name} → ${stageSections[afterIndex + 1]?.name ?? '参照先なし'}（部間休憩）`
          : stageSections.find(section => section.id === item.sectionId)?.name ?? 'Sectionなし'
        return {
          id: item.scheduleItemId, sectionLabel, kind: item.kind,
          name: original?.kind === 'break' ? original.title : bandById.get(item.eventBandId ?? '')?.name ?? '不明なバンド',
          time: timeLabel(item.plannedStartMinute, item.plannedEndMinute),
        }
      }),
    }
  })
  const paRows = plan.paShifts.map((shift, index) => {
    const assignments = paAssignments.filter(item => item.eventId === eventDay.eventId && item.eventDayId === eventDay.id)
    const assignment = assignments[index]
    const interval = assignment ? resolvePaAssignmentInterval(assignment, calculatedItems) : undefined
    const member = memberById.get(shift.memberId)
    return {
      id: assignment?.id ?? `shift-${index}`,
      stage: stages.find(stage => stage.id === shift.stageId)?.name ?? shift.stageId,
      section: sections.find(section => section.id === shift.sectionId)?.name ?? 'Sectionなし',
      role: shift.role === 'main' ? 'Main PA' : 'Sub PA',
      member: member ? getMemberDisplayName(member) : shift.memberId,
      time: interval?.ok ? timeLabel(interval.interval.fromMinute, interval.interval.untilMinute) : '参照エラー',
    }
  })
  return {
    dayLabel: formatGenerationDay(eventDay), stageRows, paRows,
    summary: { bands: plan.placements.length, breaks: plan.breaks.length, paShifts: plan.paShifts.length,
      schedulesEvaluated: plan.diagnostics.scheduleCandidatesEvaluated,
      paPlansEvaluated: plan.diagnostics.paPlansEvaluated, issues: countIssuesBySeverity(issues) },
    issues,
    scores: (Object.keys(GENERATION_SCORE_LABELS) as (keyof TimetableGenerationScore)[])
      .map(key => ({ label: GENERATION_SCORE_LABELS[key], value: plan.score[key] })),
  }
}

export type TimetableGenerationPreview = ReturnType<typeof createTimetableGenerationPreview>
