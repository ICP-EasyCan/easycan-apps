/**
 * Messaging History — localStorage per cronologia chat.
 *
 * Exports:
 *   loadLocalHistory(peerId)            → [{ from, text, timestamp }]
 *   saveLocalHistory(peerId, msgs)      → void
 *   appendToLocalHistory(peerId, msg)   → void
 *   trimHistory(peerId)                 → void
 */

const LS_PREFIX = 'sm_chat_';
const MAX_LOCAL = 500;

/**
 * Carica la storia locale di una chat.
 * @param {string} peerId — principal ID del peer
 * @returns {Array<{ from: string, text: string, timestamp: number }>}
 */
export function loadLocalHistory(peerId) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + peerId);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/**
 * Salva la storia locale (tronca a MAX_LOCAL).
 * Gestisce QuotaExceededError con trim aggressivo.
 */
export function saveLocalHistory(peerId, messages) {
  try {
    const trimmed = messages.slice(-MAX_LOCAL);
    localStorage.setItem(LS_PREFIX + peerId, JSON.stringify(trimmed));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      const trimmed = messages.slice(-Math.floor(MAX_LOCAL * 0.8));
      try { localStorage.setItem(LS_PREFIX + peerId, JSON.stringify(trimmed)); }
      catch { /* give up */ }
    }
  }
}

/** Aggiunge un messaggio alla storia locale. */
export function appendToLocalHistory(peerId, msg) {
  const history = loadLocalHistory(peerId);
  history.push(msg);
  saveLocalHistory(peerId, history);
}

/**
 * Update fields of a local-history message identified by `localId`.
 * No-op if the message is not found.
 */
export function updateLocalHistoryById(peerId, localId, patch) {
  if (!localId) return;
  const history = loadLocalHistory(peerId);
  let changed = false;
  for (const msg of history) {
    if (msg.localId === localId) {
      Object.assign(msg, patch);
      changed = true;
      break;
    }
  }
  if (changed) saveLocalHistory(peerId, history);
}

/** Remove a local-history message identified by `localId`. */
export function removeFromLocalHistoryById(peerId, localId) {
  if (!localId) return;
  const history = loadLocalHistory(peerId);
  const filtered = history.filter(m => m.localId !== localId);
  if (filtered.length !== history.length) saveLocalHistory(peerId, filtered);
}

/** Tronca la storia locale a MAX_LOCAL. */
export function trimHistory(peerId) {
  const history = loadLocalHistory(peerId);
  if (history.length > MAX_LOCAL) {
    saveLocalHistory(peerId, history);
  }
}
