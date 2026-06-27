/**
 * Round-trip safety net for the standalone capsule opener.
 *
 * Runner: `node --test shared/src/core/capsule-opener.roundtrip.test.js`
 * (picked up by `cd shared && npm test`). Node 19+ for globalThis.crypto + atob.
 *
 * WHY THIS EXISTS
 * ───────────────
 * apps/supercanister-hub/standalone/capsule-opener.html is hand-written, NOT
 * generated from the build — its crypto must read exactly the envelope format
 * that shared/src/core/crypto.js produces. This test is the only coupling:
 *   1. it extracts the <script id="capsule-core"> block from the HTML AS-IS,
 *   2. runs that very code headless in a node:vm sandbox (WebCrypto injected),
 *   3. seals real envelopes with crypto.js and asserts the opener reproduces them.
 * If the frozen format ever drifts on either side, this breaks. There is no
 * coupling to a compiled artifact — it runs the literal HTML source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import {
  sealStringWithPassphrase,
  sealFileWithPassphrase,
} from './crypto.js';

// ── Load the opener's pure-crypto script straight out of the HTML ────────────
const HTML_PATH = new URL(
  '../../../apps/supercanister-hub/standalone/capsule-opener.html',
  import.meta.url,
);
const html = readFileSync(HTML_PATH, 'utf8');

const m = html.match(/<script id="capsule-core">([\s\S]*?)<\/script>/);
assert.ok(m, 'capsule-opener.html must contain a <script id="capsule-core"> block');
const coreSource = m[1];

// Sandbox: only the web globals the opener legitimately uses. Built-ins
// (Uint8Array, DataView, JSON, Promise, …) come from the vm realm itself.
const sandbox = {
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  atob: globalThis.atob,
  console,
};
const ctx = vm.createContext(sandbox);
vm.runInContext(coreSource, ctx, { filename: 'capsule-core.js' });
assert.ok(sandbox.CapsuleCore, 'capsule-core must expose globalThis.CapsuleCore');

// Adapter: build the envBytes INSIDE the vm realm (so `instanceof Uint8Array`
// holds) and hand file bytes back as a plain Array for cross-realm comparison.
vm.runInContext(`
  globalThis.__openForTest = async function (arr, passphrase) {
    var res = await CapsuleCore.openEnvelope(Uint8Array.from(arr), passphrase);
    if (res.kind === 'file') return { kind: 'file', name: res.name, mime: res.mime, bytes: Array.from(res.bytes) };
    return res;
  };
  globalThis.__readMethod = function (arr) { return CapsuleCore.readMethod(Uint8Array.from(arr)); };
`, ctx);

const openWithOpener = (envBytes, passphrase) =>
  sandbox.__openForTest(Array.from(envBytes), passphrase);

// ── Tests ────────────────────────────────────────────────────────────────────

test('text capsule (legacy, no framing): crypto.js seals → opener shows the message', async () => {
  const message = 'Per Anna — la cassetta di sicurezza è alla banca, codice 4417. Ti voglio bene. 🌿';
  const passphrase = 'Correct-Horse-Battery-Staple-42';

  const envelope = await sealStringWithPassphrase(message, passphrase);
  const res = await openWithOpener(envelope, passphrase);

  assert.equal(res.kind, 'text');
  assert.equal(res.text, message);
});

test('file capsule: opener rebuilds name, mime and bytes byte-for-byte (binary, non-UTF8)', async () => {
  // Arbitrary binary incl. bytes that are NOT valid UTF-8 (0xFF, 0xFE, 0x00).
  const original = new Uint8Array(4096);
  crypto.getRandomValues(original);
  original[0] = 0xff; original[1] = 0xfe; original[2] = 0x00; original[3] = 0x80;

  const name = 'réçu_2024_€.pdf';            // unicode name lives inside the ciphertext
  const mime = 'application/pdf';
  const passphrase = 'una-frase-lunga-e-robusta';

  const envelope = await sealFileWithPassphrase(original, { name, mime }, passphrase);
  const res = await openWithOpener(envelope, passphrase);

  assert.equal(res.kind, 'file');
  assert.equal(res.name, name);
  assert.equal(res.mime, mime);
  assert.deepEqual(Buffer.from(res.bytes), Buffer.from(original));
});

test('empty-name / octet-stream file still round-trips', async () => {
  const original = Uint8Array.of(1, 2, 3, 4, 5);
  const passphrase = 'pw-pw-pw-pw';

  const envelope = await sealFileWithPassphrase(original, {}, passphrase);
  const res = await openWithOpener(envelope, passphrase);

  assert.equal(res.kind, 'file');
  assert.equal(res.name, '');
  assert.equal(res.mime, '');
  assert.deepEqual(Buffer.from(res.bytes), Buffer.from(original));
});

test('wrong passphrase: AES-GCM authentication fails → opener throws', async () => {
  const envelope = await sealStringWithPassphrase('segreto', 'la-giusta');
  await assert.rejects(() => openWithOpener(envelope, 'la-sbagliata'));
});

test('non-passphrase method (vetkeys) is recognised and rejected before decrypting', async () => {
  // Hand-crafted method envelope with an unsupported strategy label.
  const env = { v: 1, method: 'vetkeys', kdf: { algo: 'PBKDF2-SHA256', salt: 'AAAA', iter: 1 }, ct: '' };
  const envBytes = new TextEncoder().encode(JSON.stringify(env));

  assert.equal(sandbox.__readMethod(Array.from(envBytes)), 'vetkeys');
  await assert.rejects(
    () => openWithOpener(envBytes, 'whatever'),
    /unsupported-method:vetkeys/,
  );
});

test('garbage input is rejected as not-an-envelope', async () => {
  const envBytes = new TextEncoder().encode('this is not json at all');
  await assert.rejects(() => openWithOpener(envBytes, 'x'), /not-an-envelope/);
});
