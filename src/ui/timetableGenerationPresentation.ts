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

export interface TimetableGenerationFailurePresentation {
  code: TimetableGenerationFailureCode
  title: string
  summary: string
  checks: string[]
  details: string[]
}

type FailurePresentationDefinition = Pick<
  TimetableGenerationFailurePresentation,
  'title' | 'summary' | 'checks'
>

const failurePresentations: Record<
  TimetableGenerationFailureCode,
  FailurePresentationDefinition
> = {
  INVALID_INPUT: {
    title: '自動生成に必要な設定を確認してください',
    summary: '自動生成に使う設定の形式や参照関係を確認できない箇所があります。',
    checks: [
      'Step 2でStage・Sectionの開始時刻と終了時刻を確認してください。',
      'Step 3で参加状況と参加可能時間を確認してください。',
      'Step 4で出演枠・出演条件・固定配置を確認してください。',
      'Step 6でPA・当日運営の担当範囲、休憩、既存配置を確認してください。',
    ],
  },
  INVALID_LOCK_CONSTRAINTS: {
    title: 'TT固定を見直してください',
    summary: 'TT固定同士、またはTT固定と出演バンドの固定配置が両立していません。',
    checks: [
      '同じバンドに矛盾する複数のTT固定がないか確認してください。',
      'TT固定先のStage・Sectionが現在も存在するか確認してください。',
      'バンドの固定配置とTT固定が別のStage・Sectionを要求していないか確認してください。',
      '不要なTT固定を解除できないか確認してください。',
    ],
  },
  INVALID_ORDER_CONSTRAINTS: {
    title: '出演順制約を見直してください',
    summary: '出演順制約の参照先、または固定配置・TT固定との組み合わせが両立していません。',
    checks: [
      '出演順制約が指定しているStage・Sectionを確認してください。',
      '制約対象バンドの固定配置とTT固定を確認してください。',
      '同じバンドに矛盾する配置条件が設定されていないか確認してください。',
    ],
  },
  BROKEN_DUTY_ASSIGNMENT: {
    title: '当日運営担当の範囲を修正してください',
    summary: '当日運営担当が、存在しないStage・Section・タイムテーブル項目などを参照しています。',
    checks: [
      'Step 6「当日運営」で担当開始・終了位置を確認してください。',
      '削除済みの休憩・出演枠・Sectionを参照していないか確認してください。',
      '担当対象のStageが正しいか確認してください。',
    ],
  },
  NO_MAIN_PA_CANDIDATE: {
    title: 'Main PAを担当できるメンバーが不足しています',
    summary: '必要な時間帯をMain PAとして担当できるメンバーを見つけられませんでした。',
    checks: [
      'Step 3でMain PA担当可になっているメンバーがいるか確認してください。',
      'その開催日の参加状況と参加可能時間を確認してください。',
      '出演・当日運営との重なりによって担当できなくなっていないか確認してください。',
    ],
  },
  NO_SUB_PA_CANDIDATE: {
    title: 'Sub PAを担当できるメンバーが不足しています',
    summary: '必要な時間帯をSub PAとして担当できるメンバーを見つけられませんでした。',
    checks: [
      'Step 3でSub PA担当可になっているメンバーがいるか確認してください。',
      'その開催日の参加状況と参加可能時間を確認してください。',
      '出演・当日運営との重なりによって担当できなくなっていないか確認してください。',
    ],
  },
  NO_FEASIBLE_PA_PLAN: {
    title: 'PA担当の組み合わせを作れませんでした',
    summary: 'PA担当可能者はいますが、出演や当日運営との間隔を含めて、すべての担当範囲を満たす組み合わせを見つけられませんでした。',
    checks: [
      'Main・Sub PAを担当可能なメンバー数を確認してください。',
      '各メンバーの参加可能時間を確認してください。',
      '出演バンドの固定時刻・出演可能時間と、当日運営担当との重なりを確認してください。',
      '必須の出演配置を減らせないか確認してください。',
    ],
  },
  NO_FEASIBLE_SCHEDULE: {
    title: '現在の条件ではタイムテーブルを組めませんでした',
    summary: '複数の必須条件の組み合わせにより、配置可能なタイムテーブルを見つけられませんでした。以下を順番に確認してください。',
    checks: [
      'Stage・Sectionに、出演枠と保持する休憩を収められる時間があるか確認してください。',
      'Step 4で狭すぎる出演可能時間・固定開始時刻・固定配置がないか確認してください。',
      'TT固定が多すぎないか、固定先が他の条件と競合していないか確認してください。',
      '出演順制約と固定配置を同時に満たせるか確認してください。',
      '出演メンバーの参加可能時間と掛け持ち間隔を確認してください。',
      '当日運営担当・PA担当との時間競合がないか確認してください。',
    ],
  },
  SEARCH_LIMIT_REACHED: {
    title: '探索上限に達しました',
    summary: '条件を満たす候補を探しましたが、設定された探索範囲内では結論を出せませんでした。',
    checks: [
      '固定配置を必要最小限にできないか確認してください。',
      '不要なTT固定を解除できないか確認してください。',
      '出演順制約を減らせないか確認してください。',
      '出演可能時間が狭すぎないか確認し、必要に応じて条件を少し緩めて再生成してください。',
    ],
  },
}

export const presentTimetableGenerationFailure = (
  failure: TimetableGenerationFailure,
  references: { stages: Stage[]; sections: Section[]; eventBands: EventBand[] },
): TimetableGenerationFailurePresentation => {
  const definition = failurePresentations[failure.code]
  const section = failure.sectionId
    ? references.sections.find(candidate => candidate.id === failure.sectionId)
    : undefined
  const stageId = failure.stageId ?? section?.stageId
  const stageName = stageId
    ? references.stages.find(candidate => candidate.id === stageId)?.name ?? stageId
    : undefined
  const sectionName = failure.sectionId
    ? section?.name ?? failure.sectionId
    : undefined
  const eventBandName = failure.eventBandId
    ? references.eventBands.find(candidate => candidate.id === failure.eventBandId)?.name ??
      failure.eventBandId
    : undefined
  const checks = [...definition.checks]
  if (eventBandName && failure.code === 'INVALID_INPUT') {
    checks.unshift(`まずStep 4で「${eventBandName}」の出演枠・出演条件・固定配置を確認してください。`)
  } else if (eventBandName && failure.code === 'INVALID_LOCK_CONSTRAINTS') {
    checks.unshift(`まず「${eventBandName}」のTT固定と固定配置を確認してください。`)
  } else if (eventBandName && failure.code === 'INVALID_ORDER_CONSTRAINTS') {
    checks.unshift(`まず「${eventBandName}」を含む出演順制約と配置条件を確認してください。`)
  }

  const summary = failure.code === 'NO_FEASIBLE_SCHEDULE' && failure.attemptedSchedules === 0
    ? `${definition.summary} まだ候補を評価できる段階まで到達していない可能性があります。`
    : definition.summary
  const details = [
    stageName ? `Stage: ${stageName}` : undefined,
    sectionName ? `Section: ${sectionName}` : undefined,
    eventBandName ? `バンド: ${eventBandName}` : undefined,
    `評価したタイムテーブル候補: ${failure.attemptedSchedules}件`,
    `エラーコード: ${failure.code}`,
  ].filter((detail): detail is string => detail !== undefined)

  return {
    code: failure.code,
    title: definition.title,
    summary,
    checks,
    details,
  }
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
