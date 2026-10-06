import type {
  DutyAssignment,
  DutyType,
  EventBand,
  EventDayId,
  PaAssignment,
  ScheduleItem,
  Stage,
  StageId,
  TimetableLock,
  TimetableOrderConstraint,
} from '../domain/models'

export const TIMETABLE_HISTORY_LIMIT = 50

export interface TimetableEditSnapshot {
  stages: Stage[]
  eventBands: EventBand[]
  scheduleItems: ScheduleItem[]
  paAssignments: PaAssignment[]
  dutyTypes: DutyType[]
  dutyAssignments: DutyAssignment[]
  timetableLocks: TimetableLock[]
  timetableOrderConstraints: TimetableOrderConstraint[]
}

export interface TimetableHistoryContext {
  eventDayId?: EventDayId
  stageId?: StageId
}

export interface TimetableHistoryEntry {
  snapshot: TimetableEditSnapshot
  context: TimetableHistoryContext
}

export interface TimetableHistoryState {
  past: TimetableHistoryEntry[]
  present: TimetableHistoryEntry
  future: TimetableHistoryEntry[]
}

export interface TimetableHistoryTransition {
  changed: boolean
  state: TimetableHistoryState
  entry: TimetableHistoryEntry
}

export const cloneTimetableEditSnapshot = (
  snapshot: TimetableEditSnapshot,
): TimetableEditSnapshot => structuredClone(snapshot)

export const cloneTimetableHistoryEntry = (
  entry: TimetableHistoryEntry,
): TimetableHistoryEntry => ({
  snapshot: cloneTimetableEditSnapshot(entry.snapshot),
  context: { ...entry.context },
})

export const areTimetableEditSnapshotsEqual = (
  left: TimetableEditSnapshot,
  right: TimetableEditSnapshot,
): boolean => JSON.stringify(left) === JSON.stringify(right)

export const createTimetableHistoryState = (
  initialEntry: TimetableHistoryEntry,
): TimetableHistoryState => ({
  past: [],
  present: cloneTimetableHistoryEntry(initialEntry),
  future: [],
})

export const recordTimetableHistory = (
  state: TimetableHistoryState,
  nextEntry: TimetableHistoryEntry,
): TimetableHistoryState => {
  if (areTimetableEditSnapshotsEqual(state.present.snapshot, nextEntry.snapshot)) {
    return state
  }
  const operationContext = { ...nextEntry.context }
  const previousEntry = cloneTimetableHistoryEntry({
    snapshot: state.present.snapshot,
    context: operationContext,
  })
  return {
    past: [...state.past, previousEntry].slice(-TIMETABLE_HISTORY_LIMIT),
    present: cloneTimetableHistoryEntry(nextEntry),
    future: [],
  }
}

export const undoTimetableHistory = (
  state: TimetableHistoryState,
): TimetableHistoryTransition => {
  const previous = state.past.at(-1)
  if (!previous) {
    return { changed: false, state, entry: state.present }
  }
  const nextState = {
    past: state.past.slice(0, -1),
    present: cloneTimetableHistoryEntry(previous),
    future: [...state.future, cloneTimetableHistoryEntry({
      snapshot: state.present.snapshot,
      context: previous.context,
    })],
  }
  return {
    changed: true,
    state: nextState,
    entry: cloneTimetableHistoryEntry(nextState.present),
  }
}

export const redoTimetableHistory = (
  state: TimetableHistoryState,
): TimetableHistoryTransition => {
  const next = state.future.at(-1)
  if (!next) {
    return { changed: false, state, entry: state.present }
  }
  const nextState = {
    past: [...state.past, cloneTimetableHistoryEntry({
      snapshot: state.present.snapshot,
      context: next.context,
    })]
      .slice(-TIMETABLE_HISTORY_LIMIT),
    present: cloneTimetableHistoryEntry(next),
    future: state.future.slice(0, -1),
  }
  return {
    changed: true,
    state: nextState,
    entry: cloneTimetableHistoryEntry(nextState.present),
  }
}

export interface TimetableHistoryController {
  getState: () => TimetableHistoryState | null
  subscribe: (listener: () => void) => () => void
  reset: (entry?: TimetableHistoryEntry) => void
  record: (entry: TimetableHistoryEntry) => void
  undo: () => TimetableHistoryTransition | undefined
  redo: () => TimetableHistoryTransition | undefined
}

export const createTimetableHistoryController = (): TimetableHistoryController => {
  let state: TimetableHistoryState | null = null
  const listeners = new Set<() => void>()
  const publish = (nextState: TimetableHistoryState | null) => {
    if (nextState === state) return
    state = nextState
    listeners.forEach(listener => listener())
  }
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: (entry) => publish(entry ? createTimetableHistoryState(entry) : null),
    record: (entry) => {
      if (!state) {
        publish(createTimetableHistoryState(entry))
        return
      }
      publish(recordTimetableHistory(state, entry))
    },
    undo: () => {
      if (!state) return undefined
      const transition = undoTimetableHistory(state)
      if (transition.changed) publish(transition.state)
      return transition
    },
    redo: () => {
      if (!state) return undefined
      const transition = redoTimetableHistory(state)
      if (transition.changed) publish(transition.state)
      return transition
    },
  }
}
