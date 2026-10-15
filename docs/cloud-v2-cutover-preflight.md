# Cloud Snapshot V2 cutover preflight

この文書は、Snapshot V1をWorkspace共通Master＋Snapshot V2へ正式移行する前の
**read-only検証基盤**と、将来の運用手順を定義します。現時点ではread-only inspection
runnerはありますが、cutoverを実行するrunner、ready切替RPC、Event一括変換RPCは
ありません。Preflightの成功や
`structuralStatus: "convertible"`を、本番cutoverの実行許可として扱ってはいけません。

## 現在の実装境界

`createCloudV2CutoverPreflight()`は、既存のbackend-only
`inspect_workspace_master_backfill_source()`のraw responseを入力にします。加えて、
`inspect_cloud_v2_cutover_state()`と`createCloudV2CutoverInspectionReport()`は、同じ
generation lock下で取得した完全なMaster/relation証拠をPreflightへ接続します。
関数はPure/read-onlyで、DB、Workspace status、Cloud Event、Master、reference index、
localStorageを変更しません。結果にもSnapshot本文、Member/Band名、JWT、keyを含めません。

Preflightは既存実装を次の順で再利用します。

1. `parseCloudWorkspaceMasterBackfillSource()`でsource envelope、Workspace、generation、
   Event ID/revision/fingerprint、backfill記録を検査する
2. `createCloudWorkspaceMasterBackfillPlan()`でV1 snapshot、共有Member/Band競合、
   Band→Member closure、順序付き`defaultMemberIds`、Event→Master referenceを検査する
3. 各Eventを`createCloudEventSnapshotV2()`でV2へ変換する
4. `hasResolvedCloudEventSnapshotV2Masters()`でdirect/transitive Master closureを検査する
5. Event-owned collectionと、計画されたMasterを組み合わせた再構成結果を元V1と比較する
6. 完了backfillがある場合は件数、source/result generation、plan fingerprintを照合し、
   任意のMaster readがあればMember/Band本体もID単位で比較する

結果の`structuralStatus`は次の意味です。

- `convertible`: 提供されたV1 readだけについて、V2への構造変換と再構成が一致した
- `not-convertible`: 不正Snapshot、参照欠損、共有Master競合、V1/V2混在などを検出した
- `indeterminate`: source response自体が不足・不正で、変換可否を安全に判断できない

`cutoverReadiness`は現在`blocked`または`indeterminate`だけです。backfill未完了など既知の
必須条件不足は`blocked`、既存read契約では証明できない条件が残る場合は`indeterminate`です。
`safeToCutover`は常に`false`です。最終transactionと運用証拠が存在しない現在の実装で、
read-only結果を`ready`へ昇格させる経路はありません。

## 必須条件と検証可能性

| 必須条件 | 現在の分類 | 根拠または不足する証拠 |
| --- | --- | --- |
| Workspace master state | read-onlyで検証可能 | source RPCの`legacy/conflict/ready`を検査。cutover対象はlegacyのみ |
| V1 Snapshot形式・Event所有関係 | read-onlyで検証可能 | 既存V1 parserとrelationship validatorを再利用 |
| Event ID・revision・source fingerprint | read-onlyで検証可能 | source RPCが同一transactionで取得 |
| Workspace generation | read-onlyで観測可能 | source RPCのgeneration。最終値の固定はtransaction内で再検証が必要 |
| 共有Member/Bandの一致 | read-onlyで検証可能 | backfill plannerの完全一致・fail-closed mergeを再利用 |
| `Band.defaultMemberIds`の順序と参照 | read-onlyで検証可能 | planのpositionとV2 transitive closure、round tripで検査 |
| Event-owned collectionの所有関係・重複 | read-onlyで検証可能 | V1/V2 parserとEvent relationship validatorを再利用 |
| Event→Master closure | V1 sourceについて検証可能 | V2 serializerとresolverで完全性を検査 |
| V1→V2の情報欠落 | read-onlyで検証可能 | 全Event-owned collectionとMasterを再構成して元V1と比較 |
| V1/V2混在 | read-onlyで検出可能 | source parser失敗をversion別に診断し、混在を拒否 |
| backfill完了記録 | read-onlyで検証可能 | 件数・generation・fingerprintと実relation行を同一RPCで照合 |
| 正規化Master本体 | read-onlyで検証可能 | 同一generationのMember/Band本体、revision、順序付きrelationを比較 |
| 旧client/V1 writerの停止とdrain | 人間による運用確認が必要 | DB readだけでは開いているtabや配備済みclientを証明できない |
| バックアップ・maintenance window | 人間による運用確認が必要 | 実施記録・restore rehearsalが必要 |
| Cutoverの原子性・競合検知 | 最終DB transactionが必要 | status/generation/Event revision/fingerprintをlock下で再検証する契約が未実装 |
| rollback・復旧 | 運用手順とDB契約が必要 | cutover前backupと、全変更を一括rollbackできるtransactionが必要 |

`unverifiedRequirements`に残る項目を、警告を無視して成功へ変換してはいけません。
旧source RPCのreference件数だけでは組合せを証明しません。新inspection RPCの厳密な
parserを通った場合だけ`REFERENCE_INDEX_CONTENTS_NOT_OBSERVED`を解除します。

## Read-only operator runner

