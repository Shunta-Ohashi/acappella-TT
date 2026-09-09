import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canDeleteStage,
  createEventStageSettingsUpdate,
  getStageErrorEventDayIds,
  isValidStageTimeRange,
  validateEventStageSettingsDraft,
} from '../src/domain/eventStageSettings.ts'

const event = {
  id: 'event-1',
  name: '学園祭',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
}

const eventDays = [
  { id: 'day-1', eventId: event.id, date: '2027-11-06', order: 0 },
  { id: 'day-2', eventId: event.id, date: '2027-11-08', order: 1 },
]

const existingStage = {
  id: 'stage-existing',
  eventDayId: 'day-1',
  name: '旧Stage名',
  location: '講義室101',
  order: 0,
  plannedStartTime: '10:00',
  plannedEndTime: '17:00',
  transitionMinutes: 3,
}

const validStageDraft = (overrides = {}) => ({
  draftId: 'draft-stage',
  eventDayId: 'day-1',
  name: 'Main Stage',
  location: '',
  plannedStartTime: '10:00',
  endMode: 'automatic',
  plannedEndTime: '',
  transitionMode: 'event-default',
  transitionMinutes: '',
  ...overrides,
})

const noReferences = { sections: [], scheduleItems: [], eventBands: [] }

test('Stage開始時刻は自動終了または固定終了より前の場合だけ変更可能にする', () => {
  assert.equal(isValidStageTimeRange('16:59'), true)
  assert.equal(isValidStageTimeRange('16:59', '17:00'), true)
  assert.equal(isValidStageTimeRange('17:00', '17:00'), false)
  assert.equal(isValidStageTimeRange('18:00', '17:00'), false)
  assert.equal(isValidStageTimeRange('24:00', '17:00'), false)
})

test('既存Stage IDを維持し、新規Stageを対応するEventDayへ生成する', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: {
      defaultTransitionMinutes: '4',
      stages: [
        validStageDraft({
          draftId: 'existing-stage-draft',
          stageId: existingStage.id,
          name: ' Main Stage ',
          location: ' 体育館 ',
          plannedStartTime: '09:30',
          endMode: 'fixed',
          plannedEndTime: '18:00',
          transitionMode: 'stage-specific',
          transitionMinutes: '5',
        }),
        validStageDraft({
          draftId: 'new-stage-draft',
          eventDayId: 'day-2',
          name: 'Sub Stage',
        }),
      ],
    },
    newStageIds: ['stage-new'],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.event.defaultTransitionMinutes, 4)
  assert.deepEqual(result.stages, [
    {
      ...existingStage,
      name: 'Main Stage',
      location: '体育館',
      plannedStartTime: '09:30',
      plannedEndTime: '18:00',
      transitionMinutes: 5,
    },
    {
      id: 'stage-new',
      eventDayId: 'day-2',
      name: 'Sub Stage',
      location: undefined,
      order: 0,
      plannedStartTime: '10:00',
      plannedEndTime: undefined,
      transitionMinutes: undefined,
    },
  ])
})

test('空のStage名と空または不正な開始時刻を拒否する', () => {
  const emptyErrors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '2',
    stages: [validStageDraft({ name: '   ', plannedStartTime: '' })],
  })

  assert.equal(
    emptyErrors.stages['draft-stage'].name,
    'Stage名を入力してください。',
  )
  assert.equal(
    emptyErrors.stages['draft-stage'].plannedStartTime,
    '有効な開始時刻を入力してください。',
  )

  const invalidErrors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '2',
    stages: [validStageDraft({ plannedStartTime: '24:00' })],
  })
  assert.equal(
    invalidErrors.stages['draft-stage'].plannedStartTime,
    '有効な開始時刻を入力してください。',
  )
})

