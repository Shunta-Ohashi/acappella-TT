import { COMMON_BAND_CSV_HEADERS } from './commonBandCsv.ts'
import { COMMON_MEMBER_CSV_HEADERS } from './commonMemberCsv.ts'
import { EVENT_BAND_CSV_HEADERS } from './eventBandCsv.ts'
import { EVENT_MEMBER_CSV_HEADERS } from './eventMemberCsv.ts'
import { serializeCsv } from './csv.ts'

export interface CsvImportHelpColumn {
  name: string
  description: string
}

export interface CsvImportHelpContent {
  title: string
  description: string
  columns: CsvImportHelpColumn[]
  technicalColumns: CsvImportHelpColumn[]
  example: string
  notes: string[]
}

const createHelpColumns = (
  headers: readonly string[],
  descriptions: Readonly<Record<string, string>>,
  technicalHeaders: ReadonlySet<string>,
): Pick<CsvImportHelpContent, 'columns' | 'technicalColumns'> => {
  const columns: CsvImportHelpColumn[] = []
  const technicalColumns: CsvImportHelpColumn[] = []
  headers.forEach((name) => {
    const column = { name, description: descriptions[name] ?? '' }
    if (technicalHeaders.has(name)) technicalColumns.push(column)
    else columns.push(column)
  })
  return { columns, technicalColumns }
}

const createExample = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string => serializeCsv([headers, ...rows]).slice(1).trimEnd()

const memberColumnDescriptions = Object.fromEntries(
  Array.from({ length: 7 }, (_, index) => [
    `メンバー${index + 1}`,
    '共通メンバーの本名またはアカペラネームを完全一致で入力します。空欄は無視されます。',
  ]),
)

export const COMMON_MEMBER_CSV_HELP: CsvImportHelpContent = {
  title: '共通メンバーCSV',
  description: 'A列の本名から入力できます。ID列は通常入力不要で、既存データを更新するときだけ利用します。',
  ...createHelpColumns(COMMON_MEMBER_CSV_HEADERS, {
    本名: '必須です。1人につき1行入力します。',
    アカペラネーム: '任意です。',
    入学年度: '任意です。入力する場合は1以上の整数にします。',
    状態: '「在籍中」または「非在籍」です。新規行で空欄なら在籍中になります。',
    備考: '任意です。commaや改行を含む場合はCSVの引用符を利用できます。',
    メンバーID: '既存Memberの更新に使用します。新規追加は空欄にし、書き出したIDは変更しないことを推奨します。',
  }, new Set(['メンバーID'])),
  example: createExample(COMMON_MEMBER_CSV_HEADERS, [
    ['大橋俊太', 'しゅんた', '2024', '在籍中', '', ''],
    ['山田太郎', 'たろう', '2023', '非在籍', '休会中', 'member-abc'],
  ]),
  notes: ['メンバーIDが空の行は、同名の既存Memberがいても新しいMemberとして追加されます。'],
}

export const COMMON_BAND_CSV_HELP: CsvImportHelpContent = {
  title: '固定バンドCSV',
  description: 'A列にバンド名、B列以降にメンバー名を1人ずつ入力します。ID列は通常入力不要です。',
  ...createHelpColumns(COMMON_BAND_CSV_HEADERS, {
    バンド名: '必須です。1バンドにつき1行入力します。',
    ...memberColumnDescriptions,
    状態: '「活動中」または「活動終了」です。新規行で空欄なら活動中になります。',
    備考: '任意です。',
    バンドID: '既存Bandの更新に使用します。新規追加は空欄にします。',
    メンバーID一覧: '書き出し・再読み込み用です。値がある場合は名前列より優先されます。複数IDは「|」区切りです。',
  }, new Set(['バンドID', 'メンバーID一覧'])),
  example: createExample(COMMON_BAND_CSV_HEADERS, [
    ['Choir', 'しゅんた', 'たろう', 'はなこ', 'ゆうき', '', '', '', '活動中', '', '', ''],
    ['Modern', 'れん', 'みさき', 'かなで', 'りん', 'みなと', '', '', '活動中', '', 'band-modern', 'member-2|member-3|member-4|member-5|member-6'],
  ]),
  notes: ['8人以上の場合は「メンバー8」「メンバー9」のように連番の列を追加できます。'],
}

