/**
 * Capability: Calls
 *
 * Chiamate vocali WebRTC con signaling via canister.
 * Convenzione: ognuno posta segnali sul PROPRIO canister, il peer li legge da lì.
 *
 * Exports:
 *   CALL_STATES                                     → { idle, calling, incoming, connecting, connected, ended }
 *   initiateCall(ownCid, peerCid, peerPid)          → Promise<RTCPeerConnection>
 *   acceptIncomingCall(ownCid, peerCid, peerPid)    → Promise<RTCPeerConnection>
 *   endCall(ownCid)                                 → void
 *   muteCall(muted)                                 → void
 *   isMuted()                                       → boolean
 *   setOnCallStateChange(cb)                        → void
 *   getCallState()                                  → { state, meta }
 *   getActiveCall()                                 → object | null
 *
 * Bus ascolta: call:incoming (da notify capability).
 * Backend: post_signal, get_my_signals, ack_signals, notify_pending_call, clear_pending_caller.
 */

import { call, query } from '../../core/icp.js';
import { ICE_SERVERS } from '../../core/config.js';
import { bus } from '../../core/event-bus.js';
import { CallError, classifyIcpError } from '../errors.js';
import { acquireMic, addLocalTracks, attachRemoteAudio, cleanupMedia, tuneOpusSdp } from './media.js';
import { setPollRate } from '../notify/index.js';

// ─── Costanti ───────────────────────────────────────────────────────────────

export const CALL_STATES = {
  idle: 'idle',
  calling: 'calling',
  incoming: 'incoming',
  connecting: 'connecting',
  connected: 'connected',
  ended: 'ended',
};

// ─── Stato interno ──────────────────────────────────────────────────────────

let _callState = CALL_STATES.idle;
let _callMeta = {};
let _onCallStateChange = null;
let _endedAutoIdleTimer = null;
let _activeCall = null;
let _callStartTs = 0;
let _isMuted = false;
let _pendingOutbound = null;
let _outboundCancelled = false;

// ─── Screen Wake Lock ───────────────────────────────────────────────────────
// Tiene lo schermo acceso durante TUTTA la chiamata, setup incluso (il caso
// rotto è lo schermo che si spegne durante calling/incoming, non solo a
// connected). Feature-detect + fail-silent: il wake lock non deve MAI far
// fallire una chiamata. Inerte per le app che non usano le chiamate.

let _wakeLock = null;
let _wakeLockWanted = false;

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator) || _wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    // Il sistema lo rilascia da solo a pagina hidden → azzera il riferimento
    // così il visibilitychange sotto può ri-acquisire.
    lock.addEventListener('release', () => { if (_wakeLock === lock) _wakeLock = null; });
    if (!_wakeLockWanted) { lock.release().catch(() => {}); return; }
    _wakeLock = lock;
  } catch { /* browser vecchio, permesso negato, pagina hidden: pazienza */ }
}

function _releaseWakeLock() {
  const lock = _wakeLock;
  _wakeLock = null;
  if (lock) {
    try { lock.release().catch(() => {}); } catch { /* no-op */ }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _wakeLockWanted && !_wakeLock) {
      _acquireWakeLock();
    }
  });
}

// ─── State machine ──────────────────────────────────────────────────────────

function _setCallState(state, meta = {}) {
  if (_endedAutoIdleTimer) {
    clearTimeout(_endedAutoIdleTimer);
    _endedAutoIdleTimer = null;
  }
  _callState = state;
  _callMeta = state === CALL_STATES.idle ? {} : { ..._callMeta, ...meta };
  if (_onCallStateChange) _onCallStateChange(state, _callMeta);

  // Fast poll durante calling/incoming/connecting per glare e annullamenti reattivi.
  // Idle/connected/ended → torna a 10s.
  const transient = state === CALL_STATES.calling
    || state === CALL_STATES.incoming
    || state === CALL_STATES.connecting;
  setPollRate(transient ? 'fast' : 'idle');

  // Wake lock: acceso per tutti gli stati di chiamata attiva, spento su ended/idle.
  _wakeLockWanted = transient || state === CALL_STATES.connected;
  if (_wakeLockWanted) _acquireWakeLock(); else _releaseWakeLock();

  // Auto-reset ended → idle dopo 3s
  if (state === CALL_STATES.ended) {
    _endedAutoIdleTimer = setTimeout(() => {
      _endedAutoIdleTimer = null;
      _setCallState(CALL_STATES.idle);
    }, 3000);
  }
}

