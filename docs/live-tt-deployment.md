# Live TT deployment foundation runbook

この手順は、現行Cloud Snapshot V1アプリを新しいVercel＋Supabaseテスト環境へ公開する
ためのものです。Live TT、Realtime、Workspaceの`ready`切替、Atomic Cutoverは実行
しません。既存DBをresetせず、新規テストProjectだけを対象にします。

## 1. 公開する契約

- 通常画面は登録済みユーザーのEmail Magic LinkとWorkspace membershipで保護する
- Cloud Eventは現行Snapshot V1の保存・page読込・削除を使用する
- 公開用`#share=...`は認証不要の静的hash routeとして維持する
- envなしのlocal開発は従来どおりlocal-only modeを利用できる
- VercelではCloud設定が欠けたbuildを失敗させ、local-only公開を防ぐ

2026年10月21日時点のrepositoryには16 migrationがあります。新しい空のSupabaseテスト
Projectには、`20261021050414_live_timetable_operator_ui.sql`までをversion順に適用します。
9〜14番目は将来のV2基盤を追加しますが、migration適用だけではWorkspace Masterの
backfill、Atomic Cutover、`ready`切替を実行せず、現行AppのV1保存・hydrateも切り替え
ません。15番目は独立したLive TT backend foundation、16番目は運営向けLive TT UIの
認可・discovery契約を追加します。migration適用だけではLive投影の作成、匿名公開、
既存Eventの変更を行いません。今回の公開手順ではbackfillや
`cutover_cloud_v2_validated()`を実行せず、AppのV2 hydrate/saveも有効化しません。

## 2. 事前準備

PowerShell 7でrepository rootへ移動し、CLIとローカル検証を確認します。

```powershell
cd '<REPOSITORY_PATH>'
node --version       # 24.x必須
corepack enable
pnpm --version       # 10.x
supabase --version
pnpm install --frozen-lockfile
pnpm test
pnpm exec tsc -b
pnpm lint
pnpm build
```

最後のbuildは`VERCEL`が未設定ならCloud envなしでも成功し、local-only開発を維持します。
公開用検証をローカルで再現するときだけ、次の3値を現在のshellへ設定します。値は
`.env.local`、ログ、Gitへ保存しません。

```powershell
$env:VITE_CLOUD_REQUIRED = 'true'
$env:VITE_SUPABASE_URL = 'https://<PROJECT_REF>.supabase.co'
$env:VITE_SUPABASE_PUBLISHABLE_KEY = '<PUBLISHABLE_KEY>'
pnpm build
Remove-Item Env:VITE_CLOUD_REQUIRED, Env:VITE_SUPABASE_URL, Env:VITE_SUPABASE_PUBLISHABLE_KEY
```

## 3. SupabaseテストProject

1. Supabase Dashboardで学祭用とは分離した新規テストProjectを作成する。
2. Project ref、HTTPS Project URL、Publishable Keyを控える。DB passwordとserver keyは
   password manager等で管理し、frontend、Vercel、Gitへ入れない。
3. Authenticationの公開signupを無効化する。アプリ側も`shouldCreateUser: false`のため、
   Dashboardで事前作成したユーザーだけがMagic Linkを要求できる。
4. Authenticationのメールproviderを有効にし、SMTP設定、送信元、送信制限をDashboardで
   確認する。学祭前に実アドレスへの到達時間とrate limitを確認する。

### Migrationの確認と適用

新規で空のテストProjectだけをlinkします。既存Projectや既存DBへこの手順を流用しません。

```powershell
supabase login
supabase link --project-ref '<PROJECT_REF>'
supabase migration list --linked
supabase db push --linked --dry-run
# dry-runがrepositoryの全16 migrationをversion順に提示することを目視確認する
supabase db push --linked
supabase migration list --linked
```