export const EVENT_MEMBER_CSV_HELP: CsvImportHelpContent = {
  title: 'イベントメンバーCSV',
  description: '1 Member × 1 EventDayを1行にします。メンバー名・開催日・参加状態から入力でき、ID列は通常入力不要です。',
  ...createHelpColumns(EVENT_MEMBER_CSV_HEADERS, {
    メンバー: '共通メンバーの本名またはアカペラネームを完全一致で入力します。',
    開催日: 'YYYY-MM-DD形式です。2日開催なら同じMemberについて2行作成します。',
    参加状態: '「参加」「不参加」「未定」のいずれかです。',
    'Main PA': '「可」または「不可」です。省略時は既存設定を維持し、新規Memberでは不可になります。',
    'Sub PA': '「可」または「不可」です。省略時は既存設定を維持し、新規Memberでは不可になります。',
    出演可能時間帯: '空欄は制限なし（終日出演可能）、「なし」は出演可能時間なしです。指定時間は09:00-12:00、複数rangeは09:00-11:00|13:00-17:00のように入力します。09:00-、-17:00も利用できます。',
    希望時間帯: '最大1rangeです。例: 13:00-15:00。',
    備考: '日ごとの任意メモです。',
    メンバーID: '名前より優先して共通Memberを特定するround-trip用の列です。',
    開催日ID: '日付より優先して現在のEventDayを特定するround-trip用の列です。',
  }, new Set(['メンバーID', '開催日ID'])),
  example: createExample(EVENT_MEMBER_CSV_HEADERS, [
    ['しゅんた', '2026-11-01', '参加', '可', '不可', '09:00-12:00|13:00-17:00', '13:00-15:00', '', '', ''],
    ['しゅんた', '2026-11-02', '参加', '可', '不可', '', '', '', 'member-abc', 'day-2'],
  ]),
  notes: ['同じMemberの複数日行ではMain PA・Sub PAを同じ値にしてください。'],
}

export const EVENT_BAND_CSV_HELP: CsvImportHelpContent = {
  title: '出演バンドCSV',
  description: 'バンド名・開催日・メンバー名・出演枠から作成できます。ID列は通常入力不要です。',
  ...createHelpColumns(EVENT_BAND_CSV_HEADERS, {
    バンド名: '必須です。1出演につき1行入力します。',
    開催日: 'YYYY-MM-DD形式です。',
    ...memberColumnDescriptions,
    出演枠: 'Eventで設定済みの分数を指定します。例: 7 / 9 / 12 / 17。',
    固定バンド名: '固定バンド由来なら正確なバンド名を入力します。企画バンドは空欄です。',
    出演バンドID: '既存EventBandの更新に使用します。新規出演バンドは必ず空欄にします。',
    開催日ID: '日付より優先して現在のEventDayを特定するround-trip用の列です。',
    固定バンドID: '固定バンド名より優先して作成元を特定するround-trip用の列です。',
    メンバーID一覧: '書き出し・再読み込み用です。値がある場合は名前列より優先されます。複数IDは「|」区切りです。',
    下書きID: '通常は編集不要です。保存前の出演バンドを書き出して同じ編集画面へ再読み込みするときに使用します。新規CSVでは空欄または列自体を省略できます。',
  }, new Set(['出演バンドID', '開催日ID', '固定バンドID', 'メンバーID一覧', '下書きID'])),
  example: createExample(EVENT_BAND_CSV_HEADERS, [
    ['Choir', '2026-11-01', 'しゅんた', 'たろう', 'はなこ', 'ゆうき', '', '', '', '12', 'Choir', '', '', '', '', ''],
    ['学祭企画', '2026-11-01', 'れん', 'みさき', 'かなで', 'りん', '', '', '', '7', '', '', '', '', '', ''],
  ]),
  notes: ['8人以上の場合は連番のメンバー列を追加できます。新規出演バンドへ任意IDを手入力することはできません。'],
}
