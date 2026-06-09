/**
 * capabilities/update/flow.js — Orchestrazione del self-upgrade (§B / Fase 2).
 *
 * Logica di protocollo separata dalla UI (`page.js`). `runUpgrade()` esegue i 6 passi
 * del flusso provato al gate browser+II; `rollbackToSnapshot()` la rete di sicurezza
 * manuale. Tutto via i wrapper di `@shared/core/management.js` (identità = controller).
 *
 * I 6 passi (cfr. self_upgrade_piano § Fase 2):
 *   1. fetch WASM dalla Release → verifica SHA-256 (Web Crypto) == manifest.wasm_sha256
 *   2. clear_chunk_store → slice ≤1 MiB → upload_chunk per pezzo (canister RUNNING)
 *   3. stop_canister → take_canister_snapshot (rete: lo snapshot richiede STOP)
 *   4. install_chunked_code(mode=upgrade, hash, wasm_module_hash) → start_canister
 *   5. fetch frontend.tar.gz → verifica → clear_assets → upload_asset_batch → finalize
 *   6. health-check: app_version() == manifest.version + ping query base
 *
 * Solo messenger, MAI vault. La finestra offline è solo stop→install→start (i chunk si
 * caricano a canister vivo). In caso di guasto, lo snapshot del passo 3 permette il
 * rollback manuale (UI in page.js; auto-rollback è Fase 3).
 */

import {
  clearChunkStore, uploadChunk, stopCanister, startCanister,
  takeSnapshot, loadSnapshot, installChunkedCode, hexToBytes, sliceChunks,
} from '../../core/management.js';
import { call, query } from '../../core/icp.js';

// ─── Mappa content-type (allineata a scripts/upload_assets.js) ──────────────────
const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

const ASSET_BATCH_BYTES = 1_500_000; // soglia per batch upload_asset_batch (< limite ingress)

/**
 * Esegue il flusso di upgrade completo. Non lancia: ritorna un esito strutturato così
 * che la UI possa offrire il rollback con lo snapshot già preso.
 *
 * @param {{
 *   canisterId: string,
 *   manifest: object,            // contratto release: wasm_url, wasm_sha256, frontend_url, frontend_sha256, version
 *   onProgress?: (step: string, detail?: string) => void,
 * }} opts
 * Il campo `phase` dice DOVE si è fermato il flusso: la UI lo usa per decidere
 * l'auto-rollback solo quando lo stato è stato davvero mutato oltre un riavvio pulito
 * (`frontend`/`health`); un fail a `fetch-wasm`/`chunks`/`snapshot`/`install` lascia il
 * vecchio codice intatto (il catch riavvia il canister) → niente da ripristinare.
 *
 * @returns {Promise<{ ok: boolean, phase: string, snapshotId: Uint8Array|null, error?: string }>}
 */
export async function runUpgrade({ canisterId, manifest, onProgress = () => {} }) {
  let snapshotId = null;
  let stopped = false;
  let phase = 'fetch-wasm';
  try {
    // ── Passo 1: WASM verificato ───────────────────────────────────────────────
    onProgress('fetch-wasm', 'Downloading the new version…');
    const wasm = await fetchVerified(manifest.wasm_url, manifest.wasm_sha256, 'WASM');

    // ── Passo 2: chunk store (canister ancora RUNNING) ──────────────────────────
    phase = 'chunks';
    onProgress('chunks', 'Uploading code in chunks…');
    await clearChunkStore(canisterId);
    const chunks = sliceChunks(wasm); // ≤ 1 MiB
    const chunkHashes = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress('chunks', `Uploading chunk ${i + 1}/${chunks.length}…`);
      // copia in un Uint8Array proprio: il subarray condivide il buffer e può confondere il serializer.
      chunkHashes.push(await uploadChunk(canisterId, new Uint8Array(chunks[i])));
    }

    // ── Passo 3: stop + snapshot (rete di sicurezza) ────────────────────────────
    phase = 'snapshot';
    onProgress('snapshot', 'Stopping the app and taking a safety snapshot…');
    await stopCanister(canisterId);
    stopped = true;
    const snap = await takeSnapshot(canisterId);
    snapshotId = snap.id;

    // ── Passo 4: install (mode=upgrade) + start ─────────────────────────────────
    phase = 'install';
    onProgress('install', 'Installing the new version…');
    await installChunkedCode(canisterId, chunkHashes, hexToBytes(manifest.wasm_sha256));
    await startCanister(canisterId);
    stopped = false;

    // ── Passo 5: frontend (clear + re-upload + finalize) ────────────────────────
    phase = 'frontend';
    onProgress('frontend', 'Updating the app interface…');
    const tarGz = await fetchVerified(manifest.frontend_url, manifest.frontend_sha256, 'frontend');
    const files = await untarGz(tarGz);
    await call(canisterId, 'clear_assets');
    await uploadAssetsBatched(canisterId, files, onProgress);
    await call(canisterId, 'finalize_assets');

    // ── Passo 6: health-check ───────────────────────────────────────────────────
    phase = 'health';
    onProgress('health', 'Verifying the upgrade…');
    await healthCheck(canisterId, manifest.version);

    phase = 'done';
    onProgress('done', 'Update complete.');
    return { ok: true, phase, snapshotId };
  } catch (e) {
    // Se siamo morti a canister fermo, prova a riavviarlo per non lasciare l'app down.
    if (stopped) {
      try { await startCanister(canisterId); } catch { /* la UI offrirà il rollback */ }
    }
    return { ok: false, phase, snapshotId, error: e?.message || String(e) };
  }
}

