# Live TT state foundation runbook

この文書は`20261019154519_live_timetable_state_foundation.sql`で追加する
backend foundationの契約と、使い捨て環境での検証境界を記録します。PR #78のbackend
foundation単体では、認証済み運営者向け画面やRealtime同期UIを実装していませんでした。
使い捨て環境でbackend契約を検証できたことを、本番環境での運用準備完了とみなしては
いけません。

PR #79では、認証済み運営者向けLive TT画面、Realtime購読、認可付きreadによる状態取得、
通信障害時の再取得・bounded retryを実装しています。一方、サークル員向けのログイン不要な
閲覧専用UI、一般向け公開UI、Hosted環境でのAuth / HTTP / Realtime検証、実機・学内Wi-Fiでの
運用検証は未実装または未検証です。UI・同期の詳細な契約は
[Live TT operator UI](./live-tt-operator-ui.md)を参照してください。

`20261021050414_live_timetable_operator_ui.sql`適用後は、viewerもownerから明示割当を
受けたStageを操作できます。割当時の`granted_role`と現在のWorkspace roleが一致する
ことに加え、割当時と現在の認可epochが一致する場合だけ有効です。roleを元へ戻しても
古い割当は復活せず、role変更後はownerの明示再割当が必要です。また`is_published`はLive進行
の有効化、`public_view_enabled`は匿名公開のopt-inとして分離されます。

## データ境界

- Cloud Event Snapshot V1は編集用の正式データのままです。
- Live投影は`live_timetables`、Stageは`live_timetable_stages`、進行Entryは
  `live_timetable_entries`、Stage operatorは`live_timetable_stage_operators`へ保存します。
- Live操作は`cloud_events`のSnapshot/revision、Workspace generation、Workspace Master、
  Snapshot V2を書き換えません。
- Event削除は対応するLive TTが存在する間、外部キー`ON DELETE RESTRICT`で拒否されます。
  Live記録の削除・保存期間・監査exportは未実装です。Workspace削除もLiveが残る限り
  fail closedになるため、運用上の削除手順は後続PRで定義します。

投影はbackendで認証済みのownerが要求し、Edge Functionがservice-role限定のsource RPC
からSnapshot V1を読みます。browser requestはSnapshot本文を指定できません。Edge側は
既存V1 parserと`calculateStageTimeline()`で日・Stage・Section・Performance・Breakを
正規化し、commit RPCはEvent rowを再lockしてrevisionとPostgreSQL `jsonb::text`の
SHA-256 fingerprintを再照合します。置換は未公開・未開始に限定し、古いStage operator
割当を引き継ぎません。

投影Edgeの不存在分類は、元Cloud Eventを取得できない`P0002`を`EVENT_NOT_FOUND`、
元Eventは存在するが`replace`対象のLive TTがない`P0003`を`LIVE_NOT_FOUND`として
区別します。メッセージ文字列には依存せず、他のLive RPCが使う`P0002`の意味は変更しません。

## 認可とCAS

- owner: 投影作成/置換、公開切替、operator割当、全Stageの開始/終了
- editor: 明示的に割り当てられたStageの開始/終了だけ
- viewer: 認証済みreadと、viewerとして明示割当されたStageの進行操作。割当時roleと現在roleの不一致は拒否
- outsider/anon: Workspace内部read/write不可
- 公開閲覧: 推測困難な`public_id`を知り、`is_published=true`かつ`public_view_enabled=true`の場合だけ、allowlist DTOをread可能

RPC契約は次のとおりです。すべて`SECURITY DEFINER`かつ空の`search_path`を使用し、
PUBLIC EXECUTEを明示的に取り消します。tableへのbrowser直接writeは許可しません。

| RPC | EXECUTE | actor | 契約 |
| --- | --- | --- | --- |
| `load_live_timetable_projection_source` | `service_role` | Edgeが`auth.getUser()`で確定したUUIDを引数で渡し、DBでownerを再検証 | 保存済みV1、revision、PostgreSQL JSONB digestだけを返す |
| `create_or_replace_live_timetable_projection` | `service_role` | 同上 | owner、元Event、digest、revision、置換条件をtransaction内で再検証 |
| `load_live_timetable_authorized` | `authenticated` | `auth.uid()` | 現在のowner/editor/viewerだけ。operator一覧はownerだけ |
| `load_live_timetable_public` | `anon`, `authenticated` | actorなし | 公開UUID 1件、公開中、allowlist DTOのみ |
| `set_live_timetable_publication` | `authenticated` | `auth.uid()` | ownerだけ、management revision CAS |
| `set_live_timetable_stage_operator` | `authenticated` | `auth.uid()` | ownerだけ。割当先は現在のeditor/viewer、割当時role・認可epoch snapshot、management/projection CAS |
| `start_live_timetable_entry`, `end_live_timetable_entry` | `authenticated` | `auth.uid()` | owner、または現在role・認可epochが割当時と一致する対象Stageのeditor/viewer |
| `find_live_timetable_for_event_authorized` | `authenticated` | `auth.uid()` | member-only。Event名・保存revision・Live IDだけを返しSnapshot本文を返さない |
| `list_live_timetable_operator_candidates` | `authenticated` | `auth.uid()` | owner-only。現在のeditor/viewerのUUID・表示名だけを返す |

