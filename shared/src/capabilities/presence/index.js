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

// Auto-stop su logout
bus.on('auth:logout', () => stopPresence());
