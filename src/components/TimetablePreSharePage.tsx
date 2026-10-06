import { useMemo, useState } from 'react'
import {
  filterTimetablePreShareEntries,
  getTimetablePreShareDaySummary,
  getTimetablePreShareStageSummary,
  type TimetablePreShareSnapshotV1,
} from '../share/timetablePreShare.ts'
import { createNormalAppUrl } from '../share/timetablePreShareCodec.ts'
import './TimetablePreSharePage.css'

interface TimetablePreSharePageProps {
  snapshot: TimetablePreShareSnapshotV1
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

const formatDayLabel = (date: string, label?: string): string => {
  const [year, month, day] = date.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  const dateLabel = `${month}月${day}日（${weekday}）`
  return label?.trim() ? `${dateLabel} ${label}` : dateLabel
}

const formatSnapshotTime = (value: string): string =>
  new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))

const AssignmentLine = ({ label, names }: { label: string; names: string[] }) =>
  names.length > 0 ? (
    <div className="pre-share-entry__assignment">
      <dt>{label}</dt>
      <dd>{names.join(' / ')}</dd>
    </div>
  ) : null

export function TimetablePreSharePage({ snapshot }: TimetablePreSharePageProps) {
  const [dayIndex, setDayIndex] = useState(0)
  const [stageIndex, setStageIndex] = useState(0)
  const [query, setQuery] = useState('')
  const selectedDay = snapshot.days[dayIndex]
  const selectedStage = selectedDay?.stages[stageIndex]
  const visibleEntries = useMemo(
    () => filterTimetablePreShareEntries(selectedStage?.entries ?? [], query),
    [query, selectedStage],
  )
  const daySummary = selectedDay ? getTimetablePreShareDaySummary(selectedDay) : undefined
  const summary = selectedStage ? getTimetablePreShareStageSummary(selectedStage) : undefined

  const openNormalApp = () => {
    window.location.assign(createNormalAppUrl(window.location.href))
  }

  return (
    <main className="pre-share-page">
      <header className="pre-share-hero">
        <p className="pre-share-hero__eyebrow">事前共有タイムテーブル</p>
        <h1>{snapshot.eventName}</h1>
        <p className="pre-share-hero__snapshot">
          {formatSnapshotTime(snapshot.createdAt)} 時点のスナップショット
        </p>
        <p className="pre-share-hero__notice">
          演者・運営向けの予定表です。作成後の編集内容や当日の進行状況は自動反映されません。
        </p>
      </header>

      {snapshot.days.length > 1 && (
        <nav className="pre-share-tabs" aria-label="開催日">
          {snapshot.days.map((day, index) => (
            <button
              type="button"
              key={`${day.date}:${index}`}
              className={index === dayIndex ? 'pre-share-tab pre-share-tab--active' : 'pre-share-tab'}
              aria-pressed={index === dayIndex}
              onClick={() => {
                setDayIndex(index)
                setStageIndex(0)
              }}
            >
              {formatDayLabel(day.date, day.label)}
            </button>
          ))}
        </nav>
      )}

      {selectedDay && (
        <section className="pre-share-content" aria-labelledby="pre-share-scope-title">
          <div className="pre-share-scope">
            <div>
              <p>開催日</p>
              <h2 id="pre-share-scope-title">
                {formatDayLabel(selectedDay.date, selectedDay.label)}
              </h2>
              <p className="pre-share-scope__summary">
                全Stage：{daySummary?.startTime ?? '未設定'}
                {daySummary?.endTime ? ` – ${daySummary.endTime}` : ''}
                {`／${daySummary?.performanceCount ?? 0}組／休憩${daySummary?.breakCount ?? 0}回`}
              </p>
            </div>
            {selectedDay.stages.length > 1 && (
              <nav className="pre-share-tabs pre-share-tabs--stages" aria-label="Stage">
                {selectedDay.stages.map((stage, index) => (
                  <button
                    type="button"
                    key={`${stage.name}:${index}`}
                    className={index === stageIndex
                      ? 'pre-share-tab pre-share-tab--active'
                      : 'pre-share-tab'}
                    aria-pressed={index === stageIndex}
                    onClick={() => setStageIndex(index)}
                  >
                    {stage.name}
                  </button>
                ))}
              </nav>
            )}
          </div>

          {selectedStage ? (
            <>
              <div className="pre-share-summary">
                <div>
                  <span>Stage</span>
                  <strong>{selectedStage.name}</strong>
                </div>
                <div>
                  <span>予定時間</span>
                  <strong>
                    {summary?.startTime ?? '未設定'}
                    {summary?.endTime ? ` – ${summary.endTime}` : ''}
                  </strong>
                </div>
                <div>
                  <span>内容</span>
                  <strong>
                    {summary?.performanceCount ?? 0}組・休憩{summary?.breakCount ?? 0}回
                  </strong>
                </div>
              </div>

              <div className="pre-share-search">
                <label htmlFor="pre-share-search">タイムテーブルを検索</label>
                <input
                  id="pre-share-search"
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="バンド名・メンバー名・担当者名で検索"
                />
              </div>

              <div className="pre-share-list" aria-live="polite">
                {visibleEntries.map((entry, index) => (
                  <article
                    className={`pre-share-entry pre-share-entry--${entry.kind}`}
                    key={`${entry.startTime}:${entry.endTime}:${entry.kind}:${index}`}
                  >
                    <p className="pre-share-entry__time">
                      <time>{entry.startTime}</time><span aria-hidden="true">–</span><time>{entry.endTime}</time>
                    </p>
                    <div className="pre-share-entry__body">
                      <h3>{entry.title}</h3>
                      {entry.kind === 'performance' && entry.members.length > 0 && (
                        <p className="pre-share-entry__members">
                          <span>出演</span>{entry.members.join(' / ')}
                        </p>
                      )}
                    </div>
                    <dl className="pre-share-entry__assignments">
                      <AssignmentLine label="Main PA" names={entry.mainPa} />
                      <AssignmentLine label="Sub PA" names={entry.subPa} />
                      {entry.duties.map((duty, dutyIndex) => (
                        <AssignmentLine
                          key={`${duty.name}:${dutyIndex}`}
                          label={duty.name}
                          names={duty.members}
                        />
                      ))}
                    </dl>
                  </article>
                ))}
                {visibleEntries.length === 0 && (
                  <p className="pre-share-empty">
                    {query.trim()
                      ? '検索条件に一致する予定はありません。'
                      : 'このStageには予定がありません。'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="pre-share-empty">この開催日にはStageがありません。</p>
          )}
        </section>
      )}

      {snapshot.days.length === 0 && (
        <section className="pre-share-content">
          <p className="pre-share-empty">共有された開催日はありません。</p>
        </section>
      )}

      <footer className="pre-share-footer">
        <button type="button" onClick={openNormalApp}>通常画面を開く</button>
      </footer>
    </main>
  )
}
