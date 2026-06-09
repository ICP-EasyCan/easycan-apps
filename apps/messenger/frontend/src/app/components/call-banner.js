/**
 * call-banner.js — Banner chiamata globale persistente.
 *
 * Montato una volta all'init, sopra il route container. Sopravvive alla navigazione.
 * Usa capabilities: calls (state machine), contacts (alias lookup).
 */

import { el }               from '@shared/ui/dom.js';
import { CANISTER_ID }      from '@shared/core/config.js';
import { call }              from '@shared/core/icp.js';
import {
  CALL_STATES, setOnCallStateChange, getCallState,
  acceptIncomingCall, endCall, removePendingCallFromCache,
  muteCall, isMuted,
}                            from '../connection-manager.js';
import { getContactAlias }   from '../contacts-store.js';
import { getContactByPrincipal }
                             from '@shared/capabilities/contacts/index.js';

let _bannerEl = null;
let _timerInterval = null;
let _timerStart = 0;

/**
 * Inizializza il call banner. Chiamare una volta dopo il login.
 */
export function initCallBanner() {
  if (_bannerEl) {
    // Re-init: ricollegare callback
    setOnCallStateChange(_handleStateChange);
    return;
  }

  const app = document.getElementById('app');
  if (!app) return;

  _bannerEl = el('div', { class: 'call-banner hidden' });
  app.prepend(_bannerEl);

  setOnCallStateChange(_handleStateChange);

  // Sync con stato corrente
  const { state, meta } = getCallState();
  if (state !== CALL_STATES.idle) _handleStateChange(state, meta);
}

function _handleStateChange(state, meta) {
  if (!_bannerEl) return;
  _clearTimer();

  if (state === CALL_STATES.idle) {
    _bannerEl.className = 'call-banner hidden';
    _bannerEl.innerHTML = '';
    return;
  }

  const alias = _resolveAlias(meta);

  switch (state) {
    case CALL_STATES.calling:
      _renderBanner('state-calling', `Calling ${alias}...`, [_hangupBtn()]);
      break;

    case CALL_STATES.incoming:
      _renderBanner('state-incoming', `Incoming call from ${alias}`, [_acceptBtn(meta), _rejectBtn(meta)]);
      break;

    case CALL_STATES.connecting:
      _renderBanner('state-connecting', `Connecting to ${alias}...`, [_hangupBtn()]);
      break;

    case CALL_STATES.connected:
      _timerStart = Date.now();
      _renderConnectedBanner(alias, meta);
      _startTimer();
      break;

    case CALL_STATES.ended: {
      _renderBanner('state-ended', _endedText(alias, meta), []);
      break;
    }
  }
}

function _endedText(alias, meta) {
  switch (meta.errorCode) {
    case 'self_call':
      return `You cannot call yourself.`;
    case 'not_in_whitelist':
      return `${alias} has not added you to their contacts.`;
    case 'peer_offline':
      return `${alias} did not answer.`;
    case 'missed':
      return `Missed call from ${alias}.`;
    case 'canister_unreachable':
      return `${alias} is not reachable.`;
    case 'webrtc_failed':
      return `Call disconnected (STUN-only — may fail behind strict NAT).`;
    case 'mic_denied':
      return `Microphone access was denied.`;
    case 'busy':
      return `Another call was already in progress.`;
    case 'hangup':
    case undefined:
      return `Call ended.`;
    default:
      return meta.reason ? `Call ended (${meta.reason}).` : 'Call ended.';
  }
}

function _resolveAlias(meta) {
  if (meta.peerPid) {
    const a = getContactAlias(meta.peerPid);
    if (a) return a;
    const contact = getContactByPrincipal(meta.peerPid);
    return contact?.alias || meta.peerPid.slice(0, 12) + '...';
  }
  return 'Unknown';
}

function _renderBanner(stateClass, text, actions) {
  _bannerEl.className = `call-banner ${stateClass}`;
  _bannerEl.innerHTML = '';
  _bannerEl.append(
    el('span', { class: 'call-banner-text' }, text),
    el('div', { class: 'call-banner-actions' }, ...actions),
  );
}

function _renderConnectedBanner(alias, meta) {
  const muted = meta.muted || false;
  _bannerEl.className = 'call-banner state-connected';
  _bannerEl.innerHTML = '';
  _bannerEl.append(
    el('div', { class: 'call-banner-row' },
      el('span', { class: 'call-banner-text' }, `\u{1F7E2} ${alias}`),
      el('span', { class: 'call-banner-timer' }, '00:00'),
    ),
    el('div', { class: 'call-banner-row' },
      _muteBtn(muted),
      _hangupBtn(),
    ),
  );
}

function _muteBtn(muted) {
  return el('button', {
    class: `call-banner-btn call-banner-mute${muted ? ' muted' : ''}`,
    onclick: () => muteCall(!isMuted()),
  }, muted ? '\u{1F50A} Unmute' : '\u{1F507} Mute');
}

function _hangupBtn() {
  return el('button', {
    class: 'call-banner-btn call-banner-hangup',
    onclick: () => endCall(CANISTER_ID),
  }, 'Hang up');
}

function _acceptBtn(meta) {
  return el('button', {
    class: 'call-banner-btn call-banner-accept',
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const contact = getContactByPrincipal(meta.peerPid);
        if (!contact) throw new Error('Unknown contact');
        removePendingCallFromCache(meta.peerPid);
        await acceptIncomingCall(CANISTER_ID, contact.canisterId, contact.principalId);
      } catch (err) {
        console.warn('[call-banner] accept error:', err);
        e.target.disabled = false;
      }
    },
  }, 'Answer');
}

function _rejectBtn(meta) {
  return el('button', {
    class: 'call-banner-btn call-banner-reject',
    onclick: async () => {
      try {
        const { Principal } = await import('@dfinity/principal');
        await call(CANISTER_ID, 'clear_pending_caller', Principal.fromText(meta.peerPid)).catch(() => {});
        removePendingCallFromCache(meta.peerPid);
        _handleStateChange(CALL_STATES.idle, {});
      } catch (err) {
        console.warn('[call-banner] reject error:', err);
      }
    },
  }, 'Reject');
}

function _startTimer() {
  const timerSpan = _bannerEl.querySelector('.call-banner-timer');
  if (!timerSpan) return;
  _timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const sec = String(elapsed % 60).padStart(2, '0');
    timerSpan.textContent = `${min}:${sec}`;
  }, 1000);
}

function _clearTimer() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
}
