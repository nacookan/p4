// PDF時刻表のテキスト構造をトークン列から解析する。
//
// 設計上の重要な判断（READMEにも記載）:
// pdf.js の getTextContent() が返すアイテム配列は、視覚的なY座標順ではなく
// PDF内部のコンテンツストリーム順を保持している。PDF時刻表では、
// 便名セルが複数行（日付・時刻・運航会社違いの複数バリエーション）に
// またがる「結合セル」として中央に配置されるため、Y座標だけで行を
// 復元しようとすると便名と時刻行の対応関係を誤る。
// 一方でコンテンツストリーム順は「便名 → その1件目の時刻行 → (同じ便名の)
// 2件目以降の時刻行 → 次の便名 → ...」という論理的な順序を保っていることを
// 実際のPDF（2026/03/29〜2026/06/30版、61ページ）で確認済み。
// そのため本パーサーは幾何情報（x/y座標）を使わず、トークンの出現順序と
// パターン（便名/時刻/運航会社/区切り記号）だけで表を復元する。

const TIME_RE = /^\d{2}:\d{2}$/;
const FLIGHT_NO_RE = /^NH\d{3,4}$/;
const CARRIER_RE = /^[A-Z]{2,4}$/;
const SECTION_HEADER_TAIL_RE = /^現在）$/;

/**
 * ページ単位のテキストアイテム文字列配列から、PDF時刻表特有の
 * 定型文（表題・注意書き・ページ見出し・末尾凡例）を取り除く。
 * ジオメトリに依存せず、常に一定の並びで出現する定型トークン列を
 * パターンマッチで検出して除去する。
 *
 * 前提: 都市名・空港名トークンは js/pdf/normalize-text.js の
 * mergeNameFragments により、常に1トークンへ結合済みであること。
 *
 * @param {string[]} tokens 1ページ分のトリム済み・空文字除去済みトークン列
 * @returns {string[]} 定型文を除いたトークン列
 */
export function stripBoilerplate(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    // 末尾の凡例・注意書き（「当ダイヤは...現在のものであり...」）以降は
    // その回のトークン列末尾まで丸ごと除去する。
    if (t.startsWith('当ダイヤは')) {
      break;
    }

    // 「最新のスケジュール、機種やサービスなどの情報は...航空券の予約・購入はこちら」
    if (t.startsWith('最新のスケジュール')) {
      while (i < tokens.length && tokens[i] !== '航空券の予約・購入はこちら') i++;
      i++; // 「航空券の予約・購入はこちら」自体を消費
      continue;
    }

    // ページ先頭の表題「国内線時刻表2026/03/29~2026/06/30（2026年1月29日現在）」
    // および各ページ見出し「◯◯発着2026/03/29~2026/06/30（2026年1月29日現在）」
    if (t === '国内線時刻表' || t === '発着') {
      if (t === '発着') {
        // 直前に積んだ都市名トークンを取り除く（mergeNameFragmentsにより
        // 都市名は常に1トークンに結合されている前提）。
        if (out.length) out.pop();
      }
      i++;
      while (i < tokens.length && !SECTION_HEADER_TAIL_RE.test(tokens[i])) i++;
      i++; // '現在）' 自体を消費
      continue;
    }

    out.push(t);
    i++;
  }
  return out;
}

/**
 * ページ先頭の表題／見出しから「対象期間」「確認日」を抽出する。
 * stripBoilerplate で捨てられる前の生トークン列に対して呼び出すこと。
 * 見つからない場合は null。
 */
export function extractPeriodFromTokens(tokens) {
  // パターン: <ラベル> YYYY / MM / DD ~ YYYY / MM / DD （ YYYY 年 M 月 D 日 現在）
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d{4}$/.test(tokens[i]) && tokens[i + 1] === '/') {
      const seq = tokens.slice(i, i + 20);
      const joined = seq.join('|');
      const m = /^(\d{4})\|\/\|(\d{2})\|\/\|(\d{2})\|~\|(\d{4})\|\/\|(\d{2})\|\/\|(\d{2})\|（\|(\d{4})\|年\|(\d{1,2})\|月\|(\d{1,2})\|日\|現在）/.exec(
        joined
      );
      if (m) {
        const [, y1, m1, d1, y2, m2, d2, py, pm, pd] = m;
        return {
          from: `${y1}-${m1}-${d1}`,
          to: `${y2}-${m2}-${d2}`,
          publishedOn: `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`,
        };
      }
    }
  }
  return null;
}

/**
 * 定型文除去後のトークン列（複数ページ分を連結したもの）から、
 * 路線ブロックと便のローデータ行を復元する。
 *
 * @param {{page:number, tok:string}[]} tokens
 * @returns {{routes: object[], anomalies: object[]}}
 */
