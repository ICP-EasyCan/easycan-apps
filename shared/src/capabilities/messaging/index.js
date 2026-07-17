/**
 * Capability: Messaging
 *
 * Invio/ricezione messaggi via outbox del canister.
 * I messaggi viaggiano in chiaro (plaintext UTF-8).
 * Il canister li vede in chiaro — cifrati solo in transito (HTTPS/TLS).
 *
 * TODO(E2EE): per aggiungere cifratura end-to-end con VetKeys:
 *   import { encryptPlaintext, decryptPlaintext, deriveConversationKey } from '../../core/crypto.js';
 *   In sendMessage: const key = await deriveConversationKey(ownCid, peerPid, call);
 *                   const bytes = Array.from(encryptPlaintext(new TextEncoder().encode(text), key));
 *   In fetchMessages: const key = await deriveConversationKey(peerCid, ..., query);
 *                     const text = new TextDecoder().decode(decryptPlaintext(payload, key));
 *
 * Exports:
 *   sendMessage(ownCid, peerCid, peerPid, senderPid, text)  → bigint (msgId assegnato)
 *   fetchMessages(peerCid)                                    → [{ id, text, timestampMs, edited }]
 *   ackMessages(peerCid, ids)                                 → void
 *   countMessages(peerCid)                                    → number
 *   clearPendingSender(ownCid, peerPid)                       → void
 *   deleteOwnMessage(ownCid, id)                              → void (throw se già consegnato)
 *   editOwnMessage(ownCid, id, text)                          → void (throw se già consegnato)
 *   pendingIdsFor(ownCid, peerId)                             → Set<bigint>
 *   clearOwnPendingFlag(peerCid, myPid)                       → void (best-effort, mai throw)
 *
 * Backend:
 *   leave_message (update), fetch_my_messages (query),
 *   ack_messages (update), count_my_messages (query),
 *   notify_pending_message (update), clear_pending_sender (update),
 *   delete_own_message (update), edit_own_message (update),
 *   pending_ids_for (query).
 */

import { call, query } from '../../core/icp.js';
import { MessagingError, classifyIcpError } from '../errors.js';

const TTL_7DAYS = 7n * 24n * 3600n;

// Flag per ritentare notify se fallita al primo messaggio
const _notifyPendingFlags = new Map(); // peerCid → boolean

/**
 * Invia un messaggio a un peer via canister outbox.
 * Se è il primo messaggio non letto, notifica il peer.
 *
 * @param {string} ownCid — canister dell'utente
 * @param {string} peerCid — canister del peer
 * @param {string} peerPid — principal del peer
 * @param {string} senderPid — principal del mittente
 * @param {string} text — testo del messaggio
 */
export async function sendMessage(ownCid, peerCid, peerPid, senderPid, text) {
  const { Principal } = await import('@dfinity/principal');
  const senderPrincipal = Principal.fromText(senderPid);
  const peerPrincipal = Principal.fromText(peerPid);

  // Pre-flight mutual contact check: does the peer have us in their whitelist?
  // Cheap query, fails fast, avoids leaving an undeliverable message in our outbox.
  try {
    const allowed = await query(peerCid, 'is_whitelisted', senderPrincipal);
    if (!allowed) {
      throw new MessagingError('not_in_whitelist',
        'The recipient has not added you to their contacts.');
    }
  } catch (err) {
    if (err instanceof MessagingError) throw err;
    throw new MessagingError('canister_unreachable',
      `Could not reach the recipient canister: ${err.message}`);
  }

  const bytes = Array.from(new TextEncoder().encode(text));

  let result;
  try {
    result = await call(ownCid, 'leave_message', peerPrincipal, bytes, TTL_7DAYS);
  } catch (err) {
    throw new MessagingError(classifyIcpError(err), err.message);
  }

  if (result?.Err) {
    throw new MessagingError('unknown', result.Err);
  }

  const msgId = result.Ok.id;

  // Notify on first message or if a previous notify failed
  const shouldNotify = result?.Ok?.is_first || _notifyPendingFlags.get(peerCid);
  if (shouldNotify) {
    try {
      await call(peerCid, 'notify_pending_message', senderPrincipal);
      _notifyPendingFlags.delete(peerCid);
    } catch (err) {
      // Notify failure after a successful write is not fatal — the message
      // is in our outbox and the peer can still pull it. Surface as warning,
      // schedule a retry on next send.
      _notifyPendingFlags.set(peerCid, true);
      const code = classifyIcpError(err);
      if (code === 'not_in_whitelist') {
        // Should not happen — pre-flight already checked. Race: peer removed us.
        throw new MessagingError('not_in_whitelist',
          'The recipient has just removed you from their contacts.');
      }
      console.warn('[messaging] notify failed:', err.message);
    }
  }

  return msgId;
}

