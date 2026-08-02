// Dropbox App Folderに保存するデータのスキーマ定義とバリデーション。
// 「壊れたJSONや未知のスキーマを黙って上書きしない」ための最終防衛線。

export const TIMETABLE_SCHEMA_VERSION = 1;
export const APPDATA_SCHEMA_VERSION = 1;

export const TIMETABLE_PATH = '/timetable.json';
export const APPDATA_PATH = '/appdata.json';

export const MAX_RECENT_AIRPORTS = 8;

export function emptyAppData() {
  return {
    schemaVersion: APPDATA_SCHEMA_VERSION,
    settings: {
      recentDepartureAirports: [], // 新しい順。プランで発着したすべての空港が対象（出発地に限らない）。
    },
    plans: [],
  };
}

/** 空港の利用履歴に airport を先頭追加する（重複は除去、最大件数で切り詰め）。 */
export function withRecentAirport(settings, airport) {
  const prev = Array.isArray(settings.recentDepartureAirports) ? settings.recentDepartureAirports : [];
  const next = [airport, ...prev.filter((a) => a !== airport)].slice(0, MAX_RECENT_AIRPORTS);
  return { ...settings, recentDepartureAirports: next };
}

/**
 * 複数の空港をまとめて利用履歴に反映する。
 * airports は「先頭ほど優先的に新しく扱いたい順」で渡す（例: 旅程の出発地→経由地→到着地の順）。
 * 内部ではwithRecentAirportを逆順に適用することで、airports[0]が最終的に最も新しい扱いになる。
 */
export function withRecentAirports(settings, airports) {
  let next = settings;
  for (let i = airports.length - 1; i >= 0; i--) {
    next = withRecentAirport(next, airports[i]);
  }
  return next;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * timetable.json の内容を検証する。 { ok, errors }
 */
export function validateTimetableDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['timetable.jsonの内容がオブジェクトではありません。'] };
  }
  if (doc.schemaVersion !== TIMETABLE_SCHEMA_VERSION) {
    errors.push(
      `timetable.jsonのschemaVersion(${doc.schemaVersion})が未対応です（対応バージョン: ${TIMETABLE_SCHEMA_VERSION}）。アプリの更新が必要な可能性があります。`
    );
  }
  if (!doc.source || !isNonEmptyString(doc.source.sha256)) {
    errors.push('source.sha256がありません。');
  }
  if (!doc.validPeriod || !isNonEmptyString(doc.validPeriod.from) || !isNonEmptyString(doc.validPeriod.to)) {
    errors.push('validPeriodがありません。');
  }
  if (!Array.isArray(doc.airports)) errors.push('airportsが配列ではありません。');
  if (!Array.isArray(doc.routes)) errors.push('routesが配列ではありません。');
  return { ok: errors.length === 0, errors };
}

/**
 * appdata.json（設定＋プラン）の内容を検証する。 { ok, errors }
 */
export function validateAppDataDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['appdata.jsonの内容がオブジェクトではありません。'] };
  }
  if (doc.schemaVersion !== APPDATA_SCHEMA_VERSION) {
    errors.push(
      `appdata.jsonのschemaVersion(${doc.schemaVersion})が未対応です（対応バージョン: ${APPDATA_SCHEMA_VERSION}）。アプリの更新が必要な可能性があります。`
    );
  }
  if (!doc.settings || typeof doc.settings !== 'object') errors.push('settingsがありません。');
  if (!Array.isArray(doc.plans)) errors.push('plansが配列ではありません。');
  else {
    doc.plans.forEach((p, i) => {
      if (!isNonEmptyString(p.id)) errors.push(`plans[${i}].idがありません。`);
      if (!Array.isArray(p.legs)) errors.push(`plans[${i}].legsが配列ではありません。`);
    });
  }
  return { ok: errors.length === 0, errors };
}

let idCounter = 0;
/** ブラウザ標準APIのみで一意なID文字列を作る（crypto.randomUUIDが使える場合はそれを使用）。 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `id-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2)}`;
}
