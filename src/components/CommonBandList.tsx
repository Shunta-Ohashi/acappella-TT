import { useState } from 'react'
import type { Band, BandId, Member } from '../domain/models'
import {
  filterCommonBands,
  resolveCommonBandMembers,
  type CommonBandDraft,
  type CommonBandStatusFilter,
  type CommonBandUpdateResult,
} from '../domain/commonBands'
import { BandEditorDialog } from './BandEditorDialog'

interface CommonBandListProps {
  bands: Band[]
  members: Member[]
  onSaveBand: (
    bandId: BandId | undefined,
    draft: CommonBandDraft,
  ) => CommonBandUpdateResult
}

type BandEditorState =
  | { mode: 'create' }
  | { mode: 'edit'; bandId: BandId }
  | undefined

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
}: CommonBandListProps) {
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] =
    useState<CommonBandStatusFilter>('active')
  const [bandEditor, setBandEditor] = useState<BandEditorState>()
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

  return (
    <section className="common-band-list" aria-labelledby="common-band-list-title">
      <header className="common-band-list__header">
        <div>
          <h2 id="common-band-list-title">固定バンド</h2>
          <p>複数のイベントで利用する固定バンドを管理します。</p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => setBandEditor({ mode: 'create' })}
        >
          <span aria-hidden="true">＋</span> 固定バンドを追加
        </button>
      </header>

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

      {bandEditor && (
        <BandEditorDialog
          key={bandEditor.mode === 'edit' ? bandEditor.bandId : 'new-band'}
          band={editingBand}
          members={members}
          onCancel={() => setBandEditor(undefined)}
          onSave={handleSaveBand}
        />
      )}
    </section>
  )
}
