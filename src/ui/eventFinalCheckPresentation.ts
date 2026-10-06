import type {
  EventDay,
  EventDayId,
  EventId,
  Stage,
  StageId,
} from '../domain/models'
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
      targetEventDay?.id === currentEventDayId ? currentStageId : undefined
    ),
  })

  return { step: 6, ...selection }
}