/**
 * Fetch messaggi non letti dal canister di un peer.
 * @param {string} peerCid — canister del peer
 * @returns {Promise<Array<{ id: bigint, text: string, timestampMs: number }>>}
 */
export async function fetchMessages(peerCid) {
  const msgs = await query(peerCid, 'fetch_my_messages');
  const result = [];
  for (const msg of msgs) {
    const text = new TextDecoder().decode(new Uint8Array(msg.payload));
    const timestampMs = Number(msg.timestamp / 1_000_000n);
    const edited = Array.isArray(msg.edited) && msg.edited.length > 0 ? msg.edited[0] : false;
    result.push({ id: msg.id, text, timestampMs, edited });
  }
  return result;
}

/**
 * ACK messaggi letti (rimuove dall'outbox del peer).
 * @param {string} peerCid — canister del peer
 * @param {Array<bigint>} ids — ID dei messaggi da confermare
 */
export async function ackMessages(peerCid, ids) {
  await call(peerCid, 'ack_messages', ids);
}

/**
 * Conta messaggi non letti su un canister peer (query gratuita).
 * @param {string} peerCid — canister del peer
 * @returns {Promise<number>}
 */
export async function countMessages(peerCid) {
  const count = await query(peerCid, 'count_my_messages');
  return Number(count);
}

/**
 * Pulisce il sender dalla lista pending (dopo aver letto i messaggi).
 * @param {string} ownCid — proprio canister
 * @param {string} peerPid — principal del peer da rimuovere
 */
export async function clearPendingSender(ownCid, peerPid) {
  const { Principal } = await import('@dfinity/principal');
  await call(ownCid, 'clear_pending_sender', Principal.fromText(peerPid)).catch(() => {});
}

/**
 * Cancella un messaggio ancora nel proprio outbox ("elimina per tutti" — il
 * peer non lo vedrà mai). Fallisce se il messaggio è già stato consegnato/ackato.
 * @param {string} ownCid — proprio canister
 * @param {bigint} id — id del messaggio nell'outbox
 */
export async function deleteOwnMessage(ownCid, id) {
  let result;
  try {
    result = await call(ownCid, 'delete_own_message', id);
  } catch (err) {
    throw new MessagingError(classifyIcpError(err), err.message);
  }
  if (result?.Err) throw new MessagingError('unknown', result.Err);
}

/**
 * Sovrascrive il payload di un messaggio ancora nel proprio outbox.
 * Fallisce se già consegnato/ackato (stessa condizione di deleteOwnMessage).
 * @param {string} ownCid — proprio canister
 * @param {bigint} id — id del messaggio nell'outbox
 * @param {string} text — nuovo testo
 */
export async function editOwnMessage(ownCid, id, text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let result;
  try {
    result = await call(ownCid, 'edit_own_message', id, bytes);
  } catch (err) {
    throw new MessagingError(classifyIcpError(err), err.message);
  }
  if (result?.Err) throw new MessagingError('unknown', result.Err);
}

/**
 * Id dei messaggi ancora nel proprio outbox verso un peer (non ancora
 * consegnati/ackati). Pilota le spunte ✓/✓✓ e abilita/disabilita modifica
 * ed elimina-per-tutti.
 * @param {string} ownCid — proprio canister
 * @param {string} peerId — principal del peer
 * @returns {Promise<Set<bigint>>}
 */
export async function pendingIdsFor(ownCid, peerId) {
  const { Principal } = await import('@dfinity/principal');
  const ids = await query(ownCid, 'pending_ids_for', Principal.fromText(peerId));
  return new Set(ids);
}

/**
 * Self-clear: spegne sul canister del peer il flag di notifica che si è
 * acceso da sé (mai quello di un altro mittente — il canister lo impone).
 * Best-effort: se la chiamata cross-canister fallisce il peer si
 * auto-guarisce al prossimo poll (fetch a vuoto).
 * @param {string} peerCid — canister del peer (dove vive il flag da spegnere)
 * @param {string} myPid — proprio principal (il sender che ha acceso il flag)
 */
export async function clearOwnPendingFlag(peerCid, myPid) {
  const { Principal } = await import('@dfinity/principal');
  await call(peerCid, 'clear_pending_sender', Principal.fromText(myPid)).catch(() => {});
}