適用後はremote側に15 versionが順番どおり存在し、未適用・未知versionがないことを確認
します。migrationが失敗した場合は公開へ進まず、schema catalogと
`supabase_migrations.schema_migrations`を確認します。既存migrationを手動再実行したり、
履歴だけを成功扱いにしたりしません。履歴不一致の調査方法は
[migration history repair runbook](./cloud-event-migration-history-repair.md)を使用します。

14番目はbackend-onlyのAtomic Cutover基盤を追加するだけです。適用してもbackfill、
Snapshot V1行のV2変換、Workspaceの`ready`切替は自動実行されません。この公開手順では
backfill RPCや`cutover_cloud_v2_validated()`を呼び出さず、現行Snapshot V1アプリを
そのまま配備します。

15・16番目のLive TT migrationも既存Eventから投影を自動作成せず、Live進行や匿名公開を自動で有効に
しません。`create-live-timetable` FunctionとLive UIはこのV1公開手順の必須要素ではなく、
使い捨て環境での専用検証を完了するまでHostedへ配備しません。

Catalog regressionは一時的なcatalog変更をtransaction内で行うため、共有オンラインProject
では実行しません。必要なら同じ16 migrationを適用した別の使い捨てDBで実行します。

## 4. V1 Edge Function

現行AppがCloud保存に必要とするFunctionは`save-cloud-event`だけです。
`workspace-masters`と`save-cloud-event-v2`はV2専用基盤であり、今回のV1公開には配備
しません。

```powershell
deno check --frozen `
  --config supabase/functions/save-cloud-event/deno.json `
  supabase/functions/save-cloud-event/index.ts
supabase functions deploy save-cloud-event --project-ref '<PROJECT_REF>'
```

`--no-verify-jwt`は使用しません。Hosted Edge Runtimeが同じProject用に提供する
`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`をFunctionだけが読み、
handlerはBearer tokenをさらに`auth.getUser()`で検証します。これらserver-side値を
`VITE_` envやVercelへコピーしません。Functionの認証・RPCエラーに対してbrowserから
直接table writeへfallbackしません。

現行Functionは既存契約を維持するため、hosted runtimeが注入するlegacy名の2 keyを
読みます。新しいPublishable/Secret key体系へのFunction移行は今回行いません。新Project
でこれら既定値が利用できることをFunction実行で確認し、Supabase側のlegacy key廃止前に
独立した互換移行を計画してください。

## 5. 最初のユーザーとWorkspace

DashboardのAuthentication > Usersでowner用メールアドレスのAuth userを作成し、その
UUIDを控えます。SQL Editorで固定値を実値へ置き換えて実行します。

```sql
insert into public.workspaces (name)
values ('<TEST_WORKSPACE_NAME>')
returning id;

insert into public.workspace_members (workspace_id, user_id, role)
values ('<WORKSPACE_UUID>', '<OWNER_AUTH_USER_UUID>', 'owner');
```

editor / viewerもDashboardでAuth userを事前作成してから、同じWorkspaceへそれぞれ
`editor` / `viewer` roleで追加します。ブラウザにmembership管理権限はありません。
owner/editorはCloud Eventを書き込め、viewerは読取専用です。Workspace外ユーザーは
読込・保存・削除できないことを確認します。

## 6. Auth URL Configuration

Supabase DashboardのAuthentication > URL Configurationを設定します。

- Site URL: `https://<PRODUCTION_HOST>/`
- Additional Redirect URLs: 利用するVercel Preview URLと、必要な開発用
  `http://localhost:5173/**`

Magic Linkは現在のoriginのrootへ戻り、queryと`#share`を引き継ぎません。Preview URLを
許可する場合は対象を必要な範囲に限定し、不要になったURLを削除します。

## 7. Vercel Project

1. VercelでGitHub repositoryを接続し、Root Directoryをrepository rootにする。
2. Framework PresetをVite、Node.jsを24.xにする。
3. `vercel.json`どおりInstall=`pnpm install --frozen-lockfile`、
   Build=`node scripts/validateCloudDeployment.mjs --require-cloud && pnpm build`、
   Output=`dist`であることを確認する。明示flagによりVercelのsystem env公開設定には依存
   せずCloud設定を検査する。
