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

ファイル名は通常の文字列順でもこの依存順になりますが、Supabase CLI等での適用済み判定はmigration historyに基づきます。旧開発名`20261007120000_cloud_event_persistence.sql`を適用済みの可能性がある環境では、rename後のbase migrationを再適用しないでください。対象判定・catalog照合・承認済みrepair・中断復帰・完了確認は、専用の[Cloud Event migration履歴移行runbook](./cloud-event-migration-history-repair.md)に従って通常のmigration適用より前に実施します。外部環境へpackage install / build / App起動から自動repairは行いません。

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

Vercel projectのEnvironment Variablesへ`VITE_SUPABASE_URL`と`VITE_SUPABASE_PUBLISHABLE_KEY`を設定します。Productionと必要なPreview environmentへ設定し、設定後に再デプロイします。

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

1. `...150000_cloud_event_authorized_save.sql`まで適用してbackend専用RPCを作成
2. `save-cloud-event` Functionを配備し、認証・保存integrationを確認
3. 新frontendを配備
4. `...160000_cloud_event_rpc_only_save.sql`を適用して旧clientの直接INSERT/UPDATEを取り消す

直接write取消し後、旧frontendの直接upsertは意図どおり失敗します。途中状態を長期間残さず、専用環境で一連の順序を検証してからproductionへ反映してください。fresh DBでは全migration適用後にFunctionとfrontendを揃えて公開します。

## 9. Security確認

- `profiles`は本人のrowだけSELECT・INSERT・UPDATEできます。
- `workspace_members`は本人のmembershipだけSELECTできます。
- `workspaces`は本人のmembershipがあるWorkspaceだけSELECTできます。
- `anon`には3 tableへの権限を付与していません。
- Workspaceとmembershipの変更はbrowser clientへ許可していません。
- `cloud_events`のbrowser直接INSERT / UPDATE / DELETEは許可していません。
- 内部保存RPCは`service_role`だけが実行でき、保存transaction内でもactorのowner/editor membershipを`FOR SHARE`で再確認します。
- データ保護はPublishable keyの秘匿ではなくRLSで行います。

## 10. 現在の制限

Cloudへ保存したEvent snapshotはWorkspace内で共有できますが、Realtime、revision conflict / CAS、Presence、offline draft復元、Member/Bandの独立Cloud table化は後続実装です。共有masterはEvent snapshotへ暫定的に複製し、snapshot間で矛盾した場合はsilent mergeせずWorkspace hydrateをfail closedします。

Cloud modeの編集データは、同じブラウザ内でも認証ユーザーとWorkspaceの組み合わせごとに分離して`localStorage`へ保存されます。local-only modeで既存keyへ保存したデータは削除されず、Cloud Workspaceへ自動移行もされません。既存データを対象Workspaceへ移す場合は、local-only modeでバックアップを書き出し、対象Workspaceへログインしてから復元してください。
