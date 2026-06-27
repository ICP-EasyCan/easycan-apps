/** ui.js — micro-helpers di presentazione per la shell EasyHub. */

import { el } from '@shared/ui/dom.js';

/** Toast effimero (3s). kind: 'ok' | 'err' | ''. */
export function toast(message, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

/** Badge dei permessi dichiarati da un bundle (BundlePermissions candid). */
export function permissionBadges(perms) {
  const badges = [];
  for (const ns of perms.storage_namespaces) badges.push(el('span', { class: 'badge perm' }, `kv:${ns}`));
  for (const h of perms.http_outcall_hosts) badges.push(el('span', { class: 'badge perm' }, `http:${h}`));
  for (const c of perms.inter_canister) badges.push(el('span', { class: 'badge perm' }, `call:${c}`));
  if (perms.uses_crypto) badges.push(el('span', { class: 'badge perm' }, 'crypto'));
  if (perms.uses_timer) badges.push(el('span', { class: 'badge perm' }, 'timer'));
  if (!badges.length) badges.push(el('span', { class: 'badge' }, 'no permissions'));
  return badges;
}

/** Header di pagina standard. */
export function pageHeader(title, subtitle) {
  return el('div', { class: 'page-header' },
    el('h1', {}, title),
    subtitle ? el('p', {}, subtitle) : null,
  );
}
