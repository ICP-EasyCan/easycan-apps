/**
 * router.js — hash router minimale.
 *
 * Registra route con pattern matching semplice:
 *   route('#login', handler)         → match esatto
 *   route('#chat/*', handler)        → match prefix, param = parte dopo *
 *
 * Emette 'route:change' sull'event bus con { hash, params }.
 */

import { bus } from '../core/event-bus.js';

const _routes = new Map();
let _fallback = null;

/**
 * Registra una route.
 * @param {string} pattern — stringa esatta o prefix con '*'
 * @param {(params: string[]) => void} handler
 */
export function route(pattern, handler) {
  _routes.set(pattern, handler);
}

/** Route di fallback se nessun pattern corrisponde. */
export function fallback(handler) {
  _fallback = handler;
}

function dispatch() {
  const hash = window.location.hash || '#login';

  for (const [pattern, handler] of _routes) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (hash.startsWith(prefix)) {
        const param = hash.slice(prefix.length);
        bus.emit('route:change', { hash, params: [param] });
        handler([param]);
        return;
      }
    } else if (hash === pattern) {
      bus.emit('route:change', { hash, params: [] });
      handler([]);
      return;
    }
  }

  _fallback?.([hash]);
}

/** Avvia il router (ascolta i cambi di hash). */
export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}

/** Naviga verso una route. */
export function navigate(hash) {
  window.location.hash = hash;
}
