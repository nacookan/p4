import * as state from './state.js';
import { el, clear } from './util/dom.js';
import { isConfigured } from './dropbox/oauth.js';
import { confirmDialog } from './util/confirm-dialog.js';

import { renderConnect } from './views/connect.js';
import { renderPlanList } from './views/plan-list.js';
import { renderPlanEditor } from './views/plan-editor.js';
import { renderPlanView } from './views/plan-view.js';
import { renderAbout } from './views/about.js';
import { renderSettings } from './views/settings.js';

const appRoot = document.getElementById('app');

const NAV_ITEMS = [
  { hash: '#/plans', label: 'プラン' },
  { hash: '#/settings', label: '設定' },
  { hash: '#/about', label: 'P⁴について' },
];

// 現在表示中のビューを保持する固定のシェル要素。
// 「保存中/保存完了/保存失敗」のような一時的な状態表示だけで画面全体を
// 作り直すと、プラン作成画面のようにローカルな編集状態を持つビューが
// 保存の途中で丸ごと再生成されてしまい、入力中の内容が失われたり
// エラーメッセージが見えなくなったりする（実際に発生したバグ）。
// そのため、「どのビューを表示するか」が変わったとき（URLハッシュ、
// 接続状態、データ読み込みエラーの有無が変わったとき）だけビュー本体を
// 再構築し、保存状態バナーはビューを再構築せずに独立して更新する。
let shellBuilt = false;
let bannerSlot;
let mainEl;
let lastSignature = null;

function currentRoute() {
  const hash = window.location.hash || '#/plans';
  const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
  return parts;
}

function buildShellOnce() {
  if (shellBuilt) return;
  clear(appRoot);

  const header = el('header', { className: 'app-header' }, [
    el('div', {}, [
      el('h1', { className: 'app-title' }, [
        el('span', { className: 'app-title-main', text: 'P⁴' }),
        el('small', { text: 'PP Power Plan' }),
      ]),
    ]),
    el('button', {
      className: 'btn btn-secondary',
      text: 'ログアウト',
      attrs: { id: 'disconnect-btn', style: 'display:none' },
      on: {
        click: async () => {
          if (await confirmDialog('ログアウトしますか？Dropbox上のデータは削除されません。')) {
            await state.disconnect();
          }
        },
      },
    }),
  ]);

  const nav = el(
    'nav',
    { className: 'app-nav', attrs: { id: 'app-nav', 'aria-label': '主要なページ' } },
    NAV_ITEMS.map((item) =>
      el('button', {
        text: item.label,
        attrs: { 'data-hash': item.hash },
        on: { click: () => { window.location.hash = item.hash; } },
      })
    )
  );

  bannerSlot = el('div', { attrs: { id: 'saving-banner-slot' } });
  mainEl = el('main', {}, [bannerSlot]);

  appRoot.append(header, nav, mainEl);
  shellBuilt = true;
}

function updateNavAndHeader(currentHashPrefix) {
  const s = state.getState();
  document.getElementById('disconnect-btn').style.display = s.connectivity === 'online' ? '' : 'none';
  for (const btn of appRoot.querySelectorAll('#app-nav button')) {
    if (btn.getAttribute('data-hash') === currentHashPrefix) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
}

function updateBanner() {
  const s = state.getState();
  clear(bannerSlot);
  if (s.savingStatus === 'idle') return;
  const kind = s.savingStatus === 'failed' ? 'error' : s.savingStatus === 'saved' ? 'success' : 'warning';
  const icon = s.savingStatus === 'failed' ? '✕' : s.savingStatus === 'saved' ? '✓' : '…';
  const dismissible = s.savingStatus !== 'saving';
  bannerSlot.appendChild(
    el('div', { className: `status-banner ${kind}`, attrs: { role: 'status' } }, [
      el('span', { className: 'icon', text: icon }),
      el('span', { className: 'status-banner-text', text: s.savingMessage }),
      dismissible
        ? el('button', {
            className: 'status-banner-dismiss',
            text: '×',
            attrs: { type: 'button', 'aria-label': 'このメッセージを閉じる' },
            on: { click: () => state.dismissSavingStatus() },
          })
        : null,
    ])
  );
}

function computeSignature(s, hash) {
  return JSON.stringify({
    connectivity: s.connectivity,
    dataError: s.dataError,
    hasTimetable: Boolean(s.timetable),
    hash,
  });
}

function renderView() {
  const s = state.getState();
  const parts = currentRoute();
  const top = parts[0] || 'plans';
  const hashPrefix = `#/${top}`;

  let node;
  if (top === 'about') {
    node = renderAbout();
  } else if (!isConfigured()) {
    node = el('div', { className: 'status-banner error' }, [
      el('span', { className: 'icon', text: '!' }),
      el('div', {}, [
        el('p', { text: 'Dropbox App Keyが設定されていません。' }),
        el('p', { text: 'js/dropbox-config.js を作成し、Dropbox App Keyを設定してください（README参照）。' }),
      ]),
    ]);
  } else if (s.connectivity === 'checking') {
    node = el('p', { text: '接続を確認しています…' });
  } else if (s.connectivity === 'unauthenticated') {
    node = renderConnect();
  } else if (s.connectivity === 'offline') {
    node = el('div', { className: 'status-banner error' }, [
      el('span', { className: 'icon', text: '!' }),
      el('div', {}, [
        el('p', { text: 'Dropboxに接続できません。ネットワーク接続を確認してください。' }),
        s.lastError ? el('p', { text: s.lastError }) : null,
        el('button', { className: 'btn', text: '再接続を試す', on: { click: () => state.recheckConnectivity() } }),
      ]),
    ]);
  } else if (s.dataError) {
    node = el('div', { className: 'status-banner error' }, [
      el('span', { className: 'icon', text: '!' }),
      el('div', {}, [
        el('p', { text: 'Dropbox上のデータを読み込めませんでした。' }),
        el('p', { text: s.dataError }),
        el('p', { text: 'このアプリの対応バージョンとデータの形式が一致しない可能性があります。手動でDropbox上のファイルを確認してください。' }),
      ]),
    ]);
  } else {
    switch (top) {
      case 'settings':
        node = renderSettings();
        break;
      case 'plans':
        node = renderPlanList();
        break;
      case 'plan':
        if (parts[1] === 'new') node = renderPlanEditor({ mode: 'new' });
        else if (parts[2] === 'edit') node = renderPlanEditor({ mode: 'edit', planId: parts[1] });
        else if (parts[2] === 'price') node = renderPlanEditor({ mode: 'price', planId: parts[1] });
        else if (parts[1]) node = renderPlanView({ planId: parts[1] });
        else node = renderPlanList();
        break;
      default:
        node = renderPlanList();
    }
  }

  buildShellOnce();
  // bannerSlotの後ろにビュー本体を差し込む（バナーは常に先頭に維持）。
  while (mainEl.children.length > 1) mainEl.removeChild(mainEl.lastChild);
  mainEl.appendChild(node);
  updateNavAndHeader(hashPrefix);
  updateBanner();
}

function onStateOrHashChange() {
  buildShellOnce();
  const s = state.getState();
  const hash = window.location.hash || '#/plans';
  const signature = computeSignature(s, hash);
  if (signature !== lastSignature) {
    lastSignature = signature;
    renderView();
  } else {
    // 表示中のビューはそのまま。保存状態バナーとヘッダーだけ更新する。
    updateBanner();
    updateNavAndHeader(`#/${currentRoute()[0] || 'plans'}`);
  }
}

window.addEventListener('hashchange', onStateOrHashChange);
state.subscribe(() => onStateOrHashChange());

state.init();
