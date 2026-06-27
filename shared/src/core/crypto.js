/**
 * crypto.js — modulo E2EE production (VetKeys + AES-GCM, envelope versionato).
 *
 * Richiede che il canister host wrappi cap-crypto con 2 update functions:
 *   get_verification_key(context_name: text)
 *     -> Result<text, text>  (hex DerivedPublicKey BLS12-381 G2)
 *   derive_encrypted_key(context_name: text,
 *                        derivation: DerivationContext,
 *                        transport_public_key: blob)
 *     -> Result<text, text>  (hex EncryptedVetKey)
 *
 * Il canister conosce già il caller via `core_auth::user_principal()` e calcola
 * `owner` da solo: l'IDL JS NON passa `owner`. Lato client costruiamo lo stesso
 * `input` di `cap_crypto::derivation_input` per `EncryptedVetKey.decryptAndVerify`.
 * Se i due input divergono di anche un solo byte, decryptAndVerify fallisce.
 *
 * Envelope: [version:1 | nonce:12 | ciphertext+tag]
 * version=1 = AES-GCM-256 con nonce random 96-bit.
 * Limiti noti v1: nessun AAD, nessuna key rotation, nessuna migrazione
 * plaintext→E2EE (un solo path, nessun fallback).
 */

import { Actor } from '@dfinity/agent';
import { TransportSecretKey, DerivedPublicKey, EncryptedVetKey } from '@dfinity/vetkeys';

// ─── Costanti envelope ───────────────────────────────────────────────────────
const VERSION_V1 = 0x01;
const NONCE_LEN = 12;
const ENVELOPE_HEADER_LEN = 1 + NONCE_LEN;
const GCM_TAG_LEN = 16;
const AES_KEY_LEN_BITS = 256;
const AES_KEY_LEN_BYTES = 32;

/** @typedef {import('@dfinity/principal').Principal} Principal */
/**
 * @typedef {{ type: 'peer',   peer: Principal }
 *         | { type: 'stored', dataId: string }
 *         | { type: 'custom', context: Uint8Array }} Derivation
 */

// ─── Cache chiavi derivate (per sessione) ────────────────────────────────────
/** @type {Map<string, Promise<CryptoKey>>} */
const _keyCache = new Map();

function cacheKey(contextName, derivation, selfText) {
  switch (derivation.type) {
    case 'peer':   return `${contextName}|${selfText}|peer|${derivation.peer.toText()}`;
    case 'stored': return `${contextName}|${selfText}|stored|${derivation.dataId}`;
    case 'custom': return `${contextName}|${selfText}|custom|${hex(derivation.context)}`;
    default: throw new Error(`crypto: unknown derivation type ${derivation?.type}`);
  }
}

