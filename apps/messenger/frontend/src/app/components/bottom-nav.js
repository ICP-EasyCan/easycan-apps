/**
 * bottom-nav.js — Barra di navigazione inferiore.
 *
 * Tre tab: Chat (#chats), Contatti (#contacts), Impostazioni (#settings).
 * Visibile solo su route autenticate — nascosta su #login e #not-owner.
 * Aggiorna la tab attiva automaticamente via hashchange.
 *
 * Uso:
 *   initBottomNav()   — chiamata dopo il login
 *   removeBottomNav() — chiamata dopo il logout
 */

import { navigate } from '@shared/ui/router.js';
import { bus }      from '@shared/core/event-bus.js';
import { getPendingCache } from '../connection-manager.js';

let _pendingUnsub = null;

const TABS = [
  { route: '#chats',    icon: '\u{1F4AC}', label: 'Chats' },
  { route: '#contacts', icon: '\u{1F465}', label: 'Contacts' },
  { route: '#settings', icon: '\u{2699}\u{FE0F}', label: 'Settings' },
];

const VISIBLE_ROUTES = new Set(['#chats', '#contacts', '#settings']);


function _activeRoute() {
  const hash = window.location.hash;
  if (!hash) return '';
  if (hash.startsWith('#chat/')) return '#chats';
  if (hash === '#sovereignty') return '#settings';
  return hash;
}

function _update() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;

  const active = _activeRoute();
  // Mostra solo sulle route principali (nasconde su #login, #not-owner, #chat/*, hash vuoto)
  if (!VISIBLE_ROUTES.has(active)) {
    nav.style.display = 'none';
    return;
  }
  nav.style.display = '';

  for (const btn of nav.querySelectorAll('.bottom-nav-tab')) {
    btn.classList.toggle('active', btn.dataset.route === active);
  }
}

// Badge non-letti aggregato sul tab Chats: numero di sender con messaggi
// pending (senders.size dello snapshot notify). 0 → nascosto. Visibile da
// ogni tab, così i non-letti si notano anche fuori dalla lista chat.
function _updateBadge(count) {
  const badge = document.querySelector('#bottom-nav .bottom-nav-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

export function initBottomNav() {
  if (document.getElementById('bottom-nav')) return;

  const nav = document.createElement('nav');
  nav.id = 'bottom-nav';
  nav.className = 'bottom-nav';
  nav.style.display = 'none';

  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.className = 'bottom-nav-tab';
    btn.dataset.route = tab.route;
    btn.onclick = () => navigate(tab.route);

    const icon = document.createElement('span');
    icon.className = 'bottom-nav-icon';
    icon.textContent = tab.icon;

    const label = document.createElement('span');
    label.className = 'bottom-nav-label';
    label.textContent = tab.label;

    btn.appendChild(icon);
    btn.appendChild(label);

    if (tab.route === '#chats') {
      const badge = document.createElement('span');
      badge.className = 'bottom-nav-badge';
      badge.style.display = 'none';
      btn.appendChild(badge);
    }

    nav.appendChild(btn);
  }

  document.getElementById('app').appendChild(nav);
  _update();
  window.addEventListener('hashchange', _update);

  // Badge non-letti: seed immediato dallo snapshot corrente, poi aggiornato
  // ad ogni poll notify.
  _updateBadge(getPendingCache().size);
  _pendingUnsub = bus.on('notify:pending-update', ({ senders }) => {
    _updateBadge(senders ? senders.size : 0);
  });
}

export function removeBottomNav() {
  window.removeEventListener('hashchange', _update);
  if (_pendingUnsub) { _pendingUnsub(); _pendingUnsub = null; }
  document.getElementById('bottom-nav')?.remove();
}
