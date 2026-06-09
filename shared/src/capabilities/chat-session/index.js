/**
 * Capability di orchestrazione: Chat Session
 *
 * Incapsula l'intero ciclo di vita di una conversazione peer-to-peer:
 * caricamento storia, sync da archivio, poll messaggi con dedup,
 * invio con notify, toggle persistenza, cleanup.
 *
 * La pagina fornisce i callback di rendering — la sessione gestisce lo stato.
 *
 * Uso:
 *   const session = await startChatSession({
 *     ownCid, peerCid, peerPid, senderPid,
 *     onMessage:     (from, text, time) => addMessageToUI(from, text, time),
 *     onSystem:      (text) => addSystemMessageToUI(text),
 *     onPersistence: (isPersistent) => updatePinButton(isPersistent),
 *   });
 *
 *   // La pagina chiama:
 *   session.send('ciao');
 *   session.togglePersist();
 *   session.isPersistent();
 *   session.stop();   // alla chiusura della pagina
 *
 * Capability atomiche usate:
 *   messaging (send/fetch/ack), history (localStorage),
 *   archive (persistence/sync), notify (clear pending cache)
 */

import { sendMessage, fetchMessages, ackMessages, clearPendingSender }
  from '../messaging/index.js';
import { loadLocalHistory, saveLocalHistory, appendToLocalHistory,
         updateLocalHistoryById, removeFromLocalHistoryById }
  from '../messaging/history.js';
import { MessagingError } from '../errors.js';
import { checkPersistence, togglePersistence, syncFromArchive, archiveInBackground }
  from '../archive/index.js';
import { removePendingFromCache }
  from '../notify/index.js';

const DEFAULT_POLL_MS = 3_000;

/**
 * Avvia una sessione chat con un peer.
 *
 * @param {{
 *   ownCid: string,          — proprio canister ID
 *   peerCid: string,         — canister del peer
 *   peerPid: string,         — principal del peer
 *   senderPid: string,       — proprio principal (per sendMessage)
 *   onMessage: (from: 'me'|'peer', text: string, time: string) => void,
 *   onSystem?: (text: string) => void,
 *   onPersistence?: (isPersistent: boolean) => void,
 *   pollMs?: number,         — intervallo poll (default 3000)
 * }} options
 *
 * @returns {Promise<{
 *   send: (text: string) => Promise<void>,
 *   togglePersist: () => Promise<void>,
 *   isPersistent: () => boolean,
 *   stop: () => void,
 * }>}
 */
