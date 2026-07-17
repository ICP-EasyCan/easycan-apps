/**
 * contacts-store.js — Rubrica contatti: cache in memoria (sincrona) +
 * localStorage (fallback/bootstrap) + canister cifrato (fonte di verità,
 * cap-crud namespace "contacts") come da piano F2.
 *
 * Le API pubbliche restano TUTTE sincrone (stessa firma di prima): sono
 * consumate da 5 call-site (chat.js, add-contact.js, contacts.js, chats.js,
 * call-banner.js) che non possono diventare async. Le letture leggono la
 * cache in memoria; le mutazioni aggiornano subito cache+localStorage (UI
 * reattiva) e propagano al canister in background, best-effort. Ogni
 * mutazione DEVE passare dai mutatori qui sotto (addContact/removeContact/
 * updateContactAlias) — scrivere la lista per intero bypasserebbe la
 * propagazione al canister.
 *
 * Le cancellazioni fallite (canister irraggiungibile, id remoto non ancora
 * noto) lasciano una tombstone locale (`sm_contacts_tombstones`): alla
 * prossima idratazione il record remoto corrispondente viene cancellato
 * invece di essere ri-fuso in locale — senza, un contatto rimosso
 * "risorgerebbe" al riavvio successivo.
 *
 * `initContacts(actor)` va chiamata una volta dopo il login (come
 * initSounds/initCallBanner in main.js): deriva la chiave VetKeys, scarica
 * e decifra la rubrica dal canister, la fonde con quella locale (unione per
 * canisterId, mai overwrite — gira su ogni dispositivo) e marca l'import
 * come fatto con `sm_contacts_imported_v1`.
 *
 * Formato record su cap-crud (namespace "contacts"): il blob è JSON
 * `{ v:1, canisterId:"<in chiaro>", envelope:"<base64 di encryptString>" }`
 * dove l'envelope cifra `JSON.stringify({ principalId, alias, muted })`.
 * Il canisterId resta in chiaro (merge idempotente, D5) — il dato privato
 * vero è nell'envelope.
 */

import { deriveKey, encryptString, decryptString } from '@shared/core/crypto.js';

const STORAGE_KEY = 'sm_contacts';
const IMPORTED_MARKER_KEY = 'sm_contacts_imported_v1';
const TOMBSTONES_KEY = 'sm_contacts_tombstones';
const CTX = 'messenger';
const NS = 'contacts';
const LIST_LIMIT = 1000;

// ─── Cache in memoria ────────────────────────────────────────────────────────

let _cache = null; // Array<{ canisterId, principalId, alias, muted }>
const _idByCanister = new Map(); // canisterId -> id numerico cap-crud

function _readLocalStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function _ensureCache() {
  if (_cache === null) _cache = _readLocalStorage();
  return _cache;
}

function _persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
}

// ─── Tombstones (cancellazioni pendenti verso il canister) ──────────────────

function _readTombstones() {
  try {
    return JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '[]');
  } catch { return []; }
}

function _writeTombstones(list) {
  if (list.length) localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(list));
  else localStorage.removeItem(TOMBSTONES_KEY);
}

function _addTombstone(canisterId) {
  const t = _readTombstones();
  if (!t.includes(canisterId)) { t.push(canisterId); _writeTombstones(t); }
}

function _removeTombstone(canisterId) {
  _writeTombstones(_readTombstones().filter(c => c !== canisterId));
}

// ─── Base64 (per l'envelope binario dentro il blob JSON) ────────────────────

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ─── API sincrone (firme invariate) ──────────────────────────────────────────

export function loadContacts() {
  return _ensureCache();
}

export function addContact(canisterId, principalId, alias = '') {
  const contacts = _ensureCache();
  if (contacts.some(c => c.canisterId === canisterId)) return false;
  const contact = { canisterId, principalId, alias, muted: false };
  contacts.push(contact);
  _persist();
  _removeTombstone(canisterId); // ri-aggiunto dopo una rimozione: la delete pendente non deve più applicarsi
  _createOnCanister(contact).catch(e => console.warn('[contacts] create failed:', e.message));
  return true;
}

export function removeContact(canisterId) {
  const contacts = _ensureCache().filter(c => c.canisterId !== canisterId);
  _cache = contacts;
  _persist();
  _addTombstone(canisterId);
  const id = _idByCanister.get(canisterId);
  if (id !== undefined) {
    _idByCanister.delete(canisterId);
    _deleteOnCanister(id)
      .then(() => _removeTombstone(canisterId))
      .catch(e => console.warn('[contacts] delete failed:', e.message));
  }
}

export function getContactAlias(canisterId) {
  const c = _ensureCache().find(c => c.canisterId === canisterId);
  return c?.alias || '';
}

