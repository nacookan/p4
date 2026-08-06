// 任意の開発用統合テスト: js/app.js を実際にjsdom上で起動し、
// Dropbox APIをモックした状態で「新規プラン作成→保存」の一連の流れを検証する。
// 特に、保存処理の途中(非同期のfetch待ち)でも編集中の画面が消えず、
// 保存完了後に正しい画面へ遷移することを確認する（実際に見つけたバグの再発防止）。
//
// 実行方法:
//   cd tests/browser-sim && npm install && cd ../..
//   node tests/browser-sim/app-integration-test.mjs
import { JSDOM } from './node_modules/jsdom/lib/api.js';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.history = dom.window.history;

// テスト用にApp Keyのプレースホルダーを埋める（実際のDropbox通信はfetchモックが差し替える）。
const { DROPBOX_CONFIG } = await import('../../js/dropbox-config.js');
DROPBOX_CONFIG.appKey = 'test-app-key-for-integration-test';

// oauth.isConnected()がtrueを返すよう、接続済みのトークンをセッションに仕込む。
sessionStorage.setItem(
  'p4.dropbox.oauth.token',
  JSON.stringify({ accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', expiresAt: Date.now() + 3600_000 })
);

const fakeTimetable = {
  schemaVersion: 1,
  source: { fileName: 'test.pdf', sha256: 'abc123', importedAt: new Date().toISOString(), fileSizeBytes: 100 },
  validPeriod: { from: '2026-05-19', to: '2026-05-25' },
  publishedOn: '2026-05-01',
  airports: ['東京（羽田）', '大阪（伊丹）'],
  routes: [
    {
      origin: '東京（羽田）',
      dest: '大阪（伊丹）',
      flights: [{ flightNo: 'NH0001', carrier: 'ANA', dep: '07:00', arr: '08:05', operating: { mode: 'all', dates: [] } }],
    },
  ],
};
let appDataDoc = { schemaVersion: 1, settings: { recentDepartureAirports: [] }, plans: [] };
let appDataRev = 'rev-0';

// アップロードを一時停止できるようにする「保留中のresolve」
let pendingUploadResolve = null;
function makeUploadPromise() {
  return new Promise((resolve) => { pendingUploadResolve = resolve; });
}

function jsonResponse(status, bodyObj, extraHeaders = {}) {
  const headers = new Map(Object.entries(extraHeaders));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k) ?? null },
    text: async () => JSON.stringify(bodyObj),
    json: async () => bodyObj,
  };
}

globalThis.fetch = async (url, options = {}) => {
  if (url.includes('/2/files/download')) {
    const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
    if (arg.path === '/timetable.json') {
      return jsonResponse(200, fakeTimetable, { 'Dropbox-API-Result': JSON.stringify({ rev: 'rev-timetable-1' }) });
    }
    if (arg.path === '/appdata.json') {
      return jsonResponse(200, appDataDoc, { 'Dropbox-API-Result': JSON.stringify({ rev: appDataRev }) });
    }
    return jsonResponse(409, { error_summary: 'path/not_found/', error: { reason: { '.tag': 'not_found' } } });
  }
  if (url.includes('/2/files/upload')) {
    const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
    if (arg.path === '/appdata.json') {
      await makeUploadPromise(); // ここでテスト側が明示的にresolveするまで保留する
      appDataDoc = JSON.parse(options.body);
      appDataRev = 'rev-1';
      return jsonResponse(200, { rev: appDataRev });
    }
  }
  throw new Error(`unexpected fetch: ${url}`);
};

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`FAIL - ${name}`);
    console.error(e);
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

await import('../../js/app.js');
await sleep(50); // state.init()の非同期読み込み完了を待つ

const appRoot = document.getElementById('app');

test('起動後、接続済み・時刻表ありでプラン一覧が表示される', () => {
  assert.ok(appRoot.textContent.includes('プラン一覧'));
});

window.location.hash = '#/plan/new';
window.dispatchEvent(new dom.window.Event('hashchange'));
await sleep(10);

test('新規プラン画面で出発条件フォームが表示される', () => {
  assert.ok(appRoot.textContent.includes('出発条件を指定'));
});

const dateInput = appRoot.querySelector('input[type="date"]');
dateInput.value = '2026-05-19';
const airportChip = [...appRoot.querySelectorAll('.airport-chip')].find((b) => b.textContent === '東京（羽田）');
airportChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
appRoot.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(10);

const candidateBtn = appRoot.querySelector('.flight-option');
test('候補便が表示される', () => {
  assert.ok(candidateBtn, '候補便ボタンが見つかりません');
});
candidateBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
await sleep(10);

