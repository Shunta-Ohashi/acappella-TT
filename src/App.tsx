import { useRef, useState } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd'
import type {
  Band,
  BandId,
  DutyAssignment,
  DutyType,
  Event as TimetableEvent,
  EventBand,
  EventDay,
  EventDayId,
  EventId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  PaAssignment,
  ScheduleItem,
  Section,
  SectionId,
  Stage,
  StageId,
} from './domain/models'
import {
  createBreakScheduleItemForLane,
  createPerformanceScheduleItemForLane,
  getEventBandsForEventDay,
  getEventDaysForEvent,
  getEventDayScheduleItems,
  getInvalidSectionScheduleItemIds,
  getScheduleLaneItems,
  getSectionsForStage,
  getStageScheduleItems,
  getStagesForEventDay,
  getUnscheduledEventBandsForEventDay,
  insertScheduleItemInLane,
  moveScheduleItemWithinStage,
  removeScheduleItem,
  reorderScheduleLaneItems,
  reorderUnscheduledEventBands,
  resolveTimetableSelection,
  type ScheduleLane,
} from './domain/schedule'
import { calculateEventDayTimelines } from './domain/timetable'
import { detectScheduleIssues } from './domain/issues'
import {
  AppSectionPlaceholder,
  AppShell,
  type AppSection,
} from './components/AppShell'
import {
  EventEditorShell,
  type EventEditorStepId,
} from './components/EventEditorShell'
import { CreateEventDialog } from './components/CreateEventDialog'
import { EventBasicInfo } from './components/EventBasicInfo'
import { CommonDataPage } from './components/CommonDataPage'
import { EventMemberSettings } from './components/EventMemberSettings'
import { EventBandSettings } from './components/EventBandSettings'
import { EventBandConditions } from './components/EventBandConditions'
import { EventStageSettings } from './components/EventStageSettings'
import { PaSettings } from './components/PaSettings'
import type { PaSettingsHandle } from './components/PaSettings'
import {
  DutySettings,
  type DutySettingsHandle,
} from './components/DutySettings'
import { TimetableGrid } from './components/TimetableGrid'
import { TimetableOperationsWorkspace } from './components/TimetableOperationsWorkspace'
import { EventList } from './components/EventList'
import { IssuePanel } from './components/IssuePanel'
import {
  createEventData,
  type NewEventDraft,
} from './domain/eventCreation'
import {
  canDeleteEventDay,
  createEventBasicInfoUpdate,
  type EventBasicInfoDraft,
  type EventBasicInfoUpdateResult,
} from './domain/eventBasicInfo'
import {
  canAddFirstSection,
  canDeleteSection,
  canDeleteStage,
  createEventStageSettingsUpdate,
  isValidStageTimeRange,
  type EventStageSettingsUpdateResult,
  type SectionSettingsDraft,
  type StageSettingsDraft,
} from './domain/eventStageSettings'
import {
  createEventMemberSettingsUpdate,
  type EventMemberSettingsDraft,
  type EventMemberSettingsUpdateResult,
} from './domain/eventMemberSettings'
import {
  createCommonMemberUpdate,
  type CommonMemberDraft,
  type CommonMemberUpdateResult,
} from './domain/commonMembers'
import {
  createCommonBandUpdate,
  type CommonBandDraft,
  type CommonBandUpdateResult,
} from './domain/commonBands'
import {
  createEventBandSettingsUpdate,
  type EventBandSettingsDraft,
  type EventBandSettingsUpdateResult,
} from './domain/eventBandSettings'
import {
  createEventBandConditionsUpdate,
  type EventBandConditionsDraft,
  type EventBandConditionsUpdateResult,
} from './domain/eventBandConditions'
import {
  createPaAssignmentsUpdate,
  type PaAssignmentsDraft,
  type PaAssignmentsUpdateResult,
} from './domain/paAssignments'
import {
  createDutySettingsUpdate,
  type DutySettingsDraft,
  type DutySettingsUpdateResult,
} from './domain/dutyAssignments'
import {
  countIssuesBySeverity,
  getIssuesForStage,
} from './ui/issuePresentation'
import { getEventBandMemberDisplayNames } from './ui/eventBandPresentation'
import {
  parseTimetableDroppableId,
  resolveScheduleLane,
  TIMETABLE_POOL_DROPPABLE_ID,
} from './ui/timetableDnd'
import { createTimetableWorkspaceRows } from './ui/timetableWorkspaceRows'
import { createDemoData } from './data/demoData'
import './App.css'

type AppView = 'event-editor' | AppSection

const appSectionPlaceholders: Record<
  Exclude<AppSection, 'events' | 'shared-data'>,
  { title: string; description: string }
> = {
  settings: {
    title: '設定',
    description: 'アプリ全体の設定は後続PRで実装します。',
  },
}

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

const replaceEventBandsForEventDay = (
  allEventBands: EventBand[],
  eventId: EventId,
  eventDayId: EventDay['id'],
  replacement: EventBand[],
): EventBand[] => {
  let replacementIndex = 0

  return allEventBands.map((eventBand) =>
    eventBand.eventId === eventId && eventBand.eventDayId === eventDayId
      ? replacement[replacementIndex++]
      : eventBand,
  )
}

const DEFAULT_EVENT_SETTINGS = {
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
} satisfies Pick<
  TimetableEvent,
  'timeZone' | 'defaultTransitionMinutes' | 'validationPolicy'
>

const initialDemoData = createDemoData()

