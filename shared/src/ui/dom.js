/**
 * dom.js — helpers DOM minimali.
 *
 * Micro-framework senza dipendenze — evita ripetizioni senza introdurre React/Vue/etc.
 */

/** Seleziona un elemento nel DOM. */
export const $ = (sel, root = document) => root.querySelector(sel);

/** Seleziona tutti gli elementi che corrispondono al selettore. */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Crea un elemento con attributi e figli opzionali.
 *
 * Attributi speciali:
 *   - onClick, onInput, etc. → addEventListener
 *   - class → className
 *   - style (string) → setAttribute
 *
 * @param {string} tag
 * @param {Object} attrs
 * @param {...(string|Node)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      node.className = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Svuota un contenitore e lo ri-popola con i nodi dati. */
export function render(container, ...nodes) {
  container.innerHTML = '';
  container.append(...nodes.filter(Boolean));
}

/** Mostra un messaggio di errore nell'elemento dato. */
export function showError(container, message) {
  container.innerHTML = `<p class="error">${message}</p>`;
}

/** Tronca un testo lungo (es. Principal ID). */
export function truncate(str, max = 12) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, 6)}…${str.slice(-6)}` : str;
}

/** Formatta "ultimo accesso" in modo leggibile. */
export function formatLastSeen(timestampMs) {
  const diffMs = Date.now() - timestampMs;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return new Date(timestampMs).toLocaleDateString();
}
