# Supabase Auth / Workspace setup

この手順はAuth / WorkspaceとWorkspace共有Cloud Eventを設定します。Cloud保存は明示的な「Cloudへ保存」操作で行い、ブラウザのWorkspace scoped `localStorage`はhydrate後のcacheとして使用します。

## 1. Supabase projectを作成する

Supabase Dashboardでprojectを作成します。frontendへ設定するのはProject URLとPublishable keyだけです。`service_role` keyはブラウザ・Vercel・repositoryへ絶対に設定しないでください。

開発・build環境にはNode.js 22.12.0以上を使用します。VercelもNode.js 22系に設定してください。

## 2. migrationを適用する

新規環境では`supabase/migrations`をmigration version順に適用します。Cloud Eventの依存順は次のとおりです。

1. `20261007_auth_workspace.sql`
2. `20261008110000_cloud_event_persistence.sql`
3. `20261008120000_cloud_event_authorized_delete.sql`
4. `20261008130000_cloud_event_rpc_only_delete.sql`
5. `20261008140000_cloud_event_authorized_page.sql`
6. `20261008150000_cloud_event_authorized_save.sql`
7. `20261008160000_cloud_event_rpc_only_save.sql`
8. `20261008170000_cloud_event_workspace_generation.sql`
9. `20261012100000_cloud_workspace_master_foundation.sql`
10. `20261012110000_cloud_workspace_master_contracts_v2.sql`
11. `20261013100000_cloud_workspace_master_backfill.sql`
12. `20261013110000_cloud_event_v2_persistence_foundation.sql`
13. `20261014100000_cloud_v2_cutover_inspection.sql`

8番目の`20261008170000_cloud_event_workspace_generation.sql`は、
Workspaceごとの単調増加generationと変更triggerを追加し、
複数pageのCloud Event読込中にINSERT / UPDATE / DELETEがcommitされた場合、
次pageをfail closedにします。page RPCはmembershipとgeneration行を同一
transaction内で`FOR SHARE` lockしてからrowsを読むため、generation照合と
page snapshotの間にcommit可能な隙間を作りません。

`20261008170000_cloud_event_workspace_generation.sql`はWorkspace tableの
明示lockを使用するため、Supabase CLIが各statementを
暗黙transactionで包まない実行方式でも安全に適用できるよう、ファイル全体を明示的な
`BEGIN` / `COMMIT`で囲んでいます。CREATE TABLE、backfill、trigger、Page RPC置換、
権限設定までが同じtransactionです。この境界とWorkspace lockを分離・削除しないでください。

既存環境の`...170000`適用はpage RPCの引数契約も更新するため、maintenance
windowでCloud Event読込を停止し、新frontendの配備とmigration適用を同じ
切替作業として行ってください。配備前から開かれているtabをreloadでdrainし、
旧3引数RPCを呼ぶclientが残っていないことを確認してから利用を再開します。
旧RPCを互換用に残すと世代照合を迂回できるため、final stateでは残しません。

`...12100000`はWorkspace共通Member/Bandを将来正規化するためのadditive
foundationです。Member、Band、Band内の順序付きMember、Eventからmasterへの
参照index、`legacy` / `conflict` / `ready`状態を追加します。既存Workspaceは
`legacy`のままで、master rowやEvent referenceをseedせず、Snapshot V1や
`cloud_events`を変更しません。read/write RPCも公開しないため、このmigration
だけでは既存UI・Cloud Event保存/取得/削除経路は切り替わりません。6 tableは
RLS有効・policyなし・PUBLIC / anon / authenticated / service_roleの直接権限なし
です。後続migrationが完全なbackfillと認可endpointを導入するまでmaster削除は
fail closedです。将来のendpointではowner/editorだけにmutationを許可し、viewerを
read-onlyにする契約ですが、不完全なmasterを返さないため今回そのendpoint自体を
公開しません。

Member、Band、Band–Member relationの内部mutation triggerは、Cloud Event page
読込が利用する同じ`cloud_event_workspace_generations`行を更新します。このため、
後続PRでmaster書込みを解禁しても、Eventとmasterを跨ぐ読込は同じWorkspace
generationで変更検知できます。trigger更新はmaster DMLと同じtransactionなので、
失敗時にはgenerationもrollbackされます。後続のowner/editor mutation RPCは既存
Cloud Eventと同じくmembershipを`FOR SHARE`した後にmaster DMLを行うlock順序を
維持する必要があります。migration自身はmaster mutationを実行しません。

