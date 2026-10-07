import type {
  EventDay,
  EventDayId,
  EventId,
  Stage,
  StageId,
} from '../domain/models'
import type { EventFinalCheckFinding } from '../domain/eventFinalCheck.ts'
import { resolveTimetableSelection } from '../domain/schedule.ts'
import type { EventEditorStepId } from './eventEditorSteps.ts'

export interface EventFinalCheckRepairTarget {
  step: EventEditorStepId
  eventDayId?: EventDayId
  stageId?: StageId
}

export interface EventFinalCheckRepairNavigation {
  step: EventEditorStepId
  eventDayId?: EventDayId
  stageId?: StageId
}

export interface EventFinalCheckStageDisplayGroup {
  stage: Stage
  findings: EventFinalCheckFinding[]
}

export interface EventFinalCheckDayDisplayGroup {
  eventDay: EventDay
  dayOnly: EventFinalCheckFinding[]
  stageGroups: EventFinalCheckStageDisplayGroup[]
  unresolvedStageFindings: EventFinalCheckFinding[]
}

export interface EventFinalCheckDisplayGroups {
  globalFindings: EventFinalCheckFinding[]
  dayGroups: EventFinalCheckDayDisplayGroup[]
  ungrouped: EventFinalCheckFinding[]
}

export const getEventFinalCheckStatusMessage = (counts: {
  ERROR: number
  WARNING: number
  INFO: number
}): string => {
  if (counts.ERROR > 0) {
    return 'ERRORの項目を確認し、各Stepで修正してください。'
  }
  if (counts.WARNING > 0 && counts.INFO > 0) {
    return '致命的な問題はありません。警告・情報を確認してください。'
  }
  if (counts.WARNING > 0) {
    return '致命的な問題はありません。警告を確認してください。'
  }
  if (counts.INFO > 0) {
    return '致命的な問題はありません。情報を確認してください。'
  }
  return '問題は見つかりませんでした。'
}

export const groupEventFinalCheckFindingsForDisplay = ({
  findings,
  eventDays,
  stages,
}: {
  findings: EventFinalCheckFinding[]
  eventDays: EventDay[]
  stages: Stage[]
}): EventFinalCheckDisplayGroups => {
  const eventDayById = new Map(eventDays.map(day => [day.id, day]))
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const globalFindings = findings.filter(finding => !finding.eventDayId)
  const dayGroups = eventDays.flatMap((eventDay): EventFinalCheckDayDisplayGroup[] => {
    const dayFindings = findings.filter(finding => finding.eventDayId === eventDay.id)
    if (dayFindings.length === 0) return []
    const dayOnly = dayFindings.filter(finding => !finding.stageId)
    const stageGroups = stages.filter(stage => stage.eventDayId === eventDay.id)
      .flatMap((stage): EventFinalCheckStageDisplayGroup[] => {
        const stageFindings = dayFindings.filter(finding => finding.stageId === stage.id)
        return stageFindings.length > 0 ? [{ stage, findings: stageFindings }] : []
      })
    const unresolvedStageFindings = dayFindings.filter(finding =>
      finding.stageId !== undefined &&
      stageById.get(finding.stageId)?.eventDayId !== eventDay.id,
    )
    return [{ eventDay, dayOnly, stageGroups, unresolvedStageFindings }]
  })
  const ungrouped = findings.filter(finding =>
    finding.eventDayId !== undefined && !eventDayById.has(finding.eventDayId),
  )

  return { globalFindings, dayGroups, ungrouped }
}

export const resolveEventFinalCheckRepairNavigation = ({
  target,
  eventId,
  eventDays,
  stages,
  currentEventDayId,
  currentStageId,
}: {
  target: EventFinalCheckRepairTarget
  eventId: EventId
  eventDays: EventDay[]
  stages: Stage[]
  currentEventDayId?: EventDayId
  currentStageId?: StageId
}): EventFinalCheckRepairNavigation => {
  if (target.step !== 6) return { step: target.step }

  const targetEventDay = eventDays.find(eventDay =>
    eventDay.id === target.eventDayId && eventDay.eventId === eventId,
  )
  const targetStage = targetEventDay && target.stageId
    ? stages.find(stage =>
        stage.id === target.stageId && stage.eventDayId === targetEventDay.id,
      )
    : undefined
  const selection = resolveTimetableSelection({
    eventId,
    eventDays,
    stages,
    selectedEventDayId: targetEventDay?.id ?? currentEventDayId,
    selectedStageId: targetStage?.id ?? (
      !targetEventDay || targetEventDay.id === currentEventDayId
        ? currentStageId
        : undefined
    ),
  })

  return { step: 6, ...selection }
}
