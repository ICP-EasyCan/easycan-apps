/**
 * connection-manager.js — Thin wrapper che assembla le capability.
 *
 * Importa e ri-esporta da: presence, notify, calls.
 * Le pagine dell'app importano da qui per semplicità.
 */

import { CANISTER_ID } from '@shared/core/config.js';

// ─── Capability ────────────────────────────────────────────────────────────
import { initPresence, stopPresence, checkPeerPresence, watchPeerPresence }
  from '@shared/capabilities/presence/index.js';
import { startPendingPoll, stopPendingPoll, getPendingCache, removePendingFromCache,
         getPendingCallCache, removePendingCallFromCache }
  from '@shared/capabilities/notify/index.js';
import { CALL_STATES, initiateCall, acceptIncomingCall, endCall,
         muteCall, isMuted, setOnCallStateChange, getCallState, getActiveCall }
  from '@shared/capabilities/calls/index.js';

// ─── Init / Stop ────────────────────────────────────────────────────────────

export function initConnectionManager() {
  initPresence(CANISTER_ID);
  startPendingPoll(CANISTER_ID);
}

export function stopConnectionManager() {
  stopPresence();
  stopPendingPoll();
}

// ─── Re-export ──────────────────────────────────────────────────────────────

export {
  // presence
  checkPeerPresence, watchPeerPresence,
  // notify
  getPendingCache, removePendingFromCache,
  getPendingCallCache, removePendingCallFromCache,
  // calls
  CALL_STATES, initiateCall, acceptIncomingCall, endCall,
  muteCall, isMuted, setOnCallStateChange, getCallState, getActiveCall,
};