`...12110000`はready状態へ明示移行済みのWorkspaceだけを対象に、正規化
Member/Bandのgeneration付きread RPCと、backend専用のrevision CAS mutation
RPCを追加します。このmigrationも既存Workspaceを`ready`へ変更せず、rowのseed、
reference backfill、Snapshot V1 rowのrewriteを行いません。read RPCは
authenticatedなowner/editor/viewerのmembership、master state、Workspace
generationを同一transactionで`FOR SHARE`し、全pageでexpected generationを照合
します。mutation RPCは`service_role`だけが実行でき、transaction内でactorの
owner/editor membershipと`ready`状態を再確認し、Member/Bandのrevision CASを行い
ます。Band本体と順序付き`defaultMemberIds`は同じRPC transactionで更新され、
順序だけの変更でもBand revisionが増えます。browserからmaster tableへの直接write
は引き続き禁止です。

`src/cloud/cloudEventSnapshot.ts`にはSnapshot V2のserializer/parserと明示的な
V1/V2 dispatcherを追加していますが、現行Cloud Event repositoryは引き続きV1だけを
保存・hydrateします。V2はEvent所有collectionとexactなMember/Band参照IDだけを持ち、
master本体を複製しません。reference backfillとWorkspace ready切替が完了する後続PRまで、
V2 Event DB保存とApp hydrate切替は有効化しません。

`...13100000`はSnapshot V1から正規化Masterへ移すためのbackend-only基盤です。
自動backfillや一括移行は行わず、service-role限定のsource inspection RPCと
preview/apply RPC、完了済みplanのfingerprint記録だけを追加します。applyは対象
Workspaceの全Event ID・revision・Snapshot本体、source generation、統合済み
Member/Band、順序付きBand relation、Event参照closureを同じtransactionで再検証
します。Member/Band/relation/referenceのいずれかが失敗すれば全insertとgeneration
更新がrollbackされます。Cloud EventのSnapshot V1・revisionは変更せず、成功後も
`cloud_workspace_master_states.status`は`legacy`のままです。

`...14100000`は正式cutover前の証拠取得専用です。service-role限定の
`inspect_cloud_v2_cutover_state(uuid)`が、status→generationの既存lock順序で
共有lockを保持したまま、全Event Snapshot、正規化Master、順序付きBand–Member、
Event–Master reference、完了backfill記録を1回のRPCで返します。関数は既存dataを
書き換えず、PUBLIC / anon / authenticatedには実効EXECUTEを与えません。
ブラウザから直接呼ばず、下記read-only runnerだけで利用します。

### Cloud V2 cutover read-only inspection

このrunnerはbackfillやstatus切替を行いません。loopbackでは次のように実行します。

```powershell
$env:ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL = 'http://127.0.0.1:<new-api-port>'
$env:ACAPPELLA_TT_CUTOVER_INSPECTION_SERVICE_ROLE_KEY = '<server-only-service-role-key>'
pnpm cloud:v2-cutover-inspect -- --workspace-id '<workspace-uuid>'
```

remote URLはHTTPS必須で、`--confirm-target '<origin>'`と
`--confirm-workspace-id '<workspace-uuid>'`の両方が一致しない限り接続しません。出力は
ID・件数・Issue・reference照合結果だけで、Snapshot本文、氏名、Band名、notes、JWT、
keyを含めません。`safeToCutover`は常にfalseです。migration適用前には既存のmigration
history/catalog preflightを実行し、適用後にはservice-roleだけがRPCを実行できることを
catalog regressionで再確認してください。詳しい意味と使い捨てDBの手順は
[Cloud Snapshot V2 cutover preflight](./cloud-v2-cutover-preflight.md)を参照してください。

2026-10-15に新規使い捨て環境（Supabase CLI 2.120.0、PostgreSQL 17.11）で全13
migration、通常/inspection先行concurrency SQL、Catalog regression 98実行、未backfill
終了code 2、backfill済み終了code 0を確認しました。どちらもDB不変と
`safeToCutover: false`を確認しています。writer先行、Master更新競合、大規模応答、
production、writer drain、backup/restore、atomic cutoverは未検証です。

Windows hostの`psql` URLとDB内から開くdblink URLは同一とは限りません。検証済み手順では
host側を`127.0.0.1:55822`、dblink側をDockerから都度取得した同じ専用DBコンテナのIPv4と
container port 5432へ向け、`connect_timeout=5&require_auth=scram-sha-256,md5`でpassword
認証を必須にしました。IPを固定せず、container名・公開port・IPを照合してください。
`dblink_connect_u`やroleへの追加権限は使いません。具体的なコマンド、通常fixtureとcommit型
concurrency fixtureのcleanup差異、異常終了後の明示cleanupは上記runbookを参照してください。

### Snapshot V1からWorkspace Masterへのbackfill

最初は必ずdry-runを実行します。URLとservice-role keyはshell環境変数だけで渡し、
repository、ログ、コマンド履歴へkeyを保存しません。出力は件数・ID・競合Eventだけで、
Member/Band本体は表示しません。HTTPはHTTPS（loopbackだけHTTP）に限定されます。

