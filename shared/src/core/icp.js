/**
 * icp.js — Actor management generico per canister ICP.
 *
 * Pattern:
 *   - getActorFor(canisterId, idlFactory) → crea/riusa Actor dalla cache
 *   - call(cid, method, ...args) → update call + presenza piggyback
 *   - query(cid, method, ...args) → query call (gratis)
 *   - resetActors() → invalidare dopo login/logout
 *
 * L'idlFactory viene passata dall'app, non hardcoded qui.
 * Questo rende il modulo riutilizzabile per qualsiasi canister.
 */

import { Actor, HttpAgent } from '@dfinity/agent';
import { IC_HOST, IS_LOCAL } from './config.js';
import { getIdentity } from './auth.js';
import { bus } from './event-bus.js';

// ─── Cache degli Actor ────────────────────────────────────────────────────────

const _actors = new Map();
let _defaultIdlFactory = null;

/**
 * Registra l'idlFactory di default per il canister dell'app.
 * Chiamata una volta all'avvio dall'app.
 */
export function setDefaultIdlFactory(factory) {
  _defaultIdlFactory = factory;
}

/**
 * Crea (o riusa dalla cache) un Actor per un dato canister ID.
 * @param {string} canisterId
 * @param {Function} [idlFactory] — se omesso, usa il default registrato
 * @returns {Promise<Actor>}
 */
export async function getActorFor(canisterId, idlFactory) {
  const factory = idlFactory ?? _defaultIdlFactory;
  if (!factory) throw new Error('icp: nessun idlFactory — chiama setDefaultIdlFactory() o passa il parametro');

  if (_actors.has(canisterId)) return _actors.get(canisterId);

  const identity = getIdentity();
  const agent = await HttpAgent.create({ identity, host: IC_HOST });
  if (IS_LOCAL) {
    await agent.fetchRootKey().catch(console.warn);
  }

  const actor = Actor.createActor(factory, { agent, canisterId });
  _actors.set(canisterId, actor);
  return actor;
}

/** Invalida la cache degli actor (da chiamare dopo login/logout). */
export function resetActors() {
  _actors.clear();
}

// Auto-reset su login/logout
bus.on('auth:login', () => resetActors());
bus.on('auth:logout', () => resetActors());

// ─── Presence piggyback ──────────────────────────────────────────────────────

let _ownCid = null;
let _lastPresenceTouch = 0;
const PRESENCE_THROTTLE_MS = 60_000;

/** Registra il canister dell'utente per heartbeat implicito. */
export function setOwnCanisterId(cid) { _ownCid = cid; }

function _touchPresence() {
  if (!_ownCid) return;
  const now = Date.now();
  if (now - _lastPresenceTouch < PRESENCE_THROTTLE_MS) return;
  _lastPresenceTouch = now;
  getActorFor(_ownCid).then(a => a.set_presence(true)).catch(() => {});
}

/**
 * Update call con heartbeat di presenza come side-effect.
 * @param {string} cid — canister ID
 * @param {string} method — nome del metodo
 * @param {...any} args — argomenti
 */
export async function call(cid, method, ...args) {
  const actor = await getActorFor(cid);
  const result = await actor[method](...args);
  // Se la chiamata È GIÀ un set_presence sul proprio canister, la presenza è
  // appena stata rinfrescata dal filo: registra il timestamp e NON piggybackare.
  // Altrimenti a ogni boot initPresence sparerebbe DUE set_presence(true)
  // identici (~6M cycles sprecati/refresh) e stopPresence rischierebbe un
  // re-online subito dopo il logout. Il piggyback serve solo agli ALTRI update.
  if (method === 'set_presence' && cid === _ownCid) {
    _lastPresenceTouch = Date.now();
  } else {
    _touchPresence();
  }
  return result;
}

/**
 * Query call (gratis, senza side-effect).
 * @param {string} cid — canister ID
 * @param {string} method — nome del metodo
 * @param {...any} args — argomenti
 */
export async function query(cid, method, ...args) {
  const actor = await getActorFor(cid);
  return actor[method](...args);
}
