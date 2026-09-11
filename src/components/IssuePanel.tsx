import type { ScheduleIssue } from '../domain/issues'
import type {
  EventBand,
  Member,
  Section,
  Stage,
} from '../domain/models'
import type { CalculatedScheduleItem } from '../domain/timeline'
import {
  countIssuesBySeverity,
  ISSUE_SEVERITIES,
} from '../ui/issuePresentation'

interface IssuePanelProps {
  issues: ScheduleIssue[]
  members: Member[]
  eventBands: EventBand[]
  stages: Stage[]
  sections: Section[]
  calculatedItems: CalculatedScheduleItem[]
}

const uniqueNames = (names: string[]) => [...new Set(names)]

export function IssuePanel({
  issues,
  members,
  eventBands,
  stages,
  sections,
  calculatedItems,
}: IssuePanelProps) {
  const counts = countIssuesBySeverity(issues)
  const memberNameById = new Map(
    members.map((member) => [member.id, member.realName]),
  )
  const eventBandNameById = new Map(
    eventBands.map((eventBand) => [
      eventBand.id,
      eventBand.name,
    ]),
  )
  const stageNameById = new Map(stages.map((stage) => [stage.id, stage.name]))
  const sectionNameById = new Map(
    sections.map((section) => [section.id, section.name]),
  )
  const calculatedItemById = new Map(
    calculatedItems.map((item) => [item.scheduleItemId, item]),
  )

  const getDisplayMessage = (issue: ScheduleIssue) => {
    let message = issue.message

    issue.memberIds?.forEach((memberId) => {
      const memberName = memberNameById.get(memberId) ?? '不明なメンバー'
      message = message
        .replaceAll(`メンバー ${memberId}`, `メンバー「${memberName}」`)
        .replaceAll(memberId, memberName)
    })
    issue.eventBandIds?.forEach((eventBandId) => {
      const bandName = eventBandNameById.get(eventBandId) ?? '不明なバンド'
      message = message
        .replaceAll(`EventBand ${eventBandId}`, `バンド「${bandName}」`)
        .replaceAll(eventBandId, bandName)
    })
    issue.stageIds?.forEach((stageId) => {
      const stageName = stageNameById.get(stageId) ?? '不明なStage'
      message = message.replaceAll(`Stage ${stageId}`, `Stage「${stageName}」`)
    })
    issue.sectionIds?.forEach((sectionId) => {
      const sectionName = sectionNameById.get(sectionId) ?? '不明なSection'
      message = message.replaceAll(
        `Section ${sectionId}`,
        `Section「${sectionName}」`,
      )
    })

    return message
  }

  return (
    <section className="issue-panel" aria-labelledby="issue-panel-title">
      <h3 id="issue-panel-title" className="issue-panel__title">
        問題チェック
      </h3>

      <div className="issue-summary" aria-live="polite">
        {ISSUE_SEVERITIES.map((severity) => (
          <span
            key={severity}
            className={`issue-summary__count issue-summary__count--${severity.toLowerCase()}`}
          >
            <strong>{severity}</strong> {counts[severity]}件
          </span>
        ))}
      </div>

      {issues.length === 0 ? (
        <p className="issue-panel__empty">
          現在、検出された問題はありません
        </p>
      ) : (
        <ul className="issue-list">
          {issues.map((issue, index) => {
            const memberNames = uniqueNames(
              (issue.memberIds ?? []).map(
                (memberId) =>
                  memberNameById.get(memberId) ?? '不明なメンバー',
              ),
            )
            const bandNames = uniqueNames(
              (issue.eventBandIds ?? []).map(
                (eventBandId) =>
                  eventBandNameById.get(eventBandId) ?? '不明なバンド',
              ),
            )
            const stageNames = uniqueNames(
              [
                ...(issue.stageIds ?? []).map(
                  stageId => stageNameById.get(stageId) ?? '不明なStage',
                ),
                ...(issue.scheduleItemIds ?? []).map((scheduleItemId) => {
                  const stageId = calculatedItemById.get(scheduleItemId)?.stageId
                  return stageId
                    ? stageNameById.get(stageId) ?? '不明なStage'
                    : '不明なStage'
                }),
              ],
            )
            const sectionNames = uniqueNames(
              (issue.sectionIds ?? []).map(
                sectionId => sectionNameById.get(sectionId) ?? '不明なSection',
              ),
            )
            const targets = [
              memberNames.length > 0
                ? `メンバー: ${memberNames.join('、')}`
                : undefined,
              bandNames.length > 0
                ? `バンド: ${bandNames.join('、')}`
                : undefined,
              stageNames.length > 0
                ? `Stage: ${stageNames.join('、')}`
                : undefined,
              sectionNames.length > 0
                ? `Section: ${sectionNames.join('、')}`
                : undefined,
            ].filter((target): target is string => target !== undefined)
            const metrics = [
              issue.gapBands !== undefined
                ? `バンド間隔: ${issue.gapBands}`
                : undefined,
              issue.restMinutes !== undefined
                ? `休憩時間: ${issue.restMinutes}分`
                : undefined,
              issue.overrunMinutes !== undefined
                ? `超過時間: ${issue.overrunMinutes}分`
                : undefined,
            ].filter((metric): metric is string => metric !== undefined)

            return (
              <li
                key={[
                  issue.code,
                  issue.memberIds?.join('-'),
                  issue.eventBandIds?.join('-'),
                  issue.scheduleItemIds?.join('-'),
                  issue.stageIds?.join('-'),
                  issue.sectionIds?.join('-'),
                  index,
                ].join('|')}
                className={`issue-list__item issue-list__item--${issue.severity.toLowerCase()}`}
              >
                <div className="issue-list__heading">
                  <span
                    className={`issue-severity-label issue-severity-label--${issue.severity.toLowerCase()}`}
                  >
                    {issue.severity}
                  </span>
                  <span className="issue-list__message">
                    {getDisplayMessage(issue)}
                  </span>
                </div>
                {targets.length > 0 && (
                  <div className="issue-list__details">
                    対象: {targets.join(' / ')}
                  </div>
                )}
                {metrics.length > 0 && (
                  <div className="issue-list__details">
                    {metrics.join(' / ')}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
