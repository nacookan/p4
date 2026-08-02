// PDF時刻表の取り込みエントリポイント。
// ブラウザ内でのみ処理し、外部へ送信しない。
import { stripBoilerplate, extractPeriodFromTokens, parseRows, mergeDuplicateRouteBlocks } from './tokenize.js';
import { normalizeOperatingDays } from './date-rules.js';
import { isKnownCarrier } from '../data/carriers.js';
import { normalizeRadicals, mergeNameFragments } from './normalize-text.js';

const PDFJS_URL = new URL('../../vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const PDFJS_WORKER_URL = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const PDFJS_CMAPS_URL = new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href;

// 現実的な防御: 極端に大きい/長いPDFでUIがフリーズしないよう上限を設ける。
export const MAX_PDF_BYTES = 60 * 1024 * 1024; // 60MB
export const MAX_PAGES = 400;

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(/* @vite-ignore */ PDFJS_URL).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return mod;
    });
  }
  return pdfjsLibPromise;
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * @typedef {object} ParseReport
 * @property {boolean} ok
 * @property {object|null} timetable
 * @property {object[]} fatalErrors
 * @property {object[]} warnings
 * @property {object} stats
 */

/**
 * PDF時刻表を解析する。
 * @param {File} file
 * @param {(progress:{page:number, totalPages:number})=>void} [onProgress]
 * @returns {Promise<ParseReport>}
 */
