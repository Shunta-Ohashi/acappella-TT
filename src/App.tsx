import { useState } from 'react'
import './App.css'

// 1つのバンドの情報を表す「型」の定義
interface Band {
  id: number;
  name: string;
  duration: number;
}

function App() {
  // バンドたちのリスト
  const [bands, setBands] = useState<Band[]>([
    { id: 1, name: 'あおぞら（仮のバンド名）', duration: 15 },
    { id: 2, name: '夕焼けコーラス', duration: 10 }
  ])

  // 入力フォームの状態管理
  const [inputName, setInputName] = useState('')
  const [inputDuration, setInputDuration] = useState(15)

  // ⚙️ スケジュール一括計算用の設定状態
  const [startTime, setStartTime] = useState('13:00')
  const [intervalTime, setIntervalTime] = useState(2)

  // バンド追加の動き
  const handleAddBand = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputName || inputDuration <= 0) return

    const newBand: Band = {
      id: Date.now(),
      name: inputName,
      duration: Number(inputDuration)
    }

    setBands([...bands, newBand])
    setInputName('')
    setInputDuration(15)
  }

  // 🗑️ 削除の動き
  const handleDeleteBand = (id: number) => {
    setBands(bands.filter(band => band.id !== id))
  }

  // 🕒 バンドのタイムテーブルを自動計算する関数
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

      {/* ⚙️ スケジュール設定エリア */}
      <section style={{ background: '#edf2f7', padding: '15px', borderRadius: '8px', marginBottom: '20px', color: '#2d3748' }}>
        <h3>⚙️ スケジュール基本設定</h3>
        <div style={{ display: 'flex', gap: '20px' }}>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>イベント開始時刻:</label>
            <input 
              type="time" 
              value={startTime} 
              onChange={(e) => setStartTime(e.target.value)}
              style={{ padding: '6px', marginTop: '5px' }}
            />
          </div>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block' }}>転換時間 (分):</label>
            <input 
              type="number" 
              value={intervalTime} 
              onChange={(e) => setIntervalTime(Number(e.target.value))}
              style={{ padding: '6px', width: '60px', marginTop: '5px' }}
            />
          </div>
        </div>
      </section>
      
      {/* 📥 バンド入力フォーム */}
      <section style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px', marginBottom: '20px', color: '#333' }}>
        <h3>➕ 出演バンドの追加</h3>
        <form onSubmit={handleAddBand}>
          <div style={{ marginBottom: '10px' }}>
            <label style={{ display: 'block', fontWeight: 'bold' }}>バンド名:</label>
            <input 
              type="text" 
              placeholder="例: クレシェンド" 
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              style={{ width: '100%', padding: '8px', marginTop: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: 'bold' }}>演奏時間 (分):</label>
            <input 
              type="number" 
              value={inputDuration}
              onChange={(e) => setInputDuration(Number(e.target.value))}
              style={{ width: '100%', padding: '8px', marginTop: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>

          <button type="submit" style={{ background: '#007acc', color: 'white', padding: '8px 16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
            タイムテーブルに追加
          </button>
        </form>
      </section>

      {/* 📋 タイムテーブルの表示エリア */}
      <section>
        <h3>📅 自動計算されたタイムテーブル</h3>
        {calculatedBands.length === 0 ? (
          <p>バンドが登録されていません。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {calculatedBands.map((band) => (
              <li key={band.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderBottom: '1px solid #ddd', background: '#fff', marginBottom: '5px', borderRadius: '4px', color: '#333' }}>
                <div>
                  <span style={{ fontWeight: 'bold', marginRight: '15px', color: '#007acc' }}>⏰ {band.timeString}</span>
                  <span>🎵 {band.name} ({band.duration}分)</span>
                </div>
                {/* 🛠️ ボタンの文字を「削除」のみに修正 */}
                <button 
                  onClick={() => handleDeleteBand(band.id)}
                  style={{ background: '#e53e3e', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default App