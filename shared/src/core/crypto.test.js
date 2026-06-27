/**
 * Test del modulo E2EE shared/src/core/crypto.js.
 *
 * Runner: `node --test shared/src/core/crypto.test.js` (Node 19+ per
 * `globalThis.crypto`). Richiede deps installate in `shared/`:
 *   cd shared && npm install
 *
 * Strategia di test
 * ─────────────────
 * 1. derivationInput: parity byte-per-byte con cap_crypto::derivation_input.
 * 2. encrypt/decrypt: round-trip + envelope corrotto + version mismatch.
 *    Usa una CryptoKey reale generata via WebCrypto — niente VetKD.
 * 3. deriveKey: orchestration, cache, error paths. Il passaggio VetKD→raw AES
 *    è sostituito con un hook deterministico (`__setDeriveAesHookForTest`)
 *    perché simulare il subnet VetKD richiederebbe il master secret BLS.
 *    Tradeoff esplicito: BLS sign+verify NON è coperto qui — è responsabilità
 *    di `@dfinity/vetkeys` e va testato in integrazione (browser su Vault).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Principal } from '@dfinity/principal';

import {
  deriveKey,
  clearKeyCache,
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  deriveKeyFromPassphrase,
  generatePassphrase,
  sealWithPassphrase,
  openWithPassphrase,
  sealStringWithPassphrase,
  openStringWithPassphrase,
  sealFileWithPassphrase,
  openFileWithPassphrase,
  readEnvelopeMethod,
  METHOD_PASSPHRASE,
  __setDeriveAesHookForTest,
  __resetDeriveAesHookForTest,
  __internalsForTest,
  __methodInternalsForTest,
} from './crypto.js';

const { derivationInput } = __internalsForTest;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ALICE = Principal.fromUint8Array(new Uint8Array([1, 1, 1, 1]));
const BOB   = Principal.fromUint8Array(new Uint8Array([2, 2, 2, 2]));
const CARL  = Principal.fromUint8Array(new Uint8Array([3, 3, 3, 3]));

async function generateAesKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Mock actor: registra le chiamate e ritorna risposte stub.
 * I valori restituiti da get_verification_key / derive_encrypted_key sono hex
 * fittizi: il hook test bypassa la decifratura reale.
 */
function makeMockActor({ derive = null, verify = null } = {}) {
  const calls = { verify: 0, derive: 0 };
  return {
    calls,
    async get_verification_key(ctx) {
      calls.verify++;
      if (verify) return verify(ctx);
      return { Ok: '00'.repeat(96) };
    },
    async derive_encrypted_key(ctx, derivation, tpk) {
      calls.derive++;
      if (derive) return derive(ctx, derivation, tpk);
      return { Ok: '00'.repeat(192) };
    },
  };
}

/** Hook che ritorna un raw AES deterministico calcolato dai parametri. */
function makeDeterministicHook(callLog = []) {
  return async (actor, contextName, derivation, self) => {
    callLog.push({ contextName, derivationType: derivation.type, self: self.toText() });
    // Bytes deterministici dipendenti dai parametri → contesti diversi = chiavi diverse.
    const seed = new TextEncoder().encode(
      `${contextName}|${self.toText()}|${JSON.stringify(serializableDerivation(derivation))}`,
    );
    const buf = await crypto.subtle.digest('SHA-256', seed);
    return new Uint8Array(buf);
  };
}

function serializableDerivation(d) {
  switch (d.type) {
    case 'peer':   return { t: 'peer', peer: d.peer.toText() };
    case 'stored': return { t: 'stored', dataId: d.dataId };
    case 'custom': return { t: 'custom', context: Array.from(d.context) };
    default: return { t: 'unknown' };
  }
}

// ─── derivationInput parity ──────────────────────────────────────────────────

