import { useState, type FormEvent } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd'
import type {
  Band,
  BreakScheduleItem,
  Event as TimetableEvent,
  EventBand,
  EventDay,
  EventMember,
  EventMemberDay,
  Member,
  PerformanceScheduleItem,
  ScheduleItem,
  Section,
  Stage,
} from './domain/models'
import {
  getEventBandById,
  getStageScheduleItems,
  getUnscheduledEventBands,
  insertStageScheduleItem,
  removeScheduleItem,
  reorderStageScheduleItems,
  reorderUnscheduledEventBands,
} from './domain/schedule'
import {
  calculateStageTimeline,
  formatMinuteAsLocalTime,
  isValidLocalTime,
} from './domain/timeline'
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
import { IssuePanel } from './components/IssuePanel'
import { getHighestSeverityByScheduleItem } from './ui/issuePresentation'
import './App.css'

const CURRENT_STAGE_ID = 'stage-1'

type AppView = 'event-editor' | AppSection

const appSectionPlaceholders: Record<
  AppSection,
  { title: string; description: string }
> = {
  events: {
    title: 'イベント',
    description: 'イベント一覧と新規作成は後続PRで実装します。',
  },
  'shared-data': {
    title: '共通データ',
    description: 'メンバーや固定バンドの共通データ管理は後続PRで実装します。',
  },
  settings: {
    title: '設定',
    description: 'アプリ全体の設定は後続PRで実装します。',
  },
}

const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

const initialMembers: Member[] = [
  { id: 'm-1', realName: '佐藤', active: true },
  { id: 'm-2', realName: '鈴木', active: true },
  { id: 'm-3', realName: '高橋', active: true },
  { id: 'm-4', realName: '田中', active: true },
]

const initialEvent: TimetableEvent = {
  id: 'event-1',
  name: '現在のイベント',
  timeZone: 'Asia/Tokyo',
  defaultTransitionMinutes: 2,
  validationPolicy: {
    minimumGapBands: 1,
    minimumRestMinutes: 10,
  },
}

const eventDays: EventDay[] = [
  {
    id: 'event-day-1',
    eventId: initialEvent.id,
    date: '2026-01-01',
    order: 0,
  },
]

const initialStage: Stage = {
  id: CURRENT_STAGE_ID,
  eventDayId: eventDays[0].id,
  name: 'メインステージ',
  order: 0,
  plannedStartTime: '13:00',
}

const initialEventBands: EventBand[] = [
  {
    id: 'event-band-1',
    eventId: initialEvent.id,
    eventDayId: eventDays[0].id,
    bandId: 'b-1',
    memberIds: ['m-1', 'm-2', 'm-3'],
    durationMinutes: 15,
  },
]

const initialEventMembers: EventMember[] = initialMembers.map((member) => ({
  id: `event-member-${member.id}`,
  eventId: initialEvent.id,
  memberId: member.id,
}))

const initialEventMemberDays: EventMemberDay[] = initialEventMembers.map((
  eventMember,
) => ({
  id: `event-member-day-${eventMember.memberId}`,
  eventMemberId: eventMember.id,
  eventDayId: eventDays[0].id,
  participationStatus: 'participating',
}))

const initialScheduleItems: ScheduleItem[] = [
  {
    id: 'schedule-break-1',
    stageId: CURRENT_STAGE_ID,
    order: 0,
    kind: 'break',
    title: '中間休憩',
    durationMinutes: 10,
  },
]

const initialSections: Section[] = []

