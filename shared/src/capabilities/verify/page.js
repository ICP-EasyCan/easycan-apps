/**
 * capabilities/verify/page.js — Sottopagina "Verify the running code" drop-in.
 *
 * Gemella di `sovereignty/page.js`, ma risponde a una domanda diversa:
 *   - #sovereignty → "CHI controlla l'app" (controllers + safety net EasyCan)
 *   - #verify      → "QUALE codice gira" (module_hash certificato dall'IC)
 *
 * Mostra l'hash del WASM live (letto via read_state certificato, agent anonimo) e i
 * dati per ritrovarlo su GitHub e ricompilarlo (build riproducibile, vedi
 * docs/build/REPRODUCIBLE_BUILD.md). Integrazione = 2 righe, identica a sovereignty:
 *
 *   // main.js
 *   import { mountVerifyPage } from '@shared/capabilities/verify/page.js';
 *   route('#verify', () => requireAuth(() =>
 *     mountVerifyPage(routeContainer, {
 *       canisterId: CANISTER_ID,
 *       repoUrl: 'https://github.com/.../vault',
 *       releaseTag: 'vault-v1.0.0',
 *       releaseSha256: '3753535d…',   // module_hash atteso (dalla GitHub Release)
 *       dockerPackage: 'vault-canister',
 *       e2eeFrontend: true,            // vault → mostra la nota E2EE frontend
 *     })));
 *
 *   // settings.js
 *   import { verifyLinkSection } from '@shared/capabilities/verify/page.js';
 *   extraSections: [ verifyLinkSection(), ...altro ]
 *
 * ── Contratto con l'host ──────────────────────────────────────────────────────
 *  - CSS: l'host carica `@shared/styles/base.css` (`.page`, `.topbar`, `.settings-*`).
 *  - Router: usa `navigate` da `@shared/ui/router.js` per il back.
 *  - Onestà: il module_hash copre SOLO il backend (canister). Per le app E2EE
 *    (`e2eeFrontend: true`) la cifratura vive nel frontend → asse di verifica a parte.
 */

import { el, render } from '../../ui/dom.js';
import { navigate } from '../../ui/router.js';
import { getModuleHash } from '../../core/management.js';

/**
 * Sezione "Verify" da spreddare in `extraSections` di renderSettings.
 * @param {string} [targetRoute='#verify']
 * @returns {{ title: string, content: HTMLElement[] }}
 */
export function verifyLinkSection(targetRoute = '#verify') {
  return {
    title: 'Verify the running code',
    content: [
      el('p', { class: 'settings-note small muted' },
        'Check that this canister runs exactly the open-source code it claims to — ' +
        'certified by the Internet Computer, recomputable by anyone.'),
      el('div', { class: 'settings-row' },
        el('button', {
          class: 'btn-secondary',
          onclick: () => navigate(targetRoute),
        }, 'Verify the running code →')),
    ],
  };
}

/**
 * Monta la sottopagina Verify completa nel container.
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   repoUrl?: string,
 *   releaseTag?: string,
 *   releaseSha256?: string,
 *   dockerPackage?: string,
 *   e2eeFrontend?: boolean,
 *   backRoute?: string,
 * }} opts
 */
export async function mountVerifyPage(container, {
  canisterId,
  repoUrl = null,
  releaseTag = null,
  releaseSha256 = null,
  dockerPackage = null,
  e2eeFrontend = false,
  backRoute = '#settings',
}) {
  // 1. Skeleton immediato.
  renderPage(container, backRoute, [
    sectionEl('Running code', [loadingNote()]),
  ]);

  // 2. Fetch hash live (certificato, agent anonimo). Tollerante: degrada a "n/d".
  let liveHash = null;
  let fetchError = null;
  try {
    liveHash = await getModuleHash(canisterId);
  } catch (e) {
    fetchError = e?.message || String(e);
  }

  // 3. Render.
  renderPage(container, backRoute, buildSections({
    canisterId, liveHash, fetchError,
    repoUrl, releaseTag, releaseSha256, dockerPackage, e2eeFrontend,
  }));
}

