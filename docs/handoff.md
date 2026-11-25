# acappella-TT 開発・運用準備の引き継ぎ

更新日：2026-11-26 JST。新しいチャットでは、本書と適用されるAGENTS.mdを読み、実際のブランチ・HEAD・差分を確認してから作業する。

## 1. この引き継ぎの根拠と現在地

根拠を次のように区別する。コードの存在は、そのコードの実行成功を意味しない。

- **[コード]**：今回、ローカルのコード・設定・Git記録を読み取って確認した内容。
- **[文書]**：既存runbookに残る過去の検証記録。実機操作の報告者やSQL確認者は元文書に従い、今回Codexが再実行したとは扱わない。
- **[保存結果]**：今回、指定されたローカル結果ファイルの判定項目を読み取って確認した内容。過去runの記録であり、現在のDB・Docker状態の再確認ではない。
- **[会話]**：このチャットの過去の報告・決定。今回コードや保存結果から独立に確認できない点を含む。
- **未確認**：今回取得していないもの。完了・不具合のいずれにも決めつけない。

| 項目 | 2026-11-25の主作業フォルダー同期後の確認結果 |
| --- | --- |
| 作業ディレクトリ | `%USERPROFILE%\acappella-TT` |
| ブランチ | `feature/live-tt-operator-ui` |
| HEAD・upstream | ともに `0d6f1c7462e2a30cda1ac15f09d1bb063bf07086` |
| 作業ツリー | 本書、Operator UI文書、deployment runbook、既存のHosted補助2ファイルのローカル変更あり。ステージ済み変更なし |
| 適用指示 | ユーザー提示のAGENTS.md指示と、同内容の `%USERPROFILE%\.codex\AGENTS.md` を確認 |
| プロジェクト側のAGENTS.md | 確認した祖先ディレクトリ、リポジトリルート、対象の `docs`／`scripts` には見つからなかった |
| PR #79の現在のGitHub状態・最新main・remote HEAD | 今回は照会していない。ローカルHEADと混同しない |

[コード] 以前の実機対象 `05e315286f8f9b85f1e9ddb6c32bba19d4b7f915` から同期前の `3bad931` までの3コミットは文書のみの変更。今回は11/17のスマホOwner記録の文書コミット `3c6389d` と、担当者ボタンのUI修正 `0d6f1c7` を取り込んだ。修正後のスマホ表示確認の範囲は第8節を参照。

[会話・文書] 2026-11-11時点のPR #79はOpen・Draft・未マージ。18レビュー会話はResolved、正式APPROVEDは0件と報告されていた。CI #60／Vercel成功は`3bad9316…`についての当時の報告であり、現在の必須チェック・保護ルール・マージ条件は未確認。Resolved、承認、チェック成功、マージ可否、Production公開可否は別々に判断する。

11/25の更新では本人のHosted smoke成功と既報の読み取り結果を記録し、本番Live導入の既存条件を整理した。Codexはこの更新でHosted smoke・SQL・本番照会を実施していない。

## 2. アプリの目的と開発目標

[コード・文書] アカペラライブのTT作成と当日運営を支援するReact／TypeScript／Viteアプリ。Event・開催日・Stage・Section・Performance／Break、Member／Band、PA／Duty、出演順・固定制約、自動生成、最終チェック、CSV／XLSX／JSON、静的事前共有を扱う。

[会話] 2026年学祭を背景に、Live TTを優先して進めた。PR #77は公開環境基盤、PR #78はLive backend、PR #79は認証済み運営画面。本番Live基盤導入前の復旧検証に必要なACL証拠は方法A v3.2で取得・照合した。元バックアップが表す `PUBLIC` 向け `USAGE` は旧ローカル復元で失われていた。補完を追加した別版の新規隔離runは対象ACLと厳密なSQL往復比較が一致し、既知の基盤差を伴う限定復元に合格した。厳密な基盤同等性は未達で、本番反映は停止中。PR #80予定の匿名閲覧等を先行実装しない。

参照先：

- [アプリ概要・開発](../README.md)
- [Cloud設定とDB契約](cloud-setup.md)
- [V1公開基盤](live-tt-deployment.md)
- [Live backend基盤](live-tt-state-foundation.md)
- [Live運営UI・検証履歴](live-tt-operator-ui.md)
- [V2 preflight／inspection／Atomic Cutover](cloud-v2-cutover-preflight.md)
- [migration履歴診断](cloud-event-migration-history-repair.md)
- [使い捨てDB用SQL fixtureの説明](../supabase/tests/README.md)

## 3. 確定している設計・変更しない境界

### 通常TT・Cloud・共有

- 通常Appは引き続き**Cloud Snapshot V1**。ブラウザ編集状態のPersistence V5、local-onlyを維持する。明示的なCloud保存でEventを保存し、通常TTの共同編集・自動Cloud保存とLive同期を混同しない。
- V2のMaster／backfill／inspection／Atomic Cutoverはbackend基盤として存在するが、AppのV2 hydrate／saveへ切り替えていない。migrationの存在・適用だけでbackfill、cutover、Workspace `ready`切替が実行されたとは扱わない。
- `#share=...`は認証不要の静的スナップショット。`#live=<Event ID>`はCloud認証済み運営画面。Live直リンクをlocal-onlyへフォールバックさせない。
- Vercelでは`VITE_CLOUD_REQUIRED=true`、URLとPublishable Keyの両方、安全なremote HTTPS originを要求。不正・不足時はfail closed。server keyをVITE変数やブラウザへ渡さない。

### Live投影・進行・権限

- 保存済みV1からbackendでLive投影を作り、独立した4テーブルに保存する。Live進行は元Snapshot・Cloud Event revision・Workspace generationを書き換えない。PA／Duty／Member等の個人情報をLive投影へ流用しない。
- Ownerは全Stageの進行と管理操作が可能。Editor／Viewerは明示割当されたStageに限り操作可能。割当時roleと現在role、認可epochの一致が必要。role変更・削除再追加後に古い割当を復活させない。
- `is_published`は**Live進行有効化**。匿名公開には別の`public_view_enabled`が必要で、既定false。現在のUIには匿名公開を有効にする機能を追加していない。
- UIでの新規投影はOwnerによる`create`だけ。未保存の通常TT編集は含めず、通常TTからLiveへの自動追随・UIでの再投影は未実装。Liveが残るEventの削除はFKで拒否する。削除・保管期間・exportは後続課題。
- EdgeはJWTから本人を確定し、backend RPCがOwner・Event・revision・digestを再検証する。ブラウザからSnapshot本文や信頼済みactor IDを受け取る設計にはしない。

### 同期・競合・結果不明

- 正式状態は認可付きreadのみ。Realtimeは7列の通知に限定し、再取得のきっかけとして使う。通知値を直接CAS・権限判定・状態更新に使用しない。
- Liveのsource revision／management revision／Stage revision等は正確なbigint文字列で扱う。安全な旧numberは正規化し、不正確なnumberはCASへ使わない。Realtimeの丸められたnumberを通知として受ける例外とは区別する。
- 正常時の補助readは30秒、45秒以上未同期ならstale。認可read待機10秒、mutation待機30秒。失敗時はbounded retry、非表示時は定期poll停止、復帰時に再取得する。SUBSCRIBEDだけで鮮度保証しない。
- mutationを自動再送しない。結果不明時はscope・Live・read sequenceと対象状態を確認してreconcileする。担当変更はmanagement revisionの前進と対象Stage／User／assignedAt等で確認し、他Stageの後続変更だけで永久停止させない。
- 通常AppをLiveの背後に保持する場合はdraft／Undo・Redoを保護し、非active時はdialog／Portal等を休止する。保存・削除・結果不明中のnavigation／account操作をguardする。

## 4. 実装の入口と既存テスト

以下は[コード]で確認した入口。テスト名の存在を、今回の実行成功とは扱わない。

| 領域 | 主なファイル・関数 |
| --- | --- |
| 起動・route・編集画面保持 | `src/main.tsx`、`src/appStartup.ts`、`src/cloud/CloudRouteApp.tsx`、`src/live/liveTimetableRouting.ts` |
| Cloud設定／認証／V1保存読込削除 | `src/cloud/cloudConfig.ts`、`CloudAppGate.tsx`、`cloudEventRepository.ts`、`cloudEventSaveEndpoint.ts`、`supabase/functions/save-cloud-event/index.ts` |
| Snapshot／Persistence／timeline | `src/cloud/cloudEventSnapshot.ts`、`src/persistence/localPersistence.ts`、`src/domain/timeline.ts`の`calculateStageTimeline()` |
| Live投影・server本人確認 | `src/live/liveTimetableProjection.ts`、`liveTimetableProjectionEndpoint.ts`、`supabase/functions/create-live-timetable/index.ts` |
| Live DTO／API／source revision | `src/live/liveTimetableRepository.ts`、`liveTimetableSourceRevision.ts`。#16の`*_serialized` RPCがJSON境界のbigint精度を維持 |
| UI・同期・結果不明 | `src/components/LiveTimetableOperatorPage.tsx`／CSS、`src/live/liveTimetableSync.ts`の`canRunLiveMutation()`、`isLiveOperatorMutationReconciled()`等 |
| DB定義 | `supabase/migrations/20261019154519_live_timetable_state_foundation.sql`（#15）、`20261021050414_live_timetable_operator_ui.sql`（#16） |
| Node回帰テスト | `tests/liveTimetableFoundation.test.mjs`、`liveTimetableOperatorUi.test.mjs`、`cloudConfig.test.mjs`、`deploymentConfig.test.mjs`等 |
| 実通信smoke | `scripts/liveTimetableFoundationHttpRealtimeSmoke.mjs`。API 56121／DB 56122の専用使い捨て環境限定 |
| DB fixture／catalog | `supabase/tests/live_timetable_state_foundation*.sql`、`cloud_event_migration_history_preflight.sql`、`cloud_event_migration_history_catalog_regression.sql`、`scripts/cloudEventMigrationCatalogRegression.mjs` |

リポジトリには16 migrationが存在する。DBごとの適用状況とは別。通常Cloud V1 gatewayは`load_cloud_events_page_authorized`、`save-cloud-event`、`delete_cloud_event_authorized`を使用する。

[コード] Nodeは`package.json`で24.x、CIはNode 24／pnpm 10、Denoは2.9.7。CIはNode tests／typecheck／lint／buildと4 Edge FunctionのDeno checkを定義。実PostgreSQL／実HTTP smokeは通常CIに含まれない。`vercel.json`にはViteのbuild設定があるが、Vercel管理画面のProduction Branch・自動配備先をそれだけで断定しない。

## 5. 過去の検証実績と、その限界

### アプリ・Live運営画面

