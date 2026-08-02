import { el, clear } from '../util/dom.js';
import { groupAirportsByRegion } from '../data/airport-regions.js';

/**
 * ドロップダウンの代わりに使う、タップしやすい空港選択UI。
 * 「最近使った空港」と「すべての空港（地方区分ごと・北から南）」を切り替えられる。
 *
 * @param {object} opts
 * @param {string[]} opts.airports 時刻表に含まれる全空港名
 * @param {string[]} opts.recentAirports 最近使った空港名（新しい順）
 * @param {string|null} opts.initialValue 初期選択値
 * @param {(airport:string)=>void} opts.onChange 選択が変わるたびに呼ばれる
 * @returns {{node: HTMLElement, getValue: () => string|null}}
 */
export function renderAirportPicker({ airports, recentAirports, initialValue, onChange }) {
  let selected = initialValue || null;
  let mode = recentAirports && recentAirports.length > 0 ? 'recent' : 'all';

  const container = el('div', { className: 'airport-picker' });
  const tabs = el('div', { className: 'airport-picker-tabs', attrs: { role: 'tablist', 'aria-label': '空港の絞り込み' } });
  const listArea = el('div', { className: 'airport-picker-list' });
  const selectedLabel = el('p', { className: 'airport-picker-selected', attrs: { role: 'status' } });

  function chip(airport) {
    const isSelected = airport === selected;
    return el('button', {
      className: `airport-chip${isSelected ? ' selected' : ''}`,
      text: airport,
      attrs: { type: 'button', 'aria-pressed': isSelected ? 'true' : 'false' },
      on: {
        click: () => {
          selected = airport;
          onChange(selected);
          renderList();
          renderSelectedLabel();
        },
      },
    });
  }

  function renderSelectedLabel() {
    selectedLabel.textContent = selected ? `選択中: ${selected}` : '空港を選択してください';
  }

  function renderList() {
    clear(listArea);
    if (mode === 'recent') {
      if (!recentAirports || recentAirports.length === 0) {
        listArea.appendChild(el('p', { className: 'meta', text: 'まだ利用履歴がありません。「すべての空港」から選んでください。' }));
      } else {
        listArea.appendChild(el('div', { className: 'airport-chip-grid' }, recentAirports.map(chip)));
      }
    } else {
      const groups = groupAirportsByRegion(airports);
      for (const g of groups) {
        listArea.appendChild(el('h4', { className: 'airport-region-heading', text: g.region }));
        listArea.appendChild(el('div', { className: 'airport-chip-grid' }, g.airports.map(chip)));
      }
    }
  }

  function renderTabs() {
    clear(tabs);
    const defs = [
      { key: 'recent', label: '最近使った空港' },
      { key: 'all', label: 'すべての空港' },
    ];
    for (const d of defs) {
      tabs.appendChild(
        el('button', {
          className: `tab-button${mode === d.key ? ' active' : ''}`,
          text: d.label,
          attrs: { type: 'button', role: 'tab', 'aria-selected': mode === d.key ? 'true' : 'false' },
          on: {
            click: () => {
              mode = d.key;
              renderTabs();
              renderList();
            },
          },
        })
      );
    }
  }

  renderTabs();
  renderList();
  renderSelectedLabel();
  container.append(tabs, listArea, selectedLabel);

  return { node: container, getValue: () => selected };
}
