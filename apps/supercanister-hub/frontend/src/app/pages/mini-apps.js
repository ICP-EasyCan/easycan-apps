/**
 * mini-apps.js — la pagina UNICA delle mini-app (fonde l'ex Launcher + ex Store).
 *
 * Un solo concetto per l'utente — "le app" — visto dall'alto verso il basso:
 *  - "Your apps": le mini-app installate (list_bundles). Apri → #run/{id} (iframe sandboxed),
 *    Disinstalla → uninstall_bundle (i dati KV restano).
 *  - "Add an app": il catalogo verificabile per hash (store-index.json da GitHub raw) → per-bundle
 *    manifest + artifact → verifica sha256 NEL BROWSER (solo UX) → install_bundle. Il GATE autorevole
 *    resta IN-CANISTER (cap-store ricalcola sha256 e rifiuta senza stato su mismatch).
 *  - "Install from file (developer)": sideload `.bundle` per lo sviluppo, sotto un <details> chiuso —
 *    fuori dalla vista del neofita. Stesso install_bundle, stessa garanzia in-canister.
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate }   from '@shared/ui/router.js';
import { listBundles, uninstallBundle, installBundle } from '../../lib/hub-api.js';
import { toast, permissionBadges, pageHeader } from '../../lib/ui.js';

const HEADER_SUB = 'Apps that extend your computer — each verified by hash, sandboxed to the permissions you approve.';

// Catalogo curato (F5). Finché il repo non esiste, il fetch fallisce → si mostra solo il path dev.
const STORE_INDEX_URL =
  'https://raw.githubusercontent.com/ICP-EasyCan/bundle-store/main/store-index.json';

const EMPTY_PERMS = {
  storage_namespaces: [], http_outcall_hosts: [], inter_canister: [],
  uses_crypto: false, uses_timer: false,
};

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function renderMiniApps(container) {
  render(container, pageHeader('Mini-apps', HEADER_SUB), el('p', { class: 'muted' }, 'Loading…'));

  let bundles = [];
  let index = null;
  let fetchError = null;

  // Le app installate sono il cuore: se falliscono, la pagina lo dice. Il catalogo è accessorio.
  try {
    bundles = await listBundles();
  } catch (e) {
    render(container, pageHeader('Mini-apps', HEADER_SUB), el('p', { class: 'error' }, `Failed to load: ${e.message}`));
    return;
  }
  try {
    const res = await fetch(STORE_INDEX_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    index = await res.json();
  } catch (e) {
    fetchError = e.message || String(e);
  }

  render(container,
    pageHeader('Mini-apps', HEADER_SUB),
    yourAppsSection(bundles, container),
    addAppSection(index, fetchError, container),
    devInstallSection(container),
  );
}

// ─── "Your apps" — le mini-app installate ──────────────────────────────────────

function yourAppsSection(bundles, container) {
  const body = bundles.length
    ? el('div', { class: 'grid' }, ...bundles.map((b) => bundleCard(b, container)))
    : el('div', { class: 'empty' }, el('p', {}, 'No apps installed yet — add one below ↓'));

  return el('div', { class: 'section' },
    el('h2', {}, `Your apps${bundles.length ? ` (${bundles.length})` : ''}`),
    body);
}

function bundleCard(b, container) {
  return el('div', { class: 'card' },
    el('h3', {}, b.module_id),
    el('div', { class: 'meta' }, `v${b.version} · ${b.files.length} files · ${Number(b.size_bytes)} bytes`),
    el('div', { class: 'mono muted', style: 'margin-top:0.4rem; font-size:0.72rem;' }, `sha256 ${b.sha256.slice(0, 16)}…`),
    el('div', { style: 'margin-top:0.5rem;' }, ...permissionBadges(b.permissions)),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn-primary', onclick: () => navigate(`#run/${b.module_id}`) }, 'Open'),
      el('button', { class: 'btn-danger', onclick: () => doUninstall(b.module_id, container) }, 'Uninstall'),
    ),
  );
}

async function doUninstall(id, container) {
  if (!confirm(`Uninstall "${id}"? Its stored data is kept; you can reinstall later.`)) return;
  try {
    await uninstallBundle(id);
    toast('Uninstalled', 'ok');
    renderMiniApps(container);
  } catch (e) {
    toast(`Uninstall failed: ${e.message}`, 'err');
  }
}

// ─── "Add an app" — il catalogo (GitHub raw) ────────────────────────────────────

function addAppSection(index, fetchError, container) {
  if (index?.bundles?.length) {
    return el('div', { class: 'section' },
      el('h2', {}, 'Add an app'),
      index.store_name ? el('p', { class: 'muted', style: 'margin:0 0 0.7rem;' }, index.store_name) : null,
      el('div', { class: 'grid' }, ...index.bundles.map((b) => catalogCard(b, container))));
  }
  return el('div', { class: 'section' },
    el('h2', {}, 'Add an app'),
    el('div', { class: 'empty' },
      el('p', {}, fetchError ? `Catalog unavailable (${fetchError}).` : 'No apps in the catalog yet.'),
      el('p', { class: 'muted' }, 'You can still sideload a local .bundle from the developer section below.')));
}

function catalogCard(entry, container) {
  return el('div', { class: 'card' },
    el('h3', {}, entry.name || entry.bundle_id),
    el('div', { class: 'meta' }, `${entry.category || ''} · v${entry.latest_version || '?'}`),
    entry.summary ? el('p', { class: 'muted', style: 'font-size:0.85rem;' }, entry.summary) : null,
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn-primary', onclick: (ev) => installFromCatalog(entry, ev.target, container) }, 'Install')),
  );
}

async function installFromCatalog(entry, btn, container) {
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const manifest = await (await fetch(entry.manifest_url, { cache: 'no-store' })).json();
    const artifactRes = await fetch(manifest.artifact_url, { cache: 'no-store' });
    if (!artifactRes.ok) throw new Error(`artifact HTTP ${artifactRes.status}`);
    const bytes = new Uint8Array(await artifactRes.arrayBuffer());

    const localHash = await sha256Hex(bytes);
    if (localHash !== manifest.artifact_sha256) {
      throw new Error('browser sha256 ≠ manifest — refusing to install');
    }

    const perms = { ...EMPTY_PERMS, ...(manifest.permissions || {}) };
    if (!confirmPermissions(manifest.bundle_id, perms)) { btn.disabled = false; btn.textContent = 'Install'; return; }

    await installBundle(manifest.bundle_id, bytes, manifest.artifact_sha256, manifest.version, perms);
    toast(`Installed ${manifest.bundle_id}`, 'ok');
    renderMiniApps(container);   // re-render in pagina: l'app appare in "Your apps", niente cambio rotta
  } catch (e) {
    toast(`Install failed: ${e.message}`, 'err');
    btn.disabled = false;
    btn.textContent = 'Install';
  }
}

// ─── "Install from file (developer)" — sideload, sotto un <details> chiuso ───────

function devInstallSection(container) {
  const idIn = el('input', { type: 'text', placeholder: 'com.example.myapp' });
  const verIn = el('input', { type: 'text', placeholder: '1.0.0', value: '1.0.0' });
  const nsIn = el('input', { type: 'text', placeholder: 'com.example.myapp, com.example.shared' });

  const fileName = el('span', { class: 'muted small', style: 'margin-left:0.6rem;' }, 'No file chosen');
  const submit = el('button', { class: 'btn-primary', disabled: 'true', onclick: () => doDevInstall() }, 'Install from file');

  // Input file nativo nascosto: il suo chrome ("Scegli file / Nessun file selezionato") è
  // localizzato dal browser → lo sostituiamo con un bottone/label custom in inglese.
  const fileIn = el('input', {
    type: 'file', accept: '.bundle,application/octet-stream', style: 'display:none;',
    onchange: () => {
      const f = fileIn.files?.[0];
      fileName.textContent = f ? f.name : 'No file chosen';
      submit.disabled = !f;
    },
  });
  const fileBtn = el('label', { class: 'btn-secondary', style: 'cursor:pointer;' }, 'Choose .bundle file…', fileIn);

  async function doDevInstall() {
    const moduleId = idIn.value.trim();
    const version = verIn.value.trim() || '0.0.0';
    const namespaces = nsIn.value.split(',').map((s) => s.trim()).filter(Boolean);
    const file = fileIn.files?.[0];
    if (!moduleId || !file) { toast('Module id and .bundle file are required', 'err'); return; }

    submit.disabled = true;
    submit.textContent = 'Installing…';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(bytes); // il canister ricalcola e impone: gate autorevole
      const perms = { ...EMPTY_PERMS, storage_namespaces: namespaces };
      if (!confirmPermissions(moduleId, perms)) { submit.disabled = false; submit.textContent = 'Install from file'; return; }
      await installBundle(moduleId, bytes, hash, version, perms);
      toast(`Installed ${moduleId}`, 'ok');
      renderMiniApps(container);
    } catch (e) {
      toast(`Install failed: ${e.message}`, 'err');
      submit.disabled = false;
      submit.textContent = 'Install from file';
    }
  }

  return el('details', { class: 'section' },
    el('summary', {}, 'Install from file (developer)'),
    el('p', { class: 'muted', style: 'font-size:0.85rem;' },
      'Developer sideload. Module id and storage namespaces match the bundle folder name (e.g. com.easycan.todo). The canister recomputes the sha256 and rejects on mismatch — same gate as the catalog.'),
    el('label', {}, 'Module id'), idIn,
    el('div', { class: 'form-row' },
      el('div', {}, el('label', {}, 'Version'), verIn),
      el('div', { style: 'flex:3;' }, el('label', {}, 'Storage namespaces (comma-separated)'), nsIn)),
    el('label', {}, '.bundle file'),
    el('div', { style: 'display:flex; align-items:center; flex-wrap:wrap; gap:0.3rem; margin-top:0.25rem;' }, fileBtn, fileName),
    el('div', { style: 'margin-top:0.9rem;' }, submit),
  );
}

// ─── Prompt permessi (consenso esplicito prima dell'install) ───────────────────

function confirmPermissions(id, perms) {
  const lines = [];
  if (perms.storage_namespaces.length) lines.push(`• store data in: ${perms.storage_namespaces.join(', ')}`);
  if (perms.http_outcall_hosts.length) lines.push(`• call hosts: ${perms.http_outcall_hosts.join(', ')}`);
  if (perms.inter_canister.length) lines.push(`• call canisters: ${perms.inter_canister.join(', ')}`);
  if (perms.uses_crypto) lines.push('• use cryptography');
  if (perms.uses_timer) lines.push('• run on a timer');
  const body = lines.length ? lines.join('\n') : '(no special permissions)';
  return confirm(`Install "${id}"?\n\nThis mini-app will be allowed to:\n${body}\n\nIt runs sandboxed and confined to exactly these permissions.`);
}
