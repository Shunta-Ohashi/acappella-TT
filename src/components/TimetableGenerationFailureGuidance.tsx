import type { TimetableGenerationFailurePresentation } from '../ui/timetableGenerationPresentation'

interface TimetableGenerationFailureGuidanceProps {
  guidance: TimetableGenerationFailurePresentation
}

export function TimetableGenerationFailureGuidance({
  guidance,
}: TimetableGenerationFailureGuidanceProps) {
  return (
    <section className="timetable-generation-failure" role="alert">
      <h3>{guidance.title}</h3>
      <p>{guidance.summary}</p>
      <details className="timetable-generation-failure__disclosure">
        <summary>詳細を表示</summary>
        <div className="timetable-generation-failure__disclosure-content">
          <section aria-labelledby="timetable-generation-failure-checks">
            <h4 id="timetable-generation-failure-checks">確認してほしいこと</h4>
            <ul>
              {guidance.checks.map((check) => <li key={check}>{check}</li>)}
            </ul>
          </section>
          <section aria-labelledby="timetable-generation-failure-details">
            <h4 id="timetable-generation-failure-details">関連情報</h4>
            <ul className="timetable-generation-failure__details">
              {guidance.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </section>
        </div>
      </details>
    </section>
  )
}