内部helperと共通transition関数は`anon`、`authenticated`、`service_role`のいずれにも
EXECUTEを与えません。権限はrole membership経由の実効権限とcolumn ACLを含めてmigration
guard、preflight、catalog regressionで検査します。

すべての開始/終了は`projectionVersion`とStage `revision`を必須CASにします。Stage rowを
`FOR UPDATE`した後にrevision・状態・先頭pending/current entryを再検証し、そこで初めて
`clock_timestamp()`を取得します。同一Stageは直列化し、異なるStageはLive rowの共有lock
を使うため独立に進行できます。開始は先頭pending Entryだけ、終了は現在in-progressの
Entryだけです。PerformanceとBreakはいずれも手動操作です。skip、cancel、時刻訂正は
未実装であり、例外時のoperator判断手順を後続PRで必ず追加します。

mutationのlock順序は経路ごとに固定します。

- 進行: caller membership → Live `FOR SHARE` → editor割当 `FOR SHARE` →
  対象Stage `FOR UPDATE` → 対象Entry
- 公開: caller membership → Live `FOR UPDATE` → Realtime通知用Stage更新
- operator管理: caller/割当先membershipをuser UUID順 → Live `FOR UPDATE` →
  対象Stage `FOR SHARE` → assignment変更
- 投影作成/置換: caller membership → 元Cloud Event `FOR SHARE` →
  Live `FOR UPDATE` → 既存StageをUUID順で`FOR UPDATE` → assignment/Stage差替え

Stage revisionの最終CAS、先頭pending/current entry、公開状態、projection version、現在の
membership/operator権限をlock後の状態で判定します。Entry更新とStage revision増加は同じ
transactionです。通信応答が失われてもmutationを自動再送せず、専用read RPCで確定状態を
再取得します。CASは競合検出であり、ネットワーク越しのexactly-once保証ではありません。

## ReadとRealtime

認証read RPCと公開read RPCは、Live rowをlockしてからStage rowを安定順でlockし、一つの
transaction内で整合したDTOを組み立てます。公開DTOにWorkspace ID、内部Event/Stage/
ScheduleItem ID、actor UUID、operator割当、Member/PA/Duty、自由記述Break名を含めません。

Realtime対象は`live_timetable_stages`だけです。publicationのcolumn listも、主キー、
Workspace/Live識別子、projection/Stage revision、進行状態、更新時刻の7列に限定し、
Section・予定時刻等の投影本文を通知へ含めません。`authenticated`へSELECTを与え、RLSで
現在のWorkspace memberに限定します。通知は再取得のきっかけにすぎず、payloadを正式状態
として適用しません。anon公開画面へPostgres Changesの購読権限は与えません。PR #79の
認証済み運営者向け画面は、通知後に認可付きread RPCを再取得し、切断中はbounded polling、
再接続時は即時再取得を行います。一般向け公開UIの同期処理は未実装です。
Broadcast/Presenceは使用しません。

固定依存`@supabase/supabase-js@2.117.2`での検証購読は、`postgres_changes`の`select`へ
7列を**文字列配列**で渡します。publicationの列指定やclient側の`select`は漏えいを減らす
補助であり、認可境界はtable SELECTとRLSです。2026-10-20のローカル実配信では、明示的な
`select`を省くとpublicationの列指定より広いrow payloadが届く互換性差を観測したため、
PR #79の購読でも省略しません。DELETEはPostgres ChangesのRLS filteringに制限があり、
同じ検証で
許可済みmemberにもDELETE通知が0件でした。Stage削除を含め、DELETE通知だけで画面状態を
確定せず、再接続・投影差替え・visibility復帰時の認可付き再取得を必須にします。

同画面では、初回購読成立・再接続・タブ復帰のたびに専用read RPCを再取得します。通知と
readが交差した場合は、取得開始時のrevisionより新しい通知を記録して追加取得し、古い応答で
画面を巻き戻しません。Workspace scope/visit変更後の完了は破棄し、membershipまたは操作権限
喪失時は操作を停止して権限状態を再取得します。通信断中のmutation queueは作りません。
最終同期時刻とstale表示を出し、pollingは重複を抑止してbackoffし、非表示・scope変更・権限
喪失で停止します。公開polling/Realtimeの同時接続数と負荷はHosted公開前に別途検証します。

## Edge Function

このfoundationを使い捨て環境で検証するときだけ、次を型検査・配備します。

```powershell
deno check --frozen `
  --config supabase/functions/create-live-timetable/deno.json `
  supabase/functions/create-live-timetable/index.ts
supabase functions deploy create-live-timetable --project-ref '<DISPOSABLE_PROJECT_REF>'
```

FunctionはBearer tokenを`auth.getUser()`で検証し、service-role keyはFunction環境だけで
使用します。`--no-verify-jwt`、frontend/Vercelへのservice-role key設定は禁止です。

