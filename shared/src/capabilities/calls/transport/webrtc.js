/**
 * WebRTCTransport — Implementazione P2P via WebRTC.
 *
 * Usa il canister ICP come signal server (Offer/Answer/ICE via post_signal/get_my_signals).
 * I messaggi viaggiano su RTCDataChannel (non passano per il canister).
 *
 * Adattato dalla fabbrica: usa call/query da core/icp.js invece di wrapper diretti.
 */

import { P2PTransport } from './base.js';
import { ICE_SERVERS } from '../../../core/config.js';
import { call, query } from '../../../core/icp.js';
import { Principal } from '@dfinity/principal';

const POLL_INTERVAL_MS    = 1_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;

export class WebRTCTransport extends P2PTransport {
  constructor(ownCanisterId, peerCanisterId, peerPrincipal) {
    super(peerCanisterId, peerPrincipal);
    this._ownCid  = ownCanisterId;
    this._peerCid = peerCanisterId;
    this._peerPrincipal = Principal.fromText(peerPrincipal);

    this._pc        = null;
    this._dc        = null;
    this._status    = 'disconnected';
    this._pollTimer = null;
    this._pollStart = 0;
  }

  get state() { return this._status; }

  async connect() {
    this._status = 'connecting';
    this._pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this._setupPCHandlers();

    this._dc = this._pc.createDataChannel('sm', { ordered: true });
    this._setupDCHandlers(this._dc);

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForIceGathering();

    await call(this._ownCid, 'post_signal',
      this._peerPrincipal, { Offer: null },
      JSON.stringify(this._pc.localDescription.toJSON()));

    this._startPolling();
  }

  async accept(offerData) {
    this._status = 'connecting';
    this._pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this._setupPCHandlers();

    this._pc.ondatachannel = ({ channel }) => {
      this._dc = channel;
      this._setupDCHandlers(channel);
    };

    const offerDesc = new RTCSessionDescription(JSON.parse(offerData));
    await this._pc.setRemoteDescription(offerDesc);

    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    await this._waitForIceGathering();

    await call(this._ownCid, 'post_signal',
      this._peerPrincipal, { Answer: null },
      JSON.stringify(this._pc.localDescription.toJSON()));

    this._startPolling();
  }

  async send(message) {
    if (!this._dc || this._dc.readyState !== 'open') {
      throw new Error('Connection not active');
    }
    this._dc.send(message);
  }

  disconnect() {
    this._stopPolling();
    this._dc?.close();
    this._pc?.close();
    this._dc = null;
    this._pc = null;
    this._status = 'disconnected';
    this.onDisconnected?.('manual');
  }

  _setupPCHandlers() {
    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      if (s === 'connected') {
        this._status = 'connected';
        this._stopPolling();
      } else if (s === 'failed' || s === 'closed') {
        this._status = 'disconnected';
        this.onDisconnected?.(s);
      }
    };
  }

  _setupDCHandlers(dc) {
    dc.onopen    = () => { this._status = 'connected'; this._stopPolling(); this.onConnected?.(); };
    dc.onclose   = () => { this._status = 'disconnected'; this.onDisconnected?.('channel closed'); };
    dc.onmessage = ({ data }) => this.onMessage?.(data);
    dc.onerror   = (err) => this.onError?.(new Error(err.error?.message || err.type || 'DataChannel error'));
  }

  _waitForIceGathering() {
    if (this._pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      this._pc.onicegatheringstatechange = () => {
        if (this._pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  _startPolling() {
    this._pollStart = Date.now();
    this._pollTimer = setInterval(() => this._processPeerSignals(), POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _processPeerSignals() {
    if (Date.now() - this._pollStart > HANDSHAKE_TIMEOUT_MS) {
      this._stopPolling();
      this.onError?.(new Error('WebRTC handshake timeout (60s)'));
      return;
    }
    try {
      const signals = await query(this._peerCid, 'get_my_signals');
      if (!signals.length) return;
      for (const sig of signals) await this._handleSignal(sig);
      await call(this._peerCid, 'ack_signals', signals.map(s => s.id));
    } catch (err) {
      console.warn('[WebRTC] polling error:', err);
    }
  }

  async _handleSignal(sig) {
    const data = sig.data;
    if (sig.sig_type?.Answer !== undefined && this._pc.signalingState === 'have-local-offer') {
      await this._pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data)));
    } else if (sig.sig_type?.IceCandidate !== undefined) {
      try { await this._pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data))); }
      catch { /* ICE candidate non più valido */ }
    }
  }
}
