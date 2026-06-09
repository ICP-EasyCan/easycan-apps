/**
 * top-nav.js — Global top navigation bar for Sovereign Vault
 */

import { navigate } from '@shared/ui/router.js';
import { getPrincipalText, logout } from '@shared/core/auth.js';

const VISIBLE_ROUTES = new Set(['#dashboard', '#passwords', '#files', '#notes', '#settings']);

function _activeRoute() {
  const hash = window.location.hash;
  if (!hash) return '';
  if (hash.startsWith('#password/')) return '#passwords';
  if (hash.startsWith('#note/')) return '#notes';
  return hash;
}

function _update() {
  const header = document.getElementById('app-header');
  if (!header) return;

  const active = _activeRoute();
  
  if (VISIBLE_ROUTES.has(active)) {
    header.style.display = 'flex';
  } else {
    header.style.display = 'none';
  }

  const navLinks = document.getElementById('top-nav-links');
  if (navLinks) {
    for (const a of navLinks.querySelectorAll('a')) {
      a.classList.toggle('active', a.dataset.route === active);
    }
  }
}

export function initTopNav() {
  const header = document.getElementById('app-header');
  if (!header) return;

  // Set principal text
  const principal = getPrincipalText();
  const prinEl = document.getElementById('header-principal');
  if (prinEl && principal) {
    prinEl.textContent = `${principal.slice(0, 8)}...${principal.slice(-4)}`;
  }

  // Bind logout
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.onclick = () => logout();
  }

  _update();
  window.addEventListener('hashchange', _update);
}

export function removeTopNav() {
  window.removeEventListener('hashchange', _update);
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
}