export function setOnCallStateChange(cb) { _onCallStateChange = cb; }
export function getCallState() { return { state: _callState, meta: _callMeta }; }
export function getActiveCall() { return _activeCall; }
export function isMuted() { return _isMuted; }

export function muteCall(muted) {
  if (!_activeCall?.localStream) return;
  for (const track of _activeCall.localStream.getAudioTracks()) {
    track.enabled = !muted;
  }
  _isMuted = muted;
  if (_onCallStateChange && _callState === CALL_STATES.connected) {
    _onCallStateChange(_callState, { ..._callMeta, muted: _isMuted });
  }
}

// ─── Signal helpers ─────────────────────────────────────────────────────────

function _waitIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const timeout = setTimeout(resolve, 10_000);
    pc.addEventListener('icegatheringstatechange', function handler() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    });
  });
}

async function _cleanupSignals(cid) {
  try {
    const signals = await query(cid, 'get_my_signals');
    if (signals.length > 0) {
      await call(cid, 'ack_signals', signals.map(s => s.id));
    }
  } catch { /* ignore */ }
}

async function _pollForSignal(cid, sigType, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (_outboundCancelled) return null;
    try {
      const signals = await query(cid, 'get_my_signals');
      const match = signals
        .filter(s => s.sig_type?.[sigType] !== undefined)
        .filter(s => !_callStartTs || Number(s.timestamp / 1_000_000n) > _callStartTs - 30_000)
        .sort((a, b) => Number(b.timestamp - a.timestamp))[0];
      if (match) return match;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  return null;
}

function _setupConnectionHandlers(pc) {
  pc.addEventListener('connectionstatechange', () => {
    const state = pc.connectionState;
    if (state === 'connected') {
      _setCallState(CALL_STATES.connected, { muted: _isMuted });
    } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      if (_activeCall?.pc === pc) {
        cleanupMedia(_activeCall);
        _activeCall = null;
        _isMuted = false;
        const errorCode = state === 'closed' ? 'hangup' : 'webrtc_failed';
        _setCallState(CALL_STATES.ended, { reason: state, errorCode });
      }
    }
  });
}

// ─── API pubblica ───────────────────────────────────────────────────────────

/**
 * Chiamata in uscita — notifica il peer e attende la sua Offer.
 */
