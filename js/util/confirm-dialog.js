import { el } from './dom.js';

/**
 * window.confirm()の代わりに使う、アプリ内の確認モーダル。
 *
 * window.confirm()はブラウザによって、タブがアクティブでない瞬間に呼ばれると
 * ダイアログ自体が表示されずfalseを返すことがある
 * （Chrome: "not the active tab of the front window"）。この場合ユーザーには
 * 「ボタンを押しても何も起きない」ように見えてしまう。実際にこれが原因で
 * 削除ボタンが反応しないという報告があったため、確認UIを自前のDOM要素に
 * 置き換えることでこの問題を回避する。
 *
 * @param {string} message
 * @returns {Promise<boolean>} OKならtrue、キャンセル・背景クリック・Escapeならfalse
 */
export function confirmDialog(message) {
  return new Promise((resolve) => {
    function close(result) {
      document.removeEventListener('keydown', onKeydown);
      backdrop.remove();
      resolve(result);
    }
    function onKeydown(ev) {
      if (ev.key === 'Escape') close(false);
    }

    const okBtn = el('button', {
      className: 'btn btn-danger',
      text: 'OK',
      attrs: { type: 'button' },
      on: { click: () => close(true) },
    });
    const cancelBtn = el('button', {
      className: 'btn btn-secondary',
      text: 'キャンセル',
      attrs: { type: 'button' },
      on: { click: () => close(false) },
    });
    const box = el('div', { className: 'confirm-box card', attrs: { role: 'alertdialog', 'aria-modal': 'true' } }, [
      el('p', { text: message }),
      el('div', { className: 'actions' }, [cancelBtn, okBtn]),
    ]);
    const backdrop = el('div', { className: 'confirm-backdrop' }, [box]);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close(false);
    });

    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKeydown);
    okBtn.focus();
  });
}
