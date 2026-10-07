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

現時点では認証機能を実装していないため、production URLを知っている人はアプリ自体を開けます。共同編集・クラウド保存を導入するまでは、production deploymentを複数人での実データ共有基盤として使用しないでください。

Supabase、認証、クラウド永続化、リアルタイム共同編集は後続対応予定です。
