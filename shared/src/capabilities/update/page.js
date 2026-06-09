/**
 * capabilities/update/page.js — Sottopagina "Check for updates" drop-in (READ-ONLY).
 *
 * Terza gemella di `verify/page.js` e `sovereignty/page.js`, stesso contratto host:
 *   - #sovereignty → "CHI controlla l'app"  (controllers + safety net)
 *   - #verify      → "QUALE codice gira"     (module_hash certificato)
 *   - #update      → "C'È un aggiornamento?" (versione corrente vs ultima release)
 *
 * Self-upgrade §B: legge il manifest dell'ultima release e lo confronta con la versione
 * installata; con `enableInstall` esegue anche l'install in-app (Fase 2/3). Il manifest e
 * gli artefatti vivono su un branch `dist` del repo pubblico e si scaricano via
 * `raw.githubusercontent.com` (header CORS `*`, a differenza dei release-asset GitHub che
 * non li hanno → fetch() browser bloccato). Cfr. [[github_release_assets_no_cors]] + BACKLOG §7.
 * Integrazione = 2 righe:
 *
 *   // main.js
 *   import { mountUpdatePage } from '@shared/capabilities/update/page.js';
 *   const UPGRADE = { repo: 'Owner/repo', app: 'messenger' };
 *   route('#update', () => requireAuth(() =>
 *     mountUpdatePage(routeContainer, { canisterId: CANISTER_ID, ...UPGRADE })));
 *
 *   // settings.js
 *   import { updateLinkSection } from '@shared/capabilities/update/page.js';
 *   extraSections: [ updateLinkSection(), ...altro ]
 *
 * ── Contratto con l'host ──────────────────────────────────────────────────────
 *  - CSS: l'host carica `@shared/styles/base.css` (`.page`, `.topbar`, `.settings-*`).
 *  - Router: usa `navigate` da `@shared/ui/router.js` per il back.
 *  - L'app DEVE esporre la query `app_version()` nel suo IDL (registrato via
 *    setDefaultIdlFactory) e una release GitHub col manifest del canale.
 *  - Onestà: il confronto di stato usa la versione semver (`app_version()`); il
 *    module_hash live è mostrato come prova crittografica (cfr. #verify).
 *  - CSP: decisione congelata = NESSUNA (self_upgrade_piano dec. #2). Le app vault/messenger
 *    non impostano CSP (né header in core-assets né `<meta http-equiv>`) → il `fetch`
 *    cross-origin del manifest/artefatti funziona senza `connect-src`. Se un giorno servisse
 *    una CSP, va aggiunta come header in `core-assets` (non `.ic-assets.json5`), bakeata in
 *    genesi, con `connect-src` per l'origin di distribuzione.
 */

import { el, render } from '../../ui/dom.js';
import { navigate } from '../../ui/router.js';
import { query } from '../../core/icp.js';
import { IS_LOCAL } from '../../core/config.js';
import { getModuleHash, listSnapshots, deleteSnapshot } from '../../core/management.js';
import { runUpgrade, rollbackToSnapshot } from './flow.js';

/**
 * Sezione "Check for updates" da spreddare in `extraSections` di renderSettings.
 * @param {string} [targetRoute='#update']
 * @returns {{ title: string, content: HTMLElement[] }}
 */
export function updateLinkSection(targetRoute = '#update') {
  return {
    title: 'Software updates',
    content: [
      el('p', { class: 'settings-note small muted' },
        'See whether a newer version of this app has been published, and how it ' +
        'compares to the version you are running.'),
      el('div', { class: 'settings-row' },
        el('button', {
          class: 'btn-secondary',
          onclick: () => navigate(targetRoute),
        }, 'Check for updates →')),
    ],
  };
}

/**
 * Monta la sottopagina Update completa nel container.
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   repo: string,        // 'Owner/repo' su GitHub
 *   app: string,         // sottocartella su `dist`, es. 'messenger' | 'vault'
 *   distBranch?: string, // branch del transport CORS (default 'dist')
 *   repoUrl?: string,    // default derivato da `repo`
 *   backRoute?: string,
 *   enableInstall?: boolean, // Fase 2: abilita l'install in-app (default false → "coming soon")
 *   e2ee?: boolean,          // Fase 3: app E2EE (vault) → mostra il caveat sul rollback
 * }} opts
 */