test('derivationInput: PeerConversation ordine canonico (Alice→Bob == Bob→Alice)', () => {
  const ab = derivationInput({ type: 'peer', peer: BOB }, ALICE.toUint8Array());
  const ba = derivationInput({ type: 'peer', peer: ALICE }, BOB.toUint8Array());
  assert.deepEqual(Array.from(ab), Array.from(ba));
  // Concat = sorted(min, max).
  const aBytes = ALICE.toUint8Array();
  const bBytes = BOB.toUint8Array();
  const expected = new Uint8Array(aBytes.length + bBytes.length);
  expected.set(aBytes, 0);
  expected.set(bBytes, aBytes.length);
  assert.deepEqual(Array.from(ab), Array.from(expected));
});

test('derivationInput: PeerConversation peer diversi → input diversi', () => {
  const ab = derivationInput({ type: 'peer', peer: BOB }, ALICE.toUint8Array());
  const ac = derivationInput({ type: 'peer', peer: CARL }, ALICE.toUint8Array());
  assert.notDeepEqual(Array.from(ab), Array.from(ac));
});

test('derivationInput: StoredData = data_id_bytes + owner_bytes', () => {
  const input = derivationInput({ type: 'stored', dataId: 'file_42' }, ALICE.toUint8Array());
  const idBytes = new TextEncoder().encode('file_42');
  assert.equal(input.length, idBytes.length + ALICE.toUint8Array().length);
  for (let i = 0; i < idBytes.length; i++) assert.equal(input[i], idBytes[i]);
});

test('derivationInput: Custom = context + owner', () => {
  const ctx = new Uint8Array([0xDE, 0xAD]);
  const input = derivationInput({ type: 'custom', context: ctx }, ALICE.toUint8Array());
  assert.equal(input[0], 0xDE);
  assert.equal(input[1], 0xAD);
  assert.equal(input.length, 2 + ALICE.toUint8Array().length);
});

// ─── Envelope: round-trip ────────────────────────────────────────────────────

test('encrypt/decrypt: round-trip binary', async () => {
  const key = await generateAesKey();
  const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const env = await encrypt(plaintext, key);
  assert.equal(env[0], 0x01, 'version byte must be 1');
  assert.equal(env.length, 1 + 12 + plaintext.length + 16, 'header + ct + GCM tag');
  const back = await decrypt(env, key);
  assert.deepEqual(Array.from(back), Array.from(plaintext));
});

test('encryptString/decryptString: round-trip', async () => {
  const key = await generateAesKey();
  const msg = 'Ciao 🌍 — multi-byte UTF-8 ok?';
  const env = await encryptString(msg, key);
  assert.equal(await decryptString(env, key), msg);
});

test('encrypt: nonce diverso ogni chiamata (envelope diverso per stesso plaintext)', async () => {
  const key = await generateAesKey();
  const pt = new Uint8Array([42]);
  const e1 = await encrypt(pt, key);
  const e2 = await encrypt(pt, key);
  assert.notDeepEqual(Array.from(e1), Array.from(e2));
});

test('decrypt: envelope corrotto (tag flip) → throw', async () => {
  const key = await generateAesKey();
  const env = await encrypt(new Uint8Array([1, 2, 3]), key);
  const tampered = new Uint8Array(env);
  tampered[tampered.length - 1] ^= 0xFF;
  await assert.rejects(() => decrypt(tampered, key), /decrypt failed/);
});

test('decrypt: version byte sconosciuta → throw esplicito', async () => {
  const key = await generateAesKey();
  const env = await encrypt(new Uint8Array([1]), key);
  env[0] = 0x99;
  await assert.rejects(() => decrypt(env, key), /unsupported envelope version 153/);
});

test('decrypt: envelope troppo corto → throw esplicito (no silent)', async () => {
  const key = await generateAesKey();
  await assert.rejects(() => decrypt(new Uint8Array([0x01, 0, 0, 0]), key), /envelope too short/);
});

test('encrypt: plaintext non-Uint8Array → throw esplicito', async () => {
  const key = await generateAesKey();
  await assert.rejects(() => encrypt('stringa diretta', key), /requires Uint8Array plaintext/);
});

// ─── deriveKey: orchestration + cache (hook test) ────────────────────────────

beforeEach(() => { clearKeyCache(); });
afterEach(() => { __resetDeriveAesHookForTest(); clearKeyCache(); });

