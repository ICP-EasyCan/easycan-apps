/**
 * Capability: Presence
 *
 * Segnala online/offline e verifica presenza peer on-demand.
 * Heartbeat implicito tramite piggyback in icp.js (throttle 60s).
 *
 * Exports:
 *   initPresence(ownCid)               → segnala online
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

// Throttle del ping "online" che SOPRAVVIVE ai reload: un F5 ripetuto non deve
// ripagare ~6.2M cycles ogni volta. Deve stare sotto la soglia di staleness del
// backend (90s) così la presenza resta fresca anche saltando il ping. Timbro in
// localStorage (per-origin: un solo canister proprio per origin).
const ONLINE_THROTTLE_MS = 60_000;
const LAST_ONLINE_KEY = 'cap_presence_last_online';

let _ownCid = null;

/**
 * Segnala online al login. Chiamare una sola volta dopo il login.
 *
 * NON registra più un ping offline su beforeunload: era ~6.2M cycles ad ogni
 * refresh/chiusura ED è inaffidabile (i browser uccidono la chiamata firmata
 * durante il teardown della pagina). Il peer viene messo offline dal timer di
 * staleness (soglia 90s di silenzio) — vedi cleanup_stale in cap-presence.
 */
export function initPresence(ownCid) {
  _ownCid = ownCid;
  setOwnCanisterId(ownCid);
  // Se abbiamo già segnalato online da meno di 60s (< soglia staleness 90s del
  // backend), NON rifare l'update: la presenza è ancora fresca. Al primo avvio (o
  // trascorsi 60s) segnala e timbra. Così F5 ripetuti non ripagano il ping ogni volta.
  let last = 0;
  try { last = Number(localStorage.getItem(LAST_ONLINE_KEY)) || 0; } catch { /* n/d */ }
  if (Date.now() - last >= ONLINE_THROTTLE_MS) {
    call(ownCid, 'set_presence', true).catch(console.warn);
    try { localStorage.setItem(LAST_ONLINE_KEY, String(Date.now())); } catch { /* n/d */ }
  }
}

/** Segnala offline e pulisce (logout). */
export function stopPresence() {
  if (_ownCid) {
    call(_ownCid, 'set_presence', false).catch(() => {});
    _ownCid = null;
  }
  // Azzera il timbro: dopo un logout (che ci ha messi offline) il prossimo login
  // DEVE ri-segnalare online, altrimenti il throttle lo salterebbe e resteremmo
  // offline agli occhi dei peer.
  try { localStorage.removeItem(LAST_ONLINE_KEY); } catch { /* n/d */ }
  setOwnCanisterId(null);
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