test('固定終了時刻は開始時刻より後の場合だけ許可する', () => {
  const validErrors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '2',
    stages: [validStageDraft({
      endMode: 'fixed',
      plannedEndTime: '10:01',
    })],
  })
  assert.equal(validErrors.stages['draft-stage'], undefined)

  for (const plannedEndTime of ['10:00', '09:59']) {
    const errors = validateEventStageSettingsDraft({
      defaultTransitionMinutes: '2',
      stages: [validStageDraft({
        endMode: 'fixed',
        plannedEndTime,
      })],
    })
    assert.equal(
      errors.stages['draft-stage'].plannedEndTime,
      '終了時刻は開始時刻より後にしてください。',
    )
  }
})

test('Stage errorがある開催日をdraft順で特定する', () => {
  const stageDrafts = [
    validStageDraft({ draftId: 'day-1-stage', eventDayId: 'day-1' }),
    validStageDraft({
      draftId: 'day-2-stage',
      eventDayId: 'day-2',
      name: '',
    }),
  ]
  const errors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '2',
    stages: stageDrafts,
  })

  assert.deepEqual(getStageErrorEventDayIds(stageDrafts, errors), ['day-2'])
})

test('終了時刻を自動にすると既存の固定終了時刻を削除する', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: {
      defaultTransitionMinutes: '2',
      stages: [validStageDraft({
        stageId: existingStage.id,
        plannedEndTime: existingStage.plannedEndTime,
      })],
    },
    newStageIds: [],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.stages[0].plannedEndTime, undefined)
})

test('Event共通とStage固有の転換時間は0以上の整数だけ許可する', () => {
  const commonErrors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '-1',
    stages: [],
  })
  assert.equal(
    commonErrors.defaultTransitionMinutes,
    '0以上の整数を入力してください。',
  )

  const stageErrors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '0',
    stages: [validStageDraft({
      transitionMode: 'stage-specific',
      transitionMinutes: '1.5',
    })],
  })
  assert.equal(
    stageErrors.stages['draft-stage'].transitionMinutes,
    '0以上の整数を入力してください。',
  )

  const validErrors = validateEventStageSettingsDraft({
    defaultTransitionMinutes: '0',
    stages: [validStageDraft({
      transitionMode: 'stage-specific',
      transitionMinutes: '0',
    })],
  })
  assert.equal(validErrors.defaultTransitionMinutes, undefined)
  assert.equal(validErrors.stages['draft-stage'], undefined)
})

test('ScheduleItem、Section、または固定配置から参照されるStageは削除不可にする', () => {
  assert.equal(canDeleteStage(existingStage.id, noReferences), true)
  assert.equal(canDeleteStage(existingStage.id, {
    sections: [],
    scheduleItems: [{ stageId: existingStage.id }],
    eventBands: [],
  }), false)
  assert.equal(canDeleteStage(existingStage.id, {
    sections: [{ stageId: existingStage.id }],
    scheduleItems: [],
    eventBands: [],
  }), false)
  assert.equal(canDeleteStage(existingStage.id, {
    sections: [],
    scheduleItems: [],
    eventBands: [{ fixedPlacement: { stageId: existingStage.id } }],
  }), false)
  assert.equal(canDeleteStage(existingStage.id, {
    sections: [],
    scheduleItems: [],
    eventBands: [{ fixedPlacement: { stageId: 'another-stage' } }],
  }), true)
})

test('未参照Stageは削除でき、参照中Stageは保存処理でも削除をブロックする', () => {
  const removable = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: { defaultTransitionMinutes: '2', stages: [] },
    newStageIds: [],
    ...noReferences,
  })
  assert.equal(removable.ok, true)
  if (removable.ok) assert.deepEqual(removable.stages, [])

  const blocked = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: { defaultTransitionMinutes: '2', stages: [] },
    newStageIds: [],
    sections: [],
    scheduleItems: [{ stageId: existingStage.id }],
    eventBands: [],
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.errors.form ?? '', /削除できません/)
})

test('固定配置から参照中のStageは保存処理でも削除をブロックする', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: { defaultTransitionMinutes: '2', stages: [] },
    newStageIds: [],
    sections: [],
    scheduleItems: [],
    eventBands: [{ fixedPlacement: { stageId: existingStage.id } }],
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.errors.form ?? '', /固定配置/)
  }
})
