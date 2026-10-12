import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import {
  canDismissDeleteConfirmation,
  getDeleteConfirmationCopy,
} from '../src/ui/deleteConfirmation.ts'

test('開催日の削除確認に対象日と保存前の変更であることを示す', () => {
  const copy = getDeleteConfirmationCopy('event-day', '2026-10-03')

  assert.equal(copy.title, '開催日を削除しますか？')
  assert.match(copy.description, /2026-10-03/)
  assert.match(copy.description, /保存すると変更が反映されます/)
})

test('StageとSectionの削除確認に対象名を示す', () => {
  const stageCopy = getDeleteConfirmationCopy('stage', 'Main Stage')
  const sectionCopy = getDeleteConfirmationCopy('section', '第1部')

  assert.match(stageCopy.title, /Main Stage/)
  assert.match(stageCopy.description, /Stage設定を一覧から削除/)
  assert.match(sectionCopy.title, /第1部/)
  assert.match(sectionCopy.description, /Section設定を一覧から削除/)
})

test('参加メンバーと出演バンドの削除確認に対象名を示す', () => {
  const memberCopy = getDeleteConfirmationCopy('event-member', '山田 花子')
  const bandCopy = getDeleteConfirmationCopy('event-band', 'Choir')

  assert.match(memberCopy.description, /山田 花子/)
  assert.match(memberCopy.description, /参加メンバーから削除/)
  assert.match(bandCopy.description, /Choir/)
  assert.match(bandCopy.description, /出演バンドから削除/)
})

test('共通メンバーと固定バンドの確認は即時削除と取消不可を示す', () => {
  const memberCopy = getDeleteConfirmationCopy('common-member', '山田 太郎')
  const bandCopy = getDeleteConfirmationCopy('common-band', 'Choir')

  assert.equal(memberCopy.title, 'メンバーを削除しますか？')
  assert.match(memberCopy.description, /山田 太郎/)
  assert.match(memberCopy.description, /この操作は元に戻せません/)
  assert.doesNotMatch(memberCopy.description, /保存すると/)
  assert.equal(bandCopy.title, '固定バンドを削除しますか？')
  assert.match(bandCopy.description, /Choir/)
  assert.match(bandCopy.description, /この操作は元に戻せません/)
  assert.doesNotMatch(bandCopy.description, /保存すると/)
})

test('Event削除確認はcascade範囲と共通データ保持と取消不可を示す', () => {
  const copy = getDeleteConfirmationCopy('event', 'Autumn Live')

  assert.match(copy.title, /Autumn Live/)
  assert.match(copy.description, /開催日/)
  assert.match(copy.description, /タイムテーブル/)
  assert.match(copy.description, /PA・当日運営/)
  assert.match(copy.description, /メンバーと固定バンドは削除されません/)
  assert.match(copy.description, /この操作は元に戻せません/)
  assert.equal(copy.confirmLabel, 'イベントを削除')
})

test('Event削除確認はStep 1の未保存draftも失われることをdirty時だけ明示する', () => {
  const clean = getDeleteConfirmationCopy('event', 'Autumn Live')
  const dirty = getDeleteConfirmationCopy('event', 'Autumn Live', {
    hasUnsavedDraft: true,
  })

  assert.equal(clean.warningMessage, undefined)
  assert.match(dirty.warningMessage, /まだ保存していないイベント基本情報/)
  assert.match(dirty.warningMessage, /変更も失われます/)
  assert.match(dirty.description, /この操作は元に戻せません/)
})

