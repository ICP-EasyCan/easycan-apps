/**
 * claim.js — Deep link claim handler for platform apps.
 *
 * When a user buys an app on the portal, they receive a deep link:
 *   https://<canisterId>.icp0.io#claim=<hex_token>
 *
 * Il token è una credenziale al portatore: viaggia nel FRAGMENT (mai in query
 * string) perché i fragment non finiscono nell'header Referer, nei log dei
 * boundary node né nelle richieste al server. Non reintrodurre `?claim=`.
 *
 * ⚠️ Le app usano hash-router: il fallback del router riscrive l'hash e
 * distruggerebbe il token. Ogni app DEVE chiamare `captureClaimToken()` come
 * prima istruzione sincrona del boot, PRIMA di startRouter().
 *
 * This module:
 *   1. Captures the claim token from the URL fragment (sync, pre-router)
 *   2. Waits for authentication (user needs an II identity on this origin)
 *   3. Calls platform_claim(token) on the app canister
 *   4. Cleans the URL to remove the token
 *
 * Usage in app boot:
 *   import { captureClaimToken, handleDeepLinkClaim } from '@shared/core/claim.js';
 *   captureClaimToken();               // primo statement sincrono del boot
 *   ...
 *   await handleDeepLinkClaim(CANISTER_ID);
 */

import { call } from './icp.js';
import { isAuthenticated, logout } from './auth.js';
import { bus } from './event-bus.js';

/**
 * Parse hex string → Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

const TOKEN_STORAGE_KEY = 'claim:pending-token';
const RELOGIN_FLAG_KEY  = 'claim:relogin-required';

// Fragment atteso: "#claim=<64 hex>" — esatto, prima che il router lo tocchi.
const CLAIM_HASH_RE = /^#claim=([0-9a-fA-F]{64})$/;

// True se il token è arrivato nell'URL in QUESTO pageload (catturato da
// captureClaimToken). Sostituisce il vecchio "fromUrl" ora che l'hash viene
// pulito subito: serve alla regola di forced re-login al boot.
let _capturedThisLoad = false;

/**
 * Extract claim token from URL fragment if present.
 * @returns {Uint8Array|null} 32-byte token or null
 */
export function getClaimTokenFromUrl() {
  const m = CLAIM_HASH_RE.exec(window.location.hash);
  return m ? fromHex(m[1]) : null;
}

/**
 * Cattura sincrona del token dal fragment: stash in sessionStorage + pulizia
 * dell'URL. DEVE girare prima di startRouter() (il fallback del router
 * riscriverebbe l'hash). Idempotente: le chiamate successive alla cattura
 * riportano comunque true per tutto il pageload.
 * @returns {boolean} true se un token è stato catturato in questo pageload
 */
export function captureClaimToken() {
  const m = CLAIM_HASH_RE.exec(window.location.hash);
  if (!m) return _capturedThisLoad;
  try { sessionStorage.setItem(TOKEN_STORAGE_KEY, m[1].toLowerCase()); } catch (_) {}
  _capturedThisLoad = true;
  cleanClaimFromUrl();
  return true;
}

/**
 * Leggi il token dallo storage di sessione (hex → bytes) se presente.
 * Serve quando l'URL è già stata ripulita ma il claim deve ancora avvenire
 * dopo un logout/relogin forzato.
 * @returns {Uint8Array|null}
 */
function getPendingTokenFromStorage() {
  try {
    const hex = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!hex || hex.length !== 64) return null;
    return fromHex(hex);
  } catch (_) {
    return null;
  }
}

/**
 * Vero solo se un claim sta DAVVERO per avvenire: token `#claim=` nell'URL o
 * token pendente in sessionStorage (ripresa dopo logout forzato). Serve alla UI
 * per distinguere "sto registrando la proprietà" (acquisto fresh) dal semplice
 * "sto verificando la proprietà" (re-login, post-reinstall): dopo un reinstall
 * l'owner è già settato all'init (cap-platform adopt_sovereign) → nessun claim.
 * @returns {boolean}
 */
export function isClaimPending() {
  return getClaimTokenFromUrl() !== null || getPendingTokenFromStorage() !== null;
}

/**
 * Remove the #claim= fragment from the URL without reloading.
 */
function cleanClaimFromUrl() {
  const url = new URL(window.location.href);
  window.history.replaceState(null, '', url.pathname + url.search);
}

/**
 * Handle deep link claim if a token is present in the URL.
 *
 * If the user is already authenticated, claims immediately.
 * Otherwise, waits for the next auth:login event and then claims.
 *
 * @param {string} canisterId — the app canister ID
 * @returns {Promise<{claimed: boolean, error?: string}>}
 */
export async function handleDeepLinkClaim(canisterId, options = {}) {
  const source = options.source || 'boot'; // 'boot' | 'login'

  // 1. Cattura (idempotente — l'app dovrebbe averlo già fatto pre-router) e
  //    leggi il token dallo storage. `fromUrl` = arrivato nell'URL in questo
  //    pageload, distingue il deep-link fresco dalla ripresa post-relogin.
  const fromUrl = captureClaimToken();
  const token = getPendingTokenFromStorage();

  if (!token) return { claimed: false };

  // 2. Regola di sicurezza — solo al boot: se esiste già una sessione II
  //    sull'origin, può essere un residuo di un'anchor diversa (localStorage).
  //    Il claim è idempotente e irreversibile → forziamo logout + login
  //    esplicito. Saltata se chiamati DOPO un auth:login (source='login'),
  //    perché in quel caso l'utente ha appena confermato l'identità.
  if (source === 'boot' && fromUrl && isAuthenticated()) {
    console.log('[claim] token + stale session at boot → forcing re-login');
    try { sessionStorage.setItem(RELOGIN_FLAG_KEY, '1'); } catch (_) {}
    bus.emit('claim:relogin-required', {});
    await logout();
    return { claimed: false, pending: true };
  }

  // 3. Autenticati + token disponibile → claima subito.
  if (isAuthenticated()) {
    try { sessionStorage.removeItem(RELOGIN_FLAG_KEY); } catch (_) {}
    const result = await doClaim(canisterId, token);
    if (result.claimed) { try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {} }
    return result;
  }

  // 4. Non autenticati con token pendente: aspetta il prossimo auth:login.
  return new Promise((resolve) => {
    bus.once('auth:login', async () => {
      try { sessionStorage.removeItem(RELOGIN_FLAG_KEY); } catch (_) {}
      const result = await doClaim(canisterId, token);
      if (result.claimed) { try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {} }
      resolve(result);
    });
  });
}

/**
 * @param {string} canisterId
 * @param {Uint8Array} token
 * @returns {Promise<{claimed: boolean, error?: string}>}
 */
async function doClaim(canisterId, token) {
  console.log('[claim] doClaim called, canisterId:', canisterId, 'token length:', token.length);
  try {
    const result = await call(canisterId, 'platform_claim', Array.from(token));
    console.log('[claim] platform_claim result:', JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    if (result?.Err) {
      console.error('[claim] Deep link claim failed:', result.Err);
      return { claimed: false, error: result.Err };
    }
    console.log('[claim] Deep link claim succeeded');
    return { claimed: true };
  } catch (e) {
    console.error('[claim] Deep link claim error:', e.message);
    return { claimed: false, error: e.message };
  }
}
