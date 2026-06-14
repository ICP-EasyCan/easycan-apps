/**
 * management.js — Helper generici per il management canister (aaaaa-aa).
 *
 * Codice 100% app-agnostico: usa solo @shared/core/{config,auth}. L'identità
 * app-origin dell'utente è tra i controller dopo il claim, quindi può invocare
 * canister_status direttamente.
 *
 *   import { listControllers } from '@shared/core/management.js';
 *   const ctrls = await listControllers(canisterId); // Principal[]
 */

import { Actor, HttpAgent, CanisterStatus } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { IDL } from '@dfinity/candid';
import { IC_HOST, IS_LOCAL } from './config.js';
import { getIdentity } from './auth.js';

const managementIdl = ({ IDL: I }) => {
  const canister_id = I.Principal;

  const DefiniteCanisterSettings = I.Record({
    controllers: I.Vec(I.Principal),
    compute_allocation: I.Nat,
    memory_allocation: I.Nat,
    freezing_threshold: I.Nat,
  });

  const CanisterStatusResponse = I.Record({
    status: I.Variant({ running: I.Null, stopping: I.Null, stopped: I.Null }),
    settings: DefiniteCanisterSettings,
    module_hash: I.Opt(I.Vec(I.Nat8)),
    memory_size: I.Nat,
    cycles: I.Nat,
  });

  // ── Self-upgrade §B / Fase 2 — chunked install + snapshot ──────────────────
  // Shape esatte del management canister (allineate a @dfinity/agent 3.4.3).
  const chunk_hash = I.Record({ hash: I.Vec(I.Nat8) });
  const snapshot_id = I.Vec(I.Nat8);
  const snapshot = I.Record({
    id: snapshot_id,
    total_size: I.Nat64,
    taken_at_timestamp: I.Nat64,
  });
  const canister_install_mode = I.Variant({
    reinstall: I.Null,
    upgrade: I.Opt(I.Record({
      wasm_memory_persistence: I.Opt(I.Variant({ keep: I.Null, replace: I.Null })),
      skip_pre_upgrade: I.Opt(I.Bool),
    })),
    install: I.Null,
  });

  return I.Service({
    canister_status: I.Func(
      [I.Record({ canister_id: I.Principal })],
      [CanisterStatusResponse],
      [],
    ),
    stop_canister: I.Func([I.Record({ canister_id })], [], []),
    start_canister: I.Func([I.Record({ canister_id })], [], []),
    clear_chunk_store: I.Func([I.Record({ canister_id })], [], []),
    upload_chunk: I.Func(
      [I.Record({ canister_id, chunk: I.Vec(I.Nat8) })],
      [chunk_hash],
      [],
    ),
    install_chunked_code: I.Func(
      [I.Record({
        arg: I.Vec(I.Nat8),
        wasm_module_hash: I.Vec(I.Nat8),
        mode: canister_install_mode,
        chunk_hashes_list: I.Vec(chunk_hash),
        target_canister: canister_id,
        store_canister: I.Opt(canister_id),
        sender_canister_version: I.Opt(I.Nat64),
      })],
      [],
      [],
    ),
    take_canister_snapshot: I.Func(
      [I.Record({ canister_id, replace_snapshot: I.Opt(snapshot_id) })],
      [snapshot],
      [],
    ),
    list_canister_snapshots: I.Func(
      [I.Record({ canister_id })],
      [I.Vec(snapshot)],
      [],
    ),
    load_canister_snapshot: I.Func(
      [I.Record({
        canister_id,
        snapshot_id,
        sender_canister_version: I.Opt(I.Nat64),
      })],
      [],
      [],
    ),
    delete_canister_snapshot: I.Func(
      [I.Record({ canister_id, snapshot_id })],
      [],
      [],
    ),
  });
};

async function getManagement(effectiveCanisterId) {
  const identity = getIdentity();
  const agent = await HttpAgent.create({ identity, host: IC_HOST });
  if (IS_LOCAL) {
    await agent.fetchRootKey().catch(console.warn);
  }
  return Actor.createActor(managementIdl, {
    agent,
    canisterId: Principal.fromText('aaaaa-aa'),
    effectiveCanisterId,
  });
}

/**
 * Lista i controller del canister target.
 * Il caller deve essere un controller (vero per la app-origin identity post-claim).
 * @param {string} canisterIdText
 * @returns {Promise<import('@dfinity/principal').Principal[]>}
 */
export async function listControllers(canisterIdText) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  const status = await mgmt.canister_status({ canister_id: target });
  return status.settings.controllers;
}

