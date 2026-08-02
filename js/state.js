// アプリ全体の状態管理（Dropboxを唯一の正データとする、シンプルなpub-subストア）。
import * as oauth from './dropbox/oauth.js';
import {
  downloadJson,
  uploadJson,
  DropboxNetworkError,
  DropboxAuthError,
  DropboxConflictError,
} from './dropbox/client.js';
import { TIMETABLE_PATH, APPDATA_PATH, validateTimetableDoc, validateAppDataDoc, emptyAppData } from './domain/schema.js';

/**
 * connectivity:
 *   'checking'        起動時の確認中
 *   'unauthenticated' 未接続（接続画面を表示）
 *   'offline'         接続済みだがDropboxに到達できない（利用不可）
 *   'online'          利用可能
 */
const state = {
  connectivity: 'checking',
  timetable: null, // { doc, rev }
  appData: null, // { doc, rev }
  savingStatus: 'idle', // idle | saving | saved | failed
  savingMessage: '',
  lastError: null,
  dataError: null, // 破損データ等、致命的なデータエラーの説明
};

const listeners = new Set();
function emit() {
  for (const l of listeners) l(state);
}
export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}
export function getState() {
  return state;
}

/** 保存結果の通知バナーを閉じる（ユーザーが×ボタンを押したとき用）。 */
export function dismissSavingStatus() {
  state.savingStatus = 'idle';
  state.savingMessage = '';
  emit();
}

function setSaving(status, message = '') {
  state.savingStatus = status;
  state.savingMessage = message;
  emit();
}

/** 起動時、または再接続時に呼ぶ。Dropboxへの実到達性を確認し、データを読み込む。 */
export async function init() {
  state.connectivity = 'checking';
  state.dataError = null;
  emit();

  if (!oauth.isConnected()) {
    state.connectivity = 'unauthenticated';
    emit();
    return;
  }

  await loadAll();
}

async function loadAll() {
  try {
    const [timetableRes, appDataRes] = await Promise.all([
      downloadJson(TIMETABLE_PATH),
      downloadJson(APPDATA_PATH),
    ]);

    if (timetableRes.exists) {
      const v = validateTimetableDoc(timetableRes.data);
      if (!v.ok) {
        state.connectivity = 'online';
        state.dataError = `保存されている時刻表データ(${TIMETABLE_PATH})が読み取れません: ${v.errors.join(' / ')}`;
        emit();
        return;
      }
      state.timetable = { doc: timetableRes.data, rev: timetableRes.rev };
    } else {
      state.timetable = null;
    }

    if (appDataRes.exists) {
      const v = validateAppDataDoc(appDataRes.data);
      if (!v.ok) {
        state.connectivity = 'online';
        state.dataError = `保存されているプランデータ(${APPDATA_PATH})が読み取れません: ${v.errors.join(' / ')}`;
        emit();
        return;
      }
      state.appData = { doc: appDataRes.data, rev: appDataRes.rev };
    } else {
      state.appData = { doc: emptyAppData(), rev: null };
    }

    state.connectivity = 'online';
    state.lastError = null;
    emit();
  } catch (e) {
    if (e instanceof DropboxAuthError) {
      await oauth.disconnect();
      state.connectivity = 'unauthenticated';
      state.lastError = e.message;
    } else if (e instanceof DropboxNetworkError) {
      state.connectivity = 'offline';
      state.lastError = e.message;
    } else {
      // ネットワーク到達性の問題ではなく、Dropbox上のデータそのものが読めない
      // （壊れたJSON等）ケース。「オフライン」ではなくデータエラーとして扱い、
      // 誤ってネットワークの確認を促すメッセージを出さないようにする。
      state.connectivity = 'online';
      state.dataError = e.message || 'Dropbox上のデータの読み込み中にエラーが発生しました。';
    }
    emit();
  }
}

export async function connect() {
  await oauth.startAuthorization(); // ページ遷移するのでここで終わる
}

export async function disconnect() {
  await oauth.disconnect();
  state.timetable = null;
  state.appData = null;
  state.connectivity = 'unauthenticated';
  emit();
}

/** 通信状態の再確認（再接続後などに呼ぶ）。 */
export async function recheckConnectivity() {
  await loadAll();
}

/**
 * timetable.json を保存する（インポート確定時）。
 * @returns {Promise<{ok:true}|{ok:false, conflict:boolean, message:string}>}
 */
export async function saveTimetable(newDoc) {
  if (state.connectivity !== 'online') {
    return { ok: false, conflict: false, message: 'Dropboxに接続されていません。' };
  }
  setSaving('saving', '時刻表を保存しています…');
  try {
    const baseRev = state.timetable ? state.timetable.rev : null;
    const { rev } = await uploadJson(TIMETABLE_PATH, newDoc, { baseRev });
    state.timetable = { doc: newDoc, rev };
    setSaving('saved', '時刻表を保存しました。');
    return { ok: true };
  } catch (e) {
    return await handleSaveError(e);
  }
}

/**
 * appdata.json（設定＋プラン）を保存する。
 */
export async function saveAppData(newDoc) {
  if (state.connectivity !== 'online') {
    return { ok: false, conflict: false, message: 'Dropboxに接続されていません。' };
  }
  setSaving('saving', '保存しています…');
  try {
    const baseRev = state.appData ? state.appData.rev : null;
    const { rev } = await uploadJson(APPDATA_PATH, newDoc, { baseRev });
    state.appData = { doc: newDoc, rev };
    setSaving('saved', '保存しました。');
    return { ok: true };
  } catch (e) {
    return await handleSaveError(e);
  }
}

async function handleSaveError(e) {
  if (e instanceof DropboxConflictError) {
    setSaving('failed', '他の端末/タブでの更新と競合したため保存できませんでした。最新データを再読み込みします。');
    // データを失わないよう、ローカルの変更は破棄し、Dropbox上の最新版を再読み込みする。
    await loadAll();
    return {
      ok: false,
      conflict: true,
      message:
        '他の端末またはタブでこのデータが更新されていたため、今回の変更は保存されませんでした。' +
        '最新のデータを読み込み直しましたので、内容を確認して再度編集してください。',
    };
  }
  if (e instanceof DropboxAuthError) {
    await oauth.disconnect();
    state.connectivity = 'unauthenticated';
    setSaving('failed', '認証が期限切れのため保存に失敗しました。再接続してください。');
    emit();
    return { ok: false, conflict: false, message: '認証が期限切れです。再接続してください。' };
  }
  // ネットワークエラー・その他APIエラー
  state.connectivity = 'offline';
  setSaving('failed', `保存に失敗しました: ${e.message || '不明なエラー'}`);
  return { ok: false, conflict: false, message: e.message || '保存に失敗しました。' };
}
