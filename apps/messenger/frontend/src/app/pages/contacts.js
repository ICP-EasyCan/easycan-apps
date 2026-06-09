/**
 * contacts.js — Pagina contatti dedicata (#contacts).
 *
 * Lista contatti con avatar, alias, canister ID, azioni (apri chat, presenza, rimuovi).
 * Form "Aggiungi contatto" in fondo — chiama add_to_whitelist + salva in localStorage.
 */

import { el, render, truncate, formatLastSeen }
                           from '@shared/ui/dom.js';
import { loadContacts, removeContact, updateContactAlias }
                           from '../contacts-store.js';
import { avatarEl }        from '../components/avatar.js';
import { checkPeerPresence } from '../connection-manager.js';
import { navigate }        from '@shared/ui/router.js';

// ─── Entry point ───────────────────────────────────────────────────────────

export function renderContacts(container) {
  _render(container);
}

// ─── Render principale ─────────────────────────────────────────────────────

function _render(container) {
  const contacts = loadContacts();

  const items = contacts.length === 0
    ? [el('p', { class: 'hint contacts-empty' }, 'No contacts yet.')]
    : contacts.map(c => _contactCard(c, container));

  const addBtn = el('button', {
    class: 'btn-primary contacts-add-cta',
    onclick: () => navigate('#add-contact'),
  }, '+  Add contact');

  render(container,
    el('div', { class: 'page page-contacts' },
      el('header', { class: 'topbar' },
        el('span', { class: 'topbar-title' }, 'Contacts'),
        addBtn,
      ),
      el('div', { class: 'contacts-list' }, ...items),
    ),
  );
}

// ─── Card contatto ─────────────────────────────────────────────────────────

function _contactCard(c, container) {
  const alias      = c.alias || '';
  const displayName = alias || truncate(c.canisterId, 16);
  const presenceEl  = el('span', { class: 'contact-presence' });

  const av = avatarEl(alias, c.principalId);

  return el('div', { class: 'contact-card' },
    av,
    el('div', { class: 'contact-info' },
      el('span', { class: 'contact-name' }, displayName),
      el('span', { class: 'contact-cid small hint' }, truncate(c.canisterId, 22)),
      presenceEl,
    ),
    el('div', { class: 'contact-actions' },
      el('button', {
        class: 'btn-primary small',
        onclick: () => navigate(`#chat/${c.canisterId}:${c.principalId}`),
      }, 'Open chat'),
      el('button', {
        class: 'btn-icon',
        title: 'Check presence',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const { online, lastSeenMs } = await checkPeerPresence(c.canisterId);
            if (online) {
              presenceEl.textContent = '● online';
              presenceEl.style.color = 'var(--online)';
            } else if (lastSeenMs) {
              presenceEl.textContent = formatLastSeen(lastSeenMs);
              presenceEl.style.color = 'var(--text-dim)';
            } else {
              presenceEl.textContent = '● offline';
              presenceEl.style.color = 'var(--text-dim)';
            }
          } catch { presenceEl.textContent = '—'; }
          btn.disabled = false;
        },
      }, '📡'),
      el('button', {
        class: 'btn-icon',
        title: 'Edit alias',
        onclick: () => {
          const next = window.prompt('Edit alias', c.alias || '');
          if (next === null) return;
          updateContactAlias(c.canisterId, next.trim());
          _render(container);
        },
      }, '✎'),
      el('button', {
        class: 'btn-icon',
        title: 'Remove contact',
        onclick: () => { removeContact(c.canisterId); _render(container); },
      }, '🗑'),
    ),
  );
}

