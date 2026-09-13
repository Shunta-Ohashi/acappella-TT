import { useState, type FormEvent } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd'
import type {
  Band,
  BandId,
  Event as TimetableEvent,
  EventBand,
  EventDay,
  EventDayId,
  EventId,
  EventMember,
  EventMemberDay,
  Member,
  MemberId,
  ScheduleItem,
  Section,
  SectionId,
  Stage,
  StageId,
} from './domain/models'
import {
  createBreakScheduleItemForLane,
  createPerformanceScheduleItemForLane,
  getEventBandById,
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
import { formatMinuteAsLocalTime } from './domain/timeline'
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
import { getHighestSeverityByScheduleItem } from './ui/issuePresentation'
import {
  getSectionDroppableId,
  getStageDroppableId,
  parseTimetableDroppableId,
  resolveScheduleLane,
  TIMETABLE_POOL_DROPPABLE_ID,
} from './ui/timetableDnd'
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

const formatEventDayLabel = (eventDay: EventDay): string => {
  if (eventDay.label?.trim()) return eventDay.label.trim()
  const [, month, day] = eventDay.date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

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
  const [activeStep, setActiveStep] = useState<EventEditorStepId>(7)
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

  const handleAddBreak = (
    e: FormEvent<HTMLFormElement>,
    sectionId?: SectionId,
  ) => {
    e.preventDefault()
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

  const getMemberNamesByIds = (ids?: string[]) => {
    if (!ids) return '未登録'
    return ids.map(id => members.find(m => m.id === id)?.realName || '不明').join(', ')
  }

  const getBandNameByEventBand = (eventBand?: EventBand) => {
    if (!eventBand) return '不明なバンド'
    return eventBand.name
  }

  // 選択日の全StageをIssue判定へ渡し、表示は選択中Stageだけに絞る
  const currentStageScheduleItemsById = new Map(
    currentStageScheduleItems.map(scheduleItem => [scheduleItem.id, scheduleItem]),
  )
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
        eventMembers: selectedEventMembers,
        eventMemberDays: selectedEventMemberDays,
        eventBands: selectedEventBands,
        stages: timetableStages,
        sections: timetableSections,
        calculatedItems,
      })
    : []
  const highestSeverityByScheduleItem =
    getHighestSeverityByScheduleItem(scheduleIssues)
  const calculatedTimetable = currentStageCalculatedItems.map(calculatedItem => {
    const scheduleItem = currentStageScheduleItemsById.get(calculatedItem.scheduleItemId)
    if (!scheduleItem) {
      throw new Error(`ScheduleItem not found: ${calculatedItem.scheduleItemId}`)
    }

    const eventBand = scheduleItem.kind === 'performance'
      ? getEventBandById(selectedEventBands, scheduleItem.eventBandId)
      : undefined
    const durationMinutes = calculatedItem.plannedEndMinute - calculatedItem.plannedStartMinute

    return {
      scheduleItem,
      eventBand,
      durationMinutes,
      timeString: `${formatMinuteAsLocalTime(calculatedItem.plannedStartMinute)} 〜 ${formatMinuteAsLocalTime(calculatedItem.plannedEndMinute)}`,
    }
  })
  const calculatedTimetableByScheduleItemId = new Map(
    calculatedTimetable.map(item => [item.scheduleItem.id, item]),
  )

  // 共通スタイル定義（可読性向上のためまとめる）
  const containerStyle: React.CSSProperties = { maxWidth: '1250px', margin: '0 auto', textAlign: 'left' }
  const sectionBase: React.CSSProperties = { padding: '15px', borderRadius: '8px', marginBottom: '20px' }
  const baseButton: React.CSSProperties = { border: 'none', padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }
  const listItemBase: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', marginBottom: '8px', borderRadius: '4px', color: '#333', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }
  const listContainerBase: React.CSSProperties = { listStyle: 'none', minHeight: '300px', padding: '10px', borderRadius: '8px', border: '2px dashed #cbd5e0' }

  const renderScheduleLane = (
    lane: ScheduleLane,
    droppableId: string,
    emptyMessage: string,
    minimumHeight = '300px',
  ) => {
    const laneItems = getScheduleLaneItems(currentStageScheduleItems, lane)

    return (
      <Droppable droppableId={droppableId}>
        {(provided) => (
          <ul
            {...provided.droppableProps}
            ref={provided.innerRef}
            className="timetable-lane"
            style={{
              ...listContainerBase,
              minHeight: minimumHeight,
              background: '#edf2f7',
            }}
          >
            {laneItems.map((scheduleItem, index) => {
              const timetableItem = calculatedTimetableByScheduleItemId.get(
                scheduleItem.id,
              )
              if (!timetableItem) return null

              const {
                eventBand,
                durationMinutes,
                timeString,
              } = timetableItem
              const issueSeverity = highestSeverityByScheduleItem.get(
                scheduleItem.id,
              )

              return (
                <Draggable
                  key={scheduleItem.id}
                  draggableId={scheduleItem.id}
                  index={index}
                >
                  {(provided) => (
                    <li
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                      className={issueSeverity
                        ? `schedule-item schedule-item--${issueSeverity.toLowerCase()}`
                        : 'schedule-item'}
                      style={{
                        ...listItemBase,
                        background: scheduleItem.kind === 'break'
                          ? '#e6fffa'
                          : '#fff',
                        ...provided.draggableProps.style,
                      }}
                    >
                      <div>
                        <span className="timetable-drag-handle" aria-hidden="true">
                          ☰
                        </span>
                        <span
                          className={scheduleItem.kind === 'break'
                            ? 'timetable-item-time timetable-item-time--break'
                            : 'timetable-item-time'}
                        >
                          {timeString}
                        </span>
                        <span>
                          {scheduleItem.kind === 'break' ? '☕' : '🎵'}{' '}
                          {scheduleItem.kind === 'break'
                            ? scheduleItem.title
                            : getBandNameByEventBand(eventBand)}{' '}
                          ({durationMinutes}分)
                        </span>
                        {issueSeverity && (
                          <span className={`schedule-item__issue-label schedule-item__issue-label--${issueSeverity.toLowerCase()}`}>
                            {issueSeverity}
                          </span>
                        )}
                        {scheduleItem.kind === 'performance' && (
                          <div className="timetable-item-members">
                            メンバー: {getMemberNamesByIds(eventBand?.memberIds)}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveScheduleItem(scheduleItem.id)}
                        style={{
                          ...baseButton,
                          background: '#e53e3e',
                          color: 'white',
                          padding: '6px 12px',
                          fontSize: '13px',
                        }}
                      >
                        {scheduleItem.kind === 'break' ? '削除' : '外す'}
                      </button>
                    </li>
                  )}
                </Draggable>
              )
            })}
            {laneItems.length === 0 && (
              <li className="timetable-lane__empty">{emptyMessage}</li>
            )}
            {provided.placeholder}
          </ul>
        )}
      </Droppable>
    )
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
          ) : activeStep === 7 && selectedEvent ? (
          <div className="timetable-workspace" style={containerStyle}>
            <section className="timetable-scope" aria-label="表示するタイムテーブル">
              <div className="timetable-scope__group">
                <p>開催日</p>
                <div className="timetable-scope__choices">
                  {selectedEventDays.map((eventDay) => {
                    const isSelected = eventDay.id === timetableSelection.eventDayId
                    return (
                      <button
                        key={eventDay.id}
                        type="button"
                        className={isSelected
                          ? 'timetable-scope__button timetable-scope__button--active'
                          : 'timetable-scope__button'}
                        aria-pressed={isSelected}
                        onClick={() => handleSelectTimetableEventDay(eventDay.id)}
                      >
                        {formatEventDayLabel(eventDay)}
                        {isSelected && <small>選択中</small>}
                      </button>
                    )
                  })}
                </div>
              </div>

              {timetableEventDay && (
                <div className="timetable-scope__group">
                  <p>Stage</p>
                  <div className="timetable-scope__choices">
                    {timetableStages.map((stage) => {
                      const isSelected = stage.id === currentStage?.id
                      return (
                        <button
                          key={stage.id}
                          type="button"
                          className={isSelected
                            ? 'timetable-scope__button timetable-scope__button--active'
                            : 'timetable-scope__button'}
                          aria-pressed={isSelected}
                          onClick={() => handleSelectTimetableStage(stage.id)}
                        >
                          {stage.name}
                          {isSelected && <small>選択中</small>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>

            {!timetableEventDay ? (
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
            ) : (
              <>

      {/* ==================== ⚙️ スケジュール基本設定 ==================== */}
      <section style={{ ...sectionBase, background: '#edf2f7', color: '#2d3748' }}>
        <h3 style={{ marginTop: 0 }}>⚙️ 2. スケジュール基本設定</h3>
        <div className="timetable-settings" style={{ display: 'flex', gap: '20px' }}>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>イベント開始時刻:</label>
            <input type="time" aria-label="イベント開始時刻" value={startTime} onChange={(e) => handleStageStartTimeChange(e.target.value)} style={{ padding: '6px', marginTop: '5px' }} />
          </div>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>転換時間 (分):</label>
            <input type="number" min="0" aria-label="転換時間" value={intervalTime} onChange={(e) => handleStageTransitionMinutesChange(e.target.value)} style={{ padding: '6px', width: '60px', marginTop: '5px' }} />
          </div>
        </div>
      </section>

      {/* ==================== 🎴 ドラッグ＆ドロップ編成 ==================== */}
      <DragDropContext onDragEnd={handleOnDragEnd}>
        <div className="timetable-board" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
          
          {/* 📁 左画面：出演候補プール */}
          <div>
            <h3>📁 出演候補バンド一覧（プール）</h3>
            <Droppable droppableId={TIMETABLE_POOL_DROPPABLE_ID}>
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef} style={{ ...listContainerBase, background: '#f7fafc' }}>
                  {poolEventBands.map((eventBand, index) => (
                    <Draggable key={eventBand.id} draggableId={eventBand.id} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={{ ...listItemBase, background: '#fff', ...provided.draggableProps.style }}>
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold' }}>🎵 {eventBand.name}</span> ({eventBand.durationMinutes}分)
                            <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px' }}>👥 メンバー: {getMemberNamesByIds(eventBand.memberIds)}</div>
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
          </div>

          {/* 📅 右画面：当日のタイムテーブル */}
          <div>
            {currentStageUsesSections ? (
              <div className="timetable-section-list">
                {currentStageSections.map((section) => (
                  <section key={section.id} className="timetable-section-lane">
                    <header className="timetable-section-lane__header">
                      <div>
                        <p>SECTION {section.order + 1}</p>
                        <h3>{section.name}</h3>
                        {(section.plannedStartTime || section.plannedEndTime) && (
                          <span>
                            {section.plannedStartTime
                              ? `固定開始 ${section.plannedStartTime}`
                              : '開始は前Sectionから継続'}
                            {section.plannedEndTime
                              ? ` / 固定終了 ${section.plannedEndTime}`
                              : ''}
                          </span>
                        )}
                      </div>
                      <form
                        className="timetable-section-lane__break-form"
                        onSubmit={(event) => handleAddBreak(event, section.id)}
                      >
                        <label htmlFor={`break-duration-${section.id}`}>
                          休憩時間（分）
                        </label>
                        <input
                          id={`break-duration-${section.id}`}
                          type="number"
                          min="1"
                          value={breakDuration}
                          onChange={(event) => setBreakDuration(Number(event.target.value))}
                        />
                        <button
                          type="submit"
                          aria-label={`${section.name}に休憩を追加`}
                        >
                          ＋ 休憩を追加
                        </button>
                      </form>
                    </header>
                    {renderScheduleLane(
                      { stageId: currentStage.id, sectionId: section.id },
                      getSectionDroppableId(section.id),
                      'このSectionにはまだ項目がありません。',
                      '120px',
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <>
                <section style={{ ...sectionBase, background: '#e6fffa', color: '#234e52' }}>
                  <h3 style={{ marginTop: 0 }}>☕ 休憩枠を直接差し込む</h3>
                  <form onSubmit={(event) => handleAddBreak(event)} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '12px', fontWeight: 'bold' }}>休憩時間 (分):</label>
                      <input type="number" min="1" aria-label="休憩時間" value={breakDuration} onChange={(e) => setBreakDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', marginTop: '5px', boxSizing: 'border-box' }} />
                    </div>
                    <button type="submit" style={{ background: '#319795', color: 'white', padding: '8px 16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', height: '37px' }}>休憩を追加</button>
                  </form>
                </section>

                <h3>📅 {currentStage.name}のタイムテーブル</h3>
                {renderScheduleLane(
                  { stageId: currentStage.id },
                  getStageDroppableId(currentStage.id),
                  'タイムテーブルに項目を配置してください。',
                )}
              </>
            )}
            <IssuePanel
              issues={scheduleIssues}
              members={members}
              eventBands={selectedEventBands}
              stages={timetableStages}
              sections={timetableSections}
              calculatedItems={calculatedItems}
            />
          </div>

        </div>
      </DragDropContext>
              </>
            )}
          </div>
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
