import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv } from '../src/csv/csv.ts'
import {
  COMMON_MEMBER_CSV_HEADERS,
  createCommonMemberCsv,
  planCommonMemberCsvImport,
} from '../src/csv/commonMemberCsv.ts'
import {
  COMMON_BAND_CSV_HEADERS,
  createCommonBandCsv,
  planCommonBandCsvImport,
} from '../src/csv/commonBandCsv.ts'

const members = [
  { id: 'member-1', realName: '佐藤 花子', acaName: 'はな', entryAcademicYear: 2025, active: true, notes: '既存' },
  { id: 'member-2', realName: '鈴木 蓮', acaName: 'れん', active: true },
  { id: 'member-3', realName: '高橋 葵', acaName: 'あおい', active: false },
]

const bands = [
  { id: 'band-1', name: 'Choir', defaultMemberIds: ['member-1'], active: true, notes: '既存' },
  { id: 'band-2', name: 'Omitted', defaultMemberIds: ['member-2'], active: true },
]

const memberCsv = (rows) => [COMMON_MEMBER_CSV_HEADERS.join(','), ...rows].join('\n')
const bandCsv = (rows) => [COMMON_BAND_CSV_HEADERS.join(','), ...rows].join('\n')

test('Common Member CSVは日本語headerと特殊文字をround-trip可能な形でexportする', () => {
  const csv = createCommonMemberCsv([{ ...members[0], notes: 'comma,"quote"\nline' }])
  const parsed = parseCsv(csv)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...COMMON_MEMBER_CSV_HEADERS])
  assert.deepEqual(parsed.rows[1].cells, [
    'member-1', '佐藤 花子', 'はな', '2025', '在籍中', 'comma,"quote"\nline',
  ])
})

test('Common Memberが空でもheaderだけをexportする', () => {
  const parsed = parseCsv(createCommonMemberCsv([]))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.rows.length, 1)
})

test('Common Member importは既存更新・空ID作成・未知明示ID作成をatomicに計画する', () => {
  const before = structuredClone(members)
  const result = planCommonMemberCsvImport({
    csv: memberCsv([
      'member-1,佐藤 更新,はな,2024,inactive,更新',
      ',新規 一郎,,2026,1,',
      'portable-member,移行 太郎,,2023,在籍中,',
    ]),
    members,
    createMemberId: () => 'member-new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 2)
  assert.equal(result.updatedCount, 1)
  assert.equal(result.candidate.find((item) => item.id === 'member-1').active, false)
  assert.equal(result.candidate.some((item) => item.id === 'member-new'), true)
  assert.equal(result.candidate.some((item) => item.id === 'portable-member'), true)
  assert.equal(result.candidate.some((item) => item.id === 'member-2'), true)
  assert.deepEqual(members, before)
})

test('Common Member importはstatusの英語表現をcase-insensitiveに解釈する', () => {
  for (const [status, active] of [['ACTIVE', true], ['true', true], ['0', false], ['Inactive', false]]) {
    const result = planCommonMemberCsvImport({
      csv: memberCsv([`,Test,,2026,${status},`]), members: [], createMemberId: () => `id-${status}`,
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.candidate[0].active, active)
  }
})

test('Common Member importは重複IDとinvalid yearをrejectしcandidateを返さない', () => {
  const duplicate = planCommonMemberCsvImport({
    csv: memberCsv(['same,A,,2025,在籍中,', 'same,B,,2025,在籍中,']),
    members,
    createMemberId: () => 'unused',
  })
  assert.equal(duplicate.ok, false)
  const invalid = planCommonMemberCsvImport({
    csv: memberCsv([',A,,0,在籍中,']), members, createMemberId: () => 'new-id',
  })
  assert.equal(invalid.ok, false)
})

test('Common Band CSVはmember ID・名前と状態をexportする', () => {
  const parsed = parseCsv(createCommonBandCsv(bands.slice(0, 1), members))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...COMMON_BAND_CSV_HEADERS])
  assert.deepEqual(parsed.rows[1].cells.slice(0, 5), [
    'band-1', 'Choir', 'member-1', '佐藤 花子', '活動中',
  ])
})

test('Common Band importは既存更新と新規作成をmergeし省略Bandを維持する', () => {
  const beforeBands = structuredClone(bands)
  const beforeMembers = structuredClone(members)
  const result = planCommonBandCsvImport({
    csv: bandCsv([
      'band-1,Choir Updated,member-1|member-2,,false,更新',
      ',New Band,,佐藤 花子|鈴木 蓮,活動中,',
    ]),
    bands,
    members,
    createBandId: () => 'band-new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  assert.equal(result.updatedCount, 1)
  assert.deepEqual(result.candidate.find((item) => item.id === 'band-1').defaultMemberIds, ['member-1', 'member-2'])
  assert.deepEqual(result.candidate.find((item) => item.id === 'band-new').defaultMemberIds, ['member-1', 'member-2'])
  assert.equal(result.candidate.some((item) => item.id === 'band-2'), true)
  assert.deepEqual(bands, beforeBands)
  assert.deepEqual(members, beforeMembers)
})

test('Common Band importはMember IDを名前より優先する', () => {
  const result = planCommonBandCsvImport({
    csv: bandCsv([',ID wins,member-2,存在しない名前,1,']), bands: [], members,
    createBandId: () => 'band-new',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.candidate[0].defaultMemberIds, ['member-2'])
})

test('Common Band importはrealName後にunique acaNameでfallbackする', () => {
  const result = planCommonBandCsvImport({
    csv: bandCsv([',Names,,佐藤 花子|れん,active,']), bands: [], members,
    createBandId: () => 'band-new',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.candidate[0].defaultMemberIds, ['member-1', 'member-2'])
})

test('Common Band importはambiguous acaName・missing Member・duplicate Band IDをrejectする', () => {
  const ambiguousMembers = [...members, { id: 'member-4', realName: '別人', acaName: 'れん', active: true }]
  const ambiguous = planCommonBandCsvImport({
    csv: bandCsv([',Ambiguous,,れん,active,']), bands: [], members: ambiguousMembers,
    createBandId: () => 'band-new',
  })
  assert.equal(ambiguous.ok, false)
  const missing = planCommonBandCsvImport({
    csv: bandCsv([',Missing,missing-id,,active,']), bands: [], members,
    createBandId: () => 'band-new',
  })
  assert.equal(missing.ok, false)
  const duplicate = planCommonBandCsvImport({
    csv: bandCsv(['same,A,member-1,,active,', 'same,B,member-2,,active,']), bands: [], members,
    createBandId: () => 'unused',
  })
  assert.equal(duplicate.ok, false)
})

test('Common Band importはinvalid rowが1件でもある場合にatomic failureとなる', () => {
  const result = planCommonBandCsvImport({
    csv: bandCsv([',Valid,member-1,,active,', ',Invalid,missing,,active,']),
    bands, members, createBandId: (() => { let index = 0; return () => `new-${index += 1}` })(),
  })
  assert.equal(result.ok, false)
  assert.equal('candidate' in result, false)
})
