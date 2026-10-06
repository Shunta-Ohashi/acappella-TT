import { useState } from 'react'
import type { Band, BandId, Member, MemberId } from '../domain/models'
import type {
  CommonBandDraft,
  CommonBandUpdateResult,
} from '../domain/commonBands'
import type {
  CommonBandDeletionCheck,
  CommonBandDeletionResult,
  CommonMemberDeletionCheck,
  CommonMemberDeletionResult,
} from '../domain/commonDataDeletion'
import {
  filterCommonMembers,
  getBandsForMember,
  type CommonMemberDraft,
  type CommonMemberStatusFilter,
  type CommonMemberUpdateResult,
} from '../domain/commonMembers'
import { getDeleteConfirmationCopy } from '../ui/deleteConfirmation'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'
import { MemberEditorDialog } from './MemberEditorDialog'
import { CommonBandList } from './CommonBandList'
import { createCommonMemberCsv, planCommonMemberCsvImport } from '../csv/commonMemberCsv'
import { downloadCsv } from '../csv/csvBrowser'
import { CsvFileButton } from './CsvFileButton'
import {
  CsvImportPreviewDialog,
  type CsvImportPreview,
} from './CsvImportPreviewDialog'

interface CommonDataPageProps {
  members: Member[]
  bands: Band[]
  onSaveMember: (
    memberId: MemberId | undefined,
    draft: CommonMemberDraft,
  ) => CommonMemberUpdateResult
  onSaveBand: (
    bandId: BandId | undefined,
    draft: CommonBandDraft,
  ) => CommonBandUpdateResult
  checkMemberDeletion: (memberId: MemberId) => CommonMemberDeletionCheck
  onDeleteMember: (memberId: MemberId) => CommonMemberDeletionResult
  checkBandDeletion: (bandId: BandId) => CommonBandDeletionCheck
  onDeleteBand: (bandId: BandId) => CommonBandDeletionResult
  onImportMembers: (members: Member[]) => void
  onImportBands: (bands: Band[]) => void
  createMemberId: () => MemberId
  createBandId: () => BandId
}

type CommonDataSection = 'members' | 'bands'
type MemberEditorState =
  | { mode: 'create' }
  | { mode: 'edit'; memberId: MemberId }
  | undefined

interface PendingMemberDeletion {
  memberId: MemberId
  label: string
}

const getMemberDeletionError = (
  result: Exclude<CommonMemberDeletionCheck, { ok: true }>,
): string => result.reason === 'MEMBER_NOT_FOUND'
  ? '削除するメンバーが見つかりません。'
  : 'このメンバーは固定バンド、イベントの参加・出演情報、PA担当、または当日運営担当で使用されているため削除できません。サークルを離れたメンバーの場合は「非在籍」に変更してください。'