```powershell
$env:ACAPPELLA_TT_BACKFILL_SUPABASE_URL = 'https://<project-ref>.supabase.co'
$env:ACAPPELLA_TT_BACKFILL_SERVICE_ROLE_KEY = '<server-only-service-role-key>'
npm run cloud:workspace-master-backfill -- `
  --workspace-id '<workspace-uuid>'
```

`eligible: true`、DB側`status: preview`、source generation、件数、plan fingerprintを
記録してから、対象WorkspaceへのV1保存を止めるmaintenance windowを開始します。
競合がある場合は自動的に片方を採用せず、該当kind/ID/Eventを確認してV1 snapshotを
正規のアプリ経路で整合させ、もう一度dry-runします。Snapshot V1に含まれない未参照
Masterは復元不能であり、推測して作成しません。

実書込みにはWorkspace IDと接続先originの二重確認が必要です。

```powershell
npm run cloud:workspace-master-backfill -- `
  --workspace-id '<workspace-uuid>' `
  --apply `
  --confirm-workspace-id '<workspace-uuid>' `
  --confirm-target 'https://<project-ref>.supabase.co'
```

preflight後にEventがINSERT / UPDATE / DELETEされた場合、Event row lock、全revision・
Snapshot照合、Workspace generation CASのいずれかでapplyは`40001`を返し、書込みを
残しません。最新sourceでdry-runからやり直してください。途中失敗も同じtransactionで
rollbackされます。同一fingerprintを変更なしで再実行した場合だけ`already_applied`を
返し、異なるplanや完了後にgenerationが変わったretryは拒否します。retryのために
Master tableをDELETE/TRUNCATEしないでください。

backfill完了後も旧V1 writerは正規化Masterを更新しないため、成功を`ready`化の根拠に
してはいけません。ready切替は、旧client drain、最新generationでの再検証、V2保存・
hydrate経路の配備、reference index完全性確認を原子的に扱う後続PRまで保留します。

正式cutover前のread-only検証項目、結果の限界、将来必要なatomic RPCと運用順序は
[`cloud-v2-cutover-preflight.md`](./cloud-v2-cutover-preflight.md)を参照してください。
現在のPreflightは構造変換可能性を確認するだけで、`safeToCutover`は常に`false`です。
DBやWorkspace statusを変更せず、未検証の旧client drain・backup・最終transactionを
成功済みとして扱いません。

`...13110000`はSnapshot V2をDBへ保存できるbackend基盤だけを追加します。既存のV1
CHECKを残したままV2のexact envelope、Event identity、Master本体非包含を検査し、
`service_role`だけが実行できる`save_cloud_event_v2_validated` RPCを追加します。V2保存は
owner/editor、`ready`状態、Event revision CAS、Workspace generation CAS、同一Workspace
Masterの完全な直接・推移参照closureを同じtransactionで再検証します。Event行、参照
index、revision、generationの一部だけがcommitされることはありません。既存V1行をV2
writerで上書きすることも禁止しています。

このmigrationはWorkspaceを`ready`にせず、Appの保存・hydrateをV2へ切り替えません。
現行V1 repositoryは引き続きV1だけを扱い、分離されたV2 repository/read modelもAppや
scoped local cacheを書き換えません。V2 read modelはEvent page取得時のgenerationを
Master readにも要求し、V1/V2混在、generation不一致、参照欠損をfail closedにします。
したがってmigrationを先に適用してもlegacy WorkspaceのV1保存・取得・削除は維持されます。

将来Workspaceをreadyへ切り替える前に、全V1 snapshotのbackfillとreference indexを
再検証し、V2対応frontend/Functionを配備し、既に開かれているtabを含む旧clientをdrain
してください。ready後はtable-level triggerがV1 INSERT/UPDATEを拒否します。ready化、
V1行の正式なV2変換、App cutoverはこのPRの対象外で、旧clientが残る状態でreadyへ変更
してはいけません。

ファイル名は通常の文字列順でもこの依存順になりますが、Supabase CLI等での適用済み判定はmigration historyに基づきます。旧開発名`20261007120000_cloud_event_persistence.sql`を適用済みの可能性がある環境では、rename後のbase migrationを再適用しないでください。対象判定・catalog照合・承認済みrepair・中断復帰・完了確認は、専用の[Cloud Event migration履歴移行runbook](./cloud-event-migration-history-repair.md)に従って通常のmigration適用より前に実施します。外部環境へpackage install / build / App起動から自動repairは行いません。

### 既存環境のDelete RPC切替

既存環境ではDelete RPC作成と直接DELETE取消しを一度のblind deploymentで適用しません。旧frontendは`cloud_events`を直接DELETEするため、次の順序で切り替えます。

1. `20261008120000_cloud_event_authorized_delete.sql`まで適用し、authorized delete RPCを利用可能にする（この時点では直接DELETE権限を維持）
2. `delete_cloud_event_authorized(...)`を使用する新frontendを配備する
3. 新frontendからEvent削除がRPC経由で成功することを確認する
4. maintenance window等を設け、利用者へreloadを求めて、配備前から開かれているtabを含むlegacy clientをdrainする
5. legacy clientが残っていないことを確認してから`20261008130000_cloud_event_rpc_only_delete.sql`を適用し、browserの直接DELETEをREVOKEする
6. REVOKE後も新frontendからRPC削除が成功することを再確認する

旧clientが存在し得る間は`...130000`を先に適用しないでください。新規環境では利用開始前に全migrationを順番に適用し、現在のFunction/frontendを揃えてから公開するため、この段階的切替は不要です。

`...130000`はdirect GRANTのREVOKE後に`anon`と`authenticated`の実効DELETE権限も検査します。REVOKEとguardは1つの明示transactionに含まれるため、custom roleから継承したDELETEをguardが検出した場合は、direct DELETEのREVOKEもrollbackされ、migration historyへversionは記録されません。operatorがrole membershipとinherited GRANTを確認・除去してから同じmigrationを再実行してください。migrationが共有custom roleの権限を自動変更することはありません。guard失敗を未完了cutoverとして扱い、原因を解消して正常適用を確認するまで次のmigrationや本番公開へ進まないでください。

## 3. Authentication userを作成する

Authenticationの公開signupを無効化してください。Authentication > Usersから、利用を許可する幹部ユーザーを管理者が事前作成します。

アプリはEmail Magic Linkの送信に`shouldCreateUser: false`を指定するため、未登録メールアドレスからユーザーは作成されません。

## 4. Workspaceとmembershipを作成する

SQL EditorでWorkspaceを作成し、作成済みAuth userを追加します。次のIDや値は実際のものへ置き換えてください。

```sql
insert into public.workspaces (name)
values ('運営チーム')
returning id;

