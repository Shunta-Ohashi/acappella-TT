export interface EventEditorDraftHandle {
  hasUnsavedChanges: () => boolean
  reportUnsavedChanges: () => void
}

export type EventEditorDraftStep = 1 | 2 | 3 | 4 | 5

export interface EventEditorDraftBlock {
  step: EventEditorDraftStep
  label: string
  message: string
  handle: EventEditorDraftHandle
}

const DRAFT_STEP_COPY: Record<
  EventEditorDraftStep,
  Pick<EventEditorDraftBlock, 'label' | 'message'>
> = {
  1: {
    label: 'イベント基本情報',
    message: 'イベント基本情報に未保存の変更があります。先に基本情報を保存してから「Cloudへ保存」を実行してください。',
  },
  2: {
    label: 'ステージ・セクション',
    message: 'ステージ・セクションに未保存の変更があります。先にこの画面を保存してから「Cloudへ保存」を実行してください。',
  },
  3: {
    label: 'イベントメンバー',
    message: 'イベントメンバーに未保存の変更があります。先にこの画面を保存してから「Cloudへ保存」を実行してください。',
  },
  4: {
    label: '出演バンド',
    message: '出演バンドに未保存の変更があります。先にこの画面を保存してから「Cloudへ保存」を実行してください。',
  },
  5: {
    label: '出演条件',
    message: '出演条件に未保存の変更があります。先にこの画面を保存してから「Cloudへ保存」を実行してください。',
  },
}

const canonicalizeDraftValue = (
  value: unknown,
  propertyName?: string,
): unknown => {
  if (propertyName === 'draftId') return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { nonFiniteNumber: String(value) }
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeDraftValue(item))
  }
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => key !== 'draftId' && item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalizeDraftValue(item, key)]),
  )
}

export const hasSemanticDraftChanges = (
  current: unknown,
  saved: unknown,
): boolean => JSON.stringify(canonicalizeDraftValue(current)) !==
  JSON.stringify(canonicalizeDraftValue(saved))

export const getActiveEventEditorDraftBlock = ({
  activeStep,
  handles,
}: {
  activeStep: number
  handles: Partial<Record<EventEditorDraftStep, EventEditorDraftHandle | null>>
}): EventEditorDraftBlock | undefined => {
  if (!(activeStep in DRAFT_STEP_COPY)) return undefined
  const step = activeStep as EventEditorDraftStep
  const handle = handles[step]
  if (!handle?.hasUnsavedChanges()) return undefined
  return { step, ...DRAFT_STEP_COPY[step], handle }
}

export const runEventEditorCloudSaveGuarded = ({
  activeStep,
  handles,
  onBlocked,
  onSave,
}: {
  activeStep: number
  handles: Partial<Record<EventEditorDraftStep, EventEditorDraftHandle | null>>
  onBlocked: (block: EventEditorDraftBlock) => void
  onSave: () => void
}): boolean => {
  const block = getActiveEventEditorDraftBlock({ activeStep, handles })
  if (block) {
    block.handle.reportUnsavedChanges()
    onBlocked(block)
    return false
  }
  onSave()
  return true
}
