import { el } from '../util/dom.js';
import * as state from '../state.js';

export function renderConnect() {
  return el('div', {}, [
    el('div', { className: 'card' }, [
      el('h2', { text: 'P⁴へようこそ' }),
      el('p', {
        text:
          'P⁴はDropbox連携することで利用できます。あなた自身のDropboxアカウント内の' +
          '専用フォルダ(App Folder)にPDF時刻表とプランを保存します。',
      }),
      el('ul', {}, [
        el('li', { text: '要求する権限: アプリ専用フォルダ内ファイルの読み取り・書き込みのみ' }),
        el('li', { text: 'アカウント情報やその他のフォルダにはアクセスしません' }),
        el('li', { text: 'このアプリにはデータを保存するサーバーはありません' }),
      ]),
      el('button', {
        className: 'btn btn-block',
        text: 'Dropbox連携でログイン',
        on: { click: () => state.connect() },
      }),
    ]),
  ]);
}
