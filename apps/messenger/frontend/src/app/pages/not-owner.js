/**
 * not-owner.js — Schermata "non sei il proprietario di questo canister".
 *
 * Mostrata quando un utente autenticato tenta di usare un canister
 * che ha già un proprietario diverso da lui.
 */

import { el, render }  from '@shared/ui/dom.js';
import { logout }      from '@shared/core/auth.js';

export function renderNotOwner(container) {
  render(container,
    el('div', { class: 'page page-not-owner' },
      el('div', { class: 'not-owner-box' },
        el('div', { class: 'not-owner-icon' }, '\uD83D\uDD12'),
        el('h2', {}, 'Canister inaccessible'),
        el('p', {},
          'This canister belongs to another user.',
        ),
        el('p', { class: 'hint small' },
          'You are using an Internet Identity different from the owner\'s, ' +
          'or this is not your canister.',
        ),
        el('button', { class: 'btn-primary', onclick: () => logout() },
          'Change identity',
        ),
      ),
    ),
  );
}
