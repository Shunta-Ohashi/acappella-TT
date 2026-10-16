# acappella-TT

## 概要

アカペラライブのタイムテーブル作成・当日運営を支援するWebアプリです。

## 主な機能

- Event・開催日・Stage・Sectionの設定
- Member・固定Band・イベント出演情報の管理
- タイムテーブルの作成、ドラッグ＆ドロップ、自動生成
- PA担当・当日運営担当の設定
- TT固定・出演順制約
- イベント最終チェック
- CSV入出力・XLSX出力・JSONバックアップ
- 閲覧用タイムテーブルの事前共有URL

## 開発

必要なruntimeはNode.js 22.12.0以上です。

```bash
npm install
npm run dev
```

## 検証

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm exec tsc -b
pnpm lint
pnpm build
deno check --frozen --config supabase/functions/workspace-masters/deno.json supabase/functions/workspace-masters/index.ts
deno check --frozen --config supabase/functions/save-cloud-event/deno.json supabase/functions/save-cloud-event/index.ts
deno check --frozen --config supabase/functions/save-cloud-event-v2/deno.json supabase/functions/save-cloud-event-v2/index.ts
```

`main`向けPull Requestの作成・更新時と`main`へのpush時には、GitHub
ActionsでNode.jsのtest・typecheck・lint・build、およびDeno Edge
Functionsのtypecheckを実行します。Draft Pull Requestも対象です。結果はPull
RequestのChecksタブから確認できます。

現段階のCIには実PostgreSQLを使用するintegration testとEdge Functionの実HTTP
smoke testは含まれません。これらは専用の使い捨て検証環境で別途実行してください。

## Production preview

```bash
npm run build
npm run preview
```

## Deployment

Vercelではrepository rootをプロジェクトとして登録し、次の設定でデプロイします。設定は
`vercel.json`にも固定しています。

- Framework Preset: `Vite`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `node scripts/validateCloudDeployment.mjs --require-cloud && pnpm build`
- Output Directory: `dist`
- Root Directory: repository root
- Node.js: `24.x`

通常画面はroot URL、事前共有タイムテーブルは`#share=...`形式のhash URLを使用します。現時点ではpath-based routingを使用していないため、SPA rewriteは不要です。

Vercel buildでは`VITE_CLOUD_REQUIRED=true`と、安全なremote Supabase URL・Publishable
Keyを必須にします。不足やloopback URLがあればbuildを失敗させ、公開サイトが意図せず
local-only modeになることを防ぎます。ローカル開発ではこのflagを設定しなければ従来の
local-only modeを利用できます。テスト環境の構築と公開確認は
[Live TT deployment runbook](docs/live-tt-deployment.md)を参照してください。

## Data storage

編集データは各ブラウザの`localStorage`へ保存されます。production URLへデプロイしても、別のブラウザ・端末・利用者へデータが自動共有されることはありません。未保存のPA・当日運営設定draftも共有されません。

事前共有URLには閲覧用スナップショットが含まれるため、そのURLを受け取った人は共有内容を閲覧できます。

## Security and privacy

Supabase用envを設定した環境では、通常の編集画面を登録済みユーザーのEmail Magic Link認証とWorkspace所属で保護できます。env未設定時は開発用のlocal-only modeとなり、認証なしで従来どおり起動します。事前共有URLは引き続き公開閲覧用です。

認証後は、明示的な「Cloudへ保存」操作でEvent単位snapshotをWorkspaceへ保存できます。自動Cloud保存・共同編集・リアルタイム同期・revision conflict解決は後続対応です。

## Cloud development

Supabase Auth / Workspace環境の準備は[Cloud setup](docs/cloud-setup.md)を参照してください。Cloud用envを設定しない場合は、従来どおりlocal-only modeで起動します。
