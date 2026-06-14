/**
 * claim.js — Deep link claim handler for platform apps.
 *
 * When a user buys an app on the portal, they receive a deep link:
 *   https://<canisterId>.icp0.io?claim=<hex_token>
 *
 * This module:
 *   1. Extracts the claim token from the URL query string
 *   2. Waits for authentication (user needs an II identity on this origin)
 *   3. Calls platform_claim(token) on the app canister
 *   4. Cleans the URL to remove the token
 *
 * Usage in app boot:
 *   import { handleDeepLinkClaim } from '@shared/core/claim.js';
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

/**
 * Extract claim token from URL if present.
 * @returns {Uint8Array|null} 32-byte token or null
 */
export function getClaimTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hex = params.get('claim');
  if (!hex || hex.length !== 64) return null;
  return fromHex(hex);
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

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Vero solo se un claim sta DAVVERO per avvenire: token `?claim=` nell'URL o
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
 * Remove the ?claim= parameter from the URL without reloading.
 */
function cleanClaimFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('claim');
  const clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
  window.history.replaceState(null, '', clean);
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

  // 1. Estrai token — prima dall'URL, poi dallo storage (ripresa dopo logout forzato).
  let token = getClaimTokenFromUrl();
  const fromUrl = token !== null;

  if (fromUrl) {
    try { sessionStorage.setItem(TOKEN_STORAGE_KEY, toHex(token)); } catch (_) {}
    cleanClaimFromUrl();
  } else {
    token = getPendingTokenFromStorage();
  }

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