| 日付・根拠 | 対象・環境 | 記録された範囲と限界 |
| --- | --- | --- |
| 2026-10-28 [文書] | 当時の作業ツリー、独立したローカルSupabase 2環境、PG 17.11、全16 migration | 未割当Viewerのstart／end直接HTTPがACCESS_DENIED、拒否前後不変、割当Viewer成功、Realtime、Cloud Event非変更、Auth／DB cleanup。正確なコミットは当該記録から確定しない |
| 2026-10-28 [文書：ユーザー報告] | 専用Hosted Project `sqrbioyjhxoehbmacujf` | 全16 migration・2 Functions、Owner／Viewerログイン、保存・Live作成・担当・進行・同期・復帰。Codexによる今回の再検証ではない |
| 2026-11-11 PC [文書：ユーザー実機報告／ChatGPT既存SQL] | アプリ`05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`、Vercel Preview、同専用Hosted | Owner／Viewer進行・取消再割当・自動反映・管理ボタンOffline・短時間タブ復帰。旧Eventのmanagement revision=16、Stage revision=5 |
| 同日スマホ閲覧 [文書] | 同アプリ、Pixel 11／Chromeシークレット／Viewer、eduroam・meijo成功報告 | 閲覧・自動反映・約1分のロック／通信断復帰。14:21:26 JSTの既存SQL：旧Event management revision=28、Stage revision=5。全項目×両SSIDの網羅検証ではない |
| 同日スマホ操作 [文書] | 同アプリ、別の新Event、明示割当Viewer。操作試験時SSIDは未確認 | 開始・終了タッチ、B開始前のOffline抑止、担当取消中の終了不可、再割当後終了、再読込保持。15:15:12 JSTの既存SQL：新Event management revision=7、Stage revision=5。終了記録保持、Live進行・匿名公開OFF、担当0件 |
| 2026-11-17 スマホOwner [文書] | 同専用Hosted、別の検証Event | Ownerの開始・終了、進行中の終了ボタンのOffline抑止、復帰後の操作・記録保持。対象と限界は [Operator UIの11/17記録](live-tt-operator-ui.md#スマートフォンowner操作終了offline検証記録2026-11-17)。 |

3つのmanagement revision値は別時点・別Eventの値。置き換えない。画面の自動反映はRealtime単独の遅延計測ではなく、匿名公開OFFの保存状態も匿名アクセス拒否の実測ではない。

実機で残る範囲は、送信途中切断・結果不明・重複送信、同時操作CAS、直接RPC拒否、Editor／Workspace外ユーザー、長時間・負荷・タブ破棄・Wi-Fiローミング等。個別の自動／使い捨てDB試験と実機の証拠は別に記録する。詳細はoperator runbookに保持する。

### 本番導入前の調査・接続診断

- [会話] 本番扱いの対象は`pvtfydeptpwkvgxybupe`。当時のメタデータ確認で履歴先頭14件一致、既存`save-cloud-event` v2・JWT検証有効、#15／#16と`create-live-timetable`は未反映。**現在状態は今回照会していない**。
- [会話] CLI 2.120.0の起動は成功したが、`migration list`は`Initialising login role...`以降で中断し、dry-run未実施。14件の履歴取得はSupabase MCP経由であり、停止したCLIが取得したものではない。
- [会話] CLI接続準備には一時login role作成・network ban解除が入り得る。前回それらが実行されたかは未確認。「本番は一切変更されなかった」「DB接続前に停止した」と断定しない。read-only意図やdry-runという名称だけで接続準備の副作用を否定しない。
- [会話] 直接DBはAなし・AAAAあり。poolerの複数IPv4はCodex実行経路でTCP timeout。ユーザーの通常PowerShellは同一IPでTCP_OK、一方、同じ接続APIに揃えたCodex比較試験は待機timeoutで診断例外なし。経路・実効制限の違いは未確定。大学側の意図的遮断、CLI正常化、DB認証可否を断定しない。
- 以上を理由にCLI再試行・権限緩和・本番適用へ自動的に進まない。本番・検証Project・Vercel・既存ローカルアプリは別対象として保護する。

## 6. 復元検証の履歴と現在地

以下はアプリリポジトリとは別の、Git外のローカル証拠・補助コード。生ログ、SQL／関数本文、実データ、認証情報をGitや会話へ転記しない。

### 旧runの実復元結果 [保存結果]

```text
%LOCALAPPDATA%\acappella-tt-local-restore-20261119T145212Z-f27a65b6
```

今回`result.local.json`／`verification-checks.local.json`を読んで確認した記録：

- runner版：`CATALOG_ACL_VERIFICATION_V1`。契約：`APP_STRUCTURAL_WITH_DECLARED_PLATFORM_DRIFT_V1`。
- 元DB／ローカルDB PG 17.11、抽出・dumpクライアント17.12という過去の調査結果。[会話]
- 実復元・参照schema復元とも終了コード0。public 12件＋history 1件のTABLE DATAを復元し、全行数照合true。**12はテーブルデータ項目数で、行数ではない**。
- catalogは全12比較グループ一致。一方SQL roundtripは247文対248文でMISMATCH。
- `STOPPED_AT=VERIFY_ARCHIVE_SCHEMA_ROUNDTRIP`、`BLOCKER=ARCHIVE_SCHEMA_ROUNDTRIP_REQUIRES_REVIEW`。
- `APP_ARCHIVE_STRUCTURAL_RESTORE_ON_LOCAL_BASELINE=INCOMPLETE`。schema／owner・ACL・default privileges／RLSの3項目もINCOMPLETE。独立した3件の不一致ではなく、roundtrip不一致による降格。
- `APP_SCOPE_STRUCTURAL_RESTORE_WITH_AUTH_ID_FIXTURES=BLOCKED_BY_PLATFORM_BASELINE`は別の厳密な基盤同等性の判定。ロール・所属・拡張・外部関数メタデータの既知4領域に差があるためで、限定契約の復元結果と分ける。
- run終了時の新設コンテナ停止・volume保持、元バックアップと依存情報の実行後ハッシュ一致が記録されている。現在のDocker状態は今回再確認していない。
- Auth IDだけのfixtureを使う限定復元。Authログイン回復、Supabase全体復旧、全データ値完全一致、本番導入許可は証明しない。

### ACL差の調査結果と採用方法

[会話：前回までの保存証拠・公式ソース調査] 唯一の正規化SQL差は、再dump側にpublicのPUBLIC向けUSAGE取消しが1文増えること。publicを新規作成し、owner変更、4ロールへのUSAGE付与という順序がある。pg_dump 17.12のpublic用基準ACLの合成で追加文を説明可能だが、その位置で冗長かの判定は**C：証拠不足**。globalスキーマ用既定権限の内容・不存在とDDLトリガーの影響が必要。既存4領域の許容差へ便乗させず、文字列MISMATCHを消さない。

既存runnerの所在（読取り参照先。起動しない）：

```text
%USERPROFILE%\Downloads\acappella-tt-restore-catalog-acl-799dd077efee4bfb8d569a65caaa586b\run-local-restore.cjs
```

実行時ソースのハッシュがなく、現在のコードと当時のバイト単位の同一性は未証明。この制約は新しいpinで遡及解消しない。

[会話・今回のファイル確認] 採用済みの**方法A**用パッケージ：

```text
%LOCALAPPDATA%\acappella-tt-acl-evidence-20261120-a17f39c8
```

- `README.txt`、`collect-acl-evidence.cjs`、`evidence-core.cjs`、`test-evidence.cjs`、`package-pins.json`が存在。
- 今回、17ファイルのpinを保存ファイルから照合し、変更0・欠落0。これはファイル整合性の確認であって実取得成功ではない。
- 前回の報告では合成テスト70件、構文、単一read-only snapshotへのSQL組立て、計画表示はPASS。**今回は再実行していない**。実際の複製起動・SQL取得は前回未実行。今回も`acappella-tt-acl-clone-*`の結果フォルダは見つからず、取得成功の証拠は確認できていない。
- 計画表示が既定。明示指定時だけ、停止元volumeをread-onlyに扱うcopy helper、新規data volume、隔離した複製DBを作る。元コンテナを起動しない。外部配置・設定include等で安全性を確認できなければ停止する。archiveの読取り・再復元・追加ダウンロードへ切り替えない。
- 保存hashは全global既定権限行を含む。イベントトリガー行のhashに加え、保存された関数本文等とも比較する。元の全pg_proc hashは復元後のpublic関数追加があるため、都合よく削って照合しない。
- SQLは単一`REPEATABLE READ READ ONLY`。ただし、複製DBの起動・checkpointは**新規コピー側**へ内部書込みを伴う。SQL read-onlyと、コンテナ・ディスク無変更を混同しない。
- 終了時は今回新設したコンテナだけを停止し、volumeと非公開証拠を保持する。`EVIDENCE_MATCH`は証拠取得・結び付けの成功であり、ACL冗長性・復元PASSではない。

### 方法Aの実行結果（2026-11-21 JST）

[今回の実行] 既存READMEを読み、Windows管理者権限を使用せずに `--plan`（終了コード0）を確認してから、`--collect-clone-evidence`を1回実行した。

- 終了コード **2**。`STATUS=BLOCKED`、`STOPPED_AT=COPY_READ_ONLY_SOURCE`、`BLOCKER=SOURCE_LAYOUT_OR_COPY_CHECK_FAILED`。コピー工程の最初の停止条件は下記の読み取り調査で特定した。
- 共有用サマリーでは、元コンテナの起動なし、元volumeのread-onlyマウント、新設コンテナの停止、コピー用volumeの保持を確認できた。作成が未確認のコンテナ・volumeはない。コピーの完全性は確認されていない。
- 複製DBの起動工程に進まず、SQLは `NOT_RUN`。既定権限・イベントトリガーの保存ハッシュ、関数snapshot、最終public ACLとの照合はすべて `NOT_CHECKED`。今回の不足ACL証拠の取得は未完了。
- SQL往復比較は247文対248文の `MISMATCH` を維持。冗長性は判定C（証拠不足）で、今回のサマリーも `ACL_REDUNDANCY=NOT_EVALUATED`。再復元、アーカイブ読取り、本番接続はいずれも0件。

保存先の共有用サマリー `summary.txt` の存在を確認した。非公開結果の内容は転記しない。

```text
%LOCALAPPDATA%\acappella-tt-acl-clone-20261120T163554726Z-baabcb37
```

#### 停止原因の読み取り調査

- `SOURCE_LAYOUT_OR_COPY_CHECK_FAILED` は、コピー補助コンテナの終了値が `0` 以外のときにrunnerが返す共通エラー。保存済みのコマンド記録では、`container wait` 自体は終了コード `0` で成功し、コピー補助の終了値は **`41`** だった。収集runner全体の終了コードは `2`。
- `41` は、イメージ内の `/etc/postgresql/postgresql.conf` に `include`・`include_dir`・`include_if_exists` のいずれかに該当する行が見つかったときの明示的な停止値。期待条件は、この検査に一致する行がないこと。保存値とコードの順序から、直前の外部設定2ファイルのSHA-256照合は通過し、データディレクトリの検査やファイルコピーより前にinclude検査で停止したと判断できる。
- この実行のマニフェストに保存された17件のpin一覧は現行パッケージの一覧と一致し、現行の `collect-acl-evidence.cjs`、`evidence-core.cjs`、`README.txt` のSHA-256は実行時マニフェストの各pinと一致した。生成されたコピー用シェルスクリプトには独立した保存ハッシュがなく、対応はrunnerのpin・生成順序・保存された終了値に基づく。旧復元runnerの実行時ソースは引き続き未証明。
- 未確定なのは、一致したディレクティブの種類、参照先の有無・配置、設定への実際の影響。保存記録には一致行や参照先がないため、外部設定が不正、または元volumeに異常があるとは判断できない。

今回の調査は保存済み記録とコードの読み取りのみ。新たなコピー・SQL・照合は行っておらず、`BLOCKED`、SQL往復比較の `MISMATCH`、冗長性の判定C（証拠不足）は維持する。

#### 固定イメージのinclude調査（2026-11-22 JST）

- 実行マニフェストのimage IDとローカルのimage IDが一致した。そのIDを指定した `docker image save` からイメージのファイル配置を読み取った。書き出し側の設定JSONのSHA-256はimage IDと一致しなかったため、その値は同一性の根拠に使っていない。ローカルイメージと書き出しの順序付きレイヤー一覧（29件）が一致し、`postgresql.conf` と `pg_hba.conf` のSHA-256も保存済みの外部設定ハッシュと一致した。
- 停止検査に一致したのは、コメントではない構文上有効な `include` 4行と `include_dir` 1行。`include_if_exists` は0行。すべて絶対パスで、相対パスの解決は不要だった。直接の参照先はイメージ内で通常ファイル4件とディレクトリ1件。ディレクトリ直下の読み込み対象は `.conf` 通常ファイル5件で、Cロケール順に記録した。今回確認した参照パスと対象ファイルにリンクはなかった。
- 確認範囲は固定イメージ内の設定と直接参照先まで。元DBで実際に選ばれた設定、実行時のマウントや上書きの影響、参照先からの追加includeは未確認。調査用のDockerコンテナ・volumeの新設は0件。元のコンテナと各volumeは使用せず、DB起動・コピー再試行・SQL実行も行っていない。

一致行・行番号・参照先・一覧は次のアクセス制限付き非公開記録に保存し、読み戻して確認した。書き出し用の一時アーカイブは片付けた。

```text
%LOCALAPPDATA%\acappella-tt-image-include-20261121T155808Z-122d6f5a\image-include-details.private.json
```

方法Aは `BLOCKED` のまま。SQL往復比較の `MISMATCH` と冗長性の判定C（証拠不足）にも変更はない。

#### 固定イメージのinclude参照関係とdigest調査（2026-11-22 JST）

- `postgresql.conf` を起点に固定イメージ内だけを静的に追跡した。`include` 4件と `include_dir` 1件（直下 `.conf` 5件）の先に追加のinclude系指定はなかった。起点を含めて10ファイル・読み込み順10回。重複読み込み、欠落、循環、リンク、解決不能な参照はいずれも0件。各ファイルのSHA-256、参照行・辺・読み込み順を非公開記録に保存した。
- 前回の一時書き出しは削除済み。前回の読み取りコードで、書き出しの `manifest.json` が指す構成JSONの生バイトをSHA-256に掛けていたことを確認した。JSONの加工・再保存は介在していなかった。比較相手のDockerの `Id` は、この環境ではOCIイメージインデックスのdigest。前回の不一致は、インデックスと構成JSONという異なるオブジェクトのdigestを比較した結果だった。
- 今回の同一IDでの再書き出しでは、保存済みIDと同じdigestのOCIインデックスblob、そこから選ばれたプラットフォームmanifest、およびmanifestが指す構成JSONの生バイトを照合した。アーカイブの外側の `index.json` は固定IDのインデックスblobとは別。非圧縮レイヤー29件のSHA-256は順番も含めて `RootFS.Layers` のDiffIDと一致し、既知の外部設定2ファイルも保存済みハッシュと一致した。固定イメージのファイル配置と構成JSONの対応まで確認し、実行時の起動引数・環境・設定上書きの同等性は評価していない。
- 方法Aの停止元について、前回保存したinspect出力3件では停止状態と同じ2マウント先が記録され、今回の設定パスとの重なりはなかった。この記録は実際に起動したDBが選んだ設定や、起動時の変更・上書きまでは示さない。今回は元コンテナ・volumeを使用せず、DB起動・SQL・コピー再実行は行っていない。

非公開記録（参照関係・ハッシュは `image-include-graph.private.json`、保存済みマウント照合は `saved-source-mount-scope.private.json`）。アクセス制限と記録を読み戻して確認し、一時書き出しは削除した。

```text
%LOCALAPPDATA%\acappella-tt-image-include-graph-20261121T161610Z-039d9d40
```

方法Aは `BLOCKED`。SQL往復比較の `MISMATCH`、冗長性の判定C（証拠不足）、不足ACL証拠の取得未完了は維持する。

#### 方法Aのinclude対応修正版（2026-11-22 JST）

- 旧版の2026-11-21実行は `BLOCKED`（コピー補助の終了値41）のまま。修正版 `METHOD_A_FIXED_INCLUDE_OFFLINE_V2` は別ディレクトリに作成し、**この版の作成時点ではオフライン検証のみ完了**。翌日の実行結果は下記を参照。旧パッケージと保存記録は変更していない。
- `fixed-include.private.json` の期待値は、上記include参照関係・マウント照合記録、前回の方法Aマニフェスト、旧復元の外部設定ハッシュに固定した。コピー前にOCIインデックス、`linux/amd64` のmanifest、構成JSONをそれぞれ生バイトのSHA-256で照合し、10設定ファイルのハッシュ、include順、`include_dir` の対象一覧、HBAハッシュを確認する。起点と参照先の完全一致で参照の追加・欠落を拒否し、対象と親ディレクトリのリンクも拒否する。実行対象から期待値を更新する経路はない。
- 旧版の確認範囲は元資源のID・停止状態・既知マウントと、コピー工程の配置・ハッシュ検査までで、コンテナの起動引数・環境変数は未照合だった。修正版はハッシュで確認したイメージ既定値に対し、旧runnerコードから読み取った元側の既知の起動指定と、新設側の固定argv・実行ユーザー・環境を照合する。設定パスを覆う親マウント、未知の指定、データ側の有効な `postgresql.auto.conf` や復旧シグナルは停止条件。旧元コンテナの初期化用秘密値は存在だけを確認し、記録・転用しない。
- 旧版の元資源保護、隔離、停止確認、コピー前後のバイト・メタデータ照合、読み取り専用SQLと結果照合は維持した。版の作成時点では、実対象のOCI照合、停止元・新設側の起動仕様、マウントとデータ側の検査は未実行。旧DBの実効設定全体と旧復元runnerの実行時ソースは引き続き未証明。
- 構文確認3件、旧合成テスト70件、include・起動条件の回帰テスト8件、OCI生バイト照合の合成テスト5件、Docker非使用の `--plan`（終了コード0）はすべて成功。固定対象30件を照合し、旧版の17件も変化なし。実コピー、DB起動、SQL、Docker資源作成・変更は行っていない。

修正版（アクセス制限付き）。変更箇所・参照記録は `README.txt`、検証結果は `offline-validation.txt`、固定一覧は `package-pins.json` に記録した。

```text
%LOCALAPPDATA%\acappella-tt-acl-evidence-fixed-include-v2-20261122
```

`package-pins.json` のSHA-256は `315d351dc9b51ae1f6fa729126b81c50301a572b040e49aad3739e5b1582d956`。SQL往復比較は `MISMATCH`、冗長性は判定C（証拠不足）のまま。

#### 方法A v2の実行結果（2026-11-23 JST）

- `METHOD_A_FIXED_INCLUDE_OFFLINE_V2` の固定一覧のSHA-256を確認し、READMEの `--collect-clone-evidence` を1回実行した。終了コード **2**、`STATUS=BLOCKED`、`STOPPED_AT=VERIFY_STOPPED_SOURCE_STARTUP`、`BLOCKER=RUNTIME_OPTIONS_UNCONFIRMED`。固定イメージと構成JSONの照合工程を通過し、停止元コンテナのランタイム設定の検査で停止した。どの個別の条件が一致しなかったかは今回未確認。
- 今回の新しい非公開結果フォルダーに保存された `summary.txt` は、実行時の共有用サマリーと一致した。元コンテナを起動せず、元volumeのマウント工程にも到達していない。新設コンテナ・複製volumeとも `NOT_CREATED` で停止対象なし。結果フォルダーのアクセス制限と、旧版の結果フォルダーの保持を確認した。
- 複製DB・SQL・保存済みハッシュおよび関数snapshotとの照合は未実施で、不足ACL証拠は未取得。旧版の終了値41による `BLOCKED` とは別の実行記録。SQL往復比較は `MISMATCH`、冗長性は判定C（証拠不足）のまま。

```text
%LOCALAPPDATA%\acappella-tt-acl-clone-20261123T001557705Z-787d7ac3
```

#### v2の停止条件の読み取り調査（2026-11-23 JST）

- v2の実行マニフェストと現在のrunner・検査コードのハッシュは一致した。停止条件は `Config` と `HostConfig` が存在し、`Init` が `null` または `false`、`Privileged=false`、`Runtime=runc` であること。実行時のinspect出力は意図的に伏せられており、当時の個別値は保存されていない。
- 同じ固定ID・イメージのコンテナが停止中であることを確認し、該当項目だけを読み取った。現在は両設定オブジェクトが存在し、`Privileged=false` と `Runtime=runc` は一致する。唯一不一致の `Init` はキー自体が省略されており、JavaScriptでは `undefined` になる。この値はv2の条件を通らず、保存された停止を説明できる。当時も同じ表現だったかは未確認。
- Dockerではコンテナ側のinit指定が省略された場合にデーモン既定が使われ得る。省略を `false` と同一視しない。同じ停止元IDの旧復元記録には、準備完了時のPID 1がPostgreSQL本体だった観測が2件あり、保存された観測のオフライン再解析でも一致した。この裏付けは旧復元時の観測に限り、現在のデーモン既定や、観測後に再起動がなかったことは未確認。旧runnerの実行時ソースも引き続き未証明。
- v2は `BLOCKED` のまま。パッケージ・実行記録・Docker資源は変更せず、再試行・DB起動・SQLは行っていない。

#### Init判定の限定レビュー（2026-11-23 JST）

- v2は `Init` を起動前に検査し、Dockerのinitラッパーによって最初のプロセスが変わる条件を排除しようとしている。現在の停止元のキー省略で拒否は再現するが、v2実行時の個別値は未保存で、当時の直接原因は確定していない。今後は `null` とキー省略を「未指定」に分類し、明示的な `false` と区別する。
- 旧復元の実対象記録、v2マニフェスト、現在の読み取り専用inspectで完全なコンテナIDとイメージが一致し、現在は停止状態。現在のPIDモードはコンテナ既定のprivate。旧コードは対象IDに `docker container exec` し、コンテナ内の `/proc/1` とpostmaster PIDファイルを読んでいる。旧コードはホストPIDモードを拒否するが、観測と同時点のPIDモードを値として保存していない。準備完了時のPID 1がPostgreSQLだった観測2件は、旧復元時の観測として扱う。
- 現在のDocker最終 `State.StartedAt` は2026-11-19 23:52:39.032948461 JST。旧記録のPostgreSQL起動は23:52:47.330064、PID 1観測は23:52:51.657と23:52:56.434で時系列は整合する。ただし、旧復元とv2の保存JSONには、観測に対応するDockerの `State.StartedAt` が見つからない。観測時刻やPostgreSQLの起動時刻をDockerの起動時刻の代わりに使えず、現在の最終起動と同一だったことは未証明。RestartCount、イベントの不在、現在のデーモン既定で過去状態を補わない。
- 設計案では、停止元の `true` と不正型を拒否し、明示 `false` はInit条件を満たす。未指定は、完全なID・同一起動回の `StartedAt`・対象PID名前空間を結び付けられる保存済みのPID 1観測がある場合だけ許可候補とする。新設側は `--init=false` を明示し、起動前のinspectで明示 `false` とprivate PIDモードを確認する。この制御は停止元の過去状態の証拠には使わない。
- 将来の非公開診断には各検査の結果・理由を記録し、Initはキー有無、`false`／`true`／`null`／`omitted`／`invalid_type` を区別して保存する。回帰テスト案はこれらの値の区別、完全ID・起動時刻が合う場合と異なる場合、証拠欠落を対象にする。今回は根拠不足のためv3は作成せず、修正・回帰テスト・再試行は未実施。v2は `BLOCKED` のまま。

#### 方法A v3のInit分離（2026-11-23 JST）

過去のPID 1観測とDockerの最終起動の対応は証拠不足のまま調査を区切った。以下のコードレビューの結果、元Initと過去のPID 1を安全性の判定材料に使う必要はなかった。v2は当時の個別原因が未確定のまま `BLOCKED` で、旧版と実行記録を保持する。

| 判断 | 保証に使う条件 |
| --- | --- |
| データと設定の選択 | 固定マウント先、`PGDATA` と設定指定、固定イメージ・設定ハッシュ、データ配置と有効な上書きの検査。安全なコピー対象を選ぶ。 |
| 元資源の特定と扱い | 完全ID・イメージ・run label・停止状態・volume識別と未使用を照合。元コンテナはinspectだけで、元volumeをコピー補助にread-onlyで接続する。 |
| コピーと複製の制御 | PostgreSQLの正常停止、コピー前後のファイルとメタデータの一致、新設資源のID・ラベル・隔離、固定 `exec postgres` とreadiness。停止処理も新設IDだけを扱う。実行中のPID 1を直接観測する処理はない。 |
| SQLと保存証拠への対応 | 新設サーバーID、固定Unix socket・DB・ロール、read-only transaction、system identifier等の既存照合で取得先と結果を結び付ける。 |

`METHOD_A_OBSERVED_SOURCE_INIT_V3` では、停止元のInitは全状態を観測としてのみ記録する。省略と `null` は `UNSPECIFIED` で、キー有無と値の種別を別々に記録する。明示 `false`、`true`、不正型も元Init単独では合否に使わず、既存の権限・ランタイム・マウント・設定の条件は保持する。新設側は `--init=false` とDockerのprivate指定 `--pid=` を明示し、起動前に `Init=false` と `PidMode=""` を要求する。起動検査の結果と拒否理由は非公開ファイルに残し、設定値・認証情報は転記しない。

構文3件、既存合成70件、include・起動条件11件（v3追加3件）、OCI合成5件、`--plan`（終了コード0）が成功。固定入力40件および元資源・コピー・SQL・停止処理の既存部分を照合した。この版の準備時点ではオフライン検証のみ実施。実取得の試行結果は下記を参照。

修正版はアクセス制限付きの次の場所。判断理由は `README.txt`、検証結果は `offline-validation.txt` に記録した。

```text
%LOCALAPPDATA%\acappella-tt-acl-evidence-isolated-init-v3-20261123
```

`package-pins.json` のSHA-256は `18636bb0c9502b9f792edf3c42aeef852accf576c49e7edcaede4fb4384a3fd6`。

#### 方法A v3の実行結果（2026-11-23 JST）

- 固定一覧のSHA-256を確認し、v3の `--collect-clone-evidence` を変更・再試行なしで1回実行した。runner終了コード **2**、`STATUS=BLOCKED`、`STOPPED_AT=COPY_READ_ONLY_SOURCE`、`BLOCKER=PINNED_INCLUDE_DIRECTORY_MISMATCH`。v2の停止元起動検査での `BLOCKED` とは別の実行結果。
- 今回の個別診断では停止元の起動メタデータ検査が成功し、元Initのキー省略は `UNSPECIFIED` の観測として記録された。新設コピー補助の `Init=false` とprivate PIDモードも起動前に照合済み。過去の元コンテナの起動状態は引き続き証拠不足。
- 保存した待機結果と今回のコピー補助の正確なIDのinspectで、終了値 **53** と停止を確認した。コード上は固定 `include_dir` 一覧の列挙・整列・期待一覧の書き出し・比較のいずれかを通過できなかったことを示す。保存記録に個別工程の識別がなく、一覧の差や、どのコマンドが失敗したかは未確定。ファイルコピーより前で停止し、複製DBの作成・起動、SQL実行、ハッシュ・関数snapshot照合は未実施。
- 元コンテナが停止中で、コピー補助への元volume接続がread-onlyだったこと、新設コピー補助が停止し今回の新規volumeが保持されていることを確認した。新規volumeの内容は未確認。共有用サマリーが保存内容と一致し、旧結果と今回の非公開結果も保持されている。ACL証拠は未取得、SQL往復比較は `MISMATCH`、冗長性は判定C（証拠不足）のまま。

```text
%LOCALAPPDATA%\acappella-tt-acl-clone-20261123T004530977Z-7cc02823
```

#### v3の終了値53の調査とv3.1（2026-11-23 JST）

- v3の実行マニフェストに保存されたrunner・検査コード・固定一覧のハッシュは現行のv3と一致。保存したコピー補助スクリプトは、停止済みの補助コンテナの実行コマンドともバイト一致した。その保存ログの先頭で、BusyBox 1.37.0の `find` が `-printf` を拒否していた。最初に失敗したのは **列挙**。整列・期待一覧の書き出し・比較には到達しておらず、v3の実行時一覧が一致するかは未確認。以前に固定イメージから読み取った静的一覧は固定された5件と一致した。
- 別版 `METHOD_A_INCLUDE_DIRECTORY_PORTABLE_V3_1` では、同じ対象条件で `find -print0` を使い、実際と期待の両方を同じディレクトリ接頭辞付きのNUL区切りパスにしてCロケール順で照合する。終了値53は値の不一致だけに限定し、55～58で列挙・整列・期待一覧の書き出し・比較処理のエラーを区別する。差がある場合の一覧はサイズ上限付きで非公開記録に残し、診断の取得に失敗しても停止を維持する。
- 後段の同じ非対応オプションも置換した。コピー前後のメタデータはファイル種別・モード・UID/GID・ナノ秒付きmtimeを引き続き比較し、取得や形式確認に失敗した場合は停止する。ファイルSHA-256一覧も列挙・整列の失敗を隠さない。固定一覧・ハッシュ・読み込み順、元資源の保護、起動条件、SQL・照合・停止処理は維持した。
- Git Bashの合成入力で旧 `-printf` 拒否を模擬して終了値53を再現し、新方式の正常通過、実際の不一致と4つの処理エラーの区別、メタデータ差・取得失敗での停止を確認した。既存合成70件、include・起動条件等14件、OCI合成5件、構文3件、`--plan`（終了コード0）が成功。固定入力54件を照合済み。実イメージ上でのv3.1のツール動作、実コピー・ACL取得は未検証。
- v3の元パッケージ・実行記録は保持し、結果は `BLOCKED`。今回は既存の補助ログ・メタデータの読み取りだけで、Docker資源の変更、元volumeへのアクセス、再試行、DB起動、SQLは行っていない。ACL証拠は未取得、SQL往復比較は `MISMATCH`、冗長性は判定C（証拠不足）のまま。

修正版は次のアクセス制限付きフォルダー。原因の確認結果は `v3-exit53-review.private.json`、修正範囲は `README.txt`、検証結果は `offline-validation.txt` に記録した。

```text
%LOCALAPPDATA%\acappella-tt-acl-evidence-include-portable-v3.1-20261123
```

`package-pins.json` のSHA-256は `c53e7a0d2ac288274cd5221567a80e198744b826c23c2d776e6aad195536e0e6`。

#### 方法A v3.1の実行結果（2026-11-23 JST）

- 固定一覧のSHA-256を確認し、READMEの `--collect-clone-evidence` を変更・再試行なしで1回実行した。runner終了コード **2**、`STATUS=BLOCKED`、`STOPPED_AT=COPY_READ_ONLY_SOURCE`、`BLOCKER=SOURCE_LAYOUT_OR_COPY_CHECK_FAILED`。コピー補助の終了値は **1**。v3が終了値53で `include_dir` 列挙に失敗した記録とは別。
- 起動前の停止元とコピー補助の検査は成功。今回の停止済み補助の保存出力は、コピー前の元データと複製先のメタデータ一覧を比べたときの **不一致** を示す。I/Oエラーや一覧処理の失敗を示す記録ではない。実行コードの順序から、固定設定・`include_dir` 一覧、データ配置・正常停止、ファイルコピー、元と複製先双方の内容ハッシュ比較、コピー前後の元メタデータ比較まで通過した。複製先のどのパス・属性が異なったかは未確定。後続の制御情報比較・完了マーカー・複製DB作成には到達していない。
- 終了値1は専用診断の対象外で、追加の診断ファイルは生成されなかった。既定の共有サマリーと保存サマリーは一致。正確な新設IDのコピー補助が停止し、新設volumeが保持されていること、元コンテナが停止状態で、元volumeはコピー補助にread-onlyで接続されたことを確認した。旧結果も保持。
- 複製DB起動、読み取り専用SQL、保存済みハッシュ・関数スナップショット照合は未実施。ACL証拠は未取得、SQL往復比較は `MISMATCH`、冗長性は判定C（証拠不足）のまま。

```text
%LOCALAPPDATA%\acappella-tt-acl-clone-20261123T010646742Z-172bbf88
```

#### v3.1のメタデータ差の調査とv3.2（2026-11-23 JST）

- v3.1の実行時スクリプトを停止済み補助のコマンドと照合した。停止後、比較に使った一時ファイル `metadata-before` と `metadata-copy` は結果フォルダーにも停止済み補助の `/tmp` にもなく、取得できなかった。以下は同じ実行の固定元volumeと新規複製先volumeを、それぞれ読み取り専用で隔離helperに接続し、同じ属性採取処理で得た**現在の観測**。当時の比較用ファイルを復元したものではない。
- 対応する1,092件の差はすべて更新時刻の小数部だけで、複製先では0だった。内訳は通常ファイル1,065件、ディレクトリ26件、コピー先ルート1件。パスの欠落、種別、モード、数値UID/GID、更新時刻の秒部の差は各0件。相対パスで突き合わせた実属性の差で、表示や並べ順の差ではない。
- 固定イメージの同じシェルと `cp -a` を、volumeを接続せずtmpfs上の合成データで実行した。BusyBoxのコピーは3件すべてで時刻小数部を0にし、公開実装のふるまいとも一致した。同じイメージ内のGNU coreutils 9.8の `cp -a` は、ファイル・ディレクトリ・ルートの3件で必要な属性を保ち、同じ比較処理を通過した。コピー先のモードを意図的に変えた場合は比較で拒否した。今回新設した調査用・合成試験用helperの正確なIDと終了を非公開に記録した。
- 別版 `METHOD_A_NANOSECOND_COPY_V3_2` では、上記試験で確認したGNU `cp` の固定パスとバイナリのSHA-256をコピー直前に検査する。未確認・不一致は停止（61）。属性比較、固定一覧、読み取り専用接続、SQL・終了処理は維持する。回帰90件、構文3件、`--plan`（終了コード0）、固定入力72件の照合が成功。実データの再コピー・複製DB起動・SQLは未実施。実データでも同じ属性保持ができるかは次回の実取得で確認する。
- v3.1は `BLOCKED` のまま。ACL証拠は未取得、SQL往復比較は `MISMATCH`、追加REVOKEの冗長性は判定C（証拠不足）。元コンテナ・旧helperは再起動せず、既存volumeには書き込まず、旧パッケージと実行証拠を保持した。

```text
非公開比較・試験記録: %LOCALAPPDATA%\acappella-tt-metadata-review-20261123-3562542b
修正版v3.2: %LOCALAPPDATA%\acappella-tt-acl-evidence-nanosecond-v3.2-20261123
```

`package-pins.json` のSHA-256は `aad31d4bdd368786240e95a6ea56d7acd20f41b85c70a508a1782a9c28035a43`。

#### 方法A v3.2の実行結果（2026-11-24 JST）

- 固定一覧のSHA-256とREADMEを確認し、通常の非管理者PowerShellで `--collect-clone-evidence` を1回実行した。終了コード **0**、`STATUS=EVIDENCE_MATCH`、`STOPPED_AT=COMPLETE`、`BLOCKER=NONE`。v3.1はメタデータ比較の不一致による `BLOCKED` のまま。v3.1の1,092件の差は事後の読み取り観測であり、当時の比較入力やv3.2の件数には読み替えない。
- 固定GNU `cp` のパス・SHA-256検査を通過し、元volumeを読み取り専用で接続して新規volumeにコピーした。コピー前後の元ファイル内容・メタデータ・制御情報、元と複製先の内容ハッシュ・メタデータの全比較が成功。コピー補助の終了値0と完了マーカーを照合した。時刻の丸めや比較条件の変更はしていない。
- 隔離複製DBを起動し、単一の読み取り専用SQL snapshotで取得した。保存済み既定権限ハッシュ・イベントトリガーハッシュ・関数snapshotと一致し、グローバルスキーマ既定権限の対象行は0件、最終public ACLも一致。新しい非公開結果に証拠・照合記録を保持し、保存された共有サマリーとの一致を確認した。
- 元コンテナは停止状態のまま。今回新設のコピー補助と複製DBの2件は正確なIDで停止状態を再確認し、ともに終了値0。新規volume・旧実行結果も保持した。
- `EVIDENCE_MATCH` は方法Aの証拠取得と保存値との照合に限定する。SQL往復比較の `MISMATCH` と復元検証の判定は再評価していない。追加REVOKEの冗長性は判定C（証拠不足の既存判定を今回再評価せず）。旧元コンテナの実効設定や過去のPID 1も証明範囲外。再復元や本番接続は0件。

```text
%LOCALAPPDATA%\acappella-tt-acl-clone-20261123T190504323Z-00721294
```

#### 追加REVOKEの作用評価（2026-11-24 JST）

**結論：保存されたローカル再作成条件とSQLの実行位置では、PUBLIC向けUSAGE取消しは実効権限を変えず、その意味で冗長。** 生のカタログ表現は変わる。既存のCは「証拠不足」で、今回この限定的な実効権限の判断は証拠不足ではなくなった。確認できた既存文書・会話にはA/Bの原定義が見つからなかったため、文字ラベルは割り当てず結論を文章で記録する。

- **保存資料で確認した事実。** 旧復元フォルダーの `archive-schema.local.sql` と `restored-schema.local.sql` を既存の正規化処理で読み比べ、247文対248文の唯一の追加が再dump側4103行の `REVOKE USAGE ON SCHEMA public FROM PUBLIC;` だと確認した。実行順は再dump側26行でpublicを作成、29行で所有者を `pg_database_owner` に変更、4103行で当該REVOKE、4104～4107行で4ロールにUSAGEを付与。REVOKE以前にpublicスキーマへの直接GRANT/REVOKE、`ON SCHEMAS` の既定権限変更、ロール・replication role切替、イベントトリガー・拡張の追加変更は確認されなかった。
- **実行条件。** 両SQLのヘッダーはサーバー17.11・dumpクライアント17.12。旧runの `command-exit-metadata.local.json` は版検査・SQL出力・実復元の終了値0を記録し、現行の参照runnerは `pg_restore` 17.12のみを許可し、所有者とACLを有効にしたまま `--single-transaction --exit-on-error` で復元、再dumpは `--schema-only --schema=public --schema=supabase_migrations --strict-names` の条件。旧runの `public-schema-archive-replay-plan.local.json` と `result.local.json` はpublicの再作成と所有者変更各1件、SQL書き換え・選別なしを記録。復元直前の `actual-public-preparation-after.local.json` でpublic不存在、実行ロール `supabase_admin`（superuser）、`origin` を確認した。
- **既定権限とトリガー。** v3.2の `acl-details.private.json`、`current-inventory.private.json`、`binding-checks.private.json` を旧復元の `actual-public-preparation-before.local.json`／`after.local.json` と照合した。スキーマ用global既定権限行は全ロールで0件で、明示設定の不存在を示す。既定権限・イベントトリガーのハッシュとトリガー関数snapshotが一致。 `origin` で動作する関係トリガーのうち、`pgrst_ddl_watch` はスキーマ作成・所有者変更に対するDDL監視と通知だけで、GRANT/REVOKEは通知対象のタグにない。DROP・CREATE EXTENSION限定のトリガーは該当順序で権限付与経路にならず、DROP対応の通知は事前準備の範囲。関数本文は非公開の保存記録に保持する。
- **実装からの推論。** PostgreSQL 17.11では新規スキーマ作成時に作成者のスキーマ用global既定設定を読み、なければ組み込み既定（所有者にCREATE/USAGE、PUBLICに直接付与なし）を使う。既存の初期publicを削除して作り直すため、削除したpublicのPUBLIC向けUSAGEは引き継がれない。所有者変更は既定権限の再適用を行わず、NULLの `nspacl` はNULLのまま。追加REVOKEの直前と直後で、PUBLICの直接USAGEはなし、所有者のCREATE/USAGEは維持され、後続4ロールの付与はまだ行われていない。ただしREVOKEは、NULLを展開して組み込み既定と同値の明示ACLをカタログに書く。後続のGRANTはどちらの場合も明示ACLを作る。最終ACLの一致は補助証拠で、途中の判断は実行順と実装による。[17.11のスキーマ作成](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/catalog/pg_namespace.c#L62-L85)、[組み込み権限](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/utils/adt/acl.c#L800-L803)、[所有者変更](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/commands/schemacmds.c#L382-L397)、[ACL更新](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/catalog/aclchk.c#L2081-L2136)。
- **出力理由と残る制約。** pg_dump 17.12はpublicだけ、初期publicのPUBLIC向けUSAGEを含む基準ACLを所有者に合わせて合成し、実際のACLにその付与がない差をREVOKEとして出力する。この基準は今回のDROP後のCREATEの初期状態とは異なる。既存のPUBLIC向けUSAGEが残る別環境に同じ文を適用すれば権限は変わり得る。保存資料の静的評価であり、追加文を実行して採取した途中ACLではない。 `SOURCE_CODE_AS_AT_OLD_RUN=NOT_ATTESTED`、元バックアップ側で意図されたPUBLIC権限、旧run全体の同等性はこの評価の外。生SQLの `MISMATCH`、限定復元の `INCOMPLETE`、厳密基盤の `BLOCKED_BY_PLATFORM_BASELINE` を維持する。[17.12のpublic基準ACL](https://github.com/postgres/postgres/blob/REL_17_12/src/bin/pg_dump/pg_dump.c#L5360-L5393)。

#### 元バックアップと復元先の `PUBLIC` 向け `USAGE` の比較（2026-11-24 JST）

**結論。元バックアップが表す `PUBLIC` 向け `USAGE` は、旧ローカル復元先で保たれていない。** 復元準備で既存の `public` を削除し、アーカイブで再作成すると、元dumpが前提とする `PUBLIC` 付与が失われる。元SQLに含まれる個別付与は復元される。追加REVOKEの作用評価と、元バックアップに対する復元結果の権限比較は別の結論として記録する。

- **元資料の対応。** `%LOCALAPPDATA%\acappella-tt-prod-backup-20261116-221710-dc882269` の `manifest.json` と `app-and-history.dump`、`archive-list.txt`、`recovery-context.txt` の保存SHA-256は一致。アーカイブのSHA-256は旧復元の `run-manifest.local.json` とも一致した。保存TOCはCUSTOM形式、収録対象は `public` と `supabase_migrations` のスキーマ・データ。サーバーは PostgreSQL 17.11、作成クライアントは pg_dump 17.12（Debian 17.12-1.pgdg12+1）。元の作成コマンド全文は未確認。`recovery-context.txt` は別スナップショットの説明用資料で、後日の依存関係採取 `acappella-tt-restore-deps-20261119T010420Z-a5647220` の `dependency-context.local.json` と同様、元の `public.nspacl` の直接記録は見つからなかった。
- **ACL収録と抽出。** 保存TOCに `SCHEMA - public`（82）と `ACL - SCHEMA public`（4023）が各1件。`archive-schema.local.sql` の26行で `CREATE SCHEMA public`、29行で所有者を `pg_database_owner` に変更。対象ACLブロックは4100行から次ブロックの手前までで、`postgres`、`anon`、`authenticated`、`service_role` への `USAGE` 付与4文だけ。現行の参照runnerの `ORIGINAL_SCHEMA` は `pg_restore --exit-on-error --schema-only --file=-` を使用し、対象選別・`--use-list`・`--no-privileges`・`--no-owner` を付けない。既存のリスト選別は別のFK・データ等の抽出用。保存終了記録の17.12クライアント版検査・TOC・元SQL抽出は終了値0で、実復元の項目フィルターは `NONE`。pg_restore 17.12はACLをTOC項目単位で選別し、該当するスキーマACL項目のSQL定義全体を出力する。[ACL項目の選別](https://github.com/postgres/postgres/blob/REL_17_12/src/bin/pg_dump/pg_backup_archiver.c#L2796-L2802)、[TOC定義の出力](https://github.com/postgres/postgres/blob/REL_17_12/src/bin/pg_dump/pg_backup_archiver.c#L3677-L3693)。
- **元ACLの推論。** pg_dump 17.12は `public` の基準ACLを所有者の `CREATE`・`USAGE` と、同じ所有者を付与者とする `PUBLIC` の `USAGE` で合成する。基準にあって元ACLにない項目にはREVOKEを生成し、`nspacl` が `NULL` なら通常のスキーマの組み込み既定で展開する。その場合も基準にある `PUBLIC` 向け `USAGE` の取消しが出力される。保存済みの対象ACLは有効な一項目として丸ごと出力されており、4件の個別付与だけを記録している。この出力から、元の `nspacl` は明示ACLで、基準の `PUBLIC` 向け `USAGE` を保持していたと推論できる。元の生の配列順や採取値は未確認。[pg_dumpの基準ACL](https://github.com/postgres/postgres/blob/REL_17_12/src/bin/pg_dump/pg_dump.c#L5343-L5393)、[NULLの展開とACL収録](https://github.com/postgres/postgres/blob/REL_17_12/src/bin/pg_dump/pg_dump.c#L14422-L14468)、[付与と取消しの生成](https://github.com/postgres/postgres/blob/REL_17_12/src/bin/pg_dump/dumputils.c#L142-L225)。

| 時点 | `PUBLIC` の `USAGE` | 所有者 | `nspacl` と根拠 |
| --- | --- | --- | --- |
| 元バックアップが表す状態 | あり | `pg_database_owner` | 所有者はTOCと元SQLで確認。明示ACLと `PUBLIC` 付与は対象ACL項目全体とpg_dump 17.12の基準から推論。 |
| 既存 `public` を削除し、アーカイブが再作成した直後 | なし | CREATE直後は `supabase_admin`。直後の所有者変更で `pg_database_owner` | `actual-public-preparation-before.local.json` は削除前のローカル `public` に `PUBLIC` 付与あり、`actual-public-preparation-after.local.json` は削除後にスキーマなしと直接記録。再作成・所有者変更直後の `nspacl` は `NULL` と推論。根拠は元SQL、照合済みのスキーマ既定権限・トリガー、PostgreSQL 17.11の作成・所有者変更処理。 |
| 元アーカイブの復元後 | なし | `pg_database_owner` | `actual-catalog.local.json` の展開ACLと、v3.2の `acl-details.private.json` の生ACL・展開ACLで確認。明示ACLで、4ロールへの個別 `USAGE` はあり。 |

旧復元ランナーは準備で `DROP SCHEMA public RESTRICT` を実行し、再作成は元アーカイブが行った。差は再作成直後に生じ、元ACL項目の個別付与後も残った。再dumpはこの復元後状態から出力された。追加REVOKEは旧復元で実行されていない。`SOURCE_CODE_AS_AT_OLD_RUN: NOT_ATTESTED` とA/Bの原定義未確認は継続。元ACLの推論は同一SHA-256のアーカイブ、保存TOC、保存SQLと版を固定した公開実装に基づく。現行本番DBの状態は使っていない。方法A `EVIDENCE_MATCH`、SQL往復比較 `MISMATCH`、限定復元 `INCOMPLETE` はそれぞれ維持する。

**復元準備の最小修正案。** 対象アーカイブをSHA-256で固定し、元の `PUBLIC` 向け `USAGE`、対象のCREATE・所有者変更・ACLが各1件、隔離先と既存の準備ガードを確認できる場合に限り、アーカイブが `public` を再作成して所有者を設定した直後、後続の復元に進む前に、同じ復元トランザクションで `GRANT USAGE ON SCHEMA public TO PUBLIC;` を1回だけ適用してdumpが前提とする基準を再現する。付与者は `pg_database_owner` として確認する。これを復元手順の明示的な変更としてレビューする。保存アーカイブには手を加えず、対象の特定が曖昧な場合は停止する。後日の隔離検証では、再作成・補完直後・元ACL適用後の所有者とACLを採取し、`PUBLIC` の `USAGE` のみ補完され、`CREATE` は付与されず、4ロールの個別付与と他スキーマのACLに変更がないことを確認する。直接・継承の付与を持たない検証ロールでも `USAGE` を確かめ、元SQLと再dumpを既存の厳密比較に通す。元の `PUBLIC` 付与なし、対象不一致、適用失敗の各ケースで余分な付与や部分適用が残らないことも検証する。比較処理や許容差分の変更は提案しない。今回の作業は保存資料の解析と文書化まで。

#### `PUBLIC` の `USAGE` を補完した別版runnerでの新規隔離復元（2026-11-24 JST）

- 修正版 `PINNED_PUBLIC_USAGE_REPLAY_V1` は `%LOCALAPPDATA%\acappella-tt-restore-public-usage-v1-20261124`。旧復元runner、元アーカイブ、方法A v3.2と既存証拠を保持した。修正版のREADMEに適用条件・実行入口・結果の取扱いを記録した。既存の `restore-verification.cjs` は旧版とSHA-256一致。
- バックアップのマニフェストと旧runに共通するアーカイブSHA-256 `B5A216D8B1D2A86E567A4109EDF6519B4068028DD0A53FDBF812E702A27D59E0` を適用条件として固定し、実行時に元ファイルとクライアントの読み取り専用マウントで照合。TOC 82・4023、所有者 `pg_database_owner`、対象ACLブロック、DDLと挿入位置の一意性を必須とした。版は `pg_restore`／`psql` 17.12。元アーカイブから選別せず生成したSQLについてスキーマ、COPYのバイト列、sequenceを既存抽出と照合した。
- 両laneとも `public` のCREATEと所有者設定直後の30行目に `GRANT USAGE ON SCHEMA public TO PUBLIC;` だけを挿入した。生成SQLの他の順序・内容・混在改行を保持した。既存の `supabase_admin` と隔離先ごとのUnix socketを使用し、`psql -X --single-transaction --file=-` と `ON_ERROR_STOP=1` で、付与を同じ接続・同じ復元トランザクションに含めた。旧runnerの準備、入力保護、隔離、停止の条件を維持。`PG_RESTORE_EXIT_CODE` と `REFERENCE_SCHEMA_RESTORE_EXIT_CODE` はこの版では各復元の `psql` 終了値。
- 25ファイルの構文確認、既存の自己テスト11組と追加20チェックが成功。対象外のハッシュ、想定外のTOC・所有者・挿入位置、COPYデータ不一致で拒否することも確認した。保存済みSQL・TOC・ハッシュで単一挿入を確認した。新規referenceの小規模試験では、開始時に `public` が存在せず、同じ接続で新しい付与と混在改行の保持を観測した。意図的なエラーで `psql` 終了値3となり、別の読み取り専用接続で開始時の11スキーマのACL・所有者と一致し、新しい `public` と付与が残っていないことを確認した。
- 実アーカイブは新規actualで全復元1回、referenceで既存検証用のスキーマ復元1回。双方の終了値0。actualのpublic側12件・履歴1件のテーブルデータ項目の行数、migration履歴、Auth ID fixtureの不変性、外部FK孤立0件も確認した。両laneの対象ACLは `MATCH`。明示ACL7項目で、所有者・付与者は `pg_database_owner`、`PUBLIC` には `USAGE` 1件だけ、`CREATE` とgrant optionはなく、4ロールへの個別 `USAGE` は保持。元の権限は、保存アーカイブとpg_dumpの出力規則からの推論。
- 既存の厳密SQL往復比較は `MATCH`（247文対247文）。新runの限定判定は `PASS_WITH_DECLARED_PLATFORM_DIFFERENCES`、`STOPPED_AT=COMPLETE`、`BLOCKER=NONE`、runner終了コード0。既知4領域の基盤差による厳密判定は `BLOCKED_BY_PLATFORM_BASELINE`。Authログイン復旧、実際の認可動作、Supabase全体復旧、全データ値の同等性は未検証。旧runの `MISMATCH`（247文対248文）と `INCOMPLETE` は過去の結果として保持した。方法A v3.2の `EVIDENCE_MATCH`、旧条件での追加REVOKEの限定評価、`SOURCE_CODE_AS_AT_OLD_RUN: NOT_ATTESTED` とA/B原定義未確認にも変更なし。
- 新run `81476fba-b0d8-4277-911b-b3ad532d788f` の非公開結果は `%LOCALAPPDATA%\acappella-tt-local-restore-20261124T011237Z-81476fba`。共有用は `shareable-summary.txt`。新版ソースのハッシュ、挿入位置・生成SQLハッシュ、ACL・ロールバック・比較・資源IDの詳細は非公開ファイルに保持。今回新設したコンテナ3件だけを正確なIDで停止し、停止後の状態を確認した。新設volume 4件の保持を確認。既存資源変更、本番接続・変更、元バックアップへの書込みはいずれも0件。

### 本番Live導入に残る復旧条件と厳密比較（2026-11-24 JST）

**到達点。** 方法A v3.2は `EVIDENCE_MATCH`。別版runnerの新runは対象 `public` ACLと厳密SQL往復比較（247文対247文）が `MATCH`、限定復元が `PASS_WITH_DECLARED_PLATFORM_DIFFERENCES`。旧runの `MISMATCH`／`INCOMPLETE` は履歴。ACLとSQL往復の調査はこの到達点で完了。厳密な基盤判定は `BLOCKED_BY_PLATFORM_BASELINE`、本番Live導入は停止中。

- **既存の明示要件。** [復旧runbookの停止・復旧](live-tt-deployment.md#9-停止復旧) はDB・ACL障害時の書込み停止、バックアップの利用可否と復元先の確認を定める。[履歴修復runbook](cloud-event-migration-history-repair.md#preconditions) の現行バックアップ・復元手順・正確な対象確認・管理者承認は履歴修復を行う場合の条件。既存Projectでは履歴とcatalogの不整合、対象・権限不明、未知versionに対して停止する。新規V1テストProject向けの全16件適用手順を、既存本番にそのまま流用しない。
- **本番Liveの配備・利用条件。** 対象Projectと候補revisionを特定し、現在のmigration履歴・catalog、#15→#16の適用計画、`save-cloud-event` と `create-live-timetable` の同一Project・JWT検証、VercelのCloud設定と対象branchを確認する。#16は内部Stage builderのEXECUTEが `authenticated` に継承される環境で停止・rollbackする。対象branchのNode／Denoチェック、人による承認・マージ・Production配備承認は個別に記録する。配布前は、登録済み利用者のMagic Link・正しいredirect・Workspace認可、Live作成、未割当の拒否と割当後の進行、Realtimeの7列通知と認可付き再取得、既存Cloud Eventの保全、匿名公開OFFを対象環境の証拠で確認する。使い捨て環境・専用Hosted／Previewの検証はそれぞれの版と範囲の証拠として使用する。本番対象の最新版や承認は今回未照会。[V1公開前後の確認](live-tt-deployment.md#8-公開後の確認)、[既存環境のmigration条件](cloud-setup.md)、[Live operatorの検証](live-tt-operator-ui.md#適用と使い捨てdb検証)。
- **過去の復旧試験の前提。** 元アーカイブは#1～#14時点の `public` と `supabase_migrations` に限定。保存マニフェストではAuth／Storage／Vaultデータ、large object、global role定義、Storageファイル、Edge Functions、プラットフォーム設定を対象外とする。Auth ID fixtureと外部FK 2件（`profiles.user_id`／`workspace_members.user_id` → `auth.users.id`）の確認は構造と参照の証拠。#15／#16適用後に作られるLiveデータ、全データ値、実ログイン、セッション・既存Authアカウントの復旧、全Supabase復旧は未検証。公開時に利用者がログインできる要件は維持する。Authアカウントを含む災害復旧を採用する場合は、IDを保つ復旧とログインを別途定義する。現行のアプリ範囲の復元には、全Auth／全Supabaseの復旧証明を追加しない。
- **二つの判定と今回の提案。** 厳密な基盤同等性は `baseline-check.cjs` の採取済みメタデータ比較で、例外なし。限定復元の既知差の許容はこの判定へ適用しない。閲覧した公開手順には、厳密runnerの全項目一致を本番Live導入の独立した必須条件とする明文を確認できなかった。既存の停止判断は維持し、各差を本番で受容した扱いにも変更しない。今回の提案は、①対象と来歴が確認済みの候補で厳密な基盤preflightを先に1回行うこと、②本番導入の判断時に直近バックアップの収録範囲・別復元先・書込み停止と復旧後に再開できる条件を記録すること。②は既存の復旧手順を対象本番の切替計画に具体化する案。全Auth復旧や将来の匿名Live、V2 backfill／cutover、全プラットフォームの同等性を一律の追加条件としない。

**証拠の対応。** 期待値は `%LOCALAPPDATA%\acappella-tt-restore-deps-20261119T010420Z-a5647220` の `dependency-context.local.json`。新runの `run-manifest.local.json` のハッシュと一致し、元バックアップのSHA-256も保存マニフェストと対応する。Hosted側の依存情報は後日取得の別スナップショット。新runの `limited-baseline-profile.local.json` とactual／referenceの `*-local-dependency-metadata.local.json` に既存 `validateBaseline()` をオフライン適用し、両側で同じ4領域の不一致を確認した。`dependency-access-check.cjs` が対象とする4ロール×3関数の12組では、必要なschema `USAGE` と関数 `EXECUTE` が両laneで成立し、復元前後の比較も一致。ここで確認したのはローカルのカタログ上のアクセスで、Hostedの実効認可や関数本文の同等性は含まない。

| 領域・具体的な差 | 既存の要求と根拠 | アプリや復元対象の依存箇所 | 取得済み証拠で確認できること | 残る不足 | 必要な一致条件 | 完了条件 |
| --- | --- | --- | --- | --- | --- | --- |
| ロール。`cli_login_postgres` と `supabase_realtime_admin` が新runの両laneで欠落 | `requiredRolesPresent` は、採取した属性の対象、所属の両端・付与者、拡張・外部関数の所有者に現れるロールの存在を要求。`roles` は別に採取済み6ロールの属性を比較 | 前者は記録上のCLI管理接続に関係。後者はRealtime側の基盤メタデータ。LiveのSQLは `authenticated`・`service_role`、EdgeはJWTの利用者を使用。対象2ロールをアーカイブが直接参照しないことをrunnerで確認 | 2ロールは保存比較では所属のmemberとしてのみ登場。採取対象6ロールの属性は一致。2ロール欠落でも#1～#14のアプリ範囲は復元できた | 一致候補で両ロールが存在する証拠。後日のHosted記録は両ロールの全属性や本番の現時点での使われ方を証明しない | 採取済み参照ロールがすべて存在し、採取済み6ロールの既存属性比較も一致 | `requiredRolesPresent=PASS`、`roles=PASS`。既存比較で属性が採取されていないロールは存在の合格範囲を明記 |
| ロール所属。`postgres` → `cli_login_postgres`、`anon`／`authenticated`／`service_role` → `supabase_realtime_admin` の4辺が欠落（付与ロール → member） | `roleMemberships` は採取ロールが関わる辺集合を、付与者とADMIN／INHERIT／SETを含めて比較 | CLI接続経路とRealtimeサービス側のrole切替に関係し得る。アプリのWorkspace membershipは別。#15の `supabase_realtime` publication・7列・RLSと実クライアント受信は別の検証 | Hosted捕捉16辺に対し両lane12辺で追加なし。欠落4辺は `supabase_admin` による付与、ADMIN=false／INHERIT=false／SET=true。アプリ4ロールのカタログ上のアクセス不足は観測されなかった | 一致候補の辺と属性。保存メタデータだけでRealtimeの実サービス・RLS・JWT・再接続の動作は確定しない | 採取対象の辺集合、向き、付与者と3オプションが一致。欠落・追加とも0 | `roleMemberships=PASS`。Liveの実通知と認可は既存smokeの合格範囲で別に確認 |
| 拡張。`pg_stat_statements` 1.11、`pgcrypto` 1.3、`uuid-ossp` 1.1 の所有者がHosted採取 `postgres`、ローカル `supabase_admin` | `extensions` は元で記録した5拡張の名前・version・schema・所有者・relocatableを比較 | #1で `pgcrypto` を要求。#15のLive投影に `extensions.digest` と `extensions.gen_random_uuid` を使用。`pg_stat_statements` と `uuid-ossp` の直接呼出しは対象のアプリ・migrationで見つからなかった | 3件は `extensions` schemaで所有者だけが相違。`plpgsql` と `supabase_vault` は一致。ローカルのアクセス・復元結果からは所有者差の実害を確認していない | 候補で記録範囲の所有者一致。所有者以外の一致から更新・管理時の権限同等性は導けない | 採取5件が既存の全比較項目で一致。対象拡張が欠落した条件では停止 | `extensions=PASS`。役割や所有者の書換えで通過させない |
| 外部関数。`extensions.digest(text,text)`／`digest(bytea,text)` は所有者が `postgres` → `supabase_admin`。PUBLIC・`dashboard_user`・`postgres` のEXECUTEの付与者も変わり、ローカルに `supabase_admin` のEXECUTE行が加わる | `externalFunctions` はschema・署名・戻り型・言語・種別・SECURITY DEFINER等・所有者・展開ACLを、grantee／grantor／grant option込みで比較 | #15の投影元取得・作成時のスナップショット指紋はtext版。#11／#13／#14のV2系もtext版を使用するが起動範囲外。bytea版の対象コードからの直接呼出しは未確認。`auth.uid()` は#1、V1認可RPC、#15／#16の呼出し利用者の識別に必要 | `digest` は両署名ともownerとACLだけが差。`auth.uid()` の採取メタデータ一致。12組のローカルカタログアクセスと復元前後の不変性を確認 | 一致候補のowner・ACL。Hosted関数本文、実JWT下の `auth.uid()`、Live投影RPCの挙動はこの比較の範囲外 | 3関数の署名・採取属性・所有者・展開ACLが一致。本文やAuth全体の一致を別条件として混ぜない | `externalFunctions=PASS`。Live投影・認可の実動作は既存smokeの範囲として別記録 |

### 候補 17.11.0.004 の厳密な基盤preflight（2026-11-24 JST）

**結果は `MISMATCH`（終了コード2）。** 保存済みの `.003` と別の候補として、過去のキャッシュ一覧が記録した `.004`（接頭辞 `06ddc7962e11`）を選んだ。読み取り専用の比較SQLは終了コード0で1回完了し、既存 `validateBaseline()` が厳密条件との不一致を返した。今回の候補の比較結果と、本番Liveの導入条件は別。既存の `BLOCKED_BY_PLATFORM_BASELINE` と本番導入停止を維持する。

- **配布元と対象。** 公式 Public ECR `public.ecr.aws/supabase/postgres` に保存済みローカルの完全index digestを指定し、index `06ddc7962e11…`、`linux/amd64` manifest `4b438c22395a…`、構成 `4d5fe06292c2…` をそれぞれ生バイトSHA-256で照合。build provenanceのsubjectが対象manifestに一致し、`17.11.0.004` とリリースのコミット `cf90815` の記載を確認した。ローカルinspectはindex指定でindex ID、`--platform linux/amd64` 指定でmanifest IDを返し、29レイヤーのdiff IDの順序、entrypoint、起動構成も対応した。同名タグの照会時点のindex `b15d862126dd…` は別物で、構成digestとレイヤーが異なる。起動には保存済みの固定indexと `linux/amd64` を指定した。[Supabaseの公式リリース](https://github.com/supabase/postgres/releases/tag/17.11.0.004)。
- **初期化・比較。** 新規データvolumeとソケットvolumeで、旧runnerと同じ標準entrypoint、`postgres` DB、`supabase_admin`、設定ファイル引数、TCP待受なし・Unix socketのみを用いた。専用コンテナはネットワークなし・公開ポートなし。既存の起動確認で主PostgreSQLとDB識別を確認し、同コンテナ内の `psql` と専用Unix socketで、ハッシュ照合済み期待値に対して既存 `buildBaselineSQL()` を1回実行した。比較モジュール、期待値、比較範囲、許容差分は既存のまま。アーカイブや既存volumeは接続せず、アプリmigrationは行っていない。
- **結果と資源。** サーバー、DB・実行ロール、ソケットとread-only、空のAuth基盤とアプリ範囲、採取対象の6ロールの属性は `PASS`。下表の4領域は前回と同じ差が残り、解消0件・新規0件。今回新設したコンテナ1件を記録した完全IDで停止し、停止操作の終了値0、コンテナの停止と終了値0を確認。新設volume 2件は識別を再確認して保持。

| 領域 | 残った差 | 判定 |
| --- | --- | --- |
| 必須ロール | `cli_login_postgres`、`supabase_realtime_admin` の2件欠落 | `requiredRolesPresent=FAIL` |
| ロール所属 | 前回と同じ4辺が欠落。採取対象の残り12辺は一致 | `roleMemberships=FAIL` |
| 拡張 | `pg_stat_statements`、`pgcrypto`、`uuid-ossp` の3件の所有者差 | `extensions=FAIL` |
| 外部関数 | `digest(text,text)`／`digest(bytea,text)` の所有者・ACL差。`auth.uid()` の採取メタデータは一致 | `externalFunctions=FAIL` |

結果は `%LOCALAPPDATA%\acappella-tt-baseline-preflight-004-20261124T022613Z-364d4bd0`。`summary.txt` が共有用。完全digest・資源ID、初期化・照合の記録、差分、実行補助は同フォルダーに非公開で保持した。`.004` の確認範囲は空のローカル基盤と保存時点の採取済みメタデータ。CLIやRealtimeの実ロール動作、Live投影による `digest` 呼出し、現行Hosted、本番の復旧可否はこのpreflightで検証していない。アプリ領域の限定復元 `PASS_WITH_DECLARED_PLATFORM_DIFFERENCES`、対象ACLと247文対247文の `MATCH`、方法A `EVIDENCE_MATCH`、旧runの `MISMATCH`／`INCOMPLETE` は各範囲の結果として保持する。このpreflightの成否を本番導入の新しい必須条件に追加しない。

## 7. 文書・実装・記録の食い違いと未確認

1. `live-tt-state-foundation.md`冒頭の「実機・学内Wi-Fi未実施」は、operator runbookの11/11限定的な実機成功記録に対して古い／範囲が曖昧。全面未実施にも、長期運用確認済みにも読み替えない。今回は元文書を変更せず、本書で時点を整理した。
2. READMEの「リアルタイム同期は後続」は通常TTのCloud共同編集に関する説明として扱う。Liveでは通知＋認可readが実装済み。機能の対象が異なるため、全アプリで未実装と解釈しない。
3. backend #15には投影置換・公開read等が存在しても、#79のUIで置換・匿名公開が提供されるわけではない。#16のserialized wrapperと#15の内部RPC名も分ける。
4. Nodeテスト・SQL fixture・HTTP runnerが存在することと、あるHEAD／Hosted環境でPASSしたことは別。CI・PR・Vercel・本番DBの現在状態は未確認。
5. 2026年学祭Excelの登録・編成差・「☆はメンバーではなく目印」の扱いは会話で依頼されたが、現在の登録状態・完了結果は今回確認していない。実データをテストfixtureやGitへ移さない。
6. 既存のローカルアプリ57780／57781や過去のブラウザ用DBの現在稼働は未確認。停止・再利用・cleanupしない。

## 8. 次に取り組む作業は1つ

### 2026-11-24 JSTのHosted本人セッション初回

- 本人実行の結果は `INCOMPLETE AT CREATE_OWNER_PROJECTION`、`FINAL OFF_UNCONFIRMED`、終了値2。対象は専用Project `sqrbioyjhxoehbmacujf`、Workspace `e73db27b-f32b-4310-8498-6a21269bd065`、Event `hosted-live-evidence-3792f477-c8dd-40d3-b14e-f94522902595`。
- 13:27 JSTの実行後観測では、対象Event・Live投影・Stage・演目が各1件、`is_published=false`、`public_view_enabled=false`、操作割当0件。今回の当該Event限定のread-only照合でも、投影の作成時刻が13:21:37 JSTで両フラグがfalseであることを確認。元実行の結果はそのまま保持する。
- 対象投影の作成時刻に対応する保存ログのステータスと順序は、Edge Functionの作成200、匿名公開read 200、Owner認可read 200が2回、最後の匿名公開read 200。ログの応答本文は確認していない。観測と旧コードの制御順から、Ownerの作成DTO検査後と終了時のOwner再読後に、同じ匿名read判定で停止したと判断した。#16の公開RPCは有効な公開対象がなければJSON `null` を返し、リポジトリは `NOT_FOUND` に変換する。補助の3か所は `LIVE_NOT_FOUND` を期待していた。この契約不整合を再現済み。
- [Hosted補助](../scripts/liveTimetableHostedEvidence.mjs) を修正。匿名readはHTTP 200かつ `NOT_FOUND` で合格とし、公開データの取得、別種のエラー、不正応答、通信失敗は停止する。作成・終了確認の失敗時は固定工程・HTTPステータス・固定理由のみの `DIAGNOSTIC` を追加。当時の構文・計画表示・オフラインself-test、関連Nodeテスト82件が通過。

### 2026-11-24 JSTのHosted本人セッション2回目

- 同じ専用Project／Workspaceとデプロイ `dpl_8APhCgjsrgn5AAs9fLtS9DRJ5NzN`。Eventは `hosted-live-evidence-c7862da6-f39c-496e-839c-93e44731a0ef`。元の出力は `PASS OWNER_SAVED_EVENT_PROJECTION`、`PASS UNASSIGNED_START_ACCESS_DENIED_UNCHANGED`、`INCOMPLETE AT REALTIME_AND_ASSIGNED_VIEWER_START`、`FINAL LIVE_OFF ANONYMOUS_READ_DENIED OPERATORS=1`、終了値2。
- ユーザーの事後観測では、割当Viewerの開始が反映し演目は `in_progress`、進行と匿名公開はOFF、割当1件。今回の調査開始時、当該Eventに限定したread-only照合でもOFF両方、割当1件で未解除だった。本人が既存のOwner画面で解除する予定。事後観測と元実行結果を保持する。
- 投影作成時刻で絞ったAPIステータスの時系列では、開始RPC 200、直後の認可read 200、その約12.1秒後に終了処理のOwner readがあった。旧補助の12秒の通知待ちが停止箇所と判断した。タイムアウトまでに別のコールバック起点の認可readはログで識別できず、対象チャネルに紐づくRealtime記録も確認できなかった。未配信・対象外・行検査での拒否は区別できない。WebSocket 101と開始のDB反映は実通知の証拠に含めない。
- 旧補助はチャネルの `SUBSCRIBED` だけで開始に進み、通知待ちの例外やコールバックの検査結果を固定理由に変換していなかったため `DIAGNOSTIC` がなかった。購読準備の隙間はコード上確認した不備で、今回の未達の直接原因かは未確定。旧補助の割当解除は正常経路にだけあり、途中失敗時は終了処理がLive OFFと匿名readの確認だけを行っていた。
- 当時の修正では、チャネル参加とPostgres Changesの `system` 確認を待ってから割当・開始へ進むようにした。開始／終了RPC、Ownerの状態照合、通知待ち、通知行、通知を起点とする認可readに固定診断を追加した。通知待ちの12秒は据え置き。後処理はOwner APIでLive OFFを試み、再読したmanagement revisionで今回のStage・Viewerの組だけを解除し、両結果を個別に報告する。失敗時ももう一方を試み、元の `INCOMPLETE` を保持する。当時の構文・計画表示・対象違いでの停止・匿名read・Realtime・後処理のオフライン検証と、関連Nodeテスト82件が通過。修正後のHosted実測は次節に記録する。[Supabase Realtimeプロトコル](https://supabase.com/docs/guides/realtime/protocol#postgres-changes-subscription-errors)

### 2026-11-25 JSTのHosted本人セッション完了

- **[会話・本人のPowerShell出力]** Project `sqrbioyjhxoehbmacujf`、Workspace `e73db27b-f32b-4310-8498-6a21269bd065`、対象デプロイ `dpl_8APhCgjsrgn5AAs9fLtS9DRJ5NzN`、Event `hosted-live-evidence-5783a7cf-0365-47df-8b33-c3b247bb021e`。Ownerの保存済みEventからの投影作成、未割当Viewerの開始・終了拒否と状態不変、割当Viewerの開始・終了双方の実7列通知と通知起点のOwner認可readがPASS。進行OFF・匿名read拒否・割当0件と対象割当の不存在を報告し、`COMPLETED HOSTED LIVE EVIDENCE`、`HOSTED_SMOKE_EXIT=0`。共有出力は [Operator UI runbook](live-tt-operator-ui.md#1125のhosted-smoke完了) に記録した。
- **[会話・ChatGPTの実行後の読み取り観測]** 11/25 09:20 JST、対象Eventは進行OFF、匿名公開OFF、担当割当0件。演目1件が `completed` で開始・終了時刻を保存済み。実通知と認可readの根拠は本人出力にある。今回の文書更新で再照会していない。
- **[コード・先行記録]** デプロイの既存記録は `05e315286f8f9b85f1e9ddb6c32bba19d4b7f915`。ローカルの候補 `3bad9316e1ea1b26d46f7f268598bba7375db7cd` との差は既存2文書のみと今回Gitで再確認した。専用Projectの全16 migration、JWT検証付き2 Functions、7列publicationとRLSは先行記録に基づく。実行出力はPostgres Changes準備待ちと後処理を追加した作業ツリー版の [Hosted補助](../scripts/liveTimetableHostedEvidence.mjs) に対応する。現在のローカル補助のSHA-256は `b2f5ee54812fbd9cb1db0141fb6c6ffab9a4ccf0879c064ad599de8e2f9bf6df`。実行時のハッシュ、Node／SDK実行版の明示記録は提示結果にない。スクリプトは専用ProjectのAPIを使う。ブラウザーでの表示・操作・再接続は既存の実機証拠の範囲で扱う。
- **[会話・別件の後片付け]** 11/25 09:20 JSTの前回Event `hosted-live-evidence-c7862da6-f39c-496e-839c-93e44731a0ef` は進行OFF・匿名公開OFF・割当1件。当時はメール送信制限で解除を保留した。10:19:17 JSTの事後観測は下記に記録する。
- **[会話・設定前の運用課題]** 11/25の設定前のDashboard表示では `acappella-tt-live-validation` はプロジェクト全体で2通／時、`Enable custom SMTP` はOFF。`Minimum interval per user` は60秒表示で、画面説明ではカスタムSMTP設定時の項目。ChatGPTの同Project認証ログ確認ではHTTP 429／`over_email_send_rate_limit`。本番のSMTP・送信上限は未確認。[既存のメール確認項目](live-tt-deployment.md#3-supabaseテストproject)

### 2026-11-25 JSTのログイン確認と後片付け

- **[会話・本人の実施報告]** 専用Project `sqrbioyjhxoehbmacujf` で送信用Gmailとアプリパスワードを用意し、カスタムSMTP、Project全体の送信上限30通／時、同一ユーザーの最小間隔60秒を設定した。Ownerの個人メールとViewerの学校メールにMagic Linkが届き、両方のブラウザーログインを確認した。設定値は本人報告。現在の設定の直接取得と上限までの送信負荷試験は未実施。[SMTP運用記録](live-tt-deployment.md#3-supabaseテストproject)
- **[会話・ChatGPTの事後の読み取り観測]** 11/25 10:19:17 JST、同ProjectのWorkspace `e73db27b-f32b-4310-8498-6a21269bd065` で、前回Event `hosted-live-evidence-c7862da6-f39c-496e-839c-93e44731a0ef` と成功Event `hosted-live-evidence-5783a7cf-0365-47df-8b33-c3b247bb021e` はともに進行OFF・匿名公開OFF・担当割当0件。前回分の割当残存は事後観測時点で解消した。解除時刻と実行者は未確認。09:20の観測と各smokeの結果は当時の記録として保持する。

### 当面の運用方針と次の作業

**[会話・運用方針]** 当面は追加費用をかけず、既存の専用検証Project `acappella-tt-live-validation`（`sqrbioyjhxoehbmacujf`）と現在のVercel Previewで、少人数の開発・検証を続ける。独自ドメインと本番Live導入は必要になった段階で検討する。専用Hosted smokeは完了済み。対象ACLと247文対247文の厳密SQL比較の `MATCH`、限定復元の `PASS_WITH_DECLARED_PLATFORM_DIFFERENCES`、厳密な基盤同等性の `BLOCKED_BY_PLATFORM_BASELINE`、方法Aの `EVIDENCE_MATCH` は、それぞれの結果として保持する。

**スマホでのLive運営画面の操作性確認。** 本人の報告では全体として使いやすく、担当割当後の「再割当」「解除」の標準ボタン風の表示が気になった。ローカルの修正では両方に共通の `secondary-button` を適用し、担当者操作欄に限って既存Live操作に合わせた無効表示を加えた。操作や権限の条件、スマホ・PCの配置ルールは従来どおり。個々の操作項目の本人実測結果は報告された範囲で扱う。[スマホ操作性確認手順](live-tt-operator-ui.md#スマホでのlive運営画面の操作性確認)

配備前は、担当者欄を再現したローカルChrome表示で320・375・900px幅を確認。2ボタンの横並び、解除のみの配置、高さ44px、横はみ出しなし、無効時の減色と既存フォーカス枠を確認した。関連テスト46件、対象ファイルのESLint、`git diff --check` は通過。

2026-11-25 JST、ボタン修正のTSX／CSSだけをコミット `0d6f1c7462e2a30cda1ac15f09d1bb063bf07086` として `feature/live-tt-operator-ui` にpushした。リモート先端 `3c6389d` を基点に一時worktreeを使い、既存のローカル作業ツリーとステージを保持した。Git連携でVercelの専用Project `acappella-tt-live-test`（`prj_UOP4BmgnG7BgalwWxkkyNFnF490Y`）にPreview `dpl_4yXJJZ3FMN12pUb6faL3mvYKS6wC` が作成され、`READY` とコミットの一致を確認。ブランチ専用のPreview環境変数 `VITE_SUPABASE_URL` は専用Project `sqrbioyjhxoehbmacujf` に対応する。GitHub ActionsのNodeテスト・型検査・lint・build、Deno Edge Functions、Vercelチェックは成功。[確認用Preview](https://acappella-tt-live-test-h89q0n42e-shunta-ohashi.vercel.app/) [CI結果](https://github.com/Shunta-Ohashi/acappella-TT/actions/runs/45535834034)

**[会話・11/25の本人によるスマホ表示確認]** 上記Previewの担当者欄で「再割当」「解除」の見た目が改善されたと本人が報告した。修正が見えなかった時点では旧Preview URLを開いていた。提示されたSupabase画面で新PreviewのRedirect URLが未登録だったため、新URLの追加と新しいMagic Linkでのログインを案内し、その後に本人から表示改善の報告があった。設定の保存内容・正確な操作時刻は未確認。今回の確認範囲は2ボタンの表示。機能smokeと一連の操作の結果は各既存記録を参照する。[Operator UIの表示確認記録](live-tt-operator-ui.md#1125の担当者ボタン表示確認)

**[コード・主作業フォルダーの同期]** GitHubの対象branch先端が配備済み `0d6f1c7` であることを照会し、主作業フォルダーを2コミットfast-forwardした。UIの作業差分は配備済み内容と一致し、同期後に重複した差分はない。Operator UI文書はリモートの11/17記録とローカルのHosted・スマホ手順を統合した。deployment runbookとHosted補助2ファイルはハッシュ一致を確認。本書は未追跡のまま保全・追記した。同期前の変更7ファイルの実体・SHA-256・追跡済み差分は `%LOCALAPPDATA%\acappella-tt-sync-backups\sync-20261125T051231Z-13eccb30` に保管。mainやdbtestの更新、新しいコミット・push・配備は行っていない。

### 保留中の本番事前確認

**本番対象のmigration履歴とカタログの読み取り照合は保留。** 過去の本番記録は先頭14件一致まで。本番導入を検討する段階で対象Projectと候補版を確認し、既存preflightの検査観点で、現在の適用済みversion・依存オブジェクト・実効権限と履歴の整合を照合する。対象・取得時点・差分・残る `#15 → #16` の適用順または停止理由を記録できた時点で完了。未知・欠落・順序不一致・予期しない権限・読み取り不能があれば適用を止める。本番Live導入の既存条件と停止判断を維持する。[本番Live導入と復旧判定](live-tt-deployment.md#本番live導入と復旧判定)

過去のPID 1観測の同一起動回への対応付けは証拠不足として終了。v3とv3.1は `BLOCKED`、v3.2は `EVIDENCE_MATCH`。SQL往復比較や許容差分の変更、本番適用はこの評価とも別に判断する。

今回満たした方法Aの完了条件と停止条件：

- 元資源のID・label・image・停止状態・配置を実行時に再照合し、元は停止／read-onlyのまま扱う。
- 必要なACL内容／不存在、トリガー・関数定義、実行ロールを同じread-only snapshotで取得し、保存値との照合に成功する。
- 新規の非公開結果に証明範囲と不足項目を残し、新設分だけの停止・volume保持を確認する。共有は固定サマリーだけ。
- mismatch／未対応配置／欠落ならBLOCKEDと具体的理由を記録し、修復・別DB探索・方法Bへの自動切替をしない。未完了を成功扱いしない。

旧runの `PUBLIC` 向け `USAGE` の差と別版での検証結果は第6節に記録した。

## 9. 新しいチャットでの再開と作業範囲

最初に本書、ユーザー指示、実在するAGENTS.md、対象コード・READMEを読み、ブランチ・HEAD・未コミット差分を確認する。本書自体は未コミットの可能性があるので、保護したうえで再開する。根拠の追加に合わせて本書を更新する。

- `.004` の基盤preflightは第6節に記録済み。専用Hostedの本人実行の完了、当面の運用方針、保留中の本番事前確認は第8節を参照。
- 過去の本番書込み承認を包括的に再利用しない。Hosted／migration／Function／Auth／Vercel／Gitの変更、旧CLI再試行、既存資源cleanupは今回の許可に含まれない。
- 操作が権限・環境に阻まれた場合、正式な審査経路とその時点の停止条件に従う。sandbox・ACL・HOME・回線・認証情報を切り替えて迂回しない。
- 通常の実装変更を別途行う際は、関連テスト、`pnpm test`、`pnpm exec tsc -b`、`pnpm lint`、`pnpm build`、必要なDeno／DB／HTTP検証を変更範囲に応じて計画する。Hosted補助の修正で実施した検証は第8節に記録した。
- マージとProduction配備の関係は管理側設定を確認しない限り断定しない。検証PASS、人による承認、公開判断を分離する。

### 開発用スキル・ブラウザー環境（2026-11-24 JST）

- GitHub、Supabase、Vercel、OpenAI Docsは既存のものを使用する。OpenAI提供のProduct Designはプラグイン管理で導入済み・有効、未解決の依存なしと確認。Vercelの `react-best-practices` と `verification` はこのセッションの既存スキルから利用可能。今回は追加導入なし。
- WindowsのComputer Useと組み込みBrowserは用意されている。このセッションでは両方がブラウザー／アプリ一覧の取得前にカーネル資材の初期化エラー（OS error 3）で停止した。ChromeとEdgeの実行ファイルは存在を確認。リポジトリの宣言・ロックファイル・Nodeの解決先、既存のnpmキャッシュ、既定のPython環境を確認した範囲で、実行できるPlaywrightは見つからなかった。
- 複数利用者の画面検証が必要になった場合の追加候補は、リポジトリ外に置く独立したPlaywright環境1件。Owner／Viewerを別BrowserContextに分けられる。既存HTTP／Realtime smokeはAPIレベルの証拠として保持する。[Playwrightのセッション分離](https://playwright.dev/docs/browser-contexts)。

## 10. 文書整備の記録

初回作成時は適用指示、README・設計／運用文書、HEAD・変更履歴・差分、関連コードとテスト定義、限定した保存結果・パッケージ整合性を読取り確認した。11/25の更新範囲は本書、Operator UI runbook、deployment runbook。本人のHosted完了結果、別の事後観測、専用Projectのメール制限と設定後の通常ログイン、本番導入の既存条件と保留方針、次回のスマホ操作手順を反映した。

## 11. 2026-11-21 ユーザー直下の関連フォルダー整理

[今回のファイル確認] `%USERPROFILE%\acappella-TT` と `%USERPROFILE%\acappella-TT-dbtest` の両フォルダーが存在する。主フォルダーは現在の開発場所。dbtestの用途は、主アプリの開発設定が接続するローカルAPIの環境として保持することと、別の整理用Codexチャットの完了報告で確認した。接続や稼働は未確認。

[ユーザー完了報告] 当初対象の20フォルダーのうち18件を整理し、上記2件を保持した。

- `atomic-review`はworktree登録と元フォルダーを削除し、ブランチとコミットは保持した。
- 旧検証環境12件は必要な291ファイルを保管・照合して元フォルダーを削除し、対応するDocker volume 21件を保持した。
- `eventv2check`、`eventv2httpcheck`、`inspectioncheck`、`atomiccheck-02`、`atomiccheck-03`は必要な240ファイルを保管・照合し、環境を停止して元フォルダーを削除した。元パスを参照していたAtomic 02・03のStudioコンテナだけを削除し、その他の対象コンテナは停止状態で保持した。対応するvolume 10件も保持した。
- 上記5環境のうち、最後の`atomiccheck-03`はDBの正常停止を確認してからStudioと元フォルダーを削除した。残る11コンテナとvolume 3件を保持し、保管対象17ファイルは削除直前の再照合にも合格した。
- `atomiccheck-02`と`atomiccheck-03`のAnalyticsは、いずれも終了コード137を原因未確定の既知事象として記録し、それぞれのコンテナを停止状態で保持した。正常終了とは扱わず、両者の原因が同じかも未確定。

保管対象は設定・SQL・コード・対応記録等。DBデータのバックアップや、完全に再起動できる環境の保存が完了したことは確認されていない。旧検証環境12件の`seed.sql`欠落など、既知の制約も残る。

### 保管・実行記録の場所

以下は[ユーザー完了報告]に基づく参照先。今回、この開発用チャットからは4か所ともアクセスが拒否され、記録内容は未確認。ファイルの照合結果やコンテナ・volumeの状態は、整理完了時点の報告に基づく。

| 用途 | 保管先 |
| --- | --- |
| 旧検証環境12件の保管 | `%LOCALAPPDATA%\acappella-tt-folder-archive-20261120\20261120T133459+0900-8ea6c96218cf` |
| 5環境のファイル保管・初回実行記録 | `%LOCALAPPDATA%\acappella-tt-validation-archive-20261120\20261120T141601+0900-8444131c676b` |
| Atomic 02完了・03中断時の実行記録 | `%LOCALAPPDATA%\acappella-tt-validation-archive-20261120\resume-20261120T143529+0900-45063a53f99f` |
| Atomic 03の最終完了記録 | `%LOCALAPPDATA%\acappella-tt-validation-archive-20261120\finish-atomiccheck-03-20261121T011922+0900-d9dcddd7a0d6` |

本節の整理結果は第6節の復元・ACL検証とは別の記録。旧runのSQL往復比較 `MISMATCH` と新runの `MATCH`、次の作業は第6節と第8節を参照。
