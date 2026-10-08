import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
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
  TimetableLock,
  TimetableLockId,
  TimetableOrderConstraint,
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
  isValidBreakDurationMinutes,
  moveScheduleItemWithinStage,
  removeScheduleItem,
  reorderScheduleLaneItems,
  reorderUnscheduledEventBands,
  resolveTimetableSelection,
  type ScheduleLane,
} from './domain/schedule'
import { evaluateEventDayTimelinesSafely } from './domain/timetable'
import { formatMinuteAsLocalTime } from './domain/timeline'
import { detectScheduleIssues } from './domain/issues'
import {
  AppShell,
  type AppSection,
} from './components/AppShell'
import {
  EventEditorShell,
  type EventEditorStepId,
} from './components/EventEditorShell'
import { CreateEventDialog } from './components/CreateEventDialog'
import {
  EventBasicInfo,
  type EventBasicInfoHandle,
  type EventDeletionActionResult,
} from './components/EventBasicInfo'
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
import {
  TimetableGrid,
  TimetableLockRepairPanel,
} from './components/TimetableGrid'
import { TimetableGridAssignmentDialog } from './components/TimetableGridAssignmentDialog'
import { TimetableGridAssignmentDeletionDialog } from './components/TimetableGridAssignmentDeletionDialog'
import { TimetableDutyAutoAssignmentDialog } from './components/TimetableDutyAutoAssignmentDialog'
import { TimetableOperationsWorkspace } from './components/TimetableOperationsWorkspace'
import { TimetableOrderConstraintSettings } from './components/TimetableOrderConstraintSettings'
import { TimetableOrderConstraintRepairPanel } from './components/TimetableOrderConstraintRepairPanel'
import {
  areTimetableGridAssignmentTargetsEqual,
  resolveTimetableGridSelection,
  type ResolvedTimetableGridRangeSelection,
  type TimetableGridRangeSelection,
} from './ui/timetableGridSelection'
import {
  createTimetableGridAssignment,
  deleteTimetableGridAssignments,
  getTimetableGridAssignmentCandidates,
  getTimetableGridSelectionAssignmentTargets,
  type TimetableGridAssignmentCandidate,
  type TimetableGridAssignmentDeletionPresentation,
  type TimetableGridAssignmentDeletionTarget,
} from './ui/timetableGridAssignment'
import { TimetableGenerationPreviewDialog } from './components/TimetableGenerationPreviewDialog'
import { TimetableGenerationOptionsDialog } from './components/TimetableGenerationOptionsDialog'
import { TimetableGenerationFailureGuidance } from './components/TimetableGenerationFailureGuidance'
import { TimetableResetConfirmDialog } from './components/TimetableResetConfirmDialog'
import { createScheduleItemsForTimetableGeneration, DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS,
  hasValidTimetableGenerationPreprocessingInput, validateTimetableGenerationBreakRemoval,
  type TimetableGenerationUiOptions } from './domain/timetableGenerationOptions'
import { resetEventDayTimetable } from './domain/timetableReset'
import {
  getUnsavedOperationsNavigationMessage,
  hasUnsavedOperationsChanges,
} from './ui/operationsDraftChanges'
import {
  cloneTimetableEditSnapshot,
  createTimetableHistoryController,
  type TimetableEditSnapshot,
  type TimetableHistoryEntry,
} from './ui/timetableHistory'
import {
  createDutyAutoAssignments,
  planDutyAutoAssignments,
  type DutyAutoAssignmentPlanResult,
} from './domain/dutyAutoAssignment'
import { generateTimetablePlan } from './domain/timetableGeneration'
import {
  materializeTimetableGenerationPlan, validateTimetableGenerationCandidate,
  type MaterializedTimetable,
} from './domain/timetableGenerationApply'
import {
  createTimetableGenerationPreview, formatGenerationDay, presentTimetableGenerationFailure,
  type TimetableGenerationFailurePresentation,
  type TimetableGenerationPreview,
} from './ui/timetableGenerationPresentation'
import { EventList } from './components/EventList'
import { DataBackupSettings } from './components/DataBackupSettings'
import { EventOutputPage } from './components/EventOutputPage'
import { EventFinalCheckPage } from './components/EventFinalCheckPage'
import { IssuePanel } from './components/IssuePanel'
import { createEventFinalCheckReport } from './ui/eventFinalCheckReport'
import {
  resolveEventFinalCheckRepairNavigation,
  type EventFinalCheckRepairTarget,
} from './ui/eventFinalCheckPresentation'
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
  canSetStageStartTime,
  canDeleteSection,
  canDeleteStage,
  createEventStageSettingsUpdate,
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
  checkCommonBandDeletion,
  checkCommonMemberDeletion,
  createCommonBandDeletion,
  createCommonMemberDeletion,
  type CommonBandDeletionCheck,
  type CommonBandDeletionResult,
  type CommonMemberDeletionCheck,
  type CommonMemberDeletionResult,
} from './domain/commonDataDeletion'
import {
  checkEventDeletion,
  createEventDeletion,
  type EventDeletionCheck,
  type EventDeletionInput,
  type EventDeletionResult,
} from './domain/eventDeletion'
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
  getDutyAssignmentsForEvent,
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
import {
  clearTimetableLockFeedback,
  getTimetableLockFeedbackMessage,
  type TimetableLockFeedback,
} from './ui/timetableLockPresentation'
import {
  applyTimetableLock,
  evaluateTimetableLocks,
  removeTimetableLock,
  removeTimetableLocksForEvent,
  type TimetableLockMode,
} from './domain/timetableLocks'
import { evaluateTimetableOrderConstraintManualTransition } from './domain/timetableOrderConstraintManualPlacement'
import {
  createTimetableOrderConstraintBlockPresentations,
  getTimetableOrderConstraintBlockMember,
} from './ui/timetableOrderConstraintLinkPresentation'
import { createDemoData } from './data/demoData'
import {
  createCloudScopedStorageKey,
  isPersistenceScopeReady,
  loadPersistedStateOrFallback,
  savePersistedState,
  STORAGE_KEY,
  type PersistedAppStateV5,
  type PersistedDomainState,
} from './persistence/localPersistence'
import {
  createBackupFilename,
  createBackupJson,
  parseBackupJson,
} from './persistence/dataBackup'
import { useOptionalCloudWorkspace } from './cloud/useCloudWorkspace.ts'
import { canEditCloudWorkspace } from './cloud/cloudWorkspace.ts'
import { createSupabaseCloudEventRepository } from './cloud/cloudEventRepository.ts'
import {
  createCloudEventOperationRegistry,
  getCloudEventHydrationView,
  getCloudEventOperation,
  isCloudEventCacheWriteReady,
  loadCloudWorkspaceEvents,
  runCloudEventHydrationAttempt,
  runExclusiveCloudEventDeletion,
  runExclusiveCloudEventSave,
  saveCloudEventFromState,
  type CloudEventHydrationState,
} from './cloud/cloudEventLifecycle.ts'
import './App.css'

type AppView = 'event-editor' | AppSection

interface TimetableOrderConstraintFeedback {
  eventId: EventId
  eventDayId: EventDayId
  stageId: StageId
  message: string
}

interface GenerationPreviewState {
  eventId: EventId
  eventDayId: EventDayId
  sourceState: PersistedDomainState
  candidate: MaterializedTimetable
  presentation: TimetableGenerationPreview
  options: TimetableGenerationUiOptions
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
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
} satisfies Pick<
  TimetableEvent,
  'timeZone' | 'validationPolicy'
>

const READ_ONLY_WORKSPACE_MESSAGE =
  '閲覧権限のワークスペースではデータを変更できません。'

