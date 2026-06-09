/**
 * bottom-nav.js — Bottom navigation bar for Sovereign Vault
 *
 * Four tabs: Passwords, Files, Notes, Settings
 */

import { navigate } from '@shared/ui/router.js';

const TABS = [
  { route: '#dashboard', icon: '\u{1F3E0}', label: 'Home' },
  { route: '#passwords', icon: '\u{1F511}', label: 'Password' },
  { route: '#files',     icon: '\u{1F4C1}', label: 'File' },
  { route: '#notes',     icon: '\u{1F4DD}', label: 'Note' },
  { route: '#settings',  icon: '\u2699',    label: 'Settings' },
];

const VISIBLE_ROUTES = new Set(['#dashboard', '#passwords', '#files', '#notes', '#settings']);

function _activeRoute() {
  const hash = window.location.hash;
  if (!hash) return '';
  if (hash.startsWith('#password/')) return '#passwords';
  if (hash.startsWith('#note/')) return '#notes';
  if (hash === '#sovereignty') return '#settings';
  return hash;
}

function _update() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;

  const active = _activeRoute();
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
