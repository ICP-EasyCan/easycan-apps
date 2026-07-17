/**
 * Capability: Notify
 *
 * Polling dei pending senders e pending callers ogni 10s.
 * Interroga solo il proprio canister (zero costi, due query gratuite).
 *
 * Exports:
 *   startPendingPoll(ownCid)            → avvia polling
 *   stopPendingPoll()                   → ferma polling
 *   getPendingCache()                   → Set<principalId> (messaggi in attesa)
 *   removePendingFromCache(pid)         → rimuove un sender dalla cache
 *   getPendingCallCache()               → Set<principalId> (chiamate in attesa)
 *   removePendingCallFromCache(pid)     → rimuove un caller dalla cache
 *
 * Bus emette:
 *   notify:pending-update  → { senders: Set<string> }
 *   call:incoming          → { callerPid: string }
 *
 * Backend: get_pending_senders (query), get_pending_callers (query).
 */

import { query } from '../../core/icp.js';
import { bus } from '../../core/event-bus.js';

const POLL_MS_IDLE = 10_000;
const POLL_MS_FAST = 2_000;

const _pendingCache = new Set();
const _pendingCallCache = new Set();
let _pollTimer = null;
let _ownCid = null;
let _pollRunning = false;
let _currentPollMs = POLL_MS_IDLE;
let _visListener = null;

/**
 * Avvia il polling dei pending senders + callers ogni 10s.
 * Può essere chiamato più volte: non riavvia il timer se già attivo.
 */
export function startPendingPoll(ownCid) {
  _ownCid = ownCid;
  if (_pollTimer) return;

  // Poll immediato
  _poll();

  _pollTimer = setInterval(_poll, _currentPollMs);

  // Re-poll immediato al ritorno visibile: i browser mobile throttlano/congelano
  // i timer a pagina nascosta — al risveglio non aspettare il prossimo tick.
  _visListener = () => {
    if (document.visibilityState === 'visible' && _pollTimer) _poll();
  };
  document.addEventListener('visibilitychange', _visListener);
}

/** Ferma il polling (logout). */
export function stopPendingPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_visListener) {
    document.removeEventListener('visibilitychange', _visListener);
    _visListener = null;
  }
  _pendingCache.clear();
  _pendingCallCache.clear();
  _ownCid = null;
  _pollRunning = false;
  _currentPollMs = POLL_MS_IDLE;
}

/**
 * Cambia cadenza di polling. Usata da calls per accelerare durante calling/incoming
 * (riduce a 2s la latenza di rilevamento glare e annullamenti).
 */
export function setPollRate(mode) {
  const target = mode === 'fast' ? POLL_MS_FAST : POLL_MS_IDLE;
  if (target === _currentPollMs) return;
  _currentPollMs = target;
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(_poll, _currentPollMs);
  }
}

/** Cache corrente dei pending senders. */
export function getPendingCache() { return _pendingCache; }

/** Rimuove un sender dalla cache (dopo aver letto i messaggi). */
export function removePendingFromCache(pid) { _pendingCache.delete(pid); }

/** Cache corrente dei pending callers. */
export function getPendingCallCache() { return _pendingCallCache; }

/** Rimuove un caller dalla cache. */
export function removePendingCallFromCache(pid) { _pendingCallCache.delete(pid); }

async function _poll() {
  if (_pollRunning || !_ownCid) return;
  _pollRunning = true;
  try {
    const [senders, callers] = await Promise.all([
      query(_ownCid, 'get_pending_senders'),
      query(_ownCid, 'get_pending_callers'),
    ]);

    // Aggiorna cache senders
    const senderSet = new Set(senders.map(p => p.toString()));
    _pendingCache.clear();
    for (const pid of senderSet) _pendingCache.add(pid);

    // Aggiorna cache callers e rileva nuovi/scomparsi
    const callerSet = new Set(callers.map(p => p.toString()));
    const newCallers = [];
    const removedCallers = [];
    for (const pid of callerSet) {
      if (!_pendingCallCache.has(pid)) newCallers.push(pid);
    }
    for (const pid of _pendingCallCache) {
      if (!callerSet.has(pid)) removedCallers.push(pid);
    }
    _pendingCallCache.clear();
    for (const pid of callerSet) _pendingCallCache.add(pid);

    // Emetti eventi
    bus.emit('notify:pending-update', { senders: _pendingCache });

    for (const pid of newCallers) {
      bus.emit('call:incoming', { callerPid: pid });
    }
    for (const pid of removedCallers) {
      bus.emit('call:cancelled', { callerPid: pid });
    }
  } catch (err) {
    console.warn('[notify] poll error:', err);
  } finally {
    _pollRunning = false;
  }
}

// Auto-stop su logout
bus.on('auth:logout', () => stopPendingPoll());
