// プラン表示画面・プラン編集画面（旅程の途中経過）で共用する、
// 区間一覧テーブルの描画ロジック。表記が2画面で揺れないよう1箇所に集約している。
import { el } from '../util/dom.js';
import { formatPP } from '../domain/pp-calculator.js';
import { formatDateJa, minutesBetween } from '../util/time.js';
import { resolveArrivalDate } from '../domain/itinerary.js';
import { CABIN_CLASSES, FARE_CLASSES, DEFAULT_CABIN_CLASS_ID, DEFAULT_FARE_CLASS_ID } from '../data/pp-rules.js';
import { abbreviateAirport } from '../util/airport-name.js';

/**
 * 分数を "Xh" "0hYm" "XhYm" のような簡潔な表記にする。負値・不正値はnull。
 * 1時間未満のときも「30m」のように分だけにはせず「0h30m」と書く
 * （「30メートル」等と誤読されないように、常に単位の切り替わりを明示する）。
 */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0 && m > 0) return `${h}h${m}m`;
  if (h > 0) return `${h}h`;
  return `0h${m}m`;
}

/**
 * 前区間の到着〜次区間の出発の間隔を、単なる「その時間分の待ち時間/移動時間がある」
 * という保証っぽい表現ではなく、「次の出発はX後」という中立な事実＋「〜が必要」という
 * 確認を促す言い方にする（実際に間に合うかはユーザー自身の判断に委ねるため）。
 */
function requiredMoveText(waitText, actionText) {
  return waitText ? `次の出発は ${waitText} 後 / ${actionText}が必要` : `${actionText}が必要`;
}

function fareClassLabel(leg) {
  const fc = FARE_CLASSES.find((f) => f.id === (leg.fareClassId || DEFAULT_FARE_CLASS_ID));
  return fc ? fc.label : '(不明)';
}

function cabinClassLabel(leg) {
  const cc = CABIN_CLASSES.find((c) => c.id === (leg.cabinClassId || DEFAULT_CABIN_CLASS_ID));
  return cc ? cc.shortLabel : '(不明)';
}

/** 金額は末尾に「円」を付ける（PP単価の「円/PP」と単位表記を揃えるため、先頭¥は使わない）。 */
export function formatYen(n) {
  return `${n.toLocaleString('ja-JP')}円`;
}

export function ppUnitPriceText(price, pp) {
  if (price == null || pp === null || pp <= 0) return null;
  return `${(price / pp).toFixed(1)}円/PP`;
}

/**
 * 乗り継ぎ等で運賃がまとめて1区間に合算されている場合の単価計算用に、
 * 「上の便に合算」されている区間のPPを、合算先（直前の非合算区間）のPPへ積み上げる。
 * @returns {(number|null)[]} legsと同じ順の、各区間が属するグループの合計PP（区間自身が合算区間なら合算先のグループ合計）
 */
function computeGroupPP(legs, results) {
  const groupPP = new Array(legs.length).fill(null);
  let ownerIdx = -1;
  let sum = 0;
  let hasNull = false;
  function flush() {
    if (ownerIdx !== -1) groupPP[ownerIdx] = hasNull ? null : sum;
  }
  legs.forEach((leg, idx) => {
    const pp = results[idx].result.pp;
    const isMergedMember = idx > 0 && leg.priceMergedWithPrevious && ownerIdx !== -1;
    if (!isMergedMember) {
      flush();
      ownerIdx = idx;
      sum = 0;
      hasNull = false;
    }
    if (pp === null) hasNull = true;
    else sum += pp;
  });
  flush();
  return groupPP;
}

/** 2行構成のセル。muted:trueなら2行目を薄字・小さめにする。cellClassNameはtd自体に付与する。 */
function twoLineCell(line1, line2, muted, cellClassName) {
  const children = [el('div', { text: line1 })];
  if (line2) children.push(el('div', { className: muted ? 'td-sub' : '', text: line2 }));
  return el('td', { className: cellClassName }, children);
}

/** 出発/到着の2行セル。到着行の末尾に、薄く小さい文字で飛行時間を添える。 */
function timeAirportCell(leg) {
  const arrivalDate = resolveArrivalDate(leg.boardingDate, leg.dep, leg.arr);
  const duration = formatDuration(minutesBetween(leg.boardingDate, leg.dep, arrivalDate, leg.arr));
  const arrLine = el('div', {}, [
    `${leg.arr} ${abbreviateAirport(leg.dest)}`,
    duration ? el('span', { className: 'inline-muted', text: ` (${duration})` }) : null,
  ]);
  return el('td', {}, [el('div', { text: `${leg.dep} ${abbreviateAirport(leg.origin)}` }), arrLine]);
}

