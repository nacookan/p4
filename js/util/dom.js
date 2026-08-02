// 安全なDOM構築ヘルパー。PDFやDropboxから読み込んだ文字列は必ずtextContent/属性値
// としてのみ挿入し、innerHTMLでHTMLとして解釈させない（DOM XSS対策）。

/**
 * 要素を作る。
 * @param {string} tag
 * @param {object} [opts]
 * @param {string} [opts.text] textContentに設定するテキスト（HTMLとして解釈されない）
 * @param {string} [opts.className]
 * @param {object} [opts.attrs] 追加のHTML属性
 * @param {object} [opts.on] イベントリスナー { click: fn, ... }
 * @param {(Node|string)[]} [opts.children]
 */
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === false || v === null || v === undefined) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (opts.on) {
    for (const [ev, fn] of Object.entries(opts.on)) node.addEventListener(ev, fn);
  }
  const kids = opts.children || children;
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 外部リンクは安全な属性を付与して新しいタブで開く。 */
export function externalLink(href, text) {
  return el('a', {
    text,
    attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
  });
}
