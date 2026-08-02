import { el } from '../util/dom.js';
import { renderImport } from './import.js';

// 現時点では設定項目は時刻表の取込のみ。今後アプリ設定が増えた場合は
// ここにセクションを追加していく。
export function renderSettings() {
  return el('div', {}, [el('h2', { text: '設定' }), renderImport()]);
}