test('deriveKey: actor senza i due metodi → throw chiaro', async () => {
  const empty = {};
  await assert.rejects(
    () => deriveKey(empty, 'vault', { type: 'stored', dataId: 'x' }, ALICE),
    /actor missing cap-crypto methods/,
  );
});

test('deriveKey: contextName vuoto → throw', async () => {
  const actor = makeMockActor();
  await assert.rejects(
    () => deriveKey(actor, '', { type: 'stored', dataId: 'x' }, ALICE),
    /contextName must be a non-empty string/,
  );
});

test('deriveKey: actor.derive_encrypted_key Err → propagato con prefisso', async () => {
  const actor = makeMockActor({
    derive: () => ({ Err: 'vetkd_derive_key failed: insufficient cycles' }),
  });
  __setDeriveAesHookForTest(_realHookButErrorPath);
  await assert.rejects(
    () => deriveKey(actor, 'vault', { type: 'stored', dataId: 'x' }, ALICE),
    /derive_encrypted_key.*insufficient cycles/,
  );
});

// Hook che simula il path reale fino a unwrapResult (così l'Err propaga).
async function _realHookButErrorPath(actor, contextName, derivation /*, self */) {
  // Riproduciamo solo le due call: se una ritorna Err, deve throw.
  const r = await actor.derive_encrypted_key(contextName, { StoredData: { data_id: derivation.dataId } }, new Uint8Array(48));
  if (r?.Err) throw new Error(`crypto: derive_encrypted_key → ${r.Err}`);
  return new Uint8Array(32);
}

test('deriveKey: cache hit — stessa terna → un solo trip al hook', async () => {
  const actor = makeMockActor();
  const log = [];
  __setDeriveAesHookForTest(makeDeterministicHook(log));

  const k1 = await deriveKey(actor, 'vault', { type: 'stored', dataId: 'doc1' }, ALICE);
  const k2 = await deriveKey(actor, 'vault', { type: 'stored', dataId: 'doc1' }, ALICE);

  assert.equal(log.length, 1, 'hook deve essere chiamato una sola volta');
  assert.equal(k1, k2, 'CryptoKey deve essere la stessa istanza cachata');
});

test('deriveKey: clearKeyCache forza ri-derivazione', async () => {
  const actor = makeMockActor();
  const log = [];
  __setDeriveAesHookForTest(makeDeterministicHook(log));

  await deriveKey(actor, 'vault', { type: 'stored', dataId: 'doc1' }, ALICE);
  clearKeyCache();
  await deriveKey(actor, 'vault', { type: 'stored', dataId: 'doc1' }, ALICE);

  assert.equal(log.length, 2);
});

test('deriveKey: contextName diverso → chiave diversa anche con stessa derivation', async () => {
  const actor = makeMockActor();
  __setDeriveAesHookForTest(makeDeterministicHook());

  const kVault    = await deriveKey(actor, 'vault',     { type: 'stored', dataId: 'd' }, ALICE);
  const kMessaging = await deriveKey(actor, 'messaging', { type: 'stored', dataId: 'd' }, ALICE);

  // Cifro stesso plaintext con entrambe, verifico che NON sono interscambiabili.
  const pt = new TextEncoder().encode('segreto');
  const envV = await encrypt(pt, kVault);
  await assert.rejects(() => decrypt(envV, kMessaging), /decrypt failed/);
});

test('deriveKey: derivation diversa (peer vs stored) → cache miss', async () => {
  const actor = makeMockActor();
  const log = [];
  __setDeriveAesHookForTest(makeDeterministicHook(log));

  await deriveKey(actor, 'vault', { type: 'stored', dataId: 'doc1' }, ALICE);
  await deriveKey(actor, 'vault', { type: 'peer', peer: BOB }, ALICE);
  await deriveKey(actor, 'vault', { type: 'stored', dataId: 'doc2' }, ALICE);

  assert.equal(log.length, 3);
});

