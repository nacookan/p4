// 時刻表の「備考」欄（例: "3/29-31,4/1-30,5/1-31,6/1-11,13-15,17-30運航。"）を、
// 指定した搭乗日にその便が運航するかどうかを判定できる正規化された形式に変換する。

const SEGMENT_DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:-(\d{1,2}))?$/; // "M/D" or "M/D-D"
const SEGMENT_BARE_RE = /^(\d{1,2})(?:-(\d{1,2}))?$/; // "D" or "D-D"（直前の月を継承）

function isValidCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function toISO(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 期間の開始年月を起点に、"M/D,M/D-D,D,D-D,..." 形式の日付リストを
 * ISO日付文字列の配列に展開する。月が後退したら年を繰り上げる
 * （期間が年をまたぐケースに対応するため、期間の開始/終了年との比較ではなく
 * 出現順で単調増加するという前提で判定する）。
 *
 * @param {string} body カンマ区切りの日付リスト本体（"運航。"等の接尾辞は除いたもの）
 * @param {{from:string, to:string}} period ISO日付文字列の期間
 * @returns {{dates:string[], errors:string[]}}
 */
export function expandDateList(body, period) {
  const startYear = Number(period.from.slice(0, 4));
  const startMonth = Number(period.from.slice(5, 7));
  let year = startYear;
  let lastMonth = startMonth;
  const dates = [];
  const errors = [];

  const segments = body.split(',');
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    let month, dayStart, dayEnd;
    const mSlash = SEGMENT_DATE_RE.exec(trimmed);
    if (mSlash) {
      month = Number(mSlash[1]);
      dayStart = Number(mSlash[2]);
      dayEnd = mSlash[3] ? Number(mSlash[3]) : dayStart;
      if (month < lastMonth) year += 1;
      lastMonth = month;
    } else {
      const mBare = SEGMENT_BARE_RE.exec(trimmed);
      if (mBare) {
        month = lastMonth;
        dayStart = Number(mBare[1]);
        dayEnd = mBare[2] ? Number(mBare[2]) : dayStart;
      } else {
        errors.push(`日付表記を解釈できません: "${trimmed}"`);
        continue;
      }
    }
    if (dayEnd < dayStart) {
      errors.push(`日付範囲が不正です: "${trimmed}"`);
      continue;
    }
    for (let d = dayStart; d <= dayEnd; d++) {
      if (!isValidCalendarDate(year, month, d)) {
        errors.push(`存在しない日付です: ${year}-${month}-${d}`);
        continue;
      }
      dates.push(toISO(year, month, d));
    }
  }
  return { dates, errors };
}

/**
 * 全ての日付をperiod内に展開したリスト（例外なし運航）を返す。
 */
function allDatesInPeriod(period) {
  const dates = [];
  let cur = new Date(`${period.from}T00:00:00Z`);
  const end = new Date(`${period.to}T00:00:00Z`);
  while (cur.getTime() <= end.getTime()) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

/**
 * 備考テキストを正規化された運航日ルールに変換する。
 *
 * @param {string} remark 備考欄の生テキスト（空文字なら「毎日運航」扱い）
 * @param {{from:string, to:string}} period 時刻表の対象期間
 * @returns {{mode:'all'|'include'|'exclude'|'unparsed', dates:string[], raw:string, errors:string[]}}
 */
export function normalizeOperatingDays(remark, period) {
  if (!remark) {
    return { mode: 'all', dates: [], raw: '', errors: [] };
  }
  let mode = null;
  let body = null;
  if (remark.endsWith('運航。')) {
    mode = 'include';
    body = remark.slice(0, -3);
  } else if (remark.endsWith('運休。')) {
    mode = 'exclude';
    body = remark.slice(0, -3);
  } else {
    return { mode: 'unparsed', dates: [], raw: remark, errors: [`未知の備考形式: "${remark}"`] };
  }

  const { dates, errors } = expandDateList(body, period);
  if (errors.length > 0 || dates.length === 0) {
    return { mode: 'unparsed', dates: [], raw: remark, errors: errors.length ? errors : ['日付が抽出できませんでした'] };
  }

  // 期間外の日付が含まれていないか検証する
  const outOfRange = dates.filter((d) => d < period.from || d > period.to);
  if (outOfRange.length > 0) {
    return {
      mode: 'unparsed',
      dates: [],
      raw: remark,
      errors: [`対象期間外の日付が含まれています: ${outOfRange.join(', ')}`],
    };
  }

  return { mode, dates, raw: remark, errors: [] };
}

/**
 * 正規化された運航日ルールに基づき、指定日に運航するかを判定する。
 * @param {ReturnType<typeof normalizeOperatingDays>} rule
 * @param {string} dateISO
 * @param {{from:string, to:string}} period
 */
export function operatesOnDate(rule, dateISO, period) {
  if (dateISO < period.from || dateISO > period.to) return false;
  switch (rule.mode) {
    case 'all':
      return true;
    case 'include':
      return rule.dates.includes(dateISO);
    case 'exclude':
      return !rule.dates.includes(dateISO);
    case 'unparsed':
    default:
      return false;
  }
}

export { allDatesInPeriod };