insert into public.workspace_members (workspace_id, user_id, role)
values ('WORKSPACE_UUID', 'AUTH_USER_UUID', 'owner');
```

`role`は`owner`、`editor`、`viewer`のいずれかです。membershipの追加・更新・削除はブラウザから許可していないため、Dashboardまたは管理者SQLで行います。初回ログイン後、ユーザー本人が表示名を登録すると`profiles` rowが作成されます。

## 5. Local environment variables

`.env.example`を参考に、Git管理されない`.env.local`へ設定します。

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

両方未設定ならlocal-only modeで起動します。片方だけ設定した場合は設定エラー画面になります。

## 6. Vercel environment variables

Vercel projectのEnvironment Variablesへ`VITE_SUPABASE_URL`、
`VITE_SUPABASE_PUBLISHABLE_KEY`、`VITE_CLOUD_REQUIRED=true`を設定します。Productionと
利用するPreview environmentへ設定し、設定後に再デプロイします。Vercel buildは3値を
事前検証し、未設定、remoteでないURL、HTTP URL、server keyを検出すると失敗します。
`service_role` keyはVercelへ設定しません。

新しいオンラインテストProjectをCloud Snapshot V1のまま公開する手順は
[Live TT deployment runbook](./live-tt-deployment.md)を参照してください。

## 7. Auth URL Configuration

Supabase DashboardのAuthentication > URL Configurationで設定します。

- Site URL: production URL（例: `https://example.vercel.app`）
- Additional Redirect URLs: `http://localhost:5173/**`

Vercel PreviewでMagic Linkを使う場合は、利用するpreview URL patternもAdditional Redirect URLsへ追加してください。

Magic Linkのredirect先は、実行中ページのoriginから通常App rootを生成します。事前共有用の`#share=...`やqueryは引き継ぎません。

## 8. Cloud Event保存Function

Cloud Eventの保存はbrowserから`save-cloud-event` Edge Functionを呼びます。Functionは同じsourceの`parseCloudEventSnapshot()`でPersistence V5 / snapshot V1、ownership、ID一意性、exact Member/Band closureを検証してから、backend専用`save_cloud_event_validated` RPCを呼びます。validatorは`src/cloud/cloudEventSnapshot.ts`から相対importするため、別schemaを手作業で同期する必要はありません。

FunctionはSupabaseのJWT verificationを有効なまま配備し（`--no-verify-jwt`を使用しない）、handler内でもBearer tokenを`auth.getUser(token)`へ渡して本人確認します。

