/**
 * contacts-store.js — Rubrica contatti: cache in memoria (sincrona) +
 * localStorage (fallback/bootstrap) + canister (fonte di verità,
 * cap-crud namespace "contacts").
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
 * Sync multi-device (0.3.4): il canister è la fonte di verità e il pull è
 * ESPLICITO. `pullContactsFromCanister(actor)` fa un pull-replace 1:1 (aggiunge
 * i nuovi, RIMUOVE quelli non più sul canister, aggiorna gli alias) ed è
 * cablato al bottone "Aggiorna contatti". Un device già popolato NON assorbe
 * automaticamente i cambi remoti al boot — solo il bottone. Le mutazioni locali
 * in volo sono tracciate (`_pending`) e attese prima di ogni pull, così un
 * add/remove/rename appena lanciato atterra sul canister PRIMA della lettura e
 * non viene annullato dal pull-replace (guardia race). Niente più tombstone: la
 * cancellazione si vede per davvero nel pull-replace, il workaround add-only è
 * morto con 0.3.4.
 *
 * `initContacts(actor)` va chiamata una volta dopo il login (come
 * initSounds/initCallBanner in main.js): mappa gli id dei record del canister
 * (per abilitare update/delete mirati), migra via i record v1 cifrati residui e
 * — solo su device nuovo (cache vuota) — allinea inbound al canister. Marca
 * l'import one-shot con `sm_contacts_imported_v2`.
 *
 * Formato record su cap-crud (namespace "contacts"): il blob è JSON in CHIARO
 * `{ v:2, canisterId, principalId, alias, muted }`. La rubrica NON è più
 * cifrata (0.3.4): la lista dei propri contatti non è un segreto che vale il
 * costo/complessità VetKeys, e il canister è già owner-gated. I record v1
 * (cifrati, versioni ≤0.3.3) sono illeggibili ora → la migrazione in
 * `initContacts` li cancella e ri-semina la rubrica dalla cache locale.
 */

const STORAGE_KEY = 'sm_contacts';
const IMPORTED_MARKER_KEY = 'sm_contacts_imported_v2';
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

// ─── Guardia race: mutazioni locali in volo ─────────────────────────────────
// Ogni scrittura verso il canister (create/update/delete) viene registrata qui
// finché non si risolve. `pullContactsFromCanister` le attende prima di leggere,
// così un add/remove appena lanciato non viene annullato da un pull-replace
// immediato (la mutazione atterra sul canister PRIMA della lettura).

const _pending = new Set();

/** Registra una mutazione in volo; si auto-rimuove quando si risolve. */
function _track(promise) {
  _pending.add(promise);
  const done = () => _pending.delete(promise);
  promise.then(done, done); // consuma anche il reject: nessun unhandled rejection qui
  return promise;
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
  _track(_createOnCanister(contact)).catch(e => console.warn('[contacts] create failed:', e.message));
  return true;
}

