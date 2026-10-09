import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import { createEventBandConditionsDraft } from '../src/domain/eventBandConditions.ts'
import { createEventBandSettingsDraft } from '../src/domain/eventBandSettings.ts'
import { createEventBasicInfoDraft } from '../src/domain/eventBasicInfo.ts'
import { createEventMemberSettingsDraft } from '../src/domain/eventMemberSettings.ts'
import { createEventStageSettingsDraft } from '../src/domain/eventStageSettings.ts'
import {
  getActiveEventEditorDraftBlock,
  hasSemanticDraftChanges,
  runEventEditorCloudSaveGuarded,
} from '../src/ui/eventEditorDraftGuard.ts'

const createHandle = (state) => ({
  hasUnsavedChanges: () => hasSemanticDraftChanges(state.current, state.saved) ||
    Boolean(state.nestedDirty),
  reportUnsavedChanges: () => {
    state.reportCount += 1
  },
})

const demoData = createDemoData()
const event = demoData.events.find(candidate =>
  demoData.eventDays.some(eventDay =>
    eventDay.eventId === candidate.id &&
    demoData.stages.some(stage => stage.eventDayId === eventDay.id),
  ) &&
  demoData.eventMembers.some(eventMember => eventMember.eventId === candidate.id) &&
  demoData.eventBands.some(eventBand => eventBand.eventId === candidate.id),
)
assert.ok(event)
const eventDays = demoData.eventDays.filter(eventDay => eventDay.eventId === event.id)

const cases = [
  [1, 'イベント基本情報', createEventBasicInfoDraft(event, eventDays),
    draft => ({ ...draft, name: 'Event B' })],
  [2, 'ステージ・セクション', createEventStageSettingsDraft(
    event,
    eventDays,
    demoData.stages,
    demoData.sections,
  ), draft => ({
    ...draft,
    stages: [{ ...draft.stages[0], name: `${draft.stages[0].name} changed` },
      ...draft.stages.slice(1)],
  })],
  [3, 'イベントメンバー', createEventMemberSettingsDraft(
    event,
    eventDays,
    demoData.eventMembers,
    demoData.eventMemberDays,
  ), draft => ({ ...draft, members: draft.members.slice(1) })],
  [4, '出演バンド', createEventBandSettingsDraft(event, demoData.eventBands),
    draft => ({
      ...draft,
      items: [{ ...draft.items[0], name: `${draft.items[0].name} changed` },
        ...draft.items.slice(1)],
    })],
  [5, '出演条件', createEventBandConditionsDraft(event, demoData.eventBands),
    draft => ({
      ...draft,
      items: [{
        ...draft.items[0],
        preferredTimeRange: {
          ...draft.items[0].preferredTimeRange,
          from: draft.items[0].preferredTimeRange.from === '00:00'
            ? '00:01'
            : '00:00',
        },
      }, ...draft.items.slice(1)],
    })],
]

test('Step 1〜5は未保存draftでCloud requestを止め、commit後は最新stateを送る', () => {
  for (const [step, label, saved, change] of cases) {
    const state = {
      saved: structuredClone(saved),
      current: structuredClone(saved),
      reportCount: 0,
    }
    const handle = createHandle(state)
    const requests = []
    const blocks = []

    assert.equal(getActiveEventEditorDraftBlock({
      activeStep: step,
      handles: { [step]: handle },
    }), undefined, `${label}: initial clean`)

    state.current = change(structuredClone(state.current))
    const blocked = runEventEditorCloudSaveGuarded({
      activeStep: step,
      handles: { [step]: handle },
      onBlocked: block => blocks.push(block),
      onSave: () => requests.push(structuredClone(state.saved)),
    })
    assert.equal(blocked, false, label)
    assert.equal(requests.length, 0, label)
    assert.equal(blocks[0].label, label)
    assert.match(blocks[0].message, new RegExp(label))
    assert.equal(state.reportCount, 1, label)

    state.saved = structuredClone(state.current)
    const savedResult = runEventEditorCloudSaveGuarded({
      activeStep: step,
      handles: { [step]: handle },
      onBlocked: block => blocks.push(block),
      onSave: () => requests.push(structuredClone(state.saved)),
    })
    assert.equal(savedResult, true, label)
    assert.equal(requests.length, 1, label)
    assert.deepEqual(requests[0], state.current, label)
  }
})

test('invalid入力・追加・削除・順序変更・nested dialog変更もdirtyを維持する', () => {
  const saved = {
    items: [
      { draftId: 'a', id: 'a', name: 'A' },
      { draftId: 'b', id: 'b', name: 'B' },
    ],
  }
  for (const current of [
    { items: [{ ...saved.items[0], name: '' }, saved.items[1]] },
    { items: [...saved.items, { draftId: 'c', id: 'c', name: 'C' }] },
    { items: [saved.items[0]] },
    { items: [saved.items[1], saved.items[0]] },
    { ...saved, invalidNumber: Number.NaN },
  ]) {
    assert.equal(hasSemanticDraftChanges(current, saved), true)
  }

  const state = {
    saved,
    current: structuredClone(saved),
    nestedDirty: true,
    reportCount: 0,
  }
  assert.equal(createHandle(state).hasUnsavedChanges(), true)
})

test('元へ戻す・draftId/object identityだけの差はcleanで、active Step外へdirtyは漏れない', () => {
  const saved = { items: [{ draftId: 'old-key', id: 'a', name: 'A' }] }
  const current = { items: [{ draftId: 'new-key', id: 'a', name: 'A' }] }
  assert.equal(hasSemanticDraftChanges(current, saved), false)
  assert.equal(hasSemanticDraftChanges(structuredClone(saved), saved), false)

  const dirtyState = {
    saved: { value: 'saved' },
    current: { value: 'dirty' },
    reportCount: 0,
  }
  assert.equal(getActiveEventEditorDraftBlock({
    activeStep: 3,
    handles: { 2: createHandle(dirtyState) },
  }), undefined)
})

test('AppはStep 1〜5のproduction handleをCloud保存と遷移guardへ接続する', async () => {
  const [appSource, stageSource, memberSource, bandSource, conditionSource] =
    await Promise.all([
      readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventStageSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventMemberSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventBandSettings.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/EventBandConditions.tsx', import.meta.url), 'utf8'),
    ])

  for (const refName of [
    'eventBasicInfoRef',
    'eventStageSettingsRef',
    'eventMemberSettingsRef',
    'eventBandSettingsRef',
    'eventBandConditionsRef',
  ]) {
    assert.match(appSource, new RegExp(`ref=\\{${refName}\\}`), refName)
  }
  assert.match(appSource, /runEventEditorCloudSaveGuarded\(/)
  assert.match(appSource, /getActiveEventEditorDraftBlock\(/)
  for (const source of [stageSource, memberSource, bandSource, conditionSource]) {
    assert.match(source, /useImperativeHandle\(ref/)
    assert.match(source, /setSavedDraft\(/)
  }
})
