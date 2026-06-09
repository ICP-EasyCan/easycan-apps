/**
 * Test del modello binario sovrano-di-default (docs/catalog/cap-platform.md §Modello di sovranità).
 *
 * Runner: `node --test shared/src/core/sovereignty.test.js` (Node 18+, zero
 * dipendenze). I Principal sono stub `{ toText }`: `deriveSovereignty` li usa
 * solo via `.toText()`, quindi non serve `@dfinity/principal`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  optPrincipal,
  controllersInclude,
  parseMetadata,
  deriveSovereignty,
} from './sovereignty.js';

// ─── Stub principal ───────────────────────────────────────────────────────────
const P = (id) => ({ toText: () => id });
const SPAWNER = P('spawner-aaaa');
const PORTAL = P('portal-bbbb');
const ADMIN = P('admin-cccc');
const SELF = P('self-dddd');

// Costruisce un raw metadata candid (Opt = array).
function raw({
  is_standalone = false,
  ejected = false,
  admin = ADMIN,
  spawner = SPAWNER,
  portal_owner = PORTAL,
  original_spawner = SPAWNER,
  original_portal_owner = PORTAL,
  tier = 1,
  wasm_hash = 'abc123',
} = {}) {
  const opt = (v) => (v == null ? [] : [v]);
  return {
    is_standalone,
    ejected,
    admin: opt(admin),
    spawner: opt(spawner),
    portal_owner: opt(portal_owner),
    original_spawner: opt(original_spawner),
    original_portal_owner: opt(original_portal_owner),
    tier,
    wasm_hash: wasm_hash == null ? [] : [wasm_hash],
  };
}

// ─── optPrincipal ───────────────────────────────────────────────────────────
test('optPrincipal: None → null, Some → principal, vuoto/non-array → null', () => {
  assert.equal(optPrincipal([]), null);
  assert.equal(optPrincipal([SPAWNER]), SPAWNER);
  assert.equal(optPrincipal(null), null);
  assert.equal(optPrincipal(undefined), null);
});

// ─── controllersInclude ───────────────────────────────────────────────────────
test('controllersInclude: match per toText, null-safe', () => {
  assert.equal(controllersInclude([SPAWNER, PORTAL], SPAWNER), true);
  assert.equal(controllersInclude([PORTAL], SPAWNER), false);
  assert.equal(controllersInclude([SPAWNER], null), false);
  assert.equal(controllersInclude(null, SPAWNER), false);
  assert.equal(controllersInclude([], SPAWNER), false);
  // Confronta per identità testuale, non per riferimento oggetto.
  assert.equal(controllersInclude([P('spawner-aaaa')], SPAWNER), true);
});

// ─── parseMetadata ────────────────────────────────────────────────────────────
test('parseMetadata: null → null', () => {
  assert.equal(parseMetadata(null), null);
  assert.equal(parseMetadata(undefined), null);
});

test('parseMetadata: unwrap completo degli Opt', () => {
  const m = parseMetadata(raw());
  assert.equal(m.isStandalone, false);
  assert.equal(m.ejected, false);
  assert.equal(m.admin, ADMIN);
  assert.equal(m.spawner, SPAWNER);
  assert.equal(m.portalOwner, PORTAL);
  assert.equal(m.originalSpawner, SPAWNER);
  assert.equal(m.originalPortalOwner, PORTAL);
  assert.equal(m.tier, 1);
  assert.equal(m.wasmHash, 'abc123');
});

test('parseMetadata: backward-compat — campi assenti → null/None', () => {
  const m = parseMetadata({ is_standalone: false, ejected: true });
  assert.equal(m.admin, null);
  assert.equal(m.spawner, null);
  assert.equal(m.portalOwner, null);
  assert.equal(m.originalSpawner, null);
  assert.equal(m.originalPortalOwner, null);
  assert.equal(m.tier, 0);
  assert.equal(m.wasmHash, null);
  assert.equal(m.ejected, true);
});

// ─── deriveSovereignty: tabella di verità §5 ──────────────────────────────────
test('deriveSovereignty: meta null → null', () => {
  assert.equal(deriveSovereignty(null, []), null);
});

test('standalone: mode standalone, sotto-stati derivati ma irrilevanti', () => {
  const m = parseMetadata(raw({ is_standalone: true }));
  const s = deriveSovereignty(m, []);
  assert.equal(s.mode, 'standalone');
  assert.equal(s.statusKnown, true);
});

test('managed: spawner controller → easycanControls true, supportGranted false', () => {
  const m = parseMetadata(raw({ ejected: false }));
  const s = deriveSovereignty(m, [SELF, ADMIN, SPAWNER, PORTAL]);
  assert.equal(s.mode, 'managed');
  assert.equal(s.supportGranted, false); // support richiede ejected
  assert.equal(s.easycanControls, true);
  assert.equal(s.portalRemoved, false);
});

test('emancipated puro: spawner null e non controller → tutto false', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null }));
  const s = deriveSovereignty(m, [SELF, ADMIN, PORTAL]);
  assert.equal(s.mode, 'emancipated');
  assert.equal(s.supportGranted, false);
  assert.equal(s.easycanControls, false);
  assert.equal(s.portalRemoved, false);
});

test('emancipated + support: original_spawner ri-aggiunto → support/controls true', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null }));
  const s = deriveSovereignty(m, [SELF, ADMIN, SPAWNER, PORTAL]);
  assert.equal(s.mode, 'emancipated');
  assert.equal(s.supportGranted, true);
  assert.equal(s.easycanControls, true);
});

test('portalRemoved: portal_owner None ma original presente → true', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null, portal_owner: null }));
  const s = deriveSovereignty(m, [SELF, ADMIN]);
  assert.equal(s.portalRemoved, true);
});

test('portalRemoved: portal_owner presente → false', () => {
  const m = parseMetadata(raw());
  const s = deriveSovereignty(m, [SELF, ADMIN, SPAWNER, PORTAL]);
  assert.equal(s.portalRemoved, false);
});

test('portalRemoved: original_portal_owner mai settato → false anche se portal None', () => {
  const m = parseMetadata(raw({ portal_owner: null, original_portal_owner: null }));
  const s = deriveSovereignty(m, [SELF, ADMIN, SPAWNER]);
  assert.equal(s.portalRemoved, false);
});

test('controllers vuoto: emancipated puro (status noto ma lista vuota)', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null }));
  const s = deriveSovereignty(m, []);
  assert.equal(s.statusKnown, true);
  assert.equal(s.supportGranted, false);
  assert.equal(s.easycanControls, false);
});

test('controllers null: status non disponibile → sotto-stati null, mode/portal noti', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null, portal_owner: null }));
  const s = deriveSovereignty(m, null);
  assert.equal(s.statusKnown, false);
  assert.equal(s.supportGranted, null);
  assert.equal(s.easycanControls, null);
  // mode e portalRemoved restano derivabili dal solo metadata.
  assert.equal(s.mode, 'emancipated');
  assert.equal(s.portalRemoved, true);
});

test('re_enroll: ejected torna false → supportGranted false anche con spawner controller', () => {
  // Dopo re_enroll spawner è di nuovo Some e ejected false → managed, non support.
  const m = parseMetadata(raw({ ejected: false, spawner: SPAWNER }));
  const s = deriveSovereignty(m, [SELF, ADMIN, SPAWNER]);
  assert.equal(s.mode, 'managed');
  assert.equal(s.supportGranted, false);
  assert.equal(s.easycanControls, true);
});
