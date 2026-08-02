// 日付・時刻のユーティリティ。
// このアプリが扱う日付・時刻はすべて「日本時間（JST）の壁時計表示」として
// 一貫して扱う（時刻表はすべて日本時間で掲載されているため、
// 実時間のタイムゾーン変換は行わず、文字列としての日付・時刻比較で十分）。

/** "YYYY-MM-DD" と "HH:MM" を辞書順比較可能な結合文字列にする。 */
export function combineDateTime(dateISO, timeHHMM) {
  return `${dateISO}T${timeHHMM}`;
}

/** 2つの (date,time) の前後関係を比較する。 a<b なら負、等しければ0、a>bなら正。 */
export function compareDateTime(dateA, timeA, dateB, timeB) {
  const a = combineDateTime(dateA, timeA);
  const b = combineDateTime(dateB, timeB);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** (dateA,timeA)から(dateB,timeB)までの経過分数を返す（実行環境のタイムゾーンによらない）。 */
export function minutesBetween(dateA, timeA, dateB, timeB) {
  const toMinutes = (dateISO, timeHHMM) => {
    const [y, m, d] = dateISO.split('-').map(Number);
    const [h, mi] = timeHHMM.split(':').map(Number);
    return Date.UTC(y, m - 1, d, h, mi) / 60000;
  };
  return toMinutes(dateB, timeB) - toMinutes(dateA, timeA);
}

/** "YYYY-MM-DD" に日数を加算する（純粋なカレンダー計算、タイムゾーン非依存）。 */
export function addDays(dateISO, days) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** dateISOが period内(from<=dateISO<=to)かどうか。 */
export function isWithinPeriod(dateISO, period) {
  return dateISO >= period.from && dateISO <= period.to;
}

/** 実行環境のタイムゾーンによらず、日本時間(JST)における「今日」の日付を返す。 */
export function todayJST() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** "YYYY-MM-DD" を "YYYY/MM/DD(曜)" の表示用文字列にする。 */
export function formatDateJa(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = WEEKDAYS_JA[dt.getUTCDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}(${wd})`;
}

/** "YYYY-MM-DD" を年を省略した "MM/DD(曜)" の表示用文字列にする（幅の狭いタブ表示用）。 */
export function formatDateShortJa(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = WEEKDAYS_JA[dt.getUTCDay()];
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}(${wd})`;
}
