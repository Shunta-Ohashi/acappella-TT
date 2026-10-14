import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import {
  countTimetableMemberAppearances,
  getTimetableMemberCellAccessibleLabel,
  getTimetableMemberColumnCount,
  resolveTimetableMemberHighlight,
  TIMETABLE_MEMBER_MATRIX_MINIMUM_MEMBER_COLUMNS,
  toggleTimetableMemberHighlight,
} from '../src/ui/timetableMemberMatrixPresentation.ts'
import {
  createTimetableGridColumns,
  createTimetableMemberMatrixColumns,
} from '../src/ui/timetableGridColumns.ts'
import {
  formatTimetableTimeCondition,
  getAnchoredOverlayPosition,
  getIssueBadgeTooltip,
  getScheduleItemIssuesBySeverity,
} from '../src/ui/timetableGridDetailsPresentation.ts'

const dutyTypes = [
  { id: 'duty-photo', eventId: 'event-1', name: '撮影', order: 2 },
  { id: 'duty-tk', eventId: 'event-1', name: 'TK', order: 1 },
]

const memberCell = (memberId, displayName = memberId) => ({
  memberId,
  displayName,
  resolved: true,
})

const row = (memberCells) => ({ memberCells })

test('Member一覧Gridは7人未満・ちょうど7人なら最低7列を確保する', () => {
  assert.equal(TIMETABLE_MEMBER_MATRIX_MINIMUM_MEMBER_COLUMNS, 7)
  assert.equal(getTimetableMemberColumnCount([]), 7)
  assert.equal(getTimetableMemberColumnCount([
    row(Array.from({ length: 6 }, (_, index) => memberCell(`member-${index}`))),
    row(Array.from({ length: 7 }, (_, index) => memberCell(`member-${index}`))),
  ]), 7)

  const columns = createTimetableMemberMatrixColumns(dutyTypes, 7)
  assert.deepEqual(columns.map(column => column.label), [
    '時間',
    'バンド名',
    'メンバー1',
    'メンバー2',
    'メンバー3',
    'メンバー4',
    'メンバー5',
    'メンバー6',
    'メンバー7',
    'Main PA',
    'Sub PA',
    'TK',
    '撮影',
  ])
  assert.deepEqual(columns.map(column => column.width), [
    70,
    180,
    90,
    90,
    90,
    90,
    90,
    90,
    90,
    84,
    84,
    84,
    84,
  ])
})

test('8人以上の出演では最大人数と同じ数までMember列を拡張する', () => {
  const rows = [
    row(Array.from({ length: 4 }, (_, index) => memberCell(`short-${index}`))),
    row(Array.from({ length: 9 }, (_, index) => memberCell(`long-${index}`))),
  ]

  assert.equal(getTimetableMemberColumnCount(rows), 9)
  const columns = createTimetableMemberMatrixColumns(dutyTypes, 9)
  assert.equal(columns.filter(column => column.id.startsWith('member-')).length, 9)
  assert.equal(columns.find(column => column.id === 'member-9')?.label, 'メンバー9')
  assert.deepEqual(
    columns.slice(-4).map(column => column.label),
    ['Main PA', 'Sub PA', 'TK', '撮影'],
  )
})

test('通常表示の列幅・順序をMember一覧列追加後も変更しない', () => {
  assert.deepEqual(createTimetableGridColumns(dutyTypes), [
    { id: 'time', label: '時刻', width: 70 },
    { id: 'performance', label: '出演', width: 270 },
    { id: 'main-pa', label: 'Main PA', width: 90 },
    { id: 'sub-pa', label: 'Sub PA', width: 90 },
    { id: 'duty-duty-tk', label: 'TK', width: 90, dutyTypeId: 'duty-tk' },
    { id: 'duty-duty-photo', label: '撮影', width: 90, dutyTypeId: 'duty-photo' },
  ])
})