test('deriveKey: errore nella derivazione NON avvelena la cache', async () => {
  const actor = makeMockActor();
  let calls = 0;
  __setDeriveAesHookForTest(async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
    const buf = await crypto.subtle.digest('SHA-256', new Uint8Array([1]));
    return new Uint8Array(buf);
  });

  await assert.rejects(() => deriveKey(actor, 'vault', { type: 'stored', dataId: 'x' }, ALICE), /boom/);
  // Secondo tentativo: deve riprovare (cache pulita) e succedere.
  const k = await deriveKey(actor, 'vault', { type: 'stored', dataId: 'x' }, ALICE);
  assert.ok(k);
  assert.equal(calls, 2);
});

test('deriveKey: selfOverride bypassa la lookup dell\'agent (mock actor senza agent)', async () => {
  const actor = makeMockActor();
  __setDeriveAesHookForTest(async (_a, _c, _d, self) => {
    // Verifico che riceva esattamente il principal passato.
    assert.equal(self.toText(), ALICE.toText());
    const buf = await crypto.subtle.digest('SHA-256', new Uint8Array([7]));
    return new Uint8Array(buf);
  });
  const k = await deriveKey(actor, 'vault', { type: 'stored', dataId: 'x' }, ALICE);
  assert.ok(k);
});

test('deriveKey: hook ritorna lunghezza sbagliata → throw esplicito', async () => {
  const actor = makeMockActor();
  __setDeriveAesHookForTest(async () => new Uint8Array(16)); // 128-bit, non 256
  await assert.rejects(
    () => deriveKey(actor, 'vault', { type: 'stored', dataId: 'x' }, ALICE),
    /VetKD derived key has wrong length/,
  );
});

// ─── Strato a strategia: sigillatura passphrase (off-canister) ────────────────

test('passphrase: round-trip binario seal→open', async () => {
  const pt = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const env = await sealWithPassphrase(pt, 'correct horse battery staple');
  // Iterazioni basse opzionali NON usate qui: verifichiamo il default reale.
  const back = await openWithPassphrase(env, 'correct horse battery staple');
  assert.deepEqual(Array.from(back), Array.from(pt));
});

test('passphrase: round-trip stringa seal→open', async () => {
  const msg = 'eredità 🗝️ — multi-byte';
  const env = await sealStringWithPassphrase(msg, 'pw-test', { iterations: 50_000 });
  assert.equal(await openStringWithPassphrase(env, 'pw-test'), msg);
});

test('passphrase: passphrase errata → throw (decrypt failed)', async () => {
  const env = await sealStringWithPassphrase('segreto', 'giusta', { iterations: 50_000 });
  await assert.rejects(() => openStringWithPassphrase(env, 'sbagliata'), /decrypt failed/);
});

test('passphrase: envelope auto-descrittivo — method riconosciuto SENZA decifrare', async () => {
  const env = await sealStringWithPassphrase('x', 'pw', { iterations: 50_000 });
  assert.equal(readEnvelopeMethod(env), METHOD_PASSPHRASE);
  // Forma JSON self-descrittiva con etichetta + kdf + ct.
  const parsed = JSON.parse(new TextDecoder().decode(env));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.method, 'passphrase');
  assert.equal(parsed.kdf.algo, 'PBKDF2-SHA256');
  assert.equal(parsed.kdf.iter, 50_000);
  assert.ok(typeof parsed.kdf.salt === 'string' && parsed.kdf.salt.length > 0);
  assert.ok(typeof parsed.ct === 'string' && parsed.ct.length > 0);
});

test('decryptor #decrypt — flusso reale: generatePassphrase → sealString → openString chiude', async () => {
  // Il flusso vero della capsula: l'owner genera una passphrase FORTE (consegnata out-of-band),
  // sigilla il segreto, l'erede la apre nel decryptor #decrypt (puramente client-side). Verifica che
  // l'output di generatePassphrase funzioni come chiave end-to-end (i test 330/391 coprono il
  // round-trip a passphrase fissa e il charset, non l'integrazione delle due).
  const pass = generatePassphrase(24);
  const secret = 'wallet seed: alpha bravo charlie 🗝️';
  const env = await sealStringWithPassphrase(secret, pass, { iterations: 50_000 });
  assert.equal(await openStringWithPassphrase(env, pass), secret);
});

