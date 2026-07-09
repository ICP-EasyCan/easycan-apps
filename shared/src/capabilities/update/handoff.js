/**
 * capabilities/update/handoff.js — Ricevitore di handoff in-app (Arco B, cambio-app L2).
 *
 * Gemello dello handler di claim (`@shared/core/claim.js`), ma per il CAMBIO-APP. Il
 * portale (unica vetrina + pagamento + seat) rimbalza l'utente all'origin dell'app con
 *   https://<canisterId>.icp0.io#install=<app_id>&token=<hex>
 *
 * Il token viaggia nel FRAGMENT (mai in query string), stessa regola del claim: i
 * fragment non finiscono nel Referer né nei log dei boundary node. Come per il claim,
 * l'app DEVE chiamare `captureInstallParams()` sincrono PRIMA di startRouter(), o il
 * fallback del router riscrive l'hash e distrugge i parametri.
 * Qui, loggati come `P_app_frontend` (= owner = unico controller), si reinstalla l'app
 * richiesta SOPRA quella corrente. Il reinstall AZZERA la stable memory: i dati dell'app
 * uscente si perdono (semantica onesta L2). Nessuna UI di browsing: la scelta è già stata
 * fatta nel portale; questo è solo il ricevitore.
 *
 * Sovranità: l'install è controller-gated dal protocollo (solo l'owner installa), quindi
 * il token NON concede potere — serve solo come (a) anti-replay one-time (un wipe non deve
 * ri-scattare su back/refresh) e (b) carrier autentico dell'app_id (lo prendiamo dallo
 * spawner, non dal parametro URL spoofabile). Integrità del codice = àncora SHA-256
 * on-chain (factory `get_wasm_sha256`, B0-slice) confrontata col manifest PRIMA del fetch.
 *
 * Pipeline (passi read-only idempotenti PRIMA, reinstall distruttivo + commit DOPO):
 *   1. risolvi lo spawner del proprio canister via `platform_metadata`
 *   2. spawner `get_app_info(app)` → factory_canister_id
 *   3. factory `get_wasm_sha256()` → àncora SHA-256 (hex)
 *   4. risolvi + scarica il manifest della release (GitHub `dist`)
 *   5. spawner `peek_install_token(token, self)` → app_id autentico (read-only, NON
 *      brucia) + verifica che combaci con quello in URL
 *   6. `runReinstall` (anchor-gated; WIPE + install + swap frontend), firma P_app_frontend
 *   7. solo a reinstall riuscito: spawner `consume_install_token` (commit: brucia il
 *      token one-time + sposta l'occupancy A→B). Su fallimento niente burn/move → ritento.
 */

import { Principal } from '@dfinity/principal';
import { query, getActorFor } from '../../core/icp.js';
import { hexToBytes } from '../../core/management.js';
import { runReinstall } from './flow.js';
import { resolveManifestUrl } from './page.js';
import { spawnerHandoffIdl, factoryAnchorIdl } from './handoff-idl.js';

const TOKEN_KEY = 'install:pending-token';
const APP_KEY   = 'install:pending-app';

// ─── Parametri da URL / storage ─────────────────────────────────────────────────

/**
 * Estrae `#install=<app>&token=<hex64>` dal fragment. Ritorna null se assenti o malformati.
 * @returns {{ app: string, tokenHex: string }|null}
 */
export function getInstallParamsFromUrl() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith('install=')) return null;
  const params = new URLSearchParams(hash);
  const app = params.get('install');
  const token = params.get('token');
  if (!app || !token) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(token)) return null; // 32-byte hex
  return { app, tokenHex: token.toLowerCase() };
}

/**
 * Cattura sincrona dei parametri dal fragment: stash + pulizia URL. DEVE girare
 * prima di startRouter() (il fallback del router riscriverebbe l'hash).
 * @returns {boolean} true se i parametri erano nell'URL e sono stati stashati
 */
export function captureInstallParams() {
  const p = getInstallParamsFromUrl();
  if (!p) return false;
  stashInstallParams(p);
  cleanInstallFromUrl();
  return true;
}