test('Member一覧はコンパクト行とページ縦スクロールをCSS契約として維持する', () => {
  const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

  assert.match(css, /\.timetable-grid-wrap--member-matrix\s*\{[^}]*max-height:\s*none;/s)
  assert.match(css, /\.timetable-grid-scroll\s*\{[^}]*overflow-x:\s*auto;/s)
  assert.doesNotMatch(css, /\.timetable-grid-wrap\s*\{[^}]*overflow-x:\s*auto;/s)
  assert.match(
    css,
    /\.timetable-grid-wrap--member-matrix\s*>\s*:not\(\.timetable-grid-scroll\)\s*\{[^}]*min-width:\s*0;/s,
  )
  assert.doesNotMatch(css, /\.timetable-grid--member-matrix[^{}]*\{[^}]*position:\s*sticky;/s)
  assert.doesNotMatch(css, /\.timetable-grid--member-matrix[^{}]*\{[^}]*left:\s*(?:0|70px);/s)
  assert.match(css, /\.timetable-grid__row--member-matrix\s*\{[^}]*min-height:\s*32px;/s)
  assert.match(css, /\.timetable-grid__member-button\s*\{[^}]*white-space:\s*nowrap;/s)
  assert.match(css, /\.timetable-grid__member-button\s*\{[^}]*text-overflow:\s*ellipsis;/s)
  assert.match(css, /\.timetable-grid__row-actions-menu\s*\{[^}]*position:\s*fixed;/s)
  assert.match(css, /\.timetable-grid__row-actions-menu\s*\{[^}]*overflow-y:\s*auto;/s)
  assert.doesNotMatch(css, /\.timetable-grid__row-actions-menu\s*\{[^}]*position:\s*absolute;/s)
  assert.match(css, /\.timetable-grid-details-popover\s*\{[^}]*position:\s*fixed;/s)
  assert.match(css, /\.timetable-grid-details-popover__body\s*\{[^}]*overflow-y:\s*auto;/s)
})

test('Issue詳細はScheduleItemとseverityの明示対応だけを抽出する', () => {
  const issues = [
    { severity: 'ERROR', code: 'MEMBER_ABSENT', message: 'E', scheduleItemIds: ['item-a'] },
    { severity: 'WARNING', code: 'SHORT_REST', message: 'W1', scheduleItemIds: ['item-a', 'item-b'] },
    { severity: 'WARNING', code: 'BACK_TO_BACK', message: 'W2', scheduleItemIds: ['item-a'] },
    { severity: 'INFO', code: 'PREFERENCE_NOT_MET', message: 'I', scheduleItemIds: ['item-a'] },
    { severity: 'WARNING', code: 'SHORT_GAP', message: '行未指定' },
  ]

  assert.deepEqual(
    getScheduleItemIssuesBySeverity(issues, 'item-a', 'WARNING').map(issue => issue.message),
    ['W1', 'W2'],
  )
  assert.deepEqual(
    getScheduleItemIssuesBySeverity(issues, 'item-b', 'WARNING').map(issue => issue.message),
    ['W1'],
    '複数行に紐づくIssueはどちらからも参照できる',
  )
  assert.equal(getScheduleItemIssuesBySeverity(issues, 'item-b', 'ERROR').length, 0)
  assert.equal(getScheduleItemIssuesBySeverity(issues, 'missing', 'WARNING').length, 0)
})

test('Issue更新・行並べ替え・復元後も現在のIssue配列から詳細を解決する', () => {
  const warning = {
    severity: 'WARNING', code: 'SHORT_REST', message: '休憩不足',
    scheduleItemIds: ['item-a', 'item-b'],
  }
  const reorderedRows = ['item-b', 'item-a']
  assert.deepEqual(
    reorderedRows.map(id => getScheduleItemIssuesBySeverity([warning], id, 'WARNING').length),
    [1, 1],
  )
  assert.equal(getScheduleItemIssuesBySeverity([], 'item-a', 'WARNING').length, 0)
  assert.equal(
    getScheduleItemIssuesBySeverity([warning], 'item-a', 'WARNING').length,
    1,
    'Undo相当でIssueが戻れば再び表示できる',
  )
})

test('必須時間と希望時間は両端・片側指定を混同せず表示する', () => {
  assert.deepEqual(
    formatTimetableTimeCondition({ from: '10:00', until: '14:00' }, 'available'),
    { title: '必須時間条件', summary: '出演可能時間：10:00〜14:00' },
  )
  assert.equal(
    formatTimetableTimeCondition({ from: '13:00' }, 'preferred').summary,
    '希望時間：13:00以降',
  )
  assert.equal(
    formatTimetableTimeCondition({ until: '16:00' }, 'preferred').summary,
    '希望時間：16:00まで',
  )
})

