import { el } from '../util/dom.js';
import { formatDateJa } from '../util/time.js';

/**
 * 各区間の運賃（金額メモ）を手入力するフィールド群。
 * プラン作成の最後のステップと、保存済みプランの金額編集の両方から使う。
 *
 * 乗り継ぎ等で複数区間がまとめて1つの運賃になっているケースのため、
 * 2区間目以降には「上の便に合算されています」チェックボックスを置く。
 * チェックした区間は金額入力欄を隠し、その区間自体の金額メモは持たない
 * （PP単価計算では、合算先の便のPPにこの区間のPPを加算して扱う）。
 *
 * @param {object} opts
 * @param {object[]} opts.legs
 * @param {(number|null)[]} [opts.initialPrices] legsと同じ順の初期値（円、未入力はnull）
 * @param {boolean[]} [opts.initialMerged] legsと同じ順の初期値（上の便に合算されているか）
 * @returns {{node: HTMLElement, getPrices: () => (number|null)[], getMergedFlags: () => boolean[]}}
 */
export function renderPriceFields({ legs, initialPrices, initialMerged }) {
  const inputs = [];
  const mergedCheckboxes = [];
  const wrap = el('div', { className: 'price-fields' });

  legs.forEach((leg, idx) => {
    const initial = initialPrices && initialPrices[idx] != null ? String(initialPrices[idx]) : '';
    const isMerged = Boolean(initialMerged && initialMerged[idx]);
    const input = el('input', {
      attrs: {
        type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: '未入力', value: initial,
        style: isMerged ? 'display:none' : null,
      },
    });
    inputs.push(input);

    const fieldChildren = [
      el('label', {
        text: `${formatDateJa(leg.boardingDate)} ${leg.flightNo} ${leg.dep} ${leg.origin} → ${leg.arr} ${leg.dest}（円）`,
      }),
      input,
    ];

    let checkbox = null;
    if (idx > 0) {
      checkbox = el('input', { attrs: { type: 'checkbox', checked: isMerged } });
      checkbox.addEventListener('change', () => {
        input.style.display = checkbox.checked ? 'none' : '';
        if (checkbox.checked) input.value = '';
      });
      fieldChildren.push(
        el('label', { className: 'checkbox-label' }, [
          checkbox,
          el('span', { text: `上の便(${legs[idx - 1].flightNo})に合算されています` }),
        ])
      );
    }
    mergedCheckboxes.push(checkbox);

    wrap.appendChild(el('div', { className: 'field' }, fieldChildren));
  });

  function getPrices() {
    return inputs.map((input, idx) => {
      if (mergedCheckboxes[idx] && mergedCheckboxes[idx].checked) return null;
      const v = input.value.trim();
      if (v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    });
  }

  function getMergedFlags() {
    return mergedCheckboxes.map((cb) => Boolean(cb && cb.checked));
  }

  return { node: wrap, getPrices, getMergedFlags };
}