test('decryptor #decrypt — guard: envelope di metodo diverso riconosciuto e RESPINTO', async () => {
  // Il decryptor #decrypt prima riconosce il metodo (readEnvelopeMethod), poi apre con
  // openStringWithPassphrase. Un envelope di metodo FUTURO (es. 'vetkeys' dello strato-strategia)
  // deve essere (a) riconosciuto come ≠ passphrase → l'UI lo rifiuta prima di chiedere la passphrase,
  // e (b) respinto comunque da openWithPassphrase (difesa in profondità: il guard #decrypt).
  const foreign = new TextEncoder().encode(JSON.stringify({
    v: 1,
    method: 'vetkeys',
    kdf: { algo: 'PBKDF2-SHA256', salt: 'c2FsdHk', iter: 50_000 },
    ct: 'Y2lwaGVy',
  }));
  assert.equal(readEnvelopeMethod(foreign), 'vetkeys');
  assert.notEqual(readEnvelopeMethod(foreign), METHOD_PASSPHRASE);
  await assert.rejects(
    () => openStringWithPassphrase(foreign, 'qualsiasi'),
    /non gestisce method='vetkeys'/,
  );
});

test('passphrase: iter persistito → open usa il valore dell\'envelope, non il default', async () => {
  // Sigillo con iter custom; l'apertura deve dedurlo dall'envelope.
  const env = await sealStringWithPassphrase('y', 'pw', { iterations: 12_345 });
  assert.equal(JSON.parse(new TextDecoder().decode(env)).kdf.iter, 12_345);
  assert.equal(await openStringWithPassphrase(env, 'pw'), 'y');
});

test('passphrase: salt random → due sigilli dello stesso plaintext sono diversi', async () => {
  const e1 = await sealStringWithPassphrase('z', 'pw', { iterations: 50_000 });
  const e2 = await sealStringWithPassphrase('z', 'pw', { iterations: 50_000 });
  assert.notDeepEqual(Array.from(e1), Array.from(e2));
});

test('deriveKeyFromPassphrase: stesso (pw,salt,iter) → chiave interscambiabile; salt diverso → no', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k1 = await deriveKeyFromPassphrase('pw', salt, 50_000);
  const k2 = await deriveKeyFromPassphrase('pw', salt, 50_000);
  const env = await encrypt(new TextEncoder().encode('hi'), k1);
  assert.equal(new TextDecoder().decode(await decrypt(env, k2)), 'hi');

  const otherSalt = crypto.getRandomValues(new Uint8Array(16));
  const k3 = await deriveKeyFromPassphrase('pw', otherSalt, 50_000);
  await assert.rejects(() => decrypt(env, k3), /decrypt failed/);
});

test('deriveKeyFromPassphrase: passphrase vuota / salt vuoto → throw esplicito', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await assert.rejects(() => deriveKeyFromPassphrase('', salt), /non-empty passphrase/);
  await assert.rejects(() => deriveKeyFromPassphrase('pw', new Uint8Array(0)), /non-empty Uint8Array salt/);
});

test('readEnvelopeMethod: envelope non-JSON / malformato → throw esplicito (no silent)', () => {
  assert.throws(() => readEnvelopeMethod(new Uint8Array([0xFF, 0x00])), /non è JSON valido/);
  const bad = new TextEncoder().encode(JSON.stringify({ v: 1 })); // manca method
  assert.throws(() => readEnvelopeMethod(bad), /malformato/);
});

test('generatePassphrase: lunghezza richiesta, charset senza caratteri ambigui', () => {
  const p = generatePassphrase(32);
  assert.equal(p.length, 32);
  assert.ok(!/[0O1lI]/.test(p), 'niente 0/O/1/l/I');
  // Due generazioni consecutive non collidono (entropia reale).
  assert.notEqual(generatePassphrase(24), generatePassphrase(24));
});

test('b64 helper: round-trip su bytes arbitrari (parity browser/Node)', () => {
  const { toB64, fromB64 } = __methodInternalsForTest;
  const bytes = crypto.getRandomValues(new Uint8Array(257));
  assert.deepEqual(Array.from(fromB64(toB64(bytes))), Array.from(bytes));
});

