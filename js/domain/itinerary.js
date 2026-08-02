// 旅程（プラン）作成のドメインロジック。
// 「次に選択可能な便」の絞り込みルールをすべてここに集約する。
import { addDays, compareDateTime, isWithinPeriod } from '../util/time.js';
import { operatesOnDate } from '../pdf/date-rules.js';

// 同一都市内の複数空港（大阪: 伊丹⇔関西⇔神戸、東京: 羽田⇔成田）は、
// 「どちらかに到着したら、次便はどちらからでも選べる」を扱う特例。
const AIRPORT_TRANSFER_GROUPS = [
  ['大阪（伊丹）', '大阪（関西）', '大阪（神戸）'],
  ['東京（羽田）', '東京（成田）'],
];

function transferGroupOf(airport) {
  return AIRPORT_TRANSFER_GROUPS.find((group) => group.includes(airport)) || null;
}

/**
 * 到着空港から、次便の出発地として選択可能な空港の集合を返す。
 * 同一都市内の空港グループ（伊丹⇔関西、羽田⇔成田）は相互に選択可能。
 * それ以外は到着空港そのものだけ。
 */
export function eligibleDepartureAirports(arrivalAirport) {
  const group = transferGroupOf(arrivalAirport);
  return group ? [...group] : [arrivalAirport];
}

/**
 * 出発空港と到着空港が同一都市内の空港グループ間の入れ替わりであれば、
 * 空港間の移動が必要である旨の情報を返す（固定の所要時間は付与しない）。
 */
export function airportTransferInfo(previousArrivalAirport, nextDepartureAirport) {
  if (previousArrivalAirport === nextDepartureAirport) return null;
  const group = transferGroupOf(previousArrivalAirport);
  if (group && group.includes(nextDepartureAirport)) {
    return { from: previousArrivalAirport, to: nextDepartureAirport };
  }
  return null;
}

/**
 * 現在地・基準日時から、選択可能な次の便の候補一覧を返す。
 *
 * 絞り込みルール（すべて要件どおり）:
 *  - 現在地から出発する便のみ（大阪の伊丹/関西は相互に現在地とみなす）
 *  - 正確な搭乗日に運航する便のみ（時刻表の運航日ルールで判定）
 *  - 基準時刻以降に出発する便のみ
 *  - 同じ暦日、またはその翌日の便のみ（2日以上先は不可）
 *
 * @param {object} timetable パース済み時刻表（js/pdf/parser.jsの出力のtimetable）
 * @param {string[]} currentAirports 現在地となりうる空港名の配列（1件 or 大阪特例で2件）
 * @param {string} referenceDate 基準日 "YYYY-MM-DD"
 * @param {string} referenceTime 基準時刻 "HH:MM"
 * @returns {object[]} 候補一覧
 */
export function findNextFlightCandidates(timetable, currentAirports, referenceDate, referenceTime) {
  const candidates = [];
  const period = timetable.validPeriod;
  const candidateDates = [referenceDate, addDays(referenceDate, 1)];

  for (const route of timetable.routes) {
    if (!currentAirports.includes(route.origin)) continue;
    for (const flight of route.flights) {
      for (const boardingDate of candidateDates) {
        if (!isWithinPeriod(boardingDate, period)) continue;
        if (!operatesOnDate(flight.operating, boardingDate, period)) continue;
        const isNextDay = boardingDate !== referenceDate;
        if (!isNextDay) {
          // 同一暦日: 基準時刻以降の出発のみ
          if (compareDateTime(boardingDate, flight.dep, referenceDate, referenceTime) < 0) continue;
        }
        // 翌日便は時刻を問わず選択可（その場所での宿泊を伴う）
        candidates.push({
          route: { origin: route.origin, dest: route.dest },
          flightNo: flight.flightNo,
          carrier: flight.carrier,
          dep: flight.dep,
          arr: flight.arr,
          boardingDate,
          isOvernightStay: isNextDay,
        });
      }
    }
  }

  candidates.sort((a, b) => compareDateTime(a.boardingDate, a.dep, b.boardingDate, b.dep));
  return candidates;
}

