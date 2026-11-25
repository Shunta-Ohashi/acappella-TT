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
その後に別Eventで実施した明示割当Viewerの演奏操作については、
[スマートフォンViewer操作検証記録](#スマートフォンviewer操作検証記録2026-11-11)を参照してください。
スマホOwnerの開始・終了と進行中の終了ボタンのOffline抑止については、
[11/17のOwner操作記録](#スマートフォンowner操作終了offline検証記録2026-11-17)に分けて記録します。

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

以下はスマホ閲覧試験時点の範囲です。その後に別Eventで確認した明示割当Viewerの開始・終了、
B開始前のOffline抑止などは、[後続の操作検証記録](#スマートフォンviewer操作検証記録2026-11-11)に
分けて記録します。11/11時点で未実施だったスマホOwnerの操作と進行中の終了ボタンのOffline抑止は、
[11/17のOwner操作記録](#スマートフォンowner操作終了offline検証記録2026-11-17)を参照してください。

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

## スマートフォンViewer操作検証記録（2026-11-11）

この節は、新Eventでユーザーが行ったスマートフォン操作検証と、ChatGPTの最終read-only SQL
確認結果を引き継ぐ記録です。今回の文書整備でCodexがブラウザ試験・SQL・Hosted試験を再実行した
結果ではありません。10/28、11/11 PC、旧Eventでのスマホ閲覧試験とは分離します。

### 検証環境

- 検証日：2026-11-11 JST
- 実機検証対象commit：`05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`
  （`ddde585`・`98402e2`および今回の文書更新commitは、実機検証済みcommitではありません）
- Preview：<https://acappella-tt-live-test-qe21663mv-shunta-ohashi.vercel.app>
- Supabase検証専用Project：`sqrbioyjhxoehbmacujf`
- Workspace：学祭2026 Live TT Hosted検証
- 新Event：【検証用】スマホ操作テスト
- Event ID：`event-256f6c71-d9d2-434d-acc7-e99343015c8c`
- 開催日：2026-11-11、Stage：スマホ検証Stage
- Live ID：`f937ff74-e8dc-4b74-b217-e6e67ef1ef52`
- スマホ：Pixel 11 / Chromeシークレット / 学校用検証アカウント（Workspace role=`viewer`）
- 管理側PC：Chromeシークレット / 個人用検証Owner
- OS・Chromeのバージョンと、今回の操作試験で使用した回線・SSID：未確認。
  前回の閲覧試験でのeduroam・meijo成功報告は保持しますが、今回の操作試験を両SSIDで行ったとは
  扱いません。

### A. ユーザーによる実機操作・表示確認：PASS

ユーザーは、案内した次の①〜⑦がすべて成功したと報告しました。

1. 新Event内にStage・Sectionと、別々の検証用メンバーを持つ7分枠の
   「【検証用】スマホA」「【検証用】スマホB」を作成。A→Bの順に配置し、Cloud保存後に初めて
   Live TTを作成。
2. 未割当Viewerは閲覧のみ。OwnerがLive進行を有効化し、学校用ViewerをStageへ明示割当すると、
   スマホで操作可能になった。Workspace roleはviewerのまま。
3. スマホでAを開始・終了し、PCにも手動更新なしで自動反映。
4. B開始前にスマホを機内モードON・Wi-Fi OFFとして約1分確認。開始操作は抑止され、PC上でも
   Bは未開始を維持。通信復帰後は手動更新なしで最新状態へ戻り、Bが勝手に開始されることなく、
   開始操作が再び可能になった。
5. スマホでBを開始。PC OwnerがStage担当を解除すると、スマホは閲覧のみとなり終了操作不可。
   Bの進行中表示と開始記録は保持された。
6. Ownerが再割当するとスマホの操作権限が戻り、スマホでBを終了。PCにも自動反映。
7. 最後にOwnerが担当を解除してLive進行を無効化。スマホにも反映され、PC・スマホの
   再読み込み後もA・Bの終了記録が保持された。

タッチ操作・画面遷移・自動反映・通信断時のボタン状態は、このユーザー報告を根拠とします。
以下のSQL結果だけで、端末操作や通信経路まで確認できたとは扱いません。

### B. ChatGPTによる最終read-only SQL確認結果

確認日時は2026-11-11 15:15:12 JSTです。検証専用Projectに対して
`transaction_read_only=on`で確認済みの結果を引き継ぎます。今回CodexはSQLを再実行していません。

| 新Eventの項目 | 確認値 |
| --- | --- |
| source event revision | 1 |
| Live source revision | 1 |
| projection version | 1 |
| management revision | 7 |
| Stage revision | 5 |
| Stage | 1件、`progress_status=completed` |
| Entry | 2件、A・Bとも`completed` |
| current entry / next entry / next performanceの位置 | すべて`null` |
| Live進行 | OFF（`is_published=false`） |
| 匿名公開設定 | OFF（`public_view_enabled=false`） |
| Stage担当割当 | 0件 |

| 演奏 | 実開始（JST） | 実終了（JST） | 開始者 / 終了者 |
| --- | --- | --- | --- |
| 【検証用】スマホA | 15:10:22.003349 | 15:10:32.361839 | 学校用Viewer / 学校用Viewer |
| 【検証用】スマホB | 15:11:41.167976 | 15:12:03.577770 | 学校用Viewer / 学校用Viewer |

実開始・終了時刻の前後関係は正常で、Workspace roleはOwner / Viewerを維持しています。
SQLは保存状態と操作アカウントの確認であり、スマホのタッチ操作・画面遷移・自動反映・通信断時の
ボタン状態の証拠はAのユーザー報告と区別します。

旧Event「【検証用】Vercel実機テスト」の保全も同じ最終確認で確認済みです。

- management revision=28、Stage revision=5を維持。
- Live進行OFF、匿名公開設定OFF、Stage担当0件。
- 元Cloud Event SnapshotとEntry全行の比較用ハッシュは、それぞれ前回の最終確認結果と一致。
  旧Eventの演奏記録は保持。

PC終了時のmanagement revision=16、旧Eventのスマホ閲覧試験終了時の28（14:21:26 JST）、
新Eventの7（15:15:12 JST）は別時点・別Eventの記録です。終了記録を保持して終了しており、
検証データの削除・初期化は行っていません。

### C. 今回未実施の項目・証拠の限界

以下は11/11のViewer操作試験時点の範囲です。スマホOwnerの開始・終了と進行中の終了ボタンの
Offline抑止は、別Eventで実施した[11/17の記録](#スマートフォンowner操作終了offline検証記録2026-11-17)に
分けて記録し、11/11の結果へ遡って合算しません。

- 確認したスマホ操作は明示割当Viewerによるもの。スマホOwnerによる開始・終了は未実施。
- Offline試験はB開始前の開始ボタンの抑止。進行中の終了ボタンのOffline抑止は未実施。
- 担当解除後の終了不可はUI確認であり、直接RPCを送信した認可拒否試験ではない。
- 自動反映は画面上の確認であり、Realtime経路だけの分離計測や遅延保証ではない。
- 復帰時にBが自動開始しなかったことを、mutation送信途中の切断・結果不明・重複送信・再送への
  耐性確認へ拡張しない。これらは今回未実施。
- 同時操作CAS競合、未割当 / 解除済みViewerなどの直接RPC拒否、Editor / Workspace外ユーザーの
  今回の実機確認は未実施。
- 長時間接続・長時間ロック・タブ破棄・負荷、Wi-Fiローミング、匿名アクセス拒否の今回の実機確認は
  未実施。匿名公開設定OFFの保存状態確認と匿名アクセス拒否の実測は区別する。
- 今回の操作試験の回線・SSIDは未確認。前回の閲覧試験の両SSID成功報告を流用しない。

過去の使い捨てDB・Hosted試験は各日付・環境の証拠として保持し、今回の実機PASSへ合算しません。
この結果は「スマホ全機能PASS」「Production公開準備完了」ではありません。PRのマージ可否と
Production公開可否は別判断であり、PR #79はOpen・Draft・未マージを維持します。

## スマートフォンOwner操作・終了Offline検証記録（2026-11-17）

この節は、ユーザーが報告したスマートフォンOwnerの操作・表示確認と、その後ChatGPTが
検証専用Projectで行ったread-only SQL確認を分けて記録します。11/11のPC・Viewer試験とは
別Event・別時点の証拠です。この文書更新ではブラウザ試験・SQL・Hosted smokeを再実行していません。

### 検証環境と対象

- 検証日：2026-11-17 JST
- 案内したPreview：<https://acappella-tt-live-test-qe21663mv-shunta-ohashi.vercel.app>
  既存記録での対応commitは`05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`。
  当日の端末からbuild識別子は再取得しておらず、文書更新前HEADの`3bad9316`や今回の文書更新commitを
  実機検証済みcommitとは扱いません。
- Supabase検証専用Project：`sqrbioyjhxoehbmacujf`（`acappella-tt-live-validation`）
- Workspace：学祭2026 Live TT Hosted検証
  （`e73db27b-f32b-4310-8498-6a21269bd065`）
- Event：【検証用】スマホOwner操作
  （`event-f1fd2fb5-b80f-4e7d-8e94-dffc70864bb3`）
- Live ID：`32c85bb4-3063-4f1a-97ec-fa58b220c4bc`
- Stage：テスト用（1件）、Entry：OwnerテストA → OwnerテストB（2件）
- 操作側：スマホOwner。同期確認側：PC。機種・OS・ブラウザの種類／バージョンは今回は再確認していません。
- 通信：PC・スマホとも学校Wi-Fiとのユーザー報告。今回のSSIDは未確認で、
  11/11のViewer閲覧試験のmeijo・eduroam成功報告を今回へ流用しません。

### A. ユーザーによる実機操作・表示確認：7項目PASS

Aの基本操作3項目について、ユーザーはすべて成功したと報告しました。

1. スマホOwnerでAを開始・終了できた。
2. PCにも手動更新なしで反映された。
3. 再読み込み後もAは終了済み、Bは未開始だった。

続いて、Bを進行中にした上で通信断・復帰を確認し、次の4項目すべてに成功したと報告しました。

1. 通信断中、スマホではBの終了操作ができなくなった。
2. 通信断中もPCではBが進行中のままだった。
3. 復帰後、手動更新なしで操作可能になり、Bは勝手に終了しなかった。
4. スマホでBを終了でき、PCへの反映と、再読み込み後の記録保持にも成功した。

案内した切断手順はスマホの機内モードON・Wi-Fi OFF、Liveタブを維持した短時間の確認です。
実際の切断継続時間・ボタン無効化までの秒数・復帰遅延は計測していません。タッチ操作、通信断中の
ボタン状態、PC表示、自動反映はユーザー報告を根拠とし、以下のSQL結果から推定したものではありません。

### B. ChatGPTによる最終read-only SQL確認結果

2026-11-17 09:36:19 JSTにユーザー提示のEvent IDから対象を1件に特定し、
09:37:55 JSTに同じWorkspace・Event・Liveの最終保存状態を確認しました。
検証専用Projectで`REPEATABLE READ READ ONLY` transactionを使用し、`read_only=on`を確認して
`ROLLBACK`で終了しています。以下はその確認結果であり、この文書更新でSQLを再実行した結果ではありません。

| 項目 | 確認値 |
| --- | --- |
| source event revision / Live source revision | 1 / 1 |
| projection version | 1 |
| management revision | 3 |
| Stage revision / Stage projection version | 5 / 1 |
| Stage / Entry件数 | 1 / 2 |
| Stage progress status | `completed` |
| current entry / next entry / next performanceの位置 | すべて`null` |
| Live進行 | OFF（`is_published=false`） |
| 匿名公開設定 | OFF（`public_view_enabled=false`） |
| Stage担当割当 | 0件 |
| 開始・終了記録のactor | 4つの開始・終了記録で同じ1名。確認時点のWorkspace roleは`owner` |

実時刻はすべて2026-11-17 JSTです。

| 演奏 | 状態 | 実開始（JST） | 実終了（JST） |
| --- | --- | --- | --- |
| OwnerテストA | `completed` | 09:25:19.585776 | 09:25:23.983430 |
| OwnerテストB | `completed` | 09:29:12.109457 | 09:30:11.492057 |

両Entryの開始・終了時刻の前後関係は正常で、各Entryの開始者と終了者は同じです。
OwnerはStage担当への明示割当なしで操作可能なため、担当0件とOwner操作記録は矛盾しません。
A・Bの終了記録は保持しており、確認SQLによる削除・初期化・権限変更は行っていません。

### C. 証拠の限界と残る判断

- 今回のPASSはスマホOwnerの基本開始・終了、B進行中の通信断時の終了操作抑止、復帰後の
  意図しない終了がないこと、PCへの自動反映とリロード後の記録保持の範囲です。
- Bの実開始から実終了までの時刻差は演奏の進行時間であり、通信断時間や復帰遅延ではありません。
  自動反映をRealtime経路だけの分離計測や遅延保証とは扱いません。
- mutation送信途中の切断・結果不明・重複送信・再送、同時操作CAS競合、直接RPCの認可拒否、
  Editor／Workspace外ユーザー、長時間接続・ロック・タブ破棄・負荷・Wi-Fiローミングは今回未実施です。
  過去に別環境で実施した試験の証拠は、各日付の記録に保持します。
- actorのroleは最終確認時点のmembershipであり、操作時点のrole履歴を監査した結果ではありません。
- 今回は元Cloud Event Snapshotや旧Eventとの前後ハッシュ比較を取得していません。
  source revisionの一致だけでSnapshot本文や他Event全体の不変性を保証しません。
- 匿名公開設定OFFの保存値は確認しましたが、匿名アクセスのHTTP拒否試験は今回行っていません。
- 今回の文書更新はrunbookとPR #79本文の記録更新のみです。実装・migration・Auth設定・配備設定は
  変更せず、マージ・Draft解除・本番DB適用・本番配備も行いません。

11/11時点で残っていたスマホOwner操作と進行中の終了Offline確認は、上記の限定した範囲で
追加確認できました。「スマホ全機能PASS」「Production公開準備完了」とは扱いません。
本番バックアップの復元試験や適用前の再確認・別途承認は、この記録では完了扱いにしません。
PRのマージ可否とProduction公開可否は別判断で、PR #79はOpen・Draft・未マージを維持します。

## リリース候補と専用Hosted／Previewの照合（2026-11-24 JST）

今回の候補は `feature/live-tt-operator-ui` の `3bad931`。Vercelからデプロイ `dpl_8APhCgjsrgn5AAs9fLtS9DRJ5NzN` が `READY`、Preview URLは `https://acappella-tt-live-test-qe21663mv-shunta-ohashi.vercel.app/`、ソースは `05e315286f8f9b85f1e9ddb6c32bba19d4b7f915` と確認した。この差は `docs/live-tt-deployment.md` と本書だけ。アプリ、migration、Functions、依存・build設定に差はない。

検証専用接続先は、11/11の同一デプロイURLと当時の保存状態の記録から `sqrbioyjhxoehbmacujf` と対応付けた。このURLはVercel APIのデプロイ固有 `url` で、別に返るbranch aliasとは区別した。`src/cloud/cloudConfig.ts` の接続先はViteのビルド時設定。そのProjectに読み取り専用で全16 migration、`create-live-timetable` と `save-cloud-event` のACTIVE v1・JWT検証有効、`public.live_timetable_stages` の7列publication、RLS有効・`authenticated` SELECT・`anon` SELECTなしを確認した。2 Functionsについて返却された33ファイルは改行を正規化した比較で候補版と差なし。専用Workspace `学祭2026 Live TT Hosted検証` にOwnerとViewerが各1件いる。現在のPreviewの通信先の直接観測は未実施。保護付きHTTP取得は一時共有リンクを作る副作用のため承認レビューで拒否され、デプロイファイル一覧も得られなかった。通常ブラウザーの自動操作は初期化エラーで停止。本実行ではテストEventを作成していない。[VercelのデプロイURL](https://vercel.com/docs/deployments/generated-urls)、[Viteのビルド時環境変数](https://vite.dev/guide/env-and-mode.html)。

| 項目 | 区分 | 根拠 |
| --- | --- | --- |
| Ownerによる保存済みCloud Eventからの投影作成 | 11/25本人smokeでPASS | 11/11のスマホ操作試験は画面操作の既存証拠として再利用可能。 |
| 明示割当Viewerの開始・終了 | 11/25本人smokeでPASS | 11/11の開始・終了の画面操作と保存記録も再利用可能。 |
| 7列Realtime通知と認可read | 11/25本人smokeで開始・終了ともにPASS | 対象Stageの通知行7列と、通知起点のOwner認可readのrevision・状態を照合した。旧Previewの画面自動反映の記録では通知とpollingの区別はついていない。 |
| 未割当Viewerの開始・終了拒否と前後不変 | 11/25本人smokeで両方PASS | 本人権限での直接RPC拒否と状態不変。11/24の2回目は開始だけPASS。 |

### 11/24の本人実行と補助の修正

本人実行は `INCOMPLETE AT CREATE_OWNER_PROJECTION`、`FINAL OFF_UNCONFIRMED`、終了値2。対象Event限定の実行後観測では投影が保存され、Live進行OFF、匿名公開OFF、操作割当0件を確認。元の実行結果はそのまま保持する。作成時刻と同じ時間帯のHTTPステータスおよび呼出し順と応答仕様から、作成直後と終了確認の匿名readで、正常な公開対象なしを旧補助が不合格にしたと判断した。停止の根拠と観測範囲は [引き継ぎの第8節](handoff.md#8-次に取り組む作業は1つ) を参照。

2回目は、Owner投影作成と未割当Viewerの開始拒否・前後不変がPASS。 `INCOMPLETE AT REALTIME_AND_ASSIGNED_VIEWER_START`、`FINAL LIVE_OFF ANONYMOUS_READ_DENIED OPERATORS=1`、終了値2を保持する。このrunの開始のDB反映は事後に確認済みで、実通知は未確認。[実行記録と停止原因](handoff.md#2026-11-24-jstのhosted本人セッション2回目)

### 11/25のHosted smoke完了

対象は専用Project `sqrbioyjhxoehbmacujf`、Workspace `e73db27b-f32b-4310-8498-6a21269bd065`、Vercelデプロイ `dpl_8APhCgjsrgn5AAs9fLtS9DRJ5NzN`（既存記録のソースは `05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`）、Event `hosted-live-evidence-5783a7cf-0365-47df-8b33-c3b247bb021e`。ローカルの候補 `3bad931` との差はコミット間で文書2件。実行出力はPostgres Changes準備待ちと担当解除を追加した作業ツリー版のHosted補助に対応する。ローカルファイルの照合情報は引き継ぎに記録した。実行時のファイルハッシュ・Node／SDK実行版は未記録。補助は専用ProjectのAPIへ接続するため、新たにブラウザーの画面や操作を確認した範囲はない。[版と確認範囲](handoff.md#2026-11-25-jstのhosted本人セッション完了)

本人のPowerShell共有出力。

```text
PASS OWNER_SAVED_EVENT_PROJECTION
PASS UNASSIGNED_START_ACCESS_DENIED_UNCHANGED
PASS ASSIGNED_VIEWER_START_REALTIME_7_COLUMNS_AUTHORIZED_READ
PASS UNASSIGNED_END_ACCESS_DENIED_UNCHANGED
PASS ASSIGNED_VIEWER_END_REALTIME_7_COLUMNS_AUTHORIZED_READ
FINAL LIVE_OFF ANONYMOUS_READ_DENIED OPERATORS=0
FINAL TEST_ASSIGNMENT_ABSENT
COMPLETED HOSTED LIVE EVIDENCE
HOSTED_SMOKE_EXIT=0
```

ChatGPTによる11/25 09:20 JSTの別の読み取り観測では、このEventの進行と匿名公開はOFF、割当0件。演目1件が `completed` で開始・終了時刻を保存済み。今回の文書更新で再照会していない。

09:20 JST時点で、前回Event `hosted-live-evidence-c7862da6-f39c-496e-839c-93e44731a0ef` は進行OFF・匿名公開OFF・割当1件で、当時の送信制限により解除を保留していた。11/25 10:19:17 JSTのChatGPTによる事後の読み取り観測では、同じ専用Project・Workspaceで前回Eventと成功Eventの双方が進行OFF・匿名公開OFF・割当0件。割当残存は観測時点で解消した。解除時刻・実行者は未確認で、元の `INCOMPLETE` と終了値2は履歴として保持する。

本人報告では、専用ProjectにGmailのカスタムSMTPを設定後、Owner／ViewerへのMagic Link到着と通常のブラウザーログインを確認した。設定値と確認範囲はdeployment runbookに記録する。[SMTP・送信制限の確認項目](live-tt-deployment.md#3-supabaseテストproject)

### Hosted smokeの実行手順

以下は必要時に参照する手順。11/25の専用Hosted実測は完了済み。

1. 対象はProject `sqrbioyjhxoehbmacujf` の **学祭2026 Live TT Hosted検証**（Workspace ID `e73db27b-f32b-4310-8498-6a21269bd065`）。11/11に使った個人用検証Ownerと学校用検証Viewerを使う。既存セッションでは、Previewの上部でWorkspaceを選び、既存Live画面を開いて「Workspace権限」がそれぞれ `owner`／`viewer` と表示されることを閲覧で確認できる。メールアドレスが分からなければ、専用ProjectのTable Editorで `public.workspace_members` を対象Workspace IDで絞り、`role` ごとの `user_id` を Authentication → Users のUIDと照合する。メールアドレスは画面内だけで確認し、Workspaceやロールを編集しない。補助も両本人の認証後、同じWorkspaceでロールを照合する。
2. [通常Preview](https://acappella-tt-live-test-qe21663mv-shunta-ohashi.vercel.app/) を既存のVercelログインで開く。DevToolsのNetworkを表示して再読み込みし、アプリのSupabase通信先のホスト名が `sqrbioyjhxoehbmacujf.supabase.co` と一致する場合に進む。既存セッションがなく通信先が見えない場合は、読み込まれたViteのJSのResponseで固定されたSupabase URLを確認できる。ホストを特定できない場合は `--run` を見送る。
3. 通常の非管理者PowerShellを開き、まず次を実行する。`--self-test` で匿名read契約、Realtime、後処理の3つのPASSを確認する。`--plan` は通信せず、`PLAN ONLY` に対象のデプロイID・Project・Workspace IDを表示する。どちらかが失敗するか、対象が異なれば `--run` に進まない。

```powershell
Set-Location -LiteralPath (Join-Path $env:USERPROFILE 'acappella-TT')
node.exe .\scripts\liveTimetableHostedEvidence.mjs --self-test
node.exe .\scripts\liveTimetableHostedEvidence.mjs --plan
```

4. 専用ProjectのDashboardで **Settings → API Keys → Publishable key** の既存 `sb_publishable_` キーを確認する。Previewの「ログイン」画面をアプリ未ログインのブラウザーで表示し、「メールアドレス」にOwnerのアドレスを入力して「ログインリンクを送信」を押す。Viewerも同じ画面で自分の検証アドレス宛てに1通発行する。メールのボタンは開かず、「リンクのアドレスをコピー」で新しい未使用リンクを取得する。コードは `signInWithOtp` と `shouldCreateUser: false` で既存アカウント向けに発行を要求する。
5. 補助が受け付ける形式は `https://sqrbioyjhxoehbmacujf.supabase.co/auth/v1/verify?token=＜実値＞&type=magiclink`。`redirect_to` は省略または1個、`token` と `type` は各1個。補助は `token` の値を `token_hash`、`type` を `magiclink` として同じAuthのverify APIへPOSTし、返った本人セッションを使う。実際のメールの形式は到着時に確認する。メール追跡URL、OTPコードだけ、`type=email` や招待リンク、期限切れ・使用済みのリンクでは進めない。Vercelのログイン用リンクとも別。メールテンプレートや認証設定は変更しない。[Supabaseのメールテンプレート](https://supabase.com/docs/guides/auth/auth-email-templates)、[キーの取得方法](https://supabase.com/docs/guides/getting-started/api-keys)。
6. 同じPowerShellで以下を実行する。非表示の入力欄には順に **Publishable Key → OwnerのMagic Link → ViewerのMagic Link** を貼り付け、各欄でEnterを押す。コマンド行、ファイル、チャットには実値を入力しない。両ロール確認後に補助が新しい合成Eventを1件作成する。

```powershell
node.exe .\scripts\liveTimetableHostedEvidence.mjs --run --confirm-deployment dpl_8APhCgjsrgn5AAs9fLtS9DRJ5NzN --confirm-preview-project sqrbioyjhxoehbmacujf
$hostedSmokeExit = $LASTEXITCODE
"HOSTED_SMOKE_EXIT=$hostedSmokeExit"
```

補助はチャネル参加とPostgres Changesの準備を確認後、Viewerに割当を行う。通知は対象Stageの `UPDATE` の行データ7列と開始／終了それぞれのrevisionを照合し、そのコールバック内のOwner認可readが同じrevision・状態を返したときに合格とする。拒否は正しい未開始／進行中のEntryと最新のrevisionでViewerから送信し、`ACCESS_DENIED` とOwner DTO全体の前後一致を要求する。

補助は正常終了・途中停止ともに、Owner APIで進行OFFと今回の担当割当解除を試みる。更新後のOwner readで進行状態と担当割当を照合し、匿名readはHTTP 200かつ公開RPCの `null` を表す `NOT_FOUND` で合格とする。成功の目印は `HOSTED_SMOKE_EXIT=0`、`COMPLETED HOSTED LIVE EVIDENCE`、`FINAL LIVE_OFF ANONYMOUS_READ_DENIED OPERATORS=0`、`FINAL TEST_ASSIGNMENT_ABSENT`。表示された `FIXTURE_EVENT_ID`、`PASS`、`DIAGNOSTIC`、`INCOMPLETE`、`FINAL`、`COMPLETED`、`HOSTED_SMOKE_EXIT` の行を共有する。`DIAGNOSTIC` は固定工程・HTTPステータス・固定理由だけを表示する。途中停止時は自動再試行せず、`FINAL` の未確認・残存と当該Eventの読み取り専用確認を突き合わせる。

補助は構文、合成応答による通知・認可read・後処理、対象Project不一致での停止をオフライン確認済み。ここでの通知確認はSupabase SDKと同じ認可readを使う専用クライアントで行う。実ブラウザーの通知ハンドラまではこの補助の確認範囲に含めない。本番導入、復旧判定、既存のアプリ設定は従来の扱い。

## ブラウザ確認

1. owner / editor / viewerでEvent一覧から同じLive画面を開く。
2. 未作成Eventではownerだけに作成操作が出て、未保存変更が除外される確認文が表示される。
3. ownerは全Stage、未割当editor/viewerは閲覧のみ、割当viewerは対象Stageだけ開始・終了できる。
4. 二重tap、別端末競合、offline、staleで操作が抑止され、再取得後に現在状態へ収束する。
5. 開催日・Stage切替、現在/次、予定/実時間、進行一覧がスマートフォンで判別できる。
6. Live進行を有効にしても匿名公開されず、`#share=`と通常編集画面が変わらない。

### スマホでのLive運営画面の操作性確認

既存記録では「【検証用】スマホ操作テスト」の2演目と、11/25の成功smoke Eventの1演目が終了済み。これらは表示確認に使える。前回の中断Eventも検証履歴として保持する。開始・終了には未開始の演目が2件ある合成Eventを使う。既存記録で適切なものを特定できなければ、操作確認のときにOwnerが専用Workspace内にStage 1件・演目2件の合成Eventを作成してCloud保存する。今回は既存記録で確認し、データの再照会・作成・変更は行っていない。

1. スマホで [現在のPreview](https://acappella-tt-live-test-h89q0n42e-shunta-ohashi.vercel.app/) を開く。専用Project `sqrbioyjhxoehbmacujf` の「学祭2026 Live TT Hosted検証」で、別々のブラウザーセッションに検証OwnerとViewerで入り、同じ合成Event・Stageを開く。
2. **Owner** は必要なら保存済みEventから「Live TTを作成」し、「Live進行を有効化」する。1件目を開始・終了し、縦画面で確認ダイアログ、現在／次の表示、予定／実時刻が読めて操作しやすいかを見る。この時点で未割当の **Viewer** は閲覧のみ。
3. **Owner** が「Stage担当者」でViewerを対象Stageに割り当てる。**Viewer** は2件目を開始・終了し、両画面で状態が更新され、再表示後も記録が残るか確認する。操作ボタンの見つけやすさ、タップしやすさ、横はみ出し、状態の見分けやすさを記録する。
4. **Owner** が割当を解除し、「Live進行を無効化」する。担当者なし、Viewerが閲覧のみ、2件分の記録保持を確認する。匿名公開はOFFのまま扱う。結果は機種・OS・ブラウザー、役割、該当の画面と操作で記録する。

この手順は専用環境での開発検証。既存のHosted smokeと本番導入条件は従来の扱い。

### 11/25の担当者ボタン表示確認

2026-11-25 JSTの本人報告。コミット `0d6f1c7462e2a30cda1ac15f09d1bb063bf07086`、Deployment `dpl_4yXJJZ3FMN12pUb6faL3mvYKS6wC`、接続先は専用Project `sqrbioyjhxoehbmacujf`。ログイン後のスマホ画面で担当者欄の「再割当」「解除」の見た目が改善されたことを確認した。今回の確認範囲はこの2ボタンの表示。[確認したPreview](https://acappella-tt-live-test-h89q0n42e-shunta-ohashi.vercel.app/)

修正が見えなかった時点では旧Preview URLを開いていたことを確認した。本人が提示したSupabase画面では新PreviewのRedirect URLが未登録だったため、新URLの追加と新しいMagic Linkでのログインを案内し、その後に表示改善の報告があった。設定の保存内容と正確な操作時刻は未確認。

## 今回の範囲外

- 匿名観客向けLive routeと公開opt-inの運用UI
- skip / cancel / 実時刻訂正 / 監査履歴
- Live記録の削除、保存期間、export
- Hostedでの負荷、長時間接続、background throttling実測

