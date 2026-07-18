/**
 * canister-health.js — lettura tollerante di carburante + impronta del canister sovrano.
 *
 * Sorgente: gli endpoint `platform_*` della cap-platform, che TUTTE le app marketplace
 * espongono (hub, vault, messenger) → la sezione "Canister" di settings è uniforme ovunque.
 *  - platform_cycles : query  → Nat (cicli)
 *  - platform_status : update → variant { Ok: { memory_size: opt nat; … }; Err }
 *
 * Ogni lettura degrada a `null` (mai crash): un'app senza quegli endpoint mostra "n/d".
 */

import { call, query } from '../../core/icp.js';

/** @returns {Promise<{ cycles: bigint|null, memoryBytes: bigint|null, idleBurnPerDay: bigint|null }>} */
export async function loadCanisterHealth(canisterId) {
  const out = { cycles: null, memoryBytes: null, idleBurnPerDay: null };
  try { out.cycles = await query(canisterId, 'platform_cycles'); } catch { /* n/d */ }
  try {
    const res = await call(canisterId, 'platform_status');
    const status = res && 'Ok' in res ? res.Ok : res;
    if (status && status.memory_size && status.memory_size.length) {
      out.memoryBytes = status.memory_size[0];
    }
    if (status && status.idle_cycles_burned_per_day && status.idle_cycles_burned_per_day.length) {
      out.idleBurnPerDay = status.idle_cycles_burned_per_day[0];
    }
  } catch { /* n/d */ }
  return out;
}

/** Cicli → "1,234,567" (locale), o "n/d". */
export function formatCycles(n) {
  if (n == null) return 'n/d';
  try { return Number(n).toLocaleString(); } catch { return String(n); }
}

/** Byte → "12.3 MB" / "456 KB" / "789 B", o "n/d". */
export function formatBytes(n) {
  if (n == null) return 'n/d';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** Cycles/giorno → "1.76 B/giorno" / "345 M/giorno", o "n/d". */
export function formatBurnPerDay(n) {
  if (n == null) return 'n/d';
  const c = Number(n);
  if (c >= 1e9) return `${(c / 1e9).toFixed(2)} B/giorno`;
  if (c >= 1e6) return `${(c / 1e6).toFixed(0)} M/giorno`;
  return `${c.toLocaleString()}/giorno`;
}

/**
 * Giorni di autonomia IN IDLE = saldo / burn-idle-al-giorno, o "n/d".
 * ⚠️ Stima ottimistica: `idleBurnPerDay` è il burn di sistema (storage/memoria),
 * ESCLUDE esecuzione e attività → è un tetto massimo, non il drenaggio reale in uso.
 */
export function formatAutonomyDays(cycles, idleBurnPerDay) {
  if (cycles == null || idleBurnPerDay == null || idleBurnPerDay === 0n) return 'n/d';
  const days = Number(cycles) / Number(idleBurnPerDay);
  if (!isFinite(days)) return 'n/d';
  if (days >= 1000) return `~${Math.round(days / 100) * 100} giorni`;
  return `~${Math.round(days)} giorni`;
}
