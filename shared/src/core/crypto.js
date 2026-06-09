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
