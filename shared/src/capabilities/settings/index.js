/**
 * capabilities/settings/index.js — Pagina impostazioni condivisa.
 *
 * Uso:
 *   import { renderSettings } from '../../../capabilities/settings/index.js';
 *
 *   renderSettings(container, {
 *     canisterId: CANISTER_ID,
 *     extraSections: [                           // opzionale
 *       { title: 'Notifiche', content: el('p', {}, '...') },
 *     ],
 *   });
 */

import { el, render }            from '../../ui/dom.js';
import { getPrincipalText, logout } from '../../core/auth.js';
import { loadCanisterHealth, formatCycles, formatBytes, formatBurnPerDay, formatAutonomyDays } from './canister-health.js';

/**
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   showCanisterHealth?: boolean,   // sezione "Canister" (cicli + memoria) — uniforme tra le app
 *   extraSections?: Array<{ title: string, content: HTMLElement | HTMLElement[] }>,
 * }} options
 */
export function renderSettings(container, options = {}) {
  const {
    canisterId,
    showCanisterHealth = false,
    extraSections = [],
  } = options;

  const myPrincipal = getPrincipalText() || '—';

  // Bottone "Copy" testuale con feedback "Copied" (uniforme col portale, ex icona 📋).
  const copyButton = (getText) => {
    const btn = el('button', { class: 'copy-btn', type: 'button' }, 'Copy');
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard?.writeText(getText() || ''); } catch { /* clipboard non disponibile */ }
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    return btn;
  };

  const sections = [
    // ── Account ──
    el('div', { class: 'settings-section' },
      el('h3', {}, 'Your account'),
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Canister'),
        el('span', { class: 'settings-value mono small' }, canisterId || '—'),
        copyButton(() => canisterId),
      ),
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Principal'),
        el('span', { class: 'settings-value mono small' }, myPrincipal),
        copyButton(() => myPrincipal),
      ),
    ),
  ];

  // ── Canister (cicli + memoria): valori riempiti async dopo il render ──
  // È il carburante e l'impronta del canister sovrano: "il tuo computer, la sua benzina".
  let cyclesVal, memVal, burnVal, autonomyVal;
  if (showCanisterHealth) {
    cyclesVal    = el('span', { class: 'settings-value mono small' }, '…');
    memVal       = el('span', { class: 'settings-value mono small' }, '…');
    burnVal      = el('span', { class: 'settings-value mono small' }, '…');
    autonomyVal  = el('span', { class: 'settings-value mono small' }, '…');
    sections.push(
      el('div', { class: 'settings-section' },
        el('h3', {}, 'Canister'),
        el('div', { class: 'settings-row' }, el('span', { class: 'settings-label' }, 'Cycles'), cyclesVal),
        el('div', { class: 'settings-row' }, el('span', { class: 'settings-label' }, 'Memory'), memVal),
        el('div', { class: 'settings-row' }, el('span', { class: 'settings-label' }, 'Consumo idle'), burnVal),
        el('div', { class: 'settings-row' }, el('span', { class: 'settings-label' }, 'Autonomia (idle)'), autonomyVal),
        el('p', { class: 'settings-hint small' },
          'Stima in idle: esclude l’uso attivo (chiamate, messaggi). È il massimo teorico, non il consumo reale.'),
      ),
    );
  }

  // Sezioni extra app-specifiche
  for (const s of extraSections) {
    const content = Array.isArray(s.content) ? s.content : [s.content];
    sections.push(
      el('div', { class: 'settings-section' },
        el('h3', {}, s.title),
        ...content,
      )
    );
  }

  // ── Danger zone ──
  sections.push(
    el('div', { class: 'settings-section' },
      el('h3', {}, 'Account'),
      el('button', { class: 'btn-danger', onclick: logout }, 'Logout'),
    )
  );

  render(container,
    el('div', { class: 'page page-settings' },
      el('header', { class: 'topbar' },
        el('span', { class: 'topbar-title' }, 'Settings'),
      ),
      el('div', { class: 'settings-content' }, ...sections),
    )
  );

  if (showCanisterHealth) {
    loadCanisterHealth(canisterId)
      .then(({ cycles, memoryBytes, idleBurnPerDay }) => {
        cyclesVal.textContent   = formatCycles(cycles);
        memVal.textContent      = formatBytes(memoryBytes);
        burnVal.textContent     = formatBurnPerDay(idleBurnPerDay);
        autonomyVal.textContent = formatAutonomyDays(cycles, idleBurnPerDay);
      })
      .catch(() => {
        cyclesVal.textContent = 'n/d'; memVal.textContent = 'n/d';
        burnVal.textContent = 'n/d'; autonomyVal.textContent = 'n/d';
      });
  }
}
