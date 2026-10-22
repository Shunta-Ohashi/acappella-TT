# Live TT operator UI runbook

この文書は`20261021050414_live_timetable_operator_ui.sql`と、認証済み運営者向け
`#live=<Event ID>`画面の契約を記録します。通常Appは引き続きCloud Snapshot V1を使用し、
Cloud V2 backfill / cutover、匿名観客向け画面、Live DTOのlocalStorage保存は行いません。

## データ・認可境界

- Event一覧の「運営向けLive TT」だけが`#live=`へ遷移します。`#share=`とlocal-onlyは
  従来どおりで、Cloud設定がない状態のLive routeはfail closedです。
- discovery RPCは現在のWorkspace memberに、Event名、保存revision、Live IDだけを返します。
  Snapshot本文をLive画面へhydrateしません。
- Live未作成時はownerだけが、保存済みrevisionを指定して`mode=create`を確認付きで実行します。
  未保存のApp編集は含まず、この画面から`replace`は実行しません。
- ownerは全Stageを操作できます。editor/viewerはownerから割り当てられ、割当時の
  `granted_role`・認可epochと現在のWorkspace membershipが一致するStageだけ操作できます。
  role変更のたびにepochが回転するため、元のroleへ戻しても古い割当は復活せず、ownerが
  候補一覧から明示再割当する必要があります。同じroleを書き直すだけではepochを回転しません。
- owner向け候補RPCは現在のeditor/viewerの`userId`と`displayName`だけを返し、emailや
  Auth metadataを返しません。候補取得に失敗した場合は古い候補を割当に使わず、ownerが
  「担当候補を再取得」で復旧します。scope変更後や後発requestより古い候補応答は破棄します。
- `is_published`は運営上のLive進行有効化です。匿名公開は別の
  `public_view_enabled`も必要で、このUIからは有効化できません。

## CASと不明なmutation結果

開始・終了は投影versionとStage revision、公開切替・担当変更はmanagement revisionを
文字列のPostgreSQL bigintとして送ります。ボタン押下直後に同一画面のmutationを抑止し、
成功・拒否・通信結果不明のいずれでも認可readを再実行します。通信結果不明時に同じmutationを
自動再送せず、stale、offline、読取中断中は操作を無効にします。確認ダイアログは開始、終了、
Live進行切替、担当割当・解除の直前に表示します。

## Realtimeとpolling

`live_timetable_stages`のUPDATE通知は次の7列だけを購読します。

```text
id, workspace_id, live_timetable_id, projection_version,
revision, progress_status, updated_at
```

通知payloadは正式状態にせず、現在のuser / Workspace / workspace visit / Event / Live scopeと
一致した通知だけを認可readのきっかけにします。read応答は取得sequence、projection version、
management revision、Stage revision vectorを`BigInt`で比較し、古い応答を破棄します。

接続が正常でも30秒ごとにbackup readを行い、HTTP readが失敗した場合はRealtimeの
SUBSCRIBED状態とは独立して1〜15秒のbounded backoff pollingへ
移ります。タブ復帰、online復帰、JWT refreshでも即時再取得します。非表示時は定期pollingを
止め、復帰時は既存timerを取り消して即時readと次のtimerを各1本だけ設定します。45秒以上
同期できない画面はstaleとしてmutationを無効にします。offline mutation queueはありません。

Supabase RealtimeのRLS認可は接続時JWTと認可cacheの影響を受けます。membership取消直後の
既存channelが短時間7列通知を受ける可能性だけで権限を確定せず、通知後の認可readを唯一の
正式状態とします。認可readが拒否された場合はLive DTOを画面から破棄します。Hosted運用前に
取消後通知・JWT refresh・再接続を専用環境で再確認してください。

## 適用と使い捨てDB検証

既に15番目まで適用済みの共有・production DBで、この未公開migrationファイルを手動実行
しません。PR merge前は新しい使い捨てPostgreSQL 17へ全16 migrationをfresh適用します。
preflightはmigration historyに16番目がなければ`workspace_members`の従来3列、存在すれば
`authorization_epoch`を含む4列を要求し、historyとcatalogの食い違いを拒否します。
内部Stage DTO builderと旧authenticated read helperは、`PUBLIC` / `anon` /
`authenticated` / `service_role`から直接にも継承経由にも実行できないことを
migration guardとcatalog regressionで確認します。

```powershell
$env:ACAPPELLA_TT_TEST_DATABASE_URL = `
  'postgresql://postgres:<PASSWORD>@127.0.0.1:<NEW_PORT>/postgres'

supabase db push --db-url $env:ACAPPELLA_TT_TEST_DATABASE_URL
psql $env:ACAPPELLA_TT_TEST_DATABASE_URL `
  -v ON_ERROR_STOP=1 `
  -f supabase/tests/live_timetable_state_foundation.sql
node scripts/cloudEventMigrationCatalogRegression.mjs `
  --db-url-env ACAPPELLA_TT_TEST_DATABASE_URL `
  --confirm-disposable
```

Auth / HTTP / Realtime smokeはAPI 56121・DB 56122に固定された新規環境だけで実行します。
既存環境・Hostedへ向けず、JWT検証を無効化しません。

```powershell
pnpm test:live-timetable-http-realtime-smoke
```

PASSには、全16 migration、member-only discovery、owner-only候補、未割当拒否、割当viewerの
開始・終了、匿名公開分離、7列Realtime、取消後read拒否、Cloud Event非変更、Auth/DB fixtureの
厳密cleanupが含まれます。Node静的テストだけを実PostgreSQL・実HTTPの成功と読み替えません。

## ブラウザ確認

1. owner / editor / viewerでEvent一覧から同じLive画面を開く。
2. 未作成Eventではownerだけに作成操作が出て、未保存変更が除外される確認文が表示される。
3. ownerは全Stage、未割当editor/viewerは閲覧のみ、割当viewerは対象Stageだけ開始・終了できる。
4. 二重tap、別端末競合、offline、staleで操作が抑止され、再取得後に現在状態へ収束する。
5. 開催日・Stage切替、現在/次、予定/実時間、進行一覧がスマートフォンで判別できる。
6. Live進行を有効にしても匿名公開されず、`#share=`と通常編集画面が変わらない。

## 今回の範囲外

- 匿名観客向けLive routeと公開opt-inの運用UI
- skip / cancel / 実時刻訂正 / 監査履歴
- Live記録の削除、保存期間、export
- Hostedでの負荷、長時間接続、background throttling実測