Function runtimeだけに以下を設定します。実値を`VITE_`環境変数、frontend、Git、response、logへ入れないでください。

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`（呼出元JWTを`auth.getUser()`で検証するclient用）
- `SUPABASE_SERVICE_ROLE_KEY`（backend専用RPC用）

保存requestはJSON POSTのみで、streamを実際に読みながら5 MiBで打ち切ります。これは現行V5 Event snapshotへ余裕を持たせつつ、認証済みrequestによる無制限なmemory使用を防ぐ上限です。`Content-Length`だけには依存しません。Function未配備・認証失敗・不正response・通信失敗時にbrowserから旧table upsertへfallbackしません。

手元にSupabase CLI / Denoがある専用環境では、配備前に次を確認します（共有DBやproductionへは実行しません）。

```powershell
deno check supabase/functions/save-cloud-event/index.ts
supabase functions serve save-cloud-event
```

安全な更新順は次のとおりです。

1. `...150000_cloud_event_authorized_save.sql`まで適用してbackend専用RPCを作成し、backend-only EXECUTE contractの検査を通す
2. `save-cloud-event` Functionを配備し、認証・保存integrationを確認
3. 新frontendを配備
4. 配備前から開かれているtabを含むlegacy clientをdrainし、必要に応じて利用者へreloadを求める
5. `...160000_cloud_event_rpc_only_save.sql`を適用して旧clientの直接INSERT/UPDATEを取り消し、backend-only EXECUTE contractを再検査する
6. 新frontendからEdge Function経由の保存を再確認する

直接write取消し後、旧frontendの直接upsertは意図どおり失敗します。途中状態を長期間残さず、専用環境で一連の順序を検証してからproductionへ反映してください。fresh DBでは全migration適用後にFunctionとfrontendを揃えて公開します。

`...150000`はRPC作成・直接REVOKE・`service_role`へのGRANT後に、save RPCが`SECURITY DEFINER`であり、`service_role`だけが実効EXECUTEを持ち、`PUBLIC` / `anon` / `authenticated`が実行できないことを検査します。`...160000`もfinal cutover前に同じbackend-only EXECUTE contractを再検査し、さらにtable/columnへのdirect GRANTをREVOKEした後、`anon`と`authenticated`に継承経由の実効INSERT/UPDATE権限が残っていないことを検査します。`...160000`の全REVOKEと両guardは1つの明示transactionに含まれ、いずれかのguardが失敗した場合はtable/column権限変更もrollbackされ、migration historyへversionは記録されません。残存権限があればoperatorがinherited EXECUTE/WRITE GRANT、role membership、custom role、function default privilegesを修正してから同じmigrationを再実行してください。migrationは共有role membershipを自動変更しません。正常適用を確認するまで`...170000`や本番公開へ進まないでください。

全13 migrationは、Supabase CLIがstatementごとに実行する環境でも部分適用を残さないよう、各file全体を1組の明示的な`BEGIN` / `COMMIT`で囲んでいます。後続statementやprivilege guardが失敗した場合、そのfile内のDDL・DML・ACL変更はまとめてrollbackされます。これはPostgreSQL schema transactionの保証であり、CLIによるmigration historyの記録処理そのものと同一の保証ではありません。失敗時はcatalogと`supabase_migrations.schema_migrations`の両方を確認し、対象versionが未記録であることを確認してから原因を解消して再実行してください。fresh適用は、共有・production DBではなく新しい使い捨てのSupabase互換DBだけを指定して、全migration chainを`supabase db push --db-url $env:ACAPPELLA_TT_DISPOSABLE_DATABASE_URL`で確認してください。既にmigration historyへ対象versionが記録されたDBではファイル編集による再実行は起きないため、正常適用済み環境へ手動で再適用しません。

### Workspace Master mutation Function（段階2）

`workspace-masters` Edge FunctionはMember/Band create/update/delete requestをruntime
検証し、Bearer tokenを`auth.getUser(token)`で確認してから、service-role限定の
`mutate_workspace_master_validated` RPCへactor IDを渡します。RPCもmembership、
ready state、expected revisionを再検証します。Functionを配備してもlegacy/conflict
WorkspaceはDBで拒否され、既存Appはこのendpointをまだ呼びません。
Bandの`defaultMemberIds`に同じWorkspace内で解決できないIDがある場合は、専用の
SQLSTATE `PMA01`を`MASTER_MEMBER_NOT_FOUND`へ変換します。これは参照中Masterの
削除を拒否するFK由来の`23503` / `MASTER_REFERENCED`とは別の入力エラーです。

```powershell
deno check supabase/functions/workspace-masters/index.ts
supabase functions serve workspace-masters
```

`supabase/functions/workspace-masters/deno.json`は、このFunction専用のDeno import
mapです。Edge Runtimeはhandlerを起動する前に依存graphを解決するため、このimport
mapがない、または`@supabase/supabase-js`の指定がentrypointと一致しない場合、request
処理へ到達する前にbootが失敗し、gatewayから503が返ることがあります。これはRPCや
Workspace認可が返すapplication errorではありません。

現在は`index.ts`と`deno.json`の両方で`@supabase/supabase-js@2.117.2`をexact
versionへ固定し、Vite/React側のnpm dependencyは同じrelease lineの`^2.117.2`です。
versionを更新する場合は3箇所を同じ変更で更新し、`deno check`と実HTTP smokeを両方
実行してください。`deno.json`はFunction directoryに置いたままversion管理し、rootの
Vite/React向けmodule解決設定へ統合・流用しません。

Functionには`save-cloud-event`と同じ3つのserver-side環境変数を設定し、JWT検証を
無効化しません。Master backfill、reference index完成、ready切替、App hydrate切替は
後続PRで原子的なmigration手順として実施します。

### Workspace Master Edge Functionの実HTTP smoke

dependency injectionだけでなく、実Auth JWT→Edge HTTP route→`auth.getUser()`→
service-role限定RPCまでを確認するsmoke runnerを用意しています。既存の検証DBや共有・
production環境では実行せず、全migrationをfresh適用した新しいloopback専用Supabaseを
使用してください。runnerは既存検証DBの54322〜55122を拒否します。

まずrepository rootで`deno check supabase/functions/workspace-masters/index.ts`を実行し、
dependency graphを解決できることを確認します。次に別terminalでJWT verificationを
無効化せずFunctionを起動し、boot logにimport解決エラーがなく、HTTP routeが待受状態に
なったことを確認してからrunnerを実行します。起動直後から全requestが503になる場合は、
handlerやDBを調査する前にFunction logと上記`deno.json`の存在・version整合を確認します。

別terminalでJWT verificationを無効化せずFunctionを起動します。

```powershell
supabase functions serve workspace-masters
```

実行terminalへ、使い捨て環境の値だけを設定します。key・JWT・passwordをrepository、
shell script、ログへ保存しないでください。Function URLを省略するとSupabase URL配下の
`/functions/v1/workspace-masters`を使用します。

```powershell
$env:ACAPPELLA_TT_SMOKE_SUPABASE_URL = 'http://127.0.0.1:<new-api-port>'
$env:ACAPPELLA_TT_SMOKE_SUPABASE_ANON_KEY = '<disposable-anon-key>'
$env:ACAPPELLA_TT_SMOKE_SUPABASE_SERVICE_ROLE_KEY = '<disposable-service-role-key>'
$env:ACAPPELLA_TT_SMOKE_DATABASE_URL = 'postgresql://postgres:<password>@127.0.0.1:<new-db-port>/postgres'
# 別routeでserveした場合のみ指定:
# $env:ACAPPELLA_TT_SMOKE_FUNCTION_URL = 'http://127.0.0.1:<port>/functions/v1/workspace-masters'
npm run test:cloud-workspace-master-http-smoke
```

runnerがPASSすれば、実Auth JWT、Edge HTTP route、dependency boot、`auth.getUser()`、
service-role限定RPCまでを通過しています。503のまま、またはcleanup failureがある状態を
成功扱いにせず、専用fixtureのcleanupを確認してから同じ使い捨て環境で再実行します。

runnerは専用の固定Workspace ID 3件と専用email 4件だけをstartup/final cleanupの
対象にします。Auth Admin APIで実ユーザーを作成してpassword sign-inから異なるJWTを
取得し、owner作成、editor更新、viewer/Workspace外拒否、認証拒否、legacy拒否、
revision競合、PMA01、Band順序、正式read RPC、browser roleからのbackend-only RPC
拒否を検証します。途中失敗でもcleanupを試行しますが、cleanup failure時は表示された
失敗を解消して同じrunnerを再実行し、専用fixture以外を手動削除しないでください。

### Snapshot V2保存Function（backend基盤）

`save-cloud-event-v2`は既存`save-cloud-event`とは別routeです。Bearer tokenを
`auth.getUser(token)`で検証し、5 MiBの実stream byte上限とSnapshot V2 runtime
validationを通過したrequestだけを、service-role限定RPCへ渡します。createは
`expectedRevision: null`、updateは現在の正のrevisionを指定し、どちらも読込済みの
`expectedGeneration`を必須とします。revision、generation、ready state、Master参照の
競合は明示的なapplication errorとして返り、V1 writerへのfallbackは行いません。

依存はFunction専用`deno.json` / `deno.lock`で固定します。

```powershell
deno check --frozen `
  --config supabase/functions/save-cloud-event-v2/deno.json `
  supabase/functions/save-cloud-event-v2/index.ts