### 専用local Auth / HTTP / Realtime smoke

このrunnerはAPI `56121`、PostgreSQL `56122`の新規loopback環境だけを許可し、引数
`--confirm-disposable`を必須にします。Auth userとWorkspace/Eventは実行ごとにランダム生成し、
正常・異常終了時に専用fixtureだけをcleanupします。既存環境やHostedの値を渡してはいけません。
別PowerShellで同じ使い捨てprojectのFunctionをJWT検証有効のままserveしてから実行します。

```powershell
# Terminal 1: <DISPOSABLE_ROOT> はAPI 56121 / DB 56122の専用projectだけ
supabase functions serve create-live-timetable `
  --workdir '<DISPOSABLE_ROOT>'

# Terminal 2: 値は同じ専用projectから取得し、画面・履歴・ログへ出力しない
$env:LIVE_TT_SMOKE_SUPABASE_URL = 'http://127.0.0.1:56121'
$env:LIVE_TT_SMOKE_ANON_KEY = '<DISPOSABLE_ANON_KEY>'
$env:LIVE_TT_SMOKE_SERVICE_ROLE_KEY = '<DISPOSABLE_SERVICE_ROLE_KEY>'
$env:LIVE_TT_SMOKE_DATABASE_URL = `
  'postgresql://postgres:<DISPOSABLE_PASSWORD>@127.0.0.1:56122/postgres'
pnpm test:live-timetable-http-realtime-smoke

Remove-Item Env:LIVE_TT_SMOKE_SUPABASE_URL
Remove-Item Env:LIVE_TT_SMOKE_ANON_KEY
Remove-Item Env:LIVE_TT_SMOKE_SERVICE_ROLE_KEY
Remove-Item Env:LIVE_TT_SMOKE_DATABASE_URL
```

PASSには実Auth JWT、Edge HTTP、backend-only RPC、repository parser、owner/editor/viewerの
UPDATE通知positive control、接続中viewerのmembership取消後にownerだけへ届くdistinct UPDATE、
取消済みviewerの認可read拒否、outsider/anonへの非配信、空白EventDay labelの`null`正規化、
`EVENT_NOT_FOUND`/`LIVE_NOT_FOUND`の区別、公開DTO allowlist、bigint revision、Cloud Event本文/
revision/generation不変、membership復元後の厳密cleanupをすべて含みます。viewerへの通知0件は
ownerへの同一UPDATEのpositive deliveryを確認した場合だけ認可証拠にします。DELETE通知の観測数は
診断値であり、0件を認可PASSの根拠にはしません。Hostedでの結果にも読み替えません。

## 使い捨てPostgreSQL検証

既存DBをresetせず、新規のSupabase互換PostgreSQL 17へ全16 migrationをfresh適用します。
接続先、port、database名を目視確認し、共有・staging・productionには実行しません。

```powershell
$env:ACAPPELLA_TT_TEST_DATABASE_URL = `
  'postgresql://postgres:<PASSWORD>@127.0.0.1:<NEW_PORT>/postgres'
$env:ACAPPELLA_TT_DBLINK_DATABASE_URL = `
  'postgresql://postgres:<PASSWORD>@<DISPOSABLE_DB_HOST>:5432/postgres'

psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v ON_ERROR_STOP=1 `
  -f supabase/tests/live_timetable_state_foundation.sql
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v ON_ERROR_STOP=1 `
  -v "test_db_url=$env:ACAPPELLA_TT_DBLINK_DATABASE_URL" `
  -f supabase/tests/live_timetable_state_foundation_concurrency.sql
```

最初のfixtureは単一transactionで`ROLLBACK`します。並行fixtureは複数connectionからlockを
観測するため一時的にcommitし、開始時に固定fixtureが存在すれば停止し、正常終了時だけ
固定IDを厳密cleanupします。中断時は対象ID・名称・関連行を検査し、別データが混在して
いれば削除してはいけません。

Catalog regressionはLive tableのRLS無効化、追加のpermissive SELECT policy、browser write、
継承権限、backend RPC露出、Realtime publication欠落・配信列拡大をtransaction内で破損させ、
read-only preflightがfail closedになり、rollback後のbaselineが復帰することを確認します。
実DBで未実行の間は、SQL fixtureの存在やNode静的テストだけをPostgreSQLでの成功証拠として
扱いません。

## 後続PRへ残すもの

- サークル員向けのログイン不要な閲覧専用UI
- 一般向け公開Live TT routeと、`public_view_enabled`を運用上有効化する手順
- skip/cancel/実時間訂正と監査履歴
- Live記録の削除・保存期間・export
- 公開IDのrotate/revoke
- Hosted Auth/HTTP/Realtimeのend-to-end検証
- 実機・学内Wi-Fiでの長時間接続、再接続、background動作の運用検証
- 障害時の現場手順、誤操作時の復旧手順

Cloud V2 backfill/Atomic CutoverはLive TTとは独立です。このrunbookから実行しません。
