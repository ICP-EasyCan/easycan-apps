/**
 * chats.js — Lista chat stile WhatsApp.
 *
 * Mostra contatti con anteprima ultimo messaggio, pallino pending, avatar iniziali.
 * Usa capabilities: contacts (localStorage), notify (bus pending-update).
 */

import { bus }           from '@shared/core/event-bus.js';
import { el, render, truncate }
                         from '@shared/ui/dom.js';
import { navigate }      from '@shared/ui/router.js';
import { loadContacts }  from '../contacts-store.js';
import { getPendingCache }
                         from '../connection-manager.js';
import { avatarEl }      from '../components/avatar.js';

// ─── Stato locale ──────────────────────────────────────────────────────────

let _busUnsub  = null;
let _container = null;
let _lastOpts  = {};

// ─── Render principale ─────────────────────────────────────────────────────

export function renderChats(container, opts = {}) {
  _container = container;
  _lastOpts  = opts;
  const selectedKey = opts.selectedKey || null;

  if (!_busUnsub) {
    _busUnsub = bus.on('notify:pending-update', () => {
      const hash = window.location.hash;
      const isRail = _container && _container.id === 'chat-list-rail';
      // Ri-renderizza solo se la chats list è effettivamente visibile:
      // - hash #chats (single-pane mobile o splash desktop)
      // - oppure desktop split-view (container = rail persistente)
      if (hash !== '#chats' && !isRail) return;
      renderChats(_container, _lastOpts);
    });
  }

  const contacts      = loadContacts();
  const pendingSenders = getPendingCache();

  const sorted = [...contacts].sort((a, b) =>
    _getLastMessageTs(b.principalId) - _getLastMessageTs(a.principalId)
  );

  const body = sorted.length === 0
    ? el('div', { class: 'chat-list-empty' },
        el('div', { class: 'empty-icon' }, '\u{1F4AC}'),
        el('h3', {}, 'No active chats'),
        el('p', { class: 'hint' }, 'Tap the + button to add a contact.'),
      )
    : el('div', { class: 'chat-list' },
        ...sorted.map(c => _renderChatItem(c, pendingSenders.has(c.principalId), selectedKey)),
      );

  const fab = el('button', { class: 'fab', onclick: () => navigate('#add-contact') }, '+');

  render(container,
    el('div', { class: 'page page-chats' },
      el('header', { class: 'topbar' },
        el('span', { class: 'topbar-title' }, 'Chats')
      ),
      body,
      fab,
    ),
  );
}

// ─── Chat item ──────────────────────────────────────────────────────────────

function _renderChatItem(contact, hasPending, selectedKey) {
  const key = `${contact.canisterId}:${contact.principalId}`;
  const isActive = selectedKey === key;
  const lastMsg = _getLastMessage(contact.principalId);
  const alias   = contact.alias || truncate(contact.principalId);

  let preview = '';
  let timeStr = '';
  if (lastMsg) {
    const prefix = lastMsg.from === 'me' ? 'You: ' : '';
    const text   = lastMsg.text || '';
    preview = prefix + (text.length > 40 ? text.slice(0, 40) + '...' : text);
    timeStr = _formatTime(lastMsg.timestamp);
  }

  const av = avatarEl(contact.alias, contact.principalId);

  return el('div', {
    class: `chat-item${hasPending ? ' chat-item-unread' : ''}${isActive ? ' active' : ''}`,
    onclick: () => navigate(`#chat/${key}`),
  },
    av,
    el('div', { class: 'chat-item-body' },
      el('div', { class: 'chat-item-top' },
        el('span', { class: 'chat-item-name' }, alias),
        el('span', { class: 'chat-item-time' }, timeStr),
      ),
      el('div', { class: 'chat-item-bottom' },
        el('span', { class: 'chat-item-preview' }, preview),
        hasPending ? el('span', { class: 'chat-item-dot' }) : null,
      ),
    ),
  );
}

// ─── localStorage helpers ──────────────────────────────────────────────────

function _getLastMessage(principalId) {
  try {
    const raw = localStorage.getItem('sm_chat_' + principalId);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return arr.length > 0 ? arr[arr.length - 1] : null;
  } catch { return null; }
}

function _getLastMessageTs(principalId) {
  return _getLastMessage(principalId)?.timestamp || 0;
}

function _formatTime(timestampMs) {
  if (!timestampMs) return '';
  const d   = new Date(timestampMs);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}
