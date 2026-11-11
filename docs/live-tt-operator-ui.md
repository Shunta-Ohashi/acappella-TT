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

未割当viewerについては、最新の認可readから取得したLive / Stage / Entry IDとrevision、
projection versionで開始・終了RPCへ直接HTTP要求します。開始は未開始Entry、終了はownerが
実際に開始した別Stageの`in_progress` Entryを使用し、`ACCESS_DENIED`だけを合格とします。
拒否前後のowner認可read全体を比較し、進行状態・実時刻・revision・担当情報の不変を確認します。
終了拒否試験後はownerがそのEntryを終了し、既存の割当viewer正常系と通知を混同しません。

2026-10-28、本テスト追加後のワークツリーで、別Project ID・別volumeの使い捨て環境を
2つ順次作成し、PostgreSQL 17.11へ全16 migrationをfresh適用してsmokeが両方PASSしました。
両ケースで未割当viewerの開始・終了は`ACCESS_DENIED`、拒否前後の状態は不変でした。
既存の認可・割当viewer正常系・Realtime・Cloud Event非変更・cleanupもPASSし、各実行後に
関連16テーブルとAuth users / identities / sessionsの残存0件を直接確認しました。
前回の補助psql処理失敗はこの2環境では再発しておらず、原因は引き続き未確定です。

## Hosted検証記録（2026-10-28）

専用Project `sqrbioyjhxoehbmacujf`で、以下をユーザーが確認しました。
検証専用Eventは本番データではありません。

- 全16 migration適用、`save-cloud-event` / `create-live-timetable`の2 Function配備
- 個人用owner・学校用viewerのHostedログイン、Cloud Event保存、Live作成・進行有効化
- Stage担当者の割当・解除・再割当、開始・終了、複数ブラウザ間のRealtime同期
- 競合時の状態再取得、Offline / Online復帰、バックグラウンド復帰
- リロード後の進行状態維持、ログアウト後の認証要求、匿名公開OFFの維持