export async function initiateCall(ownCid, peerCid, peerPid, callerPid) {
  if (_activeCall || _pendingOutbound) throw new CallError('busy', 'A call is already in progress.');

  if ((callerPid && callerPid === peerPid) || ownCid === peerCid) {
    throw new CallError('self_call', 'You cannot call yourself.');
  }

  _setCallState(CALL_STATES.calling, { peerCid, peerPid });
  _outboundCancelled = false;

  let localStream = null;
  let callerPrincipal = null;
  let peerPrincipal = null;
  try {
    const { Principal } = await import('@dfinity/principal');
    peerPrincipal = Principal.fromText(peerPid);
    callerPrincipal = callerPid ? Principal.fromText(callerPid) : null;

    // Pre-flight mutual contact check
    if (callerPid) {
      try {
        const allowed = await query(peerCid, 'is_whitelisted', Principal.fromText(callerPid));
        if (!allowed) {
          throw new CallError('not_in_whitelist',
            'The peer has not added you to their contacts.');
        }
      } catch (err) {
        if (err instanceof CallError) throw err;
        throw new CallError('canister_unreachable',
          `Could not reach the peer canister: ${err.message}`);
      }
    }

    try {
      localStream = await acquireMic();
    } catch (err) {
      throw new CallError('mic_denied', 'Microphone access was denied.');
    }
    _callStartTs = Date.now();
    _pendingOutbound = { ownCid, peerCid, peerPid, ownPid: callerPid, callerPrincipal, localStream };
    await _cleanupSignals(peerCid);
    if (_outboundCancelled) throw new CallError('hangup', 'Call cancelled.');

    try {
      await call(peerCid, 'notify_pending_call', peerPrincipal);
    } catch (err) {
      throw new CallError(classifyIcpError(err), err.message);
    }

    // Wait for Offer from the peer's canister
    const offerSignal = await _pollForSignal(peerCid, 'Offer', 60_000);
    if (_outboundCancelled) {
      if (offerSignal) call(peerCid, 'ack_signals', [offerSignal.id]).catch(() => {});
      throw new CallError('hangup', 'Call cancelled.');
    }
    if (!offerSignal) throw new CallError('peer_offline', 'The peer did not answer.');

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    addLocalTracks(pc, localStream);
    const remoteAudio = attachRemoteAudio(pc);

    _activeCall = { peerCid, peerPid, pc, dc: null, localStream, remoteAudio };
    pc.ondatachannel = (ev) => { _activeCall.dc = ev.channel; };
    _setupConnectionHandlers(pc);

    _setCallState(CALL_STATES.connecting, { peerCid, peerPid });

    // Tuning Opus su entrambe le description (i fmtp li legge il mittente dal remoto)
    const remoteOffer = JSON.parse(offerSignal.data);
    remoteOffer.sdp = tuneOpusSdp(remoteOffer.sdp);
    await pc.setRemoteDescription(remoteOffer);
    const answer = await pc.createAnswer();
    answer.sdp = tuneOpusSdp(answer.sdp);
    await pc.setLocalDescription(answer);
    await _waitIce(pc);

    // Posta Answer sul PROPRIO canister
    await call(ownCid, 'post_signal', peerPrincipal, { Answer: null },
      JSON.stringify(pc.localDescription));

    // ACK Offer fire-and-forget
    call(peerCid, 'ack_signals', [offerSignal.id]).catch(() => {});

    _pendingOutbound = null;
    return pc;
  } catch (err) {
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
    }
    const callErr = err instanceof CallError
      ? err
      : new CallError(classifyIcpError(err), err.message);
    // Best-effort: rimuovi noi stessi dai pending callers del peer
    if (callerPrincipal && callErr.code !== 'self_call' && callErr.code !== 'not_in_whitelist') {
      call(peerCid, 'clear_pending_caller', callerPrincipal).catch(err => console.warn('[calls] clear_pending_caller failed:', err));
    }
    _pendingOutbound = null;
    _setCallState(CALL_STATES.ended, { reason: err.message, errorCode: callErr.code });
    throw callErr;
  }
}

/**
 * Accept an incoming call — create an Offer on-demand and wait for the Answer.
 */
export async function acceptIncomingCall(ownCid, peerCid, peerPid) {
  if (_activeCall) throw new CallError('busy', 'A call is already in progress.');

  // Reset cancellation flag: questa chiamata può seguire un endCall
  // (es. assorbimento glare lato polite) che l'aveva alzata.
  _outboundCancelled = false;
  _setCallState(CALL_STATES.connecting, { peerCid, peerPid });

  let localStream = null;
  try {
    try {
      localStream = await acquireMic();
    } catch (err) {
      throw new CallError('mic_denied', 'Microphone access was denied.');
    }
    _callStartTs = Date.now();

    const { Principal } = await import('@dfinity/principal');
    const peerPrincipal = Principal.fromText(peerPid);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    addLocalTracks(pc, localStream);
    const remoteAudio = attachRemoteAudio(pc);
    const dc = pc.createDataChannel('call', { ordered: true });

    _activeCall = { peerCid, peerPid, pc, dc, localStream, remoteAudio };
    _setupConnectionHandlers(pc);

    // Tuning Opus su entrambe le description (i fmtp li legge il mittente dal remoto)
    const offer = await pc.createOffer();
    offer.sdp = tuneOpusSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    await _waitIce(pc);

    // Post Offer on OUR canister
    try {
      await call(ownCid, 'post_signal', peerPrincipal, { Offer: null },
        JSON.stringify(pc.localDescription));
    } catch (err) {
      throw new CallError(classifyIcpError(err), err.message);
    }

    // Wait for Answer from the caller's canister
    const answerSignal = await _pollForSignal(peerCid, 'Answer', 60_000);
    if (!answerSignal) {
      pc.close();
      cleanupMedia(_activeCall);
      _activeCall = null;
      throw new CallError('peer_offline', 'The caller hung up before connecting.');
    }

    const remoteAnswer = JSON.parse(answerSignal.data);
    remoteAnswer.sdp = tuneOpusSdp(remoteAnswer.sdp);
    await pc.setRemoteDescription(remoteAnswer);

    // Cleanup fire-and-forget
    call(peerCid, 'ack_signals', [answerSignal.id]).catch(() => {});
    call(ownCid, 'clear_pending_caller', peerPrincipal).catch(() => {});

    return pc;
  } catch (err) {
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
    }
    const callErr = err instanceof CallError
      ? err
      : new CallError(classifyIcpError(err), err.message);
    _setCallState(CALL_STATES.ended, { reason: err.message, errorCode: callErr.code });
    throw callErr;
  }
}

