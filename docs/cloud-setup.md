# Supabase Auth / Workspace setup

この手順はAuthとWorkspace基盤だけを設定します。Event・Timetableなどの編集データは、現時点では引き続き各ブラウザの`localStorage`へ保存されます。

## 1. Supabase projectを作成する

Supabase Dashboardでprojectを作成します。frontendへ設定するのはProject URLとPublishable keyだけです。`service_role` keyはブラウザ・Vercel・repositoryへ絶対に設定しないでください。

## 2. migrationを適用する

SQL Editorなど管理者権限のある方法で、`supabase/migrations/20261007_auth_workspace.sql`を適用します。このmigrationは`profiles`、`workspaces`、`workspace_members`を作成し、全tableでRLSを有効化します。

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

## 8. Security確認

- `profiles`は本人のrowだけSELECT・INSERT・UPDATEできます。
- `workspace_members`は本人のmembershipだけSELECTできます。
- `workspaces`は本人のmembershipがあるWorkspaceだけSELECTできます。
- `anon`には3 tableへの権限を付与していません。
- Workspaceとmembershipの変更はbrowser clientへ許可していません。
- データ保護はPublishable keyの秘匿ではなくRLSで行います。

## 9. 現在の制限

Auth/Workspaceへログインしても、Event・Timetable・PA・DutyなどはCloudへ保存されません。端末間共有、共同編集、Realtime、revision conflict処理は後続実装です。

現在のlocalStorageはユーザー・Workspace別には分割されていません。同じブラウザでアカウントやWorkspaceを切り替えても、保存済みの編集データは共通です。
