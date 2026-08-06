import { el, clear } from '../util/dom.js';
import * as state from '../state.js';
import {
  findNextFlightCandidates,
  eligibleDepartureAirports,
  airportTransferInfo,
  resolveArrivalDate,
  validateItineraryChain,
} from '../domain/itinerary.js';
import { calculateSegmentPP, calculateItineraryPP, formatPP } from '../domain/pp-calculator.js';
import { generateId, withRecentAirports } from '../domain/schema.js';
import { formatDateShortJa, addDays, todayJST, minutesBetween } from '../util/time.js';
import { renderAirportPicker } from './airport-picker.js';
import { renderPriceFields } from './price-fields.js';
import { renderItineraryTable, formatDuration } from './itinerary-table.js';
import { confirmDialog } from '../util/confirm-dialog.js';
import { CABIN_CLASSES, FARE_CLASSES, DEFAULT_CABIN_CLASS_ID, DEFAULT_FARE_CLASS_ID } from '../data/pp-rules.js';
import { groupAirportsByRegion } from '../data/airport-regions.js';

export function renderPlanEditor({ mode, planId }) {
  if (mode === 'price') {
    return renderPriceEditor(planId);
  }

  const container = el('div', {});
  const timetableEntry = state.getState().timetable;

  if (!timetableEntry) {
    container.appendChild(
      el('div', { className: 'status-banner warning' }, [
        el('span', { className: 'icon', text: '!' }),
        el('div', {}, [
          el('p', { text: 'プランを作成するには先に時刻表を取り込んでください。' }),
          el('button', { className: 'btn', text: '設定（時刻表取込）へ', on: { click: () => { window.location.hash = '#/settings'; } } }),
        ]),
      ])
    );
    return container;
  }
  const timetable = timetableEntry.doc;

  // エディタのローカル状態
  const editorState = {
    title: '',
    legs: [],
  };

  if (mode === 'edit') {
    const appData = state.getState().appData;
    const existing = appData.doc.plans.find((p) => p.id === planId);
    if (!existing) {
      container.appendChild(el('p', { text: 'プランが見つかりませんでした。' }));
      return container;
    }
    editorState.title = existing.title;
    editorState.legs = existing.legs.map((l) => ({ ...l }));
    editorState.planId = planId;
    editorState.createdAt = existing.createdAt;

    const check = validateItineraryChain(timetable, editorState.legs);
    if (!check.valid) {
      editorState.legs = editorState.legs.slice(0, check.brokenAtIndex);
      container.appendChild(
        el('div', { className: 'status-banner warning' }, [
          el('span', { className: 'icon', text: '!' }),
          el('span', {
            text: `時刻表の更新により、このプランの${check.brokenAtIndex + 1}区間目以降が成立しなくなったため取り除きました（${check.message}）。続きを選び直してください。`,
          }),
        ])
      );
    }
  }

  const body = el('div', {});
  container.appendChild(body);
  renderBody();

  function renderBody() {
    clear(body);
    body.appendChild(renderItinerarySoFar());
    if (editorState.legs.length === 0) {
      if (editorState.pendingReference) {
        body.appendChild(renderCandidateList());
        body.appendChild(
          el('button', {
            className: 'btn btn-secondary',
            text: '出発条件を変更する',
            on: {
              click: () => {
                editorState.pendingReference = null;
                renderBody();
              },
            },
          })
        );
      } else {
        body.appendChild(renderInitialForm());
      }
    } else {
      body.appendChild(renderNextStepChooser());
      body.appendChild(renderFinishArea());
    }
  }

  function renderItinerarySoFar() {
    if (editorState.legs.length === 0) return el('div', {});
    const { results, totalPP, isComplete } = calculateItineraryPP(editorState.legs);
    const wrap = el('div', { className: 'card' }, [el('h2', { text: '旅程' })]);
    const tableWrap = el('div', { className: 'table-scroll' }, [
      renderItineraryTable(editorState.legs, results, {
        showPrice: false,
        onDeleteFrom: async (idx) => {
          const message =
            idx === 0
              ? '1区間目から旅程をやり直しますか？選択済みの区間はすべて削除されます。'
              : `${idx + 1}区間目以降を旅程から削除しますか？`;
          if (await confirmDialog(message)) {
            editorState.legs = editorState.legs.slice(0, idx);
            // 全区間を削除したときは、直前の区間の到着地・到着日時を指したままの
            // pendingReferenceを、最初に指定した出発条件（initialReference）に
            // 戻す。出発条件フォームからやり直させるのではなく、同じ出発条件のまま
            // 最初の便の候補一覧に戻す（edit時など初期条件が無ければ空になり、
            // 結果として出発条件フォームに戻る）。
            if (idx === 0) editorState.pendingReference = editorState.initialReference || null;
            renderBody();
          }
        },
      }),
    ]);
    wrap.appendChild(tableWrap);
    wrap.appendChild(el('div', { className: 'pp-total', text: `合計: ${formatPP(totalPP)} PP${isComplete ? '' : '（一部区間は計算不能）'}` }));
    wrap.appendChild(el('p', { className: 'meta', text: `使用中の時刻表: ${timetable.validPeriod.from} 〜 ${timetable.validPeriod.to}` }));
    return wrap;
  }

  function renderInitialForm() {
    const today = todayJST();
    const defaultDate =
      today >= timetable.validPeriod.from && today <= timetable.validPeriod.to ? today : '';
    const dateInput = el('input', {
      attrs: { type: 'date', min: timetable.validPeriod.from, max: timetable.validPeriod.to, required: true, value: defaultDate },
    });
    const recentAirports = (state.getState().appData.doc.settings.recentDepartureAirports || []).filter((a) =>
      timetable.airports.includes(a)
    );
    const picker = renderAirportPicker({
      airports: timetable.airports,
      recentAirports,
      initialValue: recentAirports[0] || null,
      onChange: () => clear(errorArea),
    });
    const errorArea = el('div', {});

    const form = el('form', { className: 'card' }, [
      el('h2', { text: '出発条件を指定' }),
      el('div', { className: 'field' }, [el('label', { text: '出発日' }), dateInput]),
      el('div', { className: 'field' }, [el('label', { text: '出発空港' }), picker.node]),
      errorArea,
      el('button', { className: 'btn btn-block', text: '候補の便を表示', attrs: { type: 'submit' } }),
    ]);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      clear(errorArea);
      const date = dateInput.value;
      const airport = picker.getValue();
      if (!date) {
        errorArea.appendChild(el('p', { className: 'status-banner error', text: '出発日を指定してください。' }));
        return;
      }
      if (date < timetable.validPeriod.from || date > timetable.validPeriod.to) {
        errorArea.appendChild(el('div', { className: 'status-banner error', text: '出発日は時刻表の対象期間内である必要があります。' }));
        return;
      }
      if (!airport) {
        errorArea.appendChild(el('div', { className: 'status-banner error', text: '出発空港を選択してください。' }));
        return;
      }
      const reference = { airports: [airport], date, time: '00:00', prevLeg: null };
      editorState.pendingReference = reference;
      // 全区間を削除してやり直すときに使うため、最初に指定した出発条件を別に控えておく
      // （pendingReferenceはこのあと区間を選ぶたびに直前区間の到着地・到着日時で上書きされる）。
      editorState.initialReference = reference;
      renderBody();
    });

    return form;
  }

  function renderNextStepChooser() {
    const lastLeg = editorState.legs[editorState.legs.length - 1];
    const arrivalDate = resolveArrivalDate(lastLeg.boardingDate, lastLeg.dep, lastLeg.arr);
    editorState.pendingReference = {
      airports: eligibleDepartureAirports(lastLeg.dest),
      date: arrivalDate,
      time: lastLeg.arr,
      prevLeg: lastLeg,
    };
    return renderCandidateList();
  }

  // 運賃種別・座席クラスの切り替え用セグメント行を1つ作る共通ヘルパー
  // （ラベルは付けず、呼び出し側で「運賃/座席」として1つにまとめる）。
  function renderSegmentRow(ariaLabel, options, activeId, onSelect) {
    const row = el('div', { className: 'segment-row', attrs: { role: 'tablist', 'aria-label': ariaLabel } });
    for (const opt of options) {
      row.appendChild(
        el('button', {
          className: `segment-button${opt.id === activeId ? ' active' : ''}`,
          text: opt.label,
          attrs: { type: 'button', role: 'tab', 'aria-selected': opt.id === activeId ? 'true' : 'false' },
          on: { click: () => onSelect(opt.id) },
        })
      );
    }
    return row;
  }

  function renderCandidateList() {
    const ref = editorState.pendingReference;
    const candidates = findNextFlightCandidates(timetable, ref.airports, ref.date, ref.time);
    const nextDate = addDays(ref.date, 1);
    const sameDay = candidates.filter((c) => c.boardingDate === ref.date);
    const nextDayList = candidates.filter((c) => c.boardingDate === nextDate);

    const wrap = el('div', { className: 'card' }, [
      el('h2', { text: '次の便を選択' }),
      el('p', { className: 'meta', text: `${ref.airports.join(' または ')} 発` }),
    ]);

    if (candidates.length === 0) {
      wrap.appendChild(el('p', { text: '選択可能な便が見つかりませんでした。' }));
      return wrap;
    }

    let fareClassId = DEFAULT_FARE_CLASS_ID;
    let cabinClassId = DEFAULT_CABIN_CLASS_ID;
    let activeDay = sameDay.length > 0 ? 0 : 1;
    let destFilter = '';
    const switchArea = el('div', {});
    const tabRow = el('div', { className: 'tab-row', attrs: { role: 'tablist', 'aria-label': '搭乗日' } });
    const destFilterArea = el('div', {});
    const listArea = el('div', {});

    function renderSwitches() {
      clear(switchArea);
      const pair = el('div', { className: 'segment-pair' }, [
        renderSegmentRow('運賃種別', FARE_CLASSES, fareClassId, (id) => { fareClassId = id; renderSwitches(); renderList(); }),
        renderSegmentRow('座席クラス', CABIN_CLASSES, cabinClassId, (id) => { cabinClassId = id; renderSwitches(); renderList(); }),
      ]);
      switchArea.append(el('p', { className: 'segment-group-label', text: '運賃/座席' }), pair);
    }

    // 行き先の絞り込み用ドロップダウン（当日/翌日どちらのタブでも同じ選択肢にするため、
    // 両日の候補をまとめた行き先の集合から作る。行き先が1つしかなければ出さない）。
    // 選択肢は北から南の順に並べる。
    function renderDestFilter() {
      clear(destFilterArea);
      const destinationSet = new Set(candidates.map((c) => c.route.dest));
      if (destinationSet.size <= 1) return;
      const destinations = groupAirportsByRegion([...destinationSet]).flatMap((g) => g.airports);
      const select = el('select', {});
      select.appendChild(el('option', { text: 'すべて', attrs: { value: '' } }));
      for (const d of destinations) {
        select.appendChild(el('option', { text: d, attrs: { value: d } }));
      }
      select.value = destFilter;
      select.addEventListener('change', () => {
        destFilter = select.value;
        renderList();
      });
      destFilterArea.appendChild(el('div', { className: 'field' }, [el('label', { text: '行き先で絞り込み' }), select]));
    }

    function renderTabs() {
      clear(tabRow);
      const day0 = el('button', {
        className: `tab-button${activeDay === 0 ? ' active' : ''}`,
        text: formatDateShortJa(ref.date),
        attrs: { type: 'button', role: 'tab', 'aria-selected': activeDay === 0 ? 'true' : 'false' },
        on: { click: () => { activeDay = 0; renderTabs(); renderList(); } },
      });
      const day1 = el('button', {
        className: `tab-button${activeDay === 1 ? ' active' : ''}`,
        text: formatDateShortJa(nextDate),
        attrs: { type: 'button', role: 'tab', 'aria-selected': activeDay === 1 ? 'true' : 'false' },
        on: { click: () => { activeDay = 1; renderTabs(); renderList(); } },
      });
      tabRow.append(day0, day1);
    }

    function renderList() {
      clear(listArea);
      const items = (activeDay === 0 ? sameDay : nextDayList).filter((c) => !destFilter || c.route.dest === destFilter);
      if (items.length === 0) {
        listArea.appendChild(el('p', { text: 'この日に選択可能な便はありません。' }));
        return;
      }
      const list = el('ul', { className: 'flight-list' });
      for (const c of items) {
        const ppResult = calculateSegmentPP({
          origin: c.route.origin, dest: c.route.dest, carrier: c.carrier, boardingDate: c.boardingDate, fareClassId, cabinClassId,
        });
        const transfer = ref.prevLeg ? airportTransferInfo(ref.prevLeg.dest, c.route.origin) : null;
        // 2便目以降・同じ日の乗り継ぎのときだけ、前区間の到着からの間隔を先頭に添える。
        let waitPrefix = '';
        if (ref.prevLeg && c.boardingDate === ref.date) {
          const waitText = formatDuration(minutesBetween(ref.date, ref.time, c.boardingDate, c.dep));
          if (waitText) waitPrefix = `到着から ${waitText} 後 ・ `;
        }
        const subText = `${waitPrefix}${c.flightNo} ・ ${c.carrier} ・ ${ppResult.pp !== null ? `${formatPP(ppResult.pp)} PP` : 'PP計算不能'}`;
        const arrivalDate = resolveArrivalDate(c.boardingDate, c.dep, c.arr);
        const duration = formatDuration(minutesBetween(c.boardingDate, c.dep, arrivalDate, c.arr));
        const li = el('li', {}, [
          el('button', { className: 'flight-option', on: { click: () => chooseCandidate(c, transfer, fareClassId, cabinClassId) } }, [
            c.isOvernightStay ? el('span', { className: 'badge overnight', text: `宿泊（${c.route.origin}泊）` }) : null,
            transfer ? el('span', { className: 'badge transfer', text: `空港間の移動あり: ${transfer.from} → ${transfer.to}` }) : null,
            el('div', { className: 'flight-option-row' }, [
              el('span', { className: 'flight-option-route', text: `${c.route.origin} → ${c.route.dest}` }),
              el('span', { className: 'flight-option-times' }, [
                `${c.dep} → ${c.arr}`,
                duration ? el('span', { className: 'inline-muted', text: ` (${duration})` }) : null,
              ]),
            ]),
            el('div', { className: 'flight-option-sub', text: subText }),
          ]),
        ]);
        list.appendChild(li);
      }
      listArea.appendChild(list);
    }

    renderSwitches();
    renderTabs();
    renderDestFilter();
    renderList();
    wrap.append(switchArea, tabRow, destFilterArea, listArea);
    return wrap;
  }

  function chooseCandidate(candidate, transfer, fareClassId, cabinClassId) {
    const leg = {
      seq: editorState.legs.length,
      origin: candidate.route.origin,
      dest: candidate.route.dest,
      flightNo: candidate.flightNo,
      carrier: candidate.carrier,
      boardingDate: candidate.boardingDate,
      dep: candidate.dep,
      arr: candidate.arr,
      isOvernightStay: candidate.isOvernightStay,
      airportTransfer: transfer,
      fareClassId,
      cabinClassId,
      priceMemo: null,
    };
    editorState.legs.push(leg);
    renderBody();
  }

  function renderFinishArea() {
    const titleInput = el('input', {
      attrs: { type: 'text', placeholder: '例: 沖縄修行1泊2日', value: editorState.title },
    });
    const saveErrorArea = el('div', {});
    const saveBtn = el('button', { className: 'btn btn-block', text: 'このプランを保存' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      clear(saveErrorArea);
      const title = titleInput.value.trim() || `${editorState.legs[0].origin}発 ${editorState.legs.length}区間`;
      const appData = state.getState().appData;
      const now = new Date().toISOString();
      const plan = {
        id: editorState.planId || generateId(),
        title,
        createdAt: editorState.createdAt || now,
        updatedAt: now,
        timetableRef: { sha256: timetable.source.sha256, validPeriod: timetable.validPeriod },
        legs: editorState.legs,
      };
      const existingPlans = appData.doc.plans.filter((p) => p.id !== plan.id);
      // 出発地・経由地・到着地すべてを対象にする（旅程順、重複除去）。
      const touchedAirports = [...new Set([editorState.legs[0].origin, ...editorState.legs.map((l) => l.dest)])];
      const newDoc = {
        ...appData.doc,
        settings: withRecentAirports(appData.doc.settings, touchedAirports),
        plans: [...existingPlans, plan],
      };
      const res = await state.saveAppData(newDoc);
      saveBtn.disabled = false;
      if (res.ok) {
        // 続けて金額メモ入力画面へ（あとから入力・スキップも可能）。
        window.location.hash = `#/plan/${plan.id}/price`;
      } else {
        saveErrorArea.appendChild(el('div', { className: 'status-banner error', text: res.message }));
      }
    });

    return el('div', { className: 'card' }, [
      el('div', { className: 'field' }, [el('label', { text: 'プラン名' }), titleInput]),
      saveErrorArea,
      saveBtn,
    ]);
  }

  return container;
}