/** Salva i parametri in sessionStorage (sopravvivono al logout/relogin forzato). */
export function stashInstallParams({ app, tokenHex }) {
  try {
    sessionStorage.setItem(TOKEN_KEY, tokenHex);
    sessionStorage.setItem(APP_KEY, app);
  } catch (_) { /* private mode: ignora */ }
}

/** Legge i parametri pendenti dallo storage. @returns {{app,tokenHex}|null} */
export function getPendingInstall() {
  try {
    const tokenHex = sessionStorage.getItem(TOKEN_KEY);
    const app = sessionStorage.getItem(APP_KEY);
    if (!tokenHex || !app) return null;
    return { app, tokenHex };
  } catch (_) {
    return null;
  }
}

/** Cancella i parametri pendenti dallo storage. */
export function clearPendingInstall() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(APP_KEY);
  } catch (_) { /* ignora */ }
}

/** Rimuove il fragment `#install=...&token=...` dall'URL senza ricaricare. */
export function cleanInstallFromUrl() {
  const url = new URL(window.location.href);
  window.history.replaceState(null, '', url.pathname + url.search);
}

// ─── Esecuzione ─────────────────────────────────────────────────────────────────

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Risolve lo spawner del proprio canister chiedendolo a sé stesso (via cap-platform).
 * Il ricevitore gira come owner → `platform_metadata` non gli redige i principal.
 * @param {string} canisterId
 * @returns {Promise<string>} principal text dello spawner
 */
async function resolveSpawner(canisterId) {
  const meta = await query(canisterId, 'platform_metadata');
  // AppMetadata.{original_spawner,spawner}: Opt<Principal> ⇒ [] | [Principal].
  const p = meta?.original_spawner?.[0] || meta?.spawner?.[0];
  if (!p) {
    throw new Error('This canister has no marketplace spawner on record — nothing to install onto.');
  }
  return p.toText();
}

/**
 * Pre-flight READ-ONLY del cambio-app: risolve spawner→factory→àncora SHA-256 e scarica
 * il manifest della release, poi confronta l'hash. NON consuma il token, NON tocca nulla:
 * è sicuro chiamarlo al mount della pagina per mostrare l'esito della verifica PRIMA che
 * l'utente prema Install. Il risultato si passa a `runHandoffInstall({ preflight })` per
 * non rifare le stesse fetch.
 *
 * @param {{ canisterId: string, repo: string, distBranch?: string }} opts
 * @returns {Promise<{ ok: boolean, appId: string, spawnerId?: string, factoryId?: string,
 *   manifest?: object, onChainSha256?: string, manifestSha256?: string, hashMatches?: boolean,
 *   error?: string }>}
 */
