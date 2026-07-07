import { useState, type FormEvent } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd'
import './App.css'

// 🎴 タイムテーブルに入る共通の型（バンドか休憩かを選べるようにする）
interface TimetableItem {
  id: string; // Date.now()などを文字列にして保持
  type: 'band' | 'break'; // 👈 目印
  name: string; // バンド名、または「休憩」などの文字
  duration: number; // 時間（分）
}

function App() {
  // バンドと休憩を一つのリストで管理（初期データに休憩も入れておきます）
  const [items, setItems] = useState<TimetableItem[]>([
    { id: '1', type: 'band', name: 'あおぞら（仮のバンド名）', duration: 15 },
    { id: '2', type: 'break', name: '中間休憩', duration: 10 },
    { id: '3', type: 'band', name: '夕焼けコーラス', duration: 10 }
  ])

  // 入力フォームの状態管理
  const [inputName, setInputName] = useState('')
  const [inputDuration, setInputDuration] = useState<number>(15)
  const [breakDuration, setBreakDuration] = useState<number>(10) // 👈 休憩時間入力用

  // スケジュール設定
  const [startTime, setStartTime] = useState('13:00')
  const [intervalTime, setIntervalTime] = useState(2)

  // ➕ バンドを追加する動き
  const handleAddBand = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!inputName || inputDuration <= 0) return

    const newItem: TimetableItem = {
      id: `band-${Date.now()}`,
      type: 'band',
      name: inputName,
      duration: inputDuration
    }

    setItems([...items, newItem])
    setInputName('')
    setInputDuration(15)
  }

  // ☕ 休憩を追加する動き
  const handleAddBreak = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (breakDuration <= 0) return

    const newItem: TimetableItem = {
      id: `break-${Date.now()}`,
      type: 'break',
      name: '☕ 休憩', // 固定のタイトル、またはカスタムできるようにしてもOK
      duration: breakDuration
    }

    setItems([...items, newItem])
    setBreakDuration(10) // 追加後は10分に戻す
  }

  // 🗑️ 削除の動き（バンドも休憩もまとめて削除可能）
  const handleDeleteItem = (id: string) => {
    setItems((prevItems) => prevItems.filter((item) => item.id !== id))
  }

  // 🎴 ドラッグが終わったときの動き
  const handleOnDragEnd = (result: DropResult) => {
    if (!result.destination) return

    const sourceIndex = result.source.index
    const destinationIndex = result.destination.index

    setItems((prevItems) => {
      const reorderedItems = Array.from(prevItems)
      const [removed] = reorderedItems.splice(sourceIndex, 1)
      reorderedItems.splice(destinationIndex, 0, removed)
      return reorderedItems
    })
  }

  // 🕒 タイムテーブルを自動計算する関数
  const calculateTimeline = () => {
    const [startHour, startMin] = startTime.split(':').map(Number)
    let currentTotalMinutes = startHour * 60 + startMin

    return items.map((item) => {
      const startMinRaw = currentTotalMinutes
      const endMinRaw = currentTotalMinutes + item.duration

      // 💡 転換時間の計算ロジック：
      // いま処理しているのが「バンド」のときだけ、後ろに転換時間（intervalTime分）を加算する
      // （休憩の直後は転換時間を加算しない）
      if (item.type === 'band') {
        currentTotalMinutes = endMinRaw + intervalTime
      } else {
        currentTotalMinutes = endMinRaw // 休憩の後はそのまま次の時間に繋ぐ
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

  const calculatedItems = calculateTimeline()

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', textAlign: 'left' }}>
      <h1>🎤 アカペラ タイムテーブル作成</h1>

      {/* ⚙️ スケジュール基本設定 */}
      <section style={{ background: '#edf2f7', padding: '15px', borderRadius: '8px', marginBottom: '20px', color: '#2d3748' }}>
        <h3>⚙️ スケジュール基本設定</h3>
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
      
      {/* 📥 フォームエリア（横並びに変更） */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
        {/* バンド追加フォーム */}
        <section style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px', color: '#333' }}>
          <h3 style={{ marginTop: 0 }}>➕ バンドの追加</h3>
          <form onSubmit={handleAddBand}>
            <div style={{ marginBottom: '10px' }}>
              <input type="text" placeholder="バンド名" value={inputName} onChange={(e) => setInputName(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>演奏時間 (分):</label>
              <input type="number" value={inputDuration} onChange={(e) => setInputDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
            <button type="submit" style={{ width: '100%', background: '#007acc', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>追加</button>
          </form>
        </section>

        {/* ☕ 休憩追加フォーム */}
        <section style={{ background: '#e6fffa', padding: '15px', borderRadius: '8px', color: '#234e52' }}>
          <h3 style={{ marginTop: 0 }}>☕ 休憩の追加</h3>
          <form onSubmit={handleAddBreak}>
            <div style={{ marginBottom: '23px' }}> {/* 高さを合わせるための余白 */}
              <span style={{ fontSize: '14px', color: '#4a5568' }}>タイムテーブルの間に挟む休憩枠を作成します。</span>
            </div>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold' }}>休憩時間 (分):</label>
              <input type="number" value={breakDuration} onChange={(e) => setBreakDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
            </div>
            <button type="submit" style={{ width: '100%', background: '#319795', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>休憩枠を追加</button>
          </form>
        </section>
      </div>

      {/* 📋 タイムテーブル（D&D対応エリア） */}
      <section>
        <h3>📅 自動計算されたタイムテーブル（ドラッグして並び替え可）</h3>
        {calculatedItems.length === 0 ? (
          <p>項目が登録されていません。</p>
        ) : (
          <DragDropContext onDragEnd={handleOnDragEnd}>
            <Droppable droppableId="timetable-list">
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef} style={{ listStyle: 'none', padding: 0 }}>
                  {calculatedItems.map((item, index) => (
                    <Draggable key={item.id} draggableId={item.id} index={index}>
                      {(provided) => (
                        <li 
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          style={{ 
                            display: 'flex', 
                            justifyContent: 'space-between', 
                            alignItems: 'center', 
                            padding: '12px', 
                            borderBottom: '1px solid #ddd', 
                            // 💡 休憩枠の場合は背景色をほんのり変える
                            background: item.type === 'break' ? '#e6fffa' : '#fff', 
                            marginBottom: '5px', 
                            borderRadius: '4px', 
                            color: '#333',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                            ...provided.draggableProps.style
                          }}
                        >
                          <div>
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold', marginRight: '15px', color: item.type === 'break' ? '#319795' : '#007acc' }}>⏰ {item.timeString}</span>
                            <span>{item.type === 'break' ? '☕' : '🎵'} {item.name} ({item.duration}分)</span>
                          </div>
                          <button onClick={() => handleDeleteItem(item.id)} style={{ background: '#e53e3e', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>
                            削除
                          </button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </section>
    </div>
  )
}

export default App