function App() {
  const [activeView, setActiveView] = useState<AppView>('event-editor')
  const [activeStep, setActiveStep] = useState<EventEditorStepId>(7)

  // ==================== 📦 各種状態（State）の管理 ====================

  // 現在は単一イベント・単一Stageだけを画面で扱う
  const [currentEvent, setCurrentEvent] = useState<TimetableEvent>(initialEvent)
  const [stages, setStages] = useState<Stage[]>([initialStage])
  const currentStage = stages.find(stage => stage.id === CURRENT_STAGE_ID) ?? initialStage

  // 1️⃣ サークル員データベース（初期データ）
  const [members, setMembers] = useState<Member[]>(initialMembers)

  // 2️⃣ バンドデータベース（初期データ）
  const [bands, setBands] = useState<Band[]>([
    { id: 'b-1', name: 'あおぞら', defaultMemberIds: ['m-1', 'm-2', 'm-3'], defaultDurationMinutes: 15, active: true },
    { id: 'b-2', name: '夕焼けコーラス', defaultMemberIds: ['m-4', 'm-1'], defaultDurationMinutes: 10, active: true },
  ])

  // 3️⃣ このイベントに出演するバンド
  const [eventBands, setEventBands] = useState<EventBand[]>(initialEventBands)

  // 4️⃣ 当日のタイムテーブル。出演項目はEventBandをIDで参照する
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>(initialScheduleItems)

  // ✍️ 各種フォームの入力状態
  const [newMemberName, setNewMemberName] = useState('')
  const [newBandName, setNewBandName] = useState('')
  const [newBandDuration, setNewBandDuration] = useState<number>(15)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])

  const [selectedMasterBandId, setSelectedMasterBandId] = useState('')
  const [breakDuration, setBreakDuration] = useState<number>(10)

  const startTime = currentStage.plannedStartTime
  const intervalTime = currentStage.transitionMinutes ?? currentEvent.defaultTransitionMinutes
  const currentStageScheduleItems = getStageScheduleItems(scheduleItems, currentStage.id)
  const poolEventBands = getUnscheduledEventBands(eventBands, scheduleItems)

  // ==================== 🛠️ データベース（マスタ）操作ロジック ====================

  const handleRegisterMember = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!newMemberName.trim()) return
    const newMember: Member = { id: createId('member'), realName: newMemberName.trim(), active: true }
    setMembers([...members, newMember])
    setNewMemberName('')
  }

  const handleRegisterMasterBand = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!newBandName.trim() || newBandDuration <= 0) return
    const newBand: Band = {
      id: createId('band'),
      name: newBandName.trim(),
      defaultMemberIds: selectedMemberIds,
      defaultDurationMinutes: newBandDuration,
      active: true,
    }
    setBands([...bands, newBand])
    setNewBandName('')
    setNewBandDuration(15)
    setSelectedMemberIds([])
  }

  const handleToggleMemberSelection = (memberId: string) => {
    setSelectedMemberIds(prev => prev.includes(memberId) ? prev.filter(id => id !== memberId) : [...prev, memberId])
  }

  const handleStageStartTimeChange = (value: string) => {
    if (!isValidLocalTime(value)) return

    setStages(prev => prev.map(stage => (
      stage.id === currentStage.id
        ? { ...stage, plannedStartTime: value }
        : stage
    )))
  }

  // ==================== 🎴 プール・タイムテーブル操作ロジック ====================

  const handleAddSelectedBandToPool = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const targetMaster = bands.find(b => b.id === selectedMasterBandId)
    if (!targetMaster) return

    const newEventBand: EventBand = {
      id: createId('event-band'),
      eventId: currentEvent.id,
      eventDayId: currentStage.eventDayId,
      bandId: targetMaster.id,
      memberIds: [...targetMaster.defaultMemberIds],
      durationMinutes: targetMaster.defaultDurationMinutes,
    }
    setEventBands(prev => [...prev, newEventBand])
  }

  const handleAddBreak = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (breakDuration <= 0) return
    const newBreakItem: BreakScheduleItem = {
      id: createId('schedule-break'),
      stageId: currentStage.id,
      order: currentStageScheduleItems.length,
      kind: 'break',
      title: '☕ 休憩',
      durationMinutes: breakDuration,
    }
    setScheduleItems(prev => insertStageScheduleItem(
      prev,
      currentStage.id,
      newBreakItem,
      currentStageScheduleItems.length,
    ))
    setBreakDuration(10)
  }

  const handleDeletePoolEventBand = (id: string) => {
    setEventBands(prev => prev.filter(eventBand => eventBand.id !== id))
  }

  // メンバー削除（登録ミスに対応）
  const handleDeleteMember = (id: string) => {
    setMembers(prev => prev.filter(m => m.id !== id))
    // BandとEventBandのメンバー参照は既存挙動に合わせてそのまま残す
  }

  // 演奏項目を削除すると、参照先のEventBandが算出プールへ戻る。休憩はそのまま削除する
  const handleRemoveScheduleItem = (id: string) => {
    setScheduleItems(prev => removeScheduleItem(prev, id))
  }

  // ==================== 🔀 安全なドラッグ＆ドロップ処理 ====================
  const handleOnDragEnd = (result: DropResult) => {
    const { source, destination } = result
    if (!destination) return

    const sourceId = source.droppableId
    const destId = destination.droppableId
    const sourceIndex = source.index
    const destinationIndex = destination.index

    // 同じエリア内ではIDを維持したまま表示順だけを更新する
    if (sourceId === destId) {
      if (sourceId === 'pool-list') {
        setEventBands(prev => reorderUnscheduledEventBands(
          prev,
          scheduleItems,
          sourceIndex,
          destinationIndex,
        ))
      } else {
        setScheduleItems(prev => reorderStageScheduleItems(
          prev,
          currentStage.id,
          sourceIndex,
          destinationIndex,
        ))
      }
      return
    }

    // EventBandをタイムテーブルへ配置するときだけScheduleItemを新規作成する
    if (sourceId === 'pool-list' && destId === 'timetable-list') {
      const eventBand = poolEventBands[sourceIndex]
      if (!eventBand) return

      const newScheduleItem: PerformanceScheduleItem = {
        id: createId('schedule-performance'),
        stageId: currentStage.id,
        order: destinationIndex,
        kind: 'performance',
        eventBandId: eventBand.id,
      }

      setScheduleItems(prev => insertStageScheduleItem(
        prev,
        currentStage.id,
        newScheduleItem,
        destinationIndex,
      ))
      return
    }

    // 演奏項目を外すとEventBandが再び算出プールへ現れる。休憩はプールへ移動しない
    if (sourceId === 'timetable-list' && destId === 'pool-list') {
      const scheduleItem = currentStageScheduleItems[sourceIndex]
      if (!scheduleItem || scheduleItem.kind === 'break') return

      const remainingScheduleItems = removeScheduleItem(scheduleItems, scheduleItem.id)
      setScheduleItems(remainingScheduleItems)
      setEventBands(prev => {
        const poolAfterRemoval = getUnscheduledEventBands(prev, remainingScheduleItems)
        const returnedEventBandIndex = poolAfterRemoval.findIndex(
          eventBand => eventBand.id === scheduleItem.eventBandId,
        )
        if (returnedEventBandIndex < 0) return prev

        return reorderUnscheduledEventBands(
          prev,
          remainingScheduleItems,
          returnedEventBandIndex,
          destinationIndex,
        )
      })
    }
  }

  const getMemberNamesByIds = (ids?: string[]) => {
    if (!ids) return '未登録'
    return ids.map(id => members.find(m => m.id === id)?.realName || '不明').join(', ')
  }

  const getBandNameByEventBand = (eventBand?: EventBand) => {
    if (!eventBand) return '不明なバンド'
    return bands.find(band => band.id === eventBand.bandId)?.name ?? '不明なバンド'
  }

  // Timeline engineの計算結果を、現在の表示に必要な参照と組み合わせる
  const currentStageScheduleItemsById = new Map(
    currentStageScheduleItems.map(scheduleItem => [scheduleItem.id, scheduleItem]),
  )
  const calculatedItems = calculateStageTimeline({
    event: currentEvent,
    stage: currentStage,
    sections: initialSections,
    scheduleItems,
    eventBands,
  })
  const scheduleIssues = detectScheduleIssues({
    event: currentEvent,
    eventMembers: initialEventMembers,
    eventMemberDays: initialEventMemberDays,
    eventBands,
    calculatedItems,
  })
  const highestSeverityByScheduleItem =
    getHighestSeverityByScheduleItem(scheduleIssues)
  const calculatedTimetable = calculatedItems.map(calculatedItem => {
    const scheduleItem = currentStageScheduleItemsById.get(calculatedItem.scheduleItemId)
    if (!scheduleItem) {
      throw new Error(`ScheduleItem not found: ${calculatedItem.scheduleItemId}`)
    }

    const eventBand = scheduleItem.kind === 'performance'
      ? getEventBandById(eventBands, scheduleItem.eventBandId)
      : undefined
    const durationMinutes = calculatedItem.plannedEndMinute - calculatedItem.plannedStartMinute

    return {
      scheduleItem,
      eventBand,
      durationMinutes,
      timeString: `${formatMinuteAsLocalTime(calculatedItem.plannedStartMinute)} 〜 ${formatMinuteAsLocalTime(calculatedItem.plannedEndMinute)}`,
    }
  })

  // 共通スタイル定義（可読性向上のためまとめる）
  const containerStyle: React.CSSProperties = { maxWidth: '1250px', margin: '0 auto', textAlign: 'left' }
  const sectionBase: React.CSSProperties = { padding: '15px', borderRadius: '8px', marginBottom: '20px' }
  const sectionLargeBase: React.CSSProperties = { padding: '20px', borderRadius: '12px', marginBottom: '25px' }
  const panelStyle: React.CSSProperties = { background: '#fff', padding: '15px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }
  const baseButton: React.CSSProperties = { border: 'none', padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }
  const listItemBase: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', marginBottom: '8px', borderRadius: '4px', color: '#333', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }
  const listContainerBase: React.CSSProperties = { listStyle: 'none', minHeight: '300px', padding: '10px', borderRadius: '8px', border: '2px dashed #cbd5e0' }
  const badgeStyle: React.CSSProperties = { background: '#edf2f7', padding: '4px 8px', borderRadius: '12px', fontSize: '13px' }

  return (
    <AppShell
      activeSection={activeView === 'event-editor' ? 'events' : activeView}
      onNavigate={(section) => setActiveView(section)}
    >
      {activeView === 'event-editor' ? (
        <EventEditorShell
          eventName={currentEvent.name}
          activeStep={activeStep}
          onStepChange={setActiveStep}
          onBackToEvents={() => setActiveView('events')}
        >
          <div className="timetable-workspace" style={containerStyle}>

      {/* ==================== 🗃️ データベース（マスタ）管理 ==================== */}
      <section style={{ ...sectionLargeBase, background: '#f7fafc', border: '1px solid #e2e8f0', color: '#2d3748' }}>
        <h2 style={{ marginTop: 0, borderBottom: '2px solid #cbd5e0', paddingBottom: '8px' }}>🗃️ 1. データベース（マスタ）管理</h2>
        
        <div className="timetable-master-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '30px', marginTop: '15px' }}>
          <div style={panelStyle}>
            <h3 style={{ marginTop: 0 }}>👥 サークル員の登録</h3>
            <form onSubmit={handleRegisterMember} style={{ display: 'flex', gap: '8px', marginBottom: '15px' }}>
              <input type="text" aria-label="サークル員氏名" placeholder="氏名（例: 山田）" value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <button type="submit" style={{ ...baseButton, background: '#4a5568', color: '#fff', padding: '8px 12px' }}>登録</button>
            </form>
            <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #edf2f7', padding: '8px', borderRadius: '4px' }}>
              <strong>現在のサークル員一覧 ({members.length}名):</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                {members.map(m => (
                  <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginRight: '6px' }}>
                    <span style={badgeStyle}>{m.realName}</span>
                    <button onClick={() => handleDeleteMember(m.id)} aria-label={`delete-${m.realName}`} style={{ ...baseButton, background: '#fff', color: '#e53e3e', padding: '4px 6px', borderRadius: '6px', fontSize: '12px' }}>×</button>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={{ marginTop: 0 }}>🎸 固定バンドの登録</h3>
            <form onSubmit={handleRegisterMasterBand} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div>
                <div style={{ marginBottom: '10px' }}>
                  <input type="text" aria-label="登録するバンド名" placeholder="バンド名" value={newBandName} onChange={(e) => setNewBandName(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 'bold' }}>デフォルト演奏時間 (分):</label>
                  <input type="number" aria-label="デフォルト演奏時間" value={newBandDuration} onChange={(e) => setNewBandDuration(Number(e.target.value))} style={{ ...inputStyle, marginTop: '4px' }} />
                </div>
                <button type="submit" style={{ ...baseButton, width: '100%', background: '#3182ce', color: '#fff', padding: '10px', marginTop: '15px' }}>データベースに保存</button>
              </div>
              <div>
                <label style={{ fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '6px' }}>👥 所属メンバーを選択:</label>
                <div style={{ maxHeight: '110px', overflowY: 'auto', border: '1px solid #ccc', padding: '8px', borderRadius: '4px' }}>
                  {members.map(m => (
                    <label key={m.id} style={{ display: 'block', fontSize: '13px', marginBottom: '4px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={selectedMemberIds.includes(m.id)} onChange={() => handleToggleMemberSelection(m.id)} style={{ marginRight: '6px' }} />
                      {m.realName}
                    </label>
                  ))}
                </div>
              </div>
            </form>
          </div>
        </div>
      </section>

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
            <input type="number" aria-label="転換時間" value={intervalTime} onChange={(e) => setCurrentEvent(prev => ({ ...prev, defaultTransitionMinutes: Number(e.target.value) }))} style={{ padding: '6px', width: '60px', marginTop: '5px' }} />
          </div>
        </div>
      </section>

      {/* ==================== 🎴 ドラッグ＆ドロップ編成 ==================== */}
      <DragDropContext onDragEnd={handleOnDragEnd}>
        <div className="timetable-board" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
          
          {/* 📁 左画面：出演候補プール */}
          <div>
            <section style={{ background: '#e2e8f0', padding: '15px', borderRadius: '8px', color: '#333', marginBottom: '20px' }}>
              <h3 style={{ marginTop: 0 }}>📥 DBからプールに追加</h3>
              <form onSubmit={handleAddSelectedBandToPool} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold' }}>登録済みバンドから選択:</label>
                  <select aria-label="プールに追加するバンドを選択" value={selectedMasterBandId} onChange={(e) => setSelectedMasterBandId(e.target.value)} style={{ ...inputStyle, marginTop: '5px' }}>
                    <option value="">-- バンドを選択 --</option>
                    {bands.map(b => (
                      <option key={b.id} value={b.id}>{b.name} ({b.defaultDurationMinutes}分 / 👥 {getMemberNamesByIds(b.defaultMemberIds)})</option>
                    ))}
                  </select>
                </div>
                <button type="submit" disabled={!selectedMasterBandId} style={{ background: '#4a5568', color: 'white', padding: '8px 16px', border: 'none', borderRadius: '4px', cursor: selectedMasterBandId ? 'pointer' : 'not-allowed', fontWeight: 'bold', height: '37px' }}>追加</button>
              </form>
            </section>

            <h3>📁 出演候補バンド一覧（プール）</h3>
            <Droppable droppableId="pool-list">
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef} style={{ ...listContainerBase, background: '#f7fafc' }}>
                  {poolEventBands.map((eventBand, index) => (
                    <Draggable key={eventBand.id} draggableId={eventBand.id} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={{ ...listItemBase, background: '#fff', ...provided.draggableProps.style }}>
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold' }}>🎵 {getBandNameByEventBand(eventBand)}</span> ({eventBand.durationMinutes}分)
                            <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px' }}>👥 メンバー: {getMemberNamesByIds(eventBand.memberIds)}</div>
                          </div>
                          <button onClick={() => handleDeletePoolEventBand(eventBand.id)} style={{ ...baseButton, background: '#edf2f7', color: '#e53e3e', padding: '4px 8px', fontSize: '12px' }}>完全に消す</button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
          </div>

          {/* 📅 右画面：当日のタイムテーブル */}
          <div>
            <section style={{ ...sectionBase, background: '#e6fffa', color: '#234e52' }}>
              <h3 style={{ marginTop: 0 }}>☕ 休憩枠を直接差し込む</h3>
              <form onSubmit={handleAddBreak} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold' }}>休憩時間 (分):</label>
                  <input type="number" aria-label="休憩時間" value={breakDuration} onChange={(e) => setBreakDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', marginTop: '5px', boxSizing: 'border-box' }} />
                </div>
                <button type="submit" style={{ background: '#319795', color: 'white', padding: '8px 16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', height: '37px' }}>休憩を追加</button>
              </form>
            </section>

            <h3>📅 当日のタイムテーブル</h3>
            <Droppable droppableId="timetable-list">
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef} style={{ ...listContainerBase, background: '#edf2f7' }}>
                  {calculatedTimetable.map(({ scheduleItem, eventBand, durationMinutes, timeString }, index) => {
                    const issueSeverity = highestSeverityByScheduleItem.get(scheduleItem.id)

                    return (
                      <Draggable key={scheduleItem.id} draggableId={scheduleItem.id} index={index}>
                        {(provided) => (
                          <li
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            className={issueSeverity
                              ? `schedule-item schedule-item--${issueSeverity.toLowerCase()}`
                              : 'schedule-item'}
                            style={{ ...listItemBase, background: scheduleItem.kind === 'break' ? '#e6fffa' : '#fff', ...provided.draggableProps.style }}
                          >
                            <div>
                              <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                              <span style={{ fontWeight: 'bold', marginRight: '15px', color: scheduleItem.kind === 'break' ? '#319795' : '#007acc' }}>⏰ {timeString}</span>
                              <span>{scheduleItem.kind === 'break' ? '☕' : '🎵'} {scheduleItem.kind === 'break' ? scheduleItem.title : getBandNameByEventBand(eventBand)} ({durationMinutes}分)</span>
                              {issueSeverity && (
                                <span className={`schedule-item__issue-label schedule-item__issue-label--${issueSeverity.toLowerCase()}`}>
                                  {issueSeverity}
                                </span>
                              )}
                              {scheduleItem.kind === 'performance' && <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px', marginLeft: '43px' }}>👥 {getMemberNamesByIds(eventBand?.memberIds)}</div>}
                            </div>
                            <button onClick={() => handleRemoveScheduleItem(scheduleItem.id)} style={{ ...baseButton, background: '#e53e3e', color: 'white', padding: '6px 12px', fontSize: '13px' }}>外す</button>
                          </li>
                        )}
                      </Draggable>
                    )
                  })}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
            <IssuePanel
              issues={scheduleIssues}
              members={members}
              bands={bands}
              eventBands={eventBands}
              stages={stages}
              calculatedItems={calculatedItems}
            />
          </div>

        </div>
      </DragDropContext>
          </div>
        </EventEditorShell>
      ) : (
        <AppSectionPlaceholder
          title={appSectionPlaceholders[activeView].title}
          description={appSectionPlaceholders[activeView].description}
          actionLabel={activeView === 'events' ? '現在のイベントを開く' : undefined}
          onAction={activeView === 'events'
            ? () => setActiveView('event-editor')
            : undefined}
        />
      )}
    </AppShell>
  )
}

export default App
