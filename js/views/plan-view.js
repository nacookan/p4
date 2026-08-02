import { el } from '../util/dom.js';
import * as state from '../state.js';
import { calculateItineraryPP, formatPP } from '../domain/pp-calculator.js';
import { renderItineraryTable, formatYen, ppUnitPriceText } from './itinerary-table.js';

// PP単価の評価基準（円/PPが小さいほど高評価）。
const STAR_TIERS = [
  { max: 8, stars: '☆☆☆☆☆', label: '8円以下' },
  { max: 10, stars: '☆☆☆☆', label: '10円以下' },
  { max: 12, stars: '☆☆☆', label: '12円以下' },
  { max: 15, stars: '☆☆', label: '15円以下' },
  { max: Infinity, stars: '☆', label: '15円超' },
];

function starTierFor(unitPrice) {
  return STAR_TIERS.find((t) => unitPrice <= t.max);
}

// マイル→SKYコインの交換レート。ステータスや保有カード等の条件により1.0倍、
// または1.2〜1.7倍（0.1刻み）のいずれかになる。
const MILE_EXCHANGE_RATES = [1.0, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7];

function renderPpEvaluation(totalPrice, totalPP) {
  const unitPrice = totalPrice / totalPP;
  const tier = starTierFor(unitPrice);
  const unitPriceText = ppUnitPriceText(totalPrice, totalPP);

  const tierTable = el('table', {}, [
    el('thead', {}, [el('tr', {}, [el('th', { text: '基準' }), el('th', { text: '評価' }), el('th', {})])]),
    el(
      'tbody',
      {},
      STAR_TIERS.map((t) =>
        el('tr', { className: t === tier ? 'tier-row current' : 'tier-row' }, [
          el('td', { text: t.label }),
          el('td', { text: t.stars }),
          el('td', { text: t === tier ? `👈 ${unitPriceText}` : '' }),
        ])
      )
    ),
  ]);

  const exchangeTable = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [el('th', { text: '交換レート' }), el('th', { text: '実質金額(マイル)' }), el('th', { text: '実質単価' })]),
    ]),
    el(
      'tbody',
      {},
      MILE_EXCHANGE_RATES.map((rate) => {
        // このレートでtotalPrice円分のSKYコインを得るのに実際に消費するマイル相当額
        // （1マイル=1円換算）。rate倍して totalPrice になる金額なので totalPrice/rate。
        const effectiveAmount = totalPrice / rate;
        return el('tr', {}, [
          el('td', { text: `${rate.toFixed(1)}倍` }),
          el('td', { text: formatYen(Math.round(effectiveAmount)) }),
          el('td', { text: ppUnitPriceText(effectiveAmount, totalPP) || '—' }),
        ]);
      })
    ),
  ]);

  return el('div', {}, [
    el('div', { className: 'card' }, [
      el('h3', { text: 'PP単価評価' }),
      el('div', { className: 'table-scroll' }, [tierTable]),
    ]),
    el('div', { className: 'card' }, [
      el('h3', { text: 'マイルからSKYコインに交換して購入する場合' }),
      el('div', { className: 'table-scroll' }, [exchangeTable]),
    ]),
  ]);
}

export function renderPlanView({ planId }) {
  const appData = state.getState().appData;
  const plan = appData && appData.doc.plans.find((p) => p.id === planId);
  if (!plan) {
    return el('p', { text: 'プランが見つかりませんでした。' });
  }

  const { results, totalPP, isComplete } = calculateItineraryPP(plan.legs);

  const container = el('div', {});
  container.appendChild(
    el('div', { className: 'card' }, [
      el('h2', { text: plan.title }),
      el('div', { className: 'actions' }, [
        el('button', { className: 'btn btn-secondary btn-sm', text: '便を編集', on: { click: () => { window.location.hash = `#/plan/${plan.id}/edit`; } } }),
        el('button', { className: 'btn btn-secondary btn-sm', text: '金額を編集', on: { click: () => { window.location.hash = `#/plan/${plan.id}/price`; } } }),
        el('button', {
          className: 'btn btn-danger btn-sm',
          text: '削除',
          on: {
            click: async () => {
              if (!confirm('このプランを削除しますか？この操作は取り消せません。')) return;
              const newDoc = { ...appData.doc, plans: appData.doc.plans.filter((p) => p.id !== plan.id) };
              const res = await state.saveAppData(newDoc);
              if (res.ok) window.location.hash = '#/plans';
            },
          },
        }),
      ]),
    ])
  );

  container.appendChild(el('div', { className: 'card table-scroll' }, [renderItineraryTable(plan.legs, results)]));

  const enteredPrices = plan.legs.map((l) => l.priceMemo).filter((p) => p != null);
  const totalPriceSummary = [];
  let totalPrice = null;
  if (enteredPrices.length > 0) {
    totalPrice = enteredPrices.reduce((a, b) => a + b, 0);
    totalPriceSummary.push(el('div', { className: 'meta', text: `合計金額: ${formatYen(totalPrice)}` }));
    totalPriceSummary.push(el('div', { className: 'meta', text: `PP単価: ${ppUnitPriceText(totalPrice, totalPP) || '—'}` }));
  }

  container.appendChild(
    el('div', { className: 'card' }, [
      el('div', { className: 'pp-total', text: `合計: ${formatPP(totalPP)} PP${isComplete ? '' : '（一部区間は計算不能。上表参照）'}` }),
      ...totalPriceSummary,
    ])
  );

  if (totalPrice != null && totalPP > 0) {
    container.appendChild(renderPpEvaluation(totalPrice, totalPP));
  }

  return container;
}
