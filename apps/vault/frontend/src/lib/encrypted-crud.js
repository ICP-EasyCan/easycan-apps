/**
 * encrypted-crud.js — Encrypted CRUD wrapper per Sovereign Vault.
 *
 * Wrappa create/get/list/update/delete del canister cifrando/decifrando i record
 * con il modulo condiviso `@shared/core/crypto.js` (VetKeys + AES-GCM envelope v1).
 * Pattern dataId: `namespace = dataId` (una chiave per categoria).
 */

import { getActorFor } from '@shared/core/icp.js';
import { CANISTER_ID } from '@shared/core/config.js';
import { deriveKey, encryptString, decryptString } from '@shared/core/crypto.js';

const CTX = 'vault';

async function keyFor(actor, namespace) {
  return deriveKey(actor, CTX, { type: 'stored', dataId: namespace });
}

function toBytes(data) {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export async function createEncryptedRecord(namespace, data) {
  const actor = await getActorFor(CANISTER_ID);
  const key = await keyFor(actor, namespace);
  const ct = await encryptString(JSON.stringify(data), key);
  const result = await actor.create_record({ namespace, data: ct });
  if (result.Err !== undefined) throw new Error(result.Err);
  const rec = result.Ok ?? result;
  return { ...rec, data };
}

export async function getEncryptedRecord(namespace, id) {
  const actor = await getActorFor(CANISTER_ID);
  const result = await actor.get_record(BigInt(id));
  if (!result || result.length === 0) return null;
  const rec = result[0] ?? result;
  try {
    const key = await keyFor(actor, namespace);
    const json = await decryptString(toBytes(rec.data), key);
    return { ...rec, data: JSON.parse(json) };
  } catch (e) {
    console.error(`Decrypt failed for record ${id}:`, e);
    return { ...rec, data: null };
  }
}

export async function listEncryptedRecords(namespace, offset = 0, limit = 50) {
  const actor = await getActorFor(CANISTER_ID);
  const result = await actor.list_records(namespace, BigInt(offset), BigInt(limit));
  const total = Number(result.total || 0);
  const records = [];
  if ((result.records || []).length > 0) {
    const key = await keyFor(actor, namespace);
    for (const rec of result.records) {
      try {
        const json = await decryptString(toBytes(rec.data), key);
        records.push({ ...rec, data: JSON.parse(json) });
      } catch (e) {
        console.error(`Decrypt failed for record ${rec.id}:`, e);
        records.push({ ...rec, data: null });
      }
    }
  }
  return { records, total };
}

export async function updateEncryptedRecord(namespace, id, data) {
  const actor = await getActorFor(CANISTER_ID);
  const key = await keyFor(actor, namespace);
  const ct = await encryptString(JSON.stringify(data), key);
  const result = await actor.update_record(BigInt(id), { data: ct });
  if (result.Err !== undefined) throw new Error(result.Err);
  const rec = result.Ok ?? result;
  return { ...rec, data };
}

export async function deleteEncryptedRecord(id) {
  const actor = await getActorFor(CANISTER_ID);
  const result = await actor.delete_record(BigInt(id));
  if (result.Err !== undefined) throw new Error(result.Err);
}

export async function countEncryptedRecords(namespace) {
  const actor = await getActorFor(CANISTER_ID);
  const result = await actor.count_records(namespace);
  return Number(result);
}
