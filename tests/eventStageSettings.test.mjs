import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canAddFirstSection,
  canDeleteSection,
  canDeleteStage,
  createEventStageSettingsDraft,
  createEventStageSettingsUpdate,
  getEventStageSettingsErrorEventDayIds,
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
  performanceSlotMinutes: [5, 10, 15],
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

const secondStage = {
  id: 'stage-second',
  eventDayId: 'day-1',
  name: 'Sub Stage',
  order: 1,
  plannedStartTime: '09:00',
}

const existingSection = {
  id: 'section-existing',
  stageId: existingStage.id,
  name: '旧1部',
  order: 4,
  plannedStartTime: '10:30',
  plannedEndTime: '12:00',
  notes: '既存メモ',
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

const validSectionDraft = (overrides = {}) => ({
  draftId: 'draft-section',
  stageDraftId: 'draft-stage',
  name: '1部',
  startMode: 'automatic',
  plannedStartTime: '',
  endMode: 'automatic',
  plannedEndTime: '',
  ...overrides,
})

const settingsDraft = ({
  defaultTransitionMinutes = '2',
  performanceSlotMinutes = event.performanceSlotMinutes,
  stages = [validStageDraft()],
  sections = [],
} = {}) => ({
  defaultTransitionMinutes,
  performanceSlotMinutes,
  stages,
  sections,
})

const noReferences = { sections: [], scheduleItems: [], eventBands: [] }

test('Stage開始時刻は自動終了または固定終了より前の場合だけ変更可能にする', () => {
  assert.equal(isValidStageTimeRange('16:59'), true)
  assert.equal(isValidStageTimeRange('16:59', '17:00'), true)
  assert.equal(isValidStageTimeRange('17:00', '17:00'), false)
  assert.equal(isValidStageTimeRange('18:00', '17:00'), false)
  assert.equal(isValidStageTimeRange('24:00', '17:00'), false)
})

test('出演枠はStep 2 draftで編集し、保存時だけEventへ昇順で反映する', () => {
  const draft = createEventStageSettingsDraft(event, eventDays, [], [])
  draft.performanceSlotMinutes = [15, 7, 10, 5]

  assert.deepEqual(event.performanceSlotMinutes, [5, 10, 15])

  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [],
    sections: [],
    draft,
    newStageIds: [],
    newSectionIds: [],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.event.performanceSlotMinutes, [5, 7, 10, 15])
  assert.deepEqual(event.performanceSlotMinutes, [5, 10, 15])
})

test('Step 2は空・重複・不正な出演枠optionを拒否する', () => {
  for (const performanceSlotMinutes of [
    [],
    [5, 10, 10],
    [0, 5],
    [-1, 5],
    [1.5, 5],
    [Number.POSITIVE_INFINITY, 5],
  ]) {
    const errors = validateEventStageSettingsDraft(settingsDraft({
      performanceSlotMinutes,
      stages: [],
    }))
    assert.ok(errors.performanceSlotMinutes)
  }
})

test('既存Stage IDを維持し、新規Stageを対応するEventDayへ生成する', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: settingsDraft({
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
    }),
    newStageIds: ['stage-new'],
    newSectionIds: [],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.event.defaultTransitionMinutes, 4)
  assert.deepEqual(result.event.performanceSlotMinutes, [5, 10, 15])
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
  assert.deepEqual(result.sections, [])
})

test('空のStage名と空または不正な開始時刻を拒否する', () => {
  const emptyErrors = validateEventStageSettingsDraft(settingsDraft({
    stages: [validStageDraft({ name: '   ', plannedStartTime: '' })],
  }))

  assert.equal(
    emptyErrors.stages['draft-stage'].name,
    'Stage名を入力してください。',
  )
  assert.equal(
    emptyErrors.stages['draft-stage'].plannedStartTime,
    '有効な開始時刻を入力してください。',
  )

  const invalidErrors = validateEventStageSettingsDraft(settingsDraft({
    stages: [validStageDraft({ plannedStartTime: '24:00' })],
  }))
  assert.equal(
    invalidErrors.stages['draft-stage'].plannedStartTime,
    '有効な開始時刻を入力してください。',
  )
})

