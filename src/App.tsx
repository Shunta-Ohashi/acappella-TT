import { useState } from 'react'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import type { DropResult } from '@hello-pangea/dnd' // 👈 型だけを別でインポートする
import './App.css'

interface Band {
  id: number;
  name: string;
  duration: number;
}

function App() {
  const [bands, setBands] = useState<Band[]>([
    { id: 1, name: 'あおぞら（仮のバンド名）', duration: 15 },
    { id: 2, name: '夕焼けコーラス', duration: 10 },
    { id: 3, name: 'みなみかぜ（サンプル）', duration: 12 }
  ])

  const [inputName, setInputName] = useState('')
  const [inputDuration, setInputDuration] = useState<number>(15)
  const [startTime, setStartTime] = useState('13:00')
  const [intervalTime, setIntervalTime] = useState(2)

  const handleAddBand = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputName || inputDuration <= 0) return

    const newBand: Band = {
      id: Date.now(),
      name: inputName,
      duration: inputDuration
    }

    setBands([...bands, newBand])
    setInputName('')
    setInputDuration(15)
  }

  const handleDeleteBand = (id: number) => {
    setBands(bands.filter(band => band.id !== id))
  }

  // 🎴 【新機能】ドラッグが終わった（指やマウスを離した）ときの動き
  const handleOnDragEnd = (result: DropResult) => {
    // リストの外側にドロップされた場合は何もしない
    if (!result.destination) return

    // バンドのリストをコピーして、並び替えの処理を行う
    const items = Array.from(bands)
    const [reorderedItem] = items.splice(result.source.index, 1) // 掴んだアイテムを一度抜く
    items.splice(result.destination.index, 0, reorderedItem) // 離した位置に差し込む

    setBands(items) // 新しい並び順をStateに保存（時間が自動で再計算されます！）
  }

  const calculateTimeline = () => {
    const [startHour, startMin] = startTime.split(':').map(Number)
    let currentTotalMinutes = startHour * 60 + startMin

    return bands.map((band) => {
      const startMinRaw = currentTotalMinutes
      const endMinRaw = currentTotalMinutes + band.duration

      currentTotalMinutes = endMinRaw + intervalTime

      const formatTime = (totalMinutes: number) => {
        const h = Math.floor(totalMinutes / 60) % 24
        const m = totalMinutes % 60
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      }

      return {
        ...band,
        timeString: `${formatTime(startMinRaw)} 〜 ${formatTime(endMinRaw)}`
      }
    })
  }

  const calculatedBands = calculateTimeline()

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', textAlign: 'left' }}>
      <h1>🎤 アカペラ タイムテーブル作成</h1>

      {/* ⚙️ スケジュール設定 */}
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
      
      {/* 📥 バンド入力フォーム */}
      <section style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px', marginBottom: '20px', color: '#333' }}>
        <h3>➕ 出演バンドの追加</h3>
        <form onSubmit={handleAddBand}>
          <div style={{ marginBottom: '10px' }}>
            <label style={{ display: 'block', fontWeight: 'bold' }}>バンド名:</label>
            <input type="text" placeholder="例: クレシェンド" value={inputName} onChange={(e) => setInputName(e.target.value)} style={{ width: '100%', padding: '8px', marginTop: '5px', borderRadius: '4px', border: '1px solid #ccc' }} />
          </div>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: 'bold' }}>演奏時間 (分):</label>
            <input type="number" value={inputDuration} onChange={(e) => setInputDuration(Number(e.target.value))} style={{ width: '100%', padding: '8px', marginTop: '5px', borderRadius: '4px', border: '1px solid #ccc' }} />
          </div>
          <button type="submit" style={{ background: '#007acc', color: 'white', padding: '8px 16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>タイムテーブルに追加</button>
        </form>
      </section>

      {/* 📋 タイムテーブル（D&D対応エリア） */}
      <section>
        <h3>📅 自動計算されたタイムテーブル（ドラッグして並び替え可）</h3>
        {calculatedBands.length === 0 ? (
          <p>バンドが登録されていません。</p>
        ) : (
          /* 🛠️ D&Dができる全体の範囲を設定 */
          <DragDropContext onDragEnd={handleOnDragEnd}>
            {/* 🛠️ アイテムを落とせる（Droppable）エリアを設定 */}
            <Droppable droppableId="timetable-list">
              {(provided) => (
                <ul 
                  {...provided.droppableProps} 
                  ref={provided.innerRef} 
                  style={{ listStyle: 'none', padding: 0 }}
                >
                  {calculatedBands.map((band, index) => (
                    /* 🛠️ 1つずつの要素をドラッグ可能（Draggable）にする。idは文字列にする必要があるので String() を使用 */
                    <Draggable key={band.id} draggableId={String(band.id)} index={index}>
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
                            background: '#fff', 
                            marginBottom: '5px', 
                            borderRadius: '4px', 
                            color: '#333',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                            ...provided.draggableProps.style // ライブラリが動的に計算するスタイルを適用
                          }}
                        >
                          <div>
                            {/* ☰ のようなツマミ代わりのマーク */}
                            <span style={{ marginRight: '10px', color: '#aaa', cursor: 'grab' }}>☰</span>
                            <span style={{ fontWeight: 'bold', marginRight: '15px', color: '#007acc' }}>⏰ {band.timeString}</span>
                            <span>🎵 {band.name} ({band.duration}分)</span>
                          </div>
                          <button onClick={() => handleDeleteBand(band.id)} style={{ background: '#e53e3e', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>
                            削除
                          </button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder} {/* リストがガタつかないための隙間埋めパーツ */}
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