/**
 * Legge il `module_hash` del canister via `read_state` certificato (path
 * `/canister/<id>/module_hash`), la stessa via di `dfx canister info` e della
 * dashboard IC. A differenza di `canister_status` (mgmt canister, controller-only):
 *  - usa un agent **anonimo** → nessun login richiesto per vederlo;
 *  - la risposta è verificata contro la root key dell'IC → valore non falsificabile;
 *  - esiste già appena il canister è coniato (provision), pre/post claim.
 *
 * @param {string} canisterIdText
 * @returns {Promise<string|null>} hash esadecimale (senza prefisso) o null se assente.
 */
export async function getModuleHash(canisterIdText) {
  const canisterId = Principal.fromText(canisterIdText);
  // Agent anonimo: niente getIdentity(). fetchRootKey solo in locale (replica).
  const agent = await HttpAgent.create({ host: IC_HOST });
  if (IS_LOCAL) {
    await agent.fetchRootKey().catch(console.warn);
  }
  const status = await CanisterStatus.request({
    canisterId,
    agent,
    paths: ['module_hash'],
  });
  // Path 'module_hash' → già decodificato hex dal pacchetto (bytesToHex); null se assente.
  const hash = status.get('module_hash');
  return typeof hash === 'string' ? hash : null;
}

// ─── Self-upgrade §B / Fase 2 — scritture (identità = controller) ───────────────
//
// Tutte usano getManagement(target): identità app-origin (controller post-claim) +
// effectiveCanisterId = il canister stesso (insieme chunk store e target). Provate al
// gate browser+II (2026-06-07). Solo su messenger, MAI vault (cfr. self_upgrade_piano).

/** Svuota lo store dei chunk del canister (idempotente). */
export async function clearChunkStore(canisterIdText) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  await mgmt.clear_chunk_store({ canister_id: target });
}

/**
 * Carica un chunk WASM nello store del canister (canister ancora running).
 * @param {string} canisterIdText
 * @param {Uint8Array} chunk — pezzo ≤ 1 MiB (upload_chunk vuole Vec(Nat8); accetta Uint8Array)
 * @returns {Promise<Uint8Array>} lo SHA-256 del chunk (record { hash }) — entra in chunk_hashes_list.
 */
export async function uploadChunk(canisterIdText, chunk) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  const res = await mgmt.upload_chunk({ canister_id: target, chunk });
  return res.hash; // Uint8Array
}

/** Ferma il canister (richiesto prima di snapshot/install). */
export async function stopCanister(canisterIdText) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  await mgmt.stop_canister({ canister_id: target });
}

/** Riavvia il canister. */
export async function startCanister(canisterIdText) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  await mgmt.start_canister({ canister_id: target });
}

/**
 * Cattura uno snapshot pre-upgrade (Wasm + heap + stable + chunk store). Richiede canister STOPPED.
 *
 * Retention: tiene al massimo `maxRetained` snapshot. Se si è già al limite, **riusa lo slot
 * più vecchio** via `replace_snapshot` (replace = delete-vecchio + create-nuovo atomico). Senza
 * questo, ogni upgrade ne creerebbe uno nuovo fino al tetto di 10 per canister → all'11° l'upgrade
 * si bloccherebbe (lockout), e ogni snapshot è una copia integrale (costo cicli storage, molto
 * pesante su un vault pieno). `maxRetained=2` (default) conserva un punto di "ripensamento tardivo"
 * (la versione precedente) senza crescita illimitata.
 *
 * @param {string} canisterIdText
 * @param {{ maxRetained?: number }} [opts] — N snapshot da tenere (default 2). 0 = sempre nuovo.
 * @returns {Promise<{ id: Uint8Array, total_size: bigint, taken_at_timestamp: bigint }>}
 */
export async function takeSnapshot(canisterIdText, { maxRetained = 2 } = {}) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  let replaceSnapshot = [];
  if (maxRetained > 0) {
    const snaps = await mgmt.list_canister_snapshots({ canister_id: target });
    if (snaps.length >= maxRetained) {
      // Più vecchio (taken_at_timestamp minore) = lo slot da riusare.
      const oldest = [...snaps].sort((a, b) =>
        a.taken_at_timestamp < b.taken_at_timestamp ? -1 : 1)[0];
      replaceSnapshot = [oldest.id];
    }
  }
  return mgmt.take_canister_snapshot({ canister_id: target, replace_snapshot: replaceSnapshot });
}