4. Productionと利用するPreviewへ次の3値を設定する。

```text
VITE_CLOUD_REQUIRED=true
VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY>
```

5. `SUPABASE_SERVICE_ROLE_KEY`、DB password、JWTをVercelへ設定しない。
6. deployする。Cloud envが不足、不正、HTTP、loopback、server keyの場合はbuildが失敗
   する。値そのものはvalidatorのエラーへ出力されない。

path-based routerはなく、通常画面も共有画面も同じ静的`index.html`を使います。
`#share=...`はfragmentなのでVercelへ送信されず、SPA rewriteは追加しません。

## 8. 公開後の確認

順番に確認し、失敗した時点で利用者へのURL配布を止めます。

1. root URLがCloud loginを表示し、local-only編集画面を表示しない。
2. 未登録メールではユーザーが作成されず、登録済みownerへMagic Linkが届く。
3. linkが正しいVercel originへ戻り、ownerのWorkspaceだけが表示される。
4. EventをCloudへ明示保存し、reload・再ログイン・別端末で同じV1 Eventを読める。
5. editorは保存・削除でき、viewerは閲覧できるが保存・削除できない。
6. Workspace外ユーザーは対象Workspaceへアクセスできない。
7. 通信遮断・Function停止時に保存が失敗表示となり、Cloud保存済み扱いにならない。
8. `#share=...`をログアウト状態のPC・スマートフォンで閲覧でき、通常編集画面へ
   認証なしで入れない。
9. スマートフォンでMagic Link、reload、画面復帰を確認する。

### PowerShellからのHosted V1 HTTP認可smoke

既存Event・Workspace・Auth userを変更しないread-only中心のrunnerを用意しています。
確認済みProjectのPublishable Keyだけを環境変数へ設定し、対象は既存viewer membershipの
Workspace UUIDに限定します。server key、service-role key、DB passwordは使用しません。

最初は`--run`を付けず、通信を一切行わないdry-runでProject refとWorkspace UUIDの二重確認
だけを行います。

```powershell
cd '<REPOSITORY_PATH>'
$env:ACAPPELLA_TT_CLOUD_V1_SMOKE_SUPABASE_URL = 'https://<PROJECT_REF>.supabase.co'
$env:ACAPPELLA_TT_CLOUD_V1_SMOKE_PUBLISHABLE_KEY = '<PUBLISHABLE_KEY>'

pnpm test:cloud-v1-hosted-authz-smoke -- `
  --workspace-id '<VIEWER_WORKSPACE_UUID>' `
  --confirm-workspace-id '<VIEWER_WORKSPACE_UUID>' `
  --confirm-project-ref '<PROJECT_REF>'
```

dry-runが成功したら、公開Appで既存viewerのメールアドレスへ新しいMagic Linkを1通だけ要求
します。メール内のlinkを開かずに、Supabase Project originの
`/auth/v1/verify?token=...&type=magiclink`という実linkをコピーします。メール配信サービスの
追跡URLへ置き換わっている場合はrunnerが拒否するため、別originのURLを入力しません。
続いて次を実行し、promptへlinkを貼り付けてEnterを押します。入力内容は画面に表示されず、
tokenはAuthとの交換後もprocess memory内だけで使用されます。CLI引数、環境変数、ファイル、
stdout/stderrへMagic Link、access token、refresh tokenを保存・出力しません。

`--run`はAuth Admin APIによるuser CRUDやmembership変更を行いませんが、Magic Linkの検証
は通常のログインそのものなので、one-time tokenを消費し、Supabase Auth側でsession発行・
sign-in時刻・監査情報が記録される可能性があります。このAuth上のログイン副作用まで禁止
する場合、有効JWTの認証検証とは両立しないため`--run`を実行せず、dry-runだけに留めます。

```powershell
pnpm test:cloud-v1-hosted-authz-smoke -- `
  --run `
  --workspace-id '<VIEWER_WORKSPACE_UUID>' `
  --confirm-workspace-id '<VIEWER_WORKSPACE_UUID>' `
  --confirm-project-ref '<PROJECT_REF>'
