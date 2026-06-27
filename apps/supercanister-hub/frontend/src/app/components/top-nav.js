/** top-nav.js — barra di navigazione globale EasyHub. */

import { getPrincipalText, logout } from '@shared/core/auth.js';

const VISIBLE = new Set(['#home', '#mini-apps', '#automations', '#control-room', '#settings']);

function _activeRoute() {
  const hash = window.location.hash;
  if (!hash) return '';
  if (hash.startsWith('#run/')) return '#mini-apps';
  // La Capsula non ha più una voce propria: è una ricetta di Automations. Mantieni la chrome
  // visibile e illumina Automations quando ci si arriva (dalla galleria o da un cross-link).
  if (hash === '#capsule') return '#automations';
  if (hash === '#sovereignty' || hash === '#verify' || hash === '#update') return '#settings';
  return hash;
}

function _update() {
  const header = document.getElementById('app-header');
  if (!header) return;
  const active = _activeRoute();
  header.style.display = VISIBLE.has(active) ? 'flex' : 'none';

  const links = document.getElementById('top-nav-links');
  if (links) {
    for (const a of links.querySelectorAll('a')) {
      a.classList.toggle('active', a.dataset.route === active);
    }
  }
}

export function initTopNav() {
  const header = document.getElementById('app-header');
  if (!header) return;

  const principal = getPrincipalText();
  const prinEl = document.getElementById('header-principal');
  if (prinEl && principal) prinEl.textContent = `${principal.slice(0, 8)}…${principal.slice(-4)}`;

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.onclick = () => logout();

  _update();
  window.addEventListener('hashchange', _update);
}

export function removeTopNav() {
  window.removeEventListener('hashchange', _update);
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
}