test('固定終了時刻は開始時刻より後の場合だけ許可する', () => {
  const validErrors = validateEventStageSettingsDraft(settingsDraft({
    stages: [validStageDraft({
      endMode: 'fixed',
      plannedEndTime: '10:01',
    })],
  }))
  assert.equal(validErrors.stages['draft-stage'], undefined)

  for (const plannedEndTime of ['10:00', '09:59']) {
    const errors = validateEventStageSettingsDraft(settingsDraft({
      stages: [validStageDraft({
        endMode: 'fixed',
        plannedEndTime,
      })],
    }))
    assert.equal(
      errors.stages['draft-stage'].plannedEndTime,
      '終了時刻は開始時刻より後にしてください。',
    )
  }
})

test('StageまたはSection errorがある開催日をdraft順で特定する', () => {
  const stageDrafts = [
    validStageDraft({ draftId: 'day-1-stage', eventDayId: 'day-1' }),
    validStageDraft({ draftId: 'day-2-stage', eventDayId: 'day-2' }),
  ]
  const draft = settingsDraft({
    stages: stageDrafts,
    sections: [validSectionDraft({
      draftId: 'day-2-section',
      stageDraftId: 'day-2-stage',
      name: '',
    })],
  })
  const errors = validateEventStageSettingsDraft(draft)

  assert.deepEqual(
    getEventStageSettingsErrorEventDayIds(draft, errors),
    ['day-2'],
  )
})

test('終了時刻を自動にすると既存の固定終了時刻を削除する', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: settingsDraft({
      stages: [validStageDraft({
        stageId: existingStage.id,
        plannedEndTime: existingStage.plannedEndTime,
      })],
    }),
    newStageIds: [],
    newSectionIds: [],
    ...noReferences,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.stages[0].plannedEndTime, undefined)
})

test('Event共通とStage固有の転換時間は0以上の整数だけ許可する', () => {
  const commonErrors = validateEventStageSettingsDraft(settingsDraft({
    defaultTransitionMinutes: '-1',
    stages: [],
  }))
  assert.equal(
    commonErrors.defaultTransitionMinutes,
    '0以上の整数を入力してください。',
  )

  const stageErrors = validateEventStageSettingsDraft(settingsDraft({
    defaultTransitionMinutes: '0',
    stages: [validStageDraft({
      transitionMode: 'stage-specific',
      transitionMinutes: '1.5',
    })],
  }))
  assert.equal(
    stageErrors.stages['draft-stage'].transitionMinutes,
    '0以上の整数を入力してください。',
  )

  const validErrors = validateEventStageSettingsDraft(settingsDraft({
    defaultTransitionMinutes: '0',
    stages: [validStageDraft({
      transitionMode: 'stage-specific',
      transitionMinutes: '0',
    })],
  }))
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
    draft: settingsDraft({ stages: [] }),
    newStageIds: [],
    newSectionIds: [],
    ...noReferences,
  })
  assert.equal(removable.ok, true)
  if (removable.ok) assert.deepEqual(removable.stages, [])

  const blocked = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    draft: settingsDraft({ stages: [] }),
    newStageIds: [],
    newSectionIds: [],
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
    draft: settingsDraft({ stages: [] }),
    newStageIds: [],
    newSectionIds: [],
    sections: [],
    scheduleItems: [],
    eventBands: [{ fixedPlacement: { stageId: existingStage.id } }],
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.form ?? '', /固定配置/)
})

test('Section draftへ既存Sectionと自動・固定時刻を反映する', () => {
  const draft = createEventStageSettingsDraft(
    event,
    eventDays,
    [existingStage],
    [existingSection],
  )

  assert.deepEqual(draft.sections, [{
    draftId: `section-${existingSection.id}`,
    sectionId: existingSection.id,
    stageDraftId: `stage-${existingStage.id}`,
    name: existingSection.name,
    startMode: 'fixed',
    plannedStartTime: '10:30',
    endMode: 'fixed',
    plannedEndTime: '12:00',
  }])
})

