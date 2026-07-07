import { useState, type FormEvent } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd'
import './App.css'

// 🎴 タイムテーブル・プールに入る共通の型
interface TimetableItem {
  id: string;
  type: 'band' | 'break';
  name: string;
  duration: number;
  members?: string[]; // 👈 次のアラート機能を見据えて、今のうちにメンバーを保持できるように拡張！
}

function App() {
  // 💾 ① 出演候補バンドのデータベース（左側プール）
  const [poolItems, setPoolItems] = useState<TimetableItem[]>([
    { id: 'pool-1', type: 'band', name: 'あおぞら', duration: 15, members: ['佐藤', '鈴木', '高橋'] },
    { id: 'pool-2', type: 'band', name: '夕焼けコーラス', duration: 10, members: ['田中', '伊藤'] },
    { id: 'pool-3', type: 'band', name: 'みなみかぜ', duration: 12, members: ['渡辺', '中村'] }
  ])

  // 📅 ② 当日のタイムテーブル（右側エリア）
  const [timetableItems, setTimetableItems] = useState<TimetableItem[]>([
    { id: 'time-break-1', type: 'break', name: '中間休憩', duration: 10 }
  ])

  // 入力フォームの状態管理
  const [inputName, setInputName] = useState('')
  const [inputDuration, setInputDuration] = useState<number>(15)
  const [inputMembers, setInputMembers] = useState('') // 👈 メンバーをカンマ区切りで入力する用
  const [breakDuration, setBreakDuration] = useState<number>(10)

  // スケジュール設定
  const [startTime, setStartTime] = useState('13:00')
  const [intervalTime, setIntervalTime] = useState(2)

  // ➕ 出演候補プールにバンドを新規登録する
  const handleRegisterPool = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!inputName || inputDuration <= 0) return

    // 「佐藤, 鈴木」のような入力をトリミングして ['佐藤', '鈴木'] という配列にする
    const memberArray = inputMembers
      ? inputMembers.split(',').map(m => m.trim()).filter(m => m !== '')
      : []

    const newPoolItem: TimetableItem = {
      id: `pool-${Date.now()}`,
      type: 'band',
      name: inputName,
      duration: inputDuration,
      members: memberArray
    }

    setPoolItems([...poolItems, newPoolItem])
    setInputName('')
    setInputDuration(15)
    setInputMembers('')
  }

  // ☕ タイムテーブルに「休憩」を直接追加する
  const handleAddBreak = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (breakDuration <= 0) return

    const newBreakItem: TimetableItem = {
      id: `break-${Date.now()}`,
      type: 'break',
      name: '☕ 休憩',
      duration: breakDuration
    }

    setTimetableItems([...timetableItems, newBreakItem])
    setBreakDuration(10)
  }

  // 🗑️ プール（左）からバンドを完全に削除する
  const handleDeletePoolItem = (id: string) => {
    setPoolItems((prev) => prev.filter((item) => item.id !== id))
  }

  // 🗑️ タイムテーブル（右）から枠を外す
  const handleDeleteTimetableItem = (id: string) => {
    setTimetableItems((prev) => prev.filter((item) => item.id !== id))
  }

  // 🎴 2つのエリア間（プール ↔ タイムテーブル）のドラッグ＆ドロップ処理
  const handleOnDragEnd = (result: DropResult) => {
    const { source, destination } = result
    if (!destination) return

    // 先に安全にインデックスとエリアのIDを定数に展開（TSエラー対策を応用！）
    const sourceId = source.droppableId
    const destId = destination.droppableId
    const sourceIndex = source.index
    const destinationIndex = destination.index

    // 1. 同じエリア内での並び替えの場合
    if (sourceId === destId) {
      if (sourceId === 'pool-list') {
        setPoolItems((prev) => {
          const reordered = Array.from(prev)
          const [removed] = reordered.splice(sourceIndex, 1)
          reordered.splice(destinationIndex, 0, removed)
          return reordered
        })
      } else {
        setTimetableItems((prev) => {
          const reordered = Array.from(prev)
          const [removed] = reordered.splice(sourceIndex, 1)
          reordered.splice(destinationIndex, 0, removed)
          return reordered
        })
      }
      return
    }

    // 2. 違うエリア間（プール ↔ タイムテーブル）の移動の場合
    const srcList = sourceId === 'pool-list' ? Array.from(poolItems) : Array.from(timetableItems)
    const destList = destId === 'pool-list' ? Array.from(poolItems) : Array.from(timetableItems)
    
    const [removed] = srcList.splice(sourceIndex, 1)

    // 移動先のエリアに応じて、IDが重複しないように新しく一意のIDを割り当てる
    if (destId === 'timetable-list') {
      removed.id = `time-band-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    } else {
      removed.id = `pool-band-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    }

    destList.splice(destinationIndex, 0, removed)

    // 両方の状態（State）をまとめて更新
    if (sourceId === 'pool-list') {
      setPoolItems(srcList)
      setTimetableItems(destList)
    } else {
      setTimetableItems(srcList)
      setPoolItems(destList)
    }
  }

  // 🕒 タイムテーブル側の時間を自動計算する関数
  const calculateTimeline = () => {
    const [startHour, startMin] = startTime.split(':').map(Number)
    let currentTotalMinutes = startHour * 60 + startMin

    return timetableItems.map((item) => {
      const startMinRaw = currentTotalMinutes
      const endMinRaw = currentTotalMinutes + item.duration

      if (item.type === 'band') {
        currentTotalMinutes = endMinRaw + intervalTime
      } else {
        currentTotalMinutes = endMinRaw
      }

      const formatTime = (totalMinutes: number) => {
        const h = Math.floor(totalMinutes / 60) % 24
        const m = totalMinutes % 60
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      }

      return {
        ...item,
        timeString: `${formatTime(startMinRaw)} 〜 ${formatTime(endMinRaw)}`
      }
    })
  }

  const calculatedTimetable = calculateTimeline()

  return (
    <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', textAlign: 'left' }}>
      <h1>🎤 アカペラ タイムテーブル 総合管理システム</h1>

      {/* ⚙️ スケジュール基本設定 */}
      <section style={{ background: '#edf2f7', padding: '15px', borderRadius: '8px', marginBottom: '20px', color: '#2d3748' }}>
        <h3 style={{ marginTop: 0 }}>⚙️ スケジュール基本設定</h3>
        <div style={{ display: 'flex', gap: '20px' }}>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>イベント開始時刻:</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={{ padding: '6px', marginTop: '5px' }} />
          </div>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>転換時間 (分):</label>
            <input type="number" value={intervalTime} onChange={(e) => setIntervalTime(Number(e.target.value))} style={{ padding: '6px', width: '60px', marginTop: '5px' }} />
          </div>
        </div>
      </section>

      {/* 🛠️ ドラッグ＆ドロップ全体のコンテキスト（2つのエリアを統括） */}
      <DragDropContext onDragEnd={handleOnDragEnd}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
          
          {/* ==================== 📁 左画面：出演バンドプール ==================== */}
          <div>
            <section style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px', color: '#333', marginBottom: '20px' }}>
              <h3 style={{ marginTop: 0 }}>➕ バンドをプールに登録</h3>
              <form onSubmit={handleRegisterPool}>
                <div style={{ marginBottom: '10px' }}>
                  <input type="text" placeholder="バンド名" value={inputName} onChange={(e) => setInputName(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <input type="text" placeholder="メンバー名（カンマ区切り。例: 山田, 佐藤, 鈴木）" value={inputMembers} onChange={(e) => setInputMembers(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold' }}>演奏時間 (分):</label>
                  <input type="number" value={inputDuration} onChange={(e) => setInputDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
                </div>
                <button type="submit" style={{ width: '100%', background: '#4a5568', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>プールに登録</button>
              </form>
            </section>

            <h3>📁 出演候補バンド一覧（プール）</h3>
            <Droppable droppableId="pool-list">
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef} style={{ listStyle: 'none', minHeight: '300px', background: '#f7fafc', padding: '10px', borderRadius: '8px', border: '2px dashed #cbd5e0' }}>
                  {poolItems.map((item, index) => (
                    <Draggable key={item.id} draggableId={item.id} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: '#fff', marginBottom: '8px', borderRadius: '4px', color: '#333', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', ...provided.draggableProps.style }}>
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold' }}>🎵 {item.name}</span> ({item.duration}分)
                            <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px' }}>👥 メンバー: {item.members?.join(', ') || '未登録'}</div>
                          </div>
                          <button onClick={() => handleDeletePoolItem(item.id)} style={{ background: '#edf2f7', color: '#e53e3e', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>完全に消す</button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
          </div>

          {/* ==================== 📅 右画面：当日のタイムテーブル ==================== */}
          <div>
            <section style={{ background: '#e6fffa', padding: '15px', borderRadius: '8px', color: '#234e52', marginBottom: '20px' }}>
              <h3 style={{ marginTop: 0 }}>☕ 休憩枠を直接差し込む</h3>
              <form onSubmit={handleAddBreak} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 'bold' }}>休憩時間 (分):</label>
                  <input type="number" value={breakDuration} onChange={(e) => setBreakDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', marginTop: '5px', boxSizing: 'border-box' }} />
                </div>
                <button type="submit" style={{ background: '#319795', color: 'white', padding: '8px 16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', height: '37px' }}>休憩を追加</button>
              </form>
            </section>

            <h3>📅 当日のタイムテーブル（左からここへドラッグ！）</h3>
            <Droppable droppableId="timetable-list">
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef} style={{ listStyle: 'none', minHeight: '300px', background: '#edf2f7', padding: '10px', borderRadius: '8px', border: '2px dashed #cbd5e0' }}>
                  {calculatedTimetable.map((item, index) => (
                    <Draggable key={item.id} draggableId={item.id} index={index}>
                      {(provided) => (
                        <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: item.type === 'break' ? '#e6fffa' : '#fff', marginBottom: '8px', borderRadius: '4px', color: '#333', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', ...provided.draggableProps.style }}>
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold', marginRight: '15px', color: item.type === 'break' ? '#319795' : '#007acc' }}>⏰ {item.timeString}</span>
                            <span>{item.type === 'break' ? '☕' : '🎵'} {item.name} ({item.duration}分)</span>
                            {item.type === 'band' && <div style={{ fontSize: '11px', color: '#718096', marginTop: '4px', marginLeft: '43px' }}>👥 {item.members?.join(', ')}</div>}
                          </div>
                          <button onClick={() => handleDeleteTimetableItem(item.id)} style={{ background: '#e53e3e', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>外す</button>
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