/**
 * notes.js — Encrypted notes list page
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate } from '@shared/ui/router.js';
import { listEncryptedRecords } from '../../lib/encrypted-crud.js';

const NS = 'notes';

export async function renderNotes(container) {
  render(container,
    el('div', { class: 'page-vault' },
      el('div', { class: 'topbar' },
        el('span', { class: 'topbar-title' }, 'Notes'),
        el('div', { class: 'topbar-right' },
          el('button', { class: 'btn-primary small', onClick: () => navigate('#note/new') }, '+ New'),
        ),
      ),
      el('div', { class: 'vault-content', id: 'notes-list' },
        el('p', { class: 'hint', style: 'padding:1rem' }, 'Deriving key...'),
      ),
    ),
  );

  try {
    const { records } = await listEncryptedRecords(NS, 0, 100);
    const listEl = document.getElementById('notes-list');
    if (!listEl) return;

    if (records.length === 0) {
      render(listEl, el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, '\u{1F4DD}'),
        el('p', {}, 'No notes saved yet'),
        el('button', { class: 'btn-primary', onClick: () => navigate('#note/new') }, 'Create your first'),
      ));
      return;
    }

    const items = records.map(rec => {
      const d = rec.data || {};
      const preview = (d.body || '').slice(0, 80);
      return el('div', { class: 'vault-item card', onClick: () => navigate(`#note/${rec.id}`) },
        el('div', { class: 'vault-item-main' },
          el('span', { class: 'vault-item-title' }, d.title || 'Untitled'),
          el('span', { class: 'vault-item-sub' }, preview || ''),
        ),
        el('span', { class: 'vault-item-arrow' }, '\u203A'),
      );
    });

    render(listEl, el('div', { class: 'vault-list' }, ...items));
  } catch (e) {
    const listEl = document.getElementById('notes-list');
    if (listEl) render(listEl, el('p', { class: 'error', style: 'padding:1rem' }, `Error: ${e.message}`));
  }
}