function renderPriceEditor(planId) {
  const appData = state.getState().appData;
  const plan = appData.doc.plans.find((p) => p.id === planId);
  if (!plan) {
    return el('p', { text: 'プランが見つかりませんでした。' });
  }

  const priceFields = renderPriceFields({
    legs: plan.legs,
    initialPrices: plan.legs.map((l) => (l.priceMemo != null ? l.priceMemo : null)),
    initialMerged: plan.legs.map((l) => Boolean(l.priceMergedWithPrevious)),
  });
  const errorArea = el('div', {});
  const saveBtn = el('button', { className: 'btn btn-block', text: '金額を保存' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    clear(errorArea);
    const prices = priceFields.getPrices();
    const merged = priceFields.getMergedFlags();
    const newLegs = plan.legs.map((l, i) => ({ ...l, priceMemo: prices[i], priceMergedWithPrevious: merged[i] }));
    const newPlan = { ...plan, legs: newLegs, updatedAt: new Date().toISOString() };
    const newDoc = { ...appData.doc, plans: appData.doc.plans.map((p) => (p.id === planId ? newPlan : p)) };
    const res = await state.saveAppData(newDoc);
    saveBtn.disabled = false;
    if (res.ok) {
      window.location.hash = `#/plan/${planId}`;
    } else {
      errorArea.appendChild(el('div', { className: 'status-banner error', text: res.message }));
    }
  });

  return el('div', {}, [
    el('div', { className: 'card' }, [
      el('h2', { text: `金額の編集: ${plan.title}` }),
      el('p', { className: 'meta', text: '各区間の運賃を入力できます。あとからでも入力・修正できます（未入力のままでも構いません）。' }),
    ]),
    el('div', { className: 'card' }, [priceFields.node, errorArea, saveBtn]),
  ]);
}