```

runnerは15秒の通信timeoutを使用し、次を個別に`PASS`または`SKIP`で表示します。

- Authorizationなしと形式不正JWTがpage RPCでHTTP 401になる
- Magic Linkで認証したuserが確認済みWorkspaceの`viewer`である
- viewerのtable readが、そのuser自身のmembershipに含まれないWorkspaceを露出しない
- V1 authorized page RPCが成功し、table readとEvent ID/revisionが一致する
- 対象Workspaceに保存済みEventが1件以上あり、空Workspaceを認可検証済みと誤認しない
- UUIDから生成した存在しない専用Event IDが読取結果にないことを確認してから、viewerの
  Delete RPCがHTTP 403かつPostgreSQL SQLSTATE `42501`で拒否される
- 実行前後で読取可能な全Event ID/revisionと対象Workspace generationが変化しない

正常終了表示は次のとおりです。Save/Create requestを送っていないことと、確認済みの存在
しないランダムEvent IDに対してDelete認可拒否RPCを1回送ったことを区別しています。

```text
COMPLETED 9 PASS, 2 SKIP; no save/create request was sent; one delete-denial RPC was sent for a confirmed-absent random Event ID.
```

2件の`SKIP`はviewerとWorkspace外userのSave認可です。Hostedでは、Save認可が誤って通った
場合にランダムEventでも新規rowが作成され、HTTP越しにrollbackできません。
`INVALID_SNAPSHOT`などの入力検証エラーを認可拒否の成功とは数えないため、この2件はHosted
では実行しません。専用の使い捨てSupabase環境で、正しいSnapshot fixture、専用user/
Workspace、実行後cleanupを用意した別smokeで検証します。したがって、上記COMPLETED表示を
Save認可まで検証済みという意味には扱いません。

終了後は現在のPowerShell processから公開値も除去します。

```powershell
Remove-Item `
  Env:ACAPPELLA_TT_CLOUD_V1_SMOKE_SUPABASE_URL, `
  Env:ACAPPELLA_TT_CLOUD_V1_SMOKE_PUBLISHABLE_KEY
```

通信失敗、応答形式不正、期待status不一致、前後状態不一致はいずれも非ゼロexitです。失敗時
にもURL、token、key、メールアドレス、Snapshot本文は診断へ出力しません。

## 9. 停止・復旧

- 認証、権限、保存のいずれかが不明ならVercel deploymentをPromoteせず、配布済みURLの
  利用を停止する。
- frontendだけの問題は、直前に検証済みのVercel deploymentへrollbackする。DB migration
  を巻き戻すためにresetや広範なDELETEをしない。
- DB/ACL問題は書込みを止め、Supabase backupの利用可否と復元先を先に確認する。復元は
  元Projectへの上書きではなく、可能なら別Projectで検証してから判断する。
- Event操作前後にJSON backupも取得する。ただしbrowser backupをDB全体backupの代替と
  みなさない。
- key漏えいが疑われる場合は公開を止め、Supabase側で該当keyをrotateし、Vercelを再build
  する。ログやissueへ実値を貼らない。

## 10. 次のLive TT PRとの境界

この構成は静的Vite frontendとSupabaseを分離しています。15番目のmigrationは独立した
Live進行状態、16番目は認証済みoperator route、Stage単位CAS、Realtime通知＋再取得を
追加します。観客向け匿名公開routeはまだ有効化せず、Cloud Event V1をLive進行状態の
保存先として流用しません。既存V1編集画面とは分離したままです。
