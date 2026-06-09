/**
 * platform.js — helper per tier e feature lock.
 *
 * Interroga `platform_get_tier()` sul proprio canister con cache 60s.
 * In modalità standalone (endpoint non presente) ritorna sempre tier=1
 * così le feature sono sempre attive.
 */

import { call, query } from './icp.js';

let _tierCache = null;       // { value: number, expiresAt: number }
const CACHE_TTL_MS = 60_000;

/**
 * Restituisce il tier corrente dell'app.
 * @param {string} ownCid — proprio canister ID
 * @returns {Promise<number>} 0=demo, 1=pro
 */
export async function getTier(ownCid) {
  const now = Date.now();
  if (_tierCache && now < _tierCache.expiresAt) {
    return _tierCache.value;
  }
  try {
    const tier = await query(ownCid, 'platform_get_tier');
    _tierCache = { value: Number(tier), expiresAt: now + CACHE_TTL_MS };
    return _tierCache.value;
  } catch {
    // Endpoint non presente → standalone → tutto attivo
    _tierCache = { value: 1, expiresAt: now + CACHE_TTL_MS };
    return 1;
  }
}

/**
 * Verifica che il tier sia almeno `minTier`.
 * @param {string} ownCid
 * @param {number} minTier
 * @returns {Promise<boolean>}
 */
export async function checkTier(ownCid, minTier) {
  const tier = await getTier(ownCid);
  return tier >= minTier;
}

/** Invalida la cache (es. dopo un upgrade di tier). */
export function invalidateTierCache() {
  _tierCache = null;
}

// ─── L2: azioni di sovranità (wrapper sottili su platform_*) ──────────────────
//
// Un solo posto per i nomi degli endpoint cap-platform e per l'unwrap del
// Result. Ogni wrapper lancia `Error(res.Err)` sul ramo Err e restituisce il
// payload Ok (o undefined per Result<()>); i chiamanti gestiscono il throw.
// Comportamento identico alle vecchie `call(cid, 'platform_*', ...)` inline.

/**
 * @param {any} res — Result candid decodificato ({ Ok } | { Err })
 * @returns {any} il payload Ok (undefined per Result<()>)
 */
function unwrap(res) {
  if (res && 'Err' in res) throw new Error(res.Err);
  return res && 'Ok' in res ? res.Ok : undefined;
}

/**
 * Concede il supporto EasyCan: ri-aggiunge lo spawner come controller (NON
 * riporta a managed). `sp` è di norma `original_spawner`.
 * @param {string} cid
 * @param {import('@dfinity/principal').Principal} sp
 */
export function grantSupport(cid, sp) {
  return call(cid, 'platform_add_controller', sp).then(unwrap);
}

/**
 * Revoca il supporto EasyCan: rimuove lo spawner dai controller.
 * @param {string} cid
 * @param {import('@dfinity/principal').Principal} sp
 */
export function revokeSupport(cid, sp) {
  return call(cid, 'platform_remove_controller', sp).then(unwrap);
}

/**
 * Rimuove il portal_owner (spegne la dashboard EasyCan).
 * @param {string} cid
 */
export function removePortal(cid) {
  return call(cid, 'platform_remove_portal').then(unwrap);
}

/**
 * Ripristina il portal_owner (riaccende la dashboard EasyCan).
 * @param {string} cid
 */
export function restorePortal(cid) {
  return call(cid, 'platform_restore_portal').then(unwrap);
}

/**
 * Aggiunge un controller arbitrario al canister.
 * @param {string} cid
 * @param {import('@dfinity/principal').Principal} p
 */
export function addController(cid, p) {
  return call(cid, 'platform_add_controller', p).then(unwrap);
}

/**
 * Rimuove un controller dal canister.
 * @param {string} cid
 * @param {import('@dfinity/principal').Principal} p
 */
export function removeController(cid, p) {
  return call(cid, 'platform_remove_controller', p).then(unwrap);
}
