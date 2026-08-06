import { el } from '../util/dom.js';
import * as state from '../state.js';
import { calculateItineraryPP, formatPP } from '../domain/pp-calculator.js';
import { formatDateJa } from '../util/time.js';
import { abbreviateAirport } from '../util/airport-name.js';
import { confirmDialog } from '../util/confirm-dialog.js';

function airportPath(legs) {
  if (legs.length === 0) return '';
  return [legs[0].origin, ...legs.map((l) => l.dest)].map(abbreviateAirport).join('-');
}

export function renderPlanList() {
  const appData = state.getState().appData;
  const plans = (appData && appData.doc.plans) || [];

  const container = el('div', {});
  container.appendChild(
    el('div', { className: 'card title-row' }, [
      el('h2', { text: 'プラン一覧' }),
      el('button', {
        className: 'btn',
        text: '＋ 新規プラン作成',
        on: { click: () => { window.location.hash = '#/plan/new'; } },
      }),
    ])
  );

  if (plans.length === 0) {
    container.appendChild(el('p', { text: '保存されたプランはまだありません。' }));
    return container;
  }

  const sorted = [...plans].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  for (const plan of sorted) {
    const { totalPP, isComplete } = calculateItineraryPP(plan.legs);
    const first = plan.legs[0];
    const last = plan.legs[plan.legs.length - 1];
    let dateRange = '(区間なし)';
    if (first) {
      dateRange =
        first.boardingDate === last.boardingDate
          ? formatDateJa(first.boardingDate)
          : `${formatDateJa(first.boardingDate)} 〜 ${formatDateJa(last.boardingDate)}`;
    }

    const card = el('div', { className: 'card plan-card' }, [
      el('div', {}, [
        el('strong', { text: plan.title || '(無題のプラン)' }),
        el('div', { className: 'meta', text: dateRange }),
        el('div', { className: 'meta', text: `${plan.legs.length}区間（${airportPath(plan.legs)}）` }),
        el('div', { className: 'meta', text: `合計: ${formatPP(totalPP)} PP${isComplete ? '' : '（一部区間は計算不能）'}` }),
      ]),
      el('div', { className: 'actions' }, [
        el('button', { className: 'btn btn-secondary btn-sm', text: '表示', on: { click: () => { window.location.hash = `#/plan/${plan.id}`; } } }),
        el('button', { className: 'btn btn-secondary btn-sm', text: '便を編集', on: { click: () => { window.location.hash = `#/plan/${plan.id}/edit`; } } }),
        el('button', { className: 'btn btn-secondary btn-sm', text: '金額を編集', on: { click: () => { window.location.hash = `#/plan/${plan.id}/price`; } } }),
        el('button', {
          className: 'btn btn-danger btn-sm',
          text: '削除',
          on: {
            click: async () => {
              if (!(await confirmDialog(`プラン「${plan.title || '(無題)'}」を削除しますか？この操作は取り消せません。`))) return;
              // 保存の完了を待たず、見込みで即座に画面から消す。保存に失敗した場合は
              // 上部のバナーでエラーを通知するのみとし、復元はリロード時の再読み込みに委ねる
              // （リロードすればDropbox上の実データ、つまり削除されていない状態に戻る）。
              card.remove();
              if (container.querySelectorAll('.plan-card').length === 0) {
                container.appendChild(el('p', { text: '保存されたプランはまだありません。' }));
              }
              await deletePlan(plan.id);
            },
          },
        }),
      ]),
    ]);
    container.appendChild(card);
  }

  return container;
}

async function deletePlan(planId) {
  const appData = state.getState().appData;
  const newDoc = {
    ...appData.doc,
    plans: appData.doc.plans.filter((p) => p.id !== planId),
  };
  await state.saveAppData(newDoc);
}
