/**
 * capabilities/sovereignty/page.js — Sottopagina "Sovereignty" drop-in.
 *
 * Ultimo miglio della sovranità: incapsula il fetch + lo skeleton + il render di
 * una pagina COMPLETA, così ogni app marketplace la ottiene identica con
 * un'integrazione di due righe (una route + una voce nel settings):
 *
 *   // main.js
 *   import { mountSovereigntyPage } from '@shared/capabilities/sovereignty/page.js';
 *   route('#sovereignty', () => requireAuth(() =>
 *     mountSovereigntyPage(routeContainer, {
 *       canisterId: CANISTER_ID,
 *       myPrincipal: getPrincipal(),
 *     })));
 *
 *   // settings.js
 *   import { sovereigntyLinkSection } from '@shared/capabilities/sovereignty/page.js';
 *   extraSections: [ sovereigntyLinkSection(), ...altro ]
 *
 * Il builder L4 (`buildSovereigntySections`) resta il motore: questa pagina fa
 * solo l'orchestrazione che prima ogni app ricopiava a mano.
 *
 * ── Contratto con l'host ──────────────────────────────────────────────────────
 *  - CSS: l'host carica `@shared/styles/base.css` (classi `.page`, `.topbar`,
 *    `.settings-*`, `.btn-*`, `.ctrl-*`, `.modal-*`).
 *  - Router: usa `navigate` da `@shared/ui/router.js` per il back.
 *  - I 3 fetch (platform_metadata, listControllers, platform_get_admin) sono fatti
 *    QUI in parallelo via Promise.allSettled. Un'app standalone (senza
 *    platform_metadata nel canister) degrada a un riquadro informativo.
 */

import { el, render } from '../../ui/dom.js';
import { navigate } from '../../ui/router.js';
import { query } from '../../core/icp.js';
import { listControllers } from '../../core/management.js';
import { buildSovereigntySections } from './index.js';

/**
 * Sezione "Sovereignty" da spreddare in `extraSections` di renderSettings:
 * una riga descrittiva + un bottone che naviga alla sottopagina dedicata.
 * @param {string} [targetRoute='#sovereignty']
 * @returns {{ title: string, content: HTMLElement[] }}
 */
export function sovereigntyLinkSection(targetRoute = '#sovereignty') {
  return {
    title: 'Sovereignty',
    content: [
      el('p', { class: 'settings-note small muted' },
        'Manage who controls this app: add a backup key for recovery, and review ' +
        'your controllers.'),
      el('div', { class: 'settings-row' },
        el('button', {
          class: 'btn-secondary',
          onclick: () => navigate(targetRoute),
        }, 'Open sovereignty settings →')),
    ],
  };
}

/**
 * Monta la sottopagina Sovereignty completa nel container.
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   myPrincipal?: import('@dfinity/principal').Principal | null,
 *   backRoute?: string,
 * }} opts
 */
export async function mountSovereigntyPage(container, {
  canisterId,
  myPrincipal = null,
  backRoute = '#settings',
}) {
  // 1. Skeleton immediato — visibile prima di qualsiasi round-trip.
  renderPage(container, backRoute, [
    sectionEl('Platform', [loadingNote()]),
    sectionEl('Controllers', [loadingNote()]),
  ]);

  // 2. I 3 fetch in parallelo (nessun waterfall).
  const [metaR, ctrR, adminR] = await Promise.allSettled([
    query(canisterId, 'platform_metadata'),
    listControllers(canisterId),
    query(canisterId, 'platform_get_admin'),
  ]);

  const meta = metaR.status === 'fulfilled' ? metaR.value : null;

  // 3. Costruzione sincrona via builder L4.
  const sovSections = buildSovereigntySections({
    meta,
    controllers: ctrR.status === 'fulfilled' ? ctrR.value : [],
    mgmtError: ctrR.status === 'rejected'
      ? (ctrR.reason?.message || String(ctrR.reason))
      : null,
    appAdmin: adminR.status === 'fulfilled'
      && Array.isArray(adminR.value)
      && adminR.value.length > 0
      ? adminR.value[0]
      : null,
    myPrincipal,
    canisterId,
    // Dopo ogni mutazione riuscita: rifetch + re-render in-place (solo i 3 query
    // paralleli, niente re-bundle/re-auth/full reload). mountSovereigntyPage usa
    // allSettled → non rigetta in pratica, quindi il bottone non resta bloccato.
    onChanged: () => mountSovereigntyPage(container, { canisterId, myPrincipal, backRoute }),
  });

  // 4. App standalone o metadata non disponibili → nessuna sezione: riquadro info.
  if (sovSections.length === 0) {
    renderPage(container, backRoute, [
      sectionEl('Platform', [
        el('p', { class: 'settings-note small muted' },
          'This app is not connected to any marketplace, so there is nothing to ' +
          'manage here — you are already in full control of your canister.'),
      ]),
    ]);
    return;
  }

  renderPage(container, backRoute, sovSections.map(s => sectionEl(s.title, s.content)));
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
        el('span', { class: 'topbar-title' }, 'Sovereignty'),
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

function loadingNote() {
  return el('p', { class: 'settings-note small muted' }, 'Loading…');
}
