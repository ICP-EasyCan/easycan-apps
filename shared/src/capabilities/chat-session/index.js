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
 *   session.editMessage(localId, 'nuovo testo');   // solo se ancora pendente
 *   session.deleteMessage(localId);                // per tutti (pendente) o per me (consegnato)
 *   session.togglePersist();
 *   session.isPersistent();
 *   session.stop();   // alla chiusura della pagina
 *
 * Capability atomiche usate:
 *   messaging (send/fetch/ack/delete/edit/pending), history (localStorage),
 *   archive (persistence/sync/delete), notify (clear pending cache)
 */

import { sendMessage, fetchMessages, ackMessages, clearPendingSender,
         deleteOwnMessage, editOwnMessage, pendingIdsFor, clearOwnPendingFlag }
  from '../messaging/index.js';
import { loadLocalHistory, saveLocalHistory, appendToLocalHistory,
         updateLocalHistoryById, removeFromLocalHistoryById }
  from '../messaging/history.js';
import { MessagingError } from '../errors.js';
import { checkPersistence, togglePersistence, syncFromArchive, archiveInBackground,
         deleteArchivedMessage, ARCHIVE_MAX_PER_PEER }
  from '../archive/index.js';
import { removePendingFromCache }
  from '../notify/index.js';

const DEFAULT_POLL_MS = 3_000;
// Deve restare in sync con TTL_7DAYS di ../messaging/index.js (secondi → ms qui).
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

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
  // false finché la prima fetch non è completata: i messaggi di quel primo
  // drain erano già pendenti all'apertura (l'utente è già stato notificato)
  // → meta.live = false, non devono ri-suonare. Da lì in poi live = true.
  let firstFetchDone = false;
  const shownIds        = new Set();
  const shownTimestamps = new Set();
  // localId → { msgId, timestamp, text } — messaggi propri ancora nel proprio
  // outbox (non consegnati/ackati), in attesa di refreshDelivery().
  const pendingDeliveries = new Map();

  // ─── Helper ──────────────────────────────────────────────────────────────

  function formatTime(timestampMs) {
    return new Date(timestampMs).toLocaleTimeString();
  }

  // ─── 1. Caricamento storia da localStorage ───────────────────────────────

  const localHistory = loadLocalHistory(peerPid);
  let historyMigrated = false;
  for (const msg of localHistory) {
    // Dati pre-F4: i messaggi del peer non avevano localId (necessario ora
    // per elimina-per-me). Migrazione one-shot in memoria + persistita sotto.
    if (msg.from === 'peer' && !msg.localId) {
      msg.localId = `peer-legacy-${msg.timestamp}-${Math.random().toString(36).slice(2, 6)}`;
      historyMigrated = true;
    }

    shownTimestamps.add(`${msg.from}:${msg.timestamp}`);

    const meta = {
      localId: msg.localId,
      status: msg.status || 'sent',
      errorCode: msg.errorCode,
      edited: !!msg.edited,
    };
    if (msg.from === 'me' && meta.status !== 'failed' && meta.status !== 'sending') {
      // Dati pre-F4 senza campo delivery: si assume consegnato (nessun modo
      // di saperlo retroattivamente, ed è comunque il caso comune).
      meta.delivery = msg.delivery || 'delivered';
      meta.msgId = msg.msgId;
      if (meta.delivery === 'pending' && msg.msgId) {
        pendingDeliveries.set(msg.localId, {
          msgId: msg.msgId, timestamp: msg.timestamp, text: msg.text, edited: !!msg.edited,
        });
      }
    }
    onMessage(msg.from, msg.text, formatTime(msg.timestamp), meta);
  }
  if (historyMigrated) saveLocalHistory(peerPid, localHistory);

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
          // Sincronizzati da un altro dispositivo: nessun localId noto, se ne
          // genera uno stabile per abilitare elimina-per-me. Sono per
          // definizione già consegnati (arrivano dall'archivio).
          r.localId = `sync-${r.from}-${r.timestamp}`;
          const meta = { localId: r.localId };
          if (r.from === 'me') meta.delivery = 'delivered';
          onMessage(r.from, r.text, formatTime(r.timestamp), meta);
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
      const live = firstFetchDone;
      firstFetchDone = true;
      if (msgs.length) {
        const ids = [];
        const newRecords = [];
        for (const msg of msgs) {
          ids.push(msg.id);
          if (shownIds.has(msg.id)) continue;
          shownIds.add(msg.id);

          const dedupKey = `peer:${msg.timestampMs}`;
          if (!shownTimestamps.has(dedupKey)) {
            shownTimestamps.add(dedupKey);
            const localId = `peer-${msg.id}`;
            onMessage('peer', msg.text, formatTime(msg.timestampMs), { localId, edited: msg.edited, live });

            const record = { from: 'peer', text: msg.text, timestamp: msg.timestampMs, localId, edited: msg.edited };
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
      }

      await refreshDelivery();
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

  // ─── ✓/✓✓: stato di consegna dei propri messaggi ────────────────────────

  /**
   * Aggiorna lo stato dei propri messaggi ancora tracciati come pendenti:
   * un id sparito da pending_ids_for è consegnato — o scaduto (TTL 7gg, il
   * backend non li distingue, cfr. piano F4 §caveat) — calcolato qui lato
   * client dal timestamp.
   */
  async function refreshDelivery() {
    if (pendingDeliveries.size === 0) return;
    let pendingIds;
    try {
      pendingIds = await pendingIdsFor(ownCid, peerPid);
    } catch (e) {
      console.warn('[chat-session] pending_ids_for failed:', e);
      return;
    }
    for (const [localId, info] of Array.from(pendingDeliveries.entries())) {
      if (pendingIds.has(BigInt(info.msgId))) continue; // ancora pendente
      const expired = (Date.now() - info.timestamp) > SEVEN_DAYS_MS;
      const delivery = expired ? 'expired' : 'delivered';
      updateLocalHistoryById(peerPid, localId, { delivery });
      onMessage('me', info.text, formatTime(info.timestamp), {
        localId, status: 'sent', delivery, msgId: info.msgId, edited: info.edited,
      });
      pendingDeliveries.delete(localId);
    }
  }

  // Prima fetch immediata, poi poll periodico
  loadNewMessages();
  pollTimer = setInterval(loadNewMessages, pollMs);

  // Re-poll immediato al ritorno visibile (i timer sono throttlati/congelati
  // a pagina nascosta sui browser mobile). Rimosso in stop().
  const visListener = () => {
    if (document.visibilityState === 'visible' && pollTimer) loadNewMessages();
  };
  document.addEventListener('visibilitychange', visListener);

  // ─── Send (internal) ─────────────────────────────────────────────────────

  /** Bookkeeping comune post-invio riuscito (send + retry): traccia il
   * messaggio come pendente finché refreshDelivery() non lo vede consegnato. */
  function _trackSent(localId, timestamp, text, record, msgId) {
    const msgIdStr = msgId.toString();
    updateLocalHistoryById(peerPid, localId, { status: 'sent', errorCode: null, msgId: msgIdStr, delivery: 'pending' });
    onMessage('me', text, formatTime(timestamp), { localId, status: 'sent', delivery: 'pending', msgId: msgIdStr });
    pendingDeliveries.set(localId, { msgId: msgIdStr, timestamp, text, edited: false });
    if (_isPersistent) archiveInBackground(ownCid, peerPid, [record]);
  }

  async function _sendInternal(text) {
    if (!text) return;

    const timestamp = Date.now();
    const localId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    shownTimestamps.add(`me:${timestamp}`);
    onMessage('me', text, formatTime(timestamp), { localId, status: 'sending' });

    const record = { from: 'me', text, timestamp, localId, status: 'sending' };
    appendToLocalHistory(peerPid, record);

    try {
      const msgId = await sendMessage(ownCid, peerCid, peerPid, senderPid, text);
      _trackSent(localId, timestamp, text, record, msgId);
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
        const msgId = await sendMessage(ownCid, peerCid, peerPid, senderPid, rec.text);
        _trackSent(localId, rec.timestamp, rec.text, rec, msgId);
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
     * Elimina un messaggio:
     * - se è un mio messaggio ancora pendente (delivery === 'pending') →
     *   "elimina per tutti" (delete_own_message + self-clear best-effort
     *   del proprio flag sul canister del peer, se non restano altri
     *   pendenti verso di lui);
     * - altrimenti (mio già consegnato/scaduto, o del peer) → "elimina per
     *   me": rimozione locale + dal proprio archivio se la persistenza è
     *   attiva. Non tocca mai il canister del peer.
     * @returns {Promise<boolean>} false = elimina-per-tutti fallito (id già
     *   consegnato nel frattempo), il messaggio resta visibile.
     */
    async deleteMessage(localId) {
      const history = loadLocalHistory(peerPid);
      const rec = history.find(m => m.localId === localId);
      if (!rec) return false;

      if (rec.from === 'me' && rec.delivery === 'pending' && rec.msgId) {
        try {
          await deleteOwnMessage(ownCid, BigInt(rec.msgId));
        } catch (err) {
          onSystem(`Could not delete: ${err.message}`);
          return false;
        }
        pendingDeliveries.delete(localId);
        try {
          const stillPending = await pendingIdsFor(ownCid, peerPid);
          if (stillPending.size === 0) await clearOwnPendingFlag(peerCid, senderPid);
        } catch {
          // best-effort — il peer si auto-guarisce al prossimo poll a vuoto
        }
      } else if (_isPersistent) {
        try {
          await deleteArchivedMessage(ownCid, peerPid, rec.from === 'me', rec.timestamp);
        } catch (e) {
          console.warn('[chat-session] archive delete failed:', e);
        }
      }

      removeFromLocalHistoryById(peerPid, localId);
      return true;
    },

    /**
     * Modifica un mio messaggio ancora pendente (mai se già consegnato).
     * @returns {Promise<boolean>} false se non modificabile o se fallita.
     */
    async editMessage(localId, newText) {
      if (!newText) return false;
      const history = loadLocalHistory(peerPid);
      const rec = history.find(m => m.localId === localId);
      if (!rec || rec.from !== 'me' || rec.delivery !== 'pending' || !rec.msgId) return false;

      try {
        await editOwnMessage(ownCid, BigInt(rec.msgId), newText);
      } catch (err) {
        onSystem(`Could not edit: ${err.message}`);
        return false;
      }

      updateLocalHistoryById(peerPid, localId, { text: newText, edited: true });
      const tracked = pendingDeliveries.get(localId);
      if (tracked) { tracked.text = newText; tracked.edited = true; }
      onMessage('me', newText, formatTime(rec.timestamp), {
        localId, status: 'sent', delivery: 'pending', msgId: rec.msgId, edited: true,
      });
      return true;
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
          const history = loadLocalHistory(peerPid);
          if (history.length > ARCHIVE_MAX_PER_PEER) {
            onSystem(`Only the most recent ${ARCHIVE_MAX_PER_PEER} messages will be kept in your canister.`);
          }
          onSystem('Saving history to your canister…');
          if (history.length > 0) {
            await archiveInBackground(ownCid, peerPid, history);
          }
          onSystem('History saved to your canister.');
        }
      } catch (e) {
        onSystem(`Error: ${e.message}`);
      }
    },

    /** Ritorna lo stato corrente di persistenza. */
    isPersistent() {
      return _isPersistent;
    },

    /** Ferma il poll e rilascia le risorse. Chiamare alla chiusura della pagina. */
    stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      document.removeEventListener('visibilitychange', visListener);
    },
  };
}