runnerはinspection RPCを1回だけ呼び、raw SnapshotやMember/Band名・notesを出力せず、
件数、status、generation、Issue、reference照合結果、未検証条件だけを表示します。
書込modeや`--apply`は存在しません。

```powershell
$env:ACAPPELLA_TT_CUTOVER_INSPECTION_SUPABASE_URL = 'http://127.0.0.1:<new-api-port>'
$env:ACAPPELLA_TT_CUTOVER_INSPECTION_SERVICE_ROLE_KEY = '<disposable-service-role-key>'
pnpm cloud:v2-cutover-inspect -- --workspace-id '<workspace-uuid>'
```

loopback以外はHTTPSに限り、URLとWorkspaceの二重確認が必要です。

```powershell
pnpm cloud:v2-cutover-inspect -- `
  --workspace-id '<workspace-uuid>' `
  --confirm-workspace-id '<workspace-uuid>' `
  --confirm-target 'https://<project-ref>.supabase.co'
```

終了code 0は、提供された構造とreference証拠が一致したことだけを表します。
`safeToCutover`は常にfalseで、backup、maintenance window、V1 writer drain、atomic cutover
transactionは引き続き未検証です。接続先とservice-role keyは環境変数だけで渡し、
runner出力やrepositoryへ保存しません。

使い捨てDBでは全13 migrationをfresh適用後、次を実行します。既存検証DBや共有DBを
再利用しません。

```powershell
psql "$env:ACAPPELLA_TT_DISPOSABLE_DATABASE_URL" `
  -v ON_ERROR_STOP=1 `
  -f .\supabase\tests\cloud_v2_cutover_inspection.sql

psql "$env:ACAPPELLA_TT_DISPOSABLE_DATABASE_URL" `
  -v ON_ERROR_STOP=1 `
  -v "test_db_url=$env:ACAPPELLA_TT_DISPOSABLE_DBLINK_DATABASE_URL" `
  -f .\supabase\tests\cloud_v2_cutover_inspection_concurrency.sql

node .\scripts\cloudEventMigrationCatalogRegression.mjs `
  --db-url-env ACAPPELLA_TT_DISPOSABLE_DATABASE_URL `
  --confirm-disposable
```

SQL fixtureは専用UUIDだけをtransaction内で作成し、最後にROLLBACKします。並行更新時の
lock待機は、同じ使い捨て環境でgeneration行の共有lockとEvent/Master writerの更新lockを
別sessionから観測します。`ACAPPELLA_TT_DISPOSABLE_DBLINK_DATABASE_URL`には、DB内から
同じ使い捨てPostgreSQLへ到達できるURLを指定してください。静的/Nodeテストだけを実DB
成功として扱いません。

## 将来の正式cutover手順

以下は将来実装する手順であり、現在実行可能なrunbookではありません。

1. migration history/catalog preflightを通し、対象環境と適用済みversionを確認する
2. Workspace単位の復元可能なバックアップを取得し、restore手順を確認する
3. maintenance windowを開始し、新規ログイン・保存操作を停止する
4. V2対応frontend/Functionを配備可能な状態にし、既に開いているtabを含むV1 clientを
   reload/停止して、全V1 save operationが完了したことを確認する
5. backend-only source inspectionを再取得し、本Preflightを実行する
6. legacy Workspaceに対してMaster backfill preview/applyを実行し、直後に同じgenerationの
   Master本体、Band member順序、Event reference indexを再検証する
7. **1つのDB transaction内**でstatus、generation、全Event revision/fingerprint、
   backfill record、Master/reference closureをlock下で再検証する
8. 同じtransactionで全V1 EventをV2へ変換し、reference indexと一致させ、最後にstatusを
   readyへ変更する。途中失敗時はEvent、reference、status、generationをすべてrollbackする
9. V2 readで全Event＋Masterを同一generationとして読み、件数、closure、round trip、
   owner/editor/viewerの権限を事後検証する
10. V2対応frontendを公開し、V1 writerが復帰していないことを監視する

V1 writerが残ったままreadyへ切り替えてはいけません。既存backfillの成功だけでは、
その後のV1保存によるSnapshot/Masterの乖離を防げません。

## 失敗時の扱い

- Preflightが`not-convertible`または`blocked`なら、切替処理を開始しない
- 共有Master競合をlast-write-winsで解決せず、Eventごとの差分をバックアップ上で確認する
- generation/revision/fingerprint不一致は新しいsourceを取得して最初から再検証する
- cutover transaction失敗時はtransaction全体をrollbackし、legacy statusとV1 rowsが
  変更前のままであることを確認する
- commit後の事後検証失敗に備え、事前backupからWorkspace単位で復旧する手順を用意する
- Snapshot JSONやmigration historyを手作業で部分修正しない

## 次のPRで必要なDB/API契約

現行read契約だけでは正式cutoverを安全に完了できません。少なくとも次が必要です。

- backend-onlyのatomic cutover RPC: 上記証拠をlock下で再検証し、全V1→V2変換、
  reference更新、ready切替を同一transactionで実行する
- expected generation、Event revision/fingerprint集合、plan fingerprintを必須CAS入力にする
- dry-run/read-only routeとapply routeを分離し、applyをservice-role限定にする
- 失敗時に部分commitを残さず、成功後の検証に必要なresult generationと件数だけを返す

新しいRPC/migrationを追加する際は、migration history preflight、catalog regression、
ACL/inherited privilege検査、使い捨てDBでの競合・rollbackテストも同じPRで更新します。
