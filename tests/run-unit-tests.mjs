// 依存ライブラリ不要の最小テストランナー。
// 実行方法: node tests/run-unit-tests.mjs
// PDFやDropbox実接続を必要としない純粋ロジック（トークン解析・日付ルール・
// PP計算・旅程ロジック・スキーマ検証）を検証する。
import assert from 'node:assert/strict';

import { stripBoilerplate, parseRows, extractPeriodFromTokens, mergeDuplicateRouteBlocks } from '../js/pdf/tokenize.js';
import { normalizeRadicals, mergeNameFragments } from '../js/pdf/normalize-text.js';
import { normalizeOperatingDays, operatesOnDate, expandDateList } from '../js/pdf/date-rules.js';
import { lookupBaseMileage, cityGroupOf } from '../js/data/mileage-table.js';
import { calculateSegmentPP, calculateItineraryPP } from '../js/domain/pp-calculator.js';
import {
  findNextFlightCandidates,
  eligibleDepartureAirports,
  airportTransferInfo,
  validateItineraryChain,
  resolveArrivalDate,
} from '../js/domain/itinerary.js';
import {
  validateTimetableDoc,
  validateAppDataDoc,
  emptyAppData,
  TIMETABLE_SCHEMA_VERSION,
  withRecentAirport,
  withRecentAirports,
  MAX_RECENT_AIRPORTS,
} from '../js/domain/schema.js';
import { isKnownCarrier } from '../js/data/carriers.js';
import { abbreviateAirport } from '../js/util/airport-name.js';
import { formatDateShortJa } from '../js/util/time.js';

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failures.push({ name, error: e });
  }
}

function tok(page, arr) {
  return arr.map((t) => ({ page, tok: t }));
}

// ---------------------------------------------------------------------------
// tokenize.js
// ---------------------------------------------------------------------------

test('stripBoilerplate: ページ表題・注意書き・見出しを除去する（地名結合後の入力を前提）', () => {
  const raw = [
    '国内線時刻表', '2026', '/', '03', '/', '29', '~', '2026', '/', '06', '/', '30',
    '（', '2026', '年', '1', '月', '29', '日', '現在）',
    '最新のスケジュール、機種やサービスなどの情報は、オンライン時刻表、', 'ANA', '空席照会よりご確認ください', '航空券の予約・購入はこちら',
    '東京', '（羽田）', '発着', '2026', '/', '03', '/', '29', '~', '2026', '/', '06', '/', '30',
    '（', '2026', '年', '1', '月', '29', '日', '現在）',
    '東京（羽田）', '→', '大阪（伊丹）',
    '便名', '出発', '到着', '運航社', '備考',
    'NH0985', '06:20', '07:25', 'ANA',
    '当ダイヤは2026年1月29日時点のものであり…',
  ];
  const merged = mergeNameFragments(raw.map(normalizeRadicals));
  const cleaned = stripBoilerplate(merged);
  assert.deepEqual(cleaned, [
    '東京（羽田）', '→', '大阪（伊丹）',
    '便名', '出発', '到着', '運航社', '備考',
    'NH0985', '06:20', '07:25', 'ANA',
  ]);
});

test('normalizeRadicals: 康熙部首ブロックの文字を通常のCJK統合漢字に戻す', () => {
  assert.equal(normalizeRadicals('⽻⽥'), '羽田');
  assert.equal(normalizeRadicals('⼤阪（関⻄）'), '大阪（関西）');
  assert.equal(normalizeRadicals('東京'), '東京'); // 該当しない文字列はそのまま
});

test('mergeNameFragments: 分割された地名トークンを1つに結合する', () => {
  const tokens = ['東京（', '羽', '田', '）', '→', '大', '阪（関', '西', '）', '便名', '出発'];
  assert.deepEqual(mergeNameFragments(tokens), ['東京（羽田）', '→', '大阪（関西）', '便名', '出発']);
});

test('mergeNameFragments: 予約語（表構造の見出し）は隣接結合しない', () => {
  const tokens = ['大阪（伊丹）', '便名', '出発', '到着', '運航社', '備考'];
  assert.deepEqual(mergeNameFragments(tokens), tokens);
});