test('区間追加後、保存ボタンが表示される', () => {
  assert.ok(appRoot.textContent.includes('このプランを保存'));
});

// 保存ボタンをクリック（アップロードは意図的に保留させる）
const buttons = [...appRoot.querySelectorAll('button')];
const saveBtn = buttons.find((b) => b.textContent === 'このプランを保存');
saveBtn.click();
await sleep(10);

test('保存処理が完了する前でも、編集中の旅程画面が消えていない（バグ再発防止）', () => {
  assert.ok(appRoot.textContent.includes('合計:'), '保存中に画面が丸ごと消えてしまっている');
  assert.ok(appRoot.textContent.includes('保存しています'), '保存中バナーが表示されていない');
});

// アップロード完了を許可する（1回目: 便の保存）
pendingUploadResolve();
await sleep(30);

test('便の保存完了後、金額メモ入力画面へ遷移する', () => {
  assert.equal(window.location.hash.includes('/price'), true);
  assert.ok(appRoot.textContent.includes('金額の編集'));
});

test('appdata.jsonに実際にプランが1件保存されている', () => {
  assert.equal(appDataDoc.plans.length, 1);
  assert.equal(appDataDoc.plans[0].legs.length, 1);
});

// 金額メモ入力画面で金額を入力して保存する（2回目のアップロード）
const priceInput = appRoot.querySelector('input[type="number"]');
priceInput.value = '6480';
const priceSaveBtn = [...appRoot.querySelectorAll('button')].find((b) => b.textContent === '金額を保存');
priceSaveBtn.click();
await sleep(10);
pendingUploadResolve(); // 2回目のアップロード分もモック側で明示的に完了させる
await sleep(30);

test('金額保存後、プラン詳細画面へ遷移し合計PP・金額・PP単価が表示される', () => {
  assert.equal(window.location.hash.startsWith('#/plan/'), true);
  assert.equal(window.location.hash.includes('/price'), false);
  assert.ok(appRoot.textContent.includes('合計:'));
  assert.ok(appRoot.textContent.includes('648'));
  assert.ok(appRoot.textContent.includes('6,480円'));
  assert.ok(appRoot.textContent.includes('10.0円/PP')); // 6480/648
});

test('appdata.jsonに金額メモが保存されている', () => {
  assert.equal(appDataDoc.plans[0].legs[0].priceMemo, 6480);
});

// --- プラン削除: 保存の完了を待たず、見込みで即座に画面から消えることを確認する（実際に見つけたバグの再発防止） ---
window.location.hash = '#/plans';
window.dispatchEvent(new dom.window.Event('hashchange'));
await sleep(10);

test('プラン一覧に保存済みの1件が表示され、削除ボタンがある', () => {
  assert.ok(appRoot.textContent.includes('プラン一覧'));
  assert.ok([...appRoot.querySelectorAll('button')].some((b) => b.textContent === '削除'));
});

const deleteBtn = [...appRoot.querySelectorAll('button')].find((b) => b.textContent === '削除');
deleteBtn.click();
await sleep(10);

test('削除ボタンを押すと、window.confirm()の代わりにアプリ内の確認モーダルが出る', () => {
  const confirmBox = document.querySelector('.confirm-box');
  assert.ok(confirmBox, '確認モーダルが表示されていません');
  assert.ok(confirmBox.textContent.includes('削除しますか'));
});

const confirmOkBtn = document.querySelector('.confirm-box .btn-danger');
assert.ok(confirmOkBtn, '確認モーダルのOKボタンが見つかりません');
confirmOkBtn.click();
await sleep(10);

test('削除ボタンを押すと、保存の完了(アップロード)を待たずに即座に画面から消える（見込み削除）', () => {
  // このモックのアップロードはpendingUploadResolve()を呼ぶまで保留されるため、
  // ここではまだ削除の保存は完了していない。それでも画面からは既に消えているはず。
  assert.ok(!appRoot.textContent.includes('削除'), '削除ボタンごとカードが即座に消えているはず');
  assert.ok(appRoot.textContent.includes('保存されたプランはまだありません'), '該当プランがなくなったので空状態のメッセージが出るはず');
  assert.equal(appDataDoc.plans.length, 1, 'この時点ではDropbox側のアップロードはまだ完了していないはず');
});

await sleep(10); // fetchモックがmakeUploadPromise()まで進み、pendingUploadResolveが今回分に差し替わるのを待つ
pendingUploadResolve();
await sleep(30);

test('削除の保存が完了し、Dropbox上のデータにも反映されている', () => {
  assert.equal(appDataDoc.plans.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
