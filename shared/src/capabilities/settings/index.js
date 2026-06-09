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

/**
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   extraSections?: Array<{ title: string, content: HTMLElement | HTMLElement[] }>,
 * }} options
 */
export function renderSettings(container, options = {}) {
  const {
    canisterId,
    extraSections = [],
  } = options;

  const myPrincipal = getPrincipalText() || '—';

  const sections = [
    // ── Account ──
    el('div', { class: 'settings-section' },
      el('h3', {}, 'Your account'),
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Canister'),
        el('span', { class: 'settings-value mono small' }, canisterId || '—'),
        el('button', { class: 'btn-icon small', title: 'Copy', onclick: () => navigator.clipboard?.writeText(canisterId || '') }, '📋'),
      ),
      el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, 'Principal'),
        el('span', { class: 'settings-value mono small' }, myPrincipal),
        el('button', { class: 'btn-icon small', title: 'Copy', onclick: () => navigator.clipboard?.writeText(myPrincipal) }, '📋'),
      ),
    ),
  ];

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
}