/**
 * End the active call.
 */
export async function endCall(ownCid) {
  if (_activeCall) {
    const { peerCid, pc } = _activeCall;
    cleanupMedia(_activeCall);
    _activeCall = null;
    _callStartTs = 0;
    _isMuted = false;
    if (pc) pc.close();
    _setCallState(CALL_STATES.ended, { reason: 'hangup', errorCode: 'hangup' });
    if (peerCid) await _cleanupSignals(peerCid);
    return;
  }

  // Hangup durante calling/connecting prima che la pc sia stata creata
  if (_pendingOutbound) {
    const { peerCid, localStream, callerPrincipal } = _pendingOutbound;
    _outboundCancelled = true;
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
    }
    _callStartTs = 0;
    _isMuted = false;
    if (callerPrincipal) {
      call(peerCid, 'clear_pending_caller', callerPrincipal).catch(err => console.warn('[calls] clear_pending_caller failed:', err));
    }
    _setCallState(CALL_STATES.ended, { reason: 'hangup', errorCode: 'hangup' });
    _pendingOutbound = null;
  }
}

// ─── Incoming call handler via bus ──────────────────────────────────────────

bus.on('call:incoming', async ({ callerPid }) => {
  if (_callState === CALL_STATES.idle) {
    _setCallState(CALL_STATES.incoming, { peerPid: callerPid });
    return;
  }

  // GLARE: stiamo chiamando proprio quel peer e quel peer sta chiamando noi.
  // Regola politeness deterministica: chi ha pid maggiore cede e accetta;
  // chi ha pid minore prosegue come caller. Entrambi applicano la stessa
  // regola in locale, niente coordinazione esplicita.
  if (_callState !== CALL_STATES.calling) return;
  const po = _pendingOutbound;
  if (!po || po.peerPid !== callerPid || !po.ownPid) return;

  if (po.ownPid > callerPid) {
    // polite → annulla outbound, accetta incoming
    const { ownCid, peerCid, peerPid } = po;
    try {
      await endCall(ownCid);
    } catch { /* swallow */ }
    try {
      await acceptIncomingCall(ownCid, peerCid, peerPid);
    } catch (err) {
      console.warn('[calls] glare absorption failed:', err);
    }
  }
  // impolite → noop, prosegue come caller. Il polite posterà l'Offer.
});

bus.on('call:cancelled', ({ callerPid }) => {
  if (_callState === CALL_STATES.incoming && _callMeta.peerPid === callerPid) {
    _setCallState(CALL_STATES.ended, { errorCode: 'missed' });
  }
});

bus.on('auth:logout', () => {
  if (_activeCall) {
    cleanupMedia(_activeCall);
    if (_activeCall.pc) _activeCall.pc.close();
    _activeCall = null;
  }
  if (_pendingOutbound) {
    _outboundCancelled = true;
    if (_pendingOutbound.localStream) {
      for (const t of _pendingOutbound.localStream.getTracks()) t.stop();
    }
    _pendingOutbound = null;
  }
  _callState = CALL_STATES.idle;
  _callMeta = {};
  _isMuted = false;
  _callStartTs = 0;
  _wakeLockWanted = false;
  _releaseWakeLock();
  if (_endedAutoIdleTimer) {
    clearTimeout(_endedAutoIdleTimer);
    _endedAutoIdleTimer = null;
  }
});
