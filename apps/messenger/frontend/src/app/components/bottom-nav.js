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
    nav.appendChild(btn);
  }

  document.getElementById('app').appendChild(nav);
  _update();
  window.addEventListener('hashchange', _update);
}

export function removeBottomNav() {
  window.removeEventListener('hashchange', _update);
  document.getElementById('bottom-nav')?.remove();
}