export function removeContact(canisterId) {
  const contacts = _ensureCache().filter(c => c.canisterId !== canisterId);
  _cache = contacts;
  _persist();
  const id = _idByCanister.get(canisterId);
  if (id !== undefined) {
    _idByCanister.delete(canisterId);
    _track(_deleteOnCanister(id)).catch(e => console.warn('[contacts] delete failed:', e.message));
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
  _track(_upsertOnCanister(c)).catch(e => console.warn('[contacts] update failed:', e.message));
}

// ─── Canister: codifica record (JSON in chiaro, v2) ──────────────────────────

let _actor = null;

/** Serializza un contatto nel blob v2 in chiaro salvato su cap-crud. */
function _encodeRecord(contact) {
  const outer = {
    v: 2,
    canisterId: contact.canisterId,
    principalId: contact.principalId,
    alias: contact.alias || '',
    muted: !!contact.muted,
  };
  return new TextEncoder().encode(JSON.stringify(outer));
}

/** Parsa il blob JSON di un record cap-crud. Ritorna l'oggetto grezzo (con `v`). */
function _decodeOuter(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
}

/** true se l'outer è un record contatto v2 valido (in chiaro). */
function _isValidV2(outer) {
  return outer && outer.v === 2 && !!outer.principalId && !!outer.canisterId;
}

// ─── Canister: scritture (best-effort, non bloccanti) ────────────────────────

async function _createOnCanister(contact) {
  if (!_actor) return;
  const data = _encodeRecord(contact);
  const result = await _actor.create_record({ namespace: NS, data });
  if (result.Err !== undefined) throw new Error(result.Err);
  _idByCanister.set(contact.canisterId, result.Ok.id);
}

async function _upsertOnCanister(contact) {
  if (!_actor) return;
  const id = _idByCanister.get(contact.canisterId);
  if (id === undefined) { await _createOnCanister(contact); return; }
  const data = _encodeRecord(contact);
  const result = await _actor.update_record(id, { data });
  if (result.Err !== undefined) throw new Error(result.Err);
}

async function _deleteOnCanister(id) {
  if (!_actor) return;
  const result = await _actor.delete_record(id);
  if (result.Err !== undefined) throw new Error(result.Err);
}

// ─── Hydration + migrazione v1→v2 + import one-shot ──────────────────────────

/** Invalida l'actor. Da chiamare al logout (identità cambia). */
export function resetContactsSession() {
  _actor = null;
}

/**
 * Da chiamare una volta dopo il login (actor col canister proprio già wired su
 * cap-crud). Al boot fa UNA lettura del canister (query gratis) per:
 *  - mappare canisterId→id di tutti i record v2 vivi (abilita update/delete
 *    mirati per le mutazioni di questa sessione — senza, una remove non saprebbe
 *    quale record cancellare);
 *  - migrare via i record v1 cifrati residui (illeggibili ora: li cancella).
 * NON assorbe inbound i cambi remoti su un device già popolato: quello è compito
 * del bottone "Aggiorna contatti" (pullContactsFromCanister). Solo su device
 * nuovo (cache locale vuota) allinea inbound al canister una volta.
 * Al primo avvio 0.3.4 (marker `_v2`) ri-semina outbound i contatti locali che
 * il canister non ha ancora (nati prima della rubrica-in-chiaro).
 * @param {object} actor
 */
export async function initContacts(actor) {
  _actor = actor;
  const contacts = _ensureCache();
  const firstRun = !localStorage.getItem(IMPORTED_MARKER_KEY);

  // Lettura unica al boot: mappa gli id + ripulisce i record v1 cifrati.
  try {
    const result = await actor.list_records(NS, 0n, BigInt(LIST_LIMIT));
    _idByCanister.clear();
    for (const rec of result.records) {
      let outer;
      try {
        outer = _decodeOuter(rec.data);
      } catch (e) {
        console.warn(`[contacts] outer parse failed for record ${rec.id}:`, e.message);
        continue;
      }
      if (!_isValidV2(outer)) {
        // Record v1 cifrato o malformato: illeggibile ora che la decifratura è
        // rimossa → cancellalo (best-effort). La rubrica si ri-semina dalla
        // cache locale via l'import one-shot sotto.
        try { await _deleteOnCanister(rec.id); }
        catch (e) { console.warn(`[contacts] v1 cleanup failed for record ${rec.id}:`, e.message); }
        continue;
      }
      // Mappa id per TUTTI i record v2 vivi (abilita update/delete futuri).
      // NIENTE merge inbound qui: un device popolato non assorbe i cambi remoti
      // automaticamente — solo il bottone (pull esplicito).
      _idByCanister.set(outer.canisterId, rec.id);
    }
  } catch (e) {
    console.warn('[contacts] hydration failed:', e.message);
    return;
  }

  // Import one-shot: spinge verso il canister i contatti locali pre-esistenti
  // (nati prima di 0.3.4 o rimasti solo in cache dopo la migrazione v1→v2, mai
  // visti dal canister in v2). Idempotente, gira su ogni dispositivo — il
  // marcatore si scrive solo se TUTTI gli import riescono, così un fallimento
  // parziale viene ritentato al prossimo avvio.
  if (firstRun) {
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

  // Device nuovo (cache locale vuota): allinea inbound al canister una volta.
  // Un device già popolato resta com'è finché non si preme "Aggiorna contatti".
  if (contacts.length === 0) {
    try { await pullContactsFromCanister(actor); }
    catch (e) { console.warn('[contacts] initial pull failed:', e.message); }
  }
}

// ─── Sync esplicito: pull-replace 1:1 dal canister ───────────────────────────

/**
 * Sync esplicito ("Aggiorna contatti"): allinea la cache locale allo stato del
 * canister (pull-replace 1:1). Aggiunge i contatti presenti sul canister e non
 * in locale, RIMUOVE quelli non più sul canister, aggiorna gli alias cambiati.
 * Attende prima le mutazioni locali in volo (guardia race) così un add/remove/
 * rename appena lanciato atterra sul canister PRIMA della lettura e non viene
 * annullato dal pull. Ritorna `{ added, removed, updated }`.
 * @param {object} [actor] default: l'actor già wired da initContacts
 */
export async function pullContactsFromCanister(actor) {
  const a = actor || _actor;
  if (!a) return { added: 0, removed: 0, updated: 0 };

  // Guardia race: le mutazioni locali non ancora propagate devono atterrare sul
  // canister prima di leggerlo, altrimenti il pull-replace le vedrebbe assenti.
  if (_pending.size) await Promise.allSettled([..._pending]);

  const result = await a.list_records(NS, 0n, BigInt(LIST_LIMIT));

  // Stato canister: solo record v2 validi. Rimappa gli id (fonte di verità).
  const remote = new Map(); // canisterId -> outer
  _idByCanister.clear();
  for (const rec of result.records) {
    let outer;
    try { outer = _decodeOuter(rec.data); }
    catch { continue; }
    if (!_isValidV2(outer)) continue; // salta v1/malformati (li ripulisce initContacts)
    _idByCanister.set(outer.canisterId, rec.id);
    remote.set(outer.canisterId, outer);
  }

  const contacts = _ensureCache();
  let added = 0, removed = 0, updated = 0;
  const next = [];

  // Tieni i locali ancora presenti sul canister; scarta gli altri (cancellati).
  for (const c of contacts) {
    if (remote.has(c.canisterId)) next.push(c);
    else removed++;
  }
  // Aggiorna alias dei presenti + aggiungi i nuovi arrivati dal canister.
  for (const [canisterId, outer] of remote) {
    const existing = next.find(c => c.canisterId === canisterId);
    if (existing) {
      if ((existing.alias || '') !== (outer.alias || '')) {
        existing.alias = outer.alias || '';
        updated++;
      }
    } else {
      next.push({
        canisterId,
        principalId: outer.principalId,
        alias: outer.alias || '',
        muted: !!outer.muted,
      });
      added++;
    }
  }

  _cache = next;
  _persist();
  return { added, removed, updated };
}