/**
 * 到着日時が出発日時より前にならないことを検証する（原則として時刻表上は
 * 出発<到着のはずだが、日付をまたぐ便を含め念のため検証する）。
 * 到着が翌日になる可能性があるため、単純な時刻比較ではなく、
 * 出発>=到着ならその便は日付またぎ（到着は搭乗日の翌日）とみなす。
 */
export function resolveArrivalDate(boardingDate, dep, arr) {
  if (compareDateTime(boardingDate, arr, boardingDate, dep) < 0) {
    return addDays(boardingDate, 1);
  }
  return boardingDate;
}

/**
 * 選択済みの区間リスト(legs)が、現在の時刻表データに対してなお整合しているかを検証する。
 * 日付変更などの編集後、後続区間が成立しなくなっていないかを確認するために使う。
 * @returns {{valid:boolean, brokenAtIndex:number|null, message:string|null}}
 */
export function validateItineraryChain(timetable, legs) {
  if (legs.length === 0) return { valid: true, brokenAtIndex: null, message: null };
  const period = timetable.validPeriod;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (!isWithinPeriod(leg.boardingDate, period)) {
      return { valid: false, brokenAtIndex: i, message: `${i + 1}区間目の搭乗日が時刻表の対象期間外です。` };
    }
    // 同じ便名で日付/時刻/運航会社が異なる複数バリエーションが存在しうるため、
    // 便名だけでなく出発/到着時刻・運航会社まで一致するものを探す
    // （便名だけで検索すると、たまたま配列内で先に見つかった別バリエーションの
    // 運航日で判定してしまい、実際には運航している便を「運航しない」と
    // 誤判定するバグになる）。
    const route = timetable.routes.find((r) => r.origin === leg.origin && r.dest === leg.dest);
    const flight =
      route &&
      route.flights.find(
        (f) => f.flightNo === leg.flightNo && f.dep === leg.dep && f.arr === leg.arr && f.carrier === leg.carrier
      );
    if (!flight) {
      return { valid: false, brokenAtIndex: i, message: `${i + 1}区間目の便（${leg.flightNo}）が時刻表に見つかりません。` };
    }
    if (!operatesOnDate(flight.operating, leg.boardingDate, period)) {
      return {
        valid: false,
        brokenAtIndex: i,
        message: `${i + 1}区間目の便（${leg.flightNo}）は${leg.boardingDate}に運航しません。`,
      };
    }
    if (i > 0) {
      const prev = legs[i - 1];
      const prevArrivalDate = resolveArrivalDate(prev.boardingDate, prev.dep, prev.arr);
      const eligible = eligibleDepartureAirports(prev.dest);
      if (!eligible.includes(leg.origin)) {
        return {
          valid: false,
          brokenAtIndex: i,
          message: `${i}区間目の到着地（${prev.dest}）から${i + 1}区間目の出発地（${leg.origin}）へは接続できません。`,
        };
      }
      const dayDiff = Math.round(
        (Date.parse(leg.boardingDate) - Date.parse(prevArrivalDate)) / (24 * 60 * 60 * 1000)
      );
      if (dayDiff < 0) {
        return { valid: false, brokenAtIndex: i, message: `${i + 1}区間目の出発が前区間の到着より前になっています。` };
      }
      if (dayDiff === 0) {
        if (compareDateTime(leg.boardingDate, leg.dep, prevArrivalDate, prev.arr) < 0) {
          return {
            valid: false,
            brokenAtIndex: i,
            message: `${i + 1}区間目の出発時刻が前区間の到着時刻より前になっています。`,
          };
        }
      } else if (dayDiff > 1) {
        return {
          valid: false,
          brokenAtIndex: i,
          message: `${i + 1}区間目が前区間到着の2日以上先になっています。`,
        };
      }
    }
  }
  return { valid: true, brokenAtIndex: null, message: null };
}
