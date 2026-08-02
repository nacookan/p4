// Dropbox API v2 の薄いクライアント。公式SDKは使わず、fetchで直接HTTP APIを呼ぶ
// （依存を増やさないための設計判断。エンドポイント仕様は
//  https://www.dropbox.com/developers/documentation/http/documentation を参照、確認日2026-08-02）。
//
// 使用するのは files/download と files/upload のみ。
// アプリはApp Folder型のDropbox Appとして登録する前提のため、
// パスはApp Folderのルートを起点とした相対パス（例: "/timetable.json"）でよい。
import { getValidAccessToken } from './oauth.js';

const CONTENT_HOST = 'https://content.dropboxapi.com';

export class DropboxNetworkError extends Error {}
export class DropboxAuthError extends Error {}
export class DropboxConflictError extends Error {}
export class DropboxApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function apiFetch(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new DropboxNetworkError('Dropboxへ通信できませんでした。ネットワーク接続を確認してください。');
  }
  return res;
}

/**
 * App Folder内のJSONファイルをダウンロードする。
 * @returns {Promise<{exists:true, data:any, rev:string}|{exists:false}>}
 */
export async function downloadJson(path) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new DropboxAuthError('Dropboxに接続されていません。');

  const res = await apiFetch(`${CONTENT_HOST}/2/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

  if (res.status === 409) {
    // path/not_found はここに来る（ファイル未作成 = 初回利用）
    let tag = null;
    try {
      const err = JSON.parse(res.headers.get('X-Dropbox-Api-Result') || (await res.text()));
      tag = err && err.error && err.error.reason && err.error.reason['.tag'];
    } catch {
      // 解析できなくても not_found 扱いにフォールバックせず、下でエラーとして扱う
    }
    if (!tag || tag === 'not_found') {
      return { exists: false };
    }
    throw new DropboxApiError('Dropbox APIエラーが発生しました。', 409);
  }
  if (res.status === 401) {
    throw new DropboxAuthError('Dropboxの認証が期限切れです。再接続してください。');
  }
  if (!res.ok) {
    throw new DropboxApiError(`Dropbox APIエラーが発生しました（HTTP ${res.status}）。`, res.status);
  }

  const resultHeader = res.headers.get('Dropbox-API-Result');
  let rev = null;
  if (resultHeader) {
    try {
      rev = JSON.parse(resultHeader).rev;
    } catch {
      rev = null;
    }
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DropboxApiError('保存されているデータがJSONとして壊れています。', 0);
  }
  return { exists: true, data, rev };
}

/**
 * App Folder内にJSONファイルを書き込む（新規作成、または楽観的排他制御での更新）。
 * @param {string} path
 * @param {any} data
 * @param {{baseRev:string|null}} opts baseRev===null なら新規作成(add)、
 *   それ以外はそのrevからの更新（一致しなければ409衝突）
 * @returns {Promise<{rev:string}>}
 */
export async function uploadJson(path, data, { baseRev }) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new DropboxAuthError('Dropboxに接続されていません。');

  const mode = baseRev === null ? { '.tag': 'add' } : { '.tag': 'update', update: baseRev };
  const body = JSON.stringify(data, null, 2);

  const res = await apiFetch(`${CONTENT_HOST}/2/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: true, strict_conflict: true }),
    },
    body,
  });

  if (res.status === 409) {
    throw new DropboxConflictError('Dropbox上のデータが他の端末/タブによって更新されています。');
  }
  if (res.status === 401) {
    throw new DropboxAuthError('Dropboxの認証が期限切れです。再接続してください。');
  }
  if (!res.ok) {
    throw new DropboxApiError(`保存に失敗しました（HTTP ${res.status}）。`, res.status);
  }
  const json = await res.json();
  return { rev: json.rev };
}