/**
 * Rollback manuale allo snapshot preso prima dell'upgrade: stop → load → start.
 * Provato allo spike: l'hash on-chain torna al precedente, lo stato è ripristinato.
 * @param {{ canisterId: string, snapshotId: Uint8Array, onProgress?: Function }} opts
 */
export async function rollbackToSnapshot({ canisterId, snapshotId, onProgress = () => {} }) {
  onProgress('rollback', 'Stopping the app…');
  await stopCanister(canisterId);
  try {
    onProgress('rollback', 'Restoring the previous version…');
    await loadSnapshot(canisterId, snapshotId);
  } finally {
    onProgress('rollback', 'Restarting the app…');
    await startCanister(canisterId);
  }
}

// ─── Fetch + verifica SHA-256 ───────────────────────────────────────────────────

async function fetchVerified(url, expectedSha, label) {
  if (!url) throw new Error(`Missing ${label} URL in the release manifest.`);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to download ${label} (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (expectedSha) {
    const actual = await sha256Hex(bytes);
    if (actual !== String(expectedSha).trim().toLowerCase()) {
      throw new Error(`${label} hash mismatch — refusing to install (expected ${expectedSha}, got ${actual}).`);
    }
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Re-upload asset (gunzip + untar + batch) ───────────────────────────────────

async function uploadAssetsBatched(canisterId, files, onProgress) {
  let batch = [];
  let batchBytes = 0;
  let done = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await call(canisterId, 'upload_asset_batch', batch);
    done += batch.length;
    onProgress('frontend', `Uploaded ${done}/${files.length} files…`);
    batch = [];
    batchBytes = 0;
  };
  for (const f of files) {
    if (batchBytes + f.bytes.length > ASSET_BATCH_BYTES && batch.length > 0) {
      await flush();
    }
    batch.push([f.path, f.contentType, f.bytes]);
    batchBytes += f.bytes.length;
  }
  await flush();
}

/** Decomprime un gzip+tar in memoria → [{ path, contentType, bytes }]. */
async function untarGz(tarGzBytes) {
  const tar = await gunzip(tarGzBytes);
  return untar(tar);
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the update bundle (no DecompressionStream).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parser tar minimale (ustar). Il bundle è prodotto da `tar -czf -C dist .` → entry
 * con prefisso `./`. Gestisce solo file regolari; salta directory e voci di estensione
 * GNU/pax (nomi lunghi non attesi: i file Vite stanno sotto i 100 char).
 */
function untar(buf) {
  const files = [];
  const BLOCK = 512;
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // Due blocchi azzerati = fine archivio.
    if (header.every((b) => b === 0)) break;

    const name = readStr(header, 0, 100);
    const prefix = readStr(header, 345, 155);
    const size = parseInt(readStr(header, 124, 12).trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = off + BLOCK;
    const fullName = (prefix ? `${prefix}/` : '') + name;

    // typeflag '0' o '\0' = file regolare. Tutto il resto (dir '5', longname 'L', pax 'x'/'g') → skip data.
    if ((typeflag === '0' || typeflag === '\0') && size > 0) {
      const clean = '/' + fullName.replace(/^\.\//, '').replace(/^\/+/, '');
      files.push({
        path: clean,
        contentType: contentTypeFor(clean),
        bytes: new Uint8Array(buf.subarray(dataStart, dataStart + size)),
      });
    }
    // Avanza: header + dati (paddati al blocco da 512).
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

function readStr(block, start, len) {
  let end = start;
  const limit = start + len;
  while (end < limit && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(start, end));
}

function contentTypeFor(path) {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// ─── Health-check post-upgrade ──────────────────────────────────────────────────

async function healthCheck(canisterId, expectedVersion) {
  // app_version() deve rispondere e combaciare col manifest.
  const v = await query(canisterId, 'app_version');
  if (typeof v !== 'string') throw new Error('Health-check failed: app_version() did not respond.');
  if (expectedVersion && stripV(v) !== stripV(expectedVersion)) {
    throw new Error(`Health-check failed: running v${v}, expected v${expectedVersion}.`);
  }
  // Ping a un metodo base: il canister risponde alle query → vivo.
  await query(canisterId, 'get_user_principal');
}

function stripV(v) {
  return String(v).trim().replace(/^v/i, '');
}
