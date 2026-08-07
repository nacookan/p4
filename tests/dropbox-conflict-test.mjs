// 依存ライブラリ不要のテスト: Dropboxのリビジョン競合・認証期限切れ・通信切断・
// 壊れた保存データを、fetchをモックしてjs/state.js（本番コードそのもの）で検証する。
// DOMは使わないため、jsdom等の追加インストールは不要（node tests/dropbox-conflict-test.mjs で実行可能）。
import assert from 'node:assert/strict';

// --- 最小限のsessionStorage/localStorageポリフィル（Node用） ---
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const { DROPBOX_CONFIG } = await import('../js/dropbox-config.js');
DROPBOX_CONFIG.appKey = 'test-app-key';

// アクセストークンはlocalStorageに保存される（ホーム画面追加時のログイン維持のため）。
localStorage.setItem(
  'p4.dropbox.oauth.token',
  JSON.stringify({ accessToken: 'fake-token', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600_000 })
);

// --- Dropboxサーバーの簡易モック ---
let serverAppData = { schemaVersion: 1, settings: {}, plans: [{ id: 'p1', title: '既存プラン', legs: [] }] };
let serverRev = 'rev-1';
let mode = 'normal'; // 'normal' | 'network-down' | 'auth-expired' | 'corrupt'

function jsonResponse(status, bodyObj, extraHeaders = {}) {
  const headers = new Map(Object.entries(extraHeaders));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k) ?? null },
    text: async () => (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)),
    json: async () => (typeof bodyObj === 'string' ? JSON.parse(bodyObj) : bodyObj),
  };
}

globalThis.fetch = async (url, options = {}) => {
  if (mode === 'network-down') throw new Error('network down (simulated)');

  if (url.includes('/2/files/download')) {
    if (mode === 'auth-expired') return jsonResponse(401, { error_summary: 'expired_access_token/' });
    const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
    if (arg.path === '/appdata.json') {
      if (mode === 'corrupt') {
        return jsonResponse(200, '{not valid json', { 'Dropbox-API-Result': JSON.stringify({ rev: serverRev }) });
      }
      return jsonResponse(200, serverAppData, { 'Dropbox-API-Result': JSON.stringify({ rev: serverRev }) });
    }
    if (arg.path === '/timetable.json') {
      return jsonResponse(409, { error: { reason: { '.tag': 'not_found' } } });
    }
  }
  if (url.includes('/2/files/upload')) {
    if (mode === 'auth-expired') return jsonResponse(401, { error_summary: 'expired_access_token/' });
    const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
    if (arg.path === '/appdata.json') {
      if (arg.mode['.tag'] === 'update' && arg.mode.update !== serverRev) {
        return jsonResponse(409, { error_summary: 'path/conflict/' });
      }
      serverAppData = JSON.parse(options.body);
      serverRev = `rev-${Math.random().toString(36).slice(2, 8)}`;
      return jsonResponse(200, { rev: serverRev });
    }
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const state = await import('../js/state.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`FAIL - ${name}`);
    console.error(e);
  }
}

await test('起動時にDropbox上のデータを読み込める', async () => {
  await state.init();
  assert.equal(state.getState().connectivity, 'online');
  assert.equal(state.getState().appData.doc.plans.length, 1);
});

await test('複数端末相当のリビジョン競合: 他クライアントの更新後は保存が失敗し、データを失わずに再読込する', async () => {
  // 「別の端末」が先に保存してrevを進める
  serverAppData = { ...serverAppData, plans: [...serverAppData.plans, { id: 'p2', title: '他端末が追加したプラン', legs: [] }] };
  serverRev = 'rev-from-other-device';

  // このクライアントは古いrevのまま、別の変更を保存しようとする
  const staleDoc = { ...state.getState().appData.doc, plans: [...state.getState().appData.doc.plans, { id: 'p3', title: 'この端末の変更', legs: [] }] };
  const res = await state.saveAppData(staleDoc);

  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  // 他端末の変更(p2)が失われず、こちらの未保存の変更(p3)は保存されていないこと
  const ids = state.getState().appData.doc.plans.map((p) => p.id);
  assert.ok(ids.includes('p2'));
  assert.ok(!ids.includes('p3'));
});

await test('認証期限切れ: 保存に失敗し、未接続状態に遷移する', async () => {
  mode = 'auth-expired';
  const res = await state.saveAppData(state.getState().appData.doc);
  assert.equal(res.ok, false);
  assert.equal(state.getState().connectivity, 'unauthenticated');
  mode = 'normal';
  localStorage.setItem('p4.dropbox.oauth.token', JSON.stringify({ accessToken: 'fake-token-2', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600_000 }));
  await state.init();
});

await test('通信切断: 保存に失敗し、保存成功として扱われない', async () => {
  mode = 'network-down';
  const before = JSON.stringify(state.getState().appData.doc);
  const res = await state.saveAppData({ ...state.getState().appData.doc, plans: [] });
  assert.equal(res.ok, false);
  assert.equal(state.getState().connectivity, 'offline');
  // ローカルの表示データも「保存済み」として書き換わっていないこと
  assert.equal(JSON.stringify(state.getState().appData.doc), before);
  mode = 'normal';
});

await test('壊れた保存データ: 黙って上書きせずエラー扱いにする', async () => {
  mode = 'corrupt';
  await state.init();
  assert.equal(state.getState().dataError !== null, true);
  mode = 'normal';
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
