import test from 'node:test'
import assert from 'node:assert/strict'
import { hasPaDraftChanges, hasDutyDraftChanges, hasUnsavedOperationsChanges } from '../src/ui/operationsDraftChanges.ts'
import { createPaAssignmentsDraft } from '../src/domain/paAssignments.ts'
import { createDutySettingsDraft } from '../src/domain/dutyAssignments.ts'
import { createGenerationUiInput } from './fixtures/timetableGenerationUi.mjs'

const drafts = () => {
  const input = createGenerationUiInput()
  return {
    pa: createPaAssignmentsDraft(input.event, input.paAssignments),
    duty: createDutySettingsDraft(input.event, input.stages, input.dutyTypes, input.dutyAssignments),
  }
}

test('生成設定・適用・TT初期化は同じPA/Duty dirty guardを利用できる', () => {
  const saved = drafts()
  const current = structuredClone(saved)
  const paHandle = { hasUnsavedChanges: () => hasPaDraftChanges(current.pa, saved.pa) }
  const dutyHandle = { hasUnsavedChanges: () => hasDutyDraftChanges(current.duty, saved.duty) }
  assert.equal(hasUnsavedOperationsChanges(paHandle, dutyHandle), false)
  current.pa.items[0].memberId = 'changed'
  assert.equal(hasUnsavedOperationsChanges(paHandle, dutyHandle), true)
  current.pa = structuredClone(saved.pa)
  current.duty.assignments = []
  assert.equal(hasUnsavedOperationsChanges(paHandle, dutyHandle), true)
  current.duty = structuredClone(saved.duty)
  assert.equal(hasUnsavedOperationsChanges(paHandle, dutyHandle), false)
  assert.equal(hasUnsavedOperationsChanges(null, null), false)
})

test('初期PA/Duty draftと同値の再構築draftは未保存変更なし', () => {
  const first = drafts()
  const second = drafts()
  assert.equal(hasPaDraftChanges(first.pa, second.pa), false)
  assert.equal(hasDutyDraftChanges(first.duty, second.duty), false)
})

test('PAのdraftId・配列順だけの差はdirtyではなく、担当・境界変更/追加/削除はdirty', () => {
  const { pa } = drafts()
  const same = structuredClone(pa)
  same.items.reverse().forEach((item, index) => { item.draftId = `regenerated-${index}` })
  assert.equal(hasPaDraftChanges(same, pa), false)
  for (const edit of [
    d => { d.items[0].memberId = 'sub' },
    d => { d.items[0].from.edge = 'end' },
    d => { d.items[0].stageId = 'stage-sub' },
    d => { d.items[0].role = 'sub' },
    d => { d.items.push({ ...d.items[0], paAssignmentId: undefined, draftId: 'new' }) },
    d => { d.items.pop() },
  ]) {
    const changed = structuredClone(pa)
    edit(changed)
    assert.equal(hasPaDraftChanges(changed, pa), true)
    assert.equal(hasPaDraftChanges(changed, structuredClone(changed)), false, '保存成功後はdirtyなし')
  }
})

test('DutyのdraftId再生成と対応する参照IDの差だけではdirtyにならない', () => {
  const { duty } = drafts()
  const same = structuredClone(duty)
  same.dutyTypes[0].draftId = 'regenerated-type'
  same.assignments[0].draftId = 'regenerated-assignment'
  same.assignments[0].dutyTypeDraftId = 'regenerated-type'
  assert.equal(hasDutyDraftChanges(same, duty), false)
})

test('Dutyの仕事内容・担当・境界・削除・並び順の変更はdirty、保存後はdirtyなし', () => {
  const { duty } = drafts()
  duty.dutyTypes.push({ draftId: 'new-type', dutyTypeId: 'type-2', name: '受付' })
  for (const edit of [
    d => { d.dutyTypes[0].name = '撮影変更' },
    d => { d.dutyTypes.reverse() },
    d => { d.assignments[0].memberId = 'main' },
    d => { d.assignments[0].until.scheduleItemId = 'old-p1' },
    d => { d.assignments[0].dutyTypeDraftId = 'new-type' },
    d => { d.assignments = [] },
    d => { d.dutyTypes.push({ draftId: 'type-new', name: '新しい仕事' }) },
  ]) {
    const changed = structuredClone(duty)
    edit(changed)
    assert.equal(hasDutyDraftChanges(changed, duty), true)
    assert.equal(hasDutyDraftChanges(changed, structuredClone(changed)), false)
  }
})

test('dirty比較は参照切れDutyのsemantic referenceを保持し入力を変更しない', () => {
  const { duty } = drafts()
  delete duty.assignments[0].dutyTypeDraftId
  duty.assignments[0].missingDutyTypeId = 'missing-type'
  const original = structuredClone(duty)
  const changed = structuredClone(duty)
  changed.assignments[0].missingDutyTypeId = 'other-missing-type'
  assert.equal(hasDutyDraftChanges(changed, duty), true)
  assert.equal(hasDutyDraftChanges(original, duty), false)
  assert.deepEqual(duty, original)
})
