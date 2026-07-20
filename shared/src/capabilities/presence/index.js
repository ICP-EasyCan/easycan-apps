/**
 * Capability: Presence
 *
 * Segnala online/offline e verifica presenza peer on-demand.
 * Heartbeat implicito tramite piggyback in icp.js (throttle 60s).
 *
 * Exports:
 *   initPresence(ownCid)               → segnala online, registra beforeunload
 *   stopPresence()                     → segnala offline, cleanup
 *   checkPeerPresence(peerCid)         → { online, lastSeenMs }
 *   watchPeerPresence(peerCid, cb, opts) → auto-refresh presenza, ritorna stop()
 *
 * Bus: ascolta auth:logout per auto-stop.
 * Backend: set_presence (update), get_presence (query).
 */

import { call, query, setOwnCanisterId } from '../../core/icp.js';
import { bus } from '../../core/event-bus.js';

const STALE_MS = 90_000;

let _ownCid = null;

/**
 * Segnala online al login. Registra beforeunload per segnalare offline.
 * Chiamare una sola volta dopo il login.
 */
export function initPresence(ownCid) {
  _ownCid = ownCid;
  setOwnCanisterId(ownCid);
  call(ownCid, 'set_presence', true).catch(console.warn);
  window.addEventListener('beforeunload', _handleBeforeUnload);
}

/** Segnala offline e pulisce (logout). */
export function stopPresence() {
  window.removeEventListener('beforeunload', _handleBeforeUnload);
  if (_ownCid) {
    call(_ownCid, 'set_presence', false).catch(() => {});
    _ownCid = null;
  }
  setOwnCanisterId(null);
}

function _handleBeforeUnload() {
  if (_ownCid) {
    call(_ownCid, 'set_presence', false).catch(() => {});
  }
}

/**
 * Check on-demand della presenza di un peer.
 * @param {string} peerCid — canister ID del peer
 * @returns {Promise<{ online: boolean, lastSeenMs: number|null }>}
 */
export async function checkPeerPresence(peerCid) {
  try {
    const result = await query(peerCid, 'get_presence');
    const info = result?.Ok;
    let online = info?.online === true;
    let lastSeenMs = null;
    if (info?.last_seen_ns) {
      lastSeenMs = Number(info.last_seen_ns / 1_000_000n);
      if (online && Date.now() - lastSeenMs > STALE_MS) online = false;
    }
    return { online, lastSeenMs };
  } catch {
    return { online: false, lastSeenMs: null };
  }
}

/**
 * Osserva la presenza di un peer con refresh automatico.
 *
 * Fa un primo check immediato, poi ri-controlla ogni `intervalMs`. Ripolla
 * anche al ritorno visibile della pagina (i timer sono throttlati/congelati a
 * pagina nascosta sui browser mobile) così l'indicatore è fresco appena si
 * torna in chat. Il callback riceve l'esito di `checkPeerPresence`.
 *
 * @param {string} peerCid — canister ID del peer
 * @param {(presence: { online: boolean, lastSeenMs: number|null }) => void} cb
 * @param {{ intervalMs?: number }} [opts] — intervallo refresh (default 30000)
 * @returns {() => void} stop() — ferma il refresh e rimuove i listener
 */
export function watchPeerPresence(peerCid, cb, { intervalMs = 30_000 } = {}) {
  let stopped = false;

  async function tick() {
    const presence = await checkPeerPresence(peerCid);
    if (!stopped) cb(presence);
  }

  const visListener = () => {
    if (document.visibilityState === 'visible') tick();
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', visListener);

  return function stop() {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visListener);
  };
}

// Auto-stop su logout
bus.on('auth:logout', () => stopPresence());