export async function mountUpdatePage(container, {
  canisterId,
  repo,
  app,
  distBranch = 'dist',
  repoUrl = repo ? `https://github.com/${repo}` : null,
  backRoute = '#settings',
  enableInstall = false,
  e2ee = false,
}) {
  // 1. Skeleton immediato.
  renderPage(container, backRoute, [
    sectionEl('Updates', [loadingNote()]),
  ]);

  const manifestUrl = resolveManifestUrl(repo, app, distBranch);

  // 2. Letture in parallelo, tutte tolleranti (read-only, niente crash).
  const [current, liveHash, manifest] = await Promise.all([
    readCurrentVersion(canisterId),
    readModuleHash(canisterId),
    fetchManifest(manifestUrl),
  ]);

  // 3. Render.
  renderPage(container, backRoute, buildSections({
    canisterId, current, liveHash, manifest, repoUrl, enableInstall, e2ee,
  }));
}

// ─── Letture tolleranti ───────────────────────────────────────────────────────

async function readCurrentVersion(canisterId) {
  try {
    const v = await query(canisterId, 'app_version');
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

async function readModuleHash(canisterId) {
  try {
    return await getModuleHash(canisterId);
  } catch {
    return null;
  }
}

/**
 * URL del manifest dell'ultima release, servito via `raw.githubusercontent.com` dal branch
 * `dist` (path fisso `<app>/manifest.json`, rolling → sempre l'ultima). raw ha `ACAO: *`
 * (i release-asset GitHub no → fetch() browser bloccato) e cache soft ~5min, fresca abbastanza
 * per un puntatore mobile. Cfr. [[github_release_assets_no_cors]] + BACKLOG §7.
 *
 * Dev-hatch (solo build locali): se è presente `localStorage['update:manifestUrl']` lo si
 * usa al posto del default. Serve a testare il flusso upgrade/rollback dal browser contro un
 * branch/mirror di test senza il balletto "aggiungi/revert una riga" a ogni prova.
 *
 * Gate = `IS_LOCAL` (non `import.meta.env.DEV`): la build di test è una build di *produzione*
 * Vite (`dev.sh` fa `npm run build`, DEV=false) servita dal canister → con DEV il hatch
 * sparirebbe proprio quando serve. `IS_LOCAL` deriva da `DFX_NETWORK`, iniettato a build:
 * true per le build locali, **false** per la release (`DFX_NETWORK=ic`) → su mainnet
 * l'override è inerte (zero rischio sul trust-root: un manifest ostile sceglierebbe pure il
 * wasm_sha256, aggirando la verifica). Cfr. [[dev_hatch_is_local_not_vite_dev]].
 */
function resolveManifestUrl(repo, app, distBranch = 'dist') {
  const defaultUrl = repo && app
    ? `https://raw.githubusercontent.com/${repo}/${distBranch}/${app}/manifest.json`
    : null;
  if (IS_LOCAL) {
    const override = localStorage.getItem('update:manifestUrl');
    if (override) return override;
  }
  return defaultUrl;
}

async function fetchManifest(url) {
  if (!url) return { error: 'no-channel' };
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { error: `http-${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e?.message || 'fetch-failed' };
  }
}

// ─── Costruzione sezioni ──────────────────────────────────────────────────────

function buildSections({ canisterId, current, liveHash, manifest, repoUrl, enableInstall, e2ee }) {
  const sections = [];
  const latest = manifest?.data || null;

  // — Sezione: stato (il verdetto in alto) —
  sections.push(sectionEl('Update status', [statusBlock(current, latest, manifest?.error)]));

  // — Sezione: versione installata —
  const installedRows = [
    keyVal('Installed version', current ? `v${current}` : 'unknown'),
  ];
  if (liveHash) {
    installedRows.push(hashBlock('Live module hash (certified)', liveHash));
  }
  sections.push(sectionEl('Installed', installedRows));

  // — Sezione: ultima release pubblicata —
  if (latest) {
    const latestRows = [
      keyVal('Latest version', latest.version ? `v${latest.version}` : 'n/d'),
    ];
    if (latest.released_at) latestRows.push(keyVal('Released', latest.released_at));
    if (latest.min_compatible_version) {
      latestRows.push(keyVal('Min. compatible', `v${latest.min_compatible_version}`));
    }
    if (latest.wasm_sha256) {
      latestRows.push(hashBlock('Expected module hash', latest.wasm_sha256));
      if (liveHash) latestRows.push(hashMatchNote(eqHex(liveHash, latest.wasm_sha256)));
    }
    if (latest.notes) {
      latestRows.push(
        el('div', { class: 'settings-row settings-row-stacked' },
          el('span', { class: 'settings-label' }, 'Release notes'),
          el('p', { class: 'settings-note small muted' }, String(latest.notes))),
      );
    }
    sections.push(sectionEl('Latest release', latestRows));
  }

  // — Sezione: dove guardare —
  if (repoUrl) {
    const linkRows = [
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Releases'),
        el('a', {
          class: 'settings-value',
          href: `${repoUrl}/releases`,
          target: '_blank', rel: 'noopener',
        }, 'Open on GitHub ↗')),
    ];
    sections.push(sectionEl('Source', linkRows));
  }

  // — Sezione: installazione —
  sections.push(installSection({ canisterId, current, latest, enableInstall, e2ee }));

  // — Sezione: ripristino versione precedente (standalone, indipendente dall'install) —
  const restore = restoreSection({ canisterId, enableInstall, e2ee });
  if (restore) sections.push(restore);

  return sections;
}

/**
 * Sezione Install. Senza `enableInstall` → nota "coming soon" (Fase 1). Con `enableInstall`
 * e un update disponibile → bottone che esegue il flusso a 6 passi (flow.js) con log di
 * progresso; al fallimento offre il rollback manuale allo snapshot pre-upgrade.
 */
function installSection({ canisterId, current, latest, enableInstall, e2ee }) {
  if (!enableInstall) {
    return sectionEl('Install', [
      el('p', { class: 'settings-note small muted' },
        'One-click in-app updates are coming soon. For now this page only checks ' +
        'whether a newer version exists — nothing is changed on your canister.'),
      el('div', { class: 'settings-row' },
        el('button', { class: 'btn-secondary', disabled: true }, 'Install update (coming soon)')),
    ]);
  }

  const log = el('div', { class: 'update-log' });
  const actions = el('div', { class: 'settings-row' });
  const append = (line) => log.appendChild(el('p', { class: 'settings-note small muted' }, line));
  const setActions = (...children) => actions.replaceChildren(...children);

  const updateAvailable = current && latest?.version && cmpSemver(current, latest.version) < 0;
  const canInstall = updateAvailable && latest?.wasm_url && latest?.frontend_url;

  // Toggle auto-rollback (default ON): se l'install riesce ma rompe qualcosa dopo
  // (frontend/health-check), torna da solo allo snapshot pre-upgrade. Il bottone manuale
  // resta sempre come fallback. Cfr. dec. #6 congelata (auto + manuale).
  const autoRollbackToggle = el('input', { type: 'checkbox', checked: true });

  const onProgress = (_step, detail) => { if (detail) append(detail); };

  // Lo stato è stato mutato oltre un riavvio pulito solo se siamo arrivati a frontend/health:
  // prima di lì il vecchio codice è intatto (runUpgrade riavvia il canister nel catch).
  const mutatedPhase = (phase) => phase === 'frontend' || phase === 'health';

  async function doInstall() {
    const ok = window.confirm(
      'The app will go offline for a few seconds while it restarts. A safety snapshot ' +
      'is taken first so you can roll back. Continue?');
    if (!ok) return;
    log.replaceChildren();
    setActions(el('button', { class: 'btn-secondary', disabled: true }, 'Updating…'));
    append(`Starting update v${current} → v${latest.version}…`);
    const res = await runUpgrade({ canisterId, manifest: latest, onProgress });
    if (res.ok) {
      append('✓ Update complete. Reload the app to start the new version.');
      setActions(el('button', { class: 'btn-primary', onclick: () => location.reload() }, 'Reload now'));
      return;
    }
    append(`✗ Update failed: ${res.error}`);
    // Auto-rollback: solo se abilitato, c'è uno snapshot, e lo stato è stato davvero mutato.
    if (autoRollbackToggle.checked && res.snapshotId && mutatedPhase(res.phase)) {
      append('Rolling back automatically to the pre-upgrade snapshot…');
      await doRollback(res.snapshotId);
      return;
    }
    const acts = [];
    if (res.snapshotId) {
      append('A pre-upgrade snapshot was taken — you can restore the previous version.');
      acts.push(el('button', {
        class: 'btn-danger',
        onclick: () => doRollback(res.snapshotId),
      }, 'Restore previous version'));
    }
    acts.push(el('button', { class: 'btn-secondary', onclick: doInstall }, 'Retry'));
    setActions(...acts);
  }

  async function doRollback(snapshotId) {
    setActions(el('button', { class: 'btn-danger', disabled: true }, 'Restoring…'));
    try {
      await rollbackToSnapshot({ canisterId, snapshotId, onProgress });
      append('✓ Previous version restored. Reload the app.');
      setActions(el('button', { class: 'btn-primary', onclick: () => location.reload() }, 'Reload now'));
    } catch (e) {
      append(`✗ Rollback failed: ${e?.message || e}`);
    }
  }

  const intro = [];
  if (canInstall) {
    intro.push(el('p', { class: 'settings-note small muted' },
      'Install the new version directly from here. The code is fetched from the release, ' +
      'its hash is verified, and a snapshot is taken before anything changes — so a failed ' +
      'upgrade can be rolled back. The app is offline only for the few seconds it restarts.'));
    intro.push(
      el('label', { class: 'settings-row update-autorollback' },
        autoRollbackToggle,
        el('span', { class: 'settings-note small muted' },
          'Roll back automatically if the update fails its health check')));
    if (e2ee) intro.push(e2eeCaveatNote());
    setActions(el('button', {
      class: 'btn-primary',
      onclick: doInstall,
    }, `Install update v${current} → v${latest.version}`));
  } else if (updateAvailable) {
    // Update c'è ma il manifest non ha gli URL degli artefatti → non installabile da qui.
    intro.push(el('p', { class: 'settings-note small muted' },
      'A newer version exists, but its release manifest is missing the artifacts needed ' +
      'to install it from here. Use the source link above to update manually.'));
  } else {
    intro.push(el('p', { class: 'settings-note small muted' },
      'Nothing to install — you are running the latest published version.'));
  }

  return sectionEl('Install', [...intro, actions, log]);
}

/**
 * Sezione "Restore a previous version" STANDALONE (Fase 3): indipendente da un install
 * fallito. Ogni upgrade lascia uno snapshot pre-upgrade (flow.js passo 3); qui l'owner può
 * tornarci sopra anche a freddo (ripensamento tardivo, non solo su guasto immediato).
 *
 * Lazy: la lista snapshot è una chiamata controller (`list_canister_snapshots`) → non la
 * eseguiamo al render (fallirebbe per un visitatore non-controller), ma solo al click. Lo
 * snapshot cattura Wasm + heap + stable + chunk store, e gli asset frontend di core-assets
 * vivono in memoria del canister → il restore riporta indietro **backend + dati + frontend**
 * insieme. Solo dove l'install è abilitato (stesso requisito controller).
 */
function restoreSection({ canisterId, enableInstall, e2ee }) {
  if (!enableInstall) return null;

  const list = el('div', { class: 'update-snapshots' });
  const log = el('div', { class: 'update-log' });
  const actions = el('div', { class: 'settings-row' });
  const append = (line) => log.appendChild(el('p', { class: 'settings-note small muted' }, line));
  const setActions = (...children) => actions.replaceChildren(...children);

  const showButton = () => setActions(
    el('button', { class: 'btn-secondary', onclick: loadList }, 'Show restore points'));

  async function loadList() {
    list.replaceChildren();
    log.replaceChildren();
    setActions(el('button', { class: 'btn-secondary', disabled: true }, 'Loading…'));
    let snaps;
    try {
      snaps = await listSnapshots(canisterId);
    } catch (e) {
      append(`Could not read restore points: ${e?.message || e}`);
      showButton();
      return;
    }
    if (!snaps || snaps.length === 0) {
      append('No restore points yet. A snapshot is created automatically before each update.');
      showButton();
      return;
    }
    // Più recente in cima (taken_at_timestamp è ns).
    const sorted = [...snaps].sort((a, b) =>
      a.taken_at_timestamp < b.taken_at_timestamp ? 1 : -1);
    list.replaceChildren(...sorted.map((s) => snapshotRow(s)));
    setActions(el('button', { class: 'btn-secondary', onclick: loadList }, 'Refresh'));
  }

  function snapshotRow(snap) {
    return el('div', { class: 'settings-row update-snapshot-row' },
      el('div', { class: 'update-snapshot-meta' },
        el('span', { class: 'settings-value' }, fmtTimestamp(snap.taken_at_timestamp)),
        el('span', { class: 'settings-note small muted' },
          `${fmtSize(snap.total_size)} · ${shortHex(snap.id)}`)),
      el('div', { class: 'update-snapshot-actions' },
        el('button', {
          class: 'btn-primary',
          onclick: () => doRestore(snap),
        }, 'Restore'),
        el('button', {
          class: 'btn-secondary',
          title: 'Delete this restore point',
          onclick: () => doDelete(snap),
        }, 'Delete')));
  }

  async function doDelete(snap) {
    const ok = window.confirm(
      `Delete the restore point from ${fmtTimestamp(snap.taken_at_timestamp)}?\n\n` +
      'This frees the cycles it costs to keep, but you will no longer be able to roll ' +
      'back to it. The app keeps running — nothing is stopped.');
    if (!ok) return;
    log.replaceChildren();
    try {
      await deleteSnapshot(canisterId, snap.id);
      append('✓ Restore point deleted.');
      await loadList();
    } catch (e) {
      append(`✗ Delete failed: ${e?.message || e}`);
    }
  }

  async function doRestore(snap) {
    const ok = window.confirm(
      `Restore the version from ${fmtTimestamp(snap.taken_at_timestamp)}?\n\n` +
      'The app will go offline for a few seconds while it is stopped, restored and ' +
      'restarted. This rolls back the code, the stored data and the interface together.');
    if (!ok) return;
    setActions(el('button', { class: 'btn-danger', disabled: true }, 'Restoring…'));
    log.replaceChildren();
    try {
      await rollbackToSnapshot({
        canisterId,
        snapshotId: snap.id,
        onProgress: (_step, detail) => { if (detail) append(detail); },
      });
      append('✓ Previous version restored. Reload the app.');
      setActions(el('button', { class: 'btn-primary', onclick: () => location.reload() }, 'Reload now'));
    } catch (e) {
      append(`✗ Restore failed: ${e?.message || e}`);
      setActions(el('button', { class: 'btn-secondary', onclick: loadList }, 'Back to restore points'));
    }
  }

  showButton();

  const intro = [
    el('p', { class: 'settings-note small muted' },
      'Each update first takes a safety snapshot (code + data + interface). If a newer ' +
      'version misbehaves, you can roll back to one of these points. The app is offline ' +
      'only for the few seconds it restarts. Snapshots cost cycles, so only the two most ' +
      'recent are kept — the oldest is replaced automatically. You can also delete one ' +
      'manually below to free its cycles.'),
  ];
  if (e2ee) intro.push(e2eeCaveatNote());

  return sectionEl('Restore a previous version', [...intro, actions, list, log]);
}

/**
 * Caveat onesto per le app E2EE (vault). Lo snapshot cattura la stable memory **cifrata**;
 * la master key VetKeys è per-canister e deterministica → un rollback non perde mai la
 * capacità di decifrare i dati esistenti. L'unico rischio è una migrazione forward-only del
 * formato: i dati scritti DOPO l'update potrebbero non essere leggibili tornando a prima.
 */
function e2eeCaveatNote() {
  return el('p', { class: 'settings-note small muted' },
    'End-to-end encryption: your data is stored encrypted and the decryption key is held ' +
    'per-canister, so a rollback never loses your ability to read existing data. The one ' +
    'caveat: if a newer version changes how data is stored, items saved after that update ' +
    'may not be readable once you roll back to a point before it.');
}

function statusBlock(current, latest, error) {
  // Manifest non disponibile → degrada a nota, mostra comunque l'installato.
  if (!latest) {
    const why = error === 'no-channel'
      ? 'No release channel is configured for this app.'
      : 'Could not reach the release channel right now. Please try again later.';
    return el('p', { class: 'settings-note small muted' }, why);
  }

  // Versione corrente illeggibile → non possiamo decidere.
  if (!current || !latest.version) {
    return el('p', { class: 'settings-note small muted' },
      'Could not determine the installed version to compare against the latest release.');
  }

  const cmp = cmpSemver(current, latest.version);
  if (cmp === 0) {
    return el('p', { class: 'update-status-ok' }, '✓ You are up to date');
  }
  if (cmp < 0) {
    const rows = [
      el('p', { class: 'update-status-new' },
        `⬆ Update available: v${current} → v${latest.version}`),
    ];
    // Avviso onesto se l'installato è sotto il minimo compatibile.
    if (latest.min_compatible_version &&
        cmpSemver(current, latest.min_compatible_version) < 0) {
      rows.push(
        el('p', { class: 'settings-note small muted' },
          `Heads up: your version is below the minimum compatible version ` +
          `(v${latest.min_compatible_version}) for this release.`),
      );
    }
    return el('div', {}, ...rows);
  }
  // current > latest → stai avanti al canale (build di sviluppo / preview).
  return el('p', { class: 'settings-note small muted' },
    `You are running v${current}, which is newer than the latest published ` +
    `release (v${latest.version}).`);
}

// ─── Helpers di rendering ─────────────────────────────────────────────────────

function renderPage(container, backRoute, sections) {
  render(container,
    el('div', { class: 'page page-settings' },
      el('header', { class: 'topbar' },
        el('button', {
          class: 'btn-icon',
          title: 'Back',
          onclick: () => navigate(backRoute),
        }, '←'),
        el('span', { class: 'topbar-title' }, 'Updates'),
      ),
      el('div', { class: 'settings-content' }, ...sections),
    ),
  );
}

function sectionEl(title, content) {
  const children = Array.isArray(content) ? content : [content];
  return el('div', { class: 'settings-section' },
    el('h3', {}, title),
    ...children,
  );
}

function keyVal(label, value) {
  return el('div', { class: 'settings-row' },
    el('span', { class: 'settings-label' }, label),
    el('span', { class: 'settings-value' }, value));
}

function hashBlock(label, hex) {
  return el('div', { class: 'settings-row settings-row-stacked' },
    el('span', { class: 'settings-label' }, label),
    el('code', { class: 'verify-hash', title: 'Click to select', onclick: selectText }, hex));
}

function hashMatchNote(ok) {
  return el('p', { class: ok ? 'verify-match-ok' : 'verify-match-bad' },
    ok
      ? '✓ Installed code already matches this release'
      : '✗ Installed code differs from this release');
}

function loadingNote() {
  return el('p', { class: 'settings-note small muted' }, 'Loading…');
}

// ─── Formattazione snapshot (restore) ───────────────────────────────────────────

/** taken_at_timestamp è ns dall'epoch (Nat64/bigint) → data locale leggibile. */
function fmtTimestamp(ns) {
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    return new Date(ms).toLocaleString();
  } catch {
    return 'unknown time';
  }
}

/** total_size in byte (bigint) → MB con una cifra. */
function fmtSize(bytes) {
  try {
    return `${(Number(BigInt(bytes)) / 1_048_576).toFixed(1)} MB`;
  } catch {
    return 'n/d';
  }
}

/** id snapshot (Uint8Array) → hex accorciato per la UI. */
function shortHex(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}

// ─── Semver minimale (x.y.z, parti numeriche) ─────────────────────────────────

/** -1 se a<b, 0 se =, 1 se a>b. Tollerante a 'v' iniziale e parti mancanti. */
function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function parseSemver(v) {
  const core = String(v).trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function eqHex(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function selectText(ev) {
  const range = document.createRange();
  range.selectNodeContents(ev.currentTarget);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
