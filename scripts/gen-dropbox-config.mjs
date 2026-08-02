#!/usr/bin/env node
// .env（ローカル開発）または環境変数（GitHub Actionsでのデプロイ時）から
// DROPBOX_APP_KEYを読み取り、js/dropbox-config.js を生成する。
//
// 依存パッケージを増やさないため、.envの読み取りは簡易的な自前パーサーで行う
// （dotenv相当のnpmパッケージは使わない）。
//
// 使い方:
//   ローカル: .env.example を .env にコピーしてDROPBOX_APP_KEYを設定し、
//             `node scripts/gen-dropbox-config.mjs` を実行する。
//   CI:       環境変数 DROPBOX_APP_KEY を設定した状態で実行する
//             （.github/workflows/deploy.yml 参照）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const appKey = process.env.DROPBOX_APP_KEY || loadDotEnv(join(root, '.env')).DROPBOX_APP_KEY;

if (!appKey) {
  console.error(
    'DROPBOX_APP_KEYが見つかりません。' +
      'ローカルでは .env.example を .env にコピーして値を設定してください' +
      '（CIでは環境変数 DROPBOX_APP_KEY を設定してください）。'
  );
  process.exit(1);
}

const content = `// このファイルは scripts/gen-dropbox-config.mjs により自動生成されます。
// 直接編集しないでください。値を変更する場合は .env（ローカル）または
// GitHub Actionsの Variables（DROPBOX_APP_KEY）を変更し、再生成してください。
export const DROPBOX_CONFIG = {
  appKey: ${JSON.stringify(appKey)},
};
`;

writeFileSync(join(root, 'js', 'dropbox-config.js'), content);
console.log(`js/dropbox-config.js を生成しました（App Key: ${appKey.slice(0, 4)}...）。`);
