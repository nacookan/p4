export const DEFAULT_CABIN_CLASS_ID = 'economy';
export const DEFAULT_FARE_CLASS_ID = 'standard';

export const CABIN_CLASSES = [
  { id: 'economy', label: 'エコノミークラス', shortLabel: 'エコノミー' },
  { id: 'first', label: 'ファーストクラス', shortLabel: 'ファースト' },
];

export const FARE_CLASSES = [
  { id: 'sale', label: 'セール' },
  { id: 'simple', label: 'シンプル' },
  { id: 'standard', label: 'スタンダード' },
  { id: 'flex', label: 'フレックス' },
];

// 座席クラス×運賃種別ごとの積算率・搭乗ポイント。
const RATE_TABLE = {
  'economy:sale': { accrualRate: 0.5, boardingPoints: 0 },
  'economy:simple': { accrualRate: 0.7, boardingPoints: 100 },
  'economy:standard': { accrualRate: 0.8, boardingPoints: 200 },
  'economy:flex': { accrualRate: 1.0, boardingPoints: 400 },
  'first:sale': { accrualRate: 1.0, boardingPoints: 0 },
  'first:simple': { accrualRate: 1.2, boardingPoints: 400 },
  'first:standard': { accrualRate: 1.3, boardingPoints: 400 },
  'first:flex': { accrualRate: 1.5, boardingPoints: 400 },
};

export const PP_RULESET_DOMESTIC_2026_05_19 = {
  id: 'domestic-2026-05-19',
  effectiveFrom: '2026-05-19', // この日以降搭乗分に適用
  routeMultiplier: 2, // 国内線路線倍率（座席クラス・運賃種別によらず共通）
  roundingNote:
    '区間基本マイレージ×積算率×路線倍率をまとめて計算し、その最終段階でのみ' +
    '小数点以下切り捨て（公式マイレージチャートの実例および公式サイトでの' +
    '実測値との突き合わせに基づく。公式シミュレーターでの最終確認を推奨）。',
  cabinClasses: CABIN_CLASSES,
  fareClasses: FARE_CLASSES,
};

/**
 * 搭乗日に応じて適用すべきPPルールセットを返す。対応外の日付は null。
 * @param {string} boardingDateISO - "YYYY-MM-DD"
 */
export function ruleForBoardingDate(boardingDateISO) {
  if (typeof boardingDateISO !== 'string') return null;
  if (boardingDateISO >= PP_RULESET_DOMESTIC_2026_05_19.effectiveFrom) {
    return PP_RULESET_DOMESTIC_2026_05_19;
  }
  return null;
}

/** 座席クラス×運賃種別の積算率・搭乗ポイントを取得する。見つからなければ null。 */
export function rateFor(cabinClassId, fareClassId) {
  return RATE_TABLE[`${cabinClassId}:${fareClassId}`] || null;
}