/** Svuota la cache chiavi. Chiamare a logout. */
export function clearKeyCache() {
  _keyCache.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(s) {
  if (s.length % 2 !== 0) throw new Error('crypto: invalid hex length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  return out;
}

// Lex byte compare — replica Principal Ord lato Rust.
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function concatBytes(...chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Replica byte-per-byte di `cap_crypto::derivation_input` (core/cap-crypto/src/lib.rs).
 */
function derivationInput(derivation, selfBytes) {
  switch (derivation.type) {
    case 'peer': {
      const peerBytes = derivation.peer.toUint8Array();
      const cmp = compareBytes(selfBytes, peerBytes);
      const [a, b] = cmp <= 0 ? [selfBytes, peerBytes] : [peerBytes, selfBytes];
      return concatBytes(a, b);
    }
    case 'stored': {
      const idBytes = new TextEncoder().encode(derivation.dataId);
      return concatBytes(idBytes, selfBytes);
    }
    case 'custom': {
      return concatBytes(derivation.context, selfBytes);
    }
    default:
      throw new Error(`crypto: unknown derivation type ${derivation?.type}`);
  }
}

/** @internal Esposto per i test (parity con Rust cap_crypto::derivation_input). */
export const __internalsForTest = { derivationInput };

/** Payload Candid del DerivationContext (matching IDL del canister host). */
function candidDerivation(derivation) {
  switch (derivation.type) {
    case 'peer':   return { PeerConversation: { peer: derivation.peer } };
    case 'stored': return { StoredData: { data_id: derivation.dataId } };
    case 'custom': return { Custom: { context: derivation.context } };
    default: throw new Error(`crypto: unknown derivation type ${derivation?.type}`);
  }
}

/**
 * Risolve il principal del chiamante. In produzione dal sottostante agent
 * dell'Actor; i test possono forzarlo via `selfOverride` (mock actor plain).
 */
async function resolveSelfPrincipal(actor, selfOverride) {
  if (selfOverride) return selfOverride;
  const agent = Actor.agentOf(actor);
  if (!agent) {
    throw new Error('crypto: actor has no agent (use selfOverride in tests)');
  }
  const principal = await agent.getPrincipal();
  if (principal.isAnonymous()) {
    throw new Error('crypto: caller is anonymous; login required before deriving keys');
  }
  return principal;
}

function assertActor(actor) {
  if (typeof actor?.get_verification_key !== 'function' ||
      typeof actor?.derive_encrypted_key !== 'function') {
    throw new Error('crypto: actor missing cap-crypto methods (host canister non ha assemblato cap-crypto)');
  }
}

function unwrapResult(result, label) {
  if (result && typeof result === 'object') {
    if ('Ok' in result) return result.Ok;
    if ('Err' in result) throw new Error(`crypto: ${label} → ${result.Err}`);
  }
  throw new Error(`crypto: ${label} unexpected result shape`);
}

// ─── VetKD → raw AES bytes (overridable per test) ────────────────────────────

/**
 * Implementazione reale: VetKD round-trip + symmetric key derivation.
 * Esposta come variabile sostituibile via `__setDeriveAesHookForTest` perché
 * i test unitari non possono simulare il subnet VetKD (richiederebbe master
 * secret BLS lato server). Sostituendo questo solo step, i test esercitano:
 * cache, orchestration, error paths, context separation — senza BLS.
 */
async function _realDeriveAesFromVetKd(actor, contextName, derivation, self) {
  const tsk = TransportSecretKey.random();

  const [dpkHex, encKeyHex] = await Promise.all([
    Promise.resolve(actor.get_verification_key(contextName))
      .then((r) => unwrapResult(r, 'get_verification_key')),
    Promise.resolve(
      actor.derive_encrypted_key(contextName, candidDerivation(derivation), tsk.publicKeyBytes()),
    ).then((r) => unwrapResult(r, 'derive_encrypted_key')),
  ]);

  const dpk = DerivedPublicKey.deserialize(fromHex(dpkHex));
  const ek  = EncryptedVetKey.deserialize(fromHex(encKeyHex));

  const input = derivationInput(derivation, self.toUint8Array());
  const vetKey = ek.decryptAndVerify(tsk, dpk, input);

  return vetKey.deriveSymmetricKey(`cap-crypto/v1/aes256/${contextName}`, AES_KEY_LEN_BYTES);
}

let _deriveAesFromVetKd = _realDeriveAesFromVetKd;

/**
 * @internal Test hook: sostituisce il passaggio VetKD→raw AES con una funzione
 * deterministica. NON usare in produzione. Resettare con `__resetDeriveAesHookForTest`.
 */
export function __setDeriveAesHookForTest(fn) {
  _deriveAesFromVetKd = fn;
}

/** @internal */
export function __resetDeriveAesHookForTest() {
  _deriveAesFromVetKd = _realDeriveAesFromVetKd;
}

// ─── API: key derivation ─────────────────────────────────────────────────────

/**
 * Deriva una CryptoKey AES-GCM-256 per (contextName, derivation, caller).
 *
 * Cachata in memoria. Stessa terna → stessa CryptoKey, una sola roundtrip al
 * canister. Invalidare a logout con `clearKeyCache()`.
 *
 * @param {object} actor — Candid actor del canister host (cap-crypto wired).
 * @param {string} contextName — dominio: "vault", "messaging", ...
 * @param {Derivation} derivation
 * @param {Principal} [selfOverride] — solo test; in produzione dedotto dall'agent.
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(actor, contextName, derivation, selfOverride) {
  assertActor(actor);
  if (typeof contextName !== 'string' || contextName.length === 0) {
    throw new Error('crypto: contextName must be a non-empty string');
  }

  const self = await resolveSelfPrincipal(actor, selfOverride);
  const selfText = self.toText();
  const ck = cacheKey(contextName, derivation, selfText);
  const cached = _keyCache.get(ck);
  if (cached) return cached;

  const p = (async () => {
    const rawAes = await _deriveAesFromVetKd(actor, contextName, derivation, self);
    if (!(rawAes instanceof Uint8Array) || rawAes.length !== AES_KEY_LEN_BYTES) {
      throw new Error('crypto: VetKD derived key has wrong length');
    }
    return crypto.subtle.importKey(
      'raw', rawAes,
      { name: 'AES-GCM', length: AES_KEY_LEN_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  })();

  _keyCache.set(ck, p);
  try {
    return await p;
  } catch (e) {
    _keyCache.delete(ck);
    throw e;
  }
}

/**
 * deriveReleaseKey — decifratura lato-EREDE della capsula (dead-man's switch dell'hub).
 *
 * Diverge da `deriveKey` su DUE punti, e solo quelli:
 *  1. chiama `release_derive_key(transport_pk)` (la PORTA condizionale host) invece di
 *     `derive_encrypted_key` — l'host autorizza la derivazione solo a owner / erede-dopo-silenzio;
 *  2. costruisce l'input di derivazione col principal OWNER (non col chiamante) perché l'host
 *     deriva SEMPRE con l'owner come derivation-owner → la chiave combacia con quella di setup.
 * Context, DerivedPublicKey e domain-separator simmetrico sono identici a `deriveKey`, così la
 * AES-GCM ricostruita è bit-per-bit la stessa con cui l'owner ha cifrato. Non cachata (uso one-shot).
 *
 * @param {object} actor — actor host con get_verification_key + release_derive_key.
 * @param {string} contextName — "hub-capsule".
 * @param {Derivation} derivation — { type:'stored', dataId:'__capsule' }.
 * @param {Principal} ownerPrincipal — owner pubblico del canister (da get_user_principal).
 * @returns {Promise<CryptoKey>}
 */
export async function deriveReleaseKey(actor, contextName, derivation, ownerPrincipal) {
  if (typeof actor?.get_verification_key !== 'function' ||
      typeof actor?.release_derive_key !== 'function') {
    throw new Error('crypto: actor missing release methods (host non espone gli endpoint release_*)');
  }
  if (typeof contextName !== 'string' || contextName.length === 0) {
    throw new Error('crypto: contextName must be a non-empty string');
  }
  if (!ownerPrincipal || typeof ownerPrincipal.toUint8Array !== 'function') {
    throw new Error('crypto: deriveReleaseKey requires the owner Principal');
  }

  const tsk = TransportSecretKey.random();
  const [dpkHex, encKeyHex] = await Promise.all([
    Promise.resolve(actor.get_verification_key(contextName))
      .then((r) => unwrapResult(r, 'get_verification_key')),
    Promise.resolve(actor.release_derive_key(tsk.publicKeyBytes()))
      .then((r) => unwrapResult(r, 'release_derive_key')),
  ]);

  const dpk = DerivedPublicKey.deserialize(fromHex(dpkHex));
  const ek  = EncryptedVetKey.deserialize(fromHex(encKeyHex));

  const input = derivationInput(derivation, ownerPrincipal.toUint8Array());
  const vetKey = ek.decryptAndVerify(tsk, dpk, input);
  const rawAes = vetKey.deriveSymmetricKey(`cap-crypto/v1/aes256/${contextName}`, AES_KEY_LEN_BYTES);

  return crypto.subtle.importKey(
    'raw', rawAes,
    { name: 'AES-GCM', length: AES_KEY_LEN_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── API: encrypt / decrypt (binary) ─────────────────────────────────────────

/**
 * @param {Uint8Array} plaintext
 * @param {CryptoKey} key
 * @returns {Promise<Uint8Array>} envelope [v:1|nonce:12|ct+tag]
 */
export async function encrypt(plaintext, key) {
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error('crypto: encrypt requires Uint8Array plaintext');
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext),
  );
  const out = new Uint8Array(ENVELOPE_HEADER_LEN + ct.length);
  out[0] = VERSION_V1;
  out.set(nonce, 1);
  out.set(ct, ENVELOPE_HEADER_LEN);
  return out;
}

/**
 * @param {Uint8Array} envelope
 * @param {CryptoKey} key
 * @returns {Promise<Uint8Array>} plaintext
 */
export async function decrypt(envelope, key) {
  if (!(envelope instanceof Uint8Array)) {
    throw new Error('crypto: decrypt requires Uint8Array envelope');
  }
  if (envelope.length < ENVELOPE_HEADER_LEN + GCM_TAG_LEN) {
    throw new Error('crypto: envelope too short');
  }
  const version = envelope[0];
  if (version !== VERSION_V1) {
    throw new Error(`crypto: unsupported envelope version ${version}`);
  }
  const nonce = envelope.subarray(1, ENVELOPE_HEADER_LEN);
  const ct    = envelope.subarray(ENVELOPE_HEADER_LEN);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
    return new Uint8Array(pt);
  } catch {
    throw new Error('crypto: decrypt failed (envelope corrotto o chiave errata)');
  }
}

// ─── API: zucchero stringhe ──────────────────────────────────────────────────

export async function encryptString(text, key) {
  return encrypt(new TextEncoder().encode(text), key);
}

export async function decryptString(envelope, key) {
  return new TextDecoder().decode(await decrypt(envelope, key));
}

// ─── API: strato a strategia — sigillatura per metodo ─────────────────────────
//
// La capsula/eredità di EasyHub non cabla il metodo di sigillatura: lo dichiara.
// Un envelope-metodo avvolge il ciphertext con un'ETICHETTA così che owner ed
// erede (e domani altre app) riconoscano COME è sigillato senza decifrare. Oggi
// è implementato solo `passphrase` (out-of-band: il canister tiene solo
// ciphertext, nulla di decifrabile sulla subnet). `vetkeys`/`subnetkey` sono
// riservati e riconoscibili in anticipo → aggiungerli domani è additivo e NON
// tocca lo scheletro di push outbound né `cap_crypto::derive_encrypted_key`
// (che resta vivo in core/, in panchina). Cfr. principio outbound-only +
// PLAN supercanister_hub_capsula_outbound.
//
// Formato (self-descrittivo, JSON UTF-8 → bytes opachi per il backend):
//   { v:1, method:'passphrase', kdf:{ algo:'PBKDF2-SHA256', salt:<b64>, iter:N },
//     ct:<b64 dell'envelope binario di encrypt()> }
// Il backend lo vede come `Vec<u8>` opaco → nessun cambio `.did`. L'erede lo
// decifra con un decryptor puramente client-side (zero chiamate al canister).

export const METHOD_PASSPHRASE = 'passphrase';
export const METHOD_VETKEYS    = 'vetkeys';
export const METHOD_SUBNETKEY  = 'subnetkey';

const METHOD_ENVELOPE_V1 = 1;
const PBKDF2_ALGO = 'PBKDF2-SHA256';
// OWASP 2023 per PBKDF2-HMAC-SHA256. È persistito nell'envelope (kdf.iter) →
// alzarlo in futuro non rompe gli envelope già sigillati.
const PBKDF2_DEFAULT_ITER = 600_000;
const PBKDF2_SALT_LEN = 16;

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

/**
 * Deriva una CryptoKey AES-GCM-256 da una passphrase via PBKDF2-HMAC-SHA256.
 * Non cachata (uso one-shot per sigillo/apertura). cap-crypto NON è coinvolto:
 * tutto avviene nel browser, nessun roundtrip al canister.
 *
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {number} [iterations=PBKDF2_DEFAULT_ITER]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKeyFromPassphrase(passphrase, salt, iterations = PBKDF2_DEFAULT_ITER) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('crypto: deriveKeyFromPassphrase requires a non-empty passphrase');
  }
  if (!(salt instanceof Uint8Array) || salt.length === 0) {
    throw new Error('crypto: deriveKeyFromPassphrase requires a non-empty Uint8Array salt');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' }, false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_LEN_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Genera una passphrase forte da consegnare all'erede out-of-band.
 * Charset senza caratteri ambigui (no 0/O/1/l/I). ~5.95 bit/char → 24 char ≈ 142 bit.
 *
 * @param {number} [length=24]
 * @returns {string}
 */
export function generatePassphrase(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const rnd = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  // Rejection sampling per evitare il bias del modulo sui 256 valori.
  for (let i = 0; i < length; i++) {
    let v = rnd[i];
    while (v >= 256 - (256 % alphabet.length)) {
      v = crypto.getRandomValues(new Uint8Array(1))[0];
    }
    out += alphabet[v % alphabet.length];
  }
  return out;
}

/**
 * Sigilla un plaintext con una passphrase → envelope-metodo (bytes opachi).
 * Riusa `encrypt()` (envelope binario v1) come ciphertext interno.
 *
 * @param {Uint8Array} plaintext
 * @param {string} passphrase
 * @param {{ iterations?: number }} [opts]
 * @returns {Promise<Uint8Array>} envelope-metodo JSON-UTF8 (storage-ready)
 */
export async function sealWithPassphrase(plaintext, passphrase, opts = {}) {
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error('crypto: sealWithPassphrase requires Uint8Array plaintext');
  }
  const iterations = opts.iterations ?? PBKDF2_DEFAULT_ITER;
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LEN));
  const key = await deriveKeyFromPassphrase(passphrase, salt, iterations);
  const inner = await encrypt(plaintext, key);
  const env = {
    v: METHOD_ENVELOPE_V1,
    method: METHOD_PASSPHRASE,
    kdf: { algo: PBKDF2_ALGO, salt: toB64(salt), iter: iterations },
    ct: toB64(inner),
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

/**
 * Apre un envelope-metodo `passphrase`. Decryptor puramente client-side.
 *
 * @param {Uint8Array} envelopeBytes
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>} plaintext
 */
export async function openWithPassphrase(envelopeBytes, passphrase) {
  const env = parseMethodEnvelope(envelopeBytes);
  if (env.method !== METHOD_PASSPHRASE) {
    throw new Error(`crypto: openWithPassphrase non gestisce method='${env.method}'`);
  }
  if (env.kdf?.algo !== PBKDF2_ALGO) {
    throw new Error(`crypto: unsupported kdf algo '${env.kdf?.algo}'`);
  }
  const salt = fromB64(env.kdf.salt);
  const iterations = env.kdf.iter;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('crypto: envelope kdf.iter invalido');
  }
  const key = await deriveKeyFromPassphrase(passphrase, salt, iterations);
  return decrypt(fromB64(env.ct), key);
}

/** Zucchero stringa per `sealWithPassphrase`. */
export async function sealStringWithPassphrase(text, passphrase, opts) {
  return sealWithPassphrase(new TextEncoder().encode(text), passphrase, opts);
}

/** Zucchero stringa per `openWithPassphrase`. */
export async function openStringWithPassphrase(envelopeBytes, passphrase) {
  return new TextDecoder().decode(await openWithPassphrase(envelopeBytes, passphrase));
}

// ─── Sigillatura di un FILE (qualsiasi formato) ───────────────────────────────
//
// Un file ha byte arbitrari + due metadati che servono per restituirlo: `name` e
// `mime`. Non si cifrano i byte grezzi: si cifra un CONTENITORE che impacchetta
// metadati + byte, così che nome e mime stiano DENTRO il ciphertext — chi regge
// l'envelope (canister, webhook dell'erede) non vede nemmeno come si chiama il
// file. L'outer envelope-metodo resta invariato e opaco (`method:'passphrase'`),
// uniforme tra testo e file: nessun `kind` trapela fuori dal ciphertext.
//
// Container (plaintext che entra in sealWithPassphrase):
//   FILE_MAGIC(4) | headerLen:u32 LE | header JSON UTF-8 {name,mime} | raw bytes
//
// Il MAGIC distingue, DOPO la decifratura, un file da una capsula-testo legacy
// (raw UTF-8, senza framing): l'opener decifra e, se trova il MAGIC, è un file.

// "ECF1" = EasyCapsule File v1.
const FILE_MAGIC = Uint8Array.of(0x45, 0x43, 0x46, 0x31);

function frameFile(meta, bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('crypto: frameFile requires Uint8Array bytes');
  }
  const header = new TextEncoder().encode(JSON.stringify({
    name: typeof meta?.name === 'string' ? meta.name : '',
    mime: typeof meta?.mime === 'string' ? meta.mime : '',
  }));
  const lenLE = new Uint8Array(4);
  new DataView(lenLE.buffer).setUint32(0, header.length, true);
  return concatBytes(FILE_MAGIC, lenLE, header, bytes);
}

