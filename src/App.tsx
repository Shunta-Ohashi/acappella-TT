import { useState } from 'react'
import './App.css'

// 1つのバンドの情報を表す「型」の定義
interface Band {
  id: number;
  name: string;
  time: string; // 演奏時間（例: 10:00〜10:15）
}

function App() {
  // バンドたちのリストを管理する状態（State）
  const [bands, setBands] = useState<Band[]>([
    { id: 1, name: 'あおぞら（仮のバンド名）', time: '13:00 〜 13:15' }
  ])

  // 入力フォームの文字を管理する状態
  const [inputName, setInputName] = useState('')
  const [inputTime, setInputTime] = useState('')

  // 「追加」ボタンを押したときの動き
  const handleAddBand = (e: React.FormEvent) => {
    e.preventDefault() // ページがリロードされるのを防ぐ
    if (!inputName || !inputTime) return // 空っぽなら何もしない

    const newBand: Band = {
      id: Date.now(), // 毎秒変わる数値を使って被らないIDを作る
      name: inputName,
      time: inputTime
    }

    setBands([...bands, newBand]) // 今までのリストに新しいバンドを追加
    setInputName('') // 入力欄を空っぽにリセット
    setInputTime('')
  }

  // 🗑️ 「削除」ボタンを押したときの動き
  const handleDeleteBand = (id: number) => {
    // クリックされたID以外のバンドだけで、新しいリストを作る（フィルターをかける）
    const filteredBands = bands.filter(band => band.id !== id)
    setBands(filteredBands)
  }

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', textAlign: 'left' }}>
      <h1>🎤 アカペラ タイムテーブル作成</h1>
      
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
            <label style={{ display: 'block', fontWeight: 'bold' }}>出演時間:</label>
            <input 
              type="text" 
              placeholder="例: 13:20 〜 13:35" 
              value={inputTime}
              onChange={(e) => setInputTime(e.target.value)}
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
        <h3>📅 当日のタイムテーブル</h3>
        {bands.length === 0 ? (
          <p>バンドが登録されていません。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {bands.map((band) => (
              <li key={band.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderBottom: '1px solid #ddd', background: '#fff', marginBottom: '5px', borderRadius: '4px', color: '#333' }}>
                <div>
                  <span style={{ fontWeight: 'bold', marginRight: '15px' }}>⏰ {band.time}</span>
                  <span>🎵 {band.name}</span>
                </div>
                {/* ❌ 削除ボタン */}
                <button 
                  onClick={() => handleDeleteBand(band.id)}
                  style={{ background: '#e53e3e', color: 'white', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
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