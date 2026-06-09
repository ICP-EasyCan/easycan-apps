/**
 * files.js — Encrypted file manager page
 *
 * Upload: read file as ArrayBuffer → encrypt → store as crud record
 * Download: fetch record → decrypt → create blob URL → download
 * Max ~60KB per file (cap-crud configured with max_record_bytes: 65536)
 */

import { el, render } from '@shared/ui/dom.js';
import { getActorFor } from '@shared/core/icp.js';
import { CANISTER_ID } from '@shared/core/config.js';
import { deriveKey, encrypt, decrypt } from '@shared/core/crypto.js';

const NS = 'files';
const CTX = 'vault';

async function filesKey() {
  const actor = await getActorFor(CANISTER_ID);
  return deriveKey(actor, CTX, { type: 'stored', dataId: NS });
}
const MAX_FILE_SIZE = 60_000; // ~60KB plaintext → ~60KB + 28 bytes encrypted

export async function renderFiles(container) {
  render(container,
    el('div', { class: 'page-vault' },
      el('div', { class: 'topbar' },
        el('span', { class: 'topbar-title' }, 'Encrypted Files'),
        el('div', { class: 'topbar-right' },
          el('button', { class: 'btn-primary small', onClick: triggerUpload }, '+ Upload'),
        ),
      ),
      el('div', { class: 'vault-content', id: 'files-list' },
        el('p', { class: 'hint', style: 'padding:1rem' }, 'Deriving key...'),
      ),
      el('input', { type: 'file', id: 'file-input', style: 'display:none', onChange: handleFileSelect }),
    ),
  );

  await loadFileList();
}

function triggerUpload() {
  document.getElementById('file-input')?.click();
}

async function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    alert(`File too large: max ${Math.round(MAX_FILE_SIZE / 1024)}KB`);
    return;
  }

  const statusEl = document.getElementById('files-list');
  if (statusEl) render(statusEl, el('p', { class: 'hint', style: 'padding:1rem' }, `Encrypting "${file.name}"...`));

  try {
    const arrayBuffer = await file.arrayBuffer();
    const key = await filesKey();

    // Encrypt the file content
    const encryptedContent = await encrypt(new Uint8Array(arrayBuffer), key);

    // Build metadata + encrypted content as a single blob
    const meta = JSON.stringify({ name: file.name, mime: file.type, size: file.size });
    const metaBytes = new TextEncoder().encode(meta);

    // Format: [metaLen (4 bytes LE)][meta JSON][encrypted content]
    const blob = new Uint8Array(4 + metaBytes.length + encryptedContent.length);
    const view = new DataView(blob.buffer);
    view.setUint32(0, metaBytes.length, true);
    blob.set(metaBytes, 4);
    blob.set(encryptedContent, 4 + metaBytes.length);

    // Store as crud record
    const actor = await getActorFor(CANISTER_ID);
    const result = await actor.create_record({ namespace: NS, data: blob });
    if (result.Err !== undefined) throw new Error(result.Err);

    // Reset file input and reload
    e.target.value = '';
    await loadFileList();
  } catch (err) {
    if (statusEl) render(statusEl, el('p', { class: 'error', style: 'padding:1rem' }, `Error: ${err.message}`));
  }
}

async function loadFileList() {
  const listEl = document.getElementById('files-list');
  if (!listEl) return;

  try {
    const actor = await getActorFor(CANISTER_ID);
    const result = await actor.list_records(NS, BigInt(0), BigInt(100));
    const records = result.records || [];

    if (records.length === 0) {
      render(listEl, el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, '\u{1F4C1}'),
        el('p', {}, 'No files saved yet'),
        el('button', { class: 'btn-primary', onClick: triggerUpload }, 'Upload your first'),
      ));
      return;
    }

    // Parse metadata (unencrypted header) from each record
    const items = records.map(rec => {
      const meta = parseFileMeta(rec.data);
      return el('div', { class: 'vault-item card' },
        el('div', { class: 'vault-item-main' },
          el('span', { class: 'vault-item-title' }, meta?.name || `File #${rec.id}`),
          el('span', { class: 'vault-item-sub' }, meta ? formatSize(meta.size) : 'encrypted'),
        ),
        el('div', { class: 'vault-item-actions' },
          el('button', { class: 'btn-icon small', onClick: () => downloadFile(rec) }, '\u2B07'),
          el('button', { class: 'btn-icon small', onClick: () => deleteFile(rec.id) }, '\u2716'),
        ),
      );
    });

    render(listEl, el('div', { class: 'vault-list' }, ...items));
  } catch (e) {
    render(listEl, el('p', { class: 'error', style: 'padding:1rem' }, `Error: ${e.message}`));
  }
}

function parseFileMeta(data) {
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaLen = view.getUint32(0, true);
    const metaStr = new TextDecoder().decode(bytes.slice(4, 4 + metaLen));
    return JSON.parse(metaStr);
  } catch {
    return null;
  }
}

async function downloadFile(rec) {
  try {
    const bytes = rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaLen = view.getUint32(0, true);
    const metaStr = new TextDecoder().decode(bytes.slice(4, 4 + metaLen));
    const meta = JSON.parse(metaStr);
    const encryptedContent = bytes.slice(4 + metaLen);

    const key = await filesKey();
    const plaintext = await decrypt(encryptedContent, key);

    const blob = new Blob([plaintext], { type: meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name || 'download';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(`Download error: ${e.message}`);
  }
}

async function deleteFile(id) {
  try {
    const actor = await getActorFor(CANISTER_ID);
    const result = await actor.delete_record(BigInt(id));
    if (result.Err !== undefined) throw new Error(result.Err);
    await loadFileList();
  } catch (e) {
    alert(`Deletion error: ${e.message}`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