supabase functions serve save-cloud-event-v2
```

実HTTP smokeは、全13 migrationをfresh適用した新しいloopback専用環境だけで行います。
既存検証・共有・production DBを再利用しません。別terminalから実Auth userでsign-inして
得たJWTをAuthorization headerへ設定し、ready fixtureの正しいSnapshot V2をPOSTします。
owner/editor成功、viewer/outsider/JWT不正拒否、legacy/conflict拒否、create/update CAS、
stale generation、存在しないMaster、V1 row上書き拒否を確認してください。bodyは
`workspaceId`、`snapshot`、`expectedRevision`、`expectedGeneration`の4 fieldです。Function
logにboot/import errorがなく、失敗時にEvent/references/generationが不変であることを
SQL fixtureでも確認します。key/JWTはshell環境変数だけで扱い、ログやrepositoryへ保存
しません。現行Appはこのrouteを呼ばないため、このsmokeはbackend契約の検証です。

#### Snapshot V2保存Functionの専用実HTTP smoke

`cloudEventV2HttpSmoke.mjs`は、実Auth Admin APIでowner / editor / viewer /
outsiderを作成し、各ユーザーをpassword sign-inして得た別々のJWTを使って、
`save-cloud-event-v2`のHTTP routeからservice-role限定RPC、PostgreSQLまでを検証します。
既存のV1 App保存・hydrateは呼び出しません。

このrunnerは事故防止のため、API port `55721`とDB port `55722`の組み合わせだけを
受理します。Supabase URL、Function URL、Database URLはすべてloopbackでなければならず、
FunctionはSupabase APIと同じoriginの`/functions/v1/save-cloud-event-v2`でなければ
なりません。`--confirm-disposable`がない実行、production/staging URL、54322〜55622を
含む別port、不明なrouteは実行前に拒否します。

Windows 11 + PowerShell + Docker Desktopでは、既存環境のcopyやvolumeを再利用せず、
新しい専用directoryとSupabase project IDを用意します。専用directoryの
`supabase/config.toml`で少なくとも`[api] port = 55721`、`[db] port = 55722`とし、
Studio、Inbucket等も既存環境と重ならない未使用portへ変更してください。以下は必ず
その新しいdirectoryでのみ実行します。

```powershell
cd C:\Users\shun0\acappella-TT-event-v2-http-smoke
supabase start