function App() {
  const [activeView, setActiveView] = useState<AppView>('events')
  const [activeStep, setActiveStep] = useState<EventEditorStepId>(6)
  const [selectedEventId, setSelectedEventId] = useState<EventId>(
    initialDemoData.initialEventId,
  )
  const [selectedTimetableEventDayId, setSelectedTimetableEventDayId] =
    useState<EventDayId | undefined>(initialDemoData.initialEventDayId)
  const [selectedTimetableStageId, setSelectedTimetableStageId] =
    useState<StageId | undefined>(initialDemoData.initialStageId)
  const [isCreateEventDialogOpen, setIsCreateEventDialogOpen] = useState(false)

  // ==================== 📦 各種状態（State）の管理 ====================

  const [events, setEvents] = useState<TimetableEvent[]>(initialDemoData.events)
  const [eventDays, setEventDays] = useState<EventDay[]>(initialDemoData.eventDays)
  const [stages, setStages] = useState<Stage[]>(initialDemoData.stages)
  const [sections, setSections] = useState<Section[]>(initialDemoData.sections)
  const selectedEvent = events.find((event) => event.id === selectedEventId)
  const selectedEventDays = getEventDaysForEvent(eventDays, selectedEventId)
  const selectedEventDayIds = new Set(
    selectedEventDays.map((eventDay) => eventDay.id),
  )
  const selectedStages = stages.filter((stage) =>
    selectedEventDayIds.has(stage.eventDayId),
  )
  const selectedStageIds = new Set(selectedStages.map((stage) => stage.id))
  const selectedSections = sections.filter((section) =>
    selectedStageIds.has(section.stageId),
  )
  const timetableSelection = resolveTimetableSelection({
    eventId: selectedEventId,
    eventDays,
    stages,
    selectedEventDayId: selectedTimetableEventDayId,
    selectedStageId: selectedTimetableStageId,
  })
  const timetableEventDay = selectedEventDays.find(
    eventDay => eventDay.id === timetableSelection.eventDayId,
  )
  const timetableStages = timetableSelection.eventDayId
    ? getStagesForEventDay(stages, timetableSelection.eventDayId)
    : []
  const timetableStageIds = new Set(timetableStages.map(stage => stage.id))
  const timetableSections = selectedSections.filter(section =>
    timetableStageIds.has(section.stageId),
  )
  const currentStage = timetableStages.find(
    stage => stage.id === timetableSelection.stageId,
  )

  // 1️⃣ サークル員データベース（初期データ）
  const [members, setMembers] = useState<Member[]>(initialDemoData.members)

  // 2️⃣ バンドデータベース（初期データ）
  const [bands, setBands] = useState<Band[]>(initialDemoData.bands)

  // 3️⃣ このイベントに出演するバンド
  const [eventBands, setEventBands] = useState<EventBand[]>(
    initialDemoData.eventBands,
  )
  const [eventMembers, setEventMembers] = useState<EventMember[]>(
    initialDemoData.eventMembers,
  )
  const [eventMemberDays, setEventMemberDays] = useState<EventMemberDay[]>(
    initialDemoData.eventMemberDays,
  )
  const [paAssignments, setPaAssignments] = useState<PaAssignment[]>(
    initialDemoData.paAssignments,
  )
  const [dutyTypes, setDutyTypes] = useState<DutyType[]>(
    initialDemoData.dutyTypes,
  )
  const [dutyAssignments, setDutyAssignments] = useState<DutyAssignment[]>(
    initialDemoData.dutyAssignments,
  )
  const paSettingsRef = useRef<PaSettingsHandle>(null)
  const dutySettingsRef = useRef<DutySettingsHandle>(null)
  const selectedEventBands = eventBands.filter(
    (eventBand) => eventBand.eventId === selectedEventId,
  )
  const currentDayEventBands = timetableSelection.eventDayId
    ? getEventBandsForEventDay(
        eventBands,
        selectedEventId,
        timetableSelection.eventDayId,
      )
    : []

  // 4️⃣ 当日のタイムテーブル。出演項目はEventBandをIDで参照する
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>(
    initialDemoData.scheduleItems,
  )
  const selectedScheduleItems = scheduleItems.filter((scheduleItem) =>
    selectedStageIds.has(scheduleItem.stageId),
  )

  const [breakDuration, setBreakDuration] = useState<number>(10)

  const selectedEventMembers = eventMembers.filter(
    (eventMember) => eventMember.eventId === selectedEventId,
  )
  const selectedEventMemberIds = new Set(
    selectedEventMembers.map((eventMember) => eventMember.id),
  )
  const selectedEventMemberDays = eventMemberDays.filter(
    (eventMemberDay) => selectedEventMemberIds.has(eventMemberDay.eventMemberId),
  )
  const selectedEventPaAssignments = paAssignments.filter(
    (assignment) => assignment.eventId === selectedEventId,
  )
  const selectedEventDutyTypes = dutyTypes
    .filter((dutyType) => dutyType.eventId === selectedEventId)
    .sort((first, second) =>
      first.order - second.order || first.id.localeCompare(second.id),
    )
  const selectedEventDutyTypeIds = new Set(
    selectedEventDutyTypes.map((dutyType) => dutyType.id),
  )
  const selectedEventDutyAssignments = dutyAssignments.filter((assignment) =>
    selectedEventDutyTypeIds.has(assignment.dutyTypeId) ||
    selectedStageIds.has(assignment.stageId),
  )
  const selectedEventCalculatedItems = selectedEvent
    ? selectedEventDays.flatMap((eventDay) => calculateEventDayTimelines({
        event: selectedEvent,
        eventDayId: eventDay.id,
        stages: selectedStages,
        sections: selectedSections,
        scheduleItems: selectedScheduleItems,
        eventBands: selectedEventBands,
      }).calculatedItems)
    : []
  const startTime = currentStage?.plannedStartTime ?? ''
  const intervalTime = currentStage?.transitionMinutes ??
    selectedEvent?.defaultTransitionMinutes ??
    DEFAULT_EVENT_SETTINGS.defaultTransitionMinutes
  const currentStageScheduleItems = currentStage
    ? getStageScheduleItems(selectedScheduleItems, currentStage.id)
    : []
  const currentStageSections = currentStage
    ? getSectionsForStage(timetableSections, currentStage.id)
    : []
  const currentStageUsesSections = currentStageSections.length > 0
  const currentEventDayScheduleItems = timetableSelection.eventDayId
    ? getEventDayScheduleItems(
        scheduleItems,
        timetableStages,
        timetableSelection.eventDayId,
      )
    : []
  const poolEventBands = selectedEvent && timetableSelection.eventDayId
    ? getUnscheduledEventBandsForEventDay({
        eventBands,
        eventId: selectedEvent.id,
        eventDayId: timetableSelection.eventDayId,
        stages: timetableStages,
        scheduleItems,
      })
    : []
  const invalidCurrentStageScheduleItemIds = currentStage
    ? getInvalidSectionScheduleItemIds(
        currentStage,
        currentStageSections,
        currentStageScheduleItems,
      )
    : []
  const currentStageHasInvalidSectionAssignments =
    invalidCurrentStageScheduleItemIds.length > 0

  const handleStageStartTimeChange = (value: string) => {
    if (
      !currentStage ||
      !isValidStageTimeRange(value, currentStage.plannedEndTime)
    ) return

    setStages(prev => prev.map(stage => (
      stage.id === currentStage.id
        ? { ...stage, plannedStartTime: value }
        : stage
    )))
  }

  const handleStageTransitionMinutesChange = (value: string) => {
    const transitionMinutes = Number(value)
    if (
      !currentStage ||
      !Number.isSafeInteger(transitionMinutes) ||
      transitionMinutes < 0
    ) return

    setStages(previous => previous.map(stage =>
      stage.id === currentStage.id
        ? { ...stage, transitionMinutes }
        : stage,
    ))
  }

  const handleOpenEvent = (eventId: EventId) => {
    if (!events.some((event) => event.id === eventId)) return

    setSelectedEventId(eventId)
    setSelectedTimetableEventDayId(undefined)
    setSelectedTimetableStageId(undefined)
    setActiveView('event-editor')
  }

  const handleSelectTimetableEventDay = (eventDayId: EventDayId) => {
    if (!selectedEventDays.some(eventDay => eventDay.id === eventDayId)) return

    setSelectedTimetableEventDayId(eventDayId)
    setSelectedTimetableStageId(getStagesForEventDay(stages, eventDayId)[0]?.id)
  }

  const handleSelectTimetableStage = (stageId: StageId) => {
    if (!timetableStages.some(stage => stage.id === stageId)) return
    setSelectedTimetableStageId(stageId)
  }

  const handleCreateEvent = (draft: NewEventDraft) => {
    const eventId = createId('event')
    const eventDayIds = draft.dates.map(() => createId('event-day'))
    const created = createEventData({
      eventId,
      eventDayIds,
      draft,
      defaults: DEFAULT_EVENT_SETTINGS,
    })

    setEvents((previous) => [...previous, created.event])
    setEventDays((previous) => [...previous, ...created.eventDays])
    setSelectedEventId(created.event.id)
    setSelectedTimetableEventDayId(created.eventDays[0]?.id)
    setSelectedTimetableStageId(undefined)
    setActiveStep(1)
    setActiveView('event-editor')
    setIsCreateEventDialogOpen(false)
  }

  const handleSaveEventBasicInfo = (
    draft: EventBasicInfoDraft,
  ): EventBasicInfoUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: { form: '編集するイベントが見つかりません。' },
      }
    }

    const result = createEventBasicInfoUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      draft,
      newEventDayIds: draft.eventDays
        .filter((eventDay) => !eventDay.eventDayId)
        .map(() => createId('event-day')),
      stages,
      eventMemberDays,
      eventBands,
      paAssignments,
      dutyAssignments,
    })

    if (!result.ok) return result

    setEvents((previous) => previous.map((event) =>
      event.id === selectedEvent.id ? result.event : event,
    ))
    setEventDays((previous) => [
      ...previous.filter((eventDay) => eventDay.eventId !== selectedEvent.id),
      ...result.eventDays,
    ])
    const nextTimetableSelection = resolveTimetableSelection({
      eventId: selectedEvent.id,
      eventDays: result.eventDays,
      stages,
      selectedEventDayId: timetableSelection.eventDayId,
      selectedStageId: timetableSelection.stageId,
    })
    setSelectedTimetableEventDayId(nextTimetableSelection.eventDayId)
    setSelectedTimetableStageId(nextTimetableSelection.stageId)

    return result
  }

  const handleSaveEventMemberSettings = (
    draft: EventMemberSettingsDraft,
  ): EventMemberSettingsUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: {
          members: {},
          days: {},
          form: '編集するイベントが見つかりません。',
        },
      }
    }

    const newEventMemberIds = draft.members
      .filter((memberDraft) => !memberDraft.eventMemberId)
      .map(() => createId('event-member'))
    const newEventMemberDayIds = draft.members.flatMap((memberDraft) =>
      memberDraft.days
        .filter((dayDraft) => !dayDraft.eventMemberDayId)
        .map(() => createId('event-member-day')),
    )
    const result = createEventMemberSettingsUpdate({
      event: selectedEvent,
      eventDays,
      members,
      eventMembers,
      eventMemberDays,
      eventBands,
      draft,
      newEventMemberIds,
      newEventMemberDayIds,
    })
    if (!result.ok) return result

    setEventMembers(result.eventMembers)
    setEventMemberDays(result.eventMemberDays)
    return result
  }

  const handleSaveEventBandSettings = (
    draft: EventBandSettingsDraft,
  ): EventBandSettingsUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: {
          items: {},
          form: '編集するイベントが見つかりません。',
        },
      }
    }

    const result = createEventBandSettingsUpdate({
      event: selectedEvent,
      eventDays,
      members,
      bands,
      eventBands,
      eventMembers,
      eventMemberDays,
      scheduleItems,
      draft,
      newEventBandIds: draft.items
        .filter((item) => !item.eventBandId)
        .map(() => createId('event-band')),
    })
    if (!result.ok) return result

    setEventBands(result.eventBands)
    return result
  }

  const handleSaveEventBandConditions = (
    draft: EventBandConditionsDraft,
  ): EventBandConditionsUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: {
          items: {},
          form: '編集するイベントが見つかりません。',
        },
      }
    }

    const result = createEventBandConditionsUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      eventBands,
      stages,
      sections,
      members,
      eventMembers,
      eventMemberDays,
      draft,
    })
    if (!result.ok) return result

    setEventBands(result.eventBands)
    return result
  }

  const handleSavePaAssignments = (
    draft: PaAssignmentsDraft,
  ): PaAssignmentsUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: { items: {}, form: '編集するイベントが見つかりません。' },
      }
    }
    const result = createPaAssignmentsUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      stages: selectedStages,
      members,
      eventMembers: selectedEventMembers,
      eventMemberDays: selectedEventMemberDays,
      eventBands: selectedEventBands,
      calculatedItems: selectedEventCalculatedItems,
      paAssignments,
      draft,
      newPaAssignmentIds: draft.items
        .filter((item) => !item.paAssignmentId)
        .map(() => createId('pa-assignment')),
    })
    if (!result.ok) return result
    setPaAssignments(result.paAssignments)
    return result
  }

  const handleSaveDutySettings = (
    draft: DutySettingsDraft,
  ): DutySettingsUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: {
          dutyTypes: {},
          assignments: {},
          form: '編集するイベントが見つかりません。',
        },
      }
    }
    const result = createDutySettingsUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      stages: selectedStages,
      members,
      eventMembers: selectedEventMembers,
      eventMemberDays: selectedEventMemberDays,
      eventBands: selectedEventBands,
      paAssignments: selectedEventPaAssignments,
      calculatedItems: selectedEventCalculatedItems,
      dutyTypes,
      dutyAssignments,
      draft,
      newDutyTypeIds: draft.dutyTypes
        .filter((dutyType) => !dutyType.dutyTypeId)
        .map(() => createId('duty-type')),
      newDutyAssignmentIds: draft.assignments
        .filter((assignment) => !assignment.dutyAssignmentId)
        .map(() => createId('duty-assignment')),
    })
    if (!result.ok) return result
    setDutyTypes(result.dutyTypes)
    setDutyAssignments(result.dutyAssignments)
    return result
  }

  const handleSaveStep6AndNext = () => {
    const paIsValid = paSettingsRef.current?.validateDraft() ?? false
    const dutyIsValid = dutySettingsRef.current?.validateDraft() ?? false
    if (!paIsValid || !dutyIsValid) return

    const paWasSaved = paSettingsRef.current?.commitDraft() ?? false
    const dutyWasSaved = dutySettingsRef.current?.commitDraft() ?? false
    if (paWasSaved && dutyWasSaved) setActiveStep(7)
  }

  const handleSaveCommonMember = (
    memberId: MemberId | undefined,
    draft: CommonMemberDraft,
  ): CommonMemberUpdateResult => {
    const existingMember = memberId
      ? members.find((member) => member.id === memberId)
      : undefined
    if (memberId && !existingMember) {
      return {
        ok: false,
        errors: { form: '編集するメンバーが見つかりません。' },
      }
    }

    const result = createCommonMemberUpdate({
      memberId: existingMember?.id ?? createId('member'),
      existingMember,
      draft,
    })
    if (!result.ok) return result

    setMembers((previous) => existingMember
      ? previous.map((member) =>
          member.id === existingMember.id ? result.member : member)
      : [...previous, result.member])
    return result
  }

  const handleSaveCommonBand = (
    bandId: BandId | undefined,
    draft: CommonBandDraft,
  ): CommonBandUpdateResult => {
    const existingBand = bandId
      ? bands.find((band) => band.id === bandId)
      : undefined
    if (bandId && !existingBand) {
      return {
        ok: false,
        errors: { form: '編集する固定バンドが見つかりません。' },
      }
    }

    const result = createCommonBandUpdate({
      bandId: existingBand?.id ?? createId('band'),
      existingBand,
      draft,
      members,
    })
    if (!result.ok) return result

    setBands((previous) => existingBand
      ? previous.map((band) =>
          band.id === existingBand.id ? result.band : band)
      : [...previous, result.band])
    return result
  }

  const handleSaveEventStageSettings = (
    defaultTransitionMinutes: string,
    performanceSlotMinutes: number[],
    stageDrafts: StageSettingsDraft[],
    sectionDrafts: SectionSettingsDraft[],
  ): EventStageSettingsUpdateResult => {
    if (!selectedEvent) {
      return {
        ok: false,
        errors: {
          stages: {},
          sections: {},
          form: '編集するイベントが見つかりません。',
        },
      }
    }

    const result = createEventStageSettingsUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      stages: selectedStages,
      sections: selectedSections,
      draft: {
        defaultTransitionMinutes,
        performanceSlotMinutes,
        stages: stageDrafts,
        sections: sectionDrafts,
      },
      newStageIds: stageDrafts
        .filter((stage) => !stage.stageId)
        .map(() => createId('stage')),
      newSectionIds: sectionDrafts
        .filter((section) => !section.sectionId)
        .map(() => createId('section')),
      scheduleItems,
      eventBands,
      paAssignments,
      dutyAssignments,
    })

    if (!result.ok) return result

    setEvents((previous) => previous.map((event) =>
      event.id === selectedEvent.id ? result.event : event,
    ))
    setStages((previous) => [
      ...previous.filter((stage) => !selectedEventDayIds.has(stage.eventDayId)),
      ...result.stages,
    ])
    setSections((previous) => [
      ...previous.filter((section) => !selectedStageIds.has(section.stageId)),
      ...result.sections,
    ])
    const nextTimetableSelection = resolveTimetableSelection({
      eventId: selectedEvent.id,
      eventDays: selectedEventDays,
      stages: result.stages,
      selectedEventDayId: timetableSelection.eventDayId,
      selectedStageId: timetableSelection.stageId,
    })
    setSelectedTimetableEventDayId(nextTimetableSelection.eventDayId)
    setSelectedTimetableStageId(nextTimetableSelection.stageId)

    return result
  }

  // ==================== 🎴 プール・タイムテーブル操作ロジック ====================

  const handleAddBreak = (sectionId?: SectionId) => {
    if (
      !currentStage ||
      currentStageHasInvalidSectionAssignments ||
      breakDuration <= 0
    ) return

    const lane: ScheduleLane = {
      stageId: currentStage.id,
      ...(sectionId ? { sectionId } : {}),
    }
    const newBreakItem = createBreakScheduleItemForLane({
      id: createId('schedule-break'),
      title: '☕ 休憩',
      durationMinutes: breakDuration,
      stage: currentStage,
      stageSections: currentStageSections,
      lane,
    })
    if (!newBreakItem) return

    setScheduleItems(prev => insertScheduleItemInLane(
      prev,
      lane,
      newBreakItem,
      getScheduleLaneItems(prev, lane).length,
    ))
    setBreakDuration(10)
  }

  // 演奏項目を削除すると、参照先のEventBandが算出プールへ戻る。休憩はそのまま削除する
  const handleRemoveScheduleItem = (id: string) => {
    setScheduleItems(prev => removeScheduleItem(prev, id))
  }

  // ==================== 🔀 安全なドラッグ＆ドロップ処理 ====================
  const handleOnDragEnd = (result: DropResult) => {
    if (
      !currentStage ||
      !selectedEvent ||
      !timetableSelection.eventDayId ||
      currentStageHasInvalidSectionAssignments
    ) return
    const timetableEventDayId = timetableSelection.eventDayId

    const { source, destination } = result
    if (!destination) return

    const sourceTarget = parseTimetableDroppableId(source.droppableId)
    const destinationTarget = parseTimetableDroppableId(
      destination.droppableId,
    )
    if (!sourceTarget || !destinationTarget) return

    const currentStageSectionIds = new Set(
      currentStageSections.map(section => section.id),
    )
    const sourceLane = sourceTarget.kind === 'pool'
      ? undefined
      : resolveScheduleLane(
          sourceTarget,
          currentStage.id,
          currentStageSectionIds,
        )
    const destinationLane = destinationTarget.kind === 'pool'
      ? undefined
      : resolveScheduleLane(
          destinationTarget,
          currentStage.id,
          currentStageSectionIds,
        )
    const sourceIndex = source.index
    const destinationIndex = destination.index

    // 同じエリア内ではIDを維持したまま表示順だけを更新する
    if (source.droppableId === destination.droppableId) {
      if (sourceTarget.kind === 'pool') {
        if (poolEventBands[sourceIndex]?.id !== result.draggableId) return
        setEventBands((previous) => {
          const daySpecificBands = getEventBandsForEventDay(
            previous,
            selectedEvent.id,
            timetableEventDayId,
          )
          const reordered = reorderUnscheduledEventBands(
            daySpecificBands,
            currentEventDayScheduleItems,
            sourceIndex,
            destinationIndex,
          )

          return replaceEventBandsForEventDay(
            previous,
            selectedEvent.id,
            timetableEventDayId,
            reordered,
          )
        })
      } else if (sourceLane) {
        const sourceItem = getScheduleLaneItems(
          scheduleItems,
          sourceLane,
        )[sourceIndex]
        if (!sourceItem || sourceItem.id !== result.draggableId) return
        setScheduleItems(prev => reorderScheduleLaneItems(
          prev, sourceLane, sourceIndex, destinationIndex,
        ))
      }
      return
    }

    // EventBandをタイムテーブルへ配置するときだけScheduleItemを新規作成する
    if (sourceTarget.kind === 'pool' && destinationLane) {
      const eventBand = poolEventBands[sourceIndex]
      if (
        !eventBand ||
        eventBand.id !== result.draggableId ||
        eventBand.eventId !== selectedEvent.id ||
        eventBand.eventDayId !== timetableEventDayId ||
        eventBand.eventDayId !== currentStage.eventDayId
      ) return

      const newScheduleItem = createPerformanceScheduleItemForLane({
        id: createId('schedule-performance'),
        eventBandId: eventBand.id,
        stage: currentStage,
        stageSections: currentStageSections,
        lane: destinationLane,
      })
      if (!newScheduleItem) return

      setScheduleItems(prev => insertScheduleItemInLane(
        prev,
        destinationLane,
        newScheduleItem,
        destinationIndex,
      ))
      return
    }

    // 演奏項目を外すとEventBandが再び算出プールへ現れる。休憩はプールへ移動しない
    if (sourceLane && destinationTarget.kind === 'pool') {
      const scheduleItem = getScheduleLaneItems(
        scheduleItems,
        sourceLane,
      )[sourceIndex]
      if (
        !scheduleItem ||
        scheduleItem.id !== result.draggableId ||
        scheduleItem.kind === 'break'
      ) return

      const remainingScheduleItems = removeScheduleItem(scheduleItems, scheduleItem.id)
      setScheduleItems(remainingScheduleItems)
      setEventBands(previous => {
        const daySpecificBands = getEventBandsForEventDay(
          previous,
          selectedEvent.id,
          timetableEventDayId,
        )
        const remainingDayScheduleItems = getEventDayScheduleItems(
          remainingScheduleItems,
          timetableStages,
          timetableEventDayId,
        )
        const poolAfterRemoval = getUnscheduledEventBandsForEventDay({
          eventBands: previous,
          eventId: selectedEvent.id,
          eventDayId: timetableEventDayId,
          stages: timetableStages,
          scheduleItems: remainingScheduleItems,
        })
        const returnedEventBandIndex = poolAfterRemoval.findIndex(
          eventBand => eventBand.id === scheduleItem.eventBandId,
        )
        if (returnedEventBandIndex < 0) return previous

        const reordered = reorderUnscheduledEventBands(
          daySpecificBands,
          remainingDayScheduleItems,
          returnedEventBandIndex,
          destinationIndex,
        )
        return replaceEventBandsForEventDay(
          previous,
          selectedEvent.id,
          timetableEventDayId,
          reordered,
        )
      })
      return
    }

    // このPRでは同じStage内のレーン間移動だけを許可する
    if (sourceLane && destinationLane) {
      const sourceItem = getScheduleLaneItems(
        scheduleItems,
        sourceLane,
      )[sourceIndex]
      if (!sourceItem || sourceItem.id !== result.draggableId) return

      setScheduleItems(previous => moveScheduleItemWithinStage({
        scheduleItems: previous,
        stage: currentStage,
        stageSections: currentStageSections,
        sourceLane,
        sourceIndex,
        destinationLane,
        destinationIndex,
      }))
    }
  }

  const getEventBandMemberLabel = (eventBand?: EventBand) => {
    if (!eventBand || eventBand.memberIds.length === 0) return '未登録'
    return getEventBandMemberDisplayNames(eventBand, members).join(' / ')
  }

  // 選択日の全StageをIssue判定へ渡し、表示は選択中Stageだけに絞る
  const eventDayTimelines = selectedEvent && timetableSelection.eventDayId
    ? calculateEventDayTimelines({
        event: selectedEvent,
        eventDayId: timetableSelection.eventDayId,
        stages: timetableStages,
        sections: timetableSections,
        scheduleItems: currentEventDayScheduleItems,
        eventBands: selectedEventBands,
      })
    : { calculatedItems: [], invalidStages: [] }
  const calculatedItems = eventDayTimelines.calculatedItems
  const currentStageCalculatedItems = currentStage
    ? calculatedItems.filter(item => item.stageId === currentStage.id)
    : []
  const scheduleIssues = selectedEvent
    ? detectScheduleIssues({
        event: selectedEvent,
        members,
        eventMembers: selectedEventMembers,
        eventMemberDays: selectedEventMemberDays,
        eventBands: selectedEventBands,
        stages: timetableStages,
        sections: timetableSections,
        paAssignments: selectedEventPaAssignments.filter((assignment) =>
          assignment.eventDayId === timetableSelection.eventDayId,
        ),
        dutyTypes: selectedEventDutyTypes,
        dutyAssignments: selectedEventDutyAssignments.filter((assignment) =>
          assignment.eventDayId === timetableSelection.eventDayId,
        ),
        calculatedItems,
      })
    : []
  const currentStageIssues = currentStage
    ? getIssuesForStage(
        scheduleIssues,
        currentStage.id,
        currentEventDayScheduleItems,
      )
    : []
  const currentStageIssueCounts = countIssuesBySeverity(currentStageIssues)
  const timetableWorkspaceRows = currentStage && timetableSelection.eventDayId
    ? createTimetableWorkspaceRows({
        eventDayId: timetableSelection.eventDayId,
        stageId: currentStage.id,
        scheduleItems: currentStageScheduleItems,
        calculatedItems: currentStageCalculatedItems,
        eventBands: selectedEventBands,
        members,
        paAssignments: selectedEventPaAssignments,
        dutyTypes: selectedEventDutyTypes,
        dutyAssignments: selectedEventDutyAssignments,
        issues: currentStageIssues,
      })
    : {
        rows: [],
        unresolvedPaAssignments: [],
        offGridPaAssignments: [],
        unresolvedDutyAssignments: [],
        offGridDutyAssignments: [],
      }

  return (
    <AppShell
      activeSection={activeView === 'event-editor' ? 'events' : activeView}
      onNavigate={(section) => setActiveView(section)}
    >
      {activeView === 'event-editor' ? (
        <EventEditorShell
          eventName={selectedEvent?.name ?? 'イベント'}
          activeStep={activeStep}
          onStepChange={setActiveStep}
          onBackToEvents={() => setActiveView('events')}
        >
          {activeStep === 1 && selectedEvent ? (
            <EventBasicInfo
              key={selectedEvent.id}
              event={selectedEvent}
              eventDays={selectedEventDays}
              canDeleteEventDay={(eventDayId) => canDeleteEventDay(
                eventDayId,
                {
                  stages,
                  eventMemberDays,
                  eventBands,
                  paAssignments,
                  dutyAssignments,
                },
              )}
              onSave={handleSaveEventBasicInfo}
              onSaveAndNext={() => setActiveStep(2)}
            />
          ) : activeStep === 2 && selectedEvent ? (
            <EventStageSettings
              key={selectedEvent.id}
              event={selectedEvent}
              eventDays={selectedEventDays}
              stages={selectedStages}
              sections={selectedSections}
              canAddFirstSection={(stageId) => canAddFirstSection(
                stageId,
                sections,
                scheduleItems,
              )}
              canDeleteStage={(stageId) => canDeleteStage(stageId, {
                sections,
                scheduleItems,
                eventBands,
                paAssignments,
                dutyAssignments,
              })}
              canDeleteSection={(sectionId) => canDeleteSection(sectionId, {
                scheduleItems,
                eventBands,
              })}
              onSave={handleSaveEventStageSettings}
              onSaveAndNext={() => setActiveStep(3)}
            />
          ) : activeStep === 3 && selectedEvent ? (
            <EventMemberSettings
              key={selectedEvent.id}
              event={selectedEvent}
              eventDays={selectedEventDays}
              members={members}
              eventMembers={selectedEventMembers}
              eventMemberDays={selectedEventMemberDays}
              eventBands={selectedEventBands}
              createDraftId={() => createId('event-member-draft')}
              onSave={handleSaveEventMemberSettings}
              onSaveAndNext={() => setActiveStep(4)}
            />
          ) : activeStep === 4 && selectedEvent ? (
            <EventBandSettings
              key={selectedEvent.id}
              event={selectedEvent}
              eventDays={selectedEventDays}
              bands={bands}
              members={members}
              eventMembers={selectedEventMembers}
              eventMemberDays={selectedEventMemberDays}
              eventBands={selectedEventBands}
              scheduleItems={scheduleItems}
              createDraftId={() => createId('event-band-draft')}
              onSave={handleSaveEventBandSettings}
              onSaveAndNext={() => setActiveStep(5)}
            />
          ) : activeStep === 5 && selectedEvent ? (
            <EventBandConditions
              key={selectedEvent.id}
              event={selectedEvent}
              eventDays={selectedEventDays}
              eventBands={selectedEventBands}
              stages={selectedStages}
              sections={selectedSections}
              members={members}
              eventMembers={selectedEventMembers}
              eventMemberDays={selectedEventMemberDays}
              onSave={handleSaveEventBandConditions}
              onSaveAndNext={() => setActiveStep(6)}
            />
          ) : activeStep === 6 && selectedEvent ? (
            <DragDropContext onDragEnd={handleOnDragEnd}>
              <TimetableOperationsWorkspace
                eventDays={selectedEventDays}
                stages={timetableStages}
                selectedEventDayId={timetableSelection.eventDayId}
                selectedStageId={timetableSelection.stageId}
                onSelectEventDay={handleSelectTimetableEventDay}
                onSelectStage={handleSelectTimetableStage}
                poolCount={poolEventBands.length}
                issueCounts={currentStageIssueCounts}
                settings={currentStage ? (
                  <div className="timetable-toolbar-settings">
                    <label>
                      開始
                      <input
                        type="time"
                        value={startTime}
                        onChange={(event) => handleStageStartTimeChange(event.target.value)}
                      />
                    </label>
                    <label>
                      転換
                      <input
                        type="number"
                        min="0"
                        value={intervalTime}
                        onChange={(event) => handleStageTransitionMinutesChange(event.target.value)}
                      />
                      <span>分</span>
                    </label>
                  </div>
                ) : null}
                unavailableContent={!timetableEventDay ? (
                  <section className="timetable-empty-state">
                    <h3>開催日が設定されていません</h3>
                    <p>Step 1で開催日を設定してください。</p>
                  </section>
                ) : !currentStage ? (
                  <section className="timetable-empty-state">
                    <h3>この開催日にはStageがありません</h3>
                    <p>タイムテーブルを作成するには、Step 2でStageを設定してください。</p>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setActiveStep(2)}
                    >
                      Step 2 会場・Stageへ
                    </button>
                  </section>
                ) : currentStageHasInvalidSectionAssignments ? (
                  <section className="timetable-data-error" role="alert">
                    <h3>このStageのタイムテーブルを編集できません</h3>
                    <p>
                      有効なSectionに所属していない項目があります。データを確認してから再度開いてください。
                    </p>
                    <p>対象項目: {invalidCurrentStageScheduleItemIds.join('、')}</p>
                  </section>
                ) : undefined}
                pool={currentStage ? (
                  <>
                    <h3>未配置バンド</h3>
                    <Droppable droppableId={TIMETABLE_POOL_DROPPABLE_ID}>
                      {(provided) => (
                        <ul
                          {...provided.droppableProps}
                          ref={provided.innerRef}
                          className="timetable-pool-list"
                        >
                          {poolEventBands.map((eventBand, index) => (
                            <Draggable
                              key={eventBand.id}
                              draggableId={eventBand.id}
                              index={index}
                            >
                              {(provided) => (
                                <li
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  className="timetable-pool-card"
                                  style={provided.draggableProps.style}
                                >
                                  <div>
                                    <span className="timetable-drag-handle" aria-hidden="true">☰</span>
                                    <span className="timetable-pool-band-name">
                                      {eventBand.name}
                                    </span>
                                    <div className="timetable-item-members">
                                      {getEventBandMemberLabel(eventBand)}
                                    </div>
                                    <div className="timetable-item-duration">
                                      {eventBand.durationMinutes}分枠
                                    </div>
                                  </div>
                                </li>
                              )}
                            </Draggable>
                          ))}
                          {poolEventBands.length === 0 && (
                            <li className="timetable-lane__empty">
                              {currentDayEventBands.length === 0
                                ? '出演バンドがまだ登録されていません。Step 4で出演バンドを追加してください。'
                                : 'すべての出演バンドが配置されています。'}
                            </li>
                          )}
                          {provided.placeholder}
                        </ul>
                      )}
                    </Droppable>
                  </>
                ) : null}
                timetable={currentStage ? (
                  <TimetableGrid
                    stage={currentStage}
                    sections={currentStageUsesSections ? currentStageSections : []}
                    rows={timetableWorkspaceRows.rows}
                    unresolvedPaAssignments={timetableWorkspaceRows.unresolvedPaAssignments}
                    offGridPaAssignments={timetableWorkspaceRows.offGridPaAssignments}
                    dutyTypes={selectedEventDutyTypes}
                    unresolvedDutyAssignments={timetableWorkspaceRows.unresolvedDutyAssignments}
                    offGridDutyAssignments={timetableWorkspaceRows.offGridDutyAssignments}
                    transitionMinutes={intervalTime}
                    breakDuration={breakDuration}
                    onBreakDurationChange={setBreakDuration}
                    onAddBreak={handleAddBreak}
                    onRemoveScheduleItem={handleRemoveScheduleItem}
                  />
                ) : null}
                issuePanel={(
                  <IssuePanel
                    issues={currentStageIssues}
                    members={members}
                    eventBands={selectedEventBands}
                    dutyTypes={selectedEventDutyTypes}
                    stages={timetableStages}
                    sections={timetableSections}
                    calculatedItems={calculatedItems}
                  />
                )}
                renderPaPanel={(onValidationFailed) => currentStage ? (
                  <PaSettings
                    ref={paSettingsRef}
                    key={selectedEvent.id}
                    event={selectedEvent}
                    eventDays={selectedEventDays}
                    stages={selectedStages}
                    members={members}
                    eventMembers={selectedEventMembers}
                    eventMemberDays={selectedEventMemberDays}
                    eventBands={selectedEventBands}
                    scheduleItems={selectedScheduleItems}
                    calculatedItems={selectedEventCalculatedItems}
                    paAssignments={selectedEventPaAssignments}
                    selectedEventDayId={timetableSelection.eventDayId}
                    selectedStageId={currentStage.id}
                    onSelectScope={(eventDayId, stageId) => {
                      setSelectedTimetableEventDayId(eventDayId)
                      setSelectedTimetableStageId(stageId)
                    }}
                    onValidationFailed={onValidationFailed}
                    createDraftId={() => createId('pa-assignment-draft')}
                    formId={`pa-settings-${selectedEvent.id}`}
                    onSave={handleSavePaAssignments}
                    onSaveAndNext={() => {
                      if (!dutySettingsRef.current?.validateDraft()) return
                      if (dutySettingsRef.current.commitDraft()) setActiveStep(7)
                    }}
                  />
                ) : null}
                renderOperationsPanel={(onValidationFailed) => currentStage ? (
                  <DutySettings
                    ref={dutySettingsRef}
                    key={selectedEvent.id}
                    event={selectedEvent}
                    eventDays={selectedEventDays}
                    stages={selectedStages}
                    members={members}
                    eventMembers={selectedEventMembers}
                    eventMemberDays={selectedEventMemberDays}
                    eventBands={selectedEventBands}
                    scheduleItems={selectedScheduleItems}
                    calculatedItems={selectedEventCalculatedItems}
                    paAssignments={selectedEventPaAssignments}
                    dutyTypes={selectedEventDutyTypes}
                    dutyAssignments={selectedEventDutyAssignments}
                    selectedEventDayId={timetableSelection.eventDayId}
                    selectedStageId={currentStage.id}
                    onSelectScope={(eventDayId, stageId) => {
                      setSelectedTimetableEventDayId(eventDayId)
                      setSelectedTimetableStageId(stageId)
                    }}
                    onValidationFailed={onValidationFailed}
                    createDraftId={() => createId('duty-draft')}
                    onSave={handleSaveDutySettings}
                  />
                ) : null}
                footer={(
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleSaveStep6AndNext}
                  >
                    設定を保存して次へ <span aria-hidden="true">→</span>
                  </button>
                )}
              />
            </DragDropContext>
          ) : null}
        </EventEditorShell>
      ) : activeView === 'events' ? (
        <EventList
          events={events}
          eventDays={eventDays}
          stages={stages}
          eventBands={eventBands}
          onOpenEvent={handleOpenEvent}
          onCreateEvent={() => setIsCreateEventDialogOpen(true)}
        />
      ) : activeView === 'shared-data' ? (
        <CommonDataPage
          members={members}
          bands={bands}
          onSaveMember={handleSaveCommonMember}
          onSaveBand={handleSaveCommonBand}
        />
      ) : (
        <AppSectionPlaceholder
          title={appSectionPlaceholders[activeView].title}
          description={appSectionPlaceholders[activeView].description}
        />
      )}
      {isCreateEventDialogOpen && (
        <CreateEventDialog
          onCancel={() => setIsCreateEventDialogOpen(false)}
          onCreate={handleCreateEvent}
        />
      )}
    </AppShell>
  )
}

export default App
