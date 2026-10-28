import assert from 'node:assert/strict'

// The Supabase repository sends these transitions directly to authenticated
// PostgREST RPCs. It does not consult the UI's canOperate/disabled state.
export const assertUnassignedViewerTransitionDenied = async ({
  ownerRepository, viewerRepository, viewerId, liveId,
  sourceStageId, sourceScheduleItemId, operation,
}) => {
  assert.ok(operation === 'start' || operation === 'end')
  const before = await ownerRepository.loadAuthorized(liveId)
  assert.equal(before.ok, true)
  assert.equal(before.value.liveId, liveId)
  assert.equal(before.value.role, 'owner')
  assert.equal(before.value.isPublished, true)
  const stage = before.value.stages.find(value => value.sourceStageId === sourceStageId)
  assert.ok(stage)
  assert.equal(before.value.operators.some(value =>
    value.stageId === stage.stageId && value.userId === viewerId), false)
  const entry = stage.entries.find(value =>
    value.sourceScheduleItemId === sourceScheduleItemId)
  assert.ok(entry)
  assert.equal(entry.actualEndedAt, null)
  if (operation === 'start') {
    assert.equal(entry.status, 'pending')
    assert.equal(entry.actualStartedAt, null)
    assert.equal(stage.currentEntryPosition, null)
    assert.equal(stage.nextEntryPosition, entry.position)
  } else {
    assert.equal(stage.progressStatus, 'in_progress')
    assert.equal(stage.currentEntryPosition, entry.position)
    assert.equal(entry.status, 'in_progress')
    assert.equal(typeof entry.actualStartedAt, 'string')
    assert.ok(Number.isFinite(Date.parse(entry.actualStartedAt)))
  }

  const viewerRead = await viewerRepository.loadAuthorized(liveId)
  assert.equal(viewerRead.ok, true)
  assert.equal(viewerRead.value.liveId, liveId)
  assert.equal(viewerRead.value.role, 'viewer')
  const viewerStage = viewerRead.value.stages.find(value => value.stageId === stage.stageId)
  assert.ok(viewerStage)
  assert.equal(viewerStage.canOperate, false)
  assert.equal(viewerStage.revision, stage.revision)
  assert.equal(viewerRead.value.projectionVersion, before.value.projectionVersion)

  const result = await viewerRepository[operation === 'start' ? 'startEntry' : 'endEntry'](
    liveId, sourceStageId, stage.stageId, sourceScheduleItemId,
    entry.position, stage.revision, before.value.projectionVersion,
  )
  const after = await ownerRepository.loadAuthorized(liveId)
  assert.equal(after.ok, true)
  // Compare the entire authoritative DTO, including all Stage/Entry revisions,
  // actual timestamps, actors, progress, management state and assignments.
  assert.deepEqual(after.value, before.value,
    `Unassigned viewer ${operation} changed Live state.`)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ACCESS_DENIED')
}
