/**
 * Capability: Archive
 *
 * Persistenza messaggi nel canister (toggle per chat).
 * Con pin ON, i messaggi vengono salvati nel proprio canister e sopravvivono
 * al cambio browser/dispositivo.
 *
 * Exports:
 *   checkPersistence(ownCid, peerId)                 → boolean
 *   togglePersistence(ownCid, peerId, persistent)     → void
 *   syncFromArchive(ownCid, peerId)                   → [{ from, text, timestamp }]
 *   archiveInBackground(ownCid, peerId, records)      → void
 *   getAllPersistentChats(ownCid)                      → [principalId]
 *
 * Backend:
 *   is_chat_persistent (query), set_chat_persistent (update),
 *   get_archived_messages (query), archive_messages (update),
 *   get_all_persistent_chats (query).
 */

import { call, query } from '../../core/icp.js';
// TODO(E2EE): quando VetKeys sarà implementato, importare decrypt da crypto.js
// e decifrare msg.payload prima del decode UTF-8.

const MAX_BATCH = 100;

/**
 * Verifica se una chat è persistente.
 * @param {string} ownCid — proprio canister
 * @param {string} peerId — principal del peer
 * @returns {Promise<boolean>}
 */
export async function checkPersistence(ownCid, peerId) {
  const { Principal } = await import('@dfinity/principal');
  return query(ownCid, 'is_chat_persistent', Principal.fromText(peerId));
}

/**
 * Attiva/disattiva persistenza per una chat.
 * @param {string} ownCid — proprio canister
 * @param {string} peerId — principal del peer
 * @param {boolean} persistent — stato desiderato
 */
export async function togglePersistence(ownCid, peerId, persistent) {
  const { Principal } = await import('@dfinity/principal');
  const result = await call(ownCid, 'set_chat_persistent',
    Principal.fromText(peerId), persistent);
  if (result?.Err) throw new Error(result.Err);
}

/**
 * Scarica la cronologia dal canister (query gratuita).
 * @param {string} ownCid — proprio canister
 * @param {string} peerId — principal del peer
 * @returns {Promise<Array<{ from: string, text: string, timestamp: number }>>}
 */
export async function syncFromArchive(ownCid, peerId) {
  const { Principal } = await import('@dfinity/principal');
  const archived = await query(ownCid, 'get_archived_messages',
    Principal.fromText(peerId));

  const records = [];
  for (const msg of archived) {
    const text = new TextDecoder().decode(new Uint8Array(msg.payload));
    const timestampMs = Number(msg.timestamp / 1_000_000n);
    const from = msg.from_me ? 'me' : 'peer';
    records.push({ from, text, timestamp: timestampMs });
  }
  return records;
}

/**
 * Archivia messaggi nel canister in background (fire-and-forget).
 * Divide in batch da MAX_BATCH.
 *
 * @param {string} ownCid — proprio canister
 * @param {string} peerId — principal del peer
 * @param {Array<{ from: string, text: string, timestamp: number }>} records
 */
export async function archiveInBackground(ownCid, peerId, records) {
  try {
    const { Principal } = await import('@dfinity/principal');
    const peer = Principal.fromText(peerId);

    for (let i = 0; i < records.length; i += MAX_BATCH) {
      const batch = records.slice(i, i + MAX_BATCH);
      const inputs = batch.map(r => ({
        from_me: r.from === 'me',
        payload: Array.from(new TextEncoder().encode(r.text)),
        timestamp: BigInt(r.timestamp) * 1_000_000n,
      }));
      await call(ownCid, 'archive_messages', peer, inputs);
    }
  } catch (e) {
    console.warn('[archive] background save failed:', e);
  }
}

/**
 * Lista di tutte le chat con persistenza attiva.
 * @param {string} ownCid — proprio canister
 * @returns {Promise<string[]>} — lista di principal ID
 */
export async function getAllPersistentChats(ownCid) {
  const principals = await query(ownCid, 'get_all_persistent_chats');
  return principals.map(p => p.toString());
}
