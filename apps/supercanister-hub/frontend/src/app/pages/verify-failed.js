/** verify-failed.js — proprietà NON verificabile (fail-closed). */

import { el, render } from '@shared/ui/dom.js';
import { logout }     from '@shared/core/auth.js';
import { navigate }   from '@shared/ui/router.js';

export function renderVerifyFailed(container) {
  render(container,
    el('div', { class: 'page page-not-owner' },
      el('div', { class: 'not-owner-box' },
        el('div', { class: 'not-owner-icon' }, '⚠️'),
        el('h2', {}, 'Couldn’t verify ownership'),
        el('p', {}, 'We couldn’t confirm that this canister belongs to you.'),
        el('p', { class: 'hint small' },
          'This is usually a temporary network issue. Retry, or log in again ' +
          'to finish setting up this app.'),
        el('button', { class: 'btn-primary', onclick: () => navigate('#home') }, 'Retry'),
        el('button', { class: 'btn-secondary', onclick: () => logout() }, 'Log in again'),
      ),
    ),
  );
}