export async function preflightHandoff({ canisterId, repo, distBranch = 'dist' }) {
  const pending = getPendingInstall();
  if (!pending) {
    return { ok: false, appId: '', error: 'No pending install — start the change-app flow from the portal.' };
  }
  const urlAppId = pending.app;
  try {
    const spawnerId = await resolveSpawner(canisterId);
    const spawner = await getActorFor(spawnerId, spawnerHandoffIdl);

    const info = await spawner.get_app_info(urlAppId);
    const appInfo = info?.[0];
    if (!appInfo) throw new Error(`App "${urlAppId}" is not available on the marketplace.`);
    const factoryId = appInfo.factory_canister_id.toText();

    const factory = await getActorFor(factoryId, factoryAnchorIdl);
    const shaOpt = await factory.get_wasm_sha256();
    const shaBytes = shaOpt?.[0];
    if (!shaBytes || shaBytes.length !== 32) {
      throw new Error('The factory has not published a code hash yet — cannot verify the install.');
    }
    const onChainSha256 = bytesToHex(shaBytes);

    const manifestUrl = resolveManifestUrl(repo, urlAppId, distBranch);
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not fetch the release manifest (HTTP ${res.status}).`);
    const manifest = await res.json();

    // Anchor gate (read-only): l'hash del manifest DEVE combaciare con quello on-chain.
    const want = onChainSha256.trim().toLowerCase();
    const got = String(manifest.wasm_sha256 || '').trim().toLowerCase();
    return {
      ok: true, appId: urlAppId, spawnerId, factoryId,
      manifest, onChainSha256: want, manifestSha256: got, hashMatches: !!want && want === got,
    };
  } catch (e) {
    return { ok: false, appId: urlAppId, error: e?.message || String(e) };
  }
}

/**
 * Esegue il cambio-app per il token pendente. Assume utente già autenticato come
 * `P_app_frontend`. ORDINE CRITICO: il gate hash on-chain gira PRIMA del consume — un
 * release non combaciante fallisce qui senza bruciare il token né spostare l'occupancy
 * (consume fa entrambe le cose). Solo a verifica passata: consume (one-time) + reinstall
 * distruttivo. Riusa il `preflight` se fornito (stesso esito read-only della pagina).
 *
 * @param {{
 *   canisterId: string,
 *   repo: string,             // "Owner/repo" su GitHub (dist branch)
 *   distBranch?: string,
 *   preflight?: object|null,  // risultato di preflightHandoff() — evita di rifare le fetch
 *   onProgress?: (step: string, detail?: string) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, phase: string, appId: string, error?: string, snapshotId?: any }>}
 */
export async function runHandoffInstall({ canisterId, repo, distBranch = 'dist', preflight = null, onProgress = () => {} }) {
  const pending = getPendingInstall();
  if (!pending) {
    return { ok: false, phase: 'no-token', appId: '', error: 'No pending install — start the change-app flow from the portal.' };
  }
  const urlAppId = pending.app;

  try {
    onProgress('resolve', 'Verifying this release against the on-chain hash…');
    const pf = (preflight && preflight.ok) ? preflight : await preflightHandoff({ canisterId, repo, distBranch });
    if (!pf.ok) throw new Error(pf.error || 'Could not verify the release.');

    // ── Gate hash PRIMA del reinstall: se il release non può installarsi, fermati
    //    qui (lo stesso check si ripete dentro runReinstall, difesa in profondità). ──
    if (!pf.hashMatches) {
      throw new Error(
        `Manifest hash does not match the on-chain record — refusing to install ` +
        `(on-chain ${pf.onChainSha256 || 'n/d'}, manifest ${pf.manifestSha256 || 'n/d'}).`);
    }

    // ── PEEK read-only: app_id autentico, NIENTE burn / NIENTE spostamento occupancy.
    //    Aborta presto su token invalido/scaduto → mai un wipe distruttivo su un token
    //    già morto, e verifica che combaci con quello in URL. ───────────────────────
    onProgress('resolve', 'Verifying the change…');
    const spawner = await getActorFor(pf.spawnerId, spawnerHandoffIdl);
    const tokenBytes = hexToBytes(pending.tokenHex);
    const peeked = await spawner.peek_install_token(Array.from(tokenBytes), Principal.fromText(canisterId));
    if (peeked?.Err) throw new Error(peeked.Err);
    const authenticAppId = peeked.Ok;
    if (authenticAppId !== urlAppId) {
      throw new Error(`Install request mismatch (link says "${urlAppId}", token authorizes "${authenticAppId}").`);
    }

    // ── Reinstall distruttivo (L2) — anchor-gated di nuovo dentro runReinstall ─────────
    const result = await runReinstall({ canisterId, manifest: pf.manifest, onChainSha256: pf.onChainSha256, spawnerId: pf.spawnerId, factoryId: pf.factoryId, healthPing: null, onProgress });

    // ── COMMIT solo a reinstall riuscito: brucia il token one-time + sposta l'occupancy
    //    A→B. Su fallimento NON committiamo → token intatto, occupancy invariata,
    //    dashboard coerente, l'utente può ri-tentare. ────────────────────────────────
    if (result.ok) {
      const committed = await spawner.consume_install_token(Array.from(tokenBytes), Principal.fromText(canisterId));
      if (committed?.Err) {
        // App installata e sovrana, ma lo spostamento seat/nome è fallito: lo segnaliamo.
        return { ...result, appId: authenticAppId, warning: committed.Err };
      }
      clearPendingInstall(); // bruciato lato-server: niente handle stantio
    }
    return { ...result, appId: authenticAppId };
  } catch (e) {
    return { ok: false, phase: 'handoff', appId: urlAppId, error: e?.message || String(e) };
  }
}
