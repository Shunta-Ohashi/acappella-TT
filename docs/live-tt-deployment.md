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

repositoryには13 migrationがあります。`20261014100000_cloud_v2_cutover_inspection.sql`
までを順番に適用します。別ブランチのAtomic Cutover migrationは取り込みません。
9〜13番目は将来のV2基盤を追加しますが、既存Workspaceを`ready`へ変更せず、現行Appの
V1保存・hydrateを切り替えません。

## 2. 事前準備

PowerShell 7でrepository rootへ移動し、CLIとローカル検証を確認します。

```powershell
cd '<REPOSITORY_PATH>'
node --version       # 24.xを推奨
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
# dry-runがrepositoryの13 migrationだけを提示することを目視確認する
supabase db push --linked
supabase migration list --linked
```

適用後はremote側に13 versionが順番どおり存在し、未適用・未知versionがないことを確認
します。migrationが失敗した場合は公開へ進まず、schema catalogと
`supabase_migrations.schema_migrations`を確認します。既存migrationを手動再実行したり、
履歴だけを成功扱いにしたりしません。履歴不一致の調査方法は
[migration history repair runbook](./cloud-event-migration-history-repair.md)を使用します。

Catalog regressionは一時的なcatalog変更をtransaction内で行うため、共有オンラインProject
では実行しません。必要なら同じ13 migrationを適用した別の使い捨てDBで実行します。

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

この構成は静的Vite frontendとSupabaseを分離しているため、後続で観客向け公開route、
認証済みoperator、Stage単位のCAS、Realtime通知＋再取得を追加できます。ただし今回の
13 migrationにはLive進行状態tableも権限もありません。Cloud Event V1をLive進行状態の
保存先として流用せず、Liveデータ・認可・公開read契約は次PRで別設計にします。
