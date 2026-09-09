import type {
  Event,
  EventBand,
  EventDay,
  EventId,
  Stage,
} from '../domain/models'
import {
  createEventListItems,
  type EventListItem,
} from '../ui/eventList'

interface EventListProps {
  events: Event[]
  eventDays: EventDay[]
  stages: Stage[]
  eventBands: EventBand[]
  onOpenEvent: (eventId: EventId) => void
}

interface EventCardProps {
  event: EventListItem
  onOpen: () => void
}

function EventCard({ event, onOpen }: EventCardProps) {
  return (
    <article className="event-card">
      <header className="event-card__header">
        <div>
          <p className="event-card__eyebrow">イベント</p>
          <h2>{event.name}</h2>
        </div>
        <span className="event-card__status" aria-label="仮の編集状態: 下書き">
          下書き
        </span>
      </header>

      <p className="event-card__dates">{event.dateLabel}</p>

      <dl className="event-card__facts">
        <div>
          <dt>開催日数</dt>
          <dd>{event.dayCount}日</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{event.stageCount}件</dd>
        </div>
        <div>
          <dt>出演予定</dt>
          <dd>{event.eventBandCount}件</dd>
        </div>
      </dl>

      <footer className="event-card__footer">
        <button
          type="button"
          className="event-card__open"
          aria-label={`${event.name}の編集を続ける`}
          onClick={onOpen}
        >
          編集を続ける <span aria-hidden="true">→</span>
        </button>
      </footer>
    </article>
  )
}

export function EventList({
  events,
  eventDays,
  stages,
  eventBands,
  onOpenEvent,
}: EventListProps) {
  const eventListItems = createEventListItems({
    events,
    eventDays,
    stages,
    eventBands,
  })

  return (
    <main className="event-list-page" aria-labelledby="event-list-title">
      <header className="event-list-page__header">
        <div>
          <p className="event-list-page__eyebrow">Acappella TT</p>
          <h1 id="event-list-title">イベント</h1>
          <p>イベントのタイムテーブルを作成・管理します。</p>
        </div>
        <div className="event-list-page__create">
          <button type="button" className="primary-button" disabled>
            <span aria-hidden="true">＋</span> 新規イベント作成
          </button>
          <span>後続PRで実装予定</span>
        </div>
      </header>

      {eventListItems.length === 0 ? (
        <section className="event-list-empty">
          <h2>イベントはまだありません</h2>
          <p>最初のイベントを作成すると、ここに表示されます。</p>
        </section>
      ) : (
        <div className="event-list-grid">
          {eventListItems.map((event) => (
            <EventCard
              key={event.eventId}
              event={event}
              onOpen={() => onOpenEvent(event.eventId)}
            />
          ))}
        </div>
      )}
    </main>
  )
}
