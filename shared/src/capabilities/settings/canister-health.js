/**
 * canister-health.js — lettura tollerante di carburante + impronta del canister sovrano.
 *
 * Sorgente: gli endpoint `platform_*` della cap-platform, che TUTTE le app marketplace
 * espongono (hub, vault, messenger) → la sezione "Canister" di settings è uniforme ovunque.
 *  - platform_cycles : query  → Nat (cicli)              → GRATIS, letta sempre live
 *  - platform_status : update → variant { Ok: { memory_size: opt nat; … }; Err }
 *
 * ⚠️ `platform_status` è un UPDATE (~6.7M cycles): internamente fa una inter-canister
 * call a `canister_status` del management canister — l'unico posto dove vivono
 * `idle_cycles_burned_per_day` e la memoria, IRRAGGIUNGIBILI da una query. Aprire la
 * sezione "Canister" a ogni giro rifaceva quell'update (e ci si attaccava pure il
 * piggyback di presenza). Ora è CACHATO: memoria/idle-burn cambiano lentissimo →
 * si rifetchano solo su cache scaduta (TTL) o su richiesta esplicita (`refreshStatus`).
 * Il saldo cicli invece resta live (query gratis). Cache per-canister in localStorage,
 * così sopravvive anche ai reload.
 *
 * Ogni lettura degrada a `null` (mai crash): un'app senza quegli endpoint mostra "n/a".
 */

import { call, query } from '../../core/icp.js';

const STATUS_TTL_MS = 60 * 60 * 1000; // 1h — idle-burn/memoria sono ~costanti tra un upgrade e l'altro
const _statusKey = (canisterId) => `cap_canister_status:${canisterId}`;

function _readStatusCache(canisterId) {
  try {
    const raw = JSON.parse(localStorage.getItem(_statusKey(canisterId)) || 'null');
    if (!raw || Date.now() - raw.ts > STATUS_TTL_MS) return null;
    return {
      memoryBytes:    raw.memoryBytes != null ? BigInt(raw.memoryBytes) : null,
      idleBurnPerDay: raw.idleBurnPerDay != null ? BigInt(raw.idleBurnPerDay) : null,
    };
  } catch { return null; }
}

function _writeStatusCache(canisterId, memoryBytes, idleBurnPerDay) {
  try {
    localStorage.setItem(_statusKey(canisterId), JSON.stringify({
      ts: Date.now(),
      memoryBytes:    memoryBytes != null ? memoryBytes.toString() : null,
      idleBurnPerDay: idleBurnPerDay != null ? idleBurnPerDay.toString() : null,
    }));
  } catch { /* localStorage pieno/negato: pazienza, si rifetcha */ }
}

/**
 * @param {string} canisterId
 * @param {{ refreshStatus?: boolean }} [opts] — forza il refetch dell'update platform_status
 *        (bypassa la cache). Il saldo cicli è sempre live comunque.
 * @returns {Promise<{ cycles: bigint|null, memoryBytes: bigint|null, idleBurnPerDay: bigint|null }>}
 */
export async function loadCanisterHealth(canisterId, { refreshStatus = false } = {}) {
  const out = { cycles: null, memoryBytes: null, idleBurnPerDay: null };

  // Saldo: query gratis → sempre fresco.
  try { out.cycles = await query(canisterId, 'platform_cycles'); } catch { /* n/d */ }

  // Memoria + idle-burn: update costoso → dalla cache se fresca e non forzato.
  if (!refreshStatus) {
    const cached = _readStatusCache(canisterId);
    if (cached) {
      out.memoryBytes = cached.memoryBytes;
      out.idleBurnPerDay = cached.idleBurnPerDay;
      return out;
    }
  }

  try {
    const res = await call(canisterId, 'platform_status');
    const status = res && 'Ok' in res ? res.Ok : res;
    if (status && status.memory_size && status.memory_size.length) {
      out.memoryBytes = status.memory_size[0];
    }
    if (status && status.idle_cycles_burned_per_day && status.idle_cycles_burned_per_day.length) {
      out.idleBurnPerDay = status.idle_cycles_burned_per_day[0];
    }
    _writeStatusCache(canisterId, out.memoryBytes, out.idleBurnPerDay);
  } catch { /* n/d */ }
  return out;
}

/** Cicli → "1,234,567" (locale), o "n/a". */
export function formatCycles(n) {
  if (n == null) return 'n/a';
  try { return Number(n).toLocaleString(); } catch { return String(n); }
}

/** Byte → "12.3 MB" / "456 KB" / "789 B", o "n/a". */
export function formatBytes(n) {
  if (n == null) return 'n/a';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** Cycles/day → "1.76 B/day" / "345 M/day", o "n/a". */
export function formatBurnPerDay(n) {
  if (n == null) return 'n/a';
  const c = Number(n);
  if (c >= 1e9) return `${(c / 1e9).toFixed(2)} B/day`;
  if (c >= 1e6) return `${(c / 1e6).toFixed(0)} M/day`;
  return `${c.toLocaleString()}/day`;
}

/**
 * Giorni di autonomia IN IDLE = saldo / burn-idle-al-giorno, o "n/a".
 * ⚠️ Stima ottimistica: `idleBurnPerDay` è il burn di sistema (storage/memoria),
 * ESCLUDE esecuzione e attività → è un tetto massimo, non il drenaggio reale in uso.
 */
export function formatAutonomyDays(cycles, idleBurnPerDay) {
  if (cycles == null || idleBurnPerDay == null || idleBurnPerDay === 0n) return 'n/a';
  const days = Number(cycles) / Number(idleBurnPerDay);
  if (!isFinite(days)) return 'n/a';
  if (days >= 1000) return `~${Math.round(days / 100) * 100} days`;
  return `~${Math.round(days)} days`;
}
