import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv, serializeCsv } from '../src/csv/csv.ts'
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

const csv = (headers, rows) => serializeCsv([headers, ...rows])

test('Common Member exportは人間向け列を左、IDを右端にして特殊文字をround-tripする', () => {
  const parsed = parseCsv(createCommonMemberCsv([{ ...members[0], notes: 'comma,"quote"\nline' }]))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...COMMON_MEMBER_CSV_HEADERS])
  assert.deepEqual(parsed.rows[1].cells, [
    '佐藤 花子', 'はな', '2025', '在籍中', 'comma,"quote"\nline', 'member-1',
  ])
  assert.equal(parsed.rows[0].cells.at(-1), 'メンバーID')
})

test('Common Memberが空でも新形式のheaderだけをexportする', () => {
  const parsed = parseCsv(createCommonMemberCsv([]))
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.rows.map((row) => row.cells), [[...COMMON_MEMBER_CSV_HEADERS]])
})

test('Common MemberのExportはIDを維持してそのまま再Importできる', () => {
  const result = planCommonMemberCsvImport({
    csv: createCommonMemberCsv(members), members, createMemberId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 0)
  assert.equal(result.updatedCount, members.length)
  assert.deepEqual(JSON.parse(JSON.stringify(result.candidate)), members)
})

test('Common Memberのformula-likeな正当値は安全化してExportしImportで復元する', () => {
  const formulaMember = {
    id: 'member-formula',
    realName: '=LOVE',
    acaName: '+TEST',
    active: true,
    notes: '@USER',
  }
  const exported = createCommonMemberCsv([formulaMember])
  const raw = parseCsv(exported)
  assert.equal(raw.ok, true)
  if (!raw.ok) return
  assert.deepEqual(raw.rows[1].cells.slice(0, 2), ["'=LOVE", "'+TEST"])
  assert.equal(raw.rows[1].cells[4], "'@USER")

  const imported = planCommonMemberCsvImport({
    csv: exported,
    members: [formulaMember],
    createMemberId: () => 'unused',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) {
    assert.deepEqual(JSON.parse(JSON.stringify(imported.candidate)), [formulaMember])
  }
})

test('Common Memberは本名だけのCSVと技術header省略を許可しIDなし行を常に新規作成する', () => {
  const result = planCommonMemberCsvImport({
    csv: csv(['本名'], [['佐藤 花子']]),
    members,
    createMemberId: () => 'member-new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  assert.equal(result.updatedCount, 0)
  assert.equal(result.candidate.find((item) => item.id === 'member-new').active, true)
  assert.equal(result.candidate.find((item) => item.id === 'member-1').realName, '佐藤 花子')
})

test('Common Memberは右端IDで既存更新し未知明示IDで作成する', () => {
  const result = planCommonMemberCsvImport({
    csv: csv(COMMON_MEMBER_CSV_HEADERS, [
      ['佐藤 更新', 'はな', '2024', '', '更新', 'member-1'],
      ['移行 太郎', '', '2023', '在籍中', '', 'portable-member'],
    ]),
    members,
    createMemberId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  assert.equal(result.updatedCount, 1)
  assert.equal(result.candidate.find((item) => item.id === 'member-1').active, true)
  assert.equal(result.candidate.find((item) => item.id === 'portable-member').realName, '移行 太郎')
})

test('Common Member既存更新で状態header省略または空欄なら既存状態を維持する', () => {
  for (const source of [
    csv(['本名', 'メンバーID'], [['高橋 更新', 'member-3']]),
    csv(COMMON_MEMBER_CSV_HEADERS, [['高橋 更新', '', '', '', '', 'member-3']]),
  ]) {
    const result = planCommonMemberCsvImport({ csv: source, members, createMemberId: () => 'unused' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.candidate.find((item) => item.id === 'member-3').active, false)
  }
})

test('Common Memberは既存の英語statusを解釈し重複ID・invalid yearをatomicにrejectする', () => {
  for (const [status, expected] of [['ACTIVE', true], ['INACTIVE', false], ['TRUE', true], ['FALSE', false]]) {
    const english = planCommonMemberCsvImport({
      csv: csv(['本名', '状態'], [['Test', status]]), members: [], createMemberId: () => `new-${status}`,
    })
    assert.equal(english.ok, true)
    if (english.ok) assert.equal(english.candidate[0].active, expected)
  }
  const duplicate = planCommonMemberCsvImport({
    csv: csv(COMMON_MEMBER_CSV_HEADERS, [
      ['A', '', '2025', '在籍中', '', 'same'],
      ['B', '', '2025', '在籍中', '', 'same'],
    ]), members, createMemberId: () => 'unused',
  })
  assert.equal(duplicate.ok, false)
  const invalid = planCommonMemberCsvImport({
    csv: csv(['本名', '入学年度'], [['A', '0']]), members, createMemberId: () => 'new-id',
  })
  assert.equal(invalid.ok, false)
  assert.equal('candidate' in invalid, false)
})

test('Common Bandはlocale非依存でuppercase英語statusを解釈する', () => {
  for (const [status, expected] of [['ACTIVE', true], ['INACTIVE', false], ['TRUE', true], ['FALSE', false]]) {
    const result = planCommonBandCsvImport({
      csv: csv(['バンド名', 'メンバー1', '状態'], [['Band', 'はな', status]]),
      bands: [], members, createBandId: () => `band-${status}`,
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.candidate[0].active, expected)
  }
})

test('Common Band exportは最低7つの名前列と右端の技術列を持つ', () => {
  const parsed = parseCsv(createCommonBandCsv(bands.slice(0, 1), members))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.rows[0].cells, [...COMMON_BAND_CSV_HEADERS])
  assert.deepEqual(parsed.rows[1].cells.slice(0, 4), ['Choir', '佐藤 花子', '', ''])
  assert.deepEqual(parsed.rows[0].cells.slice(-2), ['バンドID', 'メンバーID一覧'])
  assert.deepEqual(parsed.rows[1].cells.slice(-2), ['band-1', 'member-1'])
})

test('Common Band exportは最大Member数に合わせて8列以上へ拡張する', () => {
  const largeMembers = Array.from({ length: 9 }, (_, index) => ({
    id: `large-${index + 1}`, realName: `Real ${index + 1}`, acaName: `Member ${index + 1}`, active: true,
  }))
  const parsed = parseCsv(createCommonBandCsv([{
    id: 'large-band', name: 'Large', defaultMemberIds: largeMembers.map((item) => item.id), active: true,
  }], largeMembers))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.rows[0].cells.includes('メンバー9'), true)
  assert.equal(parsed.rows[1].cells[9], 'Real 9')
  assert.equal(parsed.rows[0].cells.at(-1), 'メンバーID一覧')
})

test('Common BandのExportは技術IDを使ってそのまま再Importできる', () => {
  const result = planCommonBandCsvImport({
    csv: createCommonBandCsv(bands, members), bands, members, createBandId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 0)
  assert.equal(result.updatedCount, bands.length)
  assert.deepEqual(JSON.parse(JSON.stringify(result.candidate)), bands)
})

test('Common Bandのhuman member列は本名を使いcross-field collisionを避ける', () => {
  const configuredMembers = [
    { id: 'member-a', realName: '山田太郎', acaName: 'たろう', active: true },
    { id: 'member-b', realName: 'たろう', acaName: 'びー', active: true },
  ]
  const configuredBand = {
    id: 'band-cross-field', name: 'Cross field', defaultMemberIds: ['member-a'], active: true,
  }
  const exported = parseCsv(createCommonBandCsv([configuredBand], configuredMembers))
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  assert.equal(exported.rows[1].cells[1], '山田太郎')

  const imported = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1'], [['Cross field', exported.rows[1].cells[1]]]),
    bands: [], members: configuredMembers, createBandId: () => 'imported-band',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) assert.deepEqual(imported.candidate[0].defaultMemberIds, ['member-a'])

  const ambiguous = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1'], [['Ambiguous', '山田太郎']]),
    bands: [],
    members: [...configuredMembers, {
      id: 'member-c', realName: '山田太郎', acaName: 'しー', active: true,
    }],
    createBandId: () => 'ambiguous-band',
  })
  assert.equal(ambiguous.ok, false)
})

test('Common Bandのformula-likeなhuman文字列をSpreadsheet-safeにexportする', () => {
  const configuredMembers = [{ id: 'formula-member', realName: '+MEMBER', active: true }]
  const configuredBand = {
    id: 'formula-band', name: '=BAND', defaultMemberIds: ['formula-member'], active: true,
  }
  const csvSource = createCommonBandCsv([configuredBand], configuredMembers)
  const exported = parseCsv(csvSource)
  assert.equal(exported.ok, true)
  if (!exported.ok) return
  assert.deepEqual(exported.rows[1].cells.slice(0, 2), ["'=BAND", "'+MEMBER"])

  const imported = planCommonBandCsvImport({
    csv: csvSource,
    bands: [configuredBand],
    members: configuredMembers,
    createBandId: () => 'unused',
  })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  if (imported.ok) assert.equal(imported.candidate[0].name, '=BAND')
})

test('Common Bandはバンド名と名前列だけで作成し途中の空cellを無視する', () => {
  const result = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1', 'メンバー2', 'メンバー3'], [
      ['New Band', 'はな', '', '鈴木 蓮'],
    ]),
    bands, members, createBandId: () => 'band-new',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.createdCount, 1)
  assert.deepEqual(result.candidate.find((item) => item.id === 'band-new').defaultMemberIds, ['member-1', 'member-2'])
})

test('Common Band importはメンバー8以上と技術header省略を認識する', () => {
  const eightMembers = Array.from({ length: 8 }, (_, index) => ({
    id: `m-${index + 1}`, realName: `Member ${index + 1}`, active: true,
  }))
  const headers = ['バンド名', ...Array.from({ length: 8 }, (_, index) => `メンバー${index + 1}`)]
  const result = planCommonBandCsvImport({
    csv: csv(headers, [['Eight', ...eightMembers.map((item) => item.realName)]]),
    bands: [], members: eightMembers, createBandId: () => 'band-eight',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.candidate[0].defaultMemberIds, eightMembers.map((item) => item.id))
})

test('Common Band importはメンバーID一覧を名前列より優先する', () => {
  const result = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1', 'メンバーID一覧'], [['ID wins', '存在しない名前', 'member-2']]),
    bands: [], members, createBandId: () => 'band-new',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.candidate[0].defaultMemberIds, ['member-2'])
})

test('Common BandはIDで更新・未知明示IDで作成し、省略Bandを維持する', () => {
  const result = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1', '状態', 'バンドID'], [
      ['Choir Updated', 'はな', '', 'band-1'],
      ['Portable', 'れん', '活動中', 'portable-band'],
    ]),
    bands, members, createBandId: () => 'unused',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.updatedCount, 1)
  assert.equal(result.createdCount, 1)
  assert.equal(result.candidate.find((item) => item.id === 'band-1').notes, '既存')
  assert.equal(result.candidate.some((item) => item.id === 'band-2'), true)
})

