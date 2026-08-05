// 任意の開発用スモークテスト: jsdom上で各ビュー(js/views/*)を実際にDOMへ描画し、
// 例外が発生しないこと・期待するテキストが含まれることを確認する。
//
// このテストは本番アプリの動作には不要（アプリはビルド不要でそのまま動く）。
// 実行するには事前に依存関係をインストールすること:
//   cd tests/browser-sim && npm install
//   cd ../.. && node tests/browser-sim/render-smoke-test.mjs
import { JSDOM } from './node_modules/jsdom/lib/api.js';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

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

const { renderConnect } = await import('../../js/views/connect.js');
const { renderAbout } = await import('../../js/views/about.js');
const stateMod = await import('../../js/state.js');
const { renderPlanList } = await import('../../js/views/plan-list.js');
const { renderPlanEditor } = await import('../../js/views/plan-editor.js');
const { renderPlanView } = await import('../../js/views/plan-view.js');
const { renderImport } = await import('../../js/views/import.js');
const { renderSettings } = await import('../../js/views/settings.js');

test('connect view renders without throwing', () => {
  const node = renderConnect();
  document.body.appendChild(node);
  assert.ok(document.body.textContent.includes('Dropbox連携でログイン'));
});

test('about view renders without throwing', () => {
  const node = renderAbout();
  assert.ok(node.textContent.includes('航空会社が提供する公式サービスではありません'));
  assert.ok(node.textContent.includes('データの取り扱い'));
  assert.ok(node.textContent.includes('Dropbox連携について'));
});

// --- 状態を直接注入して、Dropbox接続済みを模擬する ---
const s = stateMod.getState();
s.connectivity = 'online';
s.appData = { doc: { schemaVersion: 1, settings: {}, plans: [] }, rev: 'rev-appdata-1' };
s.timetable = null;

test('plan-list view (プランなし) renders without throwing', () => {
  const node = renderPlanList();
  assert.ok(node.textContent.includes('新規プラン作成'));
  assert.ok(node.textContent.includes('保存されたプランはまだありません'));
});

test('import view renders without throwing', () => {
  const node = renderImport();
  assert.ok(node.textContent.includes('PDFファイルを選択'));
});

test('settings view renders (includes timetable import) without throwing', () => {
  const node = renderSettings();
  assert.ok(node.textContent.includes('設定'));
  assert.ok(node.textContent.includes('PDFファイルを選択'));
});

test('plan-editor view (時刻表未取込) shows guidance instead of throwing', () => {
  const node = renderPlanEditor({ mode: 'new' });
  assert.ok(node.textContent.includes('時刻表を取り込んで'));
});

// --- 時刻表を注入してプラン作成フローを検証する ---
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
s.timetable = { doc: fakeTimetable, rev: 'rev-timetable-1' };

test('plan-editor view (時刻表あり) shows the initial form', () => {
  const node = renderPlanEditor({ mode: 'new' });
  assert.ok(node.textContent.includes('出発条件を指定'));
});

test('plan-view (存在しないID) handles gracefully', () => {
  const node = renderPlanView({ planId: 'no-such-id' });
  assert.ok(node.textContent.includes('見つかりませんでした'));
});

