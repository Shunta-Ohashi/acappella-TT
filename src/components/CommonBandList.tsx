import { useState } from 'react'
import type { Band, BandId, Member } from '../domain/models'
import {
  filterCommonBands,
  resolveCommonBandMembers,
  type CommonBandDraft,
  type CommonBandStatusFilter,
  type CommonBandUpdateResult,
} from '../domain/commonBands'
import type {
  CommonBandDeletionCheck,
  CommonBandDeletionResult,
} from '../domain/commonDataDeletion'
import { getDeleteConfirmationCopy } from '../ui/deleteConfirmation'
import { BandEditorDialog } from './BandEditorDialog'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'
import { createCommonBandCsv, planCommonBandCsvImport } from '../csv/commonBandCsv'
import { downloadCsv } from '../csv/csvBrowser'
import { CsvFileButton } from './CsvFileButton'
import { CsvImportPreviewDialog, type CsvImportPreview } from './CsvImportPreviewDialog'
import { COMMON_BAND_CSV_HELP } from '../csv/csvHelp'
import { CsvImportHelpPopover } from './CsvImportHelpPopover'

interface CommonBandListProps {
  bands: Band[]
  members: Member[]
  onSaveBand: (
    bandId: BandId | undefined,
    draft: CommonBandDraft,
  ) => CommonBandUpdateResult
  checkBandDeletion: (bandId: BandId) => CommonBandDeletionCheck
  onDeleteBand: (bandId: BandId) => CommonBandDeletionResult
  onImportBands: (bands: Band[]) => void
  createBandId: () => BandId
  readOnly?: boolean
}

type BandEditorState =
  | { mode: 'create' }
  | { mode: 'edit'; bandId: BandId }
  | undefined

interface PendingBandDeletion {
  bandId: BandId
  label: string
}

const getBandDeletionError = (
  result: Exclude<CommonBandDeletionCheck, { ok: true }>,
): string => result.reason === 'BAND_NOT_FOUND'
  ? '削除する固定バンドが見つかりません。'
  : 'この固定バンドはイベントで使用されているため削除できません。今後使用しない場合は「活動終了」に変更してください。'

const formatMemberSummary = (band: Band, members: Member[]): string => {
  const resolvedMembers = resolveCommonBandMembers(band, members)
  const visibleNames = resolvedMembers
    .slice(0, 4)
    .map((resolvedMember) => resolvedMember.displayName)
  const remainingCount = resolvedMembers.length - visibleNames.length

  return [
    visibleNames.join(' / '),
    remainingCount > 0 ? `ほか${remainingCount}人` : undefined,
  ].filter((value): value is string => Boolean(value)).join(' / ') || 'メンバー未設定'
}