export function parseRows(tokens) {
  const routes = [];
  const anomalies = [];
  let curRoute = null;
  let curFlightNo = null;
  let rows = [];
  let cur = null;

  function pushRow() {
    if (cur) {
      rows.push({
        flightNo: curFlightNo,
        dep: cur.dep,
        arr: cur.arr,
        carrier: cur.carrier,
        remark: cur.remarkParts.join(''),
        page: cur.page,
      });
      cur = null;
    }
  }
  function finalizeRoute() {
    if (curRoute) {
      curRoute.rows = rows;
      routes.push(curRoute);
    }
    rows = [];
    curRoute = null;
    curFlightNo = null;
  }

  for (let i = 0; i < tokens.length; i++) {
    const { page, tok } = tokens[i];
    const next = tokens[i + 1] ? tokens[i + 1].tok : null;

    if (next === '→') {
      pushRow();
      finalizeRoute();
      const dest = tokens[i + 2] ? tokens[i + 2].tok : null;
      if (!dest) {
        anomalies.push({ page, severity: 'fatal', message: `路線見出しの到着地が読み取れません（出発地: ${tok}）` });
        continue;
      }
      curRoute = { origin: tok, dest, page };
      i += 2;
      continue;
    }
    if (tok === '→') continue; // 通常はここに到達しない

    if (!curRoute) continue; // 路線ブロック開始前のトークンは無視

    if (tok === '便名') {
      while (i < tokens.length && tokens[i].tok !== '備考') i++;
      continue;
    }

    if (FLIGHT_NO_RE.test(tok)) {
      pushRow();
      curFlightNo = tok;
      continue;
    }

    if (TIME_RE.test(tok)) {
      if (!cur) {
        cur = { page, dep: tok, arr: null, carrier: null, remarkParts: [] };
      } else if (cur.arr === null && cur.carrier === null) {
        cur.arr = tok;
      } else {
        pushRow();
        cur = { page, dep: tok, arr: null, carrier: null, remarkParts: [] };
      }
      continue;
    }

    if (cur && cur.arr !== null && cur.carrier === null) {
      if (CARRIER_RE.test(tok)) {
        cur.carrier = tok;
      } else {
        anomalies.push({
          page,
          severity: 'warning',
          message: `運航会社コードが期待される位置に想定外のテキスト「${tok}」（路線: ${curRoute.origin}→${curRoute.dest}, 便名: ${curFlightNo || '(不明)'}）`,
        });
        cur.carrier = tok;
      }
      continue;
    }

    if (cur && cur.carrier !== null) {
      cur.remarkParts.push(tok);
      continue;
    }

    anomalies.push({
      page,
      severity: 'warning',
      message: `想定外の位置にテキスト「${tok}」（路線: ${curRoute.origin}→${curRoute.dest}）`,
    });
  }
  pushRow();
  finalizeRoute();

  // 便名を持たない行（本来あり得ない）を致命的異常として報告
  for (const r of routes) {
    for (const row of r.rows) {
      if (!row.flightNo) {
        anomalies.push({
          page: row.page,
          severity: 'fatal',
          message: `便名が特定できない行があります（路線: ${r.origin}→${r.dest}, ${row.dep}-${row.arr}）`,
        });
      }
    }
  }

  return { routes, anomalies };
}

/**
 * PDF時刻表は、各空港の発着ページ（東京発着・大阪発着 等）ごとに
 * その空港に関わる路線を掲載するため、両端の空港がそれぞれページ区分を
 * 持つ路線（例: 東京発着ページと大阪発着ページの双方に載る「東京→大阪」）は
 * PDF内に重複して2回印刷される。これはPDF自体の仕様であり破損ではない。
 * この関数は同一路線(出発地・到着地の組)のブロックを1つに統合し、
 * 完全に一致する便データ行（便名・出発・到着・運航会社・備考のすべてが
 * 一致する行）の重複だけを取り除く。
 *
 * 注意: 同じ便名・出発・到着時刻でも運航会社や運航日が異なる行が複数存在する
 * ことは、便の日付別バリエーション（例: 通常はANA運航、特定日のみAKX運航）
 * として正当なケースであり、それ自体は矛盾ではない。実際に矛盾（同一日付に
 * 複数のバリエーションが重複して適用される等）が無いかどうかは、運航日を
 * 正規化したうえでのチェック（js/pdf/parser.js）に委ねる。
 *
 * @param {{origin:string, dest:string, rows:object[]}[]} routeBlocks
 * @returns {{routes: object[]}}
 */
export function mergeDuplicateRouteBlocks(routeBlocks) {
  const groups = new Map(); // "origin dest" -> block[]
  for (const b of routeBlocks) {
    const key = `${b.origin} ${b.dest}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const routes = [];
  for (const blocks of groups.values()) {
    const { origin, dest } = blocks[0];
    const seenExact = new Set(); // flightNo|dep|arr|carrier|remark の完全一致キー
    const rows = [];
    for (const block of blocks) {
      for (const row of block.rows) {
        const exactKey = `${row.flightNo}|${row.dep}|${row.arr}|${row.carrier}|${row.remark}`;
        if (seenExact.has(exactKey)) continue; // PDF内の重複掲載による完全一致行は1つにまとめる
        seenExact.add(exactKey);
        rows.push(row);
      }
    }
    routes.push({ origin, dest, rows });
  }

  return { routes };
}