export function CommonDataPage({
  members,
  bands,
  onSaveMember,
  onSaveBand,
  checkMemberDeletion,
  onDeleteMember,
  checkBandDeletion,
  onDeleteBand,
  onImportMembers,
  onImportBands,
  createMemberId,
  createBandId,
}: CommonDataPageProps) {
  const [activeSection, setActiveSection] =
    useState<CommonDataSection>('members')
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] =
    useState<CommonMemberStatusFilter>('active')
  const [memberEditor, setMemberEditor] = useState<MemberEditorState>()
  const [pendingDeletion, setPendingDeletion] = useState<PendingMemberDeletion>()
  const [deletionError, setDeletionError] = useState('')
  const [memberCsvImport, setMemberCsvImport] = useState<{
    preview: CsvImportPreview
    candidate?: Member[]
  }>()
  const displayedMembers = filterCommonMembers(
    members,
    searchText,
    statusFilter,
  )
  const editingMember = memberEditor?.mode === 'edit'
    ? members.find((member) => member.id === memberEditor.memberId)
    : undefined

  const handleSaveMember = (draft: CommonMemberDraft) => {
    const result = onSaveMember(editingMember?.id, draft)
    if (result.ok) setMemberEditor(undefined)
    return result
  }

  const requestMemberDeletion = (member: Member) => {
    const check = checkMemberDeletion(member.id)
    if (!check.ok) {
      setDeletionError(getMemberDeletionError(check))
      return
    }

    setDeletionError('')
    setPendingDeletion({ memberId: member.id, label: member.realName })
  }

  const confirmMemberDeletion = () => {
    if (!pendingDeletion) return

    const result = onDeleteMember(pendingDeletion.memberId)
    setPendingDeletion(undefined)
    if (!result.ok) {
      setDeletionError(getMemberDeletionError(result))
      return
    }

    setDeletionError('')
  }

  return (
    <main className="common-data-page">
      <header className="common-data-page__header">
        <p>Acappella TT</p>
        <h1>共通データ</h1>
        <span>サークル全体で共通して使用するデータを管理します。</span>
      </header>

      <nav className="common-data-navigation" aria-label="共通データの種類">
        <button
          type="button"
          className={activeSection === 'members'
            ? 'common-data-navigation__button common-data-navigation__button--active'
            : 'common-data-navigation__button'}
          aria-pressed={activeSection === 'members'}
          onClick={() => setActiveSection('members')}
        >
          メンバー
        </button>
        <button
          type="button"
          className={activeSection === 'bands'
            ? 'common-data-navigation__button common-data-navigation__button--active'
            : 'common-data-navigation__button'}
          aria-pressed={activeSection === 'bands'}
          onClick={() => setActiveSection('bands')}
        >
          固定バンド
        </button>
      </nav>

      {activeSection === 'members' ? (
        <section className="common-member-list" aria-labelledby="common-member-list-title">
          <header className="common-member-list__header">
            <div>
              <h2 id="common-member-list-title">メンバー</h2>
              <p>イベントで使用する共通の人物情報を管理します。</p>
            </div>
            <div className="csv-action-buttons">
              <CsvFileButton
                onRead={(fileName, text) => {
                  const plan = planCommonMemberCsvImport({
                    csv: text, members, createMemberId,
                  })
                  setMemberCsvImport(plan.ok
                    ? {
                        candidate: plan.candidate,
                        preview: { datasetName: '共通メンバー', fileName, errors: [], ...plan },
                      }
                    : { preview: { datasetName: '共通メンバー', fileName, errors: plan.errors } })
                }}
                onError={(fileName, errors) => setMemberCsvImport({
                  preview: { datasetName: '共通メンバー', fileName, errors },
                })}
              />
              <button type="button" className="secondary-button"
                onClick={() => downloadCsv(createCommonMemberCsv(members), 'acappella-tt-members.csv')}>
                CSV書き出し
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setMemberEditor({ mode: 'create' })}
              >
                <span aria-hidden="true">＋</span> メンバーを追加
              </button>
            </div>
          </header>
          <p className="csv-id-help">
            ID列は既存データの更新とデータ間の参照に使用します。新規追加する行では空欄にできます。
          </p>

          <div className="common-member-list__filters">
            <div>
              <label htmlFor="common-member-search">検索</label>
              <input
                id="common-member-search"
                type="search"
                value={searchText}
                placeholder="名前・アカペラネームで検索"
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="common-member-status-filter">状態</label>
              <select
                id="common-member-status-filter"
                value={statusFilter}
                onChange={(event) => setStatusFilter(
                  event.target.value as CommonMemberStatusFilter,
                )}
              >
                <option value="active">在籍中</option>
                <option value="inactive">非在籍</option>
                <option value="all">すべて</option>
              </select>
            </div>
          </div>

          {deletionError && (
            <p className="common-data-deletion-error" role="alert">
              {deletionError}
            </p>
          )}

          <div className="common-member-list__table-card">
            <div className="common-member-list__table-scroll">
              <table className="common-member-list__table">
                <thead>
                  <tr>
                    <th scope="col">本名</th>
                    <th scope="col">アカペラネーム</th>
                    <th scope="col">入学年度</th>
                    <th scope="col">状態</th>
                    <th scope="col">固定バンド</th>
                    <th scope="col"><span className="visually-hidden">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {displayedMembers.map((member) => {
                    const memberBands = getBandsForMember(member.id, bands)

                    return (
                      <tr key={member.id}>
                        <th scope="row">{member.realName}</th>
                        <td>{member.acaName || '－'}</td>
                        <td>{member.entryAcademicYear ?? '－'}</td>
                        <td>
                          <span className={member.active
                            ? 'common-member-status common-member-status--active'
                            : 'common-member-status common-member-status--inactive'}>
                            {member.active ? '在籍中' : '非在籍'}
                          </span>
                        </td>
                        <td>
                          <strong>{memberBands.length}組</strong>
                          {memberBands.length > 0 && (
                            <small>{memberBands.map((band) => band.name).join('、')}</small>
                          )}
                        </td>
                        <td>
                          <div className="common-data-list__actions">
                            <button
                              type="button"
                              className="common-member-list__edit"
                              aria-label={`${member.realName}を編集`}
                              onClick={() => setMemberEditor({
                                mode: 'edit',
                                memberId: member.id,
                              })}
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              className="common-member-list__delete"
                              aria-label={`${member.realName}を削除`}
                              onClick={() => requestMemberDeletion(member)}
                            >
                              削除
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {displayedMembers.length === 0 && (
              <div className="common-member-list__empty">
                {members.length === 0 ? (
                  <>
                    <strong>メンバーはまだ登録されていません。</strong>
                    <span>「＋ メンバーを追加」から最初のメンバーを登録してください。</span>
                  </>
                ) : (
                  <span>検索・状態条件に一致するメンバーはいません。</span>
                )}
              </div>
            )}
          </div>
        </section>
      ) : (
        <CommonBandList
          bands={bands}
          members={members}
          onSaveBand={onSaveBand}
          checkBandDeletion={checkBandDeletion}
          onDeleteBand={onDeleteBand}
          onImportBands={onImportBands}
          createBandId={createBandId}
        />
      )}

      {memberEditor && (
        <MemberEditorDialog
          key={memberEditor.mode === 'edit'
            ? memberEditor.memberId
            : 'new-member'}
          member={editingMember}
          onCancel={() => setMemberEditor(undefined)}
          onSave={handleSaveMember}
        />
      )}
      {memberCsvImport && (
        <CsvImportPreviewDialog
          preview={memberCsvImport.preview}
          onCancel={() => setMemberCsvImport(undefined)}
          onConfirm={memberCsvImport.candidate ? () => {
            onImportMembers(memberCsvImport.candidate as Member[])
            setMemberCsvImport(undefined)
          } : undefined}
        />
      )}
      {pendingDeletion && (() => {
        const copy = getDeleteConfirmationCopy(
          'common-member',
          pendingDeletion.label,
        )
        return (
          <DeleteConfirmationDialog
            {...copy}
            onCancel={() => setPendingDeletion(undefined)}
            onConfirm={confirmMemberDeletion}
          />
        )
      })()}
    </main>
  )
}