function unframeFile(plaintext) {
  if (!(plaintext instanceof Uint8Array) || plaintext.length < FILE_MAGIC.length + 4) {
    throw new Error('crypto: not a sealed file (too short)');
  }
  if (compareBytes(plaintext.subarray(0, FILE_MAGIC.length), FILE_MAGIC) !== 0) {
    throw new Error('crypto: not a sealed file (bad magic)');
  }
  const off = FILE_MAGIC.length;
  const headerLen = new DataView(plaintext.buffer, plaintext.byteOffset + off, 4).getUint32(0, true);
  const headerStart = off + 4;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > plaintext.length) {
    throw new Error('crypto: sealed file corrotto (header len out of range)');
  }
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(plaintext.subarray(headerStart, headerEnd)));
  } catch {
    throw new Error('crypto: sealed file corrotto (header non JSON)');
  }
  // Copia (non subarray) → i byte restituiti non tengono in vita il buffer del plaintext.
  return {
    name: typeof meta?.name === 'string' ? meta.name : '',
    mime: typeof meta?.mime === 'string' ? meta.mime : '',
    bytes: plaintext.slice(headerEnd),
  };
}

/**
 * Sigilla un file (byte arbitrari + nome/mime) con una passphrase → envelope-metodo
 * opaco, identico in forma a quello del testo. Riusa `sealWithPassphrase`.
 *
 * @param {Uint8Array} bytes — contenuto del file
 * @param {{ name?: string, mime?: string }} meta
 * @param {string} passphrase
 * @param {{ iterations?: number }} [opts]
 * @returns {Promise<Uint8Array>} envelope-metodo JSON-UTF8 (storage-ready)
 */