// ─── Sigillatura di un FILE (qualsiasi formato) ───────────────────────────────

test('file: round-trip su byte non-UTF8 → name/mime/bytes preservati', async () => {
  // Byte arbitrari, inclusi 0x00/0xFF/sequenze non valide come UTF-8.
  const bytes = Uint8Array.of(0x00, 0xFF, 0xFE, 0x80, 0xC0, 0x01, 0x7F, 0x90);
  const env = await sealFileWithPassphrase(bytes, { name: 'foto.png', mime: 'image/png' }, 'pw', { iterations: 50_000 });
  const out = await openFileWithPassphrase(env, 'pw');
  assert.equal(out.name, 'foto.png');
  assert.equal(out.mime, 'image/png');
  assert.deepEqual(Array.from(out.bytes), Array.from(bytes));
});

test('file: round-trip su buffer ~1 MB', async () => {
  const bytes = new Uint8Array(1024 * 1024);
  for (let off = 0; off < bytes.length; off += 65536) {
    crypto.getRandomValues(bytes.subarray(off, off + 65536)); // getRandomValues: max 64 KB/chiamata
  }
  const env = await sealFileWithPassphrase(bytes, { name: 'big.bin', mime: 'application/octet-stream' }, 'pw', { iterations: 1_000 });
  const out = await openFileWithPassphrase(env, 'pw');
  assert.equal(out.bytes.length, bytes.length);
  assert.deepEqual(Array.from(out.bytes.subarray(0, 32)), Array.from(bytes.subarray(0, 32)));
  assert.deepEqual(Array.from(out.bytes.subarray(-32)), Array.from(bytes.subarray(-32)));
});

test('file: envelope-metodo opaco identico in forma a quello del testo (method=passphrase, no leak kind/name)', async () => {
  const env = await sealFileWithPassphrase(Uint8Array.of(1, 2, 3), { name: 'segreto.pdf', mime: 'application/pdf' }, 'pw', { iterations: 1_000 });
  const parsed = JSON.parse(new TextDecoder().decode(env));
  assert.equal(parsed.method, 'passphrase');     // riconoscibile come gli altri, senza decifrare
  assert.equal(parsed.kind, undefined);           // niente file-vs-testo fuori dal ciphertext
  assert.ok(!new TextDecoder().decode(env).includes('segreto.pdf')); // il nome non trapela
});

test('file: passphrase errata → throw (decrypt failed, prima di unframe)', async () => {
  const env = await sealFileWithPassphrase(Uint8Array.of(9, 9, 9), { name: 'x', mime: '' }, 'giusta', { iterations: 1_000 });
  await assert.rejects(() => openFileWithPassphrase(env, 'sbagliata'), /decrypt failed/);
});

test('file: aprire una capsula-TESTO come file → throw (bad magic, niente falso file)', async () => {
  const env = await sealStringWithPassphrase('solo testo', 'pw', { iterations: 1_000 });
  await assert.rejects(() => openFileWithPassphrase(env, 'pw'), /not a sealed file/);
});

test('file: capsula-TESTO legacy resta apribile come stringa (retro-compat invariata)', async () => {
  const env = await sealStringWithPassphrase('ciao', 'pw', { iterations: 1_000 });
  assert.equal(await openStringWithPassphrase(env, 'pw'), 'ciao');
});

test('file: frame/unframe diretti — header corrotto (len out of range) → throw', () => {
  const { frameFile, unframeFile } = __methodInternalsForTest;
  const framed = frameFile({ name: 'a', mime: 'b' }, Uint8Array.of(1, 2));
  assert.deepEqual(unframeFile(framed).bytes, Uint8Array.of(1, 2));
  // Sfondo il campo headerLen (offset 4..8) con un valore enorme.
  const broken = framed.slice();
  new DataView(broken.buffer).setUint32(4, 0xFFFFFFFF, true);
  assert.throws(() => unframeFile(broken), /out of range/);
});