test('バッジtooltipは件数と代表Issueを示し、overlayはviewport内へ補正する', () => {
  assert.equal(
    getIssueBadgeTooltip('WARNING', ['1件目', '2件目']),
    'WARNING 2件: 1件目。クリックで全件を表示',
  )
  const rightEdge = getAnchoredOverlayPosition({
    anchor: { top: 100, right: 790, bottom: 120, left: 770 },
    overlayWidth: 390,
    overlayHeight: 240,
    viewportWidth: 800,
    viewportHeight: 600,
  })
  assert.equal(rightEdge.left, 402)
  assert.equal(rightEdge.placement, 'below')

  const bottomEdge = getAnchoredOverlayPosition({
    anchor: { top: 560, right: 120, bottom: 580, left: 100 },
    overlayWidth: 300,
    overlayHeight: 220,
    viewportWidth: 800,
    viewportHeight: 600,
  })
  assert.equal(bottomEdge.placement, 'above')
  assert.ok(bottomEdge.top >= 8)

  const rightAlignedMenu = getAnchoredOverlayPosition({
    anchor: { top: 10, right: 790, bottom: 32, left: 767 },
    overlayWidth: 230,
    overlayHeight: 260,
    viewportWidth: 800,
    viewportHeight: 600,
    horizontalAlignment: 'end',
  })
  assert.equal(rightAlignedMenu.left, 560)
  assert.equal(rightAlignedMenu.placement, 'below', '先頭行では下へ表示する')

  const afterHorizontalScroll = getAnchoredOverlayPosition({
    anchor: { top: 560, right: 42, bottom: 582, left: 19 },
    overlayWidth: 230,
    overlayHeight: 260,
    viewportWidth: 800,
    viewportHeight: 600,
    horizontalAlignment: 'end',
  })
  assert.equal(afterHorizontalScroll.left, 8, '横スクロール後も左端からはみ出さない')
  assert.equal(afterHorizontalScroll.placement, 'above', '最終行では上へ表示する')
})

