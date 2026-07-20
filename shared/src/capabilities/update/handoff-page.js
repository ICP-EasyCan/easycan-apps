/**
 * capabilities/update/handoff-page.js — Pagina del ricevitore di handoff (Arco B).
 *
 * Drop-in, gemella di `update/page.js`. Mostra l'esito della verifica + le azioni e poi
 * il progress dell'install. La UX distruttiva "pesante" vive a monte: card offuscata +
 * waiver nel PORTALE (B3, decisione 6) e banner di autorizzazione sul LOGIN (l'utente
 * ri-logga coscientemente prima del wipe — gemello del relogin del claim). Qui niente
 * banner erase in cima: solo un promemoria breve sopra il bottone rosso (il punto di
 * non ritorno) + il progresso.
 *
 * Verifica PRE-FLIGHT (read-only) al mount: prima ancora che l'utente prema Install,
 * la pagina risolve l'àncora SHA-256 on-chain + il manifest e li confronta. Se NON
 * combaciano, il bottone Install resta bloccato → non si arriva mai a `consume_install_token`
 * (che brucerebbe il token e sposterebbe l'occupancy A→B), così un release non verificabile
 * non lascia mai lo stato "ledger spostato / install fallito". Il pre-flight NON consuma
 * nulla; il consume + reinstall distruttivo scattano solo dietro Install, a verifica passata.
 *
 * Toni (coerenti col banner di login, login/index.js): l'avvertimento di cancellazione
 * è ROSSO (azione irreversibile); la rassicurazione "l'acquisto resta nella licenza" è
 * neutra e vale sempre (il seat è coniato al pagamento, non all'handoff). In caso di
 * fallimento il messaggio è PHASE-AWARE: fino allo snapshot non è stato toccato nulla
 * → "dati intatti"; dall'install in poi è un reinstall (stable memory azzerata).
 *
 * Integrazione (main.js):
 *   import { captureInstallParams, getPendingInstall }
 *     from '@shared/capabilities/update/handoff.js';
 *   import { mountInstallPage } from '@shared/capabilities/update/handoff-page.js';
 *   // primo statement sincrono del boot, PRIMA di startRouter():
 *   //   captureInstallParams()  → stash + clean del fragment #install=&token=
 *   // al boot/login: se getPendingInstall() → naviga a #install
 *   route('#install', () => requireAuth(() =>
 *     mountInstallPage(routeContainer, { canisterId: CANISTER_ID, repo, distBranch })));
 *
 * Contratto host: stessa pagina-shell di #update/#verify (CSS base.css, navigate per il back).
 */

import { el, render } from '../../ui/dom.js';
import { navigate } from '../../ui/router.js';
import { getPendingInstall, preflightHandoff, runHandoffInstall } from './handoff.js';

// Fasi del flow (flow.js) che azzerano la stable memory. Prima di queste (resolve,
// handoff, fetch-wasm, chunks, snapshot) il canister vecchio è ancora integro — lo
// snapshot è la rete di sicurezza presa appena prima dell'install. Blacklist, non
// whitelist: un fallimento pre-consume (es. 'handoff'/'resolve') NON è distruttivo.
const DESTRUCTIVE_PHASES = new Set(['install', 'frontend', 'health', 'done']);

/** Box rosso d'avvertimento — gemello dello stile del banner login (login/index.js). */
function dangerBox(title, body) {
  return el('div', {
    style: 'background: rgba(239, 68, 68, 0.08); border-left: 4px solid #ef4444; ' +
           'border-radius: 4px 8px 8px 4px; padding: 14px 16px; margin-bottom: 16px; ' +
           'font-size: 0.9em; line-height: 1.5; text-align: left;',
  },
    el('strong', { style: 'display: block; margin-bottom: 6px; color: #dc2626; font-size: 1.05em;' }, title),
    body);
}

/**
 * @param {HTMLElement} container
 * @param {{ canisterId: string, repo: string, distBranch?: string, homeRoute?: string }} opts
 */