export function updateContactAlias(canisterId, alias) {
  const contacts = _ensureCache();
  const c = contacts.find(c => c.canisterId === canisterId);
  if (!c) return;
  c.alias = alias;
  _persist();
  _upsertOnCanister(c).catch(e => console.warn('[contacts] update failed:', e.message));
}

// ─── Canister: chiave + codifica record ──────────────────────────────────────

let _actor = null;
let _keyPromise = null;

function _keyFor(actor) {
  if (!_keyPromise) _keyPromise = deriveKey(actor, CTX, { type: 'stored', dataId: NS });
  return _keyPromise;
}

async function _encodeRecord(actor, contact) {
  const key = await _keyFor(actor);
  const inner = JSON.stringify({
    principalId: contact.principalId,
    alias: contact.alias || '',
    muted: !!contact.muted,
  });
  const envelope = await encryptString(inner, key);
  const outer = { v: 1, canisterId: contact.canisterId, envelope: toB64(envelope) };
  return new TextEncoder().encode(JSON.stringify(outer));
}

async function _decodeRecord(actor, bytes) {
  const outer = JSON.parse(new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  const key = await _keyFor(actor);
  const inner = JSON.parse(await decryptString(fromB64(outer.envelope), key));
  return {
    canisterId: outer.canisterId,
    principalId: inner.principalId,
    alias: inner.alias || '',
    muted: !!inner.muted,
  };
}

// ─── Canister: scritture (best-effort, non bloccanti) ────────────────────────

async function _createOnCanister(contact) {
  if (!_actor) return;
  const data = await _encodeRecord(_actor, contact);
  const result = await _actor.create_record({ namespace: NS, data });
  if (result.Err !== undefined) throw new Error(result.Err);
  _idByCanister.set(contact.canisterId, result.Ok.id);
}

async function _upsertOnCanister(contact) {
  if (!_actor) return;
  const id = _idByCanister.get(contact.canisterId);
  if (id === undefined) { await _createOnCanister(contact); return; }
  const data = await _encodeRecord(_actor, contact);
  const result = await _actor.update_record(id, { data });
  if (result.Err !== undefined) throw new Error(result.Err);
}

async function _deleteOnCanister(id) {
  if (!_actor) return;
  const result = await _actor.delete_record(id);
  if (result.Err !== undefined) throw new Error(result.Err);
}

// ─── Hydration + import one-shot (D5) ────────────────────────────────────────

/** Invalida actor + chiave derivata. Da chiamare al logout (identità cambia). */
export function resetContactsSession() {
  _actor = null;
  _keyPromise = null;
}

/**
 * Da chiamare una volta dopo il login (actor col canister proprio già wired
 * su cap-crud + cap-crypto). Idrata la cache dal canister e, al primo avvio
 * su QUESTO dispositivo, fonde i contatti locali pre-esistenti verso il
 * canister (unione per canisterId, mai overwrite).
 * @param {object} actor
 */
export async function initContacts(actor) {
  _actor = actor;
  const contacts = _ensureCache();

  let remoteContacts = [];
  const tombstones = _readTombstones();
  try {
    const result = await actor.list_records(NS, 0n, BigInt(LIST_LIMIT));
    for (const rec of result.records) {
      try {
        const decoded = await _decodeRecord(actor, rec.data);
        if (tombstones.includes(decoded.canisterId)) {
          // Rimosso su questo dispositivo con delete remota fallita: applica ora.
          try {
            await _deleteOnCanister(rec.id);
            _removeTombstone(decoded.canisterId);
          } catch (e) {
            console.warn(`[contacts] tombstone delete failed for ${decoded.canisterId}:`, e.message);
          }
          continue;
        }
        remoteContacts.push(decoded);
        _idByCanister.set(decoded.canisterId, rec.id);
      } catch (e) {
        console.warn(`[contacts] decrypt failed for record ${rec.id}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[contacts] hydration failed:', e.message);
    return;
  }

  // Unione canister → locale: aggiunge solo i contatti mancanti, mai overwrite.
  let changed = false;
  for (const rc of remoteContacts) {
    if (!contacts.some(c => c.canisterId === rc.canisterId)) {
      contacts.push(rc);
      changed = true;
    }
  }
  if (changed) _persist();

  // Import one-shot: spinge verso il canister i contatti locali pre-esistenti
  // (nati prima di F2, mai visti dal canister). Idempotente, gira su ogni
  // dispositivo — il marcatore si scrive solo se TUTTI gli import riescono,
  // così un fallimento parziale viene ritentato al prossimo avvio.
  if (!localStorage.getItem(IMPORTED_MARKER_KEY)) {
    let allOk = true;
    for (const c of contacts) {
      if (!_idByCanister.has(c.canisterId)) {
        try { await _createOnCanister(c); }
        catch (e) {
          allOk = false;
          console.warn(`[contacts] import failed for ${c.canisterId}:`, e.message);
        }
      }
    }
    if (allOk) localStorage.setItem(IMPORTED_MARKER_KEY, '1');
  }
}