test('ポップオーバーはPortal・Esc・外側click・Stage切替のclose契約を持つ', () => {
  const popoverSource = readFileSync(
    new URL('../src/components/TimetableGridDetailsPopover.tsx', import.meta.url),
    'utf8',
  )
  const gridSource = readFileSync(
    new URL('../src/components/TimetableGrid.tsx', import.meta.url),
    'utf8',
  )
  const rowActionsPortalSource = popoverSource.slice(
    popoverSource.indexOf('export function TimetableGridRowActionsMenu'),
    popoverSource.indexOf('interface TimetableGridTooltipProps'),
  )
  assert.match(popoverSource, /createPortal\(/)
  assert.match(popoverSource, /TimetableGridRowActionsMenu/)
  assert.match(rowActionsPortalSource, /createPortal\(/)
  assert.match(rowActionsPortalSource, /horizontalAlignment:\s*'end'/)
  assert.match(rowActionsPortalSource, /window\.visualViewport\?\.addEventListener\('resize'/)
  assert.match(rowActionsPortalSource, /!anchor\.isConnected/)
  assert.match(popoverSource, /document\.addEventListener\('pointerdown'/)
  assert.match(popoverSource, /event\.key !== 'Escape'/)
  assert.match(popoverSource, /window\.addEventListener\('scroll', updatePosition, true\)/)
  assert.match(gridSource, /detailsDataRevision/)
  assert.match(gridSource, /activeDetails\.epoch === currentDetailsEpoch/)
  assert.match(gridSource, /aria-expanded=\{rowActionsAnchor !== undefined\}/)
  assert.match(gridSource, /onPointerDown=\{event => event\.stopPropagation\(\)\}/)
  assert.doesNotMatch(
    gridSource,
    /<details\s+className="timetable-grid__row-actions"/,
  )
})

test('Memberセルの読み上げは同名でもID・参照状態・設定色・選択状態を区別する', () => {
  assert.equal(getTimetableMemberCellAccessibleLabel({
    displayName: '同姓同名', memberId: 'member-a', resolved: true,
    selected: true, colorLabel: 'ローズ',
  }), '同姓同名（Member ID: member-a、設定色: ローズ）の出演箇所を強調（選択中）')
  assert.equal(getTimetableMemberCellAccessibleLabel({
    displayName: '同姓同名', memberId: 'member-b', resolved: true,
    selected: false,
  }), '同姓同名（Member ID: member-b）の出演箇所を強調')
  assert.equal(getTimetableMemberCellAccessibleLabel({
    displayName: '同姓同名', memberId: 'member-c', resolved: false,
    selected: false, colorLabel: 'ブルー',
  }), '同姓同名（Member ID: member-c、参照切れ、設定色: ブルー）')
})

test('同じ表示名でもMember IDを厳密比較して出演回数を数える', () => {
  const rows = [
    row([
      memberCell('member-a', '同姓同名'),
      memberCell('member-b', '同姓同名'),
    ]),
    row([memberCell('member-a', '同姓同名')]),
    row([]),
  ]
  const original = structuredClone(rows)

  assert.equal(countTimetableMemberAppearances(rows, 'member-a'), 2)
  assert.equal(countTimetableMemberAppearances(rows, 'member-b'), 1)
  assert.equal(countTimetableMemberAppearances(rows, 'missing-member'), 0)
  assert.equal(getTimetableMemberColumnCount(rows), 7)
  assert.deepEqual(rows, original, '表示用集計はrowを変更しない')
})

test('row順や所属rowが変わっても現在のrowsから出演回数を再計算する', () => {
  const before = [
    row([memberCell('member-a')]),
    row([memberCell('member-b'), memberCell('member-a')]),
  ]
  const after = [
    row([memberCell('member-a'), memberCell('member-b'), memberCell('member-a')]),
  ]

  assert.equal(countTimetableMemberAppearances(before, 'member-a'), 2)
  assert.equal(countTimetableMemberAppearances([...before].reverse(), 'member-a'), 2)
  assert.equal(countTimetableMemberAppearances(after, 'member-a'), 2)
})

test('Member選択は同じMemberの再選択で解除し、別Memberなら置き換える', () => {
  const context = {
    persistenceScopeKey: 'scope:user-a:workspace-a',
    persistenceVisitId: 'visit-a',
    eventId: 'event-a',
    eventDayId: 'day-a',
  }
  const selected = toggleTimetableMemberHighlight(null, context, 'member-a')

  assert.deepEqual(selected, { ...context, memberId: 'member-a' })
  assert.equal(toggleTimetableMemberHighlight(selected, context, 'member-a'), null)
  assert.deepEqual(toggleTimetableMemberHighlight(selected, context, 'member-b'), {
    ...context,
    memberId: 'member-b',
  })
  assert.deepEqual(Object.keys(selected).sort(), [
    'eventDayId',
    'eventId',
    'memberId',
    'persistenceScopeKey',
    'persistenceVisitId',
  ])
})

test('highlightはscope・Event・EventDay・Member存在性で解決し、Stage切替では維持する', () => {
  const context = {
    persistenceScopeKey: 'scope:user-a:workspace-a',
    persistenceVisitId: 'visit-a',
    eventId: 'event-a',
    eventDayId: 'day-a',
  }
  const selected = toggleTimetableMemberHighlight(null, context, 'member-a')
  const existingMemberIds = new Set(['member-a'])

  assert.equal(resolveTimetableMemberHighlight(selected, context, existingMemberIds), 'member-a')
  assert.equal(
    resolveTimetableMemberHighlight(selected, { ...context }, existingMemberIds),
    'member-a',
    'Stageはhighlight contextへ含めないため同一EventDay内のStage切替で維持する',
  )
  assert.equal(resolveTimetableMemberHighlight(selected, {
    ...context,
    persistenceScopeKey: 'scope:user-a:workspace-b',
  }, existingMemberIds), null)
  assert.equal(resolveTimetableMemberHighlight(selected, {
    ...context,
    persistenceVisitId: 'visit-b',
  }, existingMemberIds), null)
  assert.equal(resolveTimetableMemberHighlight(selected, {
    ...context,
    eventId: 'event-b',
  }, existingMemberIds), null)
  assert.equal(resolveTimetableMemberHighlight(selected, {
    ...context,
    eventDayId: 'day-b',
  }, existingMemberIds), null)
  assert.equal(resolveTimetableMemberHighlight(selected, context, new Set()), null)
  assert.equal(resolveTimetableMemberHighlight(selected, {
    persistenceScopeKey: context.persistenceScopeKey,
    persistenceVisitId: context.persistenceVisitId,
  }, existingMemberIds), null)
})

test('実GridのMember一覧markupはreadOnlyでもID選択とPA・Duty補助強調を表示する', async () => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true },
  })
  try {
    const { DragDropContext } = await import('@hello-pangea/dnd')
    const { TimetableGrid } = await vite.ssrLoadModule(
      '/src/components/TimetableGrid.tsx',
    )
    const { TimetableOperationsWorkspace } = await vite.ssrLoadModule(
      '/src/components/TimetableOperationsWorkspace.tsx',
    )
    const noOp = () => {}
    const row = {
      scheduleItem: {
        id: 'schedule-a',
        kind: 'performance',
        stageId: 'stage-a',
        sectionId: 'section-a',
        eventBandId: 'event-band-a',
      },
      calculatedItem: {
        scheduleItemId: 'schedule-a',
        eventDayId: 'day-a',
        stageId: 'stage-a',
        plannedStartMinute: 600,
        plannedEndMinute: 610,
      },
      eventBand: {
        id: 'event-band-a',
        eventId: 'event-a',
        eventDayId: 'day-a',
        name: 'Alpha',
        durationMinutes: 10,
        memberIds: ['member-a', 'member-b'],
        fixedPlacement: { stageId: 'stage-a' },
        availableTimeRange: { from: '10:00', until: '11:00' },
        preferredTimeRange: { from: '10:00', until: '10:30' },
      },
      memberCells: [
        memberCell('member-a', '同姓同名'),
        memberCell('member-b', '同姓同名'),
      ],
      memberNames: ['同姓同名', '同姓同名'],
      issueCounts: { ERROR: 1, WARNING: 1, INFO: 1 },
      fixedPlacementLabels: ['Stage固定'],
      hasHardTimeCondition: true,
      hasPreferredTimeCondition: true,
      paCoverage: {
        main: [{
          assignmentId: 'pa-a',
          memberId: 'member-a',
          memberName: '同姓同名',
          role: 'main',
          startsHere: true,
          endsHere: true,
        }],
        sub: [],
      },
      dutyCoverage: {
        'duty-a': [{
          assignmentId: 'assignment-a',
          dutyTypeId: 'duty-a',
          memberId: 'member-a',
          memberName: '同姓同名',
          startsHere: true,
          endsHere: true,
          issueCounts: { ERROR: 0, WARNING: 0, INFO: 0 },
        }],
      },
    }
    const interSectionRow = {
      scheduleItem: {
        id: 'break-a',
        kind: 'break',
        stageId: 'stage-a',
        afterSectionId: 'section-a',
        title: '転換',
        durationMinutes: 5,
      },
      calculatedItem: {
        scheduleItemId: 'break-a',
        eventDayId: 'day-a',
        stageId: 'stage-a',
        plannedStartMinute: 610,
        plannedEndMinute: 615,
      },
      memberCells: [],
      memberNames: [],
      issueCounts: { ERROR: 0, WARNING: 0, INFO: 0 },
      fixedPlacementLabels: [],
      hasHardTimeCondition: false,
      hasPreferredTimeCondition: false,
      paCoverage: { main: [], sub: [] },
      dutyCoverage: { 'duty-a': [] },
    }
    const markup = renderToStaticMarkup(createElement(
      DragDropContext,
      { onDragEnd: noOp },
      createElement(TimetableGrid, {
        stage: { id: 'stage-a', eventDayId: 'day-a', name: 'Main', order: 0 },
        sections: [
          { id: 'section-a', stageId: 'stage-a', name: '第1部', order: 0 },
          { id: 'section-b', stageId: 'stage-a', name: '第2部', order: 1 },
        ],
        rows: [row, interSectionRow],
        issues: [
          {
            severity: 'ERROR',
            code: 'MEMBER_ABSENT',
            message: 'メンバー member-a は欠席です。',
            memberIds: ['member-a'],
            eventBandIds: ['event-band-a'],
            scheduleItemIds: ['schedule-a'],
            stageIds: ['stage-a'],
            sectionIds: ['section-a'],
          },
          {
            severity: 'WARNING',
            code: 'PREFERENCE_NOT_MET',
            message: 'EventBand event-band-a の希望時間外です。',
            eventBandIds: ['event-band-a'],
            scheduleItemIds: ['schedule-a'],
          },
          {
            severity: 'INFO',
            code: 'BACK_TO_BACK',
            message: '連続出演です。',
            scheduleItemIds: ['schedule-a'],
            gapBands: 0,
          },
        ],
        issueStages: [
          { id: 'stage-a', eventDayId: 'day-a', name: 'Main', order: 0 },
        ],
        issueSections: [
          { id: 'section-a', stageId: 'stage-a', name: '第1部', order: 0 },
          { id: 'section-b', stageId: 'stage-a', name: '第2部', order: 1 },
        ],
        issueCalculatedItems: [row.calculatedItem, interSectionRow.calculatedItem],
        unresolvedPaAssignments: [],
        offGridPaAssignments: [],
        dutyTypes: [{ id: 'duty-a', eventId: 'event-a', name: '受付', order: 0 }],
        unresolvedDutyAssignments: [],
        offGridDutyAssignments: [],
        breakDuration: 10,
        onBreakDurationChange: noOp,
        onAddBreak: noOp,
        onAddInterSectionBreak: noOp,
        onRemoveScheduleItem: noOp,
        timetableLocks: [],
        scheduleItems: [row.scheduleItem, interSectionRow.scheduleItem],
        eventBands: [row.eventBand],
        lockViolations: [],
        lockFeedback: '',
        orderConstraintFeedback: '',
        orderConstraintBlocks: [],
        activeOrderConstraintBlockKey: null,
        onOrderConstraintBlockHighlightChange: noOp,
        onSetTimetableLock: noOp,
        onUnlockTimetableLock: noOp,
        onUnlockAllTimetableLocks: noOp,
        selection: null,
        onSelectionChange: noOp,
        assignmentFeedback: null,
        onAssignSelection: noOp,
        onAutoAssignSelection: noOp,
        onDeleteSelectionAssignments: noOp,
        viewMode: 'member-matrix',
        highlightedMemberId: 'member-a',
        highlightedMemberName: '同姓同名',
        onHighlightedMemberChange: noOp,
        members: [
          { id: 'member-a', realName: '同姓同名', active: true },
          { id: 'member-b', realName: '同姓同名', active: true },
        ],
        memberColorCandidates: [
          {
            memberId: 'member-a',
            displayName: '同姓同名',
            eventBandCount: 2,
            selectedEventDayBandCount: 1,
          },
          {
            memberId: 'member-b',
            displayName: '同姓同名',
            eventBandCount: 1,
            selectedEventDayBandCount: 1,
          },
        ],
        memberColorAssignments: [
          { memberId: 'member-a', colorId: 'rose' },
          { memberId: 'member-b', colorId: 'blue' },
        ],
        memberColorEventDayLabel: '1日目',
        onAddMemberColor: noOp,
        onChangeMemberColor: noOp,
        onRemoveMemberColor: noOp,
        onClearMemberColors: noOp,
        readOnly: true,
      }),
    ))

    assert.match(markup, /Mainのメンバー一覧タイムテーブル/)
    assert.match(markup, /aria-colcount="12"/)
    assert.match(
      markup,
      /同姓同名（Member ID: member-a、設定色: ローズ）の出演箇所を強調（選択中）/,
    )
    assert.match(
      markup,
      /同姓同名（Member ID: member-b、設定色: ブルー）の出演箇所を強調"/,
    )
    assert.equal(
      (markup.match(/timetable-grid__member-button--active/g) ?? []).length,
      1,
    )
    assert.equal(
      (markup.match(/timetable-grid__coverage--member-highlight/g) ?? []).length,
      2,
    )
    assert.equal(
      (markup.match(/timetable-grid__member-button--colored/g) ?? []).length,
      2,
      '同名でもMember IDごとの2色を出演cellへ設定する',
    )
    assert.equal(
      (markup.match(/timetable-grid__coverage--member-colored/g) ?? []).length,
      2,
      '同じMember IDのPA・Dutyにも補助色を表示する',
    )
    assert.match(markup, /--timetable-member-color-background:#fde8ec/)
    assert.match(markup, /--timetable-member-color-background:#e3edfc/)
    assert.match(markup, /メンバー色分け設定/)
    assert.match(markup, /2人設定中/)
    assert.match(markup, /同姓同名（member-a）の色を変更/)
    assert.match(markup, /Event 2バンド/)
    const personalColorTrigger = markup.match(
      /<summary aria-label="同姓同名（member-a）の色を変更"[^>]*>/,
    )?.[0]
    assert.ok(personalColorTrigger)
    assert.equal(
      (markup.match(/timetable-member-color-picker__swatch/g) ?? []).length,
      48,
      '設定中の2人それぞれに24色の独立した見本を表示する',
    )
    assert.match(markup, /aria-label="ローズ（選択中）"/)
    assert.match(markup, /aria-label="ブルー（選択中）"/)
    assert.match(markup, /aria-label="Alphaの詳細操作"/)
    assert.match(markup, /class="timetable-grid__row-actions"/)
    assert.match(markup, /aria-haspopup="dialog" aria-expanded="false"/)
    assert.match(
      markup,
      /class="timetable-grid-scroll"><div class="timetable-grid timetable-grid--member-matrix"/,
    )
    assert.doesNotMatch(markup, /timetable-grid__time--sticky/)
    assert.doesNotMatch(markup, /timetable-grid__header-cell--(?:time|band)/)
    const gridSource = readFileSync(
      new URL('../src/components/TimetableGrid.tsx', import.meta.url),
      'utf8',
    )
    assert.match(gridSource, /<TimetableGridRowActionsMenu/)
    assert.match(gridSource, /\{renderMetaControls\(\)\}/)
    assert.match(gridSource, /\{renderRemoveButton\(\)\}/)
    assert.match(markup, /出演1箇所/)
    assert.match(markup, /aria-label="AlphaのERRORを1件表示"/)
    assert.match(markup, /aria-label="AlphaのWARNINGを1件表示"/)
    assert.match(markup, /aria-label="AlphaのINFOを1件表示"/)
    assert.match(markup, />E1<\/button>/)
    assert.match(markup, />W1<\/button>/)
    assert.match(markup, />I1<\/button>/)
    assert.match(markup, /aria-label="Alphaの必須時間条件を表示"/)
    assert.match(markup, /aria-label="Alphaの希望時間条件を表示"/)
    const issueTrigger = markup.match(
      /<button[^>]*aria-label="AlphaのWARNINGを1件表示"[^>]*>/,
    )?.[0]
    assert.ok(issueTrigger)
    assert.match(issueTrigger, /aria-haspopup="dialog"/)
    assert.doesNotMatch(issueTrigger, /disabled/)
    assert.match(gridSource, /必須時間あり/)
    assert.match(gridSource, /希望あり/)
    assert.match(gridSource, /📌 必須条件：/)
    assert.equal(
      (markup.match(/timetable-grid__member-empty/g) ?? []).length,
      12,
      '2人の出演rowは5空cell、部間休憩rowは7空cellを保持する',
    )

    const workspaceMarkup = renderToStaticMarkup(createElement(
      TimetableOperationsWorkspace,
      {
        eventDays: [],
        stages: [],
        onSelectEventDay: noOp,
        onSelectStage: noOp,
        poolCount: 0,
        issueCounts: { ERROR: 0, WARNING: 0, INFO: 0 },
        viewMode: 'member-matrix',
        onViewModeChange: noOp,
        settings: null,
        canUndo: false,
        canRedo: false,
        onUndo: noOp,
        onRedo: noOp,
        historyFeedback: null,
        navigationFeedback: null,
        unavailableContent: createElement('p', null, '表示対象なし'),
        pool: null,
        timetable: null,
        issuePanel: null,
        orderPanel: null,
        renderPaPanel: noOp,
        renderOperationsPanel: noOp,
        footer: null,
      },
    ))
    assert.match(
      workspaceMarkup,
      /role="group" aria-label="タイムテーブル表示モード"/,
    )
    assert.match(workspaceMarkup, /aria-pressed="false">通常表示/)
    assert.match(workspaceMarkup, /aria-pressed="true">メンバー一覧/)
    const memberMatrixButton = workspaceMarkup.match(
      /<button[^>]*>メンバー一覧<\/button>/,
    )?.[0]
    assert.ok(memberMatrixButton)
    assert.doesNotMatch(memberMatrixButton, /disabled/)
  } finally {
    await vite.close()
  }
})