export function mountInstallPage(container, { canisterId, repo, distBranch = 'dist', homeRoute = '#settings' }) {
  const pending = getPendingInstall();
  const back = () => navigate(homeRoute);

  const topbar = el('header', { class: 'topbar' },
    el('button', { class: 'btn-icon', title: 'Back', onclick: back }, '←'),
    el('span', { class: 'topbar-title' }, 'Change app'));

  if (!pending) {
    render(container,
      el('div', { class: 'page' }, topbar,
        el('p', { class: 'settings-note small muted' },
          'There is no pending change-app request. Start it from the marketplace portal.'),
        el('div', { class: 'settings-row' },
          el('button', { class: 'btn-secondary', onclick: back }, 'Back'))));
    return;
  }

  const appId = pending.app;
  const appLabel = appId.charAt(0).toUpperCase() + appId.slice(1);
  // Rassicurazione invariante: il seat è già nel ledger (coniato al pagamento o
  // free seat preesistente). Rinunciare qui non costa l'acquisto. Vale charged+waived.
  const LICENSE_NOTE =
    'Your purchase stays in your license either way — if you stop now you can install ' +
    'it later, even on a different canister, with no second purchase.';

  const verifyPanel = el('div', {});           // esito del pre-flight (dinamico)
  const eraseReminder = el('div', {});         // promemoria erase breve (solo happy-path)
  const status = el('p', { class: 'settings-note small muted' });
  const actions = el('div', { class: 'settings-row' });
  const failBox = el('div', {});

  const setStatus = (msg) => { status.textContent = msg; };
  const setActions = (...nodes) => render(actions, ...nodes);

  // Il bottone Install nasce DISABILITATO: si abilita solo se il pre-flight conferma
  // che l'hash on-chain combacia col manifest. Tenuto in chiusura per togglarlo.
  let verifiedPreflight = null;
  const installBtn = el('button', { class: 'btn-danger', disabled: true }, `Install ${appLabel}`);
  const notNowBtn  = el('button', { class: 'btn-secondary', onclick: back }, 'Back to your original app');

  const start = async () => {
    render(failBox);
    setActions(el('button', { class: 'btn-danger', disabled: true }, 'Installing…'), notNowBtn);
    setStatus('Starting…');
    const result = await runHandoffInstall({
      canisterId, repo, distBranch, preflight: verifiedPreflight,
      onProgress: (_step, detail) => { if (detail) setStatus(detail); },
    });
    if (result.ok) {
      setStatus(`✓ ${appLabel} is installed. Reload to open it.`);
      setActions(el('button', { class: 'btn-primary', onclick: () => location.reload() }, 'Reload now'));
      return;
    }
    // Fallimento: distinguere se il wipe è già avvenuto (phase ∈ DESTRUCTIVE) o no.
    setStatus('');
    const wiped = DESTRUCTIVE_PHASES.has(result.phase);
    const headline = wiped
      ? `${appLabel} could not be fully installed after the change started. A safety ` +
        `snapshot was taken beforehand; if the app does not open, restore it from ` +
        `Settings → Update.`
      : `Nothing was installed — ${appLabel} could not be verified or prepared, so the ` +
        `current app and all of its data are untouched.`;
    render(failBox,
      dangerBox(wiped ? 'Install did not complete' : 'Install stopped — nothing changed', headline),
      el('p', { class: 'settings-note small muted' }, LICENSE_NOTE),
      result.error
        ? el('p', { class: 'settings-note small muted', style: 'word-break: break-all; opacity: 0.75;' },
            `Technical detail: ${result.error}`)
        : null);
    setActions(el('button', { class: 'btn-secondary', onclick: back }, 'Back to your original app'));
  };
  installBtn.onclick = start;

  // ── Render iniziale: avvertimento rosso + verifica in corso + Install bloccato ──
  render(verifyPanel,
    el('p', { class: 'settings-note small muted' }, 'Verifying this release against the on-chain hash…'));
  setActions(installBtn, notNowBtn);

  // L'avvertimento erase "pesante" è già stato dato (waiver nel portale + banner del
  // login di autorizzazione): qui niente dangerBox in cima — solo l'esito della verifica,
  // poi un promemoria erase breve subito sopra il bottone rosso (riempito solo se l'hash
  // combacia, cioè quando Install è davvero abilitato).
  render(container,
    el('div', { class: 'page' }, topbar,
      el('div', { class: 'settings-section' },
        el('h3', {}, `Install ${appLabel} on this canister`),
        el('p', { class: 'settings-note small muted' }, LICENSE_NOTE),
        verifyPanel,
        eraseReminder,
        status,
        failBox,
        actions)));

  // ── Pre-flight read-only: nessun consume, nessun wipe. Aggiorna il pannello. ──
  preflightHandoff({ canisterId, repo, distBranch }).then((pf) => {
    if (pf.ok && pf.hashMatches) {
      verifiedPreflight = pf;
      installBtn.disabled = false;
      render(verifyPanel,
        el('p', { class: 'settings-note small verify-match-ok' },
          '✓ Verified — this release matches the on-chain hash.'));
      // Promemoria erase breve, mostrato solo ora che Install è abilitato: è il punto
      // di non ritorno. L'avviso esteso vive sul banner di login.
      render(eraseReminder,
        el('p', { class: 'settings-note small', style: 'color: #dc2626; margin: 8px 0 0;' },
          `Installing ${appLabel} erases the current app and all of its data on this ` +
          `canister — this cannot be undone.`));
      return;
    }
    if (pf.ok && !pf.hashMatches) {
      render(verifyPanel,
        dangerBox('Verification failed — install blocked',
          'This release does not match the code hash recorded on-chain, so it will not be ' +
          'installed. Your current app is untouched.'),
        el('p', { class: 'settings-note small muted', style: 'word-break: break-all; opacity: 0.75;' },
          `on-chain ${pf.onChainSha256 || 'n/a'} · manifest ${pf.manifestSha256 || 'n/a'}`));
      return;
    }
    // Pre-flight non riuscito (rete, manifest assente, ecc.): bloccato, ma nulla toccato.
    render(verifyPanel,
      dangerBox('Could not verify this release — install blocked',
        `${pf.error || 'Verification failed.'} Your current app is untouched; try again later.`));
  });
}
