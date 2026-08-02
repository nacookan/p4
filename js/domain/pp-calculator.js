import { lookupBaseMileage } from '../data/mileage-table.js';
import {
  ruleForBoardingDate,
  rateFor,
  DEFAULT_FARE_CLASS_ID,
  DEFAULT_CABIN_CLASS_ID,
  CABIN_CLASSES,
  FARE_CLASSES,
} from '../data/pp-rules.js';
import { isKnownCarrier, carrierInfo } from '../data/carriers.js';

/**
 * 1区間（1フライト）のプレミアムポイントを計算する。
 * 計算できない場合は pp:null と理由(reason)を返す。適当な値で補完しない。
 *
 * @param {object} leg
 * @param {string} leg.origin - 出発空港表示名（例: "東京（羽田）"）
 * @param {string} leg.dest - 到着空港表示名（"destination"ではなく"dest"。旅程データ全体でフィールド名を統一している）
 * @param {string} leg.carrier - 運航会社コード（例: "ANA", "AKX", "SFJ" ...）
 * @param {string} leg.boardingDate - 搭乗日 "YYYY-MM-DD"（JST基準）
 * @param {string} [leg.fareClassId] - 運賃種別ID（省略時は"standard"扱い）
 * @param {string} [leg.cabinClassId] - 座席クラスID（省略時は"economy"扱い）
 * @returns {{pp:number, breakdown:object, rule:object, fareClass:object, cabinClass:object}|{pp:null, reason:string}}
 */
export function calculateSegmentPP(leg) {
  const rule = ruleForBoardingDate(leg.boardingDate);
  if (!rule) {
    return {
      pp: null,
      reason:
        `搭乗日(${leg.boardingDate})は本アプリが対応するPP計算ルールの適用開始日` +
        '(2026-05-19)より前のため、PPを計算できません。公式情報でご確認ください。',
    };
  }

  const fareClassId = leg.fareClassId || DEFAULT_FARE_CLASS_ID;
  const cabinClassId = leg.cabinClassId || DEFAULT_CABIN_CLASS_ID;
  const fareClass = FARE_CLASSES.find((f) => f.id === fareClassId);
  const cabinClass = CABIN_CLASSES.find((c) => c.id === cabinClassId);
  const rate = rateFor(cabinClassId, fareClassId);
  if (!fareClass || !cabinClass || !rate) {
    return { pp: null, reason: `未知の座席クラス/運賃種別「${cabinClassId}/${fareClassId}」のため、PPを計算できません。` };
  }

  if (!isKnownCarrier(leg.carrier)) {
    return {
      pp: null,
      reason: `未知の運航会社コード「${leg.carrier}」のため、PP積算対象かどうか判定できません。`,
    };
  }
  const carrier = carrierInfo(leg.carrier);
  if (!carrier.ppEligible) {
    return {
      pp: null,
      reason: `運航会社「${carrier.name}」はプレミアムポイント積算対象外のため計算できません。`,
    };
  }

  const baseMileage = lookupBaseMileage(leg.origin, leg.dest);
  if (baseMileage === null) {
    return {
      pp: null,
      reason:
        `区間「${leg.origin} ⇔ ${leg.dest}」の区間基本マイレージが` +
        '公式マイレージチャートに見つからないため、PPを計算できません。',
    };
  }

  const mileageWithMultiplier = baseMileage * rate.accrualRate * rule.routeMultiplier;
  const flightMile = Math.floor(mileageWithMultiplier);
  const pp = flightMile + rate.boardingPoints;

  return {
    pp,
    breakdown: {
      baseMileage,
      accrualRate: rate.accrualRate,
      routeMultiplier: rule.routeMultiplier,
      flightMile,
      boardingPoints: rate.boardingPoints,
    },
    rule,
    fareClass,
    cabinClass,
  };
}

/**
 * 旅程（複数区間）の合計PPを計算する。
 * 1区間でも計算不能なら isComplete:false とし、合計は計算できた区間のみの参考値にする。
 */
export function calculateItineraryPP(legs) {
  const results = legs.map((leg) => ({ leg, result: calculateSegmentPP(leg) }));
  const computable = results.filter((r) => r.result.pp !== null);
  const totalPP = computable.reduce((sum, r) => sum + r.result.pp, 0);
  const isComplete = computable.length === results.length;
  return { results, totalPP, isComplete };
}

/** "1,234" のような3桁区切り文字列にする。 */
export function formatPP(n) {
  return n.toLocaleString('ja-JP');
}