export async function startChatSession(options) {
  const {
    ownCid,
    peerCid,
    peerPid,
    senderPid,
    onMessage,
    onSystem     = () => {},
    onPersistence = () => {},
    pollMs       = DEFAULT_POLL_MS,
  } = options;

  // ─── Stato interno ───────────────────────────────────────────────────────

  let pollTimer   = null;
  let isLoading   = false;
  let pendingRetry = false;
  let _isPersistent = false;
  const shownIds        = new Set();
  const shownTimestamps = new Set();

  // ─── Helper ──────────────────────────────────────────────────────────────

  function formatTime(timestampMs) {
    return new Date(timestampMs).toLocaleTimeString();
  }

  // ─── 1. Caricamento storia da localStorage ───────────────────────────────

  const localHistory = loadLocalHistory(peerPid);
  for (const msg of localHistory) {
    shownTimestamps.add(`${msg.from}:${msg.timestamp}`);
    onMessage(msg.from, msg.text, formatTime(msg.timestamp), {
      localId: msg.localId,
      status: msg.status || 'sent',
      errorCode: msg.errorCode,
    });
  }

  // ─── 2. Check persistenza + sync da archivio ────────────────────────────

  try {
    _isPersistent = await checkPersistence(ownCid, peerPid);
    onPersistence(_isPersistent);

    if (_isPersistent && localHistory.length === 0) {
      const records = await syncFromArchive(ownCid, peerPid);
      for (const r of records) {
        const dedupKey = `${r.from}:${r.timestamp}`;
        if (!shownTimestamps.has(dedupKey)) {
          shownTimestamps.add(dedupKey);
          onMessage(r.from, r.text, formatTime(r.timestamp));
        }
      }
      if (records.length > 0) saveLocalHistory(peerPid, records);
    }
  } catch (e) {
    console.warn('[chat-session] persistence check failed:', e);
  }

  // ─── 3. Poll messaggi ───────────────────────────────────────────────────

  async function loadNewMessages() {
    if (isLoading) { pendingRetry = true; return; }
    isLoading = true;
    pendingRetry = false;

    try {
      const msgs = await fetchMessages(peerCid);
      if (!msgs.length) return;

      const ids = [];
      const newRecords = [];
      for (const msg of msgs) {
        ids.push(msg.id);
        if (shownIds.has(msg.id)) continue;
        shownIds.add(msg.id);

        const dedupKey = `peer:${msg.timestampMs}`;
        if (!shownTimestamps.has(dedupKey)) {
          shownTimestamps.add(dedupKey);
          onMessage('peer', msg.text, formatTime(msg.timestampMs));

          const record = { from: 'peer', text: msg.text, timestamp: msg.timestampMs };
          appendToLocalHistory(peerPid, record);
          newRecords.push(record);
        }
      }

      await ackMessages(peerCid, ids);
      removePendingFromCache(peerPid);
      clearPendingSender(ownCid, peerPid).catch(() => {});

      if (_isPersistent && newRecords.length > 0) {
        archiveInBackground(ownCid, peerPid, newRecords);
      }
    } catch (err) {
      console.warn('[chat-session] poll error:', err);
    } finally {
      isLoading = false;
      if (pendingRetry) {
        pendingRetry = false;
        loadNewMessages();
      }
    }
  }

  // Prima fetch immediata, poi poll periodico
  loadNewMessages();
  pollTimer = setInterval(loadNewMessages, pollMs);

  // ─── Send (internal) ─────────────────────────────────────────────────────

  async function _sendInternal(text) {
    if (!text) return;

    const timestamp = Date.now();
    const localId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    shownTimestamps.add(`me:${timestamp}`);
    onMessage('me', text, formatTime(timestamp), { localId, status: 'sending' });

    const record = { from: 'me', text, timestamp, localId, status: 'sending' };
    appendToLocalHistory(peerPid, record);

    try {
      await sendMessage(ownCid, peerCid, peerPid, senderPid, text);
      updateLocalHistoryById(peerPid, localId, { status: 'sent', errorCode: null });
      onMessage('me', text, formatTime(timestamp), { localId, status: 'sent' });
      if (_isPersistent) archiveInBackground(ownCid, peerPid, [record]);
    } catch (err) {
      const code = err instanceof MessagingError ? err.code : 'unknown';
      updateLocalHistoryById(peerPid, localId, { status: 'failed', errorCode: code });
      onMessage('me', text, formatTime(timestamp), {
        localId, status: 'failed', errorCode: code, errorMessage: err.message,
      });
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    /**
     * Send a message to the peer.
     */
    async send(text) {
      return _sendInternal(text);
    },

    /**
     * Retry a previously failed message identified by its localId.
     */
    async retry(localId) {
      const history = loadLocalHistory(peerPid);
      const rec = history.find(m => m.localId === localId);
      if (!rec || rec.status !== 'failed') return;
      updateLocalHistoryById(peerPid, localId, { status: 'sending', errorCode: null });
      onMessage('me', rec.text, formatTime(rec.timestamp), { localId, status: 'sending' });
      try {
        await sendMessage(ownCid, peerCid, peerPid, senderPid, rec.text);
        updateLocalHistoryById(peerPid, localId, { status: 'sent', errorCode: null });
        onMessage('me', rec.text, formatTime(rec.timestamp), { localId, status: 'sent' });
        if (_isPersistent) archiveInBackground(ownCid, peerPid, [rec]);
      } catch (err) {
        const code = err instanceof MessagingError ? err.code : 'unknown';
        updateLocalHistoryById(peerPid, localId, { status: 'failed', errorCode: code });
        onMessage('me', rec.text, formatTime(rec.timestamp), {
          localId, status: 'failed', errorCode: code, errorMessage: err.message,
        });
      }
    },

    /**
     * Discard a failed local message.
     */
    discard(localId) {
      removeFromLocalHistoryById(peerPid, localId);
    },

    /**
     * Toggle persistenza (pin). Con pin ON, la storia viene
     * bulk-uploadata nel canister.
     */
    async togglePersist() {
      try {
        const newState = !_isPersistent;
        await togglePersistence(ownCid, peerPid, newState);
        _isPersistent = newState;
        onPersistence(_isPersistent);

        if (_isPersistent) {
          onSystem('Salvataggio cronologia nel canister...');
          const history = loadLocalHistory(peerPid);
          if (history.length > 0) {
            await archiveInBackground(ownCid, peerPid, history);
          }
          onSystem('Cronologia salvata nel canister.');
        }
      } catch (e) {
        onSystem(`Errore: ${e.message}`);
      }
    },

    /** Ritorna lo stato corrente di persistenza. */
    isPersistent() {
      return _isPersistent;
    },

    /** Ferma il poll e rilascia le risorse. Chiamare alla chiusura della pagina. */
    stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },
  };
}