test('plan-view (存在するプラン) renders PP details', () => {
  s.appData.doc.plans.push({
    id: 'plan-1',
    title: 'テストプラン',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
        fareClassId: 'standard', priceMemo: 12960,
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-1' });
  assert.ok(node.textContent.includes('合計:'));
  assert.ok(node.textContent.includes('648')); // 280*0.8*2+200
  assert.ok(node.textContent.includes('スタンダード'));
  assert.ok(node.textContent.includes('エコノミー'));
  assert.ok(node.textContent.includes('12,960円'), '金額は末尾に「円」を付ける表記のはず');
  assert.ok(node.textContent.includes('20.0円/PP')); // 12960/648
  assert.ok(node.textContent.includes('07:00 羽田'), '出発は時刻+略称の1行目のはず');
  assert.ok(node.textContent.includes('08:05 伊丹'), '到着は時刻+略称の2行目のはず');
  assert.ok(node.textContent.includes('(ANA運行)'), '便名セルに運航会社が2行目として統合されているはず');
  assert.ok(!node.textContent.includes('PP計算条件'), 'PP計算条件の説明カードは削除されているはず');
  const dateCell = [...node.querySelectorAll('tr.date-row td')][0];
  assert.ok(dateCell, '日付のcolspan行が見つかりません');
});

test('plan-view: 「上の便に合算」区間は自身の金額を持たず、合算元の単価計算にPPが加算される', () => {
  s.appData.doc.plans.push({
    id: 'plan-2',
    title: '乗り継ぎテストプラン',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
        priceMemo: 20000,
      },
      {
        origin: '大阪（伊丹）', dest: '東京（羽田）', flightNo: 'NH0002', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '09:00', arr: '10:05', isOvernightStay: false, airportTransfer: null,
        priceMemo: null, priceMergedWithPrevious: true,
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-2' });
  // 648 * 2区間分が合計されるはず（単区間PP計算は既存テストと同じ280*0.8*2+200）
  assert.ok(node.textContent.includes('1,296'), '合計PPは2区間分が合算されているはず');
  assert.ok(node.textContent.includes('上の便に合算'), '合算区間は「上の便に合算」と表示され、独自の金額は出さないはず');
  assert.ok(node.textContent.includes('20,000円'), '合算元の区間には入力した金額がそのまま表示されるはず');
  // 単価は 20000 / (648+648) = 15.4...円/PP
  assert.ok(node.textContent.includes('15.4円/PP'), '合算元の単価は自区間PPだけでなく合算区間PPも加えて計算されるはず');
});

test('plan-view: 飛行時間が薄字で表示され、直接乗り継ぎには「乗り継ぎ待ち」特殊行が出る', () => {
  s.appData.doc.plans.push({
    id: 'plan-3',
    title: '乗り継ぎ待ち表示テスト',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
      },
      {
        origin: '大阪（伊丹）', dest: '福岡', flightNo: 'NH9999', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '10:00', arr: '11:00', isOvernightStay: false, airportTransfer: null,
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-3' });
  const inlineDurations = [...node.querySelectorAll('.inline-muted')].map((n) => n.textContent);
  assert.ok(inlineDurations.some((t) => t.includes('(1h5m)')), '1本目の飛行時間(07:00-08:05)が薄字の(1h5m)として表示されるはず');
  assert.ok(inlineDurations.some((t) => t.includes('(1h)')), '2本目の飛行時間(10:00-11:00)が(1h)として表示されるはず');
  const connectionRow = node.querySelector('tr.connection-row');
  assert.ok(connectionRow, '乗り継ぎ待ちのcolspan特殊行が見つかりません');
  assert.ok(
    connectionRow.textContent.includes('次の出発は 1h55m 後 / 乗り継ぎ便への移動が必要'),
    '08:05到着→10:00出発の間隔1h55mが「次の出発はX後/〜が必要」の形式で表示されるはず'
  );
});

test('plan-view: 空港間の移動には所要時間が付き、空港間の移動/宿泊があるときは乗り継ぎ待ち行が出ない', () => {
  s.appData.doc.plans.push({
    id: 'plan-4',
    title: '空港間の移動テスト',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
      },
      {
        origin: '大阪（関西）', dest: '福岡', flightNo: 'NH9998', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '10:15', arr: '11:15', isOvernightStay: false,
        airportTransfer: { from: '大阪（伊丹）', to: '大阪（関西）' },
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-4' });
  const transferRow = node.querySelector('tr.transfer-row');
  assert.ok(transferRow, '空港間の移動のcolspan特殊行が見つかりません');
  assert.ok(
    transferRow.textContent.includes('次の出発は 2h10m 後 / 空港間の移動(伊丹→関西)が必要'),
    '08:05到着→10:15出発の間隔2h10mが「次の出発はX後/空港間の移動(…)が必要」の形式で表示されるはず'
  );
  assert.equal(node.querySelectorAll('tr.connection-row').length, 0, '空港間の移動があるときは乗り継ぎ待ち行を出さないはず');
});

test('plan-view: 宿泊のみのときも乗り継ぎ待ち行は出ない', () => {
  s.appData.doc.plans.push({
    id: 'plan-5',
    title: '宿泊テスト',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
      },
      {
        origin: '大阪（伊丹）', dest: '福岡', flightNo: 'NH9997', carrier: 'ANA', boardingDate: '2026-05-20',
        dep: '09:00', arr: '10:00', isOvernightStay: true, airportTransfer: null,
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-5' });
  assert.ok(node.querySelector('tr.overnight-row'), '宿泊のcolspan特殊行が見つかりません');
  assert.equal(node.querySelectorAll('tr.connection-row').length, 0, '宿泊があるときは乗り継ぎ待ち行を出さないはず');
});

test('plan-view: 空港間の移動を伴う宿泊は、宿泊行に両方の空港名が入り、空港間の移動行は出ない', () => {
  s.appData.doc.plans.push({
    id: 'plan-6',
    title: '空港間の移動を伴う宿泊テスト',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
      },
      {
        origin: '大阪（関西）', dest: '福岡', flightNo: 'NH9996', carrier: 'ANA', boardingDate: '2026-05-20',
        dep: '09:00', arr: '10:00', isOvernightStay: true,
        airportTransfer: { from: '大阪（伊丹）', to: '大阪（関西）' },
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-6' });
  assert.equal(node.querySelectorAll('tr.transfer-row').length, 0, '日をまたぐ空港間の移動は宿泊行に一本化し、空港間の移動行は出さないはず');
  const overnightRow = node.querySelector('tr.overnight-row');
  assert.ok(overnightRow, '宿泊のcolspan特殊行が見つかりません');
  assert.ok(overnightRow.textContent.includes('宿泊（伊丹・関西）'), '空港間の移動を伴う宿泊は両方の空港名が入るはず');
});

test('plan-view: 1時間未満の待ち時間は「0h30m」のように0hを補って表記する', () => {
  s.appData.doc.plans.push({
    id: 'plan-7',
    title: '短い待ち時間テスト',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timetableRef: { sha256: 'abc123', validPeriod: fakeTimetable.validPeriod },
    legs: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0001', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '07:00', arr: '08:05', isOvernightStay: false, airportTransfer: null,
      },
      {
        origin: '大阪（伊丹）', dest: '福岡', flightNo: 'NH9995', carrier: 'ANA', boardingDate: '2026-05-19',
        dep: '08:35', arr: '09:30', isOvernightStay: false, airportTransfer: null,
      },
    ],
  });
  const node = renderPlanView({ planId: 'plan-7' });
  const connectionRow = node.querySelector('tr.connection-row');
  assert.ok(connectionRow, '乗り継ぎ待ちのcolspan特殊行が見つかりません');
  assert.ok(
    connectionRow.textContent.includes('次の出発は 0h30m 後 / 乗り継ぎ便への移動が必要'),
    '08:05到着→08:35出発の30分間隔は「0h30m」と表記され、「30m」単独にはならないはず'
  );
});

test('plan-view: 運賃/座席セルには専用クラスが付き、フォントサイズを小さくしている', () => {
  const node = renderPlanView({ planId: 'plan-1' });
  assert.ok(node.querySelector('td.fare-cabin-cell'), '運賃/座席セルにfare-cabin-cellクラスが付くはず');
});

test('plan-view: PP単価評価とマイル→SKYコイン交換レート表が表示される', () => {
  // plan-1: 12,960円 / 648PP = 20.0円/PP → 「15円超」なので★1つ
  const node = renderPlanView({ planId: 'plan-1' });
  assert.ok(node.textContent.includes('PP単価評価'));
  assert.ok(!node.textContent.includes('このプランのPP単価'), '単価の再掲は不要（表の3列目でマークするだけ）');
  assert.ok(node.textContent.includes('8円以下') && node.textContent.includes('☆☆☆☆☆'), '評価基準の一覧が表示されるはず');
  const tierRows = [...node.querySelectorAll('tr.tier-row')];
  const currentTierRow = tierRows.find((r) => r.classList.contains('current'));
  assert.ok(currentTierRow && currentTierRow.textContent.includes('15円超'), '20.0円/PPは基準「15円超」に該当するはず');
  assert.ok(currentTierRow.textContent.includes('👈 20.0円/PP'), '該当する基準の行に、今回の単価そのものを書いた目印が付くはず');
  tierRows.filter((r) => r !== currentTierRow).forEach((r) => {
    assert.ok(!r.textContent.includes('👈'), '該当しない基準の行には目印が付かないはず');
  });
  assert.ok(node.textContent.includes('マイルからSKYコインに交換して購入する場合'));
  assert.ok(node.textContent.includes('実質金額(マイル)'), '実質金額(マイル)列の見出しが表示されるはず');
  const exchangeRows = [...node.querySelectorAll('table')].find((t) => t.textContent.includes('交換レート'))
    .querySelectorAll('tbody tr');
  // 1.0倍: そのままの金額(12,960円)を消費し、単価は通常のPP単価と同じ20.0円/PPのはず
  assert.ok(exchangeRows[0].textContent.includes('1.0倍'));
  assert.ok(exchangeRows[0].textContent.includes('12,960円'), '1.0倍の実質金額(マイル)は合計金額そのままのはず');
  assert.ok(exchangeRows[0].textContent.includes('20.0円/PP'));
  // 1.7倍: 1.7倍して12,960円になる金額(12960/1.7=7,623.5...→7,624円)を消費し、
  // その金額と獲得PP(648)で単価を再計算する(7623.5/648=11.76...→11.8円/PP)
  const row17 = [...exchangeRows].find((r) => r.textContent.includes('1.7倍'));
  assert.ok(row17.textContent.includes('7,624円'), '1.7倍の実質金額(マイル)は12,960÷1.7で計算されるはず');
  assert.ok(row17.textContent.includes('11.8円/PP'));
});

test('plan-editor (mode:price) 金額のみ編集して保存できる', () => {
  const node = renderPlanEditor({ mode: 'price', planId: 'plan-1' });
  document.body.appendChild(node);
  assert.ok(node.textContent.includes('金額の編集'));
  const input = node.querySelector('input[type="number"]');
  assert.ok(input, '金額入力欄が見つかりません');
  assert.equal(input.value, '12960', '既存の金額メモが初期値として入っているはず');
  assert.ok(
    node.querySelector('label').textContent.includes('07:00') && node.querySelector('label').textContent.includes('08:05'),
    '金額入力欄のラベルに出発/到着時刻(07:00/08:05)が表示されるはず'
  );
  input.value = '9800';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const saveBtn = [...node.querySelectorAll('button')].find((b) => b.textContent === '金額を保存');
  assert.ok(saveBtn);
  document.body.removeChild(node);
});

test('plan-editor (mode:price) 2区間目に「上の便に合算されています」チェックボックスが出て、チェックすると金額欄が隠れる', () => {
  const node = renderPlanEditor({ mode: 'price', planId: 'plan-2' });
  document.body.appendChild(node);
  assert.ok(node.textContent.includes('上の便(NH0001)に合算されています'), '2区間目には直前の便名を含むチェックボックスラベルが出るはず');
  const checkboxes = node.querySelectorAll('input[type="checkbox"]');
  assert.equal(checkboxes.length, 1, '1区間目には合算チェックボックスは出ないはず（上に便がないため）');
  assert.equal(checkboxes[0].checked, true, '既存データでpriceMergedWithPrevious:trueなら初期状態からチェック済みのはず');
  const numberInputs = node.querySelectorAll('input[type="number"]');
  assert.equal(numberInputs[1].style.display, 'none', '合算区間の金額入力欄は初期状態から隠れているはず');
  checkboxes[0].checked = false;
  checkboxes[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.notEqual(numberInputs[1].style.display, 'none', 'チェックを外すと金額入力欄が再び表示されるはず');
  document.body.removeChild(node);
});

test('plan-editor: 出発フォーム送信→候補選択→区間追加→保存ボタン表示までの一連の操作', () => {
  // appData.plansを一度クリアしてクリーンな状態で試す
  s.appData.doc.plans = [];
  const node = renderPlanEditor({ mode: 'new' });
  document.body.appendChild(node);

  const dateInput = node.querySelector('input[type="date"]');
  const form = node.querySelector('form');
  assert.ok(dateInput && form, '初期フォームの入力要素が見つかりません');

  dateInput.value = '2026-05-19';
  const airportChip = [...node.querySelectorAll('.airport-chip')].find((b) => b.textContent === '東京（羽田）');
  assert.ok(airportChip, '出発空港の選択肢「東京（羽田）」が見つかりません');
  airportChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

  // 運賃種別・座席クラスがそれぞれセグメントスイッチで4つ・2つ、
  // 搭乗日タブ(当日/翌日)が2つ、別々に表示される。
  const fareSwitch = node.querySelector('[aria-label="運賃種別"]').querySelectorAll('.segment-button');
  assert.equal(fareSwitch.length, 4, '運賃種別セグメントが4つ表示されるはず');
  assert.equal(fareSwitch[0].textContent, 'セール', '安い順（セールが左端）に並ぶはず');
  assert.equal(fareSwitch[3].textContent, 'フレックス', '高い運賃ほど右側に並ぶはず');
  const cabinSwitch = node.querySelector('[aria-label="座席クラス"]').querySelectorAll('.segment-button');
  assert.equal(cabinSwitch.length, 2, '座席クラスセグメントが2つ表示されるはず');
  assert.equal(cabinSwitch[0].textContent, 'エコノミークラス', '安い方（エコノミー）が左端のはず');
  assert.ok(node.textContent.includes('運賃/座席'), '運賃種別と座席クラスは1つのラベル「運賃/座席」にまとめるはず');
  const dayTabs = node.querySelector('[aria-label="搭乗日"]').querySelectorAll('.tab-button');
  assert.equal(dayTabs.length, 2, '当日/翌日の切り替えタブが2つ表示されるはず');
  assert.match(dayTabs[0].textContent, /^\d{2}\/\d{2}\(.\)$/, '日付タブは年・件数・宿泊表記を省いた MM/DD(曜) のみのはず');
  assert.match(dayTabs[1].textContent, /^\d{2}\/\d{2}\(.\)$/, '翌日タブも同様に簡潔な表記のはず');

  // NH0001は毎日運航なので、当日タブ・翌日(宿泊)タブの両方に1件ずつ候補が出る。
  let candidateButtons = node.querySelectorAll('.flight-option');
  assert.equal(candidateButtons.length, 1, '初期表示（当日タブ）には1件の候補が出るはず');
  assert.ok(candidateButtons[0].textContent.includes('NH0001'));
  assert.ok(
    candidateButtons[0].querySelector('.flight-option-times .inline-muted').textContent.includes('(1h5m)'),
    '候補一覧の時刻(07:00 → 08:05)にも薄字で飛行時間(1h5m)が表示されるはず'
  );
  const ppTextStandard = candidateButtons[0].textContent;
  // 運賃種別・座席クラスは候補一覧には表示しない（上のスイッチで選ぶため）
  assert.ok(!ppTextStandard.includes('スタンダード'));
  assert.ok(!ppTextStandard.includes('エコノミー'));

  // 運賃種別を切り替えるとPPの数値が変わる
  fareSwitch[3].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // フレックス(100%)
  candidateButtons = node.querySelectorAll('.flight-option');
  assert.notEqual(candidateButtons[0].textContent, ppTextStandard, '運賃種別切り替えでPP表示が変わるはず');

  // 翌日タブへ切り替えると宿泊バッジ付きの候補が出る
  dayTabs[1].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  candidateButtons = node.querySelectorAll('.flight-option');
  assert.equal(candidateButtons.length, 1, '翌日タブにも1件の候補が出るはず');
  assert.ok(candidateButtons[0].textContent.includes('宿泊'));

  candidateButtons[0].dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  assert.ok(node.textContent.includes('合計:') && node.textContent.includes('PP'), '区間追加後、合計PPが表示されるはず');
  // 金額入力は保存後の別画面で行うため、プラン編集画面の旅程テーブルには
  // 「金額/単価」列自体を出さない。
  assert.ok(!node.textContent.includes('金額/単価'), 'プラン編集画面の旅程テーブルに金額/単価列は無いはず');
  assert.ok(!node.textContent.includes('金額を保存'), '金額の保存ボタンはこの時点では表示されないはず');
  assert.ok(node.textContent.includes('このプランを保存'), '保存ボタンが表示されるはず');
  document.body.removeChild(node);
});

test('plan-editor: 候補一覧を行き先で絞り込めるドロップダウンが出る', () => {
  const original = s.timetable;
  const filterTimetable = {
    schemaVersion: 1,
    source: { fileName: 'test.pdf', sha256: 'filter123', importedAt: new Date().toISOString(), fileSizeBytes: 100 },
    validPeriod: { from: '2026-05-19', to: '2026-05-25' },
    publishedOn: '2026-05-01',
    airports: ['東京（羽田）', '大阪（伊丹）', '那覇'],
    routes: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）',
        flights: [{ flightNo: 'NH1001', carrier: 'ANA', dep: '07:00', arr: '08:05', operating: { mode: 'all', dates: [] } }],
      },
      {
        origin: '東京（羽田）', dest: '那覇',
        flights: [{ flightNo: 'NH1002', carrier: 'ANA', dep: '09:00', arr: '11:30', operating: { mode: 'all', dates: [] } }],
      },
    ],
  };
  s.timetable = { doc: filterTimetable, rev: 'rev-filter' };
  try {
    const node = renderPlanEditor({ mode: 'new' });
    document.body.appendChild(node);
    const dateInput = node.querySelector('input[type="date"]');
    const form = node.querySelector('form');
    dateInput.value = '2026-05-19';
    const airportChip = [...node.querySelectorAll('.airport-chip')].find((b) => b.textContent === '東京（羽田）');
    airportChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    assert.equal(node.querySelectorAll('.flight-option').length, 2, '絞り込み前は2件（伊丹行き・那覇行き）の候補が出るはず');
    const select = node.querySelector('select');
    assert.ok(select, '行き先の絞り込みドロップダウンが見つかりません');
    const optionLabels = [...select.querySelectorAll('option')].map((o) => o.textContent).sort();
    assert.deepEqual(optionLabels, ['すべて', '大阪（伊丹）', '那覇'].sort(), '選択肢は候補一覧に出ている行き先＋「すべて」のはず');

    select.value = '那覇';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const filtered = node.querySelectorAll('.flight-option');
    assert.equal(filtered.length, 1, '「那覇」で絞り込むと1件になるはず');
    assert.ok(filtered[0].textContent.includes('NH1002'));

    document.body.removeChild(node);
  } finally {
    s.timetable = original;
  }
});

test('plan-editor: 2便目以降・同じ日の候補には「到着からX後」の待ち時間が先頭に付く', () => {
  const original = s.timetable;
  const connectTimetable = {
    schemaVersion: 1,
    source: { fileName: 'test.pdf', sha256: 'connect123', importedAt: new Date().toISOString(), fileSizeBytes: 100 },
    validPeriod: { from: '2026-05-19', to: '2026-05-25' },
    publishedOn: '2026-05-01',
    airports: ['東京（羽田）', '大阪（伊丹）', '福岡'],
    routes: [
      {
        origin: '東京（羽田）', dest: '大阪（伊丹）',
        flights: [{ flightNo: 'NH2001', carrier: 'ANA', dep: '07:00', arr: '08:05', operating: { mode: 'all', dates: [] } }],
      },
      {
        origin: '大阪（伊丹）', dest: '福岡',
        flights: [{ flightNo: 'NH2002', carrier: 'ANA', dep: '09:35', arr: '10:35', operating: { mode: 'all', dates: [] } }],
      },
    ],
  };
  s.timetable = { doc: connectTimetable, rev: 'rev-connect' };
  try {
    const node = renderPlanEditor({ mode: 'new' });
    document.body.appendChild(node);
    const dateInput = node.querySelector('input[type="date"]');
    const form = node.querySelector('form');
    dateInput.value = '2026-05-19';
    const airportChip = [...node.querySelectorAll('.airport-chip')].find((b) => b.textContent === '東京（羽田）');
    airportChip.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    const firstLegOption = node.querySelector('.flight-option');
    assert.ok(firstLegOption, '1便目の候補が見つかりません');
    assert.ok(!firstLegOption.textContent.includes('到着から'), '1便目には前区間が無いので「到着から」の表記は出ないはず');
    firstLegOption.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

    const secondLegOption = node.querySelector('.flight-option');
    assert.ok(secondLegOption, '2便目の候補が見つかりません');
    assert.ok(
      secondLegOption.textContent.includes('到着から 1h30m 後 ・ NH2002'),
      '08:05到着→09:35出発の間隔1h30mが候補の先頭に「到着からX後」の形式で表示されるはず'
    );

    document.body.removeChild(node);
  } finally {
    s.timetable = original;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