export async function sealFileWithPassphrase(bytes, meta, passphrase, opts) {
  return sealWithPassphrase(frameFile(meta, bytes), passphrase, opts);
}

/**
 * Apre un envelope-file sigillato con passphrase → `{ name, mime, bytes }`.
 * Decryptor puramente client-side (lancia se l'envelope non è un file).
 *
 * @param {Uint8Array} envelopeBytes
 * @param {string} passphrase
 * @returns {Promise<{ name: string, mime: string, bytes: Uint8Array }>}
 */
export async function openFileWithPassphrase(envelopeBytes, passphrase) {
  return unframeFile(await openWithPassphrase(envelopeBytes, passphrase));
}

function parseMethodEnvelope(envelopeBytes) {
  if (!(envelopeBytes instanceof Uint8Array)) {
    throw new Error('crypto: method envelope must be Uint8Array');
  }
  let env;
  try {
    env = JSON.parse(new TextDecoder().decode(envelopeBytes));
  } catch {
    throw new Error('crypto: method envelope non è JSON valido');
  }
  if (!env || typeof env !== 'object' || env.v !== METHOD_ENVELOPE_V1 || typeof env.method !== 'string') {
    throw new Error('crypto: method envelope malformato (v/method)');
  }
  return env;
}

/**
 * Riconosce il metodo di sigillatura SENZA decifrare. Permette a owner/erede/UI
 * di sapere quale strategia serve (oggi solo 'passphrase'; 'vetkeys'/'subnetkey'
 * riconoscibili in anticipo) prima di chiedere la passphrase.
 *
 * @param {Uint8Array} envelopeBytes
 * @returns {string} uno tra METHOD_*
 */
export function readEnvelopeMethod(envelopeBytes) {
  return parseMethodEnvelope(envelopeBytes).method;
}

/** @internal Esposto per i test. */
export const __methodInternalsForTest = { toB64, fromB64, parseMethodEnvelope, frameFile, unframeFile, FILE_MAGIC };
