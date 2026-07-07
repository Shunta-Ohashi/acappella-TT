import { useState, type FormEvent } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd'
import './App.css'

// ==================== 💾 データベース（マスタ）の型定義 ====================

// ① サークル員マスタの型
interface Member {
  id: string;
  name: string;
}

// ② バンドマスタの型
interface MasterBand {
  id: string;
  name: string;
  memberIds: string[]; // 👥 サークル員IDの配列
  defaultDuration: number;
}

// ③ タイムテーブル・プールに入るアイテムの型
interface TimetableItem {
  id: string;
  type: 'band' | 'break';
  name: string;
  duration: number;
  memberIds?: string[]; // 👈 名前ではなくIDの配列で管理！
}

function App() {
  // ==================== 📦 各種状態（State）の管理 ====================

  // 1️⃣ サークル員データベース（初期データ）
  const [members, setMembers] = useState<Member[]>([
    { id: 'm-1', name: '佐藤' },
    { id: 'm-2', name: '鈴木' },
    { id: 'm-3', name: '高橋' },
    { id: 'm-4', name: '田中' },
  ])

  // 2️⃣ バンドデータベース（初期データ）
  const [masterBands, setMasterBands] = useState<MasterBand[]>([
    { id: 'b-1', name: 'あおぞら', memberIds: ['m-1', 'm-2', 'm-3'], defaultDuration: 15 },
    { id: 'b-2', name: '夕焼けコーラス', memberIds: ['m-4', 'm-1'], defaultDuration: 10 },
  ])

  // 3️⃣ 出演候補バンドのプール（左側）
  const [poolItems, setPoolItems] = useState<TimetableItem[]>([
    { id: 'pool-band-1', type: 'band', name: 'あおぞら', duration: 15, memberIds: ['m-1', 'm-2', 'm-3'] }
  ])

  // 4️⃣ 当日のタイムテーブル（右側）
  const [timetableItems, setTimetableItems] = useState<TimetableItem[]>([
    { id: 'time-break-1', type: 'break', name: '中間休憩', duration: 10 }
  ])

  // ✍️ 各種フォームの入力状態
  const [newMemberName, setNewMemberName] = useState('')
  const [newBandName, setNewBandName] = useState('')
  const [newBandDuration, setNewBandDuration] = useState<number>(15)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])

  const [selectedMasterBandId, setSelectedMasterBandId] = useState('')
  const [breakDuration, setBreakDuration] = useState<number>(10)

  const [startTime, setStartTime] = useState('13:00')
  const [intervalTime, setIntervalTime] = useState(2)

  // ==================== 🛠️ データベース（マスタ）操作ロジック ====================

  const handleRegisterMember = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!newMemberName.trim()) return
    const newMember: Member = { id: `m-${Date.now()}`, name: newMemberName.trim() }
    setMembers([...members, newMember])
    setNewMemberName('')
  }

  const handleRegisterMasterBand = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!newBandName.trim() || newBandDuration <= 0) return
    const newBand: MasterBand = {
      id: `b-${Date.now()}`,
      name: newBandName.trim(),
      memberIds: selectedMemberIds,
      defaultDuration: newBandDuration
    }
    setMasterBands([...masterBands, newBand])
    setNewBandName('')
    setNewBandDuration(15)
    setSelectedMemberIds([])
  }

  const handleToggleMemberSelection = (memberId: string) => {
    setSelectedMemberIds(prev => prev.includes(memberId) ? prev.filter(id => id !== memberId) : [...prev, memberId])
  }

  // ==================== 🎴 プール・タイムテーブル操作ロジック ====================

  const handleAddSelectedBandToPool = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const targetMaster = masterBands.find(b => b.id === selectedMasterBandId)
    if (!targetMaster) return

    const newPoolItem: TimetableItem = {
      id: `pool-band-${Date.now()}`,
      type: 'band',
      name: targetMaster.name,
      duration: targetMaster.defaultDuration,
      memberIds: targetMaster.memberIds
    }
    setPoolItems([...poolItems, newPoolItem])
  }

  const handleAddBreak = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (breakDuration <= 0) return
    const newBreakItem: TimetableItem = {
      id: `time-break-${Date.now()}`,
      type: 'break',
      name: '☕ 休憩',
      duration: breakDuration
    }
    setTimetableItems([...timetableItems, newBreakItem])
    setBreakDuration(10)
  }

  const handleDeletePoolItem = (id: string) => setPoolItems(prev => prev.filter(i => i.id !== id))

  // メンバー削除（登録ミスに対応）
  const handleDeleteMember = (id: string) => {
    setMembers(prev => prev.filter(m => m.id !== id))
    // もし削除したメンバーが masterBands や timetable に入っていればそのまま残す／参照はidsなので特別な処理は不要
  }

  // タイムテーブルのアイテムをプールに戻す（「外す」ボタンの新挙動）
  const handleReturnToPool = (id: string) => {
    const item = timetableItems.find(i => i.id === id)
    if (!item) return

    // 休憩枠なら完全削除、バンドならプールに戻す
    if (item.type === 'break') {
      setTimetableItems(prev => prev.filter(i => i.id !== id))
      return
    }

    // バンドをプールに戻す（新しい一意な id を生成）
    const newPoolItem: TimetableItem = {
      ...item,
      id: `pool-${item.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    }

    setTimetableItems(prev => prev.filter(i => i.id !== id))
    setPoolItems(prev => [...prev, newPoolItem])
  }

  // ==================== 🔀 安全なドラッグ＆ドロップ処理 ====================
  const handleOnDragEnd = (result: DropResult) => {
    const { source, destination } = result
    if (!destination) return

    const sourceId = source.droppableId
    const destId = destination.droppableId
    const sourceIndex = source.index
    const destinationIndex = destination.index

    // 1. 同じエリア内での並び替えの場合
    if (sourceId === destId) {
      const stateUpdater = sourceId === 'pool-list' ? setPoolItems : setTimetableItems
      stateUpdater((prev) => {
        const reordered = Array.from(prev)
        const [removed] = reordered.splice(sourceIndex, 1)
        reordered.splice(destinationIndex, 0, removed)
        return reordered
      })
      return
    }

    // 2. 違うエリア間（プール ↔ タイムテーブル）の移動の場合
    const srcList = sourceId === 'pool-list' ? Array.from(poolItems) : Array.from(timetableItems)
    const destList = destId === 'pool-list' ? Array.from(poolItems) : Array.from(timetableItems)

    const [removed] = srcList.splice(sourceIndex, 1)

    // 🌟 ご自身で追加されたガード節：休憩枠をプールへは移動させない
    if (destId === 'pool-list' && removed.type === 'break') return

    // 🌟 ご自身で追加されたStateミューテーション回避＆一意のID生成
    const idPrefix = destId === 'timetable-list' ? 'time' : 'pool'
    const movedItem: TimetableItem = {
      ...removed,
      id: `${idPrefix}-${removed.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    }

    destList.splice(destinationIndex, 0, movedItem)

    if (sourceId === 'pool-list') {
      setPoolItems(srcList)
      setTimetableItems(destList)
    } else {
      setTimetableItems(srcList)
      setPoolItems(destList)
    }
  }

  // ==================== 🕒 時間自動計算 ＆ IDから名前の変換 ====================
  const calculateTimeline = () => {
    const [startHour, startMin] = startTime.split(':').map(Number)
    let currentTotalMinutes = startHour * 60 + startMin

    return timetableItems.map((item) => {
      const startMinRaw = currentTotalMinutes
      const endMinRaw = currentTotalMinutes + item.duration
      currentTotalMinutes = item.type === 'band' ? endMinRaw + intervalTime : endMinRaw

      const formatTime = (tot: number) => {
        const h = Math.floor(tot / 60) % 24
        const m = tot % 60
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      }

      return {
        ...item,
        timeString: `${formatTime(startMinRaw)} 〜 ${formatTime(endMinRaw)}`
      }
    })
  }

  const getMemberNamesByIds = (ids?: string[]) => {
    if (!ids) return '未登録'
    return ids.map(id => members.find(m => m.id === id)?.name || '不明').join(', ')
  }

  const calculatedTimetable = calculateTimeline()

  // 共通スタイル定義（可読性向上のためまとめる）
  const containerStyle: React.CSSProperties = { padding: '20px', maxWidth: '1250px', margin: '0 auto', textAlign: 'left' }
  const sectionBase: React.CSSProperties = { padding: '15px', borderRadius: '8px', marginBottom: '20px' }
  const sectionLargeBase: React.CSSProperties = { padding: '20px', borderRadius: '12px', marginBottom: '25px' }
  const panelStyle: React.CSSProperties = { background: '#fff', padding: '15px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }
  const baseButton: React.CSSProperties = { border: 'none', padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }
  const listItemBase: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', marginBottom: '8px', borderRadius: '4px', color: '#333', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }
  const listContainerBase: React.CSSProperties = { listStyle: 'none', minHeight: '300px', padding: '10px', borderRadius: '8px', border: '2px dashed #cbd5e0' }
  const badgeStyle: React.CSSProperties = { background: '#edf2f7', padding: '4px 8px', borderRadius: '12px', fontSize: '13px' }

  return (
    <div style={containerStyle}>
      <h1>🎤 アカペラ タイムテーブル 総合管理システム</h1>

      {/* ==================== 🗃️ データベース（マスタ）管理 ==================== */}
      <section style={{ ...sectionLargeBase, background: '#f7fafc', border: '1px solid #e2e8f0', color: '#2d3748' }}>
        <h2 style={{ marginTop: 0, borderBottom: '2px solid #cbd5e0', paddingBottom: '8px' }}>🗃️ 1. データベース（マスタ）管理</h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '30px', marginTop: '15px' }}>
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
                    <span style={badgeStyle}>{m.name}</span>
                    <button onClick={() => handleDeleteMember(m.id)} aria-label={`delete-${m.name}`} style={{ ...baseButton, background: '#fff', color: '#e53e3e', padding: '4px 6px', borderRadius: '6px', fontSize: '12px' }}>×</button>
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
                      {m.name}
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
        <div style={{ display: 'flex', gap: '20px' }}>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>イベント開始時刻:</label>
            <input type="time" aria-label="イベント開始時刻" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={{ padding: '6px', marginTop: '5px' }} />
          </div>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>転換時間 (分):</label>
            <input type="number" aria-label="転換時間" value={intervalTime} onChange={(e) => setIntervalTime(Number(e.target.value))} style={{ padding: '6px', width: '60px', marginTop: '5px' }} />
          </div>
        </div>
      </section>

      {/* ==================== 🎴 ドラッグ＆ドロップ編成 ==================== */}
      <DragDropContext onDragEnd={handleOnDragEnd}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
          
          {/* 📁 左画面：出演候補プール */}
          <div>
            <section style={{ background: '#e2e8f0', padding: '15px', borderRadius: '8px', color: '#333', marginBottom: '20px' }}>
              <h3 style={{ marginTop: 0 }}>📥 DBからプールに追加</h3>
              <form onSubmit={handleAddSelectedBandToPool} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold' }}>登録済みバンドから選択:</label>
                  <select aria-label="プールに追加するバンドを選択" value={selectedMasterBandId} onChange={(e) => setSelectedMasterBandId(e.target.value)} style={{ ...inputStyle, marginTop: '5px' }}>
                    <option value="">-- バンドを選択 --</option>
                    {masterBands.map(b => (
                      <option key={b.id} value={b.id}>{b.name} ({b.defaultDuration}分 / 👥 {getMemberNamesByIds(b.memberIds)})</option>
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
                  {poolItems.map((item, index) => (
                    <Draggable key={item.id} draggableId={item.id} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={{ ...listItemBase, background: '#fff', ...provided.draggableProps.style }}>
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold' }}>🎵 {item.name}</span> ({item.duration}分)
                            <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px' }}>👥 メンバー: {getMemberNamesByIds(item.memberIds)}</div>
                          </div>
                          <button onClick={() => handleDeletePoolItem(item.id)} style={{ ...baseButton, background: '#edf2f7', color: '#e53e3e', padding: '4px 8px', fontSize: '12px' }}>完全に消す</button>
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
                  {calculatedTimetable.map((item, index) => (
                    <Draggable key={item.id} draggableId={item.id} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={{ ...listItemBase, background: item.type === 'break' ? '#e6fffa' : '#fff', ...provided.draggableProps.style }}>
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold', marginRight: '15px', color: item.type === 'break' ? '#319795' : '#007acc' }}>⏰ {item.timeString}</span>
                            <span>{item.type === 'break' ? '☕' : '🎵'} {item.name} ({item.duration}分)</span>
                            {item.type === 'band' && <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px', marginLeft: '43px' }}>👥 {getMemberNamesByIds(item.memberIds)}</div>}
                          </div>
                          <button onClick={() => handleReturnToPool(item.id)} style={{ ...baseButton, background: '#e53e3e', color: 'white', padding: '6px 12px', fontSize: '13px' }}>外す</button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
          </div>

        </div>
      </DragDropContext>
    </div>
  )
}

export default App