/** Lista gli snapshot del canister (per la UI di rollback). */
export async function listSnapshots(canisterIdText) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  return mgmt.list_canister_snapshots({ canister_id: target });
}

/**
 * Cancella uno snapshot (bottone Delete manuale nella lista restore). Non richiede STOP.
 * @param {string} canisterIdText
 * @param {Uint8Array} snapshotId
 */
export async function deleteSnapshot(canisterIdText, snapshotId) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  await mgmt.delete_canister_snapshot({ canister_id: target, snapshot_id: snapshotId });
}

/**
 * Ripristina uno snapshot. Richiede canister STOPPED (poi va riavviato).
 * @param {string} canisterIdText
 * @param {Uint8Array} snapshotId
 */
export async function loadSnapshot(canisterIdText, snapshotId) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  await mgmt.load_canister_snapshot({
    canister_id: target,
    snapshot_id: snapshotId,
    sender_canister_version: [],
  });
}

/**
 * Installa il WASM dai chunk caricati. La replica valida che l'hash assemblato ==
 * wasm_module_hash. Due modi:
 *   - `'upgrade'` (default, self-upgrade §B): preserva la stable memory via
 *     pre/post_upgrade — stessa app, versione nuova.
 *   - `'reinstall'` (Arco B, cambio-app L2): AZZERA la stable memory — installa
 *     un'app DIVERSA sopra quella corrente, i dati dell'app uscente si perdono
 *     (semantica onesta L2). Gemello dell'upgrade ma con `mode={reinstall:null}`.
 * @param {string} canisterIdText
 * @param {Uint8Array[]} chunkHashes — hash dei chunk in ordine (da uploadChunk)
 * @param {Uint8Array} wasmModuleHash — = manifest.wasm_sha256 (hex→bytes), prova on-chain
 * @param {'upgrade'|'reinstall'} [mode='upgrade']
 * @param {{spawnerId: string, factoryId: string}|null} [platformInit=null] — per
 *   mode='reinstall': l'init dell'app (feature platform) vuole (spawner, factory).
 *   Ignorato per 'upgrade' (post_upgrade zero-arg).
 */
export async function installChunkedCode(canisterIdText, chunkHashes, wasmModuleHash, mode = 'upgrade', platformInit = null) {
  const target = Principal.fromText(canisterIdText);
  const mgmt = await getManagement(target);
  // `upgrade` è una variante Opt(Record) → `[]` = None (default upgrade); `reinstall`
  // è I.Null → `null`. Passare la forma sbagliata fa fallire la decodifica Candid.
  const installMode = mode === 'reinstall' ? { reinstall: null } : { upgrade: [] };
  // L'arg dell'init dipende dal mode: upgrade → post_upgrade() zero-arg (vuoto);
  // reinstall → esegue init(spawner, factory) (app feature platform) → va encodato,
  // o Candid trappa "Cannot parse header" (BUG-13). cap-platform branca poi sul
  // caller (P_app_frontend ≠ factory → adozione sovrana, niente finestra spawner).
  let arg = new Uint8Array();
  if (mode === 'reinstall') {
    if (!platformInit?.spawnerId || !platformInit?.factoryId) {
      throw new Error('installChunkedCode(reinstall): mancano spawnerId/factoryId per l\'init dell\'app');
    }
    arg = new Uint8Array(IDL.encode(
      [IDL.Principal, IDL.Principal],
      [Principal.fromText(platformInit.spawnerId), Principal.fromText(platformInit.factoryId)],
    ));
  }
  await mgmt.install_chunked_code({
    arg,
    wasm_module_hash: wasmModuleHash,
    mode: installMode,
    chunk_hashes_list: chunkHashes.map((hash) => ({ hash })),
    target_canister: target,
    store_canister: [],                           // None → lo store è il target stesso
    sender_canister_version: [],
  });
}

// ─── Helper byte ────────────────────────────────────────────────────────────────

/** hex (senza prefisso) → Uint8Array. Per passare manifest.wasm_sha256 a installChunkedCode. */
export function hexToBytes(hex) {
  const clean = String(hex).trim().toLowerCase().replace(/^0x/, '');
  if (clean.length % 2 !== 0) throw new Error('hexToBytes: lunghezza dispari');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** Spezza un Uint8Array in pezzi di al massimo `size` byte (default 1 MiB). */
export function sliceChunks(bytes, size = 1024 * 1024) {
  const chunks = [];
  for (let off = 0; off < bytes.length; off += size) {
    chunks.push(bytes.subarray(off, Math.min(off + size, bytes.length)));
  }
  return chunks;
}
