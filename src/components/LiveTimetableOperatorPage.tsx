import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AppShell } from './AppShell.tsx'
import { useOptionalCloudWorkspace } from '../cloud/useCloudWorkspace.ts'
import { formatMinuteAsLocalTime } from '../domain/timeline.ts'
import {
  createSupabaseLiveTimetableRepository,
  type AuthorizedLiveTimetable,
  type LiveTimetableEntryView,
  type LiveTimetableOperatorCandidate,
  type LiveTimetableRepositoryError,
  type LiveTimetableStageView,
} from '../live/liveTimetableRepository.ts'
import {
  LIVE_TIMETABLE_REALTIME_COLUMNS,
  canApplyLiveRead,
  canApplyLatestScopedRequest,
  canResolveLiveMutationReconciliation,
  canApplyLiveOperatorCandidateRead,
  canDispatchConfirmedLiveMutation,
  canRunLiveMutation,
  createInvalidatedLiveOperatorCandidateRead,
  createLivePollingTimerController,
  createPostMutationReadBarrier,
  createLiveTimetableScopeKey,
  describeLiveStageManagementTarget,
  getLivePollingDelay,
  isLiveStateStale,
  isMatchingLiveRealtimePayload,
  resolveLiveOperatorCandidateSelection,
  runLiveAuthorizedReadWithDeadline,
  runLiveMutationWithDeadline,
  type LiveReadToken,
  type LiveMutationReconciliation,
  type LiveOperatorCandidateReadToken,
} from '../live/liveTimetableSync.ts'
import type {
  RetainedEditorAccountAction,
} from '../live/liveTimetableRouting.ts'
import { formatLiveTimetableTimestamp } from '../live/liveTimetablePresentation.ts'
import './LiveTimetableOperatorPage.css'

interface LiveTimetableOperatorPageProps {
  eventId: string
  onBeforeAccountAction?: (action: RetainedEditorAccountAction) => boolean
}

type ConnectionState = 'connecting' | 'realtime' | 'polling' | 'offline'

const connectionLabels: Record<ConnectionState, string> = {
  connecting: '接続中',
  realtime: 'Realtime接続中',
  polling: 'HTTP再取得で同期中',
  offline: 'オフライン',
}

const progressLabels: Record<LiveTimetableStageView['progressStatus'], string> = {
  empty: '出演なし',
  not_started: '開始前',
  waiting: '次の開始待ち',
  in_progress: '進行中',
  completed: '終了',
}

const describeEntry = (entry: LiveTimetableEntryView): string =>
  entry.kind === 'break' ? '休憩' : entry.displayName

const describeRepositoryError = (error: LiveTimetableRepositoryError): string => {
  switch (error.code) {
    case 'REVISION_CONFLICT':
      return '別の端末で更新されました。最新状態を再取得しました。'
    case 'STATE_CONFLICT':
      return '現在の進行状態ではこの操作を実行できません。最新状態を確認してください。'
    case 'ACCESS_DENIED':
      return '現在の権限ではこの操作を実行できません。'
    case 'LIVE_ALREADY_EXISTS':
      return 'Live TTは既に作成されています。再取得します。'
    case 'OPERATOR_NOT_ELIGIBLE':
    case 'OPERATOR_NOT_EDITOR':
      return '割当先のWorkspace権限が変わりました。候補を再取得してください。'
    case 'SUPABASE_ERROR':
      return '通信結果を確定できませんでした。操作は再送せず、最新状態を再取得します。'
    default:
      return error.message
  }
}

const getCurrentEntry = (
  stage: LiveTimetableStageView,
): LiveTimetableEntryView | undefined => stage.currentEntryPosition === null
  ? undefined
  : stage.entries.find(entry => entry.position === stage.currentEntryPosition)

const getNextEntry = (
  stage: LiveTimetableStageView,
): LiveTimetableEntryView | undefined => stage.nextEntryPosition === null
  ? undefined
  : stage.entries.find(entry => entry.position === stage.nextEntryPosition)

function LiveEntrySummary({
  title,
  entry,
  timeZone,
}: {
  title: string
  entry: LiveTimetableEntryView | undefined
  timeZone: string
}) {
  return (
    <section className="live-operator-entry-summary">
      <p>{title}</p>
      {entry ? (
        <>
          <strong>{describeEntry(entry)}</strong>
          <span>
            {formatMinuteAsLocalTime(entry.plannedStartMinute)}〜
            {formatMinuteAsLocalTime(entry.plannedEndMinute)}
          </span>
          <span>実開始 {formatLiveTimetableTimestamp(entry.actualStartedAt, timeZone)}</span>
          <span>実終了 {formatLiveTimetableTimestamp(entry.actualEndedAt, timeZone)}</span>
        </>
      ) : <strong>ありません</strong>}
    </section>
  )
}

export function LiveTimetableOperatorPage({
  eventId,
  onBeforeAccountAction,
}: LiveTimetableOperatorPageProps) {
  const cloud = useOptionalCloudWorkspace()
  if (!cloud) {
    return (
      <main className="live-operator-unavailable" role="alert">
        <h1>Live TTはCloudモード専用です</h1>
      </main>
    )
  }

  return (
    <LiveTimetableOperatorWorkspace
      key={JSON.stringify([
        cloud.user.id,
        cloud.workspace.id,
        cloud.workspaceVisitId,
        eventId,
      ])}
      eventId={eventId}
      onBeforeAccountAction={onBeforeAccountAction}
    />
  )
}

