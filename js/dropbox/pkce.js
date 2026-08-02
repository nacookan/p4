// PKCE (Proof Key for Code Exchange) のcode_verifier/code_challenge生成。
// 出典: https://developers.dropbox.com/oauth-guide 、
//       https://dropbox.tech/developers/pkce--what-and-why- （確認日: 2026-08-02）
// code_verifierの許容文字集合: [A-Za-z0-9-._~]、長さ43〜128文字。
// 本アプリは常にS256（SHA-256ベース）方式を使用する（plain方式は使わない＝
// 「PKCEは可能な限り安全な方式を採用する」という要件に対応）。

const VERIFIER_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 暗号学的乱数を用いて43〜128文字のcode_verifierを生成する（長さは128固定で最大強度）。 */
export function generateCodeVerifier() {
  const bytes = new Uint8Array(96); // base64url化すると128文字になる
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += VERIFIER_CHARS[bytes[i] % VERIFIER_CHARS.length];
  }
  return out;
}

/** code_verifierからS256方式のcode_challengeを生成する。 */
export async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** OAuthのstateパラメータ用の乱数文字列を生成する（CSRF対策）。 */
export function generateState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
