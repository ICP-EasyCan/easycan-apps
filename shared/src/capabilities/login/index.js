/**
 * capabilities/login/index.js — Pagina login Internet Identity condivisa.
 *
 * Uso:
 *   import { renderLogin } from '../../../capabilities/login/index.js';
 *   renderLogin(container, { title: 'My App', subtitle: 'Descrizione' });
 */

import { el, render } from '../../ui/dom.js';
import { login }      from '../../core/auth.js';

/**
 * @param {HTMLElement} container
 * @param {{ title?: string, subtitle?: string }} [options]
 */
export function renderLogin(container, options = {}) {
  const title    = options.title    ?? 'Sovereign App';
  const subtitle = options.subtitle ?? null;

  let claimNotice = null;
  try {
    const hasTokenInUrl = new URLSearchParams(window.location.search).has('claim');
    const hasPendingToken = !!sessionStorage.getItem('claim:pending-token');
    const needsRelogin = sessionStorage.getItem('claim:relogin-required') === '1';

    if (hasTokenInUrl || hasPendingToken || needsRelogin) {
      claimNotice = el('div', { class: 'login-notice', style: 'background: rgba(255, 152, 0, 0.08); border-left: 4px solid #f59e0b; border-radius: 4px 8px 8px 4px; padding: 14px 16px; margin-bottom: 24px; font-size: 0.9em; line-height: 1.5; text-align: left; animation: fadeIn 0.5s ease-out;' },
        el('strong', { style: 'display: block; margin-bottom: 6px; color: #d97706; font-size: 1.05em;' }, 'Ownership Claim'),
        'Log in with the Internet Identity you want to own this app. This action is irreversible: the identity you use for this first login will become the permanent administrator.'
      );
    }
  } catch (_) {}

  render(container,
    el('div', { class: 'page page-login' },
      el('div', { class: 'hero' },
        el('h1', {}, title),
        subtitle ? el('p', { class: 'subtitle' }, subtitle) : null,
      ),
      el('div', { class: 'login-card' },
        claimNotice,
        el('button', { class: 'btn-primary', onclick: login }, 'Log in with Internet Identity'),
      ),
    )
  );
}
