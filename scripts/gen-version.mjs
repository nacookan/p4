#!/usr/bin/env node
// デプロイのたびに index.html 内の __APP_VERSION__ プレースホルダーを、
// そのコミットの短縮SHAで書き換える。
//
// service workerを使わない静的サイトなので、ホーム画面に追加した状態（PWA的な使い方）で
// 起動したとき、ブラウザ（特にiOSのスタンドアロン表示）が古いキャッシュをいつまでも
// 読み続けてしまうことがある。index.html内の起動時チェック（インラインscript）が、
// このバージョン文字列を使って「今読み込んでいるHTMLが最新デプロイと一致しているか」を
// 判定し、古ければキャッシュを迂回して読み直す。
//
// 使い方: CI（.github/workflows/deploy.yml）でデプロイ直前に実行する。
// ローカル開発では実行不要（index.htmlは__APP_VERSION__のプレースホルダーのままでよく、
// その場合バージョンチェック自体が行われない）。
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let version;
try {
  version = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {
  // gitが使えない環境向けのフォールバック（通常のCI実行では発生しない）。
  version = String(Date.now());
}

const indexPath = join(root, 'index.html');
const original = readFileSync(indexPath, 'utf8');
const updated = original.replaceAll('__APP_VERSION__', version);

if (updated === original) {
  console.error('index.html内に__APP_VERSION__のプレースホルダーが見つかりませんでした。');
  process.exit(1);
}

writeFileSync(indexPath, updated);
console.log(`index.html のバージョンを ${version} に更新しました。`);
