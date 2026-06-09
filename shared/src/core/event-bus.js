/**
 * Event Bus — collante tra moduli frontend.
 *
 * Ogni modulo emette e ascolta eventi senza conoscere gli altri.
 * Pattern publish/subscribe con namespace convenzionali:
 *
 *   auth:login, auth:logout
 *   presence:online, presence:offline
 *   messaging:new, messaging:ack
 *   notify:pending, notify:clear
 *   signaling:offer, signaling:answer
 *   route:change
 *
 * Uso:
 *   import { bus } from './core/event-bus.js';
 *   bus.on('auth:login', ({ principal }) => { ... });
 *   bus.emit('auth:login', { principal });
 */

const _listeners = new Map();

export const bus = {
  /**
   * Registra un listener per un evento.
   * @param {string} event
   * @param {Function} fn
   * @returns {Function} unsubscribe
   */
  on(event, fn) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(fn);
    return () => _listeners.get(event)?.delete(fn);
  },

  /**
   * Registra un listener che si attiva una sola volta.
   * @param {string} event
   * @param {Function} fn
   */
  once(event, fn) {
    const unsub = this.on(event, (...args) => {
      unsub();
      fn(...args);
    });
  },

  /**
   * Emette un evento con dati opzionali.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    const fns = _listeners.get(event);
    if (!fns) return;
    for (const fn of fns) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[event-bus] Error in handler for '${event}':`, err);
      }
    }
  },

  /**
   * Rimuove tutti i listener (utile per test o reset).
   * @param {string} [event] — se specificato, solo per quell'evento.
   */
  off(event) {
    if (event) {
      _listeners.delete(event);
    } else {
      _listeners.clear();
    }
  },
};