export async function parseTimetablePdf(file, onProgress) {
  const fatalErrors = [];
  const warnings = [];

  if (!file) {
    return fail('ファイルが選択されていません。');
  }
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    return fail('PDFファイルを選択してください。');
  }
  if (file.size > MAX_PDF_BYTES) {
    return fail(`ファイルサイズが大きすぎます（上限 ${Math.floor(MAX_PDF_BYTES / 1024 / 1024)}MB）。`);
  }

  const arrayBuffer = await file.arrayBuffer();
  const sourceHash = await sha256Hex(arrayBuffer);

  let pdfjsLib;
  try {
    pdfjsLib = await loadPdfjs();
  } catch {
    return fail('PDF解析ライブラリの読み込みに失敗しました。ページを再読み込みしてください。');
  }

  let doc;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      cMapUrl: PDFJS_CMAPS_URL,
      cMapPacked: true,
      disableFontFace: true,
      isEvalSupported: false,
    });
    doc = await loadingTask.promise;
  } catch {
    return fail('PDFとして読み込めませんでした。壊れたファイル、またはパスワード保護されたPDFの可能性があります。');
  }

  if (doc.numPages === 0) {
    return fail('PDFにページがありません。');
  }
  if (doc.numPages > MAX_PAGES) {
    return fail(`ページ数が多すぎます（${doc.numPages}ページ、上限${MAX_PAGES}）。公式の全便時刻表PDFか確認してください。`);
  }

  const allTokens = [];
  const periodsFound = [];
  for (let p = 1; p <= doc.numPages; p++) {
    let page, content;
    try {
      page = await doc.getPage(p);
      content = await page.getTextContent();
    } catch {
      fatalErrors.push({ page: p, message: `ページ${p}の読み取りに失敗しました。` });
      continue;
    }
    // PDFのエディションによっては、一部の漢字が康熙部首ブロックの文字として
    // 文字単位で分離抽出されるため、まず文字を正規化してから期間を抽出し
    // （期間の文字列パターンは1トークン=1記号を前提とするため、この時点では
    // まだ地名の結合は行わない）、そのあとで地名トークンの結合を行う。
    const rawItems = content.items
      .map((it) => (it.str || '').trim())
      .filter((s) => s.length > 0)
      .map(normalizeRadicals);

    const period = extractPeriodFromTokens(rawItems);
    if (period) periodsFound.push({ page: p, ...period });

    const merged = mergeNameFragments(rawItems);
    const cleaned = stripBoilerplate(merged);
    for (const tok of cleaned) allTokens.push({ page: p, tok });

    if (onProgress) onProgress({ page: p, totalPages: doc.numPages });
  }

  if (periodsFound.length === 0) {
    return fail(
      '対象期間（例: 2026/03/29~2026/06/30）が見つかりませんでした。PDF時刻表ではない可能性があります。'
    );
  }
  const period = { from: periodsFound[0].from, to: periodsFound[0].to };
  const publishedOn = periodsFound[0].publishedOn;
  const inconsistentPeriods = periodsFound.filter(
    (p) => p.from !== period.from || p.to !== period.to || p.publishedOn !== publishedOn
  );
  if (inconsistentPeriods.length > 0) {
    return fail(
      'PDF内のページ間で対象期間の記載が一致しません。破損したPDF、または複数の時刻表が混在したファイルの可能性があります。'
    );
  }

  let rawRoutes, anomalies;
  try {
    ({ routes: rawRoutes, anomalies } = parseRows(allTokens));
  } catch {
    return fail('時刻表データの解析中に予期しないエラーが発生しました。ファイルが破損している可能性があります。');
  }
  for (const a of anomalies) {
    (a.severity === 'fatal' ? fatalErrors : warnings).push(a);
  }

  if (rawRoutes.length === 0) {
    return fail('路線データを1件も抽出できませんでした。PDF時刻表か確認してください。');
  }

  // PDF時刻表は、両端の空港ページ双方に同じ路線が重複掲載されるため、
  // ここで路線単位に統合し、完全一致する重複行をまとめる。
  const { routes: dedupedRoutes } = mergeDuplicateRouteBlocks(rawRoutes);
  rawRoutes = dedupedRoutes;

  // 便データの正規化 + 運航日ルールの正規化 + 妥当性検証
  const routes = [];
  let totalFlightRows = 0;
  let unparsedRemarkCount = 0;
  let unknownCarrierCount = 0;
  let variantFlightCount = 0; // 日付/時刻/運航会社が異なる複数バリエーションを持つ便名の数
  const airportSet = new Set();
  const carrierSet = new Set();

  for (const r of rawRoutes) {
    airportSet.add(r.origin);
    airportSet.add(r.dest);
    const flights = [];
    for (const row of r.rows) {
      totalFlightRows += 1;
      carrierSet.add(row.carrier);
      if (!isKnownCarrier(row.carrier)) {
        unknownCarrierCount += 1;
        warnings.push({
          page: row.page,
          severity: 'warning',
          message: `未知の運航会社コード「${row.carrier}」（便名: ${row.flightNo}, 路線: ${r.origin}→${r.dest}）。PPは計算不能として扱われます。`,
        });
      }
      if (!/^\d{2}:\d{2}$/.test(row.dep) || !/^\d{2}:\d{2}$/.test(row.arr)) {
        fatalErrors.push({
          page: row.page,
          message: `時刻の形式が不正です（便名: ${row.flightNo}, ${row.dep}-${row.arr}）`,
        });
        continue;
      }
      const operating = normalizeOperatingDays(row.remark, period);
      if (operating.mode === 'unparsed') {
        unparsedRemarkCount += 1;
        warnings.push({
          page: row.page,
          severity: 'warning',
          message: `運航日の備考を解釈できませんでした（便名: ${row.flightNo}, 路線: ${r.origin}→${r.dest}, 備考: "${row.remark}"）。この行は運航日不明として扱われ、旅程作成では選択できません。`,
        });
      }
      flights.push({
        flightNo: row.flightNo,
        carrier: row.carrier,
        dep: row.dep,
        arr: row.arr,
        operating,
      });
    }

    // 同一便名内での運航日重複（矛盾）検出
    const byFlightNo = new Map();
    for (const f of flights) {
      if (!byFlightNo.has(f.flightNo)) byFlightNo.set(f.flightNo, []);
      byFlightNo.get(f.flightNo).push(f);
    }
    for (const [flightNo, variants] of byFlightNo) {
      if (variants.length < 2) continue;
      variantFlightCount += 1;
      const seen = new Map(); // date -> variant index
      variants.forEach((v, idx) => {
        if (v.operating.mode !== 'include') return; // all/exclude/unparsed は網羅的重複判定が難しいためスキップ
        for (const d of v.operating.dates) {
          if (seen.has(d)) {
            warnings.push({
              page: r.page,
              severity: 'warning',
              message: `便名「${flightNo}」（路線: ${r.origin}→${r.dest}）で同一日付(${d})に複数の時刻/運航会社バリエーションが重複しています。`,
            });
          } else {
            seen.set(d, idx);
          }
        }
      });
    }

    routes.push({ origin: r.origin, dest: r.dest, flights });
  }

  const stats = {
    pageCount: doc.numPages,
    airportCount: airportSet.size,
    routeCount: routes.length,
    flightCount: totalFlightRows,
    carrierCodes: Array.from(carrierSet).sort(),
    unknownCarrierCount,
    unparsedRemarkCount,
    variantFlightCount,
    warningCount: warnings.length,
  };

  if (fatalErrors.length > 0) {
    return { ok: false, timetable: null, fatalErrors, warnings, stats };
  }

  const timetable = {
    schemaVersion: 1,
    source: {
      fileName: file.name,
      sha256: sourceHash,
      importedAt: new Date().toISOString(),
      fileSizeBytes: file.size,
    },
    validPeriod: period,
    publishedOn,
    airports: Array.from(airportSet).sort(),
    routes,
  };

  return { ok: true, timetable, fatalErrors: [], warnings, stats };

  function fail(message) {
    fatalErrors.unshift({ message });
    return { ok: false, timetable: null, fatalErrors, warnings, stats: null };
  }
}