$env:ACAPPELLA_TT_EVENT_V2_SMOKE_DATABASE_URL = `
  'postgresql://postgres:postgres@127.0.0.1:55722/postgres'

# fresh環境へrepositoryの全13 migrationを適用する。既存DBには指定しない。
supabase db push `
  --db-url $env:ACAPPELLA_TT_EVENT_V2_SMOKE_DATABASE_URL
```

`supabase status -o env`でこの専用環境のAPI URL、anon key、service-role keyを確認します。
出力をissue、ログ、repositoryへ貼らず、2つのPowerShell terminalの環境変数だけへ設定
してください。1つ目のterminalではJWT verificationを無効化せずFunctionを起動します。

```powershell
$env:SUPABASE_URL = 'http://127.0.0.1:55721'
$env:SUPABASE_ANON_KEY = '<55721専用環境のanon-key>'
$env:SUPABASE_SERVICE_ROLE_KEY = '<55721専用環境のservice-role-key>'

deno check --frozen `
  --config supabase/functions/save-cloud-event-v2/deno.json `
  supabase/functions/save-cloud-event-v2/index.ts

supabase functions serve save-cloud-event-v2
```

`--no-verify-jwt`は使用しません。2つ目のterminalで同じ専用環境だけを設定し、runnerを
起動します。Function URLを省略した場合はSupabase URLと同じoriginの正式routeを使います。

```powershell
cd C:\Users\shun0\acappella-TT-event-v2-http-smoke

$env:ACAPPELLA_TT_EVENT_V2_SMOKE_SUPABASE_URL = 'http://127.0.0.1:55721'
$env:ACAPPELLA_TT_EVENT_V2_SMOKE_ANON_KEY = '<55721専用環境のanon-key>'
$env:ACAPPELLA_TT_EVENT_V2_SMOKE_SERVICE_ROLE_KEY = `
  '<55721専用環境のservice-role-key>'
$env:ACAPPELLA_TT_EVENT_V2_SMOKE_DATABASE_URL = `
  'postgresql://postgres:postgres@127.0.0.1:55722/postgres'
# 通常は省略する。明示する場合も同じ55721 originに限定される。
$env:ACAPPELLA_TT_EVENT_V2_SMOKE_FUNCTION_URL = `
  'http://127.0.0.1:55721/functions/v1/save-cloud-event-v2'

npm run test:cloud-event-v2-http-smoke
```

`Cloud Event V2 HTTP smoke: PASS`は、owner create、editor update、revision/generationの
単調増加、正式Page RPCでの読戻し、Member/Band reference index一致まで確認したことを
示します。さらにviewer/outsider/JWTなし・不正JWT、legacy、stale revision/generation、
malformed V2、存在しないMember/Band、V1上書き、browser JWTからのbackend-only RPC、
5 MiB超bodyを拒否し、各拒否後にEvent/references/revision/generation/status/Masterが
変わっていないことを確認します。

