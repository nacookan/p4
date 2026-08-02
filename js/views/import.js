import { el, externalLink, clear } from '../util/dom.js';
import * as state from '../state.js';
import { parseTimetablePdf } from '../pdf/parser.js';
import { TIMETABLE_GUIDE_PAGE } from '../data/ana-links.js';

export function renderImport() {
  const container = el('div', {});
  const currentTimetable = state.getState().timetable;

  const guideCard = el('div', { className: 'card' }, [
    el('h2', { text: '1. PDF時刻表を入手' }),
    el('p', { text: '国内線PDF時刻表を公式サイトから自身でダウンロードしてください。' }),
    el('p', {}, [externalLink(TIMETABLE_GUIDE_PAGE, TIMETABLE_GUIDE_PAGE)]),
    el('p', { className: 'meta', text: '※利用したい期間の「全エリア」のPDFをダウンロードしてください。' }),
  ]);

  const uploadCard = el('div', { className: 'card' }, [
    el('h2', { text: '2. PDFを読み込む' }),
    el('p', { text: 'ダウンロードしたPDFを以下に読み込ませてください。' }),
  ]);

  if (currentTimetable) {
    uploadCard.appendChild(
      el('div', { className: 'status-banner success' }, [
        el('span', { className: 'icon', text: '✓' }),
        el('span', {
          className: 'status-banner-text',
          text: `現在読み込まれているPDF: ${currentTimetable.doc.validPeriod.from} 〜 ${currentTimetable.doc.validPeriod.to}`,
        }),
      ])
    );
  }

  uploadCard.appendChild(
    el('p', { className: 'meta', text: '※読み込んだPDFはDropboxに保存され、プラン登録に利用できるようになります。' })
  );

  const fileInput = el('input', {
    attrs: { type: 'file', accept: 'application/pdf,.pdf', id: 'pdf-file-input' },
  });
  const label = el('label', { attrs: { for: 'pdf-file-input' }, className: 'sr-only', text: 'PDFファイルを選択' });
  const pickBtn = el('button', { className: 'btn', text: 'PDFファイルを選択' });
  pickBtn.addEventListener('click', () => fileInput.click());

  const progressWrap = el('div', { attrs: { style: 'display:none' } }, [
    el('p', { attrs: { id: 'progress-label' }, text: '解析中…' }),
    el('div', { className: 'progress-bar' }, [el('div', { attrs: { id: 'progress-fill', style: 'width:0%' } })]),
  ]);

  const resultArea = el('div', { attrs: { id: 'import-result' } });

  uploadCard.append(label, fileInput, pickBtn, progressWrap, resultArea);

  let busy = false;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file || busy) return;
    busy = true;
    pickBtn.disabled = true;
    progressWrap.style.display = '';
    clear(resultArea);

    let report;
    try {
      report = await parseTimetablePdf(file, ({ page, totalPages }) => {
        const pct = Math.round((page / totalPages) * 100);
        progressWrap.querySelector('#progress-fill').style.width = `${pct}%`;
        progressWrap.querySelector('#progress-label').textContent = `解析中… (${page}/${totalPages}ページ)`;
      });
    } catch (e) {
      report = { ok: false, fatalErrors: [{ message: `予期しないエラーが発生しました: ${e.message || e}` }], warnings: [], stats: null };
    }

    progressWrap.style.display = 'none';
    pickBtn.disabled = false;
    busy = false;
    fileInput.value = '';
    renderResult(resultArea, report);
  });

  container.append(guideCard, uploadCard);
  return container;
}

function renderResult(container, report) {
  clear(container);

  if (!report.ok) {
    container.appendChild(
      el('div', { className: 'status-banner error' }, [
        el('span', { className: 'icon', text: '✕' }),
        el('div', {}, [
          el('p', { text: 'PDFを取り込めませんでした。既存の時刻表データは変更されていません。' }),
          ...report.fatalErrors.map((e) => el('p', { text: e.message + (e.page ? `（${e.page}ページ）` : '') })),
        ]),
      ])
    );
    if (report.warnings && report.warnings.length > 0) {
      container.appendChild(renderWarningList(report.warnings));
    }
    return;
  }

  const { timetable, warnings, stats } = report;

  container.appendChild(
    el('div', { className: 'card' }, [
      el('h3', { text: '取込プレビュー' }),
      el('ul', {}, [
        el('li', { text: `対象期間: ${timetable.validPeriod.from} 〜 ${timetable.validPeriod.to}（確認日: ${timetable.publishedOn}）` }),
        el('li', { text: `空港数: ${stats.airportCount}` }),
        el('li', { text: `路線数: ${stats.routeCount}` }),
        el('li', { text: `便データ行数: ${stats.flightCount}` }),
        el('li', { text: `日付・時刻・運航会社が複数バリエーションある便名の数: ${stats.variantFlightCount}` }),
        el('li', { text: `運航会社コード: ${stats.carrierCodes.join(', ')}` }),
        el('li', { text: `未知の運航会社コード: ${stats.unknownCarrierCount}件` }),
        el('li', { text: `解釈できなかった運航日備考: ${stats.unparsedRemarkCount}件` }),
        el('li', { text: `PDFファイル SHA-256: ${timetable.source.sha256.slice(0, 16)}…` }),
      ]),
    ])
  );

  if (warnings.length > 0) {
    container.appendChild(renderWarningList(warnings));
  } else {
    container.appendChild(
      el('div', { className: 'status-banner success' }, [
        el('span', { className: 'icon', text: '✓' }),
        el('span', { text: '警告はありませんでした。' }),
      ])
    );
  }

  const confirmBtn = el('button', {
    className: 'btn btn-block',
    text: 'この内容でDropboxに保存する',
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const res = await state.saveTimetable(timetable);
    confirmBtn.disabled = false;
    if (res.ok) {
      window.location.hash = '#/plans';
    } else {
      container.appendChild(
        el('div', { className: 'status-banner error' }, [
          el('span', { className: 'icon', text: '✕' }),
          el('span', { text: res.message }),
        ])
      );
    }
  });

  container.appendChild(
    el('div', { className: 'card' }, [
      el('p', {
        text: '確定するとDropbox上の時刻表データが今回の内容に置き換わります（元のPDFファイル自体は保存されません）。',
      }),
      confirmBtn,
    ])
  );
}

function renderWarningList(warnings) {
  const MAX_SHOW = 50;
  const shown = warnings.slice(0, MAX_SHOW);
  return el('div', { className: 'status-banner warning' }, [
    el('span', { className: 'icon', text: '!' }),
    el('div', {}, [
      el('p', { text: `警告 ${warnings.length}件（内容には影響しない軽微な注記の解釈失敗などを含みます）` }),
      el(
        'ul',
        {},
        shown.map((w) => el('li', { text: `${w.message}${w.page ? `（${w.page}ページ）` : ''}` }))
      ),
      warnings.length > MAX_SHOW ? el('p', { text: `他 ${warnings.length - MAX_SHOW} 件…` }) : null,
    ]),
  ]);
}