function LiveTimetableOperatorWorkspace({
  eventId,
  onBeforeAccountAction,
}: LiveTimetableOperatorPageProps) {
  const cloud = useOptionalCloudWorkspace()
  if (!cloud) throw new Error('Cloud Workspace context is required.')

  const liveRepository = useMemo(
    () => createSupabaseLiveTimetableRepository(cloud.supabase),
    [cloud.supabase],
  )
  const [liveId, setLiveId] = useState<string>()
  const [savedEvent, setSavedEvent] = useState<{
    name: string
    revision: number
  }>()
  const [live, setLive] = useState<AuthorizedLiveTimetable>()
  const liveRef = useRef<AuthorizedLiveTimetable | undefined>(undefined)
  const [initializing, setInitializing] = useState(true)
  const [pageError, setPageError] = useState('')
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error'
    message: string
  }>()
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [lastSynchronizedAt, setLastSynchronizedAt] = useState<number>()
  const lastSynchronizedAtRef = useRef<number | undefined>(undefined)
  const [now, setNow] = useState(0)
  const [consecutiveFailures, setConsecutiveFailures] = useState(0)
  const [mutationPending, setMutationPending] = useState(false)
  const [mutationReconciliationPending, setMutationReconciliationPending] =
    useState(false)
  const [creationOutcomeUnknown, setCreationOutcomeUnknown] = useState(false)
  const [freshnessVerificationPending, setFreshnessVerificationPending] =
    useState(false)
  const mutationPendingRef = useRef(false)
  const componentMountedRef = useRef(false)
  const mutationOperationSequenceRef = useRef(0)
  const mutationPendingOwnerRef = useRef(0)
  const mutationReconciliationRef = useRef<LiveMutationReconciliation | undefined>(undefined)
  const creationOutcomeUnknownRef = useRef(false)
  const [candidates, setCandidates] = useState<LiveTimetableOperatorCandidate[]>([])
  const candidatesRef = useRef<LiveTimetableOperatorCandidate[]>([])
  const [candidateError, setCandidateError] = useState('')
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [candidateContext, setCandidateContext] = useState<{
    liveId: string
    scopeKey: string
  }>()
  const [selectedCandidateByStage, setSelectedCandidateByStage] = useState<
    Record<string, string>
  >({})
  const [selectedDayId, setSelectedDayId] = useState('')
  const [selectedStageId, setSelectedStageId] = useState('')

  const scopeKey = useMemo(() => createLiveTimetableScopeKey({
    userId: cloud.user.id,
    workspaceId: cloud.workspace.id,
    workspaceVisitId: cloud.workspaceVisitId,
    eventId,
    liveId: liveId ?? 'pending',
  }), [
    cloud.user.id,
    cloud.workspace.id,
    cloud.workspaceVisitId,
    eventId,
    liveId,
  ])
  const activeScopeKeyRef = useRef(scopeKey)
  const requestSequenceRef = useRef(0)
  const latestAppliedSequenceRef = useRef(0)
  const freshnessRequiredSequenceRef = useRef(0)
  const inFlightReadRef = useRef<Promise<void> | null>(null)
  const activeReadControllerRef = useRef<AbortController | undefined>(undefined)
  const pendingReadRef = useRef(false)
  const refreshRef = useRef<(reason?: string) => Promise<void>>(async () => {})
  const candidateRequestSequenceRef = useRef(0)
  const candidateReadControllerRef = useRef<AbortController | undefined>(undefined)
  const discoveryRequestSequenceRef = useRef(0)
  const discoveryReadControllerRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey
  }, [scopeKey])

  useEffect(() => {
    componentMountedRef.current = true
    return () => {
      componentMountedRef.current = false
    }
  }, [])

  const discover = useCallback(async () => {
    discoveryReadControllerRef.current?.abort()
    const controller = new AbortController()
    discoveryReadControllerRef.current = controller
    const token: LiveReadToken = {
      scopeKey: activeScopeKeyRef.current,
      sequence: ++discoveryRequestSequenceRef.current,
    }
    setInitializing(true)
    setPageError('')
    setSavedEvent(undefined)
    const outcome = await runLiveAuthorizedReadWithDeadline({
      controller,
      read: signal => liveRepository.findForEvent(
        cloud.workspace.id,
        eventId,
        signal,
      ),
    })
    if (!canApplyLatestScopedRequest({
      token,
      activeScopeKey: activeScopeKeyRef.current,
      latestStartedSequence: discoveryRequestSequenceRef.current,
    })) return 'stale' as const
    if (discoveryReadControllerRef.current === controller) {
      discoveryReadControllerRef.current = undefined
    }
    setInitializing(false)
    if (outcome.status === 'aborted') return 'stale' as const
    if (outcome.status === 'timed-out') {
      setLiveId(undefined)
      liveRef.current = undefined
      setLive(undefined)
      setPageError('Live TTの作成状況確認がタイムアウトしました。再確認してください。')
      return 'failed' as const
    }
    if (outcome.status === 'failed') {
      setLiveId(undefined)
      liveRef.current = undefined
      setLive(undefined)
      setPageError('Live TTの作成状況を確認できませんでした。再確認してください。')
      return 'failed' as const
    }
    const discovery = outcome.value
    if (!discovery.ok) {
      setLiveId(undefined)
      liveRef.current = undefined
      setLive(undefined)
      setPageError(describeRepositoryError(discovery.error))
      return 'failed' as const
    }
    if (discovery.value.liveId) {
      creationOutcomeUnknownRef.current = false
      setCreationOutcomeUnknown(false)
      setLiveId(discovery.value.liveId)
      return 'live' as const
    }
    setSavedEvent({
      name: discovery.value.eventName,
      revision: discovery.value.sourceRevision,
    })
    return 'missing' as const
  }, [
    cloud.workspace.id,
    eventId,
    liveRepository,
  ])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void discover()
    })
    return () => {
      active = false
      discoveryRequestSequenceRef.current += 1
      discoveryReadControllerRef.current?.abort()
      discoveryReadControllerRef.current = undefined
    }
  }, [discover])

  const refresh = useCallback(async (reason = 'manual') => {
    void reason
    if (!liveId) return
    if (inFlightReadRef.current) {
      pendingReadRef.current = true
      return inFlightReadRef.current
    }

    const token: LiveReadToken = {
      scopeKey: activeScopeKeyRef.current,
      sequence: ++requestSequenceRef.current,
    }
    const controller = new AbortController()
    activeReadControllerRef.current = controller
    let retryWithBackoff = false
    const operation = (async () => {
      const outcome = await runLiveAuthorizedReadWithDeadline({
        controller,
        read: signal => liveRepository.loadAuthorized(liveId, signal),
      })
      if (token.scopeKey !== activeScopeKeyRef.current) return
      if (outcome.status === 'aborted') return
      if (outcome.status === 'timed-out') {
        retryWithBackoff = true
        setConsecutiveFailures(count => count + 1)
        setPageError('Live TTの読込がタイムアウトしました。自動再試行します。')
        return
      }
      if (outcome.status === 'failed') {
        retryWithBackoff = true
        setConsecutiveFailures(count => count + 1)
        setPageError('Live TTを再取得できませんでした。自動再試行します。')
        return
      }
      const result = outcome.value
      if (!result.ok) {
        retryWithBackoff = true
        setConsecutiveFailures(count => count + 1)
        setPageError(describeRepositoryError(result.error))
        if (result.error.code === 'ACCESS_DENIED' ||
          result.error.code === 'AUTHENTICATION_REQUIRED') {
          liveRef.current = undefined
          setLive(undefined)
        }
        return
      }

      const current = liveRef.current
      if (!canApplyLiveRead({
        token,
        activeScopeKey: activeScopeKeyRef.current,
        latestAppliedSequence: latestAppliedSequenceRef.current,
        minimumRequiredSequence: freshnessRequiredSequenceRef.current,
        incoming: result.value,
        current,
      })) return

      latestAppliedSequenceRef.current = token.sequence
      liveRef.current = result.value
      setLive(result.value)
      setPageError('')
      const synchronizedAt = Date.now()
      lastSynchronizedAtRef.current = synchronizedAt
      setLastSynchronizedAt(synchronizedAt)
      setNow(synchronizedAt)
      setConsecutiveFailures(0)
      const reconciliation = mutationReconciliationRef.current
      if (reconciliation && canResolveLiveMutationReconciliation({
        reconciliation,
        activeScopeKey: token.scopeKey,
        current: result.value,
      })) {
        mutationReconciliationRef.current = undefined
        setMutationReconciliationPending(false)
        setFeedback({
          kind: 'success',
          message: '結果不明だった操作が最新状態へ反映済みであることを確認しました。',
        })
      }
      if (token.sequence >= freshnessRequiredSequenceRef.current) {
        freshnessRequiredSequenceRef.current = 0
        setFreshnessVerificationPending(false)
      }
    })()
    inFlightReadRef.current = operation
    try {
      await operation
    } finally {
      if (activeReadControllerRef.current === controller) {
        activeReadControllerRef.current = undefined
      }
      if (inFlightReadRef.current === operation) inFlightReadRef.current = null
      if (pendingReadRef.current && token.scopeKey === activeScopeKeyRef.current) {
        pendingReadRef.current = false
        if (!retryWithBackoff) {
          queueMicrotask(() => { void refreshRef.current('coalesced') })
        }
      }
    }
  }, [liveId, liveRepository])

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  const restartAuthorizedRead = useCallback((reason: string) => {
    const controller = activeReadControllerRef.current
    if (controller && !controller.signal.aborted) {
      pendingReadRef.current = true
      controller.abort()
      return
    }
    void refreshRef.current(reason)
  }, [])

  useEffect(() => () => {
    pendingReadRef.current = false
    activeReadControllerRef.current?.abort()
  }, [scopeKey])

  useEffect(() => {
    if (!liveId) return
    queueMicrotask(() => { void refresh('initial') })
  }, [liveId, refresh])

  useEffect(() => {
    if (!liveId) return
    const capturedScope = scopeKey
    const channel = cloud.supabase
      .channel(`live-operator-${liveId}-${cloud.workspaceVisitId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'live_timetable_stages',
        filter: `live_timetable_id=eq.${liveId}`,
        select: [...LIVE_TIMETABLE_REALTIME_COLUMNS],
      }, (payload) => {
        if (capturedScope !== activeScopeKeyRef.current ||
          !isMatchingLiveRealtimePayload(
            payload.new,
            cloud.workspace.id,
            liveId,
          )) return
        void refreshRef.current('realtime')
      })

    channel.subscribe((status) => {
      if (!componentMountedRef.current ||
        capturedScope !== activeScopeKeyRef.current) return
      if (status === 'SUBSCRIBED') {
        setConnection('realtime')
        void refreshRef.current('subscribed')
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ||
        status === 'CLOSED') {
        setConnection(navigator.onLine ? 'polling' : 'offline')
      }
    })

    const { data: authListener } = cloud.supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (capturedScope !== activeScopeKeyRef.current || !session?.access_token) {
          return
        }
        queueMicrotask(() => {
          if (capturedScope !== activeScopeKeyRef.current) return
          void cloud.supabase.realtime.setAuth(session.access_token)
          void refreshRef.current('token-refresh')
        })
      },
    )

    return () => {
      authListener.subscription.unsubscribe()
      void cloud.supabase.removeChannel(channel)
    }
  }, [
    cloud.supabase,
    cloud.workspace.id,
    cloud.workspaceVisitId,
    liveId,
    scopeKey,
  ])

  useEffect(() => {
    if (!liveId) return
    let stopped = false
    const pollingTimer = createLivePollingTimerController({
      setTimer: (callback, delayMilliseconds) => window.setTimeout(
        callback,
        delayMilliseconds,
      ),
      clearTimer: handle => window.clearTimeout(handle as number),
    })

    const schedule = () => {
      if (stopped || document.visibilityState !== 'visible') return
      pollingTimer.schedule(
        getLivePollingDelay(consecutiveFailures, connection === 'realtime'),
        async (isCurrent) => {
          if (stopped || !isCurrent()) return
          if (!navigator.onLine) {
            setConnection('offline')
            if (isCurrent()) schedule()
            return
          }
          if (connection === 'offline') setConnection('polling')
          await refreshRef.current('polling')
          if (isCurrent()) schedule()
        },
      )
    }
    const handleVisibility = () => {
      pollingTimer.cancel()
      if (document.visibilityState === 'visible') {
        setNow(Date.now())
        freshnessRequiredSequenceRef.current = requestSequenceRef.current + 1
        setFreshnessVerificationPending(true)
        restartAuthorizedRead('visibility')
        schedule()
      }
    }
    const handleOnline = () => {
      setConnection(current => current === 'realtime' ? current : 'polling')
      freshnessRequiredSequenceRef.current = requestSequenceRef.current + 1
      setFreshnessVerificationPending(true)
      restartAuthorizedRead('online')
    }
    const handleOffline = () => {
      freshnessRequiredSequenceRef.current = requestSequenceRef.current + 1
      setFreshnessVerificationPending(true)
      setConnection('offline')
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    schedule()
    return () => {
      stopped = true
      pollingTimer.dispose()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [connection, consecutiveFailures, liveId, restartAuthorizedRead])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const invalidateCandidateRead = useCallback((error: string) => {
    candidateReadControllerRef.current?.abort()
    candidateReadControllerRef.current = undefined
    const current = liveRef.current
    const invalidated = createInvalidatedLiveOperatorCandidateRead({
      currentSequence: candidateRequestSequenceRef.current,
      liveId: current?.canManage ? current.liveId : undefined,
      scopeKey: current?.canManage ? activeScopeKeyRef.current : undefined,
      error,
    })
    candidateRequestSequenceRef.current = invalidated.nextSequence
    setCandidateLoading(invalidated.loading)
    candidatesRef.current = []
    setCandidates([])
    setCandidateContext(invalidated.context)
    setCandidateError(invalidated.error)
  }, [])

  const refreshCandidates = useCallback(async () => {
    const candidateLive = liveRef.current
    if (!candidateLive?.canManage) return
    candidateReadControllerRef.current?.abort()
    const controller = new AbortController()
    candidateReadControllerRef.current = controller
    const capturedScope = activeScopeKeyRef.current
    const token: LiveOperatorCandidateReadToken = {
      liveId: candidateLive.liveId,
      scopeKey: capturedScope,
      sequence: ++candidateRequestSequenceRef.current,
    }
    setCandidateContext({ liveId: token.liveId, scopeKey: token.scopeKey })
    setCandidateLoading(true)
    candidatesRef.current = []
    setCandidates([])
    setCandidateError('')
    const outcome = await runLiveAuthorizedReadWithDeadline({
      controller,
      read: signal => liveRepository.listOperatorCandidates(
        candidateLive.liveId,
        signal,
      ),
    })
    if (!canApplyLiveOperatorCandidateRead({
      token,
      activeLiveId: liveRef.current?.liveId,
      activeScopeKey: activeScopeKeyRef.current,
      latestStartedSequence: candidateRequestSequenceRef.current,
    })) return
    if (candidateReadControllerRef.current === controller) {
      candidateReadControllerRef.current = undefined
    }
    setCandidateLoading(false)
    if (outcome.status === 'aborted') return
    if (outcome.status === 'timed-out') {
      candidatesRef.current = []
      setCandidates([])
      setCandidateError('担当候補の取得がタイムアウトしました。担当候補を再取得してください。')
      return
    }
    if (outcome.status === 'failed') {
      candidatesRef.current = []
      setCandidates([])
      setCandidateError('担当候補を取得できませんでした。担当候補を再取得してください。')
      return
    }
    const result = outcome.value
    if (result.ok) {
      candidatesRef.current = result.value
      setCandidates(result.value)
      setCandidateError('')
    } else {
      candidatesRef.current = []
      setCandidates([])
      setCandidateError(`${describeRepositoryError(result.error)} 担当候補を再取得してください。`)
    }
  }, [liveRepository])

  useEffect(() => {
    if (!live?.canManage) {
      invalidateCandidateRead('')
      return
    }
    void refreshCandidates()
    return () => {
      candidateRequestSequenceRef.current += 1
      candidateReadControllerRef.current?.abort()
      candidateReadControllerRef.current = undefined
    }
  }, [
    invalidateCandidateRead,
    live?.canManage,
    live?.liveId,
    live?.managementRevision,
    refreshCandidates,
  ])

  const stale = isLiveStateStale(lastSynchronizedAt, now)
  const candidatesAreCurrent = live?.canManage === true &&
    candidateContext?.liveId === live.liveId &&
    candidateContext.scopeKey === scopeKey
  const currentCandidates = candidatesAreCurrent ? candidates : []
  const currentCandidateError = candidatesAreCurrent ? candidateError : ''
  const currentCandidateLoading = live?.canManage === true &&
    (!candidatesAreCurrent || candidateLoading)
  const mutationBlocked = mutationPending || freshnessVerificationPending ||
    mutationReconciliationPending
  const orderedDays = live ? [...live.eventDays].sort((left, right) =>
    left.position - right.position) : []
  const effectiveDayId = orderedDays.some(day =>
    day.sourceEventDayId === selectedDayId)
    ? selectedDayId
    : orderedDays[0]?.sourceEventDayId ?? ''
  const selectedDay = live?.eventDays.find(day =>
    day.sourceEventDayId === effectiveDayId)
  const dayStages = live?.stages.filter(stage =>
    stage.sourceEventDayId === effectiveDayId) ?? []
  const orderedManagementStages = live ? [...live.stages].sort((left, right) =>
    left.eventDayPosition - right.eventDayPosition ||
    left.position - right.position) : []
  const selectedStage = dayStages.find(stage => stage.stageId === selectedStageId) ??
    dayStages[0]
  const currentEntry = selectedStage ? getCurrentEntry(selectedStage) : undefined
  const nextEntry = selectedStage ? getNextEntry(selectedStage) : undefined
  const mutationEnabled = selectedStage ? canRunLiveMutation({
    online: navigator.onLine,
    stale,
    pending: mutationBlocked,
    canOperate: selectedStage.canOperate === true,
    progressEnabled: live?.isPublished === true,
  }) : false

  const requireFreshMutationConfirmation = useCallback(() => {
    freshnessRequiredSequenceRef.current = requestSequenceRef.current + 1
    setFreshnessVerificationPending(true)
    setFeedback({
      kind: 'error',
      message: '確認中に同期状態または権限が変わりました。最新状態を再取得し、内容を確認してもう一度操作してください。',
    })
    void refreshRef.current('pre-mutation-confirmation')
  }, [])

  const getConfirmedMutationLive = useCallback(({
    expectedScopeKey,
    expectedLiveId,
    authorized,
  }: {
    expectedScopeKey: string
    expectedLiveId: string
    authorized: (current: AuthorizedLiveTimetable) => boolean
  }): AuthorizedLiveTimetable | undefined => {
    const current = liveRef.current
    const allowed = canDispatchConfirmedLiveMutation({
      online: navigator.onLine,
      lastSynchronizedAt: lastSynchronizedAtRef.current,
      now: Date.now(),
      pending: mutationPendingRef.current ||
        mutationReconciliationRef.current !== undefined,
      freshnessRequiredSequence: freshnessRequiredSequenceRef.current,
      expectedScopeKey,
      activeScopeKey: activeScopeKeyRef.current,
      expectedLiveId,
      activeLiveId: current?.liveId,
      authorized: current ? authorized(current) : false,
    })
    if (allowed) return current
    if (expectedScopeKey === activeScopeKeyRef.current &&
      expectedLiveId === current?.liveId) {
      requireFreshMutationConfirmation()
    }
    return undefined
  }, [requireFreshMutationConfirmation])

  const runMutation = useCallback(async (
    action: () => Promise<{
      ok: true
      value: unknown
    } | {
      ok: false
      error: LiveTimetableRepositoryError
    }>,
    successMessage: string,
    onResult?: (result: {
      ok: true
      value: unknown
    } | {
      ok: false
      error: LiveTimetableRepositoryError
    }) => void,
    confirms?: (current: AuthorizedLiveTimetable) => boolean,
  ) => {
    if (mutationPendingRef.current || mutationReconciliationRef.current) return
    const capturedScope = activeScopeKeyRef.current
    const capturedLiveId = liveRef.current?.liveId
    if (!capturedLiveId) return
    const operationId = ++mutationOperationSequenceRef.current
    mutationPendingOwnerRef.current = operationId
    mutationPendingRef.current = true
    setMutationPending(true)
    setFeedback(undefined)
    let refreshRequired = false
    try {
      const outcome = await runLiveMutationWithDeadline({ mutation: action })
      if (!componentMountedRef.current ||
        capturedScope !== activeScopeKeyRef.current) return
      const isUnknown = outcome.status !== 'completed' ||
        (!outcome.value.ok && (
          outcome.value.error.code === 'SUPABASE_ERROR' ||
          outcome.value.error.code === 'INVALID_RESPONSE'
        ))
      if (isUnknown) {
        mutationReconciliationRef.current = {
          operationId,
          scopeKey: capturedScope,
          liveId: capturedLiveId,
          confirms: confirms ?? (() => false),
        }
        setMutationReconciliationPending(true)
        freshnessRequiredSequenceRef.current = createPostMutationReadBarrier(
          requestSequenceRef.current,
        )
        setFreshnessVerificationPending(true)
        setFeedback({
          kind: 'error',
          message: '操作の結果を確定できません。自動再送はせず、最新状態で反映済みと確認できるまで新しい操作を停止します。',
        })
        void refreshRef.current('mutation-timeout-reconciliation')
        return
      }
      const result = outcome.value
      refreshRequired = true
      onResult?.(result)
      setFeedback(result.ok
        ? { kind: 'success', message: successMessage }
        : { kind: 'error', message: describeRepositoryError(result.error) })
    } finally {
      if (refreshRequired && capturedScope === activeScopeKeyRef.current) {
        freshnessRequiredSequenceRef.current = createPostMutationReadBarrier(
          requestSequenceRef.current,
        )
        setFreshnessVerificationPending(true)
        await refreshRef.current('post-mutation')
      }
      if (componentMountedRef.current &&
        mutationPendingOwnerRef.current === operationId) {
        mutationPendingRef.current = false
        setMutationPending(false)
      }
    }
  }, [])

  const markCreationOutcomeUnknown = useCallback(() => {
    creationOutcomeUnknownRef.current = true
    setCreationOutcomeUnknown(true)
    setFeedback({
      kind: 'error',
      message: 'Live TT作成の結果が不明です。自動再送はしません。作成状況を再確認し、既存Liveが見つかるまで再作成しないでください。',
    })
  }, [])

  const createProjection = async () => {
    if (!savedEvent || cloud.membership.role !== 'owner' ||
      mutationPendingRef.current || creationOutcomeUnknownRef.current) return
    if (!window.confirm(
      'Cloudへ保存済みのTTからLive TTを作成します。\n未保存の変更は反映されません。\n\n作成しますか？',
    )) return
    const capturedScope = activeScopeKeyRef.current
    const operationId = ++mutationOperationSequenceRef.current
    mutationPendingOwnerRef.current = operationId
    mutationPendingRef.current = true
    setMutationPending(true)
    setFeedback(undefined)
    try {
      const outcome = await runLiveMutationWithDeadline({
        mutation: () => liveRepository.createProjection({
          workspaceId: cloud.workspace.id,
          eventId,
          expectedSourceRevision: savedEvent.revision,
          mode: 'create',
          expectedManagementRevision: null,
        }),
      })
      if (!componentMountedRef.current ||
        capturedScope !== activeScopeKeyRef.current) return
      if (outcome.status !== 'completed' ||
        (!outcome.value.ok && (
          outcome.value.error.code === 'SUPABASE_ERROR' ||
          outcome.value.error.code === 'INVALID_RESPONSE'
        ))) {
        markCreationOutcomeUnknown()
        void discover()
        return
      }
      const result = outcome.value
      const discoveryState = await discover()
      if (!componentMountedRef.current ||
        capturedScope !== activeScopeKeyRef.current) return
      if (discoveryState === 'live') {
        setFeedback(result.ok
          ? { kind: 'success', message: 'Live TTを作成しました。' }
          : {
              kind: result.error.code === 'LIVE_ALREADY_EXISTS' ? 'success' : 'error',
              message: result.error.code === 'LIVE_ALREADY_EXISTS'
                ? '既存のLive TTを確認しました。'
                : describeRepositoryError(result.error),
            })
      } else if (!result.ok && result.error.code !== 'LIVE_ALREADY_EXISTS') {
        setFeedback({ kind: 'error', message: describeRepositoryError(result.error) })
      } else {
        markCreationOutcomeUnknown()
      }
    } finally {
      if (componentMountedRef.current &&
        mutationPendingOwnerRef.current === operationId) {
        mutationPendingRef.current = false
        setMutationPending(false)
      }
    }
  }

  const setProgressEnabled = async (enabled: boolean) => {
    if (!live?.canManage) return
    const expectedScopeKey = activeScopeKeyRef.current
    const expectedLiveId = live.liveId
    const description = enabled ? 'Live進行を有効にしますか？' :
      'Live進行を無効にしますか？ 進行記録は保持されます。'
    if (!window.confirm(description)) return
    const current = getConfirmedMutationLive({
      expectedScopeKey,
      expectedLiveId,
      authorized: candidate => candidate.canManage &&
        candidate.isPublished !== enabled,
    })
    if (!current) return
    await runMutation(
      () => liveRepository.setPublication(
        current.liveId,
        current.managementRevision,
        enabled,
      ),
      enabled ? 'Live進行を有効にしました。' : 'Live進行を無効にしました。',
      undefined,
      candidate => candidate.isPublished === enabled &&
        BigInt(candidate.managementRevision) > BigInt(current.managementRevision),
    )
  }

  const transitionEntry = async (
    operation: 'start' | 'end',
    entry: LiveTimetableEntryView,
  ) => {
    if (!live || !selectedStage || !entry.sourceScheduleItemId || !mutationEnabled) return
    const expectedScopeKey = activeScopeKeyRef.current
    const expectedLiveId = live.liveId
    const expectedStageId = selectedStage.stageId
    const expectedSourceStageId = selectedStage.sourceStageId
    const expectedScheduleItemId = entry.sourceScheduleItemId
    const label = describeEntry(entry)
    const question = operation === 'start'
      ? `${label}${entry.kind === 'performance' ? 'の演奏' : ''}を開始しますか？`
      : `${label}${entry.kind === 'performance' ? 'の演奏' : ''}を終了しますか？`
    if (!window.confirm(question)) return
    const current = getConfirmedMutationLive({
      expectedScopeKey,
      expectedLiveId,
      authorized: candidate => {
        const stage = candidate.stages.find(item =>
          item.stageId === expectedStageId &&
          item.sourceStageId === expectedSourceStageId)
        if (!stage?.canOperate || !candidate.isPublished) return false
        const currentTarget = operation === 'start'
          ? getNextEntry(stage)
          : getCurrentEntry(stage)
        return currentTarget?.sourceScheduleItemId === expectedScheduleItemId &&
          currentTarget.status === (operation === 'start' ? 'pending' : 'in_progress')
      },
    })
    if (!current) return
    const currentStage = current.stages.find(item =>
      item.stageId === expectedStageId &&
      item.sourceStageId === expectedSourceStageId)
    if (!currentStage) return
    await runMutation(
      () => operation === 'start'
        ? liveRepository.startEntry(
            current.liveId,
            currentStage.sourceStageId ?? '',
            expectedScheduleItemId,
            currentStage.revision,
            current.projectionVersion,
          )
        : liveRepository.endEntry(
            current.liveId,
            currentStage.sourceStageId ?? '',
            expectedScheduleItemId,
            currentStage.revision,
            current.projectionVersion,
          ),
      operation === 'start' ? '開始を記録しました。' : '終了を記録しました。',
      undefined,
      candidate => {
        const stage = candidate.stages.find(item =>
          item.stageId === expectedStageId &&
          item.sourceStageId === expectedSourceStageId)
        const reconciledEntry = stage?.entries.find(item =>
          item.sourceScheduleItemId === expectedScheduleItemId)
        return stage !== undefined &&
          BigInt(stage.revision) > BigInt(currentStage.revision) &&
          (operation === 'start'
          ? reconciledEntry?.status === 'in_progress' &&
            reconciledEntry.actualStartedAt !== null
          : reconciledEntry?.status === 'completed' &&
            reconciledEntry.actualEndedAt !== null)
      },
    )
  }

  const changeOperator = async (
    stage: LiveTimetableStageView,
    userId: string,
    assign: boolean,
  ) => {
    if (!live?.canManage || !stage.sourceStageId) return
    const candidate = currentCandidates.find(item => item.userId === userId)
    if (assign && (currentCandidateLoading || currentCandidateError || !candidate)) {
      setCandidateError('担当候補が最新か確認できません。担当候補を再取得してください。')
      return
    }
    const actionLabel = assign ? '割り当て' : '解除'
    const expectedScopeKey = activeScopeKeyRef.current
    const expectedLiveId = live.liveId
    const expectedStageId = stage.stageId
    const expectedSourceStageId = stage.sourceStageId
    const targetLabel = describeLiveStageManagementTarget(stage, live.eventDays)
    if (!window.confirm(
      `${candidate?.displayName ?? 'この担当者'}を${targetLabel}から${actionLabel}しますか？`,
    )) return
    const current = getConfirmedMutationLive({
      expectedScopeKey,
      expectedLiveId,
      authorized: candidateLive => candidateLive.canManage &&
        candidateLive.stages.some(item => item.stageId === expectedStageId &&
          item.sourceStageId === expectedSourceStageId) &&
        (!assign || candidatesRef.current.some(item => item.userId === userId)),
    })
    if (!current) return
    await runMutation(
      () => liveRepository.setStageOperator(
        current.liveId,
        expectedSourceStageId,
        userId,
        assign,
        current.managementRevision,
        current.projectionVersion,
      ),
      assign ? '担当者を割り当てました。' : '担当者を解除しました。',
      result => {
        if (!result.ok && (
          result.error.code === 'OPERATOR_NOT_ELIGIBLE' ||
          result.error.code === 'OPERATOR_NOT_EDITOR'
        )) {
          invalidateCandidateRead(
            '割当先のWorkspace権限が変わりました。担当候補を再取得してください。',
          )
        }
      },
      candidateLive => BigInt(candidateLive.managementRevision) >
          BigInt(current.managementRevision) &&
        candidateLive.operators.some(operator =>
          operator.stageId === expectedStageId && operator.userId === userId) === assign,
    )
  }

  const closeLive = () => {
    if (mutationPendingRef.current) return
    window.location.hash = ''
  }

  const handleBeforeAccountAction = (
    action: RetainedEditorAccountAction,
  ): boolean => {
    if (mutationPendingRef.current) return false
    const allowed = onBeforeAccountAction?.(action) ?? true
    if (!allowed) {
      setFeedback({
        kind: 'error',
        message: '通常編集画面に未保存の編集があるか、編集状態を安全に確認できません。イベント一覧へ戻って編集内容を確認してください。',
      })
    }
    return allowed
  }

  if (initializing) {
    return <main className="live-operator-loading" aria-busy="true">Live TTを確認しています…</main>
  }

  if (!liveId) {
    return (
      <AppShell
        activeSection="events"
        onNavigate={() => closeLive()}
        navigationDisabled={mutationPending}
        onBeforeSignOut={() => handleBeforeAccountAction('sign-out')}
        onBeforeWorkspaceChange={() =>
          handleBeforeAccountAction('workspace-switch')}
      >
        <main className="live-operator-page">
          <button type="button" className="live-operator-back" onClick={closeLive}>
            ← イベント一覧へ
          </button>
          <section className="live-operator-empty" aria-labelledby="live-empty-title">
            <p className="live-operator-eyebrow">運営向け Live TT</p>
            <h1 id="live-empty-title">{savedEvent?.name ?? 'Live TT'}</h1>
            {feedback && (
              <p
                className={feedback.kind === 'error'
                  ? 'live-operator-alert'
                  : 'live-operator-feedback'}
                role={feedback.kind === 'error' ? 'alert' : 'status'}
              >
                {feedback.message}
              </p>
            )}
            {pageError
              ? <p role="alert">{pageError}</p>
              : <p>このEventのLive TTはまだ作成されていません。</p>}
            <p className="live-operator-source-warning">
              Cloudへ保存済みのTTからLive TTを作成します。未保存の変更は反映されません。
            </p>
            {cloud.membership.role === 'owner' ? (
              <button
                type="button"
                className="primary-button live-operator-primary-action"
                disabled={!savedEvent || mutationPending || creationOutcomeUnknown}
                onClick={() => void createProjection()}
              >
                {mutationPending ? '作成中…' : 'Live TTを作成'}
              </button>
            ) : (
              <p>作成はWorkspace ownerへ依頼してください。</p>
            )}
            {creationOutcomeUnknown && (
              <p role="alert">
                作成要求の結果が不明なため、重複送信を防ぐ目的で作成操作を停止しています。
                再確認で既存Liveが見つかるまで再作成しないでください。
              </p>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={mutationPending}
              onClick={() => void discover()}
            >
              Live TTの作成状況を再確認
            </button>
          </section>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell
      activeSection="events"
      onNavigate={() => closeLive()}
      navigationDisabled={mutationPending}
      onBeforeSignOut={() => handleBeforeAccountAction('sign-out')}
      onBeforeWorkspaceChange={() =>
        handleBeforeAccountAction('workspace-switch')}
    >
      <main className="live-operator-page" aria-labelledby="live-operator-title">
        <header className="live-operator-header">
          <button type="button" className="live-operator-back" onClick={closeLive}>
            ← イベント一覧へ
          </button>
          <div>
            <p className="live-operator-eyebrow">運営向け Live TT</p>
            <h1 id="live-operator-title">{live?.eventName ?? 'Live TT'}</h1>
          </div>
          <dl className="live-operator-connection" aria-label="同期状態">
            <div><dt>接続</dt><dd>{connectionLabels[connection]}</dd></div>
            <div><dt>最終同期</dt><dd>{lastSynchronizedAt
              ? formatLiveTimetableTimestamp(
                  new Date(lastSynchronizedAt).toISOString(),
                  live?.timeZone ?? 'UTC',
                )
              : '未同期'}</dd></div>
            <div><dt>状態</dt><dd>{stale ? '更新確認が必要' : '最新'}</dd></div>
          </dl>
        </header>

        {pageError && <p className="live-operator-alert" role="alert">{pageError}</p>}
        {feedback && (
          <p
            className={feedback.kind === 'error'
              ? 'live-operator-alert'
              : 'live-operator-feedback'}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
          >
            {feedback.message}
          </p>
        )}

        {!live ? (
          <section className="live-operator-loading" aria-busy="true">
            <p>認証済みLive状態を読み込んでいます…</p>
            <button type="button" onClick={() => void refresh('manual')}>再取得</button>
          </section>
        ) : (
          <>
            <section className="live-operator-controls" aria-label="Live TT表示対象">
              <label>
                開催日
                <select
                  value={effectiveDayId}
                  onChange={event => {
                    setSelectedDayId(event.target.value)
                    setSelectedStageId('')
                  }}
                >
                  {orderedDays.map(day => (
                      <option key={day.sourceEventDayId} value={day.sourceEventDayId}>
                        {day.date}{day.label ? ` ${day.label}` : ''}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Stage
                <select
                  value={selectedStage?.stageId ?? ''}
                  onChange={event => setSelectedStageId(event.target.value)}
                >
                  {dayStages.map(stage => (
                    <option key={stage.stageId} value={stage.stageId}>{stage.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={mutationPending}
                onClick={() => void refresh('manual')}
              >
                最新状態を取得
              </button>
            </section>

            <section className="live-operator-permissions" aria-label="Live TT権限">
              <div>
                <span>Workspace権限</span>
                <strong>{live.role}</strong>
              </div>
              <div>
                <span>選択Stageの操作</span>
                <strong>{selectedStage?.canOperate ? '許可' : '閲覧のみ'}</strong>
              </div>
              <div>
                <span>Live進行</span>
                <strong>{live.isPublished ? '有効' : '無効'}</strong>
              </div>
              {live.canManage && (
                <button
                  type="button"
                  className={live.isPublished ? 'secondary-button' : 'primary-button'}
                  disabled={mutationBlocked || stale || !navigator.onLine}
                  onClick={() => void setProgressEnabled(!live.isPublished)}
                >
                  {live.isPublished ? 'Live進行を無効化' : 'Live進行を有効化'}
                </button>
              )}
              <p>匿名一般公開はこの画面から有効化されません。</p>
            </section>

            {selectedDay && selectedStage ? (
              <>
                <section className="live-operator-stage" aria-labelledby="live-stage-title">
                  <header>
                    <div>
                      <p>{selectedDay.date}{selectedDay.label ? ` ${selectedDay.label}` : ''}</p>
                      <h2 id="live-stage-title">{selectedStage.name}</h2>
                    </div>
                    <span className={`live-operator-status live-operator-status--${selectedStage.progressStatus}`}>
                      {progressLabels[selectedStage.progressStatus]}
                    </span>
                  </header>
                  <p className="live-operator-stage-time">
                    予定 {selectedStage.plannedStartTime}〜{selectedStage.plannedEndTime ?? '未定'}
                  </p>
                  <div className="live-operator-now-next">
                    <LiveEntrySummary title="現在" entry={currentEntry} timeZone={live.timeZone} />
                    <LiveEntrySummary title="次" entry={nextEntry} timeZone={live.timeZone} />
                  </div>
                  <div className="live-operator-actions">
                    {currentEntry ? (
                      <button
                        type="button"
                        className="live-operator-action live-operator-action--end"
                        disabled={!mutationEnabled}
                        onClick={() => void transitionEntry('end', currentEntry)}
                      >
                        {mutationPending ? '確認中…' : `${describeEntry(currentEntry)}を終了`}
                      </button>
                    ) : nextEntry ? (
                      <button
                        type="button"
                        className="live-operator-action live-operator-action--start"
                        disabled={!mutationEnabled}
                        onClick={() => void transitionEntry('start', nextEntry)}
                      >
                        {mutationPending ? '確認中…' : `${describeEntry(nextEntry)}を開始`}
                      </button>
                    ) : (
                      <p>このStageの進行項目はすべて終了しました。</p>
                    )}
                    {stale && <p role="alert">最新状態を確認できないため操作を停止しています。</p>}
                    {!navigator.onLine && <p role="alert">オフライン中の操作・予約送信はできません。</p>}
                  </div>
                </section>

                <section className="live-operator-list" aria-labelledby="live-list-title">
                  <h2 id="live-list-title">進行一覧</h2>
                  <ol>
                    {selectedStage.entries.map(entry => (
                      <li key={entry.position} data-status={entry.status}>
                        <span className="live-operator-list__position">{entry.position + 1}</span>
                        <div>
                          <strong>{describeEntry(entry)}</strong>
                          <span>
                            {formatMinuteAsLocalTime(entry.plannedStartMinute)}〜
                            {formatMinuteAsLocalTime(entry.plannedEndMinute)}
                          </span>
                        </div>
                        <span className="live-operator-list__actual">
                          {entry.status === 'pending' ? '未開始' :
                            entry.status === 'in_progress'
                              ? `開始 ${formatLiveTimetableTimestamp(entry.actualStartedAt, live.timeZone)}`
                              : `終了 ${formatLiveTimetableTimestamp(entry.actualEndedAt, live.timeZone)}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            ) : <p role="status">この開催日にStageはありません。</p>}

            {live.canManage && (
              <section className="live-operator-management" aria-labelledby="operator-management-title">
                <h2 id="operator-management-title">Stage担当者</h2>
                <p>現在のeditor/viewerだけを、Stage単位で割り当てます。</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={currentCandidateLoading || mutationPending}
                  onClick={() => void refreshCandidates()}
                >
                  {currentCandidateLoading ? '担当候補を取得中…' : '担当候補を再取得'}
                </button>
                {currentCandidateError && <p role="alert">{currentCandidateError}</p>}
                {!currentCandidateLoading && !currentCandidateError &&
                  currentCandidates.length === 0 && (
                  <p role="status">割り当て可能な担当候補はいません。</p>
                )}
                {orderedManagementStages.map(stage => {
                  const assignments = live.operators.filter(operator =>
                    operator.stageId === stage.stageId)
                  const selectedCandidate = resolveLiveOperatorCandidateSelection(
                    selectedCandidateByStage[stage.stageId ?? ''],
                    currentCandidates,
                  )
                  return (
                    <article key={stage.stageId} className="live-operator-management__stage">
                      <h3>{describeLiveStageManagementTarget(stage, live.eventDays)}</h3>
                      {assignments.length > 0 ? (
                        <ul>
                          {assignments.map(assignment => {
                            const candidate = currentCandidates.find(item =>
                              item.userId === assignment.userId)
                            return (
                              <li key={assignment.userId}>
                                <span>{candidate?.displayName ?? `現在の候補外 (${assignment.userId.slice(0, 8)}…)`}</span>
                                {candidate && (
                                  <button
                                    type="button"
                                    disabled={mutationBlocked || stale}
                                    onClick={() => void changeOperator(stage, assignment.userId, true)}
                                  >
                                    現在の権限で再割当
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={mutationBlocked || stale}
                                  onClick={() => void changeOperator(stage, assignment.userId, false)}
                                >
                                  解除
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      ) : <p>担当者なし</p>}
                      <div className="live-operator-management__assign">
                        <label>
                          担当候補
                          <select
                            value={selectedCandidate}
                            disabled={currentCandidateLoading || currentCandidateError !== '' ||
                              currentCandidates.length === 0 || mutationPending}
                            onChange={event => setSelectedCandidateByStage(current => ({
                              ...current,
                              [stage.stageId ?? '']: event.target.value,
                            }))}
                          >
                            {currentCandidates.map(candidate => (
                              <option key={candidate.userId} value={candidate.userId}>
                                {candidate.displayName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="secondary-button"
                            disabled={!selectedCandidate || currentCandidateLoading ||
                              currentCandidateError !== '' || mutationBlocked || stale}
                          onClick={() => void changeOperator(stage, selectedCandidate, true)}
                        >
                          割り当て
                        </button>
                      </div>
                    </article>
                  )
                })}
              </section>
            )}
          </>
        )}
      </main>
    </AppShell>
  )
}