setupは固定Workspace ID `76000000-0000-0000-0000-000000000001`〜`003`または専用emailが
既に存在すれば、既存データを消さずに停止します。通常終了・失敗時は、この実行で作成した
Auth user IDと固定Workspace IDだけをcleanupし、cleanup失敗も全体を失敗扱いにします。
途中でprocess自体が停止してfixtureが残った場合は、接続先が55721/55722の専用環境である
ことを再確認し、次の明示cleanupを1回実行してから通常runnerを再実行してください。

```powershell
node scripts/cloudEventV2HttpSmoke.mjs `
  --confirm-disposable `
  --cleanup-only
```

cleanup確認は、固定Workspace 3件が0件であることと、Admin API上で
`cloud-event-v2-http-smoke-*@example.invalid`の4ユーザーが存在しないことだけを対象にします。
広範囲DELETE、TRUNCATE、DB reset、Authユーザーの一括削除は行いません。cleanupが再度
失敗した場合は自動的に成功扱いせず、Functionではなく`psql`接続と親Workspace cascadeを
確認してください。

## 9. Security確認

- `profiles`は本人のrowだけSELECT・INSERT・UPDATEできます。
- `workspace_members`は本人のmembershipだけSELECTできます。
- `workspaces`は本人のmembershipがあるWorkspaceだけSELECTできます。
- `anon`には3 tableへの権限を付与していません。
- Workspaceとmembershipの変更はbrowser clientへ許可していません。
- `cloud_events`のbrowser直接INSERT / UPDATE / DELETEは許可していません。
- Workspace masterの6 tableはbrowser/backend roleへ直接公開しません。ready
  Workspace向けread RPCだけをauthenticated memberへ、mutation RPCだけを
  `service_role`へ公開します。legacy/conflict Workspaceはfail closedです。
- V1/V2の内部保存RPCは`service_role`だけが実行でき、保存transaction内でもactorのowner/editor membershipを`FOR SHARE`で再確認します。V2はさらにready state、revision/generation CAS、Master closureを検証します。
- データ保護はPublishable keyの秘匿ではなくRLSで行います。

## 10. 現在の制限

Cloudへ保存したEvent snapshotはWorkspace内で共有できますが、Realtime、Presence、offline draft復元、Snapshot V2へのApp切替は後続実装です。V2 backendはrevision/generation CASを備えますが現行AppはまだV1経路です。正規化tableとAPI契約は存在しても既存Workspaceは未backfillの`legacy`状態で、通常mutationと正式readを拒否します。共有masterは現行V1 snapshotへ暫定的に複製し、snapshot間で矛盾した場合はsilent mergeせずWorkspace hydrateをfail closedします。

このfail-closedは、古いMember/Bandで新しい値を黙って上書きすることと、不整合時にlocal cacheを正式データとして表示・保存することを防ぎます。一方、Event A/Bが同じ共有masterを含む状態でmasterを編集し、片方だけをCloud保存すると、不整合なsnapshot集合自体は作成され得ます。新しいEventを初めてCloud保存する場合も、既存Event側のcopyが古ければ同様です。競合はWorkspaceのCloud rowsに保存されるため、保存した本人だけでなく、別のAuthユーザー、F5、logout後の再loginでも次回hydrateが`SHARED_MASTER_CONFLICT`で停止します。参照中Member/BandのHard Deleteはdomain guardで拒否され、参照されないmasterの追加・削除はsnapshot closureへ含まれないため、この競合原因にはなりません。

Event単位の保存前に一覧を読むだけでは、照合後から保存commitまでに別端末が別Eventを保存できるため、並行更新を含む保証にはなりません。完全に防ぐには、Workspace共通Member/BandのCloud table正規化、またはWorkspace lock/CAS下での共有master検証と複数Eventの原子的な更新契約が必要です。現在のPRではそのDB仕様を追加しません。

既に`SHARED_MASTER_CONFLICT`になった場合はlast-write-winsで解決しないでください。まず対象WorkspaceのCloud Event rowsを管理者が退避し、矛盾したmaster IDと各Eventの内容を比較して正しい値を決定します。maintenance windowで他端末の保存を止めたうえで、古いcopyを持つEventを退避・削除し、整合したWorkspaceをhydrateしてから、検証済みのアプリ経路でそのEventを再作成・再保存します。復旧中にsnapshot JSONを直接書き換えたり、別Eventを自動上書きしたりしません。独立したCloud masterまたは原子的repair APIが導入されるまではoperator-assisted recoveryです。

Cloud modeの編集データは、同じブラウザ内でも認証ユーザーとWorkspaceの組み合わせごとに分離して`localStorage`へ保存されます。local-only modeで既存keyへ保存したデータは削除されず、Cloud Workspaceへ自動移行もされません。既存データを対象Workspaceへ移す場合は、local-only modeでバックアップを書き出し、対象Workspaceへログインしてから復元してください。