10/28時点の未実施は、実機スマートフォンのタッチ操作、学内Wi-Fi、Vercel Hosted Previewの
実機検証でした。後日のPCでのPreview確認は、下記の
[11/11の検証記録](#vercel-hosted-preview-pc基本検証記録2026-11-11)を参照してください。
この記録は上記の手動検証範囲を示すもので、すべての負荷・通信条件の保証ではありません。
PR #79のマージ可否とProduction公開可否は、それぞれ別に判断します。

## Vercel Hosted Preview PC基本検証記録（2026-11-11）

この節は、ユーザーから引き継いだ実機操作・表示の確認と、ChatGPTによる最終read-only SQLの
確認結果を記録します。今回の文書整備でCodexが再実行した試験ではありません。10/28のHosted
試験、使い捨てDBのHTTP / Realtime smoke、過去の競合試験とは別の記録です。

### 検証環境

- 検証日：2026-11-11 JST
- 実機検証対象commit：`05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`
  （この記録を追記した文書更新commitは、実機検証済みcommitではありません）
- Preview：<https://acappella-tt-live-test-qe21663mv-shunta-ohashi.vercel.app>
- Supabase検証専用Project：`sqrbioyjhxoehbmacujf`
- Workspace：学祭2026 Live TT Hosted検証
- Event：【検証用】Vercel実機テスト（本番データではありません）
- 開催日：2026-11-03、Stage：Vercel検証Stage
- Chromeシークレット：検証Owner（個人用）、Workspace role=`owner`
- Edge InPrivate：検証アカウント（学校用）、Workspace role=`viewer`

### A. ユーザーによる実機操作・表示の確認：PASS

- Owner / Viewerのログインと、同じWorkspace・Event・Stageの表示。
- OwnerによるLive進行の有効化・無効化、テストバンドAの開始・終了。
- ViewerをStage担当に明示割当すると操作可能になり、ViewerがテストバンドBを開始。
- B進行中に担当を解除するとViewerは閲覧のみに戻り、終了操作が無効化。
  Bの進行記録は保持され、再割当後にViewerがBを終了。
- 両ブラウザへの自動反映と、再読み込み後の進行記録・権限保持。
- ChromeのDevTools Offline設定で管理ボタンの操作停止・未同期警告を確認。
  オンライン復帰後は自動再取得し、操作可能状態へ復帰。
- EdgeがOfflineの間にOwnerがLive進行を有効化し、Edgeのオンライン復帰後、
  手動更新なしで有効状態へ追随。
- EdgeのLiveタブを閉じずに別タブへ約1分移動し、Ownerが変更した状態を、
  Liveタブ復帰後に手動更新なしで表示。
- 各確認後、OwnerがLive進行を無効へ戻し、Viewer側にも自動反映。

Offline時の操作停止を実測したのは管理ボタンです。終了済みの演奏の開始・終了ボタンについて、
Offline時の抑止まで実測した記録ではありません。自動反映は画面上の結果であり、Realtime通知
経路だけの計測や遅延保証ではありません。約1分のタブ復帰も、長時間放置・スリープ・タブ破棄の
検証とは区別します。

### B. ChatGPTの最終read-only SQLで確認した保存状態

| 項目 | 確認値 |
| --- | --- |
| source event revision | 2 |
| Live source revision | 2 |
| projection version | 2 |
| management revision | 16 |
| Stage revision | 5 |
| Stage progress status | `completed` |
| 現在 / 次のEntry位置 | いずれも`null` |

- A・Bとも`completed`で、実際の開始・終了時刻あり。
  Aの開始・終了者はOwner、Bの開始・終了者はViewer。
- 通信断・タブ復帰試験前後でEntry全行の比較用ハッシュが一致し、開始・終了時刻を含む
  演奏記録に変更なし。元Cloud EventのSnapshotも比較用ハッシュが一致し、変更なし。
- 終了時はLive進行OFF、匿名公開設定OFF、Stage担当割当0件。
  Workspace roleはOwner / Viewerのまま。

担当割当0件・Live進行OFFは、検証記録を削除したという意味ではありません。
A・Bの終了記録を保持して試験を終了しています。匿名公開設定OFFの保存状態確認と、
匿名アクセスを実際に試した拒否確認は別です。

### C. 今回のPreview実機テストに含めていない項目

以下はPC検証時点の範囲です。その後のスマホViewerの閲覧・短時間復帰・学内Wi-Fi基本確認は、
[後続のスマートフォン検証記録](#スマートフォンviewer学内wi-fi基本検証記録2026-11-11)に分けて
記録します。スマホの開始・終了タッチ操作まで確認済みという意味ではありません。

- スマートフォン実機のタッチ操作・画面復帰。
- 学内Wi-Fi（meijo / eduroam）での実アプリ確認。
- 同時操作によるCAS競合。
- 演奏の開始・終了ボタンのOffline時抑止。
- 送信途中の切断、結果不明、重複送信・再送の実測。
- 未割当 / 解除済みViewerなどによる直接RPCの権限拒否。
- EditorやWorkspace外ユーザーの今回の実機確認。
- 長時間接続、スリープ、タブ破棄、負荷試験。
- 匿名アクセスを実際に試した拒否確認。

過去の使い捨てDB試験や10/28のHosted試験で確認済みの項目は、各日付・環境の証拠として
上記の別記録に保持します。Cの項目を全環境で未検証としたり、過去の結果を今回のPreview
実機テストのPASSへ合算したりしません。

`05e3152`に対する既存のGitHub Actions CI #57とVercelチェックは成功しています。
2026-11-11のGitHub確認時点でPR #79はOpen・Draft・未マージ、インラインレビュー18件は
すべてResolvedですが、正式なレビュー承認ではありません。本記録はProductionの運用準備完了を
示すものではなく、PRのマージ可否とProduction公開可否は別判断です。Draftを維持します。

## スマートフォンViewer・学内Wi-Fi基本検証記録（2026-11-11）

この節は、ユーザーによるスマートフォンViewerの実機報告と、ChatGPTによる既存の最終
read-only SQL確認結果を引き継いだ記録です。今回の文書整備でCodexが実機試験・Hosted試験・
SQLを再実行した結果ではありません。10/28のHosted / 使い捨てDB試験と、上記11/11のPC検証は
別の時点・範囲の記録として保持し、今回のPASSへ合算しません。

### 検証環境

- 検証日：2026-11-11 JST
- 実機検証対象commit：`05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`
  （`ddde585`および今回の文書更新commitは、実機検証済みcommitではありません）
- Preview：<https://acappella-tt-live-test-qe21663mv-shunta-ohashi.vercel.app>
- Supabase検証専用Project：`sqrbioyjhxoehbmacujf`
- Workspace：学祭2026 Live TT Hosted検証
- Event：【検証用】Vercel実機テスト（本番データではありません）
- 開催日：2026-11-03、Stage：Vercel検証Stage
- スマートフォン：Pixel 11、Chromeのシークレット（機種・ブラウザはユーザー確認済み）
- OSとChromeのバージョン：未確認。推測では補完しません。
- スマホ：検証アカウント（学校用）、Workspace role=`viewer`
- 操作側PC：Chromeシークレット、検証Owner（個人用）、Workspace role=`owner`
- 通信：大学のWi-Fi。ユーザーからeduroam・meijoの両方で成功したとの報告あり。

### A. ユーザーによる実機操作・表示確認：PASS

- Vercel認証とアプリへのログインに成功し、同じWorkspace・Event・開催日・Stageを表示。
- Workspace権限はviewer、選択Stageの操作は「閲覧のみ」。初期表示・スクロールと、
  既存のテストバンドA・Bの終了記録を確認し、ユーザーは表示上の問題なしと報告。
- Live画面をスマホで前面表示中、PC OwnerによるLive進行の有効化・無効化が、
  手動更新なしで自動反映。ユーザーは「瞬時に自動反映された」と報告。
- Liveタブを閉じずに画面をロックし、その間にPC OwnerがLive進行を有効化。
  約1分後のロック解除で同じ画面へ戻ると、手動更新なしで有効状態・最新表示へ復帰し、
  最後の無効化も自動反映。
- 機内モードON・Wi-Fi OFFで通信を切り、その間にPC OwnerがLive進行を有効化。
  約1分の通信断確認後、元の通信状態へ戻すと、手動更新なしで有効状態・最新表示へ追随。
  ユーザーは案内した確認手順の成功を報告。
- 学内Wi-Fiのeduroam・meijoの両方で成功したとのユーザー報告あり。

「瞬時」はユーザーの体感報告であり、ミリ秒単位の計測や遅延保証ではありません。画面の
自動反映を確認したもので、Realtime通知経路だけを分離して計測していません。両SSIDの成功報告は
記録しますが、個別の実施記録がない「全試験項目×両SSID」の網羅表は作りません。スマホはViewerの
閲覧側として使用し、演奏の開始・終了は操作していません。

### B. ChatGPTによる既存の最終read-only SQL確認結果

終了時の確認でLive進行ONが残っていたため、ユーザーがOwner UIでOFFへ戻しました。
その後の2026-11-11 14:21:26 JSTのread-only SQLで、次の保存状態を確認しています。
これは引き継いだ既存結果であり、今回CodexがSQLを実行した結果ではありません。

| 項目 | 確認値 |
| --- | --- |
| source event revision | 2 |
| Live source revision | 2 |
| projection version | 2 |
| management revision | 28 |
| Stage revision | 5 |
| Stage progress status | `completed` |
| current entry / next entry / next performanceの位置 | すべて`null` |
| Stage / Entry件数 | 1 / 2 |
| Live進行 | OFF（`is_published=false`） |
| 匿名公開設定 | OFF（`public_view_enabled=false`） |
| Stage担当割当 | 0件 |

- A・Bとも`completed`で実開始・終了時刻があり、時刻の前後関係に問題なし。
  Aの開始・終了者はOwner、Bの開始・終了者はViewer。
- Entry全行と元Cloud Event Snapshotの比較用ハッシュは、それぞれPC検証終了時と一致。
- Workspace roleはOwner / Viewerを維持。

PC検証終了時のmanagement revision=16と、今回の最終確認時の28は異なる時点の値です。
A・Bの終了記録はPC検証で作成したものであり、今回スマホから開始・終了した記録ではありません。
終了記録を保持して終了しており、検証データを削除・初期化したという意味ではありません。
匿名公開設定OFFの保存状態確認も、匿名アクセス拒否の実測とは区別します。

### C. 今回のスマホ検証に含めていない項目

- スマホのOwner / 明示割当Viewerによる演奏開始・終了のタッチ操作。
- 演奏開始・終了ボタンのOffline時抑止。
- 未割当 / 解除済みViewerなどによる直接RPCの権限拒否。
- 同時操作によるCAS競合。
- mutation送信途中の切断、結果不明、重複送信・再送の実測。
- EditorやWorkspace外ユーザーの今回の実機確認。
- 長時間接続・長時間ロック、タブ破棄、負荷試験。
- Wi-Fi間のローミング。
- 匿名アクセスを実際に試した拒否確認。

過去の使い捨てDBや10/28 Hostedの検証実績は、各日付・環境の証拠として保持します。
今回の成果は「スマホViewerの閲覧・自動反映・短時間の復帰と学内Wi-Fiでの基本確認」であり、
「スマホ全機能PASS」「全環境で安全」「Production公開準備完了」とは扱いません。
PRのマージ可否とProduction公開可否は別判断で、PR #79はOpen・Draft・未マージを維持します。

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

