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
  systemPrincipals,
  deriveBackupKeys,
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

test('managed: spawner ancora presente → mode managed', () => {
  const m = parseMetadata(raw({ ejected: false }));
  const s = deriveSovereignty(m, [SELF, ADMIN, SPAWNER, PORTAL]);
  assert.equal(s.mode, 'managed');
  assert.equal(s.portalRemoved, false);
});

test('emancipated: spawner null → mode emancipated (post-F4 EasyCan mai controller)', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null }));
  const s = deriveSovereignty(m, [SELF, ADMIN, PORTAL]);
  assert.equal(s.mode, 'emancipated');
  assert.equal(s.portalRemoved, false);
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

test('controllers vuoto: statusKnown true (lista nota ma vuota)', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null }));
  const s = deriveSovereignty(m, []);
  assert.equal(s.statusKnown, true);
  assert.equal(s.mode, 'emancipated');
});

test('controllers null: status non disponibile → statusKnown false, mode/portal noti', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null, portal_owner: null }));
  const s = deriveSovereignty(m, null);
  assert.equal(s.statusKnown, false);
  // mode e portalRemoved restano derivabili dal solo metadata.
  assert.equal(s.mode, 'emancipated');
  assert.equal(s.portalRemoved, true);
});

// ─── Backup key (F2 self-install) ─────────────────────────────────────────────

const BACKUP = P('backup-eeee');
const BACKUP2 = P('backup-ffff');

test('deriveBackupKeys: solo i controller non-di-sistema sono backup key', () => {
  const m = parseMetadata(raw());
  // controllers = self + admin + EasyCan(spawner) + portal + 1 backup utente.
  const ctrls = [SELF, ADMIN, SPAWNER, PORTAL, BACKUP];
  const keys = deriveBackupKeys(m, ctrls, {
    appAdmin: ADMIN, myPrincipal: ADMIN, selfPrincipal: SELF,
  });
  assert.deepEqual(keys.map((k) => k.toText()), ['backup-eeee']);
});

test('deriveBackupKeys: nessuna backup key quando ci sono solo identità di sistema', () => {
  const m = parseMetadata(raw());
  const keys = deriveBackupKeys(m, [SELF, ADMIN, SPAWNER, PORTAL], {
    appAdmin: ADMIN, myPrincipal: ADMIN, selfPrincipal: SELF,
  });
  assert.equal(keys.length, 0);
});

test('deriveBackupKeys: più backup key tutte rilevate', () => {
  const m = parseMetadata(raw());
  const keys = deriveBackupKeys(m, [SELF, ADMIN, BACKUP, BACKUP2], {
    appAdmin: ADMIN, myPrincipal: ADMIN, selfPrincipal: SELF,
  });
  assert.deepEqual(keys.map((k) => k.toText()).sort(), ['backup-eeee', 'backup-ffff']);
});

test('deriveBackupKeys: il portale RIMOSSO (original_portal_owner) non conta come backup', () => {
  // Post-remove-portal: portal_owner None ma original_portal_owner ancora noto.
  const m = parseMetadata(raw({ portal_owner: null }));
  const keys = deriveBackupKeys(m, [SELF, ADMIN, PORTAL, BACKUP], {
    appAdmin: ADMIN, myPrincipal: ADMIN, selfPrincipal: SELF,
  });
  // PORTAL è ancora original_portal_owner → di sistema, non backup.
  assert.deepEqual(keys.map((k) => k.toText()), ['backup-eeee']);
});

test('deriveBackupKeys: original_spawner (EasyCan) non è mai una backup key', () => {
  const m = parseMetadata(raw({ ejected: true, spawner: null }));
  // Difesa: anche se original_spawner comparisse tra i controller, resta un
  // principal di sistema (EasyCan), mai scambiato per una backup key dell'utente.
  const keys = deriveBackupKeys(m, [SELF, ADMIN, SPAWNER, BACKUP], {
    appAdmin: ADMIN, myPrincipal: ADMIN, selfPrincipal: SELF,
  });
  assert.deepEqual(keys.map((k) => k.toText()), ['backup-eeee']);
});

test('deriveBackupKeys: meta null → nessuna backup key (degrada pulito)', () => {
  assert.deepEqual(deriveBackupKeys(null, [SELF, BACKUP], {}), []);
});

test('systemPrincipals: include self/admin/spawner/portal attuali e originali', () => {
  const m = parseMetadata(raw());
  const sys = systemPrincipals(m, { appAdmin: ADMIN, myPrincipal: ADMIN, selfPrincipal: SELF });
  assert.equal(sys.has('self-dddd'), true);
  assert.equal(sys.has('admin-cccc'), true);
  assert.equal(sys.has('spawner-aaaa'), true);
  assert.equal(sys.has('portal-bbbb'), true);
  assert.equal(sys.has('backup-eeee'), false);
});
