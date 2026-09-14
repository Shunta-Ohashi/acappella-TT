import assert from 'node:assert/strict'
import test from 'node:test'

import { createDemoData } from '../src/data/demoData.ts'
import { detectScheduleIssues } from '../src/domain/issues.ts'
import { calculateEventDayTimelines } from '../src/domain/timetable.ts'

test('demoDataは想定件数と全EventDayのdomain invariantを満たす', () => {
  const data = createDemoData()

  assert.deepEqual({
    events: data.events.length,
    eventDays: data.eventDays.length,
    members: data.members.length,
    bands: data.bands.length,
    eventBands: data.eventBands.length,
    stages: data.stages.length,
    sections: data.sections.length,
    scheduleItems: data.scheduleItems.length,
    paAssignments: data.paAssignments.length,
    dutyTypes: data.dutyTypes.length,
    dutyAssignments: data.dutyAssignments.length,
  }, {
    events: 2,
    eventDays: 3,
    members: 10,
    bands: 6,
    eventBands: 10,
    stages: 5,
    sections: 5,
    scheduleItems: 6,
    paAssignments: 2,
    dutyTypes: 2,
    dutyAssignments: 2,
  })

  for (const eventDay of data.eventDays) {
    const event = data.events.find((candidate) =>
      candidate.id === eventDay.eventId,
    )
    assert.ok(event, `Eventが見つかりません: ${eventDay.eventId}`)

    const eventBands = data.eventBands.filter((eventBand) =>
      eventBand.eventId === event.id,
    )
    const stages = data.stages.filter((stage) =>
      stage.eventDayId === eventDay.id,
    )
    const timelines = calculateEventDayTimelines({
      event,
      eventDayId: eventDay.id,
      stages: data.stages,
      sections: data.sections,
      scheduleItems: data.scheduleItems,
      eventBands,
    })

    assert.deepEqual(
      timelines.invalidStages,
      [],
      `${eventDay.id}に不正なStage timelineがあります`,
    )

    const errors = detectScheduleIssues({
      event,
      members: data.members,
      eventMembers: data.eventMembers.filter((eventMember) =>
        eventMember.eventId === event.id,
      ),
      eventMemberDays: data.eventMemberDays,
      eventBands,
      stages,
      sections: data.sections,
      paAssignments: data.paAssignments.filter((assignment) =>
        assignment.eventId === event.id &&
        assignment.eventDayId === eventDay.id,
      ),
      dutyTypes: data.dutyTypes.filter((dutyType) =>
        dutyType.eventId === event.id,
      ),
      dutyAssignments: data.dutyAssignments.filter((assignment) =>
        assignment.eventDayId === eventDay.id,
      ),
      calculatedItems: timelines.calculatedItems,
    }).filter((issue) => issue.severity === 'ERROR')

    assert.deepEqual(
      errors,
      [],
      `${eventDay.id}の初期IssueにERRORがあります`,
    )
  }
})