test('Common Band name resolutionはrealNameを優先しambiguous・missing・duplicate Memberをrejectする', () => {
  const sameAca = [...members, { id: 'member-4', realName: '別人', acaName: 'れん', active: true }]
  const cases = [
    { configuredMembers: sameAca, rows: [['Ambiguous', 'れん']] },
    { configuredMembers: members, rows: [['Missing', 'missing']] },
    { configuredMembers: members, rows: [['Duplicate', 'はな', '佐藤 花子']] },
  ]
  for (const item of cases) {
    const result = planCommonBandCsvImport({
      csv: csv(['バンド名', 'メンバー1', 'メンバー2'], item.rows),
      bands: [], members: item.configuredMembers, createBandId: () => 'new',
    })
    assert.equal(result.ok, false)
  }
})

test('Common Band name resolutionはacaNameよりrealNameの完全一致を優先する', () => {
  const configuredMembers = [
    { id: 'real', realName: '同じ名前', acaName: 'real-aca', active: true },
    { id: 'aca', realName: '別の本名', acaName: '同じ名前', active: true },
  ]
  const result = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1'], [['Priority', '同じ名前']]),
    bands: [], members: configuredMembers, createBandId: () => 'new',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.candidate[0].defaultMemberIds, ['real'])
})

test('Common Bandは不連続または不正なメンバー列をrejectする', () => {
  for (const headers of [
    ['バンド名', 'メンバー1', 'メンバー3'],
    ['バンド名', 'メンバー0'],
  ]) {
    const result = planCommonBandCsvImport({
      csv: csv(headers, [['Bad', 'はな', 'れん']]), bands: [], members, createBandId: () => 'new',
    })
    assert.equal(result.ok, false)
  }
})

test('Common Band importはinvalid rowが1件でもある場合にatomic failureとなる', () => {
  const result = planCommonBandCsvImport({
    csv: csv(['バンド名', 'メンバー1'], [['Valid', 'はな'], ['Invalid', 'missing']]),
    bands, members, createBandId: (() => { let index = 0; return () => `new-${index += 1}` })(),
  })
  assert.equal(result.ok, false)
  assert.equal('candidate' in result, false)
})