/**
 * 区間一覧テーブルを構築する。
 * @param {object[]} legs
 * @param {{result:object}[]} results calculateItineraryPP(legs).results と同じ形
 * @param {object} [opts]
 * @param {(idx:number)=>void} [opts.onDeleteFrom] 指定すると「操作」列に削除ボタンを追加する
 * @param {boolean} [opts.showPrice] falseにすると「金額/単価」列を表示しない（既定はtrue）
 * @returns {HTMLElement}
 */
export function renderItineraryTable(legs, results, opts = {}) {
  const withActions = typeof opts.onDeleteFrom === 'function';
  const showPrice = opts.showPrice !== false;
  const columnCount = 4 + (showPrice ? 1 : 0) + (withActions ? 1 : 0);
  const headers = ['出発/到着', '便名', '運賃/座席', 'PP'];
  if (showPrice) headers.push('金額/単価');
  if (withActions) headers.push('操作');

  const table = el('table', {}, [el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))])]);
  const tbody = el('tbody');
  let lastDate = null;
  const groupPP = showPrice ? computeGroupPP(legs, results) : null;

  legs.forEach((leg, idx) => {
    const r = results[idx].result;

    if (idx > 0) {
      const prev = legs[idx - 1];
      const prevArrivalDate = resolveArrivalDate(prev.boardingDate, prev.dep, prev.arr);
      const waitText = formatDuration(minutesBetween(prevArrivalDate, prev.arr, leg.boardingDate, leg.dep));

      // 日をまたぐ空港間の移動は、宿泊行だけを出せば十分なので空港間の移動行は出さない。
      const showTransfer = leg.airportTransfer && !leg.isOvernightStay;
      if (showTransfer) {
        const actionText = `空港間の移動(${abbreviateAirport(leg.airportTransfer.from)}→${abbreviateAirport(leg.airportTransfer.to)})`;
        tbody.appendChild(
          el('tr', { className: 'special-row transfer-row' }, [
            el('td', { attrs: { colspan: columnCount }, text: requiredMoveText(waitText, actionText) }),
          ])
        );
      }
      if (leg.isOvernightStay) {
        // 空港間の移動を伴う宿泊は、片方の空港名だけでは分かりにくいので両方書く（例: 宿泊（伊丹・関西））。
        const stayLabel = leg.airportTransfer
          ? `${abbreviateAirport(leg.airportTransfer.from)}・${abbreviateAirport(leg.airportTransfer.to)}`
          : abbreviateAirport(leg.origin);
        tbody.appendChild(
          el('tr', { className: 'special-row overnight-row' }, [
            el('td', { attrs: { colspan: columnCount }, text: `宿泊（${stayLabel}）` }),
          ])
        );
      }
      if (!showTransfer && !leg.isOvernightStay) {
        tbody.appendChild(
          el('tr', { className: 'special-row connection-row' }, [
            el('td', { attrs: { colspan: columnCount }, text: requiredMoveText(waitText, '乗り継ぎ便への移動') }),
          ])
        );
      }
    }
    if (leg.boardingDate !== lastDate) {
      tbody.appendChild(
        el('tr', { className: 'special-row date-row' }, [
          el('td', { attrs: { colspan: columnCount }, text: formatDateJa(leg.boardingDate) }),
        ])
      );
      lastDate = leg.boardingDate;
    }

    const cells = [
      timeAirportCell(leg),
      twoLineCell(leg.flightNo, `(${leg.carrier}運行)`, true),
      twoLineCell(fareClassLabel(leg), cabinClassLabel(leg), false, 'fare-cabin-cell'),
      el('td', { text: r.pp !== null ? formatPP(r.pp) : '計算不能' }),
    ];
    if (showPrice) {
      if (idx > 0 && leg.priceMergedWithPrevious) {
        cells.push(twoLineCell('上の便に合算', null, true));
      } else {
        const priceText = leg.priceMemo != null ? formatYen(leg.priceMemo) : '—';
        const unitText = ppUnitPriceText(leg.priceMemo, groupPP[idx]);
        cells.push(twoLineCell(priceText, unitText ? `(${unitText})` : null, true));
      }
    }
    if (withActions) {
      cells.push(
        el('td', {}, [
          el('button', {
            className: 'btn btn-secondary table-action-btn',
            text: '✕',
            attrs: { type: 'button', 'aria-label': `${idx + 1}区間目以降を削除` },
            on: { click: () => opts.onDeleteFrom(idx) },
          }),
        ])
      );
    }
    tbody.appendChild(el('tr', {}, cells));
  });

  table.appendChild(tbody);
  return table;
}
