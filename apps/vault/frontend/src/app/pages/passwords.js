/**
 * passwords.js — Password list page
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate } from '@shared/ui/router.js';
import { listEncryptedRecords } from '../../lib/encrypted-crud.js';

const NS = 'passwords';

export async function renderPasswords(container) {
  render(container,
    el('div', { class: 'page-vault' },
      el('div', { class: 'topbar' },
        el('span', { class: 'topbar-title' }, 'Passwords'),
        el('div', { class: 'topbar-right' },
          el('button', { class: 'btn-primary small', onClick: () => navigate('#password/new') }, '+ New'),
        ),
      ),
      el('div', { class: 'vault-content', id: 'password-list' },
        el('p', { class: 'hint', style: 'padding:1rem' }, 'Deriving key...'),
      ),
    ),
  );

  try {
    const { records, total } = await listEncryptedRecords(NS, 0, 100);
    const listEl = document.getElementById('password-list');
    if (!listEl) return;

    if (records.length === 0) {
      render(listEl, el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, '\u{1F512}'),
        el('p', {}, 'No passwords saved yet'),
        el('button', { class: 'btn-primary', onClick: () => navigate('#password/new') }, 'Add your first'),
      ));
      return;
    }

    const items = records.map(rec => {
      const d = rec.data || {};
      return el('div', { class: 'vault-item card', onClick: () => navigate(`#password/${rec.id}`) },
        el('div', { class: 'vault-item-main' },
          el('span', { class: 'vault-item-title' }, d.site || 'Untitled'),
          el('span', { class: 'vault-item-sub' }, d.username || ''),
        ),
        el('span', { class: 'vault-item-arrow' }, '\u203A'),
      );
    });

    render(listEl, el('div', { class: 'vault-list' }, ...items));
  } catch (e) {
    const listEl = document.getElementById('password-list');
    if (listEl) render(listEl, el('p', { class: 'error', style: 'padding:1rem' }, `Error: ${e.message}`));
  }
}
