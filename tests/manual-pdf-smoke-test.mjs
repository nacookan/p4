// 手動スモークテスト: 実際のPDF時刻表を、本番コードそのものである
// js/pdf/tokenize.js と js/pdf/date-rules.js にかけて解析結果を確認する。
//
// PDFのテキスト抽出には pdf.js の "legacy" ビルドを使う（Node実行のため）。
// 本番アプリ（ブラウザ）はvendor/pdfjs/の通常ビルドを使用しており、ここでの
// legacyビルド使用はNode上でのテキスト抽出のみに限定した検証用の対応であり、
// アプリ本体のコード(js/pdf/parser.js等)は変更しない。
//
// 実行方法:
//   1. PDF時刻表をダウンロードする
//      https://www.ana.co.jp/ja/jp/guide/plan/airinfo/dom-timetable/
//   2. npm経由などでpdfjs-distを一時的に用意し、以下を実行:
//        node tests/manual-pdf-smoke-test.mjs <ダウンロードしたPDFのパス> <pdfjs-distのlegacy/buildディレクトリ>
//
// このPDFファイル自体はリポジトリにコミットしないこと（再配布を避けるため）。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripBoilerplate, extractPeriodFromTokens, parseRows, mergeDuplicateRouteBlocks } from '../js/pdf/tokenize.js';
import { normalizeOperatingDays } from '../js/pdf/date-rules.js';
import { isKnownCarrier } from '../js/data/carriers.js';
import { normalizeRadicals, mergeNameFragments } from '../js/pdf/normalize-text.js';

globalThis.DOMMatrix = class DOMMatrix {
  constructor(init) {
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    if (Array.isArray(init) && init.length === 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init;
  }
  multiplySelf(m) {
    const a = this.a, b = this.b, c = this.c, d = this.d, e = this.e, f = this.f;
    this.a = a * m.a + c * m.b; this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d; this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e; this.f = b * m.e + d * m.f + f;
    return this;
  }
  translate(x, y) {
    return new DOMMatrix([this.a, this.b, this.c, this.d, this.e + x * this.a + y * this.c, this.f + x * this.b + y * this.d]);
  }
  is2D = true;
};
globalThis.Path2D = class Path2D { moveTo() {} lineTo() {} };

const pdfPath = process.argv[2];
const pdfjsLegacyDir = process.argv[3];
if (!pdfPath || !pdfjsLegacyDir) {
  console.error('使い方: node tests/manual-pdf-smoke-test.mjs <PDF時刻表のパス> <pdfjs-distのlegacy/buildディレクトリ>');
  process.exit(1);
}

const pdfjsLib = await import(pathToFileURL(`${pdfjsLegacyDir}/pdf.mjs`).href);
const data = new Uint8Array(readFileSync(pdfPath));
const doc = await pdfjsLib.getDocument({
  data,
  cMapUrl: pathToFileURL(`${pdfjsLegacyDir}/../cmaps/`).href,
  cMapPacked: true,
  disableFontFace: true,
  isEvalSupported: false,
}).promise;

console.log(`ページ数: ${doc.numPages}`);

const allTokens = [];
const periodsFound = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  const rawItems = content.items.map((it) => (it.str || '').trim()).filter((s) => s.length > 0).map(normalizeRadicals);
  const period = extractPeriodFromTokens(rawItems);
  if (period) periodsFound.push(period);
  const merged = mergeNameFragments(rawItems);
  const cleaned = stripBoilerplate(merged);
  for (const tok of cleaned) allTokens.push({ page: p, tok });
}

console.log('検出した対象期間:', JSON.stringify(periodsFound[0]));
const inconsistent = periodsFound.filter((p) => JSON.stringify(p) !== JSON.stringify(periodsFound[0]));
console.log('期間の不一致件数:', inconsistent.length);

const { routes: rawRoutes, anomalies } = parseRows(allTokens);
console.log('路線ブロック数(重複統合前):', rawRoutes.length);
console.log('解析異常(anomalies):', anomalies.length);
if (anomalies.length > 0) console.log(anomalies.slice(0, 20));

const { routes } = mergeDuplicateRouteBlocks(rawRoutes);
console.log('路線数(重複統合後):', routes.length);

let totalFlights = 0;
let unknownCarrier = 0;
let unparsedRemark = 0;
const airports = new Set();
for (const r of routes) {
  airports.add(r.origin);
  airports.add(r.dest);
  for (const row of r.rows) {
    totalFlights += 1;
    if (!isKnownCarrier(row.carrier)) unknownCarrier += 1;
    const rule = normalizeOperatingDays(row.remark, periodsFound[0]);
    if (rule.mode === 'unparsed') unparsedRemark += 1;
  }
}

console.log('空港数:', airports.size);
console.log('便データ行数:', totalFlights);
console.log('未知の運航会社コード件数:', unknownCarrier);
console.log('解釈できなかった運航日備考件数:', unparsedRemark);
console.log('\n=== 判定 ===');
const ok = anomalies.length === 0 && inconsistent.length === 0 && totalFlights > 0 && unknownCarrier === 0 && unparsedRemark <= 1;
console.log(ok ? 'OK: 実PDFを問題なく解析できました。' : 'NG: 上記の異常を確認してください。');
