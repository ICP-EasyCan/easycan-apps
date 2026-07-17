/**
 * notifications.js — Wrapper Notification API (messenger).
 *
 * Notifiche di sistema SENZA service worker: arrivano solo finché il tab è vivo
 * (desktop: sempre; Android: finché il sistema non congela la PWA). Le push vere
 * ad app chiusa (Web Push firmate dal canister) sono un progetto futuro — non
 * aggiungere un service worker qui.
 *
 * Regole:
 *  - il permesso si chiede SOLO da un gesto utente (bottone in settings, mai al boot)
 *  - si notifica SOLO a pagina nascosta (in faccia bastano suono + badge)
 *  - `tag` sostituisce la notifica precedente invece di accumulare
 */

import { navigate } from '@shared/ui/router.js';

const _active = new Map(); // tag → Notification (per chiudere es. chiamata annullata)

export function notificationsAvailable() {
  return 'Notification' in window;
}

export function notificationsGranted() {
  return notificationsAvailable() && Notification.permission === 'granted';
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notificationsPermission() {
  return notificationsAvailable() ? Notification.permission : 'unsupported';
}

/** Da chiamare SOLO su gesto utente. Ritorna il permesso risultante. */
export async function requestNotificationPermission() {
  if (!notificationsAvailable()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Mostra una notifica di sistema solo se la pagina è nascosta e il permesso c'è.
 * Click → focus della finestra + navigazione opzionale.
 *
 * @param {{ title: string, body?: string, tag?: string, route?: string,
 *           requireInteraction?: boolean }} options
 * @returns {Notification|null}
 */
export function maybeNotify({ title, body, tag, route, requireInteraction = false }) {
  if (!notificationsGranted() || !document.hidden) return null;
  try {
    const n = new Notification(title, { body, tag, requireInteraction });
    if (tag) _active.set(tag, n);
    n.onclick = () => {
      try { window.focus(); } catch { /* no-op */ }
      if (route) navigate(route);
      n.close();
    };
    n.onclose = () => { if (tag) _active.delete(tag); };
    return n;
  } catch {
    return null;
  }
}

/** Chiude la notifica con il tag dato (es. chiamata annullata dal chiamante). */
export function closeNotification(tag) {
  const n = _active.get(tag);
  if (n) {
    try { n.close(); } catch { /* no-op */ }
    _active.delete(tag);
  }
}