test('EventBasicInfoの各dirty draftは実renderされた削除Dialogへ警告を渡す', async () => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true },
  })
  try {
    const { EventDeletionConfirmationDialog } = await vite.ssrLoadModule(
      '/src/components/EventBasicInfo.tsx',
    )
    const { createPendingEventDeletion } = await vite.ssrLoadModule(
      '/src/ui/eventDeletionConfirmation.ts',
    )
    const event = { id: 'event-a', name: '保存済みイベント名' }
    const savedDraft = {
      name: event.name,
      description: '保存済み説明',
      notes: '保存済み備考',
      eventDays: [{ eventDayId: 'day-a', date: '2026-10-12' }],
    }
    const dirtyDrafts = [
      { ...savedDraft, name: '未保存イベント名' },
      { ...savedDraft, description: '未保存説明' },
      { ...savedDraft, notes: '未保存備考' },
      {
        ...savedDraft,
        eventDays: [{ ...savedDraft.eventDays[0], date: '2026-10-13' }],
      },
    ]
    const renderDialog = currentDraft => {
      const pendingDeletion = createPendingEventDeletion({
        event,
        currentDraft,
        savedDraft,
      })
      return renderToStaticMarkup(createElement(EventDeletionConfirmationDialog, {
        pendingDeletion,
        isDeleting: false,
        errorMessage: '',
        onCancel() {},
        onConfirm() {},
      }))
    }

    for (const dirtyDraft of dirtyDrafts) {
      const markup = renderDialog(dirtyDraft)
      assert.match(markup, /まだ保存していないイベント基本情報の変更も失われます/)
      assert.match(markup, /role="alert"/)
      assert.deepEqual(savedDraft, {
        name: event.name,
        description: '保存済み説明',
        notes: '保存済み備考',
        eventDays: [{ eventDayId: 'day-a', date: '2026-10-12' }],
      })
    }

    // Saving the Step replaces savedDraft with the current normalized draft.
    // The same component path is used in local-only mode; no Cloud prop exists.
    assert.doesNotMatch(renderDialog(savedDraft), /まだ保存していない/)
  } finally {
    await vite.close()
  }
})

test('削除確認の操作ラベルを全対象で共通化する', () => {
  const targets = [
    'event-day',
    'stage',
    'section',
    'event-member',
    'event-band',
    'common-member',
    'common-band',
  ]

  for (const target of targets) {
    const copy = getDeleteConfirmationCopy(target, '対象')
    assert.equal(copy.cancelLabel, 'キャンセル')
    assert.equal(copy.confirmLabel, '削除する')
  }

  assert.equal(
    getDeleteConfirmationCopy('event', '対象').confirmLabel,
    'イベントを削除',
  )
})

test('非同期削除中だけCancel・Escape等のdismissを禁止する', () => {
  assert.equal(canDismissDeleteConfirmation(false), true)
  assert.equal(canDismissDeleteConfirmation(true), false)
})

test('共通Dialogはpending中にCancel・ConfirmをdisabledにしEscapeもguardする', async () => {
  const source = await readFile(new URL(
    '../src/components/DeleteConfirmationDialog.tsx',
    import.meta.url,
  ), 'utf8')

  assert.match(source, /onCancel=\{\(event\) => \{[\s\S]*event\.preventDefault\(\)[\s\S]*canDismissDeleteConfirmation\(isPending\)/)
  assert.equal((source.match(/disabled=\{isPending\}/g) ?? []).length, 2)
  assert.match(source, /aria-busy=\{isPending \|\| undefined\}/)
  assert.match(source,
    /warningMessage[\s\S]*className="form-error" role="alert"/)
})

test('Event削除は成功時だけDialogを閉じ、失敗時はerror付きで再試行可能にする', async () => {
  const source = await readFile(new URL(
    '../src/components/EventBasicInfo.tsx',
    import.meta.url,
  ), 'utf8')
  const pendingSource = await readFile(new URL(
    '../src/ui/eventDeletionConfirmation.ts',
    import.meta.url,
  ), 'utf8')

  assert.match(source, /if \(!result\.ok\) \{[\s\S]*setEventDeletionError\([\s\S]*return[\s\S]*\}[\s\S]*setPendingEventDeletion\(undefined\)/)
  assert.match(source, /finally \{\s*setIsDeletingEvent\(false\)/)
  assert.match(source, /isDeleting=\{isDeletingEvent\}/)
  assert.match(source, /errorMessage=\{eventDeletionError\}/)
  assert.match(pendingSource,
    /hasUnsavedDraft: hasEventBasicInfoDraftChanges\(currentDraft, savedDraft\)/)
  assert.match(source,
    /pendingDeletion=\{pendingEventDeletion\}/)
  const confirmHandler = source.slice(
    source.indexOf('const confirmEventDeletion = async'),
    source.indexOf('const save =', source.indexOf('const confirmEventDeletion = async')),
  )
  assert.doesNotMatch(confirmHandler,
    /set(?:EventName|Description|Notes|DateInputs|SavedDraft)\(/)
  assert.match(source,
    /onCancel=\{\(\) => \{[\s\S]*setPendingEventDeletion\(undefined\)[\s\S]*\}\}/)
})
