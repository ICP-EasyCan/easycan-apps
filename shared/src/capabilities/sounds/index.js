/**
 * Capability: Sounds
 *
 * Suoni sintetizzati via WebAudio — zero asset audio (niente peso nel canister,
 * niente licenze). La capability è passiva: nessun suono parte da sola, è l'APP
 * che chiama play* agganciandosi ai propri eventi.
 *
 * Exports:
 *   initSounds()        → registra il listener di sblocco autoplay (una volta)
 *   playMessage()       → beep breve per messaggio in arrivo (throttle 1s)
 *   startRingtone()     → pattern due-toni in loop (~2s on / 1s pausa), idempotente
 *   stopRingtone()      → ferma il loop (noop se non attivo)
 *   playCallEnd()       → tono discendente breve di fine chiamata
 *   setEnabled(bool)    → persiste in localStorage['sounds:enabled']
 *   isEnabled()         → stato corrente (default: on)
 *
 * Gotcha autoplay: i browser bloccano l'audio senza gesto utente. L'AudioContext
 * nasce/riparte al primo pointerdown/keydown; ogni play* prima dello sblocco
 * fallisce in silenzio, mai lanciare.
 */

const STORAGE_KEY = 'sounds:enabled';
const MIN_BEEP_GAP_MS = 1_000;   // anti-doppio-beep (notify + chat-session)
const RING_PERIOD_MS = 3_000;    // burst ~2s + ~1s di pausa

let _ctx = null;
let _initialized = false;
let _enabled = null;             // lazy da localStorage
let _ringTimer = null;
let _ringOscs = [];              // oscillatori del burst corrente (per stop immediato)
let _lastBeepAt = 0;

/**
 * Inizializza il motore. Chiamare una volta al bootstrap dell'app.
 * Non crea suoni: registra solo lo sblocco dell'AudioContext al primo gesto.
 */
export function initSounds() {
  if (_initialized) return;
  _initialized = true;
  const unlock = () => {
    const ctx = _ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
}

/** Stato corrente (default on). */
export function isEnabled() {
  if (_enabled === null) {
    try { _enabled = localStorage.getItem(STORAGE_KEY) !== 'off'; }
    catch { _enabled = true; }
  }
  return _enabled;
}

/** Abilita/disabilita tutti i suoni (persistito). Off ferma anche il ringtone attivo. */
export function setEnabled(on) {
  _enabled = !!on;
  try { localStorage.setItem(STORAGE_KEY, _enabled ? 'on' : 'off'); } catch { /* no-op */ }
  if (!_enabled) stopRingtone();
}

/** Beep discreto per messaggio in arrivo (2 toni, ~200ms, throttle 1s). */
export function playMessage() {
  if (!isEnabled()) return;
  const now = Date.now();
  if (now - _lastBeepAt < MIN_BEEP_GAP_MS) return;
  _lastBeepAt = now;
  _tone(880, 0, 0.09, 0.06);
  _tone(1175, 0.10, 0.11, 0.06);
}

/** Avvia il ringtone in loop. Idempotente: start su ringtone già attivo = noop. */
export function startRingtone() {
  if (!isEnabled() || _ringTimer) return;
  _ringBurst();
  _ringTimer = setInterval(_ringBurst, RING_PERIOD_MS);
}

/** Ferma il ringtone (anche il burst in corso). Noop se non attivo. */
export function stopRingtone() {
  if (_ringTimer) { clearInterval(_ringTimer); _ringTimer = null; }
  for (const osc of _ringOscs) {
    try { osc.stop(); } catch { /* già fermo */ }
  }
  _ringOscs = [];
}

/** Tono discendente breve di fine chiamata. */
export function playCallEnd() {
  if (!isEnabled()) return;
  _tone(660, 0, 0.12, 0.07);
  _tone(520, 0.13, 0.12, 0.07);
  _tone(392, 0.26, 0.18, 0.06);
}

// ─── Interni ────────────────────────────────────────────────────────────────

function _ensureCtx() {
  if (_ctx) return _ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  } catch { _ctx = null; }
  return _ctx;
}

/** Burst di ~2s: due toni alternati (pattern classico di squillo). */
function _ringBurst() {
  _ringOscs = [];
  for (let i = 0; i < 4; i++) {
    const osc = _tone(i % 2 === 0 ? 740 : 880, i * 0.5, 0.45, 0.09);
    if (osc) _ringOscs.push(osc);
  }
}

/**
 * Programma un singolo tono con inviluppo (anti-click). Fail-silent:
 * senza AudioContext o con contesto sospeso non suona e non lancia.
 * @returns {OscillatorNode|null}
 */
function _tone(freq, delaySec, durSec, peak, type = 'sine') {
  const ctx = _ensureCtx();
  if (!ctx) return null;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.setValueAtTime(peak, t0 + Math.max(durSec - 0.03, 0.02));
    gain.gain.linearRampToValueAtTime(0, t0 + durSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.05);
    return osc;
  } catch {
    return null;
  }
}