// ─── Costruzione sezioni ──────────────────────────────────────────────────────

function buildSections({
  canisterId, liveHash, fetchError,
  repoUrl, releaseTag, releaseSha256, dockerPackage, e2eeFrontend,
}) {
  const sections = [];

  // — Sezione: codice in esecuzione (hash live + match) —
  const liveRows = [];
  liveRows.push(
    el('p', { class: 'settings-note small muted' },
      'This canister is certified by the Internet Computer to run exactly the code ' +
      'with this hash (its module_hash). Anyone can recompute it from the ' +
      'open-source release and check it matches.'),
  );

  if (liveHash) {
    liveRows.push(hashBlock('Live module hash (certified)', liveHash));
  } else {
    liveRows.push(
      el('p', { class: 'settings-note small muted' },
        fetchError
          ? `Could not read the module hash right now (${fetchError}).`
          : 'Module hash not available (n/d) — the canister may not have code installed yet.'),
    );
  }

  if (releaseSha256) {
    liveRows.push(hashBlock('Expected hash (from release)', releaseSha256));
    if (liveHash) {
      liveRows.push(matchBadge(eqHex(liveHash, releaseSha256)));
    }
  }

  sections.push(sectionEl('Running code', liveRows));

  // — Sezione: come verificarlo (GitHub + recipe docker) —
  const howRows = [];
  if (repoUrl) {
    howRows.push(
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Source'),
        el('a', { class: 'settings-value', href: repoUrl, target: '_blank', rel: 'noopener' },
          'Open repository ↗')),
    );
  }
  if (repoUrl && releaseTag) {
    howRows.push(
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Release'),
        el('a', {
          class: 'settings-value',
          href: `${repoUrl}/releases/tag/${releaseTag}`,
          target: '_blank', rel: 'noopener',
        }, `${releaseTag} ↗`)),
    );
  }
  if (dockerPackage) {
    howRows.push(
      el('p', { class: 'settings-note small muted' },
        'Recompute the hash yourself (reproducible build):'),
      el('pre', { class: 'verify-code' },
        `docker build --build-arg PACKAGE=${dockerPackage} -t easycan-verify .\n` +
        `docker run --rm easycan-verify sha256sum /out/app.wasm`),
    );
  }
  if (howRows.length === 0) {
    howRows.push(
      el('p', { class: 'settings-note small muted' },
        'You can verify this hash against the project’s open-source release on GitHub.'),
    );
  }
  sections.push(sectionEl('How to verify', howRows));

  // — Sezione: caveat onesto (cosa copre / non copre) —
  const caveatRows = [
    el('p', { class: 'settings-note small muted' },
      'The hash covers the backend (canister) code. The app’s web interface is ' +
      'delivered separately and is verified on its own track.'),
  ];
  if (e2eeFrontend) {
    caveatRows.push(
      el('p', { class: 'settings-note small muted' },
        'For end-to-end encryption, the cryptography runs in that web interface, ' +
        'so it is not part of this backend hash.'),
    );
  }
  sections.push(sectionEl('What this covers', caveatRows));

  return sections;
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
        el('span', { class: 'topbar-title' }, 'Verify'),
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

function hashBlock(label, hex) {
  return el('div', { class: 'settings-row settings-row-stacked' },
    el('span', { class: 'settings-label' }, label),
    el('code', { class: 'verify-hash', title: 'Click to select', onclick: selectText }, hex),
  );
}

function matchBadge(ok) {
  return el('p', { class: ok ? 'verify-match-ok' : 'verify-match-bad' },
    ok ? '✓ Live code matches the published release' : '✗ Live code does NOT match the published release');
}

function loadingNote() {
  return el('p', { class: 'settings-note small muted' }, 'Loading…');
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