test('mergeDuplicateRouteBlocks: 両端の空港ページに重複掲載される同一路線を1つに統合する', () => {
  const blocks = [
    {
      origin: '東京（羽田）', dest: '大阪（関西）',
      rows: [
        { flightNo: 'NH0093', dep: '07:25', arr: '08:40', carrier: 'ANA', remark: '7/1-31運航。', page: 2 },
        { flightNo: 'NH0093', dep: '07:25', arr: '08:40', carrier: 'AKX', remark: '9/29運航。', page: 2 },
      ],
    },
    {
      // 大阪発着ページに再掲載された同一路線（重複）
      origin: '東京（羽田）', dest: '大阪（関西）',
      rows: [
        { flightNo: 'NH0093', dep: '07:25', arr: '08:40', carrier: 'ANA', remark: '7/1-31運航。', page: 20 },
        { flightNo: 'NH0093', dep: '07:25', arr: '08:40', carrier: 'AKX', remark: '9/29運航。', page: 20 },
      ],
    },
  ];
  const { routes } = mergeDuplicateRouteBlocks(blocks);
  assert.equal(routes.length, 1);
  // 完全一致する行は1つにまとめられ、正当な日付バリエーション行(ANA/AKX)はどちらも残る
  assert.equal(routes[0].rows.length, 2);
});

test('extractPeriodFromTokens: 対象期間と確認日を抽出する', () => {
  const raw = ['国内線時刻表', '2026', '/', '03', '/', '29', '~', '2026', '/', '06', '/', '30', '（', '2026', '年', '1', '月', '29', '日', '現在）'];
  const period = extractPeriodFromTokens(raw);
  assert.deepEqual(period, { from: '2026-03-29', to: '2026-06-30', publishedOn: '2026-01-29' });
});

test('parseRows: 便名が複数行にまたがるケース（同一便名・複数バリエーション）', () => {
  const tokens = tok(1, [
    '東京（羽田）', '→', '大阪（伊丹）',
    '便名', '出発', '到着', '運航社', '備考',
    'NH0021',
    '11:00', '12:05', 'ANA', '6/1-11,13-15', '運航。',
    '11:05', '12:10', 'ANA', '6/12,16', '運航。',
    'NH0023', '12:00', '13:10', 'ANA',
  ]);
  const { routes, anomalies } = parseRows(tokens);
  assert.equal(anomalies.length, 0);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].rows.length, 3);
  assert.equal(routes[0].rows[0].flightNo, 'NH0021');
  assert.equal(routes[0].rows[1].flightNo, 'NH0021');
  assert.equal(routes[0].rows[1].dep, '11:05');
  assert.equal(routes[0].rows[2].flightNo, 'NH0023');
});

test('parseRows: 複数路線・ページをまたいだ連結', () => {
  const tokens = [
    ...tok(1, ['東京（羽田）', '→', '大阪（伊丹）', '便名', '出発', '到着', '運航社', '備考', 'NH0001', '07:00', '08:05', 'ANA']),
    ...tok(2, ['東京（羽田）', '→', '札幌（新千歳）', '便名', '出発', '到着', '運航社', '備考', 'NH0051', '07:00', '08:30', 'ANA']),
  ];
  const { routes } = parseRows(tokens);
  assert.equal(routes.length, 2);
  assert.equal(routes[1].origin, '東京（羽田）');
  assert.equal(routes[1].dest, '札幌（新千歳）');
});

// ---------------------------------------------------------------------------
// date-rules.js
// ---------------------------------------------------------------------------

const PERIOD = { from: '2026-03-29', to: '2026-06-30' };

