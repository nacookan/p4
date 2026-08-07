// Dropbox OAuth 2.0 Authorization Code Flow with PKCE（公開クライアント向け）。
// 出典: https://developers.dropbox.com/oauth-guide （確認日: 2026-08-02）
//
// 設計判断（README参照）: アクセストークン・リフレッシュトークンはlocalStorageに保存する
// （以前はsessionStorageのみだったが、ホーム画面に追加してPWA的に使う場合、起動のたびに
// 新しいセッション扱いになりログインが必要になってしまうため変更した）。このアプリの
// Dropboxアクセスはこのアプリ専用のApp Folderのみに限定されたスコープ
// （files.content.write/files.content.read）であり、アカウント全体へはアクセスできない。
// PKCEの認可フロー中だけ使う一時情報（code verifier・state）は、認可の往復が終われば
// 不要になるためsessionStorageのままにしている。
import { DROPBOX_CONFIG } from '../dropbox-config.js';
import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';

// App Folder型アプリで完結する最小権限のみ要求する。
const OAUTH_SCOPE = 'files.content.write files.content.read';

const SESSION_KEY_PENDING = 'p4.dropbox.oauth.pending'; // {verifier, state}
const TOKEN_STORAGE_KEY = 'p4.dropbox.oauth.token'; // {accessToken, refreshToken, expiresAt}

export function computeRedirectUri() {
  return new URL('oauth-callback.html', document.baseURI).href;
}

export function isConfigured() {
  return Boolean(DROPBOX_CONFIG.appKey) && DROPBOX_CONFIG.appKey !== 'YOUR_DROPBOX_APP_KEY_HERE';
}

function saveToken(token) {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
}

function loadToken() {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return null;
  }
}

export function clearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function isConnected() {
  return loadToken() !== null;
}

/** Dropboxの認可画面へリダイレクトする。 */
export async function startAuthorization() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  sessionStorage.setItem(SESSION_KEY_PENDING, JSON.stringify({ verifier, state }));

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', DROPBOX_CONFIG.appKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', computeRedirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', OAUTH_SCOPE);
  window.location.assign(url.toString());
}

/**
 * oauth-callback.html から呼び出される。URLのcode/stateを検証してトークンを取得する。
 * 成功・失敗にかかわらず、呼び出し後はURLからcode/state等の認証情報を除去する。
 * @returns {{ok:true}|{ok:false, message:string}}
 */
export async function handleRedirectCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  // URLに残った認証情報は使い終わったら即座に消す。
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);

  const pendingRaw = sessionStorage.getItem(SESSION_KEY_PENDING);
  sessionStorage.removeItem(SESSION_KEY_PENDING);

  if (error) {
    return { ok: false, message: `Dropboxでの認可が拒否またはキャンセルされました（${error}）。` };
  }
  if (!code || !state) {
    return { ok: false, message: '認可コードが取得できませんでした。' };
  }
  if (!pendingRaw) {
    return { ok: false, message: '認証セッション情報が見つかりません。最初からやり直してください。' };
  }
  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    return { ok: false, message: '認証セッション情報が壊れています。最初からやり直してください。' };
  }
  if (state !== pending.state) {
    return { ok: false, message: 'state不一致のため、認証を中断しました（CSRF対策）。最初からやり直してください。' };
  }

  const body = new URLSearchParams();
  body.set('code', code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', computeRedirectUri());
  body.set('client_id', DROPBOX_CONFIG.appKey);
  body.set('code_verifier', pending.verifier);

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    return { ok: false, message: 'Dropboxへの通信に失敗しました。ネットワーク接続を確認してください。' };
  }
  if (!res.ok) {
    return { ok: false, message: `トークン取得に失敗しました（HTTP ${res.status}）。` };
  }
  const json = await res.json();
  saveToken({
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: Date.now() + (json.expires_in ? json.expires_in * 1000 : 4 * 60 * 60 * 1000),
  });
  return { ok: true };
}

async function refreshAccessToken(token) {
  if (!token.refreshToken) return null;
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', token.refreshToken);
  body.set('client_id', DROPBOX_CONFIG.appKey);
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const json = await res.json();
  const updated = {
    accessToken: json.access_token,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + (json.expires_in ? json.expires_in * 1000 : 4 * 60 * 60 * 1000),
  };
  saveToken(updated);
  return updated;
}

/**
 * 有効なアクセストークンを返す。必要なら自動的にリフレッシュする。
 * 未接続、またはリフレッシュにも失敗した場合は null。
 */
export async function getValidAccessToken() {
  let token = loadToken();
  if (!token) return null;
  const EXPIRY_MARGIN_MS = 60 * 1000;
  if (Date.now() < token.expiresAt - EXPIRY_MARGIN_MS) {
    return token.accessToken;
  }
  const refreshed = await refreshAccessToken(token);
  if (!refreshed) {
    clearToken();
    return null;
  }
  return refreshed.accessToken;
}

/** Dropbox連携を解除する（トークン失効 + ローカル情報の削除）。 */
export async function disconnect() {
  const token = loadToken();
  if (token && token.accessToken) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
    } catch {
      // 失効APIが失敗してもローカルの認証情報は必ず削除する。
    }
  }
  clearToken();
}