export function CommonBandList({
  bands,
  members,
  onSaveBand,
  checkBandDeletion,
  onDeleteBand,
  onImportBands,
  createBandId,
  readOnly = false,
}: CommonBandListProps) {
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] =
    useState<CommonBandStatusFilter>('active')
  const [bandEditor, setBandEditor] = useState<BandEditorState>()
  const [pendingDeletion, setPendingDeletion] = useState<PendingBandDeletion>()
  const [deletionError, setDeletionError] = useState('')
  const [csvImport, setCsvImport] = useState<{
    preview: CsvImportPreview
    candidate?: Band[]
  }>()
  const displayedBands = filterCommonBands(bands, searchText, statusFilter)
  const editingBand = bandEditor?.mode === 'edit'
    ? bands.find((band) => band.id === bandEditor.bandId)
    : undefined

  const handleSaveBand = (draft: CommonBandDraft) => {
    const result = onSaveBand(
      bandEditor?.mode === 'edit' ? bandEditor.bandId : undefined,
      draft,
    )
    if (result.ok) setBandEditor(undefined)
    return result
  }

  const requestBandDeletion = (band: Band) => {
    const check = checkBandDeletion(band.id)
    if (!check.ok) {
      setDeletionError(getBandDeletionError(check))
      return
    }

    setDeletionError('')
    setPendingDeletion({ bandId: band.id, label: band.name })
  }

  const confirmBandDeletion = () => {
    if (!pendingDeletion) return

    const result = onDeleteBand(pendingDeletion.bandId)
    setPendingDeletion(undefined)
    if (!result.ok) {
      setDeletionError(getBandDeletionError(result))
      return
    }

    setDeletionError('')
  }

  return (
    <section className="common-band-list" aria-labelledby="common-band-list-title">
      <header className="common-band-list__header">
        <div>
          <h2 id="common-band-list-title">固定バンド</h2>
          <p>複数のイベントで利用する固定バンドを管理します。</p>
        </div>
        <div className="csv-action-buttons">
          {!readOnly && <div className="csv-import-control">
            <CsvFileButton
              onRead={(fileName, text) => {
                const plan = planCommonBandCsvImport({ csv: text, bands, members, createBandId })
                setCsvImport(plan.ok
                  ? { candidate: plan.candidate, preview: {
                      datasetName: '固定バンド', fileName, errors: [], ...plan,
                    } }
                  : { preview: { datasetName: '固定バンド', fileName, errors: plan.errors } })
              }}
              onError={(fileName, errors) => setCsvImport({
                preview: { datasetName: '固定バンド', fileName, errors },
              })}
            />
            <CsvImportHelpPopover content={COMMON_BAND_CSV_HELP} />
          </div>}
          <button type="button" className="secondary-button"
            onClick={() => downloadCsv(createCommonBandCsv(bands, members), 'acappella-tt-bands.csv')}>
            CSV書き出し
          </button>
          {!readOnly && <button
            type="button"
            className="primary-button"
            onClick={() => setBandEditor({ mode: 'create' })}
          >
            <span aria-hidden="true">＋</span> 固定バンドを追加
          </button>}
        </div>
      </header>
      <p className="csv-id-help">
        ID列は既存データの更新とメンバー参照に使用します。新規追加する行では空欄にできます。
      </p>

      <div className="common-band-list__filters">
        <div>
          <label htmlFor="common-band-search">検索</label>
          <input
            id="common-band-search"
            type="search"
            value={searchText}
            placeholder="バンド名で検索"
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="common-band-status-filter">状態</label>
          <select
            id="common-band-status-filter"
            value={statusFilter}
            onChange={(event) => setStatusFilter(
              event.target.value as CommonBandStatusFilter,
            )}
          >
            <option value="active">活動中</option>
            <option value="inactive">活動終了</option>
            <option value="all">すべて</option>
          </select>
        </div>
      </div>

      {deletionError && (
        <p className="common-data-deletion-error" role="alert">
          {deletionError}
        </p>
      )}

      <div className="common-band-list__table-card">
        <div className="common-band-list__table-scroll">
          <table className="common-band-list__table">
            <thead>
              <tr>
                <th scope="col">バンド名</th>
                <th scope="col">メンバー</th>
                <th scope="col">状態</th>
                <th scope="col"><span className="visually-hidden">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {displayedBands.map((band) => {
                const memberCount = resolveCommonBandMembers(band, members).length

                return (
                  <tr key={band.id}>
                    <th scope="row">{band.name}</th>
                    <td>
                      <strong>{memberCount}人</strong>
                      <small>{formatMemberSummary(band, members)}</small>
                    </td>
                    <td>
                      <span className={band.active
                        ? 'common-band-status common-band-status--active'
                        : 'common-band-status common-band-status--inactive'}>
                        {band.active ? '活動中' : '活動終了'}
                      </span>
                    </td>
                    <td>
                      {!readOnly && <div className="common-data-list__actions">
                        <button
                          type="button"
                          className="common-band-list__edit"
                          aria-label={`${band.name}を編集`}
                          onClick={() => setBandEditor({
                            mode: 'edit',
                            bandId: band.id,
                          })}
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          className="common-band-list__delete"
                          aria-label={`${band.name}を削除`}
                          onClick={() => requestBandDeletion(band)}
                        >
                          削除
                        </button>
                      </div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {displayedBands.length === 0 && (
          <div className="common-band-list__empty">
            {bands.length === 0 ? (
              <>
                <strong>固定バンドはまだ登録されていません。</strong>
                <span>「＋ 固定バンドを追加」から最初の固定バンドを登録してください。</span>
              </>
            ) : (
              <span>検索・状態条件に一致する固定バンドはありません。</span>
            )}
          </div>
        )}
      </div>

      {!readOnly && bandEditor && (
        <BandEditorDialog
          key={bandEditor.mode === 'edit' ? bandEditor.bandId : 'new-band'}
          band={editingBand}
          members={members}
          onCancel={() => setBandEditor(undefined)}
          onSave={handleSaveBand}
        />
      )}
      {!readOnly && csvImport && (
        <CsvImportPreviewDialog
          preview={csvImport.preview}
          onCancel={() => setCsvImport(undefined)}
          onConfirm={csvImport.candidate ? () => {
            onImportBands(csvImport.candidate as Band[])
            setCsvImport(undefined)
          } : undefined}
        />
      )}
      {!readOnly && pendingDeletion && (() => {
        const copy = getDeleteConfirmationCopy(
          'common-band',
          pendingDeletion.label,
        )
        return (
          <DeleteConfirmationDialog
            {...copy}
            onCancel={() => setPendingDeletion(undefined)}
            onConfirm={confirmBandDeletion}
          />
        )
      })()}
    </section>
  )
}