test('expandDateList: 月をまたぐ日リストの展開（月省略時は直前の月を継承）', () => {
  const { dates, errors } = expandDateList('3/29-31,4/1-3,5,6-7', PERIOD);
  assert.equal(errors.length, 0);
  assert.deepEqual(dates, ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-04-07']);
});

test('normalizeOperatingDays: 備考なしは毎日運航', () => {
  const rule = normalizeOperatingDays('', PERIOD);
  assert.equal(rule.mode, 'all');
  assert.equal(operatesOnDate(rule, '2026-04-15', PERIOD), true);
});

test('normalizeOperatingDays: 「運航。」は限定日のみ運航', () => {
  const rule = normalizeOperatingDays('6/12,16運航。', PERIOD);
  assert.equal(rule.mode, 'include');
  assert.equal(operatesOnDate(rule, '2026-06-12', PERIOD), true);
  assert.equal(operatesOnDate(rule, '2026-06-13', PERIOD), false);
});

test('normalizeOperatingDays: 「運休。」は除外日以外運航', () => {
  const rule = normalizeOperatingDays('6/12運休。', PERIOD);
  assert.equal(rule.mode, 'exclude');
  assert.equal(operatesOnDate(rule, '2026-06-12', PERIOD), false);
  assert.equal(operatesOnDate(rule, '2026-06-13', PERIOD), true);
});

test('normalizeOperatingDays: 未知形式はunparsedとして運航しない扱い', () => {
  const rule = normalizeOperatingDays('団体専用便のみ運航', PERIOD);
  assert.equal(rule.mode, 'unparsed');
  assert.equal(operatesOnDate(rule, '2026-04-01', PERIOD), false);
});

test('normalizeOperatingDays: 存在しない日付はunparsed扱いになる', () => {
  const rule = normalizeOperatingDays('2/30運航。', PERIOD);
  assert.equal(rule.mode, 'unparsed');
});

// ---------------------------------------------------------------------------
// mileage-table.js
// ---------------------------------------------------------------------------

test('lookupBaseMileage: 双方向・都市グループ丸めで一致した値を返す', () => {
  assert.equal(lookupBaseMileage('東京（羽田）', '大阪（伊丹）'), 280);
  assert.equal(lookupBaseMileage('大阪（関西）', '東京（成田）'), 280); // 往復・空港違いでも同一都市グループなら同じ
  assert.equal(cityGroupOf('大阪（関西）'), '大阪');
});

test('lookupBaseMileage: 存在しない組み合わせはnull（推測しない）', () => {
  assert.equal(lookupBaseMileage('東京（羽田）', '存在しない空港'), null);
});

// ---------------------------------------------------------------------------
// pp-calculator.js
// ---------------------------------------------------------------------------

test('calculateSegmentPP: 羽田-伊丹（基本マイル280, 端数なし）', () => {
  const r = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-19' });
  assert.equal(r.pp, Math.floor(280 * 0.8 * 2) + 200);
  assert.equal(r.pp, 648);
});

test('calculateSegmentPP: 伊丹-福岡（287×0.8×2=459.2 → 切り捨て459）で端数処理を検証', () => {
  // 積算率適用の段階(287×0.8=229.6)で先に切り捨てると229×2+200=658になり、
  // 公式サイトでの実測値(659)より1少なくなってしまう既知の不具合の回帰テスト。
  // 路線倍率まで掛けた後に切り捨てることで正しく459(=229.6*2=459.2の切り捨て)になる。
  const r = calculateSegmentPP({ origin: '大阪（伊丹）', dest: '福岡', carrier: 'ANA', boardingDate: '2026-05-19' });
  assert.equal(r.breakdown.flightMile, 459);
  assert.equal(r.pp, 459 + 200);
  assert.equal(r.pp, 659);
});

test('calculateSegmentPP: 適用開始日(2026-05-19)より前は計算不能', () => {
  const r = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-18' });
  assert.equal(r.pp, null);
});

test('calculateSegmentPP: 未知の運航会社コードは計算不能', () => {
  const r = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ZZZ', boardingDate: '2026-05-19' });
  assert.equal(r.pp, null);
});

test('calculateSegmentPP: ANA便名のコードシェア便（既知キャリア）は計算できる', () => {
  const r = calculateSegmentPP({ origin: '大阪（伊丹）', dest: '福岡', carrier: 'SFJ', boardingDate: '2026-05-19' });
  assert.ok(r.pp !== null);
  assert.ok(isKnownCarrier('SFJ'));
});

test('calculateItineraryPP: 合計は各区間の合計と一致する', () => {
  const legs = [
    { origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-19' },
    { origin: '大阪（伊丹）', dest: '福岡', carrier: 'ANA', boardingDate: '2026-05-19' },
  ];
  const { results, totalPP } = calculateItineraryPP(legs);
  const sum = results.reduce((s, r) => s + (r.result.pp || 0), 0);
  assert.equal(totalPP, sum);
  assert.equal(totalPP, 648 + 659);
});

test('calculateSegmentPP: 座席クラス指定なしはエコノミー・スタンダード扱い（既定値）', () => {
  const withDefaults = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-19' });
  const explicit = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-19', cabinClassId: 'economy', fareClassId: 'standard' });
  assert.equal(withDefaults.pp, explicit.pp);
  assert.equal(withDefaults.pp, 648);
});

test('calculateSegmentPP: ファーストクラスは座席クラスごとに異なる積算率が適用される', () => {
  // 羽田-伊丹 基本マイル280。ファーストクラス・フレックス=150%・路線倍率2倍 → floor(280*1.5*2)=840
  const r = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-19', cabinClassId: 'first', fareClassId: 'flex' });
  assert.equal(r.breakdown.flightMile, 840);
  assert.equal(r.pp, 840 + 400);
  assert.equal(r.pp, 1240);
});

test('calculateSegmentPP: ファーストクラスのセールは搭乗ポイントが0pt（他の運賃種別と異なる）', () => {
  const r = calculateSegmentPP({ origin: '東京（羽田）', dest: '大阪（伊丹）', carrier: 'ANA', boardingDate: '2026-05-19', cabinClassId: 'first', fareClassId: 'sale' });
  assert.equal(r.breakdown.boardingPoints, 0);
});

// ---------------------------------------------------------------------------
// util/airport-name.js
// ---------------------------------------------------------------------------

test('abbreviateAirport: カッコ書きがあればカッコ内を略称にする', () => {
  assert.equal(abbreviateAirport('大阪（伊丹）'), '伊丹');
  assert.equal(abbreviateAirport('東京（羽田）'), '羽田');
});

test('abbreviateAirport: カッコ書きが無ければそのままの名前を使う', () => {
  assert.equal(abbreviateAirport('仙台'), '仙台');
  assert.equal(abbreviateAirport('石垣'), '石垣');
});

test('formatDateShortJa: 年を省略した MM/DD(曜) 形式にする', () => {
  assert.equal(formatDateShortJa('2026-09-10'), '09/10(木)');
});

// ---------------------------------------------------------------------------
// domain/itinerary.js
// ---------------------------------------------------------------------------

const miniTimetable = {
  validPeriod: { from: '2026-05-19', to: '2026-05-25' },
  airports: ['東京（羽田）', '大阪（伊丹）', '大阪（関西）', '福岡'],
  routes: [
    {
      origin: '東京（羽田）', dest: '大阪（伊丹）',
      flights: [
        { flightNo: 'NH0001', carrier: 'ANA', dep: '07:00', arr: '08:05', operating: { mode: 'all', dates: [] } },
        { flightNo: 'NH0003', carrier: 'ANA', dep: '09:00', arr: '10:05', operating: { mode: 'all', dates: [] } },
      ],
    },
    {
      origin: '大阪（伊丹）', dest: '福岡',
      flights: [{ flightNo: 'NH0011', carrier: 'ANA', dep: '11:00', arr: '12:10', operating: { mode: 'all', dates: [] } }],
    },
    {
      origin: '大阪（関西）', dest: '福岡',
      flights: [{ flightNo: 'NH8811', carrier: 'SFJ', dep: '11:30', arr: '12:40', operating: { mode: 'all', dates: [] } }],
    },
    {
      origin: '福岡', dest: '東京（羽田）',
      flights: [
        { flightNo: 'NH0099', carrier: 'ANA', dep: '20:00', arr: '21:30', operating: { mode: 'include', dates: ['2026-05-20'] } },
      ],
    },
  ],
};

test('findNextFlightCandidates: 基準時刻より前の当日便は除外される（翌日分は残る）', () => {
  const cs = findNextFlightCandidates(miniTimetable, ['東京（羽田）'], '2026-05-19', '08:00');
  const sameDayFlightNos = cs.filter((c) => c.boardingDate === '2026-05-19').map((c) => c.flightNo);
  assert.ok(!sameDayFlightNos.includes('NH0001')); // 07:00発は基準08:00より前なので当日分は除外
  assert.ok(sameDayFlightNos.includes('NH0003'));
  // 翌日分は時刻を問わず候補に残る（宿泊を伴う翌日便として）
  assert.ok(cs.some((c) => c.flightNo === 'NH0001' && c.boardingDate === '2026-05-20' && c.isOvernightStay));
});

test('findNextFlightCandidates: 2日以上先の便は候補に出ない', () => {
  const cs = findNextFlightCandidates(miniTimetable, ['福岡'], '2026-05-19', '00:00');
  // NH0099は5/20のみ運航。基準日5/19なら翌日として候補に入るはず。
  assert.ok(cs.some((c) => c.flightNo === 'NH0099' && c.boardingDate === '2026-05-20'));
  const cs2 = findNextFlightCandidates(miniTimetable, ['福岡'], '2026-05-18', '00:00');
  // 基準日5/18からは翌日5/19までしか候補に出ない＝5/20運航のNH0099は出ない
  assert.ok(!cs2.some((c) => c.flightNo === 'NH0099'));
});

test('eligibleDepartureAirports: 伊丹・関西・神戸は相互に選択可能', () => {
  assert.deepEqual(
    eligibleDepartureAirports('大阪（伊丹）').sort(),
    ['大阪（伊丹）', '大阪（関西）', '大阪（神戸）'].sort()
  );
  assert.deepEqual(
    eligibleDepartureAirports('大阪（神戸）').sort(),
    ['大阪（伊丹）', '大阪（関西）', '大阪（神戸）'].sort()
  );
  assert.deepEqual(eligibleDepartureAirports('福岡'), ['福岡']);
});

test('eligibleDepartureAirports: 羽田・成田も相互に選択可能', () => {
  assert.deepEqual(eligibleDepartureAirports('東京（羽田）').sort(), ['東京（羽田）', '東京（成田）'].sort());
  assert.deepEqual(eligibleDepartureAirports('東京（成田）').sort(), ['東京（羽田）', '東京（成田）'].sort());
});

test('airportTransferInfo: 伊丹→関西は空港間の移動として検出される', () => {
  const t = airportTransferInfo('大阪（伊丹）', '大阪（関西）');
  assert.deepEqual(t, { from: '大阪（伊丹）', to: '大阪（関西）' });
  assert.equal(airportTransferInfo('大阪（伊丹）', '大阪（伊丹）'), null);
});

test('airportTransferInfo: 神戸も伊丹・関西との間で空港間の移動として検出される', () => {
  assert.deepEqual(airportTransferInfo('大阪（伊丹）', '大阪（神戸）'), { from: '大阪（伊丹）', to: '大阪（神戸）' });
  assert.deepEqual(airportTransferInfo('大阪（神戸）', '大阪（関西）'), { from: '大阪（神戸）', to: '大阪（関西）' });
});

test('airportTransferInfo: 羽田→成田も空港間の移動として検出される', () => {
  const t = airportTransferInfo('東京（羽田）', '東京（成田）');
  assert.deepEqual(t, { from: '東京（羽田）', to: '東京（成田）' });
});

test('findNextFlightCandidates: 大阪特例で伊丹到着後に関西発の便も候補に入る', () => {
  const airports = eligibleDepartureAirports('大阪（伊丹）');
  const cs = findNextFlightCandidates(miniTimetable, airports, '2026-05-19', '10:30');
  assert.ok(cs.some((c) => c.route.origin === '大阪（伊丹）' && c.flightNo === 'NH0011'));
  assert.ok(cs.some((c) => c.route.origin === '大阪（関西）' && c.flightNo === 'NH8811'));
});

test('validateItineraryChain: 整合した旅程はvalid', () => {
  const legs = [
    { origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH0003', carrier: 'ANA', dep: '09:00', arr: '10:05', boardingDate: '2026-05-19' },
    { origin: '大阪（伊丹）', dest: '福岡', flightNo: 'NH0011', carrier: 'ANA', dep: '11:00', arr: '12:10', boardingDate: '2026-05-19' },
  ];
  const r = validateItineraryChain(miniTimetable, legs);
  assert.equal(r.valid, true);
});

test('validateItineraryChain: 存在しない便は不整合として検出される', () => {
  const legs = [
    { origin: '東京（羽田）', dest: '大阪（伊丹）', flightNo: 'NH9999', carrier: 'ANA', dep: '09:00', arr: '10:05', boardingDate: '2026-05-19' },
  ];
  const r = validateItineraryChain(miniTimetable, legs);
  assert.equal(r.valid, false);
  assert.equal(r.brokenAtIndex, 0);
});

test('validateItineraryChain: 同一便名で日付/運航会社違いの複数バリエーションがあっても正しいバリエーションで判定する（実際にあったバグの回帰テスト）', () => {
  // NH1863のような、同じ便名・同じ出発/到着時刻でも運航会社と運航日が異なる
  // 2つの行がある場合、leg（実際に選ばれたバリエーション）と一致する行で
  // 運航日を判定しなければならない。便名だけで検索すると、配列内でたまたま
  // 先に見つかった別バリエーションの運航日で誤判定してしまう。
  const tt = {
    validPeriod: { from: '2026-07-01', to: '2026-10-24' },
    routes: [
      {
        origin: '東京（羽田）',
        dest: '那覇',
        flights: [
          { flightNo: 'NH1863', carrier: 'ANA', dep: '07:00', arr: '09:40', operating: { mode: 'include', dates: ['2026-07-15'] } },
          { flightNo: 'NH1863', carrier: 'AKX', dep: '07:00', arr: '09:40', operating: { mode: 'include', dates: ['2026-09-08'] } },
        ],
      },
    ],
  };
  const legs = [
    { origin: '東京（羽田）', dest: '那覇', flightNo: 'NH1863', carrier: 'AKX', dep: '07:00', arr: '09:40', boardingDate: '2026-09-08' },
  ];
  const r = validateItineraryChain(tt, legs);
  assert.equal(r.valid, true, r.message);
});

test('resolveArrivalDate: 到着が翌日になる便を正しく判定', () => {
  assert.equal(resolveArrivalDate('2026-05-19', '23:30', '00:40'), '2026-05-20');
  assert.equal(resolveArrivalDate('2026-05-19', '09:00', '10:05'), '2026-05-19');
});

// ---------------------------------------------------------------------------
// schema.js
// ---------------------------------------------------------------------------

test('validateAppDataDoc: 空データは有効', () => {
  const r = validateAppDataDoc(emptyAppData());
  assert.equal(r.ok, true);
});

test('validateAppDataDoc: 壊れたデータは無効として検出される', () => {
  const r = validateAppDataDoc({ schemaVersion: 1, settings: {}, plans: 'not-an-array' });
  assert.equal(r.ok, false);
});

test('withRecentAirport: 先頭追加され、重複は除去される', () => {
  let settings = { recentDepartureAirports: ['大阪（伊丹）', '東京（羽田）'] };
  settings = withRecentAirport(settings, '那覇');
  assert.deepEqual(settings.recentDepartureAirports, ['那覇', '大阪（伊丹）', '東京（羽田）']);
  settings = withRecentAirport(settings, '東京（羽田）');
  assert.deepEqual(settings.recentDepartureAirports, ['東京（羽田）', '那覇', '大阪（伊丹）'], '既存の項目は先頭に移動し、重複は残らないはず');
});

test('withRecentAirport: 最大件数で切り詰められる', () => {
  let settings = { recentDepartureAirports: [] };
  for (let i = 0; i < MAX_RECENT_AIRPORTS + 3; i++) {
    settings = withRecentAirport(settings, `空港${i}`);
  }
  assert.equal(settings.recentDepartureAirports.length, MAX_RECENT_AIRPORTS);
  assert.equal(settings.recentDepartureAirports[0], `空港${MAX_RECENT_AIRPORTS + 2}`);
});

test('withRecentAirports: プランで発着したすべての空港（出発地に限らない）が最近使った扱いになる', () => {
  let settings = { recentDepartureAirports: [] };
  // 東京（羽田）→大阪（伊丹）→那覇 という旅程を保存した想定。
  settings = withRecentAirports(settings, ['東京（羽田）', '大阪（伊丹）', '那覇']);
  assert.deepEqual(settings.recentDepartureAirports, ['東京（羽田）', '大阪（伊丹）', '那覇'], '旅程順（出発地が先頭）で並ぶはず');
});

test('withRecentAirports: 既存の履歴と重複する到着地も先頭側に繰り上がる', () => {
  let settings = { recentDepartureAirports: ['福岡', '那覇'] };
  settings = withRecentAirports(settings, ['東京（羽田）', '福岡']);
  assert.deepEqual(settings.recentDepartureAirports, ['東京（羽田）', '福岡', '那覇'], '出発地に限らず到着地の福岡も最近使った扱いになるはず');
});

test('validateTimetableDoc: スキーマバージョン不一致を検出する', () => {
  const r = validateTimetableDoc({
    schemaVersion: 999,
    source: { sha256: 'x' },
    validPeriod: { from: '2026-01-01', to: '2026-02-01' },
    airports: [],
    routes: [],
  });
  assert.equal(r.ok, false);
  assert.notEqual(TIMETABLE_SCHEMA_VERSION, 999);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\nFAIL: ${f.name}`);
    console.error(f.error);
  }
  process.exit(1);
}
