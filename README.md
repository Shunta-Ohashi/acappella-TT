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

```bash
npm install
npm run dev
```

## 検証

```bash
npm test
npx tsc -b
npm run lint
npm run build
```

## Production preview

```bash
npm run build
npm run preview
```

## Deployment

Vercelではrepository rootをプロジェクトとして登録し、次の設定でデプロイします。

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Root Directory: repository root

通常画面はroot URL、事前共有タイムテーブルは`#share=...`形式のhash URLを使用します。現時点ではpath-based routingを使用していないため、SPA rewriteは不要です。

## Data storage

編集データは各ブラウザの`localStorage`へ保存されます。production URLへデプロイしても、別のブラウザ・端末・利用者へデータが自動共有されることはありません。未保存のPA・当日運営設定draftも共有されません。

事前共有URLには閲覧用スナップショットが含まれるため、そのURLを受け取った人は共有内容を閲覧できます。

## Security and privacy

Supabase用envを設定した環境では、通常の編集画面を登録済みユーザーのEmail Magic Link認証とWorkspace所属で保護できます。env未設定時は開発用のlocal-only modeとなり、認証なしで従来どおり起動します。事前共有URLは引き続き公開閲覧用です。

認証後も編集データはCloudへ保存されません。共同編集・クラウド永続化・リアルタイム同期は後続対応です。

## Cloud development

Supabase Auth / Workspace環境の準備は[Cloud setup](docs/cloud-setup.md)を参照してください。Cloud用envを設定しない場合は、従来どおりlocal-only modeで起動します。