test('Section名と固定時刻を検証し、自動時刻では入力値を要求しない', () => {
  const automaticErrors = validateEventStageSettingsDraft(settingsDraft({
    sections: [validSectionDraft({
      plannedStartTime: 'invalid',
      plannedEndTime: 'invalid',
    })],
  }))
  assert.equal(automaticErrors.sections['draft-section'], undefined)

  const invalidErrors = validateEventStageSettingsDraft(settingsDraft({
    sections: [validSectionDraft({
      name: '   ',
      startMode: 'fixed',
      plannedStartTime: '24:00',
      endMode: 'fixed',
      plannedEndTime: '',
    })],
  }))
  assert.equal(
    invalidErrors.sections['draft-section'].name,
    'Section名を入力してください。',
  )
  assert.match(
    invalidErrors.sections['draft-section'].plannedStartTime,
    /有効な固定開始時刻/,
  )
  assert.match(
    invalidErrors.sections['draft-section'].plannedEndTime,
    /有効な固定終了時刻/,
  )

  for (const plannedEndTime of ['11:00', '10:59']) {
    const errors = validateEventStageSettingsDraft(settingsDraft({
      sections: [validSectionDraft({
        startMode: 'fixed',
        plannedStartTime: '11:00',
        endMode: 'fixed',
        plannedEndTime,
      })],
    }))
    assert.match(
      errors.sections['draft-section'].plannedEndTime,
      /固定開始時刻より後/,
    )
  }
})

test('Section固定時刻をStageの時間範囲内に制限する', () => {
  const fixedStage = validStageDraft({
    endMode: 'fixed',
    plannedEndTime: '17:00',
  })
  const validateSection = (section) => validateEventStageSettingsDraft(
    settingsDraft({ stages: [fixedStage], sections: [section] }),
  ).sections['draft-section']

  assert.match(validateSection(validSectionDraft({
    startMode: 'fixed',
    plannedStartTime: '09:59',
  })).plannedStartTime, /Stage開始時刻以降/)
  assert.equal(validateSection(validSectionDraft({
    startMode: 'fixed',
    plannedStartTime: '10:00',
  })), undefined)
  assert.match(validateSection(validSectionDraft({
    startMode: 'fixed',
    plannedStartTime: '17:00',
  })).plannedStartTime, /Stage終了時刻より前/)
  assert.match(validateSection(validSectionDraft({
    endMode: 'fixed',
    plannedEndTime: '10:00',
  })).plannedEndTime, /Stage開始時刻より後/)
  assert.equal(validateSection(validSectionDraft({
    endMode: 'fixed',
    plannedEndTime: '17:00',
  })), undefined)
  assert.match(validateSection(validSectionDraft({
    endMode: 'fixed',
    plannedEndTime: '17:01',
  })).plannedEndTime, /Stage終了時刻以前/)
  assert.equal(validateSection(validSectionDraft({
    startMode: 'fixed',
    plannedStartTime: '10:30',
    endMode: 'fixed',
    plannedEndTime: '16:30',
  })), undefined)
})

test('既存Section IDを維持し、新規IDだけを使ってStageごとにorderを正規化する', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage, secondStage],
    sections: [existingSection],
    draft: settingsDraft({
      stages: [
        validStageDraft({
          draftId: 'stage-one-draft',
          stageId: existingStage.id,
          endMode: 'fixed',
          plannedEndTime: '17:00',
        }),
        validStageDraft({
          draftId: 'stage-two-draft',
          stageId: secondStage.id,
          name: secondStage.name,
          plannedStartTime: secondStage.plannedStartTime,
        }),
      ],
      sections: [
        validSectionDraft({
          draftId: 'existing-section-draft',
          sectionId: existingSection.id,
          stageDraftId: 'stage-one-draft',
          name: ' 1部 ',
        }),
        validSectionDraft({
          draftId: 'new-one-draft',
          stageDraftId: 'stage-one-draft',
          name: '2部',
        }),
        validSectionDraft({
          draftId: 'new-two-draft',
          stageDraftId: 'stage-two-draft',
          name: '別Stage 1部',
        }),
      ],
    }),
    newStageIds: [],
    newSectionIds: ['section-new-one', 'section-new-two'],
    scheduleItems: [],
    eventBands: [],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.sections, [
    {
      ...existingSection,
      name: '1部',
      order: 0,
      plannedStartTime: undefined,
      plannedEndTime: undefined,
    },
    {
      id: 'section-new-one',
      stageId: existingStage.id,
      name: '2部',
      order: 1,
      plannedStartTime: undefined,
      plannedEndTime: undefined,
    },
    {
      id: 'section-new-two',
      stageId: secondStage.id,
      name: '別Stage 1部',
      order: 0,
      plannedStartTime: undefined,
      plannedEndTime: undefined,
    },
  ])
})

