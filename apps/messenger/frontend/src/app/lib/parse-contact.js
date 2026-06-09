/**
 * parse-contact.js — Riconosce un contatto da input testuale eterogeneo.
 *
 * Output canonico: { canisterId, principalId, alias? }.
 * Ritorna { error } se non trova abbastanza materiale.
 *
 * Ordine di tentativi (primo che matcha vince):
 *   1. JSON { canisterId, principalId, alias? }
 *   2. URL con query ?add=<cid>:<pid> (separatori : , | / spazio anche qui)
 *   3. Token liberi: estrae tutti i Principal-like dalla stringa,
 *      classifica via suffisso "-cai" (canister) vs altri (user principal).
 */

import { Principal } from '@dfinity/principal';

const TOKEN_RE = /[a-z0-9][a-z0-9-]{4,}/gi;

function _isValidPrincipal(s) {
  try { Principal.fromText(s); return true; } catch { return false; }
}

function _isCanisterId(s) {
  return s.endsWith('-cai') && _isValidPrincipal(s);
}

function _classify(tokens) {
  const valid = tokens.filter(_isValidPrincipal);
  const canisters = valid.filter(_isCanisterId);
  const users     = valid.filter(t => !_isCanisterId(t));

  if (canisters.length >= 1 && users.length >= 1) {
    return { canisterId: canisters[0], principalId: users[0] };
  }
  // Fallback: due principal validi, assumiamo ordine cid, pid.
  if (canisters.length === 0 && valid.length >= 2) {
    return { canisterId: valid[0], principalId: valid[1] };
  }
  return null;
}

export function parseContactInput(raw) {
  const text = (raw || '').trim();
  if (!text) return { error: 'Empty input.' };

  // 1) JSON
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      const cid = obj.canisterId || obj.cid;
      const pid = obj.principalId || obj.pid;
      if (cid && pid && _isValidPrincipal(cid) && _isValidPrincipal(pid)) {
        return { canisterId: cid, principalId: pid, alias: obj.alias || '' };
      }
    } catch { /* fall through */ }
  }

  // 2) URL con ?add=...
  if (/^https?:\/\//i.test(text) || text.includes('icp0.io')) {
    try {
      const u = new URL(text);
      const add = u.searchParams.get('add') || u.searchParams.get('contact');
      if (add) {
        const sub = _classify(add.split(/[\s:,|/]+/).filter(Boolean));
        if (sub) return sub;
      }
    } catch { /* fall through */ }
  }

  // 3) Token liberi su tutta la stringa
  const tokens = text.match(TOKEN_RE) || [];
  const hit = _classify(tokens);
  if (hit) return hit;

  return { error: 'No valid canister id + principal found in input.' };
}