function App() {
  const cloudWorkspace = useOptionalCloudWorkspace()
  const canEditWorkspace = cloudWorkspace === null ||
    canEditCloudWorkspace(cloudWorkspace.membership.role)
  const canEditWorkspaceRef = useRef(canEditWorkspace)
  useLayoutEffect(() => {
    canEditWorkspaceRef.current = canEditWorkspace
  }, [canEditWorkspace])
  const cloudSupabase = cloudWorkspace?.supabase
  const cloudEventRepository = useMemo(
    () => cloudSupabase
      ? createSupabaseCloudEventRepository(cloudSupabase)
      : undefined,
    [cloudSupabase],
  )
  const requestedPersistenceStorageKey = cloudWorkspace
    ? createCloudScopedStorageKey({
        userId: cloudWorkspace.user.id,
        workspaceId: cloudWorkspace.workspace.id,
      })
    : STORAGE_KEY
  const [activePersistenceStorageKey, setActivePersistenceStorageKey] = useState(
    requestedPersistenceStorageKey,
  )
  const [initialAppState] = useState(() =>
    loadPersistedStateOrFallback(
      createDemoData,
      undefined,
      requestedPersistenceStorageKey,
    ),
  )
  const initialEventId = initialAppState.events[0]?.id ?? ''
  const initialEventDayId = getEventDaysForEvent(
    initialAppState.eventDays,
    initialEventId,
  )[0]?.id
  const initialStageId = initialEventDayId
    ? getStagesForEventDay(initialAppState.stages, initialEventDayId)[0]?.id
    : undefined
  const [activeView, setActiveView] = useState<AppView>('events')
  const [activeStep, setActiveStep] = useState<EventEditorStepId>(6)
  const [selectedEventId, setSelectedEventId] = useState<EventId>(
    initialEventId,
  )
  const [selectedTimetableEventDayId, setSelectedTimetableEventDayId] =
    useState<EventDayId | undefined>(initialEventDayId)
  const [selectedTimetableStageId, setSelectedTimetableStageId] =
    useState<StageId | undefined>(initialStageId)
  const [isCreateEventDialogOpen, setIsCreateEventDialogOpen] = useState(false)
  const [isImportingBackup, setIsImportingBackup] = useState(false)
  const importingBackupRef = useRef(false)
  const [backupFeedback, setBackupFeedback] = useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const [cloudEventLoadState, setCloudEventLoadState] = useState<CloudEventHydrationState>(
    cloudWorkspace
      ? { scopeKey: '', kind: 'loading' }
      : { scopeKey: STORAGE_KEY, kind: 'ready' },
  )
  const [cloudEventReloadToken, setCloudEventReloadToken] = useState(0)
  const [cloudEventOperationRegistry] = useState(createCloudEventOperationRegistry)
  const [cloudEventOperations, setCloudEventOperations] = useState<ReadonlyMap<
    string,
    'save' | 'delete'
  >>(
    () => new Map(),
  )
  const [cloudEventSaveFeedback, setCloudEventSaveFeedback] = useState<{
    eventId: EventId
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const currentPersistenceScopeRef = useRef(requestedPersistenceStorageKey)
  const [breakDuration, setBreakDuration] = useState<number>(10)

  useLayoutEffect(() => {
    currentPersistenceScopeRef.current = requestedPersistenceStorageKey
  }, [requestedPersistenceStorageKey])

  // ==================== 📦 各種状態（State）の管理 ====================

  const [events, setEvents] = useState<TimetableEvent[]>(initialAppState.events)
  const [eventDays, setEventDays] = useState<EventDay[]>(initialAppState.eventDays)
  const [stages, setStages] = useState<Stage[]>(initialAppState.stages)
  const [sections, setSections] = useState<Section[]>(initialAppState.sections)
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
  const [members, setMembers] = useState<Member[]>(initialAppState.members)

  // 2️⃣ バンドデータベース（初期データ）
  const [bands, setBands] = useState<Band[]>(initialAppState.bands)

  // 3️⃣ このイベントに出演するバンド
  const [eventBands, setEventBands] = useState<EventBand[]>(
    initialAppState.eventBands,
  )
  const [eventMembers, setEventMembers] = useState<EventMember[]>(
    initialAppState.eventMembers,
  )
  const [eventMemberDays, setEventMemberDays] = useState<EventMemberDay[]>(
    initialAppState.eventMemberDays,
  )
  const [paAssignments, setPaAssignments] = useState<PaAssignment[]>(
    initialAppState.paAssignments,
  )
  const [dutyTypes, setDutyTypes] = useState<DutyType[]>(
    initialAppState.dutyTypes,
  )
  const [dutyAssignments, setDutyAssignments] = useState<DutyAssignment[]>(
    initialAppState.dutyAssignments,
  )
  const [timetableLocks, setTimetableLocks] = useState<TimetableLock[]>(
    initialAppState.timetableLocks,
  )
  const [timetableOrderConstraints, setTimetableOrderConstraints] = useState<
    TimetableOrderConstraint[]
  >(initialAppState.timetableOrderConstraints)
  const [timetableLockFeedback, setTimetableLockFeedback] = useState<
    TimetableLockFeedback | null
  >(null)
  const [timetableOrderConstraintFeedback, setTimetableOrderConstraintFeedback] = useState<
    TimetableOrderConstraintFeedback | null
  >(null)
  const [activeTimetableOrderBlockKey, setActiveTimetableOrderBlockKey] = useState<
    string | null
  >(null)
  const [timetableHistoryController] = useState(createTimetableHistoryController)
  const timetableHistory = useSyncExternalStore(
    timetableHistoryController.subscribe,
    timetableHistoryController.getState,
    timetableHistoryController.getState,
  )
  const timetableHistorySessionEventIdRef = useRef<EventId | null>(null)
  const timetableHistoryReplayRef = useRef(false)
  const [timetableHistoryFeedback, setTimetableHistoryFeedback] = useState<{
    eventId: EventId
    entry: TimetableHistoryEntry
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const [step6NavigationFeedback, setStep6NavigationFeedback] = useState<{
    eventId: EventId
    message: string
  } | null>(null)
  const paSettingsRef = useRef<PaSettingsHandle>(null)
  const dutySettingsRef = useRef<DutySettingsHandle>(null)
  const eventBasicInfoRef = useRef<EventBasicInfoHandle>(null)
  const [generationPreview, setGenerationPreview] = useState<GenerationPreviewState | null>(null)
  const [operationsPanelRevision, setOperationsPanelRevision] = useState(0)
  const [generationOptions, setGenerationOptions] = useState<TimetableGenerationUiOptions>(
    { ...DEFAULT_TIMETABLE_GENERATION_UI_OPTIONS },
  )
  const [generationOptionsScope, setGenerationOptionsScope] = useState<{
    eventId: EventId; eventDayId: EventDayId
  } | null>(null)
  const [resetConfirmation, setResetConfirmation] = useState<{
    eventId: EventId; eventDayId: EventDayId; sourceState: PersistedDomainState
  } | null>(null)
  const [generationFeedback, setGenerationFeedback] = useState<{
    eventId: EventId; eventDayId: EventDayId; kind: 'success' | 'error'; message: string
    guidance?: TimetableGenerationFailurePresentation
  } | null>(null)
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
    initialAppState.scheduleItems,
  )
  const timetableGridSelectionContext = {
    activeStep,
    dutyTypes,
    scheduleItems,
    eventId: selectedEventId,
    eventDayId: timetableSelection.eventDayId,
    stageId: timetableSelection.stageId,
  }
  const [timetableGridSelectionState, setTimetableGridSelectionState] = useState<{
    context: typeof timetableGridSelectionContext
    selection: TimetableGridRangeSelection | null
  }>(() => ({ context: timetableGridSelectionContext, selection: null }))
  const [gridAssignmentDialog, setGridAssignmentDialog] = useState<{
    eventId: EventId
    selection: ResolvedTimetableGridRangeSelection
    targetLabel: string
    candidates: TimetableGridAssignmentCandidate[]
    errors: string[]
  } | null>(null)
  const [dutyAutoAssignmentDialog, setDutyAutoAssignmentDialog] = useState<{
    eventId: EventId
    selection: ResolvedTimetableGridRangeSelection
    dutyTypeName: string
    additionalCount: string
    preview: DutyAutoAssignmentPlanResult
    notice?: string
    errors: string[]
  } | null>(null)
  const [gridAssignmentDeletion, setGridAssignmentDeletion] = useState<{
    eventId: EventId
    eventDayId: EventDayId
    stageId: StageId
    selection: ResolvedTimetableGridRangeSelection
    targets: TimetableGridAssignmentDeletionTarget[]
    items: TimetableGridAssignmentDeletionPresentation[]
    includesOutsideSelection: boolean
  } | null>(null)
  const [gridAssignmentFeedback, setGridAssignmentFeedback] = useState<{
    eventId: EventId
    eventDayId: EventDayId
    stageId: StageId
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const selectionContextMatches =
    timetableGridSelectionState.context.activeStep === activeStep &&
    timetableGridSelectionState.context.dutyTypes === dutyTypes &&
    timetableGridSelectionState.context.scheduleItems === scheduleItems &&
    timetableGridSelectionState.context.eventId === selectedEventId &&
    timetableGridSelectionState.context.eventDayId === timetableSelection.eventDayId &&
    timetableGridSelectionState.context.stageId === timetableSelection.stageId
  if (!selectionContextMatches) {
    setTimetableGridSelectionState({
      context: timetableGridSelectionContext,
      selection: null,
    })
  }
  const timetableGridSelection = selectionContextMatches
    ? timetableGridSelectionState.selection
    : null

  useEffect(() => {
    if (canEditWorkspace) return
    const timeoutId = window.setTimeout(() => {
      setIsCreateEventDialogOpen(false)
      setGenerationPreview(null)
      setGenerationOptionsScope(null)
      setResetConfirmation(null)
      setGridAssignmentDialog(null)
      setDutyAutoAssignmentDialog(null)
      setGridAssignmentDeletion(null)
      setTimetableGridSelectionState((current) => ({
        ...current,
        selection: null,
      }))
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [canEditWorkspace])

  const handleTimetableGridSelectionChange = (
    selection: TimetableGridRangeSelection | null,
  ) => {
    if (!canEditWorkspace && selection !== null) return
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setTimetableGridSelectionState({
      context: {
        activeStep,
        dutyTypes,
        scheduleItems,
        eventId: selectedEventId,
        eventDayId: timetableSelection.eventDayId,
        stageId: timetableSelection.stageId,
      },
      selection,
    })
  }

  const rehydratePersistenceScope = useEffectEvent((
    snapshot: PersistedAppStateV5,
    storageKey: string,
  ) => {
    const nextEventId = snapshot.events.some(event => event.id === selectedEventId)
      ? selectedEventId
      : snapshot.events[0]?.id ?? ''
    const nextEventDays = getEventDaysForEvent(snapshot.eventDays, nextEventId)
    const nextEventDayId = nextEventDays.some(
      eventDay => eventDay.id === selectedTimetableEventDayId,
    )
      ? selectedTimetableEventDayId
      : nextEventDays[0]?.id
    const nextStages = nextEventDayId
      ? getStagesForEventDay(snapshot.stages, nextEventDayId)
      : []
    const nextStageId = nextStages.some(stage => stage.id === selectedTimetableStageId)
      ? selectedTimetableStageId
      : nextStages[0]?.id

    setMembers(snapshot.members)
    setBands(snapshot.bands)
    setEvents(snapshot.events)
    setEventDays(snapshot.eventDays)
    setStages(snapshot.stages)
    setSections(snapshot.sections)
    setEventMembers(snapshot.eventMembers)
    setEventMemberDays(snapshot.eventMemberDays)
    setEventBands(snapshot.eventBands)
    setScheduleItems(snapshot.scheduleItems)
    setPaAssignments(snapshot.paAssignments)
    setDutyTypes(snapshot.dutyTypes)
    setDutyAssignments(snapshot.dutyAssignments)
    setTimetableLocks(snapshot.timetableLocks)
    setTimetableOrderConstraints(snapshot.timetableOrderConstraints)
    setSelectedEventId(nextEventId)
    setSelectedTimetableEventDayId(nextEventDayId)
    setSelectedTimetableStageId(nextStageId)
    timetableHistoryController.reset()
    timetableHistorySessionEventIdRef.current = null
    timetableHistoryReplayRef.current = false
    setOperationsPanelRevision(revision => revision + 1)
    setActivePersistenceStorageKey(storageKey)
  })

  useEffect(() => {
    if (isPersistenceScopeReady(
      activePersistenceStorageKey,
      requestedPersistenceStorageKey,
    )) return

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      rehydratePersistenceScope(loadPersistedStateOrFallback(
        createDemoData,
        undefined,
        requestedPersistenceStorageKey,
      ), requestedPersistenceStorageKey)
    })
    return () => {
      cancelled = true
    }
  }, [activePersistenceStorageKey, requestedPersistenceStorageKey])

  const persistenceScopeReady = isPersistenceScopeReady(
    activePersistenceStorageKey,
    requestedPersistenceStorageKey,
  )
  const cloudEventScopeReady = isCloudEventCacheWriteReady({
    cloudEnabled: Boolean(cloudWorkspace),
    persistenceScopeReady,
    requestedScopeKey: requestedPersistenceStorageKey,
    hydration: cloudEventLoadState,
  })

  const domainState = useMemo<PersistedDomainState>(() => ({
    members,
    bands,
    events,
    eventDays,
    stages,
    sections,
    eventMembers,
    eventMemberDays,
    eventBands,
    scheduleItems,
    paAssignments,
    dutyTypes,
    dutyAssignments,
    timetableLocks,
    timetableOrderConstraints,
  }), [
    members,
    bands,
    events,
    eventDays,
    stages,
    sections,
    eventMembers,
    eventMemberDays,
    eventBands,
    scheduleItems,
    paAssignments,
    dutyTypes,
    dutyAssignments,
    timetableLocks,
    timetableOrderConstraints,
  ])
  const latestDomainStateRef = useRef(domainState)
  useLayoutEffect(() => {
    latestDomainStateRef.current = domainState
  }, [domainState])
  useEffect(() => {
    if (!cloudEventScopeReady) return
    savePersistedState(domainState, undefined, activePersistenceStorageKey)
  }, [
    activePersistenceStorageKey,
    cloudEventScopeReady,
    domainState,
  ])

  const timetableHistoryActive = canEditWorkspace && activeView === 'event-editor' &&
    activeStep === 6 && selectedEventId.length > 0
  useEffect(() => {
    if (!timetableHistoryActive) {
      timetableHistoryController.reset()
      timetableHistorySessionEventIdRef.current = null
      timetableHistoryReplayRef.current = false
      return
    }
    const entry: TimetableHistoryEntry = {
      snapshot: {
        stages,
        eventBands,
        scheduleItems,
        paAssignments,
        dutyTypes,
        dutyAssignments,
        timetableLocks,
        timetableOrderConstraints,
      },
      context: {
        ...(timetableSelection.eventDayId
          ? { eventDayId: timetableSelection.eventDayId }
          : {}),
        ...(timetableSelection.stageId
          ? { stageId: timetableSelection.stageId }
          : {}),
      },
    }
    if (timetableHistorySessionEventIdRef.current !== selectedEventId) {
      timetableHistorySessionEventIdRef.current = selectedEventId
      timetableHistoryReplayRef.current = false
      timetableHistoryController.reset(entry)
      return
    }
    if (timetableHistoryReplayRef.current) {
      timetableHistoryReplayRef.current = false
      return
    }
    timetableHistoryController.record(entry)
  }, [
    timetableHistoryActive,
    timetableHistoryController,
    selectedEventId,
    timetableSelection.eventDayId,
    timetableSelection.stageId,
    stages,
    eventBands,
    scheduleItems,
    paAssignments,
    dutyTypes,
    dutyAssignments,
    timetableLocks,
    timetableOrderConstraints,
  ])

  function applyPersistedSnapshot(snapshot: PersistedAppStateV5) {
    timetableHistoryController.reset()
    timetableHistorySessionEventIdRef.current = null
    timetableHistoryReplayRef.current = false
    setTimetableHistoryFeedback(null)
    setGenerationOptionsScope(null)
    setResetConfirmation(null)
    setGenerationPreview(null)
    setGenerationFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setCloudEventSaveFeedback(null)
    setMembers(snapshot.members)
    setBands(snapshot.bands)
    setEvents(snapshot.events)
    setEventDays(snapshot.eventDays)
    setStages(snapshot.stages)
    setSections(snapshot.sections)
    setEventMembers(snapshot.eventMembers)
    setEventMemberDays(snapshot.eventMemberDays)
    setEventBands(snapshot.eventBands)
    setScheduleItems(snapshot.scheduleItems)
    setPaAssignments(snapshot.paAssignments)
    setDutyTypes(snapshot.dutyTypes)
    setDutyAssignments(snapshot.dutyAssignments)
    setTimetableLocks(snapshot.timetableLocks)
    setTimetableOrderConstraints(snapshot.timetableOrderConstraints)
    setActiveTimetableOrderBlockKey(null)
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    setSelectedEventId('')
    setSelectedTimetableEventDayId(undefined)
    setSelectedTimetableStageId(undefined)
    setActiveStep(6)
    setBreakDuration(10)
    setIsCreateEventDialogOpen(false)
    setActiveView('events')
  }

  const loadCloudEventScope = useEffectEvent(async (
    workspaceId: string,
    scopeKey: string,
    isCancelled: () => boolean,
  ) => {
    if (!cloudEventRepository) return
    await runCloudEventHydrationAttempt({
      scopeKey,
      isCurrent: () => !isCancelled() &&
        currentPersistenceScopeRef.current === scopeKey,
      load: () => loadCloudWorkspaceEvents(
        cloudEventRepository,
        workspaceId,
        domainState,
      ),
      apply: (loaded) => {
        // In Cloud mode the scoped localStorage snapshot is only a cache. Cloud
        // Event collections replace it after every successful hydration, so
        // edits not explicitly saved to Cloud are intentionally discarded here.
        applyPersistedSnapshot(loaded.state)
      },
      onStateChange: setCloudEventLoadState,
    })
  })

  useEffect(() => {
    if (!cloudWorkspace || !cloudEventRepository || !persistenceScopeReady) return
    let cancelled = false
    const scopeKey = requestedPersistenceStorageKey
    queueMicrotask(() => {
      void loadCloudEventScope(
        cloudWorkspace.workspace.id,
        scopeKey,
        () => cancelled,
      )
    })
    return () => {
      cancelled = true
    }
  }, [
    cloudEventReloadToken,
    cloudEventRepository,
    cloudWorkspace,
    persistenceScopeReady,
    requestedPersistenceStorageKey,
  ])

  const handleExportBackup = () => {
    let objectUrl: string | undefined
    let link: HTMLAnchorElement | undefined
    try {
      const json = createBackupJson(domainState)
      objectUrl = URL.createObjectURL(new Blob([json], {
        type: 'application/json;charset=utf-8',
      }))
      link = document.createElement('a')
      link.href = objectUrl
      link.download = createBackupFilename(new Date())
      document.body.appendChild(link)
      link.click()
      setBackupFeedback({ kind: 'success', message: 'バックアップを書き出しました。' })
    } catch {
      setBackupFeedback({ kind: 'error', message: 'バックアップを書き出せませんでした。' })
    } finally {
      link?.remove()
      if (objectUrl) {
        const completedUrl = objectUrl
        window.setTimeout(() => URL.revokeObjectURL(completedUrl), 0)
      }
    }
  }

  const handleImportBackup = async (file: File) => {
    if (!canEditWorkspace) {
      setBackupFeedback({ kind: 'error', message: READ_ONLY_WORKSPACE_MESSAGE })
      return
    }
    if (importingBackupRef.current) return
    importingBackupRef.current = true
    setIsImportingBackup(true)
    setBackupFeedback(null)
    try {
      const snapshot = parseBackupJson(await file.text())
      if (!snapshot) {
        setBackupFeedback({
          kind: 'error',
          message: 'バックアップファイルを読み込めませんでした。ファイルが破損しているか、対応していない形式です。',
        })
        return
      }
      if (!canEditWorkspaceRef.current) {
        setBackupFeedback({ kind: 'error', message: READ_ONLY_WORKSPACE_MESSAGE })
        return
      }
      if (!window.confirm('バックアップを復元すると、現在のデータはすべて置き換わり、未保存の編集も失われます。復元しますか？')) return
      if (!canEditWorkspaceRef.current) {
        setBackupFeedback({ kind: 'error', message: READ_ONLY_WORKSPACE_MESSAGE })
        return
      }
      if (!isPersistenceScopeReady(
        activePersistenceStorageKey,
        requestedPersistenceStorageKey,
      ) || !savePersistedState(snapshot, undefined, activePersistenceStorageKey)) {
        setBackupFeedback({ kind: 'error', message: 'バックアップを保存できませんでした。現在のデータは変更されていません。' })
        return
      }
      applyPersistedSnapshot(snapshot)
      setBackupFeedback({ kind: 'success', message: 'バックアップを復元しました。' })
    } catch {
      setBackupFeedback({ kind: 'error', message: 'バックアップファイルを読み込めませんでした。現在のデータは変更されていません。' })
    } finally {
      importingBackupRef.current = false
      setIsImportingBackup(false)
    }
  }

  const selectedScheduleItems = scheduleItems.filter((scheduleItem) =>
    selectedStageIds.has(scheduleItem.stageId),
  )
  const selectedEventTimetableLocks = timetableLocks.filter(
    (lock) => lock.eventId === selectedEventId,
  )

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
  const selectedEventDutyAssignments = selectedEvent
    ? getDutyAssignmentsForEvent({
        event: selectedEvent,
        stages: selectedStages,
        dutyTypes,
        dutyAssignments,
      })
    : []
  const selectedEventCalculatedItems = selectedEvent && activeStep !== 7
    ? selectedEventDays.flatMap((eventDay) => evaluateEventDayTimelinesSafely({
        eventDayId: eventDay.id,
        stages: selectedStages,
        sections: selectedSections,
        scheduleItems: selectedScheduleItems,
        eventBands: selectedEventBands,
      }).calculatedItems)
    : []
  const finalCheckReport = useMemo(() => {
    if (activeStep !== 7) return undefined
    const event = events.find(candidate => candidate.id === selectedEventId)
    return event
      ? createEventFinalCheckReport({
        event,
        eventDays,
        stages,
        sections,
        members,
        eventMembers,
        eventMemberDays,
        eventBands,
        scheduleItems,
        paAssignments,
        dutyTypes,
        dutyAssignments,
        timetableLocks,
        timetableOrderConstraints,
      }) : undefined
  }, [
    activeStep,
    selectedEventId,
    events,
    eventDays,
    stages,
    sections,
    members,
    eventMembers,
    eventMemberDays,
    eventBands,
    scheduleItems,
    paAssignments,
    dutyTypes,
    dutyAssignments,
    timetableLocks,
    timetableOrderConstraints,
  ])
  const startTime = currentStage?.plannedStartTime ?? ''
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
  const timetableOrderConstraintBlocks = (
    selectedEvent && timetableSelection.eventDayId && currentStage
      ? createTimetableOrderConstraintBlockPresentations({
          eventId: selectedEvent.id,
          eventDayId: timetableSelection.eventDayId,
          stageId: currentStage.id,
          timetableOrderConstraints,
          eventDays: selectedEventDays,
          stages: selectedStages,
          sections: selectedSections,
          eventBands: selectedEventBands,
        })
      : []
  )
  const visibleTimetableOrderBlockKey = activeTimetableOrderBlockKey &&
    timetableOrderConstraintBlocks.some(block => block.key === activeTimetableOrderBlockKey)
    ? activeTimetableOrderBlockKey
    : null

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
      !canEditWorkspace ||
      !currentStage ||
      !canSetStageStartTime(currentStage, currentStageSections, value)
    ) return

    setStages(prev => prev.map(stage => (
      stage.id === currentStage.id
        ? { ...stage, plannedStartTime: value }
        : stage
    )))
  }

  const handleOpenEvent = (eventId: EventId) => {
    if (!events.some((event) => event.id === eventId)) return

    setCloudEventSaveFeedback(null)
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
    setGenerationPreview(null)
    setGenerationOptionsScope(null)
    setResetConfirmation(null)
    setGenerationFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setStep6NavigationFeedback(null)
    setSelectedEventId(eventId)
    setSelectedTimetableEventDayId(undefined)
    setSelectedTimetableStageId(undefined)
    setActiveView('event-editor')
  }

  const handleSelectTimetableEventDay = (eventDayId: EventDayId) => {
    if (!selectedEventDays.some(eventDay => eventDay.id === eventDayId)) return

    setSelectedTimetableEventDayId(eventDayId)
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
    setGenerationPreview(null)
    setGenerationOptionsScope(null)
    setResetConfirmation(null)
    setGenerationFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setSelectedTimetableStageId(getStagesForEventDay(stages, eventDayId)[0]?.id)
  }

  const handleSelectTimetableStage = (stageId: StageId) => {
    if (!timetableStages.some(stage => stage.id === stageId)) return
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
    setSelectedTimetableStageId(stageId)
  }

  const persistEventToCloud = async (
    state: PersistedDomainState,
    eventId: EventId,
  ): Promise<boolean> => {
    if (!cloudWorkspace || !cloudEventRepository) return true
    if (!canEditWorkspace) return false
    const scopeKey = requestedPersistenceStorageKey
    if (
      currentPersistenceScopeRef.current !== scopeKey ||
      !latestDomainStateRef.current.events.some(event => event.id === eventId)
    ) return false
    setCloudEventSaveFeedback(null)
    let execution
    try {
      execution = await runExclusiveCloudEventSave({
        registry: cloudEventOperationRegistry,
        scopeKey,
        eventId,
        operation: () => saveCloudEventFromState(
          cloudEventRepository,
          cloudWorkspace.workspace.id,
          state,
          eventId,
        ),
        onChange: setCloudEventOperations,
      })
    } catch {
      if (currentPersistenceScopeRef.current === scopeKey) {
        setCloudEventSaveFeedback({
          eventId,
          kind: 'error',
          message: 'Cloud Eventの保存中に予期しないエラーが発生しました。',
        })
      }
      return false
    }
    if (!execution.started) {
      if (currentPersistenceScopeRef.current === scopeKey) {
        const operation = cloudEventOperationRegistry.get(scopeKey, eventId)
        setCloudEventSaveFeedback({
          eventId,
          kind: 'error',
          message: operation === 'delete'
            ? 'Cloud Eventの削除中は保存できません。削除完了後に状態を確認してください。'
            : 'Cloud Eventの保存処理がすでに進行中です。',
        })
      }
      return false
    }
    if (currentPersistenceScopeRef.current !== scopeKey) return false

    const result = execution.value
    if (!result.ok) {
      setCloudEventSaveFeedback({
        eventId,
        kind: 'error',
        message: result.error.message,
      })
      return false
    }
    setCloudEventSaveFeedback({
      eventId,
      kind: 'success',
      message: `Cloudへ保存しました（revision ${result.value.revision}）。`,
    })
    return true
  }

  const handleCreateEvent = (draft: NewEventDraft) => {
    if (!canEditWorkspace) return
    setCloudEventSaveFeedback(null)
    setGenerationPreview(null)
    setGenerationOptionsScope(null)
    setResetConfirmation(null)
    setGenerationFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    const eventId = createId('event')
    const eventDayIds = draft.dates.map(() => createId('event-day'))
    const created = createEventData({
      eventId,
      eventDayIds,
      draft,
      defaults: DEFAULT_EVENT_SETTINGS,
    })

    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
    setEvents((previous) => [...previous, created.event])
    setEventDays((previous) => [...previous, ...created.eventDays])
    setSelectedEventId(created.event.id)
    setSelectedTimetableEventDayId(created.eventDays[0]?.id)
    setSelectedTimetableStageId(undefined)
    setActiveStep(1)
    setActiveView('event-editor')
    setIsCreateEventDialogOpen(false)
  }

  const getEventDeletionInput = (eventId: EventId): EventDeletionInput => ({
    eventId,
    events,
    eventDays,
    stages,
    sections,
    eventMembers,
    eventMemberDays,
    eventBands,
    scheduleItems,
    paAssignments,
    dutyTypes,
    dutyAssignments,
    timetableLocks,
    timetableOrderConstraints,
  })

  const commitEventDeletion = (
    result: Extract<EventDeletionResult, { ok: true }>,
  ) => {
    const nextDomainState: PersistedDomainState = {
      events: result.events,
      eventDays: result.eventDays,
      stages: result.stages,
      sections: result.sections,
      eventMembers: result.eventMembers,
      eventMemberDays: result.eventMemberDays,
      eventBands: result.eventBands,
      scheduleItems: result.scheduleItems,
      paAssignments: result.paAssignments,
      dutyTypes: result.dutyTypes,
      dutyAssignments: result.dutyAssignments,
      timetableLocks: result.timetableLocks,
      timetableOrderConstraints: result.timetableOrderConstraints,
      members: latestDomainStateRef.current.members,
      bands: latestDomainStateRef.current.bands,
    }
    latestDomainStateRef.current = nextDomainState

    setEvents(result.events)
    setEventDays(result.eventDays)
    setStages(result.stages)
    setSections(result.sections)
    setEventMembers(result.eventMembers)
    setEventMemberDays(result.eventMemberDays)
    setEventBands(result.eventBands)
    setScheduleItems(result.scheduleItems)
    setPaAssignments(result.paAssignments)
    setDutyTypes(result.dutyTypes)
    setDutyAssignments(result.dutyAssignments)
    setTimetableLocks(result.timetableLocks)
    setTimetableOrderConstraints(result.timetableOrderConstraints)
  }

  const handleCheckEventDeletion = (
    eventId: EventId,
  ): EventDeletionCheck => checkEventDeletion(getEventDeletionInput(eventId))

  const handleDeleteEvent = async (
    eventId: EventId,
  ): Promise<EventDeletionActionResult> => {
    if (!canEditWorkspace) return { ok: false, reason: 'READ_ONLY' }
    const initialResult = createEventDeletion(getEventDeletionInput(eventId))
    if (!initialResult.ok) return initialResult
    const scopeKey = requestedPersistenceStorageKey

    let result = initialResult
    if (cloudWorkspace && cloudEventRepository) {
      try {
        const execution = await runExclusiveCloudEventDeletion({
          registry: cloudEventOperationRegistry,
          scopeKey,
          workspaceId: cloudWorkspace.workspace.id,
          eventId,
          repository: cloudEventRepository,
          isScopeCurrent: () => currentPersistenceScopeRef.current === scopeKey,
          getLatestState: () => latestDomainStateRef.current,
          commit: commitEventDeletion,
          onChange: setCloudEventOperations,
        })
        if (!execution.started) {
          return { ok: false, reason: 'CLOUD_OPERATION_IN_PROGRESS' }
        }
        if (!execution.value.ok) return execution.value
        result = execution.value
      } catch {
        return { ok: false, reason: 'CLOUD_DELETE_FAILED' }
      }
    } else {
      commitEventDeletion(result)
    }

    setSelectedEventId('')
    setSelectedTimetableEventDayId(undefined)
    setSelectedTimetableStageId(undefined)
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
    setGenerationPreview(null)
    setGenerationOptionsScope(null)
    setResetConfirmation(null)
    setGenerationFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setCloudEventSaveFeedback(null)
    setOperationsPanelRevision((revision) => revision + 1)
    setBreakDuration(10)
    setIsCreateEventDialogOpen(false)
    setActiveStep(1)
    setActiveView('events')

    return result
  }

  const handleSaveEventBasicInfo = (
    draft: EventBasicInfoDraft,
  ): EventBasicInfoUpdateResult => {
    if (!canEditWorkspace) {
      return { ok: false, errors: { form: READ_ONLY_WORKSPACE_MESSAGE } }
    }
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
      timetableOrderConstraints,
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
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)

    return result
  }

  const handleSaveEventMemberSettings = (
    draft: EventMemberSettingsDraft,
  ): EventMemberSettingsUpdateResult => {
    if (!canEditWorkspace) {
      return {
        ok: false,
        errors: { members: {}, days: {}, form: READ_ONLY_WORKSPACE_MESSAGE },
      }
    }
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
    if (!canEditWorkspace) {
      return {
        ok: false,
        errors: { items: {}, form: READ_ONLY_WORKSPACE_MESSAGE },
      }
    }
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
      timetableOrderConstraints,
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
    if (!canEditWorkspace) {
      return {
        ok: false,
        errors: { items: {}, form: READ_ONLY_WORKSPACE_MESSAGE },
      }
    }
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
      timetableOrderConstraints,
      draft,
    })
    if (!result.ok) return result

    setEventBands(result.eventBands)
    return result
  }

  const handleCreatePaAssignmentsUpdate = (
    draft: PaAssignmentsDraft,
  ): PaAssignmentsUpdateResult => {
    if (!canEditWorkspace) {
      return {
        ok: false,
        errors: { items: {}, form: READ_ONLY_WORKSPACE_MESSAGE },
      }
    }
    if (!selectedEvent) {
      return {
        ok: false,
        errors: { items: {}, form: '編集するイベントが見つかりません。' },
      }
    }
    return createPaAssignmentsUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      stages: selectedStages,
      sections: selectedSections,
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
  }

  const handleCreateDutySettingsUpdate = (
    draft: DutySettingsDraft,
    paAssignmentsOverride: PaAssignment[] = selectedEventPaAssignments,
  ): DutySettingsUpdateResult => {
    if (!canEditWorkspace) {
      return {
        ok: false,
        errors: {
          dutyTypes: {},
          assignments: {},
          form: READ_ONLY_WORKSPACE_MESSAGE,
        },
      }
    }
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
    return createDutySettingsUpdate({
      event: selectedEvent,
      eventDays: selectedEventDays,
      stages: selectedStages,
      sections: selectedSections,
      members,
      eventMembers: selectedEventMembers,
      eventMemberDays: selectedEventMemberDays,
      eventBands: selectedEventBands,
      paAssignments: paAssignmentsOverride,
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
  }

  const handleSaveStep6AndNext = () => {
    if (!canEditWorkspace) return
    setStep6NavigationFeedback(null)
    const paResult = paSettingsRef.current?.prepareDraft()
    if (!paResult?.ok) return

    const dutyResult = dutySettingsRef.current?.prepareDraft(
      paResult.paAssignments,
    )
    if (!dutyResult?.ok) return

    paSettingsRef.current?.commitPrepared(paResult)
    dutySettingsRef.current?.commitPrepared(dutyResult)
    setActiveStep(7)
  }

  const hasUnsavedOperations = () => hasUnsavedOperationsChanges(paSettingsRef.current, dutySettingsRef.current)

  const handleSaveSelectedEventToCloud = () => {
    if (!canEditWorkspace) return
    if (!selectedEvent || !cloudWorkspace) return
    if (eventBasicInfoRef.current?.hasUnsavedChanges()) {
      setCloudEventSaveFeedback({
        eventId: selectedEvent.id,
        kind: 'error',
        message: 'イベント基本情報に未保存の変更があります。先に基本情報を保存してから「Cloudへ保存」を実行してください。',
      })
      return
    }
    if (hasUnsavedOperations()) {
      setCloudEventSaveFeedback({
        eventId: selectedEvent.id,
        kind: 'error',
        message: 'PAまたは当日運営の未保存編集を先に保存してください。',
      })
      return
    }
    void persistEventToCloud(domainState, selectedEvent.id)
  }

  const blockUnsavedOperationsNavigation = (
    target: EventEditorStepId | 'events' | 'sign-out' | 'workspace-switch',
  ): boolean => {
    const message = getUnsavedOperationsNavigationMessage({
      activeStep,
      target,
      hasUnsavedChanges: hasUnsavedOperations(),
    })
    if (!message) {
      setStep6NavigationFeedback(null)
      return false
    }
    setStep6NavigationFeedback({ eventId: selectedEventId, message })
    return true
  }

  const blockUnsavedEditorNavigation = (
    target: EventEditorStepId | 'events' | 'sign-out' | 'workspace-switch',
  ): boolean => {
    if (eventBasicInfoRef.current?.hasUnsavedChanges()) {
      eventBasicInfoRef.current.reportUnsavedChanges()
      return true
    }
    return blockUnsavedOperationsNavigation(target)
  }

  const handleEventEditorStepChange = (step: EventEditorStepId) => {
    if (blockUnsavedEditorNavigation(step)) return
    if (step !== 6) setTimetableHistoryFeedback(null)
    setActiveStep(step)
  }

  const handleLeaveEventEditor = () => {
    if (blockUnsavedEditorNavigation('events')) return
    setActiveView('events')
  }

  const handleAppNavigation = (section: AppSection) => {
    if (activeView === 'event-editor' && blockUnsavedEditorNavigation('events')) return
    setActiveView(section)
  }

  const handleBeforeSignOut = (): boolean =>
    activeView !== 'event-editor' || !blockUnsavedEditorNavigation('sign-out')

  const handleBeforeWorkspaceChange = (): boolean =>
    activeView !== 'event-editor' || !blockUnsavedEditorNavigation('workspace-switch')

  const clearTimetableHistoryEphemeralState = () => {
    setGenerationOptionsScope(null)
    setResetConfirmation(null)
    setGenerationPreview(null)
    setGenerationFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion(null)
    setGridAssignmentFeedback(null)
    setTimetableGridSelectionState((previous) => ({
      ...previous,
      selection: null,
    }))
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
  }

  const applyTimetableEditSnapshot = (
    snapshot: TimetableEditSnapshot,
    context: TimetableHistoryEntry['context'],
  ) => {
    if (!canEditWorkspace) return
    const restored = cloneTimetableEditSnapshot(snapshot)
    setStages(restored.stages)
    setEventBands(restored.eventBands)
    setScheduleItems(restored.scheduleItems)
    setPaAssignments(restored.paAssignments)
    setDutyTypes(restored.dutyTypes)
    setDutyAssignments(restored.dutyAssignments)
    setTimetableLocks(restored.timetableLocks)
    setTimetableOrderConstraints(restored.timetableOrderConstraints)
    const restoredSelection = resolveTimetableSelection({
      eventId: selectedEventId,
      eventDays,
      stages: restored.stages,
      selectedEventDayId: context.eventDayId,
      selectedStageId: context.stageId,
    })
    setSelectedTimetableEventDayId(restoredSelection.eventDayId)
    setSelectedTimetableStageId(restoredSelection.stageId)
    clearTimetableHistoryEphemeralState()
    setOperationsPanelRevision((revision) => revision + 1)
  }

  const performTimetableHistoryTransition = (
    direction: 'undo' | 'redo',
  ): boolean => {
    if (!timetableHistoryActive || !timetableHistory) return false
    const available = direction === 'undo'
      ? timetableHistory.past.length > 0
      : timetableHistory.future.length > 0
    if (!available) return false
    if (hasUnsavedOperations()) {
      setTimetableHistoryFeedback({
        eventId: selectedEventId,
        entry: timetableHistory.present,
        kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。先に保存してください。',
      })
      return false
    }
    timetableHistoryReplayRef.current = true
    const transition = direction === 'undo'
      ? timetableHistoryController.undo()
      : timetableHistoryController.redo()
    if (!transition?.changed) {
      timetableHistoryReplayRef.current = false
      return false
    }
    applyTimetableEditSnapshot(transition.entry.snapshot, transition.entry.context)
    setTimetableHistoryFeedback({
      eventId: selectedEventId,
      entry: transition.state.present,
      kind: 'success',
      message: direction === 'undo'
        ? '1つ前の操作に戻しました。'
        : '操作をやり直しました。',
    })
    return true
  }

  const canUndoTimetable = timetableHistoryActive &&
    (timetableHistory?.past.length ?? 0) > 0
  const canRedoTimetable = timetableHistoryActive &&
    (timetableHistory?.future.length ?? 0) > 0
  const visibleTimetableHistoryFeedback =
    timetableHistoryFeedback?.eventId === selectedEventId &&
    timetableHistoryFeedback.entry === timetableHistory?.present
      ? timetableHistoryFeedback
      : null
  const performTimetableHistoryTransitionEvent = useEffectEvent(
    performTimetableHistoryTransition,
  )

  useEffect(() => {
    if (!timetableHistoryActive) return
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey)) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [aria-modal="true"]',
      )) return
      const key = event.key.toLowerCase()
      const direction = key === 'z'
        ? event.shiftKey ? 'redo' : 'undo'
        : key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey
          ? 'redo'
          : undefined
      if (!direction) return
      const available = direction === 'undo' ? canUndoTimetable : canRedoTimetable
      if (!available) return
      if (performTimetableHistoryTransitionEvent(direction)) event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [timetableHistoryActive, canUndoTimetable, canRedoTimetable])

  const timetableResetInput = selectedEvent && timetableEventDay
    ? { event: selectedEvent, eventDay: timetableEventDay, eventDays, stages, eventBands,
      scheduleItems, paAssignments, dutyTypes, dutyAssignments, timetableLocks } : undefined
  const timetableResetResult = timetableResetInput ? resetEventDayTimetable(timetableResetInput) : undefined

  const handleOpenGenerationOptions = () => {
    if (!canEditWorkspace) return
    if (!selectedEvent || !timetableEventDay || !timetableStages.length || !currentDayEventBands.length) return
    if (hasUnsavedOperations()) {
      setGenerationFeedback({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。先に保存してから自動生成してください。' })
      return
    }
    setGenerationFeedback(null)
    setGenerationOptionsScope({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id })
  }

  const handleGenerateTimetable = () => {
    if (!canEditWorkspace) return
    if (!selectedEvent || !timetableEventDay || !timetableStages.length || !currentDayEventBands.length) return
    const feedback = (
      message: string,
      guidance?: TimetableGenerationFailurePresentation,
    ) => setGenerationFeedback({
      eventId: selectedEvent.id, eventDayId: timetableEventDay.id,
      kind: 'error', message, guidance,
    })
    if (generationOptionsScope?.eventId !== selectedEvent.id || generationOptionsScope.eventDayId !== timetableEventDay.id) {
      setGenerationOptionsScope(null)
      feedback('編集対象が変わりました。自動生成設定を開き直してください。')
      return
    }
    setGenerationOptionsScope(null)
    if (hasUnsavedOperations()) {
      feedback('PAまたは当日運営に未保存の変更があります。先に保存してから自動生成してください。')
      return
    }
    setGenerationFeedback(null)
    if (!hasValidTimetableGenerationPreprocessingInput({ event: selectedEvent,
      eventDay: timetableEventDay, eventDays, stages, sections, scheduleItems, options: generationOptions,
      paAssignments, dutyTypes, dutyAssignments, timetableLocks })) {
      feedback('自動生成に必要なデータの形式または参照を確認できません。Step 2〜6の設定と、既存の休憩・TT固定・PA／当日運営の担当範囲を確認してください。')
      return
    }
    const generationScheduleItems = createScheduleItemsForTimetableGeneration({ event: selectedEvent,
      eventDay: timetableEventDay, eventDays, stages, sections, scheduleItems, options: generationOptions })
    const breakRemoval = validateTimetableGenerationBreakRemoval({
      event: selectedEvent, eventDay: timetableEventDay,
      originalScheduleItems: scheduleItems, generationScheduleItems,
      paAssignments, dutyAssignments, timetableLocks,
    })
    if (!breakRemoval.ok) {
      feedback(breakRemoval.code === 'INVALID_REFERENCE_SHAPE'
        ? '自動生成に必要なデータの形式または参照を確認できません。Step 2〜6の設定と、既存の休憩・TT固定・PA／当日運営の担当範囲を確認してください。'
        : '選択した休憩を除外すると、当日運営・TT固定、または保持されるPA担当の参照が壊れるため自動生成できません。自動生成設定でその休憩を残すか、先に担当範囲・TT固定を変更してください。')
      return
    }
    const input = { event: selectedEvent, eventDay: timetableEventDay, eventDays, stages, sections,
      members, eventMembers, eventMemberDays, eventBands, scheduleItems: generationScheduleItems,
      timetableLocks, timetableOrderConstraints, dutyTypes, dutyAssignments }
    const result = generateTimetablePlan(input)
    if (!result.ok) {
      const guidance = presentTimetableGenerationFailure(
        result.failure,
        { stages, sections, eventBands },
      )
      feedback(guidance.summary, guidance)
      return
    }
    const candidate = materializeTimetableGenerationPlan({ ...input, sourceScheduleItems: scheduleItems,
      paAssignments, plan: result.plan,
      newScheduleItemIds: result.plan.placements.filter(p => p.scheduleItemId === undefined)
        .map(() => createId('schedule-performance')),
      newPaAssignmentIds: result.plan.paShifts.map(() => createId('pa-assignment')),
    })
    if (!candidate.ok) {
      feedback(`生成結果を安全にプレビューへ変換できませんでした。設定を変更せず再度生成しても解消しない場合は、Step 2〜6のデータの参照関係を確認してください。（詳細: ${candidate.code}）`)
      return
    }
    const validation = validateTimetableGenerationCandidate({ ...input, paAssignments, plan: result.plan }, candidate)
    if (!validation.ok) { feedback(validation.reason); return }
    setGenerationPreview({
      eventId: selectedEvent.id, eventDayId: timetableEventDay.id, sourceState: domainState, candidate,
      options: { ...generationOptions },
      presentation: createTimetableGenerationPreview({ ...input, ...candidate, ...validation,
        plan: result.plan }),
    })
  }

  const handleApplyGeneratedTimetable = () => {
    if (!canEditWorkspace) return
    if (!generationPreview) return
    if (generationPreview.eventId !== selectedEvent?.id ||
      generationPreview.eventDayId !== timetableEventDay?.id ||
      generationPreview.sourceState !== domainState || hasUnsavedOperations()) {
      setGenerationPreview(null)
      if (selectedEvent && timetableEventDay) setGenerationFeedback({
        eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'error',
        message: '設定または編集対象が変わったため適用できません。未保存の編集を保存し、再生成してください。',
      })
      return
    }
    // Commit precisely the validated preview, in one batched React event.
    // Autosave observes the resulting complete domain snapshot, never a half apply.
    setScheduleItems(generationPreview.candidate.scheduleItems)
    setPaAssignments(generationPreview.candidate.paAssignments)
    setTimetableOrderConstraintFeedback(null)
    setOperationsPanelRevision(revision => revision + 1)
    setGenerationFeedback({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'success',
      message: `✓ ${formatGenerationDay(timetableEventDay)}のタイムテーブルとPA担当を自動生成結果へ更新しました。`,
    })
    setGenerationPreview(null)
  }

  const handleOpenTimetableReset = () => {
    if (!canEditWorkspace) return
    if (!selectedEvent || !timetableEventDay || !timetableResetResult?.ok || !timetableResetResult.hasChanges) return
    if (hasUnsavedOperations()) {
      setGenerationFeedback({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。先に保存してからTTを初期化してください。' })
      return
    }
    setGenerationFeedback(null)
    setResetConfirmation({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, sourceState: domainState })
  }

  const handleResetTimetable = () => {
    if (!canEditWorkspace) return
    if (!resetConfirmation || !selectedEvent || !timetableEventDay) return
    setResetConfirmation(null)
    if (resetConfirmation.eventId !== selectedEvent.id || resetConfirmation.eventDayId !== timetableEventDay.id ||
      resetConfirmation.sourceState !== domainState || hasUnsavedOperations()) {
      setGenerationFeedback({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'error',
        message: '設定または編集対象が変わりました。未保存の編集を保存し、初期化を確認し直してください。' })
      return
    }
    if (!timetableResetInput) return
    const result = resetEventDayTimetable(timetableResetInput)
    if (!result.ok) {
      setGenerationFeedback({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'error',
        message: '参照関係またはデータの所属を安全に判定できないため、TTを初期化できません。' })
      return
    }
    // All four collections commit together; existing autosave and draft remount observe this snapshot.
    setScheduleItems(result.scheduleItems)
    setPaAssignments(result.paAssignments)
    setDutyAssignments(result.dutyAssignments)
    setTimetableLocks(result.timetableLocks)
    setOperationsPanelRevision(revision => revision + 1)
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    setGenerationPreview(null)
    setGenerationFeedback({ eventId: selectedEvent.id, eventDayId: timetableEventDay.id, kind: 'success',
      message: `✓ ${formatGenerationDay(timetableEventDay)}のタイムテーブルを初期化しました。出演バンドは未配置に戻り、PA・当日運営担当・TT固定を削除しました。` })
  }

  const handleSaveCommonMember = (
    memberId: MemberId | undefined,
    draft: CommonMemberDraft,
  ): CommonMemberUpdateResult => {
    if (!canEditWorkspace) {
      return { ok: false, errors: { form: READ_ONLY_WORKSPACE_MESSAGE } }
    }
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
    if (!canEditWorkspace) {
      return { ok: false, errors: { form: READ_ONLY_WORKSPACE_MESSAGE } }
    }
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

  const getCommonMemberDeletionCheck = (
    memberId: MemberId,
  ): CommonMemberDeletionCheck => checkCommonMemberDeletion({
    memberId,
    members,
    bands,
    eventMembers,
    eventBands,
    paAssignments,
    dutyAssignments,
  })

  const handleDeleteCommonMember = (
    memberId: MemberId,
  ): CommonMemberDeletionResult => {
    if (!canEditWorkspace) return { ok: false, reason: 'MEMBER_NOT_FOUND' }
    const result = createCommonMemberDeletion({
      memberId,
      members,
      bands,
      eventMembers,
      eventBands,
      paAssignments,
      dutyAssignments,
    })
    if (result.ok) setMembers(result.members)
    return result
  }

  const getCommonBandDeletionCheck = (
    bandId: BandId,
  ): CommonBandDeletionCheck => checkCommonBandDeletion({
    bandId,
    bands,
    eventBands,
  })

  const handleDeleteCommonBand = (
    bandId: BandId,
  ): CommonBandDeletionResult => {
    if (!canEditWorkspace) return { ok: false, reason: 'BAND_NOT_FOUND' }
    const result = createCommonBandDeletion({ bandId, bands, eventBands })
    if (result.ok) setBands(result.bands)
    return result
  }

  const handleSaveEventStageSettings = (
    performanceSlotMinutes: number[],
    stageDrafts: StageSettingsDraft[],
    sectionDrafts: SectionSettingsDraft[],
  ): EventStageSettingsUpdateResult => {
    if (!canEditWorkspace) {
      return {
        ok: false,
        errors: {
          stages: {},
          sections: {},
          form: READ_ONLY_WORKSPACE_MESSAGE,
        },
      }
    }
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
      timetableLocks,
      timetableOrderConstraints,
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
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)

    return result
  }

  // ==================== 🎴 プール・タイムテーブル操作ロジック ====================

  const evaluateSelectedEventLocks = (
    candidateScheduleItems: ScheduleItem[],
    candidateLocks: TimetableLock[] = timetableLocks,
  ) => evaluateTimetableLocks({
    eventId: selectedEventId,
    timetableLocks: candidateLocks,
    scheduleItems: candidateScheduleItems,
    eventBands,
    eventDays,
    stages,
    sections,
  })

  const evaluateSelectedOrderConstraintTransition = (
    candidateScheduleItems: ScheduleItem[],
  ) => timetableSelection.eventDayId
    ? evaluateTimetableOrderConstraintManualTransition({
        eventId: selectedEventId,
        eventDayId: timetableSelection.eventDayId,
        timetableOrderConstraints,
        currentScheduleItems: scheduleItems,
        candidateScheduleItems,
        eventDays,
        stages,
        sections,
        eventBands,
      })
    : undefined

  const allowSelectedOrderConstraintTransition = (
    candidateScheduleItems: ScheduleItem[],
  ): boolean => {
    const evaluation = evaluateSelectedOrderConstraintTransition(candidateScheduleItems)
    if (!evaluation || evaluation.allowed) return true
    if (!timetableSelection.eventDayId || !currentStage) return false
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback({
      eventId: selectedEventId,
      eventDayId: timetableSelection.eventDayId,
      stageId: currentStage.id,
      message: evaluation.introducedIssues[0]?.message ??
        '出演順制約によりこの操作はできません。',
    })
    return false
  }

  const commitScheduleItemsIfScheduleGuardsAllow = (
    candidateScheduleItems: ScheduleItem[],
  ): boolean => {
    if (!canEditWorkspace) return false
    const evaluation = evaluateSelectedEventLocks(candidateScheduleItems)
    if (!evaluation.valid) {
      setTimetableOrderConstraintFeedback(null)
      setTimetableLockFeedback(
        {
          eventId: selectedEventId,
          message: evaluation.violations[0]?.message ?? 'TT固定により操作できません。',
        },
      )
      return false
    }
    if (!allowSelectedOrderConstraintTransition(candidateScheduleItems)) return false
    setScheduleItems(candidateScheduleItems)
    setTimetableLockFeedback(clearTimetableLockFeedback())
    setTimetableOrderConstraintFeedback(null)
    return true
  }

  const handleAddBreak = (sectionId?: SectionId) => {
    if (
      !currentStage ||
      currentStageHasInvalidSectionAssignments ||
      !isValidBreakDurationMinutes(breakDuration)
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

    const candidate = insertScheduleItemInLane(
      scheduleItems,
      lane,
      newBreakItem,
      getScheduleLaneItems(scheduleItems, lane).length,
    )
    if (commitScheduleItemsIfScheduleGuardsAllow(candidate)) setBreakDuration(10)
  }

  const handleAddInterSectionBreak = (afterSectionId: SectionId) => {
    if (
      !currentStage ||
      currentStageHasInvalidSectionAssignments ||
      !isValidBreakDurationMinutes(breakDuration)
    ) return

    const lane: ScheduleLane = {
      stageId: currentStage.id,
      afterSectionId,
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

    const candidate = insertScheduleItemInLane(
      scheduleItems,
      lane,
      newBreakItem,
      getScheduleLaneItems(scheduleItems, lane).length,
    )
    if (commitScheduleItemsIfScheduleGuardsAllow(candidate)) setBreakDuration(10)
  }

  // 演奏項目を削除すると、参照先のEventBandが算出プールへ戻る。休憩はそのまま削除する
  const handleRemoveScheduleItem = (id: string) => {
    commitScheduleItemsIfScheduleGuardsAllow(removeScheduleItem(scheduleItems, id))
  }

  const handleSetTimetableLock = (
    scheduleItemId: string,
    mode: TimetableLockMode,
  ) => {
    if (!canEditWorkspace) return
    const result = applyTimetableLock({
      lockId: createId('timetable-lock'),
      eventId: selectedEventId,
      scheduleItemId,
      mode,
      timetableLocks,
      scheduleItems,
      eventBands,
      eventDays,
      stages,
      sections,
    })
    if (!result.ok) {
      setTimetableOrderConstraintFeedback(null)
      setTimetableLockFeedback(
        {
          eventId: selectedEventId,
          message: result.violations[0]?.message ?? 'TT固定を設定できません。',
        },
      )
      return
    }
    if (!allowSelectedOrderConstraintTransition(result.scheduleItems)) return
    setScheduleItems(result.scheduleItems)
    setTimetableLocks(result.timetableLocks)
    setTimetableOrderConstraintFeedback(null)
    setTimetableLockFeedback({
      eventId: selectedEventId,
      message: 'TT固定を更新しました。',
    })
  }

  const handleUnlockTimetableLock = (lockId: TimetableLockId) => {
    if (!canEditWorkspace) return
    setTimetableLocks((previous) => removeTimetableLock(previous, lockId))
    setTimetableLockFeedback({
      eventId: selectedEventId,
      message: 'TT固定を解除しました。',
    })
  }

  const handleUnlockAllTimetableLocks = () => {
    if (!canEditWorkspace) return
    setTimetableLocks((previous) =>
      removeTimetableLocksForEvent(previous, selectedEventId))
    setTimetableLockFeedback({
      eventId: selectedEventId,
      message: 'このイベントのTT固定をすべて解除しました。',
    })
  }

  const handleCommitTimetableOrderConstraints = (
    nextConstraints: TimetableOrderConstraint[],
  ) => {
    if (!canEditWorkspace) return
    setTimetableOrderConstraints(nextConstraints)
    setTimetableOrderConstraintFeedback(null)
    setActiveTimetableOrderBlockKey(null)
  }

  // ==================== 🔀 安全なドラッグ＆ドロップ処理 ====================
  const handleOnDragEnd = (result: DropResult) => {
    if (
      !canEditWorkspace ||
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
    const validInterSectionAnchorIds = new Set(
      currentStageSections.slice(0, -1).map(section => section.id),
    )
    const sourceLane = sourceTarget.kind === 'pool'
      ? undefined
      : resolveScheduleLane(
          sourceTarget,
          currentStage.id,
          currentStageSectionIds,
          validInterSectionAnchorIds,
        )
    const destinationLane = destinationTarget.kind === 'pool'
      ? undefined
      : resolveScheduleLane(
          destinationTarget,
          currentStage.id,
          currentStageSectionIds,
          validInterSectionAnchorIds,
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
        commitScheduleItemsIfScheduleGuardsAllow(reorderScheduleLaneItems(
          scheduleItems, sourceLane, sourceIndex, destinationIndex,
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

      commitScheduleItemsIfScheduleGuardsAllow(insertScheduleItemInLane(
        scheduleItems,
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
      if (!commitScheduleItemsIfScheduleGuardsAllow(remainingScheduleItems)) return
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

      commitScheduleItemsIfScheduleGuardsAllow(moveScheduleItemWithinStage({
        scheduleItems,
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
  const eventDayTimelines = selectedEvent && timetableSelection.eventDayId && activeStep !== 7
    ? evaluateEventDayTimelinesSafely({
        eventDayId: timetableSelection.eventDayId,
        stages: timetableStages,
        sections: timetableSections,
        scheduleItems: currentEventDayScheduleItems,
        eventBands: selectedEventBands,
      })
    : { calculatedItems: [], invalidStages: [], failedStages: [] }
  const calculatedItems = eventDayTimelines.calculatedItems
  const invalidTimelineStageIds = new Set(
    eventDayTimelines.invalidStages.map(stage => stage.stageId),
  )
  const failedTimelineStageIds = new Set(
    eventDayTimelines.failedStages.map(stage => stage.stageId),
  )
  const evaluableTimetableStages = timetableStages.filter(stage =>
    !invalidTimelineStageIds.has(stage.id) && !failedTimelineStageIds.has(stage.id),
  )
  const evaluableTimetableStageIds = new Set(
    evaluableTimetableStages.map(stage => stage.id),
  )
  const evaluableTimetableSections = timetableSections.filter(section =>
    evaluableTimetableStageIds.has(section.stageId),
  )
  const selectedStageById = new Map(selectedStages.map(stage => [stage.id, stage]))
  const shouldEvaluateOperationsAssignment = (assignment: {
    eventDayId: EventDayId
    stageId: StageId
  }): boolean => {
    if (assignment.eventDayId !== timetableSelection.eventDayId) return false
    const stage = selectedStageById.get(assignment.stageId)
    if (!stage || stage.eventDayId !== assignment.eventDayId) return true
    return evaluableTimetableStageIds.has(stage.id)
  }
  const currentStageTimelineFailed = currentStage
    ? failedTimelineStageIds.has(currentStage.id)
    : false
  const currentStageCalculatedItems = currentStage
    ? calculatedItems.filter(item => item.stageId === currentStage.id)
    : []
  const scheduleIssues = selectedEvent && activeStep !== 7
    ? detectScheduleIssues({
        event: selectedEvent,
        members,
        eventMembers: selectedEventMembers,
        eventMemberDays: selectedEventMemberDays,
        eventBands: selectedEventBands,
        stages: evaluableTimetableStages,
        sections: evaluableTimetableSections,
        paAssignments: selectedEventPaAssignments.filter(
          shouldEvaluateOperationsAssignment,
        ),
        dutyTypes: selectedEventDutyTypes,
        dutyAssignments: selectedEventDutyAssignments.filter(
          shouldEvaluateOperationsAssignment,
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
  const timetableWorkspaceRows = currentStage && timetableSelection.eventDayId &&
    activeStep !== 7 && !currentStageTimelineFailed &&
    !currentStageHasInvalidSectionAssignments
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
        stages: selectedStages,
        sections: selectedSections,
      })
    : {
        rows: [],
        unresolvedPaAssignments: [],
        offGridPaAssignments: [],
        unresolvedDutyAssignments: [],
        offGridDutyAssignments: [],
      }

  const getGridAssignmentContext = () => selectedEvent ? {
    event: selectedEvent,
    eventDays: selectedEventDays,
    stages: selectedStages,
    sections: selectedSections,
    members,
    eventMembers: selectedEventMembers,
    eventMemberDays: selectedEventMemberDays,
    eventBands: selectedEventBands,
    calculatedItems: selectedEventCalculatedItems,
    paAssignments,
    dutyTypes,
    dutyAssignments,
  } : undefined

  const getDutyAutoAssignmentContext = (
    context: NonNullable<ReturnType<typeof getGridAssignmentContext>>,
    selection: ResolvedTimetableGridRangeSelection,
  ) => {
    const matchingDays = context.eventDays.filter((eventDay) =>
      eventDay.id === selection.eventDayId,
    )
    const matchingStages = context.stages.filter((stage) =>
      stage.id === selection.stageId,
    )
    if (matchingDays.length !== 1 || matchingStages.length !== 1) return undefined
    return {
      ...context,
      eventDay: matchingDays[0],
      stage: matchingStages[0],
    }
  }

  const selectionsMatch = (
    current: ResolvedTimetableGridRangeSelection,
    expected: ResolvedTimetableGridRangeSelection,
  ) => current.eventDayId === expected.eventDayId &&
    current.stageId === expected.stageId &&
    current.fromMinute === expected.fromMinute &&
    current.untilMinute === expected.untilMinute &&
    areTimetableGridAssignmentTargetsEqual(current.target, expected.target) &&
    current.scheduleItemIds.length === expected.scheduleItemIds.length &&
    current.scheduleItemIds.every((id, index) => id === expected.scheduleItemIds[index])

  const planDutyAutoAssignment = (
    context: NonNullable<ReturnType<typeof getGridAssignmentContext>>,
    selection: ResolvedTimetableGridRangeSelection,
    additionalCount: number,
  ): DutyAutoAssignmentPlanResult => {
    if (selection.target.kind !== 'duty') {
      return {
        ok: false,
        code: 'INVALID_SCOPE',
        message: '当日運営の仕事を選択してください。',
      }
    }
    const autoContext = getDutyAutoAssignmentContext(context, selection)
    if (!autoContext) {
      return {
        ok: false,
        code: 'INVALID_SCOPE',
        message: '選択した開催日またはStageを確認できません。',
      }
    }
    return planDutyAutoAssignments(autoContext, {
      dutyTypeId: selection.target.dutyTypeId,
      fromBoundary: selection.fromBoundary,
      untilBoundary: selection.untilBoundary,
      fromMinute: selection.fromMinute,
      untilMinute: selection.untilMinute,
      additionalCount,
    })
  }

  const getCurrentResolvedGridSelection = () => timetableGridSelection
    ? resolveTimetableGridSelection(
        timetableGridSelection,
        timetableWorkspaceRows.rows,
      )
    : undefined

  const rejectStaleGridSelection = () => {
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    handleTimetableGridSelectionChange(null)
    if (selectedEvent && timetableSelection.eventDayId && currentStage) {
      setGridAssignmentFeedback({
        eventId: selectedEvent.id,
        eventDayId: timetableSelection.eventDayId,
        stageId: currentStage.id,
        kind: 'error',
        message: '選択範囲または編集対象が変わりました。範囲を選択し直してください。',
      })
    }
  }

  const handleOpenGridAssignment = () => {
    if (!canEditWorkspace) return
    const selection = getCurrentResolvedGridSelection()
    const context = getGridAssignmentContext()
    if (
      !selection || !context || !currentStage || !timetableSelection.eventDayId ||
      selection.eventDayId !== timetableSelection.eventDayId ||
      selection.stageId !== currentStage.id
    ) {
      rejectStaleGridSelection()
      return
    }
    if (hasUnsavedOperations()) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: selection.eventDayId,
        stageId: selection.stageId,
        kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。右側の設定を保存してから担当を割り当ててください。',
      })
      return
    }

    const candidates = getTimetableGridAssignmentCandidates(context, selection)
    if (!candidates.ok) {
      handleTimetableGridSelectionChange(null)
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: selection.eventDayId,
        stageId: selection.stageId,
        kind: 'error',
        message: candidates.errors.join(' '),
      })
      return
    }

    setGridAssignmentFeedback(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDialog({
      eventId: context.event.id,
      selection,
      targetLabel: candidates.targetLabel,
      candidates: candidates.candidates,
      errors: [],
    })
  }

  const handleSubmitGridAssignment = (memberId: string) => {
    if (!canEditWorkspace) return
    if (!gridAssignmentDialog) return
    const currentSelection = getCurrentResolvedGridSelection()
    const context = getGridAssignmentContext()
    const originalSelection = gridAssignmentDialog.selection
    const selectionIsCurrent = currentSelection !== undefined &&
      gridAssignmentDialog.eventId === selectedEvent?.id &&
      currentSelection.eventDayId === originalSelection.eventDayId &&
      currentSelection.stageId === originalSelection.stageId &&
      currentSelection.fromMinute === originalSelection.fromMinute &&
      currentSelection.untilMinute === originalSelection.untilMinute &&
      areTimetableGridAssignmentTargetsEqual(
        currentSelection.target,
        originalSelection.target,
      ) &&
      currentSelection.scheduleItemIds.length === originalSelection.scheduleItemIds.length &&
      currentSelection.scheduleItemIds.every((id, index) =>
        id === originalSelection.scheduleItemIds[index],
      )
    if (!context || !currentSelection || !selectionIsCurrent) {
      rejectStaleGridSelection()
      return
    }
    if (hasUnsavedOperations()) {
      setGridAssignmentDialog((current) => current ? {
        ...current,
        errors: ['PAまたは当日運営に未保存の変更があります。右側の設定を保存してから担当を割り当ててください。'],
      } : current)
      return
    }

    const result = createTimetableGridAssignment({
      context,
      selection: currentSelection,
      memberId,
      newAssignmentId: createId(
        currentSelection.target.kind === 'pa'
          ? 'pa-assignment'
          : 'duty-assignment',
      ),
    })
    if (!result.ok) {
      setGridAssignmentDialog((current) => current ? {
        ...current,
        errors: result.errors,
      } : current)
      return
    }

    if (result.kind === 'pa') setPaAssignments(result.paAssignments)
    else setDutyAssignments(result.dutyAssignments)
    setOperationsPanelRevision((revision) => revision + 1)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setTimetableGridSelectionState({
      context: timetableGridSelectionContext,
      selection: null,
    })
    const warning = result.warnings.length > 0
      ? ` 注意：${result.warnings.join(' / ')}`
      : ''
    setGridAssignmentFeedback({
      eventId: context.event.id,
      eventDayId: currentSelection.eventDayId,
      stageId: currentSelection.stageId,
      kind: 'success',
      message: `${result.targetLabel}に${result.memberName}を${formatMinuteAsLocalTime(currentSelection.fromMinute)}〜${formatMinuteAsLocalTime(currentSelection.untilMinute)}で割り当てました。${warning}`,
    })
  }

  const handleOpenDutyAutoAssignment = () => {
    if (!canEditWorkspace) return
    const selection = getCurrentResolvedGridSelection()
    const context = getGridAssignmentContext()
    if (
      !selection || selection.target.kind !== 'duty' || !context ||
      !currentStage || !timetableSelection.eventDayId ||
      selection.eventDayId !== timetableSelection.eventDayId ||
      selection.stageId !== currentStage.id
    ) {
      rejectStaleGridSelection()
      return
    }
    if (hasUnsavedOperations()) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: selection.eventDayId,
        stageId: selection.stageId,
        kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。右側の設定を保存してから自動割り当てしてください。',
      })
      return
    }

    const dutyTypeId = selection.target.dutyTypeId
    const dutyType = context.dutyTypes.find((candidate) =>
      candidate.id === dutyTypeId,
    )
    const preview = planDutyAutoAssignment(context, selection, 1)
    setGridAssignmentFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog({
      eventId: context.event.id,
      selection,
      dutyTypeName: dutyType?.name ?? '当日運営',
      additionalCount: '1',
      preview,
      errors: [],
    })
  }

  const handleDutyAutoAssignmentCountChange = (value: string) => {
    if (!canEditWorkspace) return
    const dialog = dutyAutoAssignmentDialog
    const selection = getCurrentResolvedGridSelection()
    const context = getGridAssignmentContext()
    if (!dialog || !selection || !context || !selectionsMatch(selection, dialog.selection)) {
      rejectStaleGridSelection()
      return
    }
    setDutyAutoAssignmentDialog({
      ...dialog,
      additionalCount: value,
      preview: planDutyAutoAssignment(context, selection, Number(value)),
      notice: undefined,
      errors: [],
    })
  }

  const handleApplyDutyAutoAssignment = () => {
    if (!canEditWorkspace) return
    const dialog = dutyAutoAssignmentDialog
    const selection = getCurrentResolvedGridSelection()
    const context = getGridAssignmentContext()
    if (!dialog || !selection || !context || !selectionsMatch(selection, dialog.selection)) {
      rejectStaleGridSelection()
      return
    }
    if (hasUnsavedOperations()) {
      setDutyAutoAssignmentDialog({
        ...dialog,
        errors: ['PAまたは当日運営に未保存の変更があります。右側の設定を保存してから自動割り当てしてください。'],
      })
      return
    }

    const latestPreview = planDutyAutoAssignment(
      context,
      selection,
      Number(dialog.additionalCount),
    )
    if (!latestPreview.ok) {
      setDutyAutoAssignmentDialog({
        ...dialog,
        preview: latestPreview,
        notice: undefined,
        errors: [],
      })
      return
    }
    if (!dialog.preview.ok || dialog.preview.plan.planKey !== latestPreview.plan.planKey) {
      setDutyAutoAssignmentDialog({
        ...dialog,
        preview: latestPreview,
        notice: '担当状況が変わったため候補を更新しました。内容を確認してもう一度追加してください。',
        errors: [],
      })
      return
    }
    const autoContext = getDutyAutoAssignmentContext(context, selection)
    if (!autoContext) {
      rejectStaleGridSelection()
      return
    }
    const result = createDutyAutoAssignments({
      context: autoContext,
      plan: latestPreview.plan,
      newDutyAssignmentIds: latestPreview.plan.selectedMemberIds.map(() =>
        createId('duty-assignment'),
      ),
    })
    if (!result.ok) {
      setDutyAutoAssignmentDialog({
        ...dialog,
        preview: latestPreview,
        errors: result.errors ?? [result.message],
      })
      return
    }

    setDutyAssignments(result.dutyAssignments)
    setOperationsPanelRevision((revision) => revision + 1)
    setDutyAutoAssignmentDialog(null)
    setTimetableGridSelectionState({
      context: timetableGridSelectionContext,
      selection: null,
    })
    const selectedNames = latestPreview.plan.selectedMemberIds.map((memberId) =>
      members.find((member) => member.id === memberId)?.realName ?? memberId,
    )
    const assignedLabel = selectedNames.length === 1
      ? selectedNames[0]
      : `${selectedNames.length}名`
    const warning = latestPreview.plan.warnings.length > 0
      ? ` 注意：${latestPreview.plan.warnings.join(' / ')}`
      : ''
    setGridAssignmentFeedback({
      eventId: context.event.id,
      eventDayId: selection.eventDayId,
      stageId: selection.stageId,
      kind: 'success',
      message: `${dialog.dutyTypeName}に${assignedLabel}を自動割り当てしました。${warning}`,
    })
  }

  const handleOpenGridAssignmentDeletion = () => {
    if (!canEditWorkspace) return
    const selection = getCurrentResolvedGridSelection()
    const context = getGridAssignmentContext()
    const eventDayId = timetableSelection.eventDayId
    const stageId = currentStage?.id
    if (!selection || !context || !eventDayId || !stageId) {
      rejectStaleGridSelection()
      return
    }
    if (hasUnsavedOperations()) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId,
        stageId,
        kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。右側の設定を保存してから担当を削除してください。',
      })
      return
    }

    const targets = getTimetableGridSelectionAssignmentTargets(
      selection,
      timetableWorkspaceRows.rows,
    )
    if (targets.length === 0) return
    const deletion = deleteTimetableGridAssignments({
      context,
      targets,
      eventDayId,
      stageId,
    })
    if (!deletion.ok) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId,
        stageId,
        kind: 'error',
        message: deletion.errors.join(' '),
      })
      return
    }

    setGridAssignmentFeedback(null)
    setGridAssignmentDialog(null)
    setDutyAutoAssignmentDialog(null)
    setGridAssignmentDeletion({
      eventId: context.event.id,
      eventDayId,
      stageId,
      selection,
      targets,
      items: deletion.deleted,
      includesOutsideSelection: deletion.deleted.some((item) =>
        item.fromMinute < selection.fromMinute ||
        item.untilMinute > selection.untilMinute,
      ),
    })
  }

  const handleConfirmGridAssignmentDeletion = () => {
    if (!canEditWorkspace) return
    const confirmation = gridAssignmentDeletion
    const context = getGridAssignmentContext()
    if (!confirmation || !context) return
    setGridAssignmentDeletion(null)
    const selection = getCurrentResolvedGridSelection()
    if (
      !selection ||
      confirmation.eventId !== context.event.id ||
      confirmation.eventDayId !== timetableSelection.eventDayId ||
      confirmation.stageId !== currentStage?.id ||
      !areTimetableGridAssignmentTargetsEqual(
        selection.target,
        confirmation.selection.target,
      ) ||
      selection.scheduleItemIds.length !== confirmation.selection.scheduleItemIds.length ||
      !selection.scheduleItemIds.every((id, index) =>
        id === confirmation.selection.scheduleItemIds[index]
      )
    ) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: confirmation.eventDayId,
        stageId: confirmation.stageId,
        kind: 'error',
        message: '編集対象が変わったため担当を削除できませんでした。',
      })
      return
    }
    if (hasUnsavedOperations()) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: confirmation.eventDayId,
        stageId: confirmation.stageId,
        kind: 'error',
        message: 'PAまたは当日運営に未保存の変更があります。右側の設定を保存してから担当を削除してください。',
      })
      return
    }

    const currentTargets = getTimetableGridSelectionAssignmentTargets(
      selection,
      timetableWorkspaceRows.rows,
    )
    const targetsAreCurrent = currentTargets.length === confirmation.targets.length &&
      currentTargets.every((target, index) => {
        const expected = confirmation.targets[index]
        return expected !== undefined &&
          target.kind === expected.kind &&
          target.assignmentId === expected.assignmentId
      })
    if (!targetsAreCurrent) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: confirmation.eventDayId,
        stageId: confirmation.stageId,
        kind: 'error',
        message: '選択範囲の担当が変わったため削除できませんでした。',
      })
      return
    }

    const deletion = deleteTimetableGridAssignments({
      context,
      targets: confirmation.targets,
      eventDayId: confirmation.eventDayId,
      stageId: confirmation.stageId,
    })
    if (!deletion.ok) {
      setGridAssignmentFeedback({
        eventId: context.event.id,
        eventDayId: confirmation.eventDayId,
        stageId: confirmation.stageId,
        kind: 'error',
        message: deletion.errors.join(' '),
      })
      return
    }

    if (deletion.kind === 'pa') setPaAssignments(deletion.paAssignments)
    else setDutyAssignments(deletion.dutyAssignments)
    setOperationsPanelRevision((revision) => revision + 1)
    const message = deletion.deleted.length === 1
      ? `${deletion.deleted[0].targetLabel} ${deletion.deleted[0].memberName}の担当を削除しました。`
      : `選択範囲の担当${deletion.deleted.length}件を削除しました。`
    setGridAssignmentFeedback({
      eventId: context.event.id,
      eventDayId: confirmation.eventDayId,
      stageId: confirmation.stageId,
      kind: 'success',
      message,
    })
  }
  const timetableLockEvaluation = evaluateSelectedEventLocks(scheduleItems)
  const unavailableTimetableLockRepair = (
    <TimetableLockRepairPanel
      violations={timetableLockEvaluation.violations}
      timetableLocks={selectedEventTimetableLocks}
      scheduleItems={selectedScheduleItems}
      eventBands={selectedEventBands}
      onUnlockTimetableLock={handleUnlockTimetableLock}
      readOnly={!canEditWorkspace}
    />
  )
  const unavailableTimetableOrderConstraintRepair = selectedEvent ? (
    <TimetableOrderConstraintRepairPanel
      key={selectedEvent.id}
      event={selectedEvent}
      eventDays={selectedEventDays}
      stages={selectedStages}
      sections={selectedSections}
      eventBands={selectedEventBands}
      timetableOrderConstraints={timetableOrderConstraints}
      onCommit={handleCommitTimetableOrderConstraints}
    />
  ) : null
  const activeGridAssignmentDialog =
    gridAssignmentDialog?.eventId === selectedEvent?.id &&
    timetableGridSelection
      ? gridAssignmentDialog
      : null
  const handleFinalCheckNavigation = (target: EventFinalCheckRepairTarget) => {
    if (!selectedEvent) return
    const navigation = resolveEventFinalCheckRepairNavigation({
      target,
      eventId: selectedEvent.id,
      eventDays: selectedEventDays,
      stages: selectedStages,
      currentEventDayId: timetableSelection.eventDayId,
      currentStageId: timetableSelection.stageId,
    })
    if (navigation.step === 6) {
      setSelectedTimetableEventDayId(navigation.eventDayId)
      setSelectedTimetableStageId(navigation.stageId)
      setTimetableOrderConstraintFeedback(null)
      setActiveTimetableOrderBlockKey(null)
    } else {
      setTimetableHistoryFeedback(null)
    }
    setActiveStep(navigation.step)
  }

  const activeDutyAutoAssignmentDialog =
    dutyAutoAssignmentDialog?.eventId === selectedEvent?.id &&
    timetableGridSelection
      ? dutyAutoAssignmentDialog
      : null
  const activeGridAssignmentDeletion =
    gridAssignmentDeletion?.eventId === selectedEvent?.id
      ? gridAssignmentDeletion
      : null

  const cloudEventHydrationView = getCloudEventHydrationView({
    cloudEnabled: Boolean(cloudWorkspace),
    persistenceScopeReady,
    requestedScopeKey: requestedPersistenceStorageKey,
    hydration: cloudEventLoadState,
  })

  if (cloudEventHydrationView === 'loading') {
    return (
      <main className="app-loading" aria-busy="true">
        <p role="status">ワークスペースのCloud Eventを読み込んでいます…</p>
      </main>
    )
  }

  if (cloudEventHydrationView === 'error' && cloudEventLoadState.kind === 'error') {
    return (
      <AppShell
        activeSection="events"
        onNavigate={handleAppNavigation}
        onBeforeSignOut={handleBeforeSignOut}
        onBeforeWorkspaceChange={handleBeforeWorkspaceChange}
      >
        <main className="app-loading">
          <p role="alert">{cloudEventLoadState.message}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setCloudEventReloadToken(token => token + 1)}
          >
            Cloud Eventを再読み込み
          </button>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell
      activeSection={activeView === 'event-editor' ? 'events' : activeView}
      onNavigate={handleAppNavigation}
      onBeforeSignOut={handleBeforeSignOut}
      onBeforeWorkspaceChange={handleBeforeWorkspaceChange}
    >
      {backupFeedback && (
        <div
          className={`data-backup-feedback data-backup-feedback--${backupFeedback.kind}`}
          role={backupFeedback.kind === 'error' ? 'alert' : 'status'}
        >
          {backupFeedback.message}
        </div>
      )}
      {activeView === 'event-editor' ? (
        <EventEditorShell
          key={canEditWorkspace ? 'event-editor-editable' : 'event-editor-read-only'}
          eventName={selectedEvent?.name ?? 'イベント'}
          activeStep={activeStep}
          readOnly={!canEditWorkspace}
          onStepChange={handleEventEditorStepChange}
          onBackToEvents={handleLeaveEventEditor}
          cloudSave={cloudWorkspace && selectedEvent ? {
            operation: getCloudEventOperation(
              cloudEventOperations,
              requestedPersistenceStorageKey,
              selectedEvent.id,
            ),
            feedback: cloudEventSaveFeedback?.eventId === selectedEvent.id
              ? cloudEventSaveFeedback
              : undefined,
            onSave: handleSaveSelectedEventToCloud,
          } : undefined}
        >
          {activeStep === 1 && selectedEvent ? (
            <EventBasicInfo
              ref={eventBasicInfoRef}
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
                  timetableOrderConstraints,
                },
              )}
              checkEventDeletion={handleCheckEventDeletion}
              onDeleteEvent={handleDeleteEvent}
              isCloudSavePending={getCloudEventOperation(
                cloudEventOperations,
                requestedPersistenceStorageKey,
                selectedEvent.id,
              ) !== undefined}
              onSave={handleSaveEventBasicInfo}
              onSaveAndNext={() => setActiveStep(2)}
              readOnly={!canEditWorkspace}
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
                timetableOrderConstraints,
              )}
              canDeleteStage={(stageId) => canDeleteStage(stageId, {
                sections,
                scheduleItems,
                eventBands,
                paAssignments,
                dutyAssignments,
                timetableLocks,
                timetableOrderConstraints,
              })}
              canDeleteSection={(sectionId) => canDeleteSection(sectionId, {
                scheduleItems,
                eventBands,
                timetableLocks,
                timetableOrderConstraints,
                paAssignments,
                dutyAssignments,
              })}
              onSave={handleSaveEventStageSettings}
              onSaveAndNext={() => setActiveStep(3)}
              readOnly={!canEditWorkspace}
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
              readOnly={!canEditWorkspace}
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
              timetableOrderConstraints={timetableOrderConstraints}
              createDraftId={() => createId('event-band-draft')}
              onSave={handleSaveEventBandSettings}
              onSaveAndNext={() => setActiveStep(5)}
              readOnly={!canEditWorkspace}
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
              readOnly={!canEditWorkspace}
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
                canUndo={canEditWorkspace && canUndoTimetable}
                canRedo={canEditWorkspace && canRedoTimetable}
                onUndo={() => {
                  performTimetableHistoryTransition('undo')
                }}
                onRedo={() => {
                  performTimetableHistoryTransition('redo')
                }}
                historyFeedback={visibleTimetableHistoryFeedback}
                navigationFeedback={
                  step6NavigationFeedback?.eventId === selectedEvent.id
                    ? step6NavigationFeedback.message
                    : null
                }
                generationAction={canEditWorkspace ? (
                  <div className="timetable-generation-action">
                    <div className="timetable-generation-action__buttons">
                    <button type="button" className="primary-button"
                      disabled={!timetableEventDay || timetableStages.length === 0 || currentDayEventBands.length === 0}
                      title="選択中の開催日の全Stageを対象に、確認用のプレビューを生成します。"
                      onClick={handleOpenGenerationOptions}>
                      ✨ この開催日を自動生成
                    </button>
                    <button type="button" className="timetable-reset-button"
                      disabled={!timetableResetResult?.ok || !timetableResetResult.hasChanges}
                      title={!timetableResetResult?.ok ? '参照関係またはデータの所属を安全に判定できないため、初期化できません。'
                        : !timetableResetResult.hasChanges ? '初期化対象の配置・担当・TT固定がありません。休憩は残ります。'
                        : 'この開催日の全Stageの出演配置・PA・当日運営担当・TT固定を削除します。休憩と出演条件は残します。'}
                      onClick={handleOpenTimetableReset}>この開催日のTTを初期化</button>
                    </div>
                  </div>
                ) : undefined}
                generationFeedback={generationFeedback?.eventId === selectedEvent.id &&
                  generationFeedback.eventDayId === timetableEventDay?.id
                  ? (
                      generationFeedback.kind === 'error' && generationFeedback.guidance
                        ? <TimetableGenerationFailureGuidance guidance={generationFeedback.guidance} />
                        : (
                          <p role={generationFeedback.kind === 'error' ? 'alert' : 'status'}
                            className={generationFeedback.kind === 'error' ? 'form-error' : 'timetable-generation-feedback'}>
                            {generationFeedback.message}
                          </p>
                        )
                    )
                  : null}
                settings={currentStage ? (
                  <div className="timetable-toolbar-settings">
                    <label>
                      開始
                      <input
                        type="time"
                        value={startTime}
                        disabled={!canEditWorkspace}
                        onChange={(event) => handleStageStartTimeChange(event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
                unavailableContent={!timetableEventDay ? (
                  <section className="timetable-empty-state">
                    <h3>開催日が設定されていません</h3>
                    <p>Step 1で開催日を設定してください。</p>
                    {unavailableTimetableLockRepair}
                    {unavailableTimetableOrderConstraintRepair}
                  </section>
                ) : !currentStage ? (
                  <section className="timetable-empty-state">
                    <h3>この開催日にはStageがありません</h3>
                    <p>タイムテーブルを作成するには、Step 2でStageを設定してください。</p>
                    {unavailableTimetableLockRepair}
                    {unavailableTimetableOrderConstraintRepair}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => handleEventEditorStepChange(2)}
                    >
                      Step 2 会場・Stageへ
                    </button>
                  </section>
                ) : currentStageTimelineFailed ? (
                  <section className="timetable-data-error" role="alert">
                    <h3>このStageのタイムテーブルを計算できません</h3>
                    <p>
                      参照切れの出演項目があります。Step 4の出演バンドと配置内容を確認してください。
                    </p>
                    {unavailableTimetableLockRepair}
                    {unavailableTimetableOrderConstraintRepair}
                  </section>
                ) : currentStageHasInvalidSectionAssignments ? (
                  <section className="timetable-data-error" role="alert">
                    <h3>このStageのタイムテーブルを編集できません</h3>
                    <p>
                      Section設定と一致しない項目があります。データを確認してから再度開いてください。
                    </p>
                    <p>対象項目: {invalidCurrentStageScheduleItemIds.join('、')}</p>
                    {unavailableTimetableLockRepair}
                    {unavailableTimetableOrderConstraintRepair}
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
                          {poolEventBands.map((eventBand, index) => {
                            const orderConstraintMember =
                              getTimetableOrderConstraintBlockMember(
                                timetableOrderConstraintBlocks,
                                eventBand.id,
                              )
                            return (
                            <Draggable
                              key={eventBand.id}
                              draggableId={eventBand.id}
                              index={index}
                              isDragDisabled={!canEditWorkspace}
                            >
                              {(provided) => (
                                <li
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  className={[
                                    'timetable-pool-card',
                                    orderConstraintMember?.blockKey ===
                                      visibleTimetableOrderBlockKey
                                      ? 'timetable-pool-card--order-highlight'
                                      : '',
                                  ].filter(Boolean).join(' ')}
                                  style={provided.draggableProps.style}
                                  onMouseEnter={orderConstraintMember
                                    ? () => setActiveTimetableOrderBlockKey(
                                        orderConstraintMember.blockKey,
                                      )
                                    : undefined}
                                  onMouseLeave={orderConstraintMember
                                    ? () => setActiveTimetableOrderBlockKey(null)
                                    : undefined}
                                  onFocusCapture={orderConstraintMember
                                    ? () => setActiveTimetableOrderBlockKey(
                                        orderConstraintMember.blockKey,
                                      )
                                    : undefined}
                                  onBlurCapture={orderConstraintMember
                                    ? () => setActiveTimetableOrderBlockKey(null)
                                    : undefined}
                                >
                                  <div>
                                    <span className="timetable-drag-handle" aria-hidden="true">☰</span>
                                    <span className="timetable-pool-band-name">
                                      {eventBand.name}
                                    </span>
                                    {orderConstraintMember && (
                                      <span
                                        className="timetable-order-block-badge"
                                        title={orderConstraintMember.title}
                                      >
                                        🔗 {orderConstraintMember.badgeLabel}
                                      </span>
                                    )}
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
                            )
                          })}
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
                    breakDuration={breakDuration}
                    onBreakDurationChange={setBreakDuration}
                    onAddBreak={handleAddBreak}
                    onAddInterSectionBreak={handleAddInterSectionBreak}
                    onRemoveScheduleItem={handleRemoveScheduleItem}
                    timetableLocks={selectedEventTimetableLocks}
                    scheduleItems={selectedScheduleItems}
                    eventBands={selectedEventBands}
                    lockViolations={timetableLockEvaluation.violations}
                    lockFeedback={getTimetableLockFeedbackMessage(
                      timetableLockFeedback,
                      selectedEventId,
                    )}
                    orderConstraintFeedback={
                      timetableOrderConstraintFeedback?.eventId === selectedEvent.id &&
                      timetableOrderConstraintFeedback.eventDayId === timetableSelection.eventDayId &&
                      timetableOrderConstraintFeedback.stageId === currentStage.id
                        ? timetableOrderConstraintFeedback.message
                        : ''
                    }
                    orderConstraintBlocks={timetableOrderConstraintBlocks}
                    activeOrderConstraintBlockKey={visibleTimetableOrderBlockKey}
                    onOrderConstraintBlockHighlightChange={setActiveTimetableOrderBlockKey}
                    onSetTimetableLock={handleSetTimetableLock}
                    onUnlockTimetableLock={handleUnlockTimetableLock}
                    onUnlockAllTimetableLocks={handleUnlockAllTimetableLocks}
                    selection={timetableGridSelection}
                    onSelectionChange={handleTimetableGridSelectionChange}
                    assignmentFeedback={
                      gridAssignmentFeedback?.eventId === selectedEvent.id &&
                      gridAssignmentFeedback.eventDayId === timetableSelection.eventDayId &&
                      gridAssignmentFeedback.stageId === currentStage.id
                        ? gridAssignmentFeedback
                        : null
                    }
                    onAssignSelection={handleOpenGridAssignment}
                    onAutoAssignSelection={handleOpenDutyAutoAssignment}
                    onDeleteSelectionAssignments={handleOpenGridAssignmentDeletion}
                    readOnly={!canEditWorkspace}
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
                orderPanel={currentStage && timetableEventDay ? (
                  <TimetableOrderConstraintSettings
                    key={`${selectedEvent.id}:${timetableEventDay.id}:${currentStage.id}`}
                    event={selectedEvent}
                    eventDay={timetableEventDay}
                    stage={currentStage}
                    eventDays={selectedEventDays}
                    stages={selectedStages}
                    sections={selectedSections}
                    eventBands={selectedEventBands}
                    scheduleItems={selectedScheduleItems}
                    timetableOrderConstraints={timetableOrderConstraints}
                    orderConstraintBlocks={timetableOrderConstraintBlocks}
                    activeOrderConstraintBlockKey={visibleTimetableOrderBlockKey}
                    onOrderConstraintBlockHighlightChange={setActiveTimetableOrderBlockKey}
                    createConstraintId={() => createId('timetable-order-constraint')}
                    onCommit={handleCommitTimetableOrderConstraints}
                    readOnly={!canEditWorkspace}
                  />
                ) : null}
                renderPaPanel={(onValidationFailed) => currentStage ? (
                  <PaSettings
                    ref={paSettingsRef}
                    key={`${selectedEvent.id}:${operationsPanelRevision}`}
                    event={selectedEvent}
                    eventDays={selectedEventDays}
                    stages={selectedStages}
                    sections={selectedSections}
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
                      setTimetableOrderConstraintFeedback(null)
                      setActiveTimetableOrderBlockKey(null)
                    }}
                    onValidationFailed={onValidationFailed}
                    createDraftId={() => createId('pa-assignment-draft')}
                    formId={`pa-settings-${selectedEvent.id}`}
                    onCreateUpdate={handleCreatePaAssignmentsUpdate}
                    onCommit={(result) => {
                      if (!canEditWorkspace) return
                      setPaAssignments(result.paAssignments)
                      setStep6NavigationFeedback(null)
                    }}
                    onSaveAndNext={handleSaveStep6AndNext}
                    readOnly={!canEditWorkspace}
                  />
                ) : null}
                renderOperationsPanel={(onValidationFailed) => currentStage ? (
                  <DutySettings
                    ref={dutySettingsRef}
                    key={`${selectedEvent.id}:${operationsPanelRevision}`}
                    event={selectedEvent}
                    eventDays={selectedEventDays}
                    stages={selectedStages}
                    sections={selectedSections}
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
                      setTimetableOrderConstraintFeedback(null)
                      setActiveTimetableOrderBlockKey(null)
                    }}
                    onValidationFailed={onValidationFailed}
                    createDraftId={() => createId('duty-draft')}
                    onCreateUpdate={handleCreateDutySettingsUpdate}
                    onCommit={(result) => {
                      if (!canEditWorkspace) return
                      setDutyTypes(result.dutyTypes)
                      setDutyAssignments(result.dutyAssignments)
                      setStep6NavigationFeedback(null)
                    }}
                    readOnly={!canEditWorkspace}
                  />
                ) : null}
                footer={(
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!canEditWorkspace}
                    onClick={handleSaveStep6AndNext}
                  >
                    設定を保存して次へ <span aria-hidden="true">→</span>
                  </button>
                )}
              />
            </DragDropContext>
          ) : activeStep === 7 && selectedEvent && finalCheckReport ? (
            <EventFinalCheckPage
              key={selectedEvent.id}
              report={finalCheckReport}
              eventDays={selectedEventDays}
              stages={selectedStages}
              onNavigateToRepair={handleFinalCheckNavigation}
              onProceed={() => setActiveStep(8)}
            />
          ) : activeStep === 8 && selectedEvent ? (
            <EventOutputPage
              event={selectedEvent}
              eventDays={selectedEventDays}
              stages={selectedStages}
              sections={selectedSections}
              members={members}
              eventMembers={selectedEventMembers}
              eventMemberDays={selectedEventMemberDays}
              eventBands={selectedEventBands}
              scheduleItems={selectedScheduleItems}
              paAssignments={selectedEventPaAssignments}
              dutyTypes={selectedEventDutyTypes}
              dutyAssignments={selectedEventDutyAssignments}
            />
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
          readOnly={!canEditWorkspace}
        />
      ) : activeView === 'shared-data' ? (
        <CommonDataPage
          key={canEditWorkspace ? 'common-data-editable' : 'common-data-read-only'}
          members={members}
          bands={bands}
          onSaveMember={handleSaveCommonMember}
          onSaveBand={handleSaveCommonBand}
          checkMemberDeletion={getCommonMemberDeletionCheck}
          onDeleteMember={handleDeleteCommonMember}
          checkBandDeletion={getCommonBandDeletionCheck}
          onDeleteBand={handleDeleteCommonBand}
          onImportMembers={(nextMembers) => {
            if (canEditWorkspace) setMembers(nextMembers)
          }}
          onImportBands={(nextBands) => {
            if (canEditWorkspace) setBands(nextBands)
          }}
          createMemberId={() => createId('member')}
          createBandId={() => createId('band')}
          readOnly={!canEditWorkspace}
        />
      ) : (
        <DataBackupSettings
          isImporting={isImportingBackup}
          onExport={handleExportBackup}
          onImportFile={handleImportBackup}
          readOnly={!canEditWorkspace}
        />
      )}
      {canEditWorkspace && isCreateEventDialogOpen && (
        <CreateEventDialog
          onCancel={() => setIsCreateEventDialogOpen(false)}
          onCreate={handleCreateEvent}
        />
      )}
      {canEditWorkspace && generationPreview && (
        <TimetableGenerationPreviewDialog
          preview={generationPreview.presentation}
          options={generationPreview.options}
          onCancel={() => setGenerationPreview(null)}
          onApply={handleApplyGeneratedTimetable}
        />
      )}
      {canEditWorkspace && generationOptionsScope?.eventId === selectedEvent?.id &&
        generationOptionsScope?.eventDayId === timetableEventDay?.id && timetableEventDay && (
        <TimetableGenerationOptionsDialog dayLabel={formatGenerationDay(timetableEventDay)}
          options={generationOptions} onChange={setGenerationOptions}
          onCancel={() => setGenerationOptionsScope(null)} onGenerate={handleGenerateTimetable} />
      )}
      {canEditWorkspace && resetConfirmation?.eventId === selectedEvent?.id &&
        resetConfirmation?.eventDayId === timetableEventDay?.id && timetableEventDay && (
        <TimetableResetConfirmDialog dayLabel={formatGenerationDay(timetableEventDay)}
          onCancel={() => setResetConfirmation(null)} onReset={handleResetTimetable} />
      )}
      {canEditWorkspace && activeGridAssignmentDialog && (
          <TimetableGridAssignmentDialog
            selection={activeGridAssignmentDialog.selection}
            targetLabel={activeGridAssignmentDialog.targetLabel}
            candidates={activeGridAssignmentDialog.candidates}
            errors={activeGridAssignmentDialog.errors}
            onCancel={() => setGridAssignmentDialog(null)}
            onClearErrors={() => setGridAssignmentDialog((current) =>
              current ? { ...current, errors: [] } : current,
            )}
            onSubmit={handleSubmitGridAssignment}
          />
      )}
      {canEditWorkspace && activeDutyAutoAssignmentDialog && (
        <TimetableDutyAutoAssignmentDialog
          selection={activeDutyAutoAssignmentDialog.selection}
          dutyTypeName={activeDutyAutoAssignmentDialog.dutyTypeName}
          additionalCount={activeDutyAutoAssignmentDialog.additionalCount}
          preview={activeDutyAutoAssignmentDialog.preview}
          members={members}
          notice={activeDutyAutoAssignmentDialog.notice}
          errors={activeDutyAutoAssignmentDialog.errors}
          onAdditionalCountChange={handleDutyAutoAssignmentCountChange}
          onCancel={() => setDutyAutoAssignmentDialog(null)}
          onSubmit={handleApplyDutyAutoAssignment}
        />
      )}
      {canEditWorkspace && activeGridAssignmentDeletion && (
        <TimetableGridAssignmentDeletionDialog
          items={activeGridAssignmentDeletion.items}
          includesOutsideSelection={activeGridAssignmentDeletion.includesOutsideSelection}
          onConfirm={handleConfirmGridAssignmentDeletion}
          onCancel={() => setGridAssignmentDeletion(null)}
        />
      )}
    </AppShell>
  )
}

export default App