test('ScheduleItemまたは固定配置から参照されるSectionだけ削除不可にする', () => {
  const noSectionReferences = { scheduleItems: [], eventBands: [] }
  assert.equal(canDeleteSection(existingSection.id, noSectionReferences), true)
  assert.equal(canDeleteSection(existingSection.id, {
    scheduleItems: [{ sectionId: existingSection.id }],
    eventBands: [],
  }), false)
  assert.equal(canDeleteSection(existingSection.id, {
    scheduleItems: [],
    eventBands: [{
      fixedPlacement: {
        stageId: existingStage.id,
        sectionId: existingSection.id,
      },
    }],
  }), false)
  assert.equal(canDeleteSection(existingSection.id, {
    scheduleItems: [{ sectionId: 'another-section' }],
    eventBands: [{
      fixedPlacement: {
        stageId: existingStage.id,
        sectionId: 'another-section',
      },
    }],
  }), true)
})

test('参照中Sectionをdraftから除いても保存処理で削除をブロックする', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    sections: [existingSection],
    draft: settingsDraft({
      stages: [validStageDraft({
        stageId: existingStage.id,
        endMode: 'fixed',
        plannedEndTime: existingStage.plannedEndTime,
      })],
    }),
    newStageIds: [],
    newSectionIds: [],
    scheduleItems: [{
      id: 'schedule-1',
      stageId: existingStage.id,
      sectionId: existingSection.id,
      order: 0,
      kind: 'break',
      title: '休憩',
      durationMinutes: 10,
    }],
    eventBands: [],
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.form ?? '', /Section/)
})

test('未参照の最後のSectionは保存処理で削除できる', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    sections: [existingSection],
    draft: settingsDraft({
      stages: [validStageDraft({
        stageId: existingStage.id,
        endMode: 'fixed',
        plannedEndTime: existingStage.plannedEndTime,
      })],
    }),
    newStageIds: [],
    newSectionIds: [],
    scheduleItems: [],
    eventBands: [],
  })

  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.sections, [])
})

test('最初のSectionはScheduleItemがないStageにだけ追加できる', () => {
  const scheduleItem = { stageId: existingStage.id }
  assert.equal(canAddFirstSection(existingStage.id, [], []), true)
  assert.equal(canAddFirstSection(existingStage.id, [], [scheduleItem]), false)
  assert.equal(canAddFirstSection(
    existingStage.id,
    [{ stageId: existingStage.id }],
    [scheduleItem],
  ), true)
})

test('ScheduleItemがあるSectionなしStageへの最初のSection追加を保存処理でも拒否する', () => {
  const result = createEventStageSettingsUpdate({
    event,
    eventDays,
    stages: [existingStage],
    sections: [],
    draft: settingsDraft({
      stages: [validStageDraft({
        stageId: existingStage.id,
        endMode: 'fixed',
        plannedEndTime: existingStage.plannedEndTime,
      })],
      sections: [validSectionDraft()],
    }),
    newStageIds: [],
    newSectionIds: ['section-new'],
    scheduleItems: [{
      id: 'schedule-1',
      stageId: existingStage.id,
      order: 0,
      kind: 'break',
      title: '休憩',
      durationMinutes: 10,
    }],
    eventBands: [],
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(
      result.errors.sections['draft-section'].form,
      /先にタイムテーブルの配置を削除/,
    )
  }
})
