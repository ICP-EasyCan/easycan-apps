/**
 * desktop-rail.js — Layout two-pane stile WhatsApp Web (≥1024px).
 *
 * Su desktop, quando l'hash è in {#chats, #chat/*}, monta la chat list
 * in un rail persistente a sinistra; il pannello destro mostra la
 * conversazione attiva (o uno splash su #chats).
 *
 * Su mobile (<1024px) il rail è nascosto via CSS e tutto torna al flusso
 * single-pane gestito dal router.
 */

import { renderChats } from '../pages/chats.js';
import { renderChatEmpty } from '../pages/chat-empty.js';

const MQ = window.matchMedia('(min-width: 1024px)');
let _enabled = false;
let _lastSelectedKey = null;

function _railEl()   { return document.getElementById('chat-list-rail'); }
function _routeEl()  { return document.getElementById('route-container'); }

function _isChatHash(hash) {
  return hash === '#chats' || hash.startsWith('#chat/');
}

function _selectedKeyFromHash(hash) {
  if (!hash.startsWith('#chat/')) return null;
  return hash.slice('#chat/'.length); // "<cid>:<pid>"
}

/**
 * Sync layout state with current hash + viewport.
 * Idempotente — può essere chiamato a ogni hashchange senza side effects.
 */
export function syncRail() {
  if (!_enabled) return;

  const rail   = _railEl();
  const route  = _routeEl();
  if (!rail || !route) return;

  const hash         = window.location.hash || '';
  const isDesktop    = MQ.matches;
  const isChatRoute  = _isChatHash(hash);
  const split        = isDesktop && isChatRoute;

  document.body.dataset.layout = split ? 'split' : 'single';

  if (!split) {
    // Mobile, o route non-chat su desktop: rail vuoto, route gestisce tutto.
    rail.innerHTML = '';
    _lastSelectedKey = null;
    return;
  }

  // Desktop + chat route: monta/aggiorna la chat list nel rail.
  const selectedKey = _selectedKeyFromHash(hash);
  renderChats(rail, { selectedKey });
  _lastSelectedKey = selectedKey;

  // Su #chats desktop il route container mostra lo splash.
  if (hash === '#chats') {
    renderChatEmpty(route);
  }
  // Su #chat/* lascia che il router renderizzi renderChat in route.
}

export function initDesktopRail() {
  if (_enabled) return;
  _enabled = true;
  window.addEventListener('hashchange', syncRail);
  MQ.addEventListener('change', syncRail);
  syncRail();
}

export function teardownDesktopRail() {
  if (!_enabled) return;
  _enabled = false;
  window.removeEventListener('hashchange', syncRail);
  MQ.removeEventListener('change', syncRail);
  const rail = _railEl();
  if (rail) rail.innerHTML = '';
  document.body.dataset.layout = 'single';
  _lastSelectedKey = null;
}
