# P⁴ – PP Power Plan

P⁴(PP Power Plan)は、PP(プレミアムポイント)獲得を目的とした旅程を組み立てるためのツールです。

## 特徴

- 指定した空港、もしくは到着した空港から、乗ることができる便の一覧を表示し、そこから次に乗る便を選んでいってプランを作ります。
- プランを複数作って比較検討できます。
- 獲得PPを自動で計算します。運賃種別や座席クラスも便ごとに指定できます。
- 金額を入力することでPP単価も計算します。
- アプリには、ユーザーデータを保存するためのサーバーはありません。あなたのデータはあなた自身のDropboxアカウントだけに保存されます。

## 使い方

- Dropbox連携をしてログインします。
- 「設定」画面で、PDF時刻表のダウンロードと読み込みを行います。
- 「プラン」画面でプランを作成します。

## 注意事項

- 国内線のみが対象です。
- 利便性のために個人的に作られたもので、航空会社が提供する公式サービスではありません。
- 表示する便名・時刻・運航会社・PP等の情報は実際のものとは異なっていることがあります。運航状況・空席・予約・積算結果は、必ず公式サイトでご確認ください。

## 技術スタック

- HTML / CSS / JavaScript
- PDF解析: [PDF.js](https://mozilla.github.io/pdf.js/)（Apache License 2.0）
- データの保存・同期: Dropbox API v2（OAuth 2.0 PKCE）
- ホスティング: GitHub Pages等の静的ホスティング

## 動かし方

[Dropbox App Console](https://www.dropbox.com/developers/apps) でアプリを作成し、以下を設定してください。

- **API**: Scoped access / **Access type**: App folder
- **Permissions**: `files.content.write`, `files.content.read`
- **Redirect URIs**: 実際に配信するURLの `oauth-callback.html`（例: `https://example.com/p4/oauth-callback.html`）

作成したアプリの **App Key** は、`js/dropbox-config.js`（gitignore対象、コミットしない）に
`node scripts/gen-dropbox-config.mjs` で生成します。

- **ローカル**: `.env.example` を `.env` にコピーし、`DROPBOX_APP_KEY` に設定してから
  `node scripts/gen-dropbox-config.mjs` を実行してください。
- **本番（GitHub Pages）**: リポジトリの Settings → Secrets and variables → Actions →
  **Variables** タブで `DROPBOX_APP_KEY` を登録してください。`main` へのpush時に
  `.github/workflows/deploy.yml` が自動でこの値を埋め込んでデプロイします
  （Settings → Pages の Source は「GitHub Actions」を選択してください）。ビルド・
  バンドルは行わず、静的ファイルをそのまま配